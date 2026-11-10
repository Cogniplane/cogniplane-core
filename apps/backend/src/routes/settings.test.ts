import { randomUUID } from "node:crypto";
import { test, expect, vi } from "vitest";

import cookie from "@fastify/cookie";
import Fastify from "fastify";
import type { Redis } from "ioredis";

import { handleAppError } from "../app.js";
import { registerSettingsRoutes, type SettingsRouteStores } from "./settings.js";
import { RedisRequestLimits } from "../services/redis-request-limits.js";
import { RequestLimits } from "../services/request-limits.js";
import type { Pool } from "../lib/db.js";
import { FakeDatabase } from "../test-helpers/fake-database.js";
import { FakePool, type QueryResultRow } from "../test-helpers/fake-pool.js";
import { InMemoryAuditEventStore } from "../test-helpers/in-memory-audit-events.js";
import { createTestConfig } from "../test-helpers/test-config.js";
import { computeNextCronRunAt } from "../lib/cron.js";
import { PiiProtectionServiceError } from "../services/pii/pii-protection-service.js";
import {
  userSettingsSectionKeys,
  type CreateScheduledJobResult,
  type ScheduledJobAdmission,
  type ScheduledJobRecord,
  type ScheduledJobRunRecord,
  type UpdateScheduledJobResult,
  type UserSettingsSectionKey,
  type UserSettingsSectionRecord
} from "../services/user-settings-store.js";
import type { NotionUserConnectionSummary } from "../services/integrations/notion/notion-connection-service.js";
import {
  GithubConnectionError,
  GithubConnectionNotConfiguredError
} from "../services/integrations/github/github-connection-service.js";
import { InvalidGithubRepositoryListError } from "../services/integrations/github/github-repository-allowlist.js";
import { ConnectionConfirmError } from "../services/auth/security-change.js";
import { registerGithubSettingsRoutes } from "../services/integrations/github/github-settings-routes.js";
import { loadIntegrationEnablement } from "../services/integrations/integration-enablement.js";
import type { IntegrationStateStore } from "../services/integrations/integration-state-store.js";
import { registerNotionSettingsRoutes } from "../services/integrations/notion/notion-settings-routes.js";

class InMemoryGithubConnectionService {
  userConnection: {
    githubUserId: string;
    githubLogin: string;
    githubName: string | null;
    githubEmail: string | null;
    githubAvatarUrl: string | null;
    scopes: string[];
    allowedRepositories: string[];
    accessTokenExpiresAt: string | null;
    refreshTokenExpiresAt: string | null;
    connectedAt: string;
    updatedAt: string;
    lastUsedAt: string | null;
    suspended: boolean;
  } | null = null;
  authorizeRequested = false;
  confirmed: Array<{ githubUserId: string; ownerSecurityVersion: number | null }> = [];
  listing = { repositories: [{ fullName: "Acme/App", private: true, archived: false }], truncated: false };
  savedLists: string[][] = [];
  failure: Error | null = null;

  async getConnectionStatus() {
    return {
      configured: true,
      userConnection: this.userConnection
    };
  }

  async confirm(_tenantId: string, _userId: string, githubUserId: string, ownerSecurityVersion: number | null) {
    if (!this.userConnection) throw new ConnectionConfirmError("not_connected", "GitHub");
    if (this.userConnection.githubUserId !== githubUserId) throw new ConnectionConfirmError("account_changed", "GitHub");
    this.confirmed.push({ githubUserId, ownerSecurityVersion });
    this.userConnection = { ...this.userConnection, suspended: false };
    return this.userConnection;
  }

  async listAccessibleRepositories() {
    if (this.failure) throw this.failure;
    return this.listing;
  }

  async setAllowedRepositories(
    _tenantId: string,
    _userId: string,
    repositories: readonly string[],
    expectedGithubUserId: string
  ) {
    if (this.failure) throw this.failure;
    // The real store checks the same thing under the row lock.
    if (expectedGithubUserId !== this.userConnection?.githubUserId) {
      throw new GithubConnectionError("account_changed", "The connected GitHub account changed.");
    }
    this.savedLists.push([...repositories]);
    return repositories.map((repository) => repository.toLowerCase()).sort();
  }

  authorizeVersion: number | null | undefined = undefined;

  async getAuthorizationUrl(input: { ownerSecurityVersion: number | null }) {
    this.authorizeRequested = true;
    this.authorizeVersion = input.ownerSecurityVersion;
    return {
      url: "https://github.com/login/oauth/authorize?client_id=test-client",
      browserBinding: {
        name: "cogniplane_oauth_bind_github",
        value: "github-nonce",
        options: {
          httpOnly: true as const,
          secure: true,
          sameSite: "none" as const,
          path: "/auth/github/user/callback",
          maxAge: 600
        }
      }
    };
  }

  async disconnect() {
    if (!this.userConnection) {
      return false;
    }

    this.userConnection = null;
    return true;
  }
}

function connectedAs(githubUserId: string) {
  return {
    githubUserId,
    githubLogin: `login-${githubUserId}`,
    githubName: null,
    githubEmail: null,
    githubAvatarUrl: null,
    scopes: [],
    allowedRepositories: [] as string[],
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    connectedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastUsedAt: null,
    suspended: false
  };
}

class InMemoryNotionConnectionService {
  userConnection: NotionUserConnectionSummary | null = null;
  authorizeRequested = false;
  configured = true;

  async getConnectionStatus() {
    return {
      configured: this.configured,
      userConnection: this.userConnection
    };
  }

  authorizeVersion: number | null | undefined = undefined;

  async getAuthorizationUrl(input: { ownerSecurityVersion: number | null }) {
    this.authorizeRequested = true;
    this.authorizeVersion = input.ownerSecurityVersion;
    return {
      url: "https://api.notion.com/v1/oauth/authorize?client_id=test-client",
      browserBinding: {
        name: "cogniplane_oauth_bind_notion",
        value: "notion-nonce",
        options: {
          httpOnly: true as const,
          secure: true,
          sameSite: "none" as const,
          path: "/integrations/notion/callback",
          maxAge: 600
        }
      }
    };
  }

  async disconnect() {
    if (!this.userConnection) {
      return false;
    }
    this.userConnection = null;
    return true;
  }

  async confirm() {
    if (!this.userConnection) throw new ConnectionConfirmError("not_connected", "Notion");
    if (this.userConnection.notionOwnerEmail === null) throw new ConnectionConfirmError("not_attested", "Notion");
    this.userConnection = { ...this.userConnection, suspended: false };
    return this.userConnection;
  }
}

class InMemoryUserSettingsStore {
  private readonly sections = new Map<string, UserSettingsSectionRecord>();
  private readonly jobs = new Map<string, ScheduledJobRecord>();
  // The security version that the saving session gave, per job.
  readonly ownerSecurityVersions = new Map<string, number | null>();
  // The account's current version, as `getOwnerSecurityVersion` reads it.
  currentSecurityVersion: number | null = null;

  async getOwnerSecurityVersion(): Promise<number | null> {
    return this.currentSecurityVersion;
  }

  /** What the scheduler does after a security change of the owner. */
  pauseForSecurityChange(jobId: string): void {
    const job = this.jobs.get(jobId)!;
    this.jobs.set(jobId, { ...job, enabled: false, nextRunAt: null, pausedReason: "security_change" });
  }

  async listSections(_tenantId: string, userId: string): Promise<UserSettingsSectionRecord[]> {
    return [...this.sections.values()]
      .filter((section) => section.userId === userId)
      .sort((left, right) => left.sectionKey.localeCompare(right.sectionKey));
  }

  async upsertSection(input: {
    tenantId: string;
    userId: string;
    sectionKey: UserSettingsSectionKey;
    config: Record<string, unknown>;
  }): Promise<UserSettingsSectionRecord> {
    const key = `${input.tenantId}:${input.userId}:${input.sectionKey}`;
    const now = new Date().toISOString();
    const current = this.sections.get(key);
    const next: UserSettingsSectionRecord = {
      userId: input.userId,
      sectionKey: input.sectionKey,
      version: current ? current.version + 1 : 1,
      config: input.config,
      createdAt: current?.createdAt ?? now,
      updatedAt: now
    };
    this.sections.set(key, next);
    return next;
  }

  async listScheduledJobs(_tenantId: string, userId: string): Promise<ScheduledJobRecord[]> {
    return [...this.jobs.values()]
      .filter((job) => job.userId === userId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  // The real store counts and writes in one locked transaction; this fake is
  // single-threaded, so it only needs to apply the same admission rule.
  private activeCount(userId: string): number {
    return [...this.jobs.values()].filter((job) => job.userId === userId && job.enabled).length;
  }

  // Recorded so route tests can check what limit the route hands to the store.
  readonly admissions: ScheduledJobAdmission[] = [];

  async getScheduledJob(
    _tenantId: string,
    jobId: string,
    userId: string
  ): Promise<ScheduledJobRecord | null> {
    const job = this.jobs.get(jobId);
    return job && job.userId === userId ? job : null;
  }

  async createScheduledJob(input: {
    tenantId: string;
    jobId: string;
    userId: string;
    jobName: string;
    description: string | null;
    cronExpression: string;
    timeZone: string;
    targetType: "prompt" | "skill";
    targetRef: string | null;
    input: Record<string, unknown>;
    settingsSnapshot: Record<string, unknown>;
    enabled: boolean;
    nextRunAt: string | null;
    ownerSecurityVersion: number | null;
  }, admission: ScheduledJobAdmission): Promise<CreateScheduledJobResult> {
    this.admissions.push(admission);
    if (input.enabled && admission.maxActive > 0 && this.activeCount(input.userId) >= admission.maxActive) {
      return { status: "limit_reached" };
    }
    const now = new Date().toISOString();
    const job: ScheduledJobRecord = {
      tenantId: input.tenantId,
      jobId: input.jobId,
      userId: input.userId,
      jobName: input.jobName,
      description: input.description,
      scheduleKind: "cron",
      cronExpression: input.cronExpression,
      timeZone: input.timeZone,
      targetType: input.targetType,
      targetRef: input.targetRef,
      input: input.input,
      settingsSnapshot: input.settingsSnapshot,
      enabled: input.enabled,
      pausedReason: null,
      consecutiveFailures: 0,
      lastRunAt: null,
      nextRunAt: input.nextRunAt,
      createdAt: now,
      updatedAt: now
    };
    this.jobs.set(job.jobId, job);
    this.ownerSecurityVersions.set(job.jobId, input.ownerSecurityVersion);
    return { status: "created", job };
  }

  async updateScheduledJob(input: {
    tenantId: string;
    jobId: string;
    userId: string;
    jobName: string;
    description: string | null;
    cronExpression: string;
    timeZone: string;
    targetType: "prompt" | "skill";
    targetRef: string | null;
    input: Record<string, unknown>;
    settingsSnapshot: Record<string, unknown>;
    enabled: boolean;
    nextRunAt: string | null;
    ownerSecurityVersion: number | null;
  }, admission: ScheduledJobAdmission): Promise<UpdateScheduledJobResult> {
    this.admissions.push(admission);
    const current = this.jobs.get(input.jobId);
    if (!current || current.userId !== input.userId) {
      return { status: "not_found" };
    }
    if (
      input.enabled && !current.enabled && admission.maxActive > 0 &&
      this.activeCount(input.userId) >= admission.maxActive
    ) {
      return { status: "limit_reached" };
    }

    const next: ScheduledJobRecord = {
      ...current,
      jobName: input.jobName,
      description: input.description,
      cronExpression: input.cronExpression,
      timeZone: input.timeZone,
      targetType: input.targetType,
      targetRef: input.targetRef,
      input: input.input,
      settingsSnapshot: input.settingsSnapshot,
      enabled: input.enabled,
      pausedReason: null,
      nextRunAt: input.nextRunAt,
      updatedAt: new Date().toISOString()
    };
    this.jobs.set(input.jobId, next);
    this.ownerSecurityVersions.set(input.jobId, input.ownerSecurityVersion);
    return { status: "updated", job: next };
  }

  async deleteScheduledJob(_tenantId: string, jobId: string, userId: string): Promise<boolean> {
    const current = this.jobs.get(jobId);
    if (!current || current.userId !== userId) {
      return false;
    }
    return this.jobs.delete(jobId);
  }

  async listJobRuns(): Promise<ScheduledJobRunRecord[]> {
    return [];
  }
}

async function createApp(overrides: {
  integrationStates?: Pick<IntegrationStateStore, "get">;
  integrationRegistry?: SettingsRouteStores["integrationRegistry"];
  config?: SettingsRouteStores["config"];
  limits?: SettingsRouteStores["limits"];
  piiProtection?: SettingsRouteStores["piiProtection"];
  db?: Pool;
  // The error handler of the real app (`app.ts`).
  appErrorHandler?: boolean;
} = {}) {
  const app = Fastify();
  if (overrides.appErrorHandler) app.setErrorHandler(handleAppError);
  await app.register(cookie);
  const settings = new InMemoryUserSettingsStore();
  const auditEvents = new InMemoryAuditEventStore();
  const githubConnections = new InMemoryGithubConnectionService();
  const notionConnections = new InMemoryNotionConnectionService();

  app.decorate("config", createTestConfig({ LOCAL_DEV_USER_ID: "settings-user" }));
  app.decorate("db", overrides.db ?? new FakeDatabase() as unknown as Pool);
  app.addHook("preHandler", async (request) => {
    // `x-security-version`: a local session with that version. Without it,
    // the request has no browser session, as in dev mode.
    const securityVersion = request.headers["x-security-version"]?.toString();
    request.auth = {
      userId: request.headers["x-user-id"]?.toString() || "settings-user",
      tenantId: request.headers["x-tenant-id"]?.toString() || "settings-tenant",
      isAdmin: false,
      role: "member" as const,
      ...(securityVersion === undefined ? {} : {
        session: securityVersion === "workos"
          ? { authSource: "workos" as const }
          : { authSource: "local" as const, securityVersion: Number(securityVersion) }
      })
    };
  });

  const config = overrides.config ?? createTestConfig({});
  const integrationStates = overrides.integrationStates ?? {
    async get() {
      return null;
    }
  };
  // The GitHub and Notion member routes ship with their connector modules.
  // `app-bootstrap.ts` attaches them next to these settings routes.
  const enablement = (tenantId: string, integrationId: string) =>
    loadIntegrationEnablement(integrationStates, config, tenantId, integrationId);
  registerGithubSettingsRoutes(app, { githubConnections, loadIntegrationEnablement: enablement });
  registerNotionSettingsRoutes(app, { notionConnections, loadIntegrationEnablement: enablement });
  await registerSettingsRoutes(app, {
    settings,
    auditEvents,
    config,
    integrationRegistry: overrides.integrationRegistry ?? {
      async getIntegrationsForUser() {
        return [];
      }
    },
    limits: overrides.limits ?? {
      async consumeRateLimit() {
        return null;
      },
      async consumeTurnQuota() {
        return null;
      },
      sweepExpired() {}
    },
    piiProtection: overrides.piiProtection
  });
  await app.ready();

  return {
    app,
    settings,
    auditEvents,
    githubConnections,
    notionConnections
  };
}

test("settings routes expose default sections and persist section config", async () => {
  const { app, auditEvents } = await createApp();

  const listResponse = await app.inject({
    method: "GET",
    url: "/me/settings"
  });
  expect(listResponse.statusCode).toBe(200);
  expect(listResponse.json().sections.length).toBe(5);
  expect(listResponse.json().sections[0].sectionKey).toBe("scheduled_jobs");
  expect(listResponse.json().sections[0].status).toBe("live");
  expect(listResponse.json().sections[1].sectionKey).toBe("github");
  expect(listResponse.json().sections[1].status).toBe("live");

  const updateResponse = await app.inject({
    method: "PUT",
    url: "/me/settings/scheduled_jobs",
    payload: {
      config: {
        defaultTimeZone: "UTC",
        enableOnCreate: true
      }
    }
  });
  expect(updateResponse.statusCode).toBe(200);
  expect(updateResponse.json().section.version).toBe(1);
  expect(updateResponse.json().section.config.defaultTimeZone).toBe("UTC");
  expect(auditEvents.events.length).toBe(1);

  await app.close();
});

// The documented section size limit: 64 KiB of UTF-8.
const SECTION_LIMIT_BYTES = 65_536;
const SECTION_TOO_LARGE = {
  error: "settings_section_too_large",
  message: "The settings section is larger than the 64 KiB limit."
};

// A PUT body of exactly `bytes` UTF-8 bytes. "€" is 3 bytes but 1 UTF-16
// unit, so the string has far fewer characters than bytes.
function sectionBodyOfBytes(bytes: number): string {
  const textBytes = bytes - Buffer.byteLength('{"config":{"note":""}}');
  const text = "€".repeat(Math.floor(textBytes / 3)) + "a".repeat(textBytes % 3);
  const body = `{"config":{"note":"${text}"}}`;
  expect(Buffer.byteLength(body, "utf8")).toBe(bytes);
  return body;
}

function putSection(app: Awaited<ReturnType<typeof createApp>>["app"], body: string, sectionKey = "model") {
  return app.inject({
    method: "PUT",
    url: `/me/settings/${sectionKey}`,
    headers: { "content-type": "application/json" },
    payload: body
  });
}

function recordingLimits(consumed: string[]): SettingsRouteStores["limits"] {
  return {
    async consumeRateLimit(input) {
      consumed.push(input.resource);
      return null;
    },
    async consumeTurnQuota() {
      return null;
    },
    sweepExpired() {}
  };
}

test("a section save accepts a body of exactly 64 KiB of multibyte text", async () => {
  const { app, settings, auditEvents } = await createApp({ appErrorHandler: true });
  const body = sectionBodyOfBytes(SECTION_LIMIT_BYTES);

  const response = await putSection(app, body);

  expect(response.statusCode).toBe(200);
  const [section] = await settings.listSections("settings-tenant", "settings-user");
  expect(section?.config).toEqual(JSON.parse(body).config);
  expect(auditEvents.events.map((event) => event.type)).toEqual(["user.settings.updated"]);
  await app.close();
});

test("a section save one byte over 64 KiB returns 413 with fixed text and writes nothing", async () => {
  const consumed: string[] = [];
  const { app, settings, auditEvents } = await createApp({
    appErrorHandler: true,
    limits: recordingLimits(consumed)
  });
  const body = sectionBodyOfBytes(SECTION_LIMIT_BYTES + 1);
  // The limit counts bytes: this body has fewer characters than the limit.
  expect(body.length).toBeLessThan(SECTION_LIMIT_BYTES / 2);

  const response = await putSection(app, body);

  expect(response.statusCode).toBe(413);
  expect(response.json()).toEqual(SECTION_TOO_LARGE);
  expect(await settings.listSections("settings-tenant", "settings-user")).toEqual([]);
  expect(auditEvents.events).toEqual([]);
  // Fastify refuses the body before the handler runs.
  expect(consumed).toEqual([]);
  await app.close();
});

test("a section save whose config grows past 64 KiB when parsed returns 413 and writes nothing", async () => {
  const pool = new FakePool();
  const { app, settings, auditEvents } = await createApp({ appErrorHandler: true, db: pool.asPool() });
  // `1e20` is 4 bytes in the body; JSON.stringify writes it as 21 digits.
  const body = `{"config":{"n":[${Array.from({ length: 3_500 }, () => "1e20").join(",")}]}}`;
  expect(Buffer.byteLength(body, "utf8")).toBeLessThan(SECTION_LIMIT_BYTES);
  expect(Buffer.byteLength(JSON.stringify(JSON.parse(body).config), "utf8")).toBeGreaterThan(SECTION_LIMIT_BYTES);

  const response = await putSection(app, body);

  expect(response.statusCode).toBe(413);
  expect(response.json()).toEqual(SECTION_TOO_LARGE);
  expect(await settings.listSections("settings-tenant", "settings-user")).toEqual([]);
  expect(auditEvents.events).toEqual([]);
  expect(pool.queries).toEqual([]);
  await app.close();
});


test("a section save accepts exactly 64 KiB of stored config after numeric expansion", async () => {
  const { app, settings } = await createApp({ appErrorHandler: true });
  const compact = `{"config":{"n":[${Array.from({ length: 2_800 }, () => "1e20").join(",")}],"note":""}}`;
  const padding = SECTION_LIMIT_BYTES - Buffer.byteLength(JSON.stringify(JSON.parse(compact).config), "utf8");
  const body = compact.replace('"note":""', `"note":"${"a".repeat(padding)}"`);
  expect(Buffer.byteLength(body, "utf8")).toBeLessThan(SECTION_LIMIT_BYTES);
  expect(Buffer.byteLength(JSON.stringify(JSON.parse(body).config), "utf8")).toBe(SECTION_LIMIT_BYTES);

  const response = await putSection(app, body);

  expect(response.statusCode).toBe(200);
  const [section] = await settings.listSections("settings-tenant", "settings-user");
  expect(section?.config).toEqual(JSON.parse(body).config);
  await app.close();
});

test("section saves keep the scheduled-job defaults and accept empty planned sections", async () => {
  const consumed: string[] = [];
  const { app, auditEvents } = await createApp({ appErrorHandler: true, limits: recordingLimits(consumed) });
  const defaults = { defaultTimeZone: "America/Toronto", enableOnCreate: true };

  expect((await putSection(app, JSON.stringify({ config: defaults }), "scheduled_jobs")).statusCode).toBe(200);
  for (const sectionKey of ["github", "skills", "mcp", "model"]) {
    expect((await putSection(app, JSON.stringify({ config: {} }), sectionKey)).statusCode).toBe(200);
  }

  const list = await app.inject({ method: "GET", url: "/me/settings" });
  const sections = list.json().sections as Array<{ sectionKey: string; version: number; config: unknown }>;
  expect(sections.map(({ sectionKey, version, config }) => ({ sectionKey, version, config }))).toEqual([
    { sectionKey: "scheduled_jobs", version: 1, config: defaults },
    { sectionKey: "github", version: 1, config: {} },
    { sectionKey: "skills", version: 1, config: {} },
    { sectionKey: "mcp", version: 1, config: {} },
    { sectionKey: "model", version: 1, config: {} }
  ]);
  expect(auditEvents.events).toHaveLength(5);
  expect(consumed).toEqual(Array.from({ length: 5 }, () => "settings_write"));
  await app.close();
});

test("section saves use the settings_write limit per user and per tenant, before any write", async () => {
  // The real in-memory limiter, built from app configuration.
  const limits = RequestLimits.fromAppConfig(createTestConfig({
    SETTINGS_WRITE_LIMIT_PER_USER_PER_WINDOW: 2,
    SETTINGS_WRITE_LIMIT_PER_TENANT_PER_WINDOW: 3
  }));
  const { app, settings, auditEvents } = await createApp({ limits });
  const save = (userId: string, tenantId = "settings-tenant") => app.inject({
    method: "PUT",
    url: "/me/settings/scheduled_jobs",
    headers: { "x-user-id": userId, "x-tenant-id": tenantId },
    payload: { config: { defaultTimeZone: "UTC", enableOnCreate: true } }
  });

  expect((await save("user-a")).statusCode).toBe(200);
  expect((await save("user-a")).statusCode).toBe(200);
  const userLimited = await save("user-a");
  expect(userLimited.statusCode).toBe(429);
  expect(Number(userLimited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  expect(userLimited.json()).toMatchObject({
    error: "limit_exceeded",
    resource: "settings_write",
    scope: "user",
    limit: 2,
    message: "User settings write rate limit exceeded."
  });

  // Each user has a key: another member saves until the tenant key is full.
  expect((await save("user-b")).statusCode).toBe(200);
  const tenantLimited = await save("user-b");
  expect(tenantLimited.statusCode).toBe(429);
  expect(tenantLimited.json()).toMatchObject({ resource: "settings_write", scope: "tenant", limit: 3 });

  // Another tenant has its own key.
  expect((await save("user-c", "other-tenant")).statusCode).toBe(200);

  // A refused save writes no section and no audit event.
  expect((await settings.listSections("settings-tenant", "user-a"))[0]?.version).toBe(2);
  expect((await settings.listSections("settings-tenant", "user-b"))[0]?.version).toBe(1);
  expect(auditEvents.events.filter((event) => event.type === "user.settings.updated")).toHaveLength(4);

  // The settings limit is not the scheduled-job creation limit.
  const job = await app.inject({
    method: "POST",
    url: "/me/scheduled-jobs",
    headers: { "x-user-id": "user-a" },
    payload: {
      jobName: "Digest", cronExpression: "0 9 * * *", timeZone: "UTC", targetType: "prompt",
      input: { prompt: "Write the digest." }, enabled: false
    }
  });
  expect(job.statusCode).toBe(201);
  await app.close();
});

test("a settings_write limit of 0 turns that scope off", async () => {
  const limits = RequestLimits.fromAppConfig(createTestConfig({
    SETTINGS_WRITE_LIMIT_PER_USER_PER_WINDOW: 0,
    SETTINGS_WRITE_LIMIT_PER_TENANT_PER_WINDOW: 0
  }));
  const { app } = await createApp({ limits });

  for (let attempt = 0; attempt < 30; attempt += 1) {
    expect((await putSection(app, JSON.stringify({ config: {} }))).statusCode).toBe(200);
  }
  await app.close();
});

test("a section save fails closed with a retryable 503 when the limit store is down", async () => {
  // The real Redis limiter with a Redis that refuses every command.
  const redis = {
    async eval() {
      throw new Error("connect ECONNREFUSED");
    }
  } as unknown as Redis;
  const limits = RedisRequestLimits.fromAppConfig(redis, createTestConfig({}));
  const { app, settings, auditEvents } = await createApp({ appErrorHandler: true, limits });

  const response = await putSection(app, JSON.stringify({ config: {} }));

  expect(response.statusCode).toBe(503);
  expect(response.headers["retry-after"]).toBe("5");
  expect(response.json()).toEqual({
    error: "request_limits_unavailable",
    message: "Request limits are temporarily unavailable."
  });
  expect(await settings.listSections("settings-tenant", "settings-user")).toEqual([]);
  expect(auditEvents.events).toEqual([]);
  await app.close();
});

const snapshotProbeJob = (jobName: string, enabled = false) => ({
  jobName, cronExpression: "0 9 * * *", timeZone: "UTC", targetType: "prompt",
  input: { prompt: "Write the digest." }, enabled
});

test("new and edited jobs do not copy settings sections, even oversized legacy ones", async () => {
  const { app, settings } = await createApp();
  // Rows saved before the size limit can be larger than any save allows now.
  for (const sectionKey of userSettingsSectionKeys) {
    await settings.upsertSection({
      tenantId: "settings-tenant",
      userId: "settings-user",
      sectionKey,
      config: { legacy: "x".repeat(1_000_000) }
    });
  }
  const listSections = vi.spyOn(settings, "listSections");

  const created = await app.inject({ method: "POST", url: "/me/scheduled-jobs", payload: snapshotProbeJob("Digest") });
  expect(created.statusCode).toBe(201);
  expect(created.json().scheduledJob.settingsSnapshot).toEqual({});
  const jobId = created.json().scheduledJob.jobId as string;

  const edited = await app.inject({ method: "PUT", url: `/me/scheduled-jobs/${jobId}`, payload: snapshotProbeJob("Digest 2") });
  expect(edited.statusCode).toBe(200);
  expect(edited.json().scheduledJob.settingsSnapshot).toEqual({});
  expect((await settings.getScheduledJob("settings-tenant", jobId, "settings-user"))?.settingsSnapshot).toEqual({});
  // A job save does not read the sections at all.
  expect(listSections).not.toHaveBeenCalled();
  await app.close();
});

test("a job saved with an old snapshot keeps it until its next edit", async () => {
  const { app, settings } = await createApp();
  const oldSnapshot = { model: { version: 3, config: { legacy: "x".repeat(100_000) } } };
  const jobId = randomUUID();
  await settings.createScheduledJob({
    tenantId: "settings-tenant",
    jobId,
    userId: "settings-user",
    jobName: "Legacy digest",
    description: null,
    cronExpression: "0 9 * * *",
    timeZone: "UTC",
    targetType: "prompt",
    targetRef: null,
    input: { prompt: "Write the digest." },
    settingsSnapshot: oldSnapshot,
    enabled: false,
    nextRunAt: null,
    ownerSecurityVersion: null
  }, { maxActive: 0 });
  await settings.upsertSection({
    tenantId: "settings-tenant",
    userId: "settings-user",
    sectionKey: "model",
    config: { legacy: "y".repeat(100_000) }
  });

  // The API still returns the stored snapshot of a job that nobody edited.
  const listed = await app.inject({ method: "GET", url: "/me/scheduled-jobs" });
  expect(listed.json().scheduledJobs[0].settingsSnapshot).toEqual(oldSnapshot);

  const edited = await app.inject({ method: "PUT", url: `/me/scheduled-jobs/${jobId}`, payload: snapshotProbeJob("Legacy digest") });
  expect(edited.statusCode).toBe(200);
  expect(edited.json().scheduledJob.settingsSnapshot).toEqual({});
  await app.close();
});

test("scheduled jobs routes create, update, validate, and delete jobs", async () => {
  const { app, auditEvents } = await createApp();

  const createResponse = await app.inject({
    method: "POST",
    url: "/me/scheduled-jobs",
    payload: {
      jobName: "Daily artifact digest",
      description: "Summarize what changed overnight.",
      cronExpression: "0 9 * * 1-5",
      timeZone: "UTC",
      targetType: "prompt",
      input: {
        prompt: "Summarize ready artifacts and pending approvals."
      },
      enabled: true
    }
  });
  expect(createResponse.statusCode).toBe(201);
  expect(createResponse.json().scheduledJob.jobName).toBe("Daily artifact digest");
  expect(createResponse.json().scheduledJob.nextRunAt).toBeTruthy();

  const jobId = createResponse.json().scheduledJob.jobId as string;

  const listResponse = await app.inject({
    method: "GET",
    url: "/me/scheduled-jobs"
  });
  expect(listResponse.statusCode).toBe(200);
  expect(listResponse.json().scheduledJobs.length).toBe(1);

  const updateResponse = await app.inject({
    method: "PUT",
    url: `/me/scheduled-jobs/${jobId}`,
    payload: {
      jobName: "Morning artifact digest",
      description: "Summarize overnight work.",
      cronExpression: "30 8 * * 1-5",
      timeZone: "UTC",
      targetType: "prompt",
      input: {
        prompt: "Summarize overnight work and post priorities."
      },
      enabled: false
    }
  });
  expect(updateResponse.statusCode).toBe(200);
  expect(updateResponse.json().scheduledJob.jobName).toBe("Morning artifact digest");
  expect(updateResponse.json().scheduledJob.nextRunAt).toBe(null);

  const invalidResponse = await app.inject({
    method: "POST",
    url: "/me/scheduled-jobs",
    payload: {
      jobName: "Broken job",
      cronExpression: "bad cron",
      timeZone: "UTC",
      targetType: "prompt",
      input: {
        prompt: "This should fail."
      },
      enabled: true
    }
  });
  expect(invalidResponse.statusCode).toBe(400);
  expect(invalidResponse.json().error).toBe("invalid_request");

  const deleteResponse = await app.inject({
    method: "DELETE",
    url: `/me/scheduled-jobs/${jobId}`
  });
  expect(deleteResponse.statusCode).toBe(204);
  expect(auditEvents.events.length).toBe(3);

  await app.close();
});

test("a job keeps the security version of the session that saved it; an edit confirms a paused job", async () => {
  const { app, settings, auditEvents } = await createApp();
  const job = (enabled: boolean) => ({
    jobName: "Digest", cronExpression: "0 9 * * *", timeZone: "UTC", targetType: "prompt",
    input: { prompt: "Write the digest." }, enabled
  });

  const local = await app.inject({
    method: "POST", url: "/me/scheduled-jobs", headers: { "x-security-version": "4" }, payload: job(true)
  });
  expect(local.statusCode).toBe(201);
  const jobId = local.json().scheduledJob.jobId as string;
  expect(settings.ownerSecurityVersions.get(jobId)).toBe(4);
  // The version is account state: the API does not return it.
  expect(local.json().scheduledJob).not.toHaveProperty("ownerSecurityVersion");
  expect(local.json().scheduledJob.pausedReason).toBeNull();

  // WorkOS accounts have no security version here.
  const workos = await app.inject({
    method: "POST", url: "/me/scheduled-jobs", headers: { "x-security-version": "workos" }, payload: job(true)
  });
  expect(settings.ownerSecurityVersions.get(workos.json().scheduledJob.jobId as string)).toBeNull();

  // The scheduler paused the job after a security change. The list shows why.
  settings.pauseForSecurityChange(jobId);
  const listed = (await app.inject({ method: "GET", url: "/me/scheduled-jobs" })).json().scheduledJobs as Array<Record<string, unknown>>;
  expect(listed.find((row) => row.jobId === jobId)).toMatchObject({ enabled: false, pausedReason: "security_change" });

  // The owner's edit from a current session stores that session's version
  // and turns the job on again.
  const resumed = await app.inject({
    method: "PUT", url: `/me/scheduled-jobs/${jobId}`, headers: { "x-security-version": "5" }, payload: job(true)
  });
  expect(resumed.statusCode).toBe(200);
  expect(resumed.json().scheduledJob).toMatchObject({ enabled: true, pausedReason: null });
  expect(settings.ownerSecurityVersions.get(jobId)).toBe(5);
  expect(auditEvents.events.at(-1)).toMatchObject({
    type: "user.scheduled_job.updated",
    payload: { jobId, enabled: true, previousPausedReason: "security_change" }
  });

  await app.close();
});

test("a review that turns on a job paused after a security change does not use the creation rate limit", async () => {
  const consumed: string[] = [];
  const { app, settings } = await createApp({
    // One active job at most, so the cap check is visible.
    config: createTestConfig({ SCHEDULED_JOB_MAX_ACTIVE_PER_USER: 1 }),
    limits: {
      async consumeRateLimit(input) {
        consumed.push(input.resource);
        return {
          error: "limit_exceeded", limitType: "rate_limit", resource: input.resource, scope: "user", limit: 10,
          retryAfterMs: 30_000, resetAt: new Date(Date.now() + 30_000).toISOString(), message: "Too many new jobs."
        };
      },
      async consumeTurnQuota() {
        return null;
      },
      sweepExpired() {}
    } satisfies SettingsRouteStores["limits"]
  });
  const fields = (jobId: string, enabled: boolean) => ({
    tenantId: "settings-tenant", jobId, userId: "settings-user", jobName: jobId, description: null,
    cronExpression: "0 9 * * *", timeZone: "UTC", targetType: "prompt" as const, targetRef: null,
    input: { prompt: "Write the digest." }, settingsSnapshot: {}, enabled, nextRunAt: null, ownerSecurityVersion: 1
  });
  const [pausedA, pausedB, offByChoice] = [randomUUID(), randomUUID(), randomUUID()];
  await settings.createScheduledJob(fields(pausedA, true), { maxActive: 0 });
  await settings.createScheduledJob(fields(pausedB, true), { maxActive: 0 });
  await settings.createScheduledJob(fields(offByChoice, false), { maxActive: 0 });
  settings.pauseForSecurityChange(pausedA);
  settings.pauseForSecurityChange(pausedB);
  const enable = (jobId: string) => app.inject({
    method: "PUT", url: `/me/scheduled-jobs/${jobId}`, headers: { "x-security-version": "2" },
    payload: { jobName: jobId, cronExpression: "0 9 * * *", timeZone: "UTC", targetType: "prompt", input: { prompt: "Write the digest." }, enabled: true }
  });

  // The limiter refuses every request, but the review is not counted.
  const resumed = await enable(pausedA);
  expect(resumed.statusCode).toBe(200);
  expect(resumed.json().scheduledJob).toMatchObject({ enabled: true, pausedReason: null });
  expect(consumed).toEqual([]);

  // The active-job cap still applies to a review.
  const capped = await enable(pausedB);
  expect(capped.statusCode).toBe(409);
  expect(capped.json()).toMatchObject({ error: "scheduled_job_limit_reached" });

  // A job that the owner turned off still uses the limit.
  const throttled = await enable(offByChoice);
  expect(throttled.statusCode).toBe(429);
  expect(consumed).toEqual(["scheduled_job_create"]);

  await app.close();
});

test("in dev-headers mode a job keeps the account's current version; in jwt mode a request without a session stores none", async () => {
  const payload = { jobName: "Digest", cronExpression: "0 9 * * *", timeZone: "UTC", targetType: "prompt", input: { prompt: "Write the digest." }, enabled: true };

  const dev = await createApp({ config: createTestConfig({ AUTH_MODE: "dev-headers" }) });
  dev.settings.currentSecurityVersion = 7;
  const devJob = await dev.app.inject({ method: "POST", url: "/me/scheduled-jobs", payload });
  expect(dev.settings.ownerSecurityVersions.get(devJob.json().scheduledJob.jobId as string)).toBe(7);
  // A session still decides when one exists.
  const withSession = await dev.app.inject({ method: "POST", url: "/me/scheduled-jobs", headers: { "x-security-version": "3" }, payload });
  expect(dev.settings.ownerSecurityVersions.get(withSession.json().scheduledJob.jobId as string)).toBe(3);
  await dev.app.close();

  const jwt = await createApp({ config: createTestConfig({ AUTH_MODE: "jwt" }) });
  jwt.settings.currentSecurityVersion = 7;
  const jwtJob = await jwt.app.inject({ method: "POST", url: "/me/scheduled-jobs", payload });
  expect(jwt.settings.ownerSecurityVersions.get(jwtJob.json().scheduledJob.jobId as string)).toBeNull();
  await jwt.app.close();
});

test("saving an enabled job rejects a prompt the PII policy blocks", async () => {
  let outage = false;
  const { app, settings } = await createApp({
    piiProtection: {
      async evaluateText({ text }) {
        if (outage) throw new PiiProtectionServiceError("pii_provider_unavailable", "down");
        return text.includes("@")
          ? { action: "block", findings: [], blockReason: "email", providerType: null, providerModel: null }
          : { action: "allow", reason: "no_findings" };
      }
    }
  });
  const job = (prompt: string, enabled: boolean) => ({
    jobName: "Job", cronExpression: "0 9 * * *", timeZone: "UTC", targetType: "prompt", input: { prompt }, enabled
  });

  const blocked = await app.inject({ method: "POST", url: "/me/scheduled-jobs", payload: job("Mail jane@example.com", true) });
  expect(blocked.statusCode).toBe(422);
  expect(blocked.json().error).toBe("pii_block");

  const created = await app.inject({ method: "POST", url: "/me/scheduled-jobs", payload: job("Daily report", true) });
  expect(created.statusCode).toBe(201);
  const url = `/me/scheduled-jobs/${created.json().scheduledJob.jobId}`;
  expect((await app.inject({ method: "PUT", url, payload: job("Mail jane@example.com", true) })).statusCode).toBe(422);
  // A disabled job does not run, so the owner can always save it.
  expect((await app.inject({ method: "PUT", url, payload: job("Mail jane@example.com", false) })).statusCode).toBe(200);

  // An outage does not stop the save: the run-time check still applies.
  outage = true;
  expect((await app.inject({ method: "POST", url: "/me/scheduled-jobs", payload: job("Mail jane@example.com", true) })).statusCode).toBe(201);
  expect((await settings.listScheduledJobs("settings-tenant", "settings-user")).length).toBe(2);

  await app.close();
});

test("scheduled job preview uses the scheduler parser without saving a job", async () => {
  const { app, auditEvents } = await createApp();
  try {
    const before = new Date();
    const response = await app.inject({
      method: "POST",
      url: "/me/scheduled-jobs/preview",
      payload: { cronExpression: "30 9 * * 1", timeZone: "America/Toronto" }
    });
    const after = new Date();
    expect(response.statusCode).toBe(200);
    expect([
      computeNextCronRunAt("30 9 * * 1", "America/Toronto", before),
      computeNextCronRunAt("30 9 * * 1", "America/Toronto", after)
    ]).toContain(response.json().nextRunAt);

    const invalid = await app.inject({
      method: "POST",
      url: "/me/scheduled-jobs/preview",
      payload: { cronExpression: "bad cron", timeZone: "America/Toronto" }
    });
    expect(invalid.statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/me/scheduled-jobs" })).json().scheduledJobs).toEqual([]);
    expect(auditEvents.events).toHaveLength(0);
  } finally {
    await app.close();
  }
});

test("scheduled job request defaults reach create and update persistence", async () => {
  const { app } = await createApp();
  const payload = {
    jobName: "Defaulted job",
    cronExpression: "0 9 * * 1-5",
    timeZone: "UTC",
    input: { prompt: "Run with request defaults." }
  };

  const created = await app.inject({
    method: "POST",
    url: "/me/scheduled-jobs",
    payload
  });
  expect(created.statusCode).toBe(201);
  expect(created.json().scheduledJob).toMatchObject({
    targetType: "prompt",
    enabled: true
  });

  const updated = await app.inject({
    method: "PUT",
    url: `/me/scheduled-jobs/${created.json().scheduledJob.jobId}`,
    payload: { ...payload, jobName: "Defaulted job updated" }
  });
  expect(updated.statusCode).toBe(200);
  expect(updated.json().scheduledJob).toMatchObject({
    jobName: "Defaulted job updated",
    targetType: "prompt",
    enabled: true
  });

  await app.close();
});

test("run history route returns empty runs for a job", async () => {
  const { app } = await createApp();

  const createResponse = await app.inject({
    method: "POST",
    url: "/me/scheduled-jobs",
    payload: {
      jobName: "History test job",
      cronExpression: "0 9 * * 1-5",
      timeZone: "UTC",
      targetType: "prompt",
      input: { prompt: "Test prompt." },
      enabled: true
    }
  });
  expect(createResponse.statusCode).toBe(201);
  const jobId = createResponse.json().scheduledJob.jobId as string;

  const runsResponse = await app.inject({
    method: "GET",
    url: `/me/scheduled-jobs/${jobId}/runs`
  });
  expect(runsResponse.statusCode).toBe(200);
  expect(runsResponse.json().runs.length).toBe(0);

  await app.close();
});

test("active-job cap counts only enabled jobs, not disabled ones", async () => {
  const { app } = await createApp({
    config: createTestConfig({ SCHEDULED_JOB_MAX_ACTIVE_PER_USER: 1 })
  });

  const makeJob = (jobName: string, enabled: boolean) =>
    app.inject({
      method: "POST",
      url: "/me/scheduled-jobs",
      payload: {
        jobName,
        cronExpression: "0 9 * * 1-5",
        timeZone: "UTC",
        targetType: "prompt",
        input: { prompt: "Test prompt." },
        enabled
      }
    });

  // First enabled job fills the cap of 1.
  const first = await makeJob("Job A", true);
  expect(first.statusCode).toBe(201);
  const firstId = first.json().scheduledJob.jobId as string;

  // Second enabled job is rejected — cap reached.
  const blocked = await makeJob("Job B", true);
  expect(blocked.statusCode).toBe(409);
  expect(blocked.json().error).toBe("scheduled_job_limit_reached");

  // Creating a DISABLED job while at the cap must still succeed — disabled jobs
  // don't fire turns, so they don't count against the active cap.
  const disabledCreate = await makeJob("Job B-disabled", false);
  expect(disabledCreate.statusCode).toBe(201);

  // Disable the first job; it no longer fires turns, so it must free a slot.
  const disable = await app.inject({
    method: "PUT",
    url: `/me/scheduled-jobs/${firstId}`,
    payload: {
      jobName: "Job A",
      cronExpression: "0 9 * * 1-5",
      timeZone: "UTC",
      targetType: "prompt",
      input: { prompt: "Test prompt." },
      enabled: false
    }
  });
  expect(disable.statusCode).toBe(200);

  // Now a new enabled job can be created again.
  const afterDisable = await makeJob("Job C", true);
  expect(afterDisable.statusCode).toBe(201);

  await app.close();
});

test("PUT cannot bypass the active-job cap by enabling a disabled job", async () => {
  // A user at the cap could create N disabled jobs and PUT-enable
  // them all — the disabled→enabled transition must hit the same cap as POST.
  const { app } = await createApp({
    config: createTestConfig({ SCHEDULED_JOB_MAX_ACTIVE_PER_USER: 1 })
  });

  const jobPayload = (jobName: string, enabled: boolean) => ({
    jobName,
    cronExpression: "0 9 * * 1-5",
    timeZone: "UTC",
    targetType: "prompt",
    input: { prompt: "Test prompt." },
    enabled
  });

  const enabledJob = await app.inject({
    method: "POST",
    url: "/me/scheduled-jobs",
    payload: jobPayload("Job A", true)
  });
  expect(enabledJob.statusCode).toBe(201);
  const enabledJobId = enabledJob.json().scheduledJob.jobId as string;

  const disabledJob = await app.inject({
    method: "POST",
    url: "/me/scheduled-jobs",
    payload: jobPayload("Job B", false)
  });
  expect(disabledJob.statusCode).toBe(201);
  const disabledJobId = disabledJob.json().scheduledJob.jobId as string;

  // Enabling Job B while Job A holds the only slot must be rejected.
  const blocked = await app.inject({
    method: "PUT",
    url: `/me/scheduled-jobs/${disabledJobId}`,
    payload: jobPayload("Job B", true)
  });
  expect(blocked.statusCode).toBe(409);
  expect(blocked.json().error).toBe("scheduled_job_limit_reached");

  // Updating the already-enabled job (it counts against the cap itself) must
  // NOT be blocked — staying enabled adds nothing to the active count.
  const renameEnabled = await app.inject({
    method: "PUT",
    url: `/me/scheduled-jobs/${enabledJobId}`,
    payload: jobPayload("Job A renamed", true)
  });
  expect(renameEnabled.statusCode).toBe(200);

  // Free the slot, then the enable transition succeeds.
  const disableA = await app.inject({
    method: "PUT",
    url: `/me/scheduled-jobs/${enabledJobId}`,
    payload: jobPayload("Job A renamed", false)
  });
  expect(disableA.statusCode).toBe(200);

  const enableB = await app.inject({
    method: "PUT",
    url: `/me/scheduled-jobs/${disabledJobId}`,
    payload: jobPayload("Job B", true)
  });
  expect(enableB.statusCode).toBe(200);
  expect(enableB.json().scheduledJob.enabled).toBe(true);

  await app.close();
});

test("scheduled job writes pass the configured cap to the store and keep the 409 messages", async () => {
  const { app, settings } = await createApp({
    config: createTestConfig({ SCHEDULED_JOB_MAX_ACTIVE_PER_USER: 1 })
  });
  const jobPayload = (enabled: boolean) => ({
    jobName: "Cap probe",
    cronExpression: "0 9 * * 1-5",
    timeZone: "UTC",
    targetType: "prompt",
    input: { prompt: "Test prompt." },
    enabled
  });

  const first = await app.inject({ method: "POST", url: "/me/scheduled-jobs", payload: jobPayload(true) });
  expect(first.statusCode).toBe(201);
  const create = await app.inject({ method: "POST", url: "/me/scheduled-jobs", payload: jobPayload(true) });
  expect(create.statusCode).toBe(409);
  expect(create.json()).toMatchObject({ error: "scheduled_job_limit_reached" });
  expect(create.json().message).toContain("before creating a new one");

  const parked = await app.inject({ method: "POST", url: "/me/scheduled-jobs", payload: jobPayload(false) });
  const enable = await app.inject({
    method: "PUT",
    url: `/me/scheduled-jobs/${parked.json().scheduledJob.jobId}`,
    payload: jobPayload(true)
  });
  expect(enable.statusCode).toBe(409);
  expect(enable.json()).toMatchObject({ error: "scheduled_job_limit_reached" });
  expect(enable.json().message).toContain("before enabling this one");

  // Every write hands the store the cap. The route does not count itself.
  expect(settings.admissions).toEqual(Array(4).fill({ maxActive: 1 }));

  await app.close();
});

test("a cap of 0 disables the active-job cap for creates and enables", async () => {
  const { app, settings } = await createApp({
    config: createTestConfig({ SCHEDULED_JOB_MAX_ACTIVE_PER_USER: 0 })
  });
  const jobPayload = (enabled: boolean) => ({
    jobName: "Uncapped",
    cronExpression: "0 9 * * 1-5",
    timeZone: "UTC",
    targetType: "prompt",
    input: { prompt: "Test prompt." },
    enabled
  });

  for (let index = 0; index < 3; index += 1) {
    const created = await app.inject({ method: "POST", url: "/me/scheduled-jobs", payload: jobPayload(true) });
    expect(created.statusCode).toBe(201);
  }
  const parked = await app.inject({ method: "POST", url: "/me/scheduled-jobs", payload: jobPayload(false) });
  const enable = await app.inject({
    method: "PUT",
    url: `/me/scheduled-jobs/${parked.json().scheduledJob.jobId}`,
    payload: jobPayload(true)
  });
  expect(enable.statusCode).toBe(200);
  expect(settings.admissions.every((admission) => admission.maxActive === 0)).toBe(true);

  await app.close();
});

test("PUT enable meets the cap even when the route's earlier read of the job is stale", async () => {
  const consumed: string[] = [];
  const { app, settings } = await createApp({
    config: createTestConfig({ SCHEDULED_JOB_MAX_ACTIVE_PER_USER: 1 }),
    limits: {
      async consumeRateLimit(input: { resource: string }) {
        consumed.push(input.resource);
        return null;
      },
      async consumeTurnQuota() {
        return null;
      },
      sweepExpired() {}
    } as SettingsRouteStores["limits"]
  });
  const jobPayload = (enabled: boolean) => ({
    jobName: "Stale read",
    cronExpression: "0 9 * * 1-5",
    timeZone: "UTC",
    targetType: "prompt",
    input: { prompt: "Test prompt." },
    enabled
  });

  await app.inject({ method: "POST", url: "/me/scheduled-jobs", payload: jobPayload(true) });
  const parked = await app.inject({ method: "POST", url: "/me/scheduled-jobs", payload: jobPayload(false) });
  const parkedId = parked.json().scheduledJob.jobId as string;
  consumed.length = 0;

  // The job is disabled in the store, but the read before the write still says
  // enabled, as if another request disabled it in between. With that stale
  // read the route sees no transition, so only the store can enforce the cap.
  const realGet = settings.getScheduledJob.bind(settings);
  settings.getScheduledJob = async (...args) => {
    const job = await realGet(...args);
    return job ? { ...job, enabled: true } : null;
  };

  const response = await app.inject({
    method: "PUT",
    url: `/me/scheduled-jobs/${parkedId}`,
    payload: jobPayload(true)
  });
  expect(response.statusCode).toBe(409);
  expect(response.json()).toMatchObject({ error: "scheduled_job_limit_reached" });
  expect(consumed).toEqual([]);

  await app.close();
});

test("PUT enable transition consumes the scheduled_job_create rate limit; other updates do not", async () => {
  const consumed: string[] = [];
  let rejectNext = false;
  const { app } = await createApp({
    limits: {
      async consumeRateLimit(input: { resource: string }) {
        consumed.push(input.resource);
        if (rejectNext) {
          return { error: "rate_limited", retryAfterMs: 30_000 };
        }
        return null;
      },
      async consumeTurnQuota() {
        return null;
      },
      sweepExpired() {}
    } as SettingsRouteStores["limits"]
  });

  const jobPayload = (enabled: boolean) => ({
    jobName: "Rate limit probe",
    cronExpression: "0 9 * * 1-5",
    timeZone: "UTC",
    targetType: "prompt",
    input: { prompt: "Test prompt." },
    enabled
  });

  const created = await app.inject({
    method: "POST",
    url: "/me/scheduled-jobs",
    payload: jobPayload(false)
  });
  expect(created.statusCode).toBe(201);
  const jobId = created.json().scheduledJob.jobId as string;
  expect(consumed).toEqual(["scheduled_job_create"]); // POST consumed one

  // A disabled→disabled update consumes nothing.
  const plainUpdate = await app.inject({
    method: "PUT",
    url: `/me/scheduled-jobs/${jobId}`,
    payload: jobPayload(false)
  });
  expect(plainUpdate.statusCode).toBe(200);
  expect(consumed).toEqual(["scheduled_job_create"]);

  // The disabled→enabled transition consumes the creation rate limit and is
  // rejected with 429 when the limiter says no.
  rejectNext = true;
  const throttled = await app.inject({
    method: "PUT",
    url: `/me/scheduled-jobs/${jobId}`,
    payload: jobPayload(true)
  });
  expect(throttled.statusCode).toBe(429);
  expect(throttled.headers["retry-after"]).toBe("30");
  expect(consumed).toEqual(["scheduled_job_create", "scheduled_job_create"]);

  // The job is still disabled — the throttled request must not have applied.
  rejectNext = false;
  const list = await app.inject({ method: "GET", url: "/me/scheduled-jobs" });
  expect(list.json().scheduledJobs[0].enabled).toBe(false);

  const enable = await app.inject({
    method: "PUT",
    url: `/me/scheduled-jobs/${jobId}`,
    payload: jobPayload(true)
  });
  expect(enable.statusCode).toBe(200);
  expect(consumed).toEqual(["scheduled_job_create", "scheduled_job_create", "scheduled_job_create"]);

  await app.close();
});

test("github connection routes expose status, authorization URL, and disconnect flow", async () => {
  const { app, githubConnections } = await createApp();

  githubConnections.userConnection = {
    githubUserId: "12345",
    githubLogin: "octocat",
    githubName: "The Octocat",
    githubEmail: "octocat@example.com",
    githubAvatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
    scopes: [],
    allowedRepositories: ["octocat/hello-world"],
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    connectedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastUsedAt: null,
    suspended: false
  };

  const statusResponse = await app.inject({
    method: "GET",
    url: "/me/github-connection"
  });
  expect(statusResponse.statusCode).toBe(200);
  expect(statusResponse.json().userConnection.githubLogin).toBe("octocat");
  expect(statusResponse.json().userConnection.allowedRepositories).toEqual(["octocat/hello-world"]);

  const authorizeResponse = await app.inject({
    method: "POST",
    url: "/me/github-connection/authorize",
    headers: { "x-security-version": "4" }
  });
  expect(authorizeResponse.statusCode).toBe(200);
  expect(authorizeResponse.json().url as string).toMatch(/client_id=test-client/);
  expect(githubConnections.authorizeRequested).toBe(true);
  // The signed OAuth state carries the version of the session that started it.
  expect(githubConnections.authorizeVersion).toBe(4);
  const bindingCookie = authorizeResponse.cookies.find((c) => c.name === "cogniplane_oauth_bind_github");
  expect(bindingCookie).toMatchObject({
    value: "github-nonce",
    httpOnly: true,
    secure: true,
    sameSite: "None",
    path: "/auth/github/user/callback",
    maxAge: 600
  });

  const disconnectResponse = await app.inject({
    method: "DELETE",
    url: "/me/github-connection"
  });
  expect(disconnectResponse.statusCode).toBe(204);
  expect(githubConnections.userConnection).toBe(null);

  await app.close();
});

test("github repository routes list the choices and save the allowed list for the signed-in user", async () => {
  const { app, githubConnections } = await createApp();
  githubConnections.userConnection = connectedAs("12345");

  const listing = await app.inject({ method: "GET", url: "/me/github-connection/repositories" });
  expect(listing.statusCode).toBe(200);
  expect(listing.json()).toEqual({
    repositories: [{ fullName: "Acme/App", private: true, archived: false }],
    truncated: false
  });

  const saved = await app.inject({
    method: "PUT",
    url: "/me/github-connection/repositories",
    payload: { githubUserId: "12345", repositories: ["  Acme/App ", "octocat/Hello-World"] }
  });
  expect(saved.statusCode).toBe(200);
  expect(saved.json()).toEqual({ allowedRepositories: ["acme/app", "octocat/hello-world"] });
  expect(githubConnections.savedLists).toEqual([["Acme/App", "octocat/Hello-World"]]);

  const cleared = await app.inject({
    method: "PUT",
    url: "/me/github-connection/repositories",
    payload: { githubUserId: "12345", repositories: [] }
  });
  expect(cleared.statusCode).toBe(200);
  expect(cleared.json()).toEqual({ allowedRepositories: [] });

  await app.close();
});

test("github repository update for another GitHub account answers 409 and saves nothing", async () => {
  const { app, githubConnections } = await createApp();
  // A tab prepared the list for account A. Account B is connected now.
  githubConnections.userConnection = connectedAs("B");

  const response = await app.inject({
    method: "PUT",
    url: "/me/github-connection/repositories",
    payload: { githubUserId: "A", repositories: ["a-org/secret"] }
  });

  expect(response.statusCode).toBe(409);
  expect(response.json().error).toBe("github_account_changed");
  expect(githubConnections.savedLists).toEqual([]);
  expect(githubConnections.userConnection?.allowedRepositories).toEqual([]);
  await app.close();
});

test.each([
  ["a name without an owner", { githubUserId: "12345", repositories: ["app"] }],
  ["a path segment", { githubUserId: "12345", repositories: ["acme/app/contents"] }],
  ["a dot segment", { githubUserId: "12345", repositories: ["acme/.."] }],
  ["a value that is not a string", { githubUserId: "12345", repositories: [42] }],
  ["more than 200 entries", { githubUserId: "12345", repositories: Array.from({ length: 201 }, (_, i) => `acme/repo-${i}`) }],
  ["an unknown field", { githubUserId: "12345", repositories: ["acme/app"], userId: "someone-else" }],
  ["no GitHub account", { repositories: ["acme/app"] }],
  ["an empty GitHub account", { githubUserId: "", repositories: ["acme/app"] }],
  ["no list", { githubUserId: "12345" }]
])("github repository update rejects %s without saving", async (_label, payload) => {
  const { app, githubConnections } = await createApp();

  const response = await app.inject({ method: "PUT", url: "/me/github-connection/repositories", payload });

  expect(response.statusCode).toBe(400);
  expect(response.json().error).toBe("invalid_request");
  expect(githubConnections.savedLists).toEqual([]);
  await app.close();
});

test.each([
  ["no connection", new GithubConnectionError("not_connected", "GitHub is not connected."), 404, "github_not_connected"],
  ["an unusable token", new GithubConnectionError("credentials_unusable", "Connect GitHub again."), 409, "github_credentials_unusable"],
  ["a changed account", new GithubConnectionError("account_changed", "Reload the page."), 409, "github_account_changed"],
  ["a GitHub failure", new GithubConnectionError("upstream_unavailable", "Try again."), 502, "github_upstream_unavailable"],
  ["a missing GitHub OAuth app", new GithubConnectionNotConfiguredError(), 503, "github_integration_not_configured"],
  ["a list that the service rejects", new InvalidGithubRepositoryListError("Each repository must use the form owner/name."), 400, "invalid_request"]
])("github repository routes answer %s with a typed error", async (_label, failure, status, code) => {
  const { app, githubConnections } = await createApp();
  githubConnections.failure = failure;

  const listing = await app.inject({ method: "GET", url: "/me/github-connection/repositories" });
  const saved = await app.inject({
    method: "PUT",
    url: "/me/github-connection/repositories",
    payload: { githubUserId: "12345", repositories: ["acme/app"] }
  });

  for (const response of [listing, saved]) {
    expect(response.statusCode).toBe(status);
    expect(response.json().error).toBe(code);
  }
  await app.close();
});

test("notion connection routes expose status, authorization URL, and disconnect flow", async () => {
  const { app, notionConnections } = await createApp();

  notionConnections.userConnection = {
    notionUserId: "notion-user-1",
    notionWorkspaceId: "ws-xyz",
    notionWorkspaceName: "Test Workspace",
    notionWorkspaceIcon: null,
    notionOwnerEmail: "owner@example.com",
    notionOwnerName: "Test Owner",
    scopes: [],
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    connectedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastUsedAt: null,
    suspended: false
  };

  const statusResponse = await app.inject({
    method: "GET",
    url: "/me/notion-connection"
  });
  expect(statusResponse.statusCode).toBe(200);
  expect(statusResponse.json().configured).toBe(true);
  expect(statusResponse.json().userConnection.notionWorkspaceName).toBe("Test Workspace");

  const authorizeResponse = await app.inject({
    method: "POST",
    url: "/me/notion-connection/authorize",
    headers: { "x-security-version": "workos" }
  });
  expect(authorizeResponse.statusCode).toBe(200);
  expect(authorizeResponse.json().url as string).toMatch(/api\.notion\.com\/v1\/oauth\/authorize/);
  expect(notionConnections.authorizeRequested).toBe(true);
  // A WorkOS session has no security version.
  expect(notionConnections.authorizeVersion).toBeNull();

  const disconnectResponse = await app.inject({
    method: "DELETE",
    url: "/me/notion-connection"
  });
  expect(disconnectResponse.statusCode).toBe(204);
  expect(notionConnections.userConnection).toBe(null);

  // Disconnect again returns 404 when nothing to remove.
  const secondDisconnect = await app.inject({
    method: "DELETE",
    url: "/me/notion-connection"
  });
  expect(secondDisconnect.statusCode).toBe(404);

  await app.close();
});

test("connection status endpoints expose tenant enablement and platform configuration", async () => {
  const { app } = await createApp({
    config: createTestConfig({
      NOTION_OAUTH_CLIENT_ID: "client",
      NOTION_OAUTH_CLIENT_SECRET: "secret",
      NOTION_OAUTH_REDIRECT_URI: "https://example.com/callback"
    }),
    integrationStates: {
      async get(_tenantId, integrationId) {
        if (integrationId === "notion") {
          return {
            tenantId: "settings-tenant",
            integrationId: "notion",
            readsEnabled: true,
            writesEnabled: false,
            config: {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            updatedBy: "admin-user"
          };
        }
        return null;
      }
    }
  });

  const response = await app.inject({ method: "GET", url: "/me/notion-connection" });
  expect(response.statusCode).toBe(200);
  const body = response.json() as {
    tenantEnabled: boolean;
    tenantReadsEnabled: boolean;
    tenantWritesEnabled: boolean;
    platformConfigured: boolean;
  };
  expect(body.tenantEnabled).toBe(true);
  expect(body.tenantReadsEnabled).toBe(true);
  expect(body.tenantWritesEnabled).toBe(false);
  expect(body.platformConfigured).toBe(true);

  await app.close();
});

test("/me/integrations-availability returns the user's enabled integrations", async () => {
  const { app } = await createApp({
    integrationRegistry: {
      async getIntegrationsForUser() {
        return [
          {
            id: "notion",
            name: "Notion",
            logoSlug: "notion",
            category: "Productivity",
            readsEnabled: true,
            writesEnabled: false
          }
        ];
      }
    }
  });

  const response = await app.inject({ method: "GET", url: "/me/integrations-availability" });
  expect(response.statusCode).toBe(200);
  const body = response.json() as { enabled: Array<{ id: string }> };
  expect(body.enabled.length).toBe(1);
  expect(body.enabled[0].id).toBe("notion");

  await app.close();
});

// ─── GET /me/token-usage ────────────────────────────────────────────────────

function tokenUsagePool(rows: { daily?: QueryResultRow[]; byModel?: QueryResultRow[]; totals?: QueryResultRow[] } = {}) {
  const pick = (list: QueryResultRow[] = []) => () => ({ rows: list, rowCount: list.length });
  // The grouped queries first: the totals pattern also matches them.
  return new FakePool()
    .onQuery(/INSERT INTO users/, () => ({ rows: [], rowCount: 1 }))
    .onQuery(/GROUP BY DATE\(/, pick(rows.daily))
    .onQuery(/GROUP BY COALESCE\(model_name/, pick(rows.byModel))
    .onQuery(/COUNT\(\*\)::bigint\s+AS message_count/, pick(rows.totals));
}

const usageQueryValues = (pool: FakePool) =>
  pool.queries.filter((query) => query.text.includes("FROM messages")).map((query) => query.values);

test.each([
  [undefined, 30],
  ["1", 1],
  ["7", 7],
  ["365", 365],
  ["0", 30],
  ["366", 30],
  ["soon", 30]
])("token usage reads days=%s as a %i-day window for the caller's own tenant and user", async (days, window) => {
  const pool = tokenUsagePool();
  const { app } = await createApp({ db: pool.asPool() });

  const response = await app.inject({
    method: "GET",
    url: days === undefined ? "/me/token-usage" : `/me/token-usage?days=${days}&userId=someone-else`,
    headers: { "x-user-id": "user-1", "x-tenant-id": "tenant-A" }
  });

  expect(response.statusCode).toBe(200);
  expect(response.json().days).toBe(window);
  expect(usageQueryValues(pool)).toEqual([
    ["tenant-A", "user-1", window],
    ["tenant-A", "user-1", window],
    ["tenant-A", "user-1", window]
  ]);
});

test("token usage maps database numbers and reports zeros without usage", async () => {
  const pool = tokenUsagePool({
    daily: [{ date: "2026-10-01", input_tokens: "10", output_tokens: "5", total_tokens: "15", cost_usd: 0.25 }],
    byModel: [{ model_name: "model-a", input_tokens: "10", output_tokens: "5", total_tokens: "15", cost_usd: 0.25 }]
  });
  const { app } = await createApp({ db: pool.asPool() });

  const { usage } = (await app.inject({ method: "GET", url: "/me/token-usage" })).json();

  expect(usage).toEqual({
    daily: [{ date: "2026-10-01", inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.25 }],
    byModel: [{ modelName: "model-a", inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.25 }],
    totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, messageCount: 0 }
  });
});

test("token usage rejects a repeated days parameter", async () => {
  const pool = tokenUsagePool();
  const { app } = await createApp({ db: pool.asPool() });

  const response = await app.inject({ method: "GET", url: "/me/token-usage?days=7&days=30" });

  expect(response.statusCode).toBe(400);
  expect(usageQueryValues(pool)).toEqual([]);
});


// Confirm stores the security version of the requesting session.
test("github and notion confirm routes pass the session's security version and map refusals", async () => {
  const { app, githubConnections, notionConnections } = await createApp();
  githubConnections.userConnection = { ...connectedAs("12345"), suspended: true };

  const confirmed = await app.inject({
    method: "POST", url: "/me/github-connection/confirm",
    headers: { "x-security-version": "6" }, payload: { githubUserId: "12345" }
  });
  expect(confirmed.statusCode).toBe(200);
  expect(confirmed.json().userConnection).toMatchObject({ githubUserId: "12345", suspended: false });
  expect(githubConnections.confirmed).toEqual([{ githubUserId: "12345", ownerSecurityVersion: 6 }]);

  const otherAccount = await app.inject({
    method: "POST", url: "/me/github-connection/confirm",
    headers: { "x-security-version": "6" }, payload: { githubUserId: "999" }
  });
  expect(otherAccount.statusCode).toBe(409);
  expect(otherAccount.json().error).toBe("github_account_changed");
  const extraField = await app.inject({
    method: "POST", url: "/me/github-connection/confirm",
    headers: { "x-security-version": "6" }, payload: { githubUserId: "12345", ownerSecurityVersion: 99 }
  });
  expect(extraField.statusCode).toBe(400);

  const notConnected = await app.inject({
    method: "POST", url: "/me/notion-connection/confirm",
    headers: { "x-security-version": "6" }, payload: { notionUserId: "n-1", notionWorkspaceId: null }
  });
  expect(notConnected.statusCode).toBe(404);
  expect(notConnected.json().error).toBe("notion_not_connected");
  expect(notionConnections.userConnection).toBeNull();

  // No attested identity (Notion returned no owner email): the route refuses.
  notionConnections.userConnection = {
    notionUserId: "n-1", notionWorkspaceId: "ws-1", notionWorkspaceName: "Mine", notionWorkspaceIcon: null,
    notionOwnerEmail: null, notionOwnerName: "Me", scopes: [], accessTokenExpiresAt: null, refreshTokenExpiresAt: null,
    connectedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastUsedAt: null, suspended: true
  };
  const notAttested = await app.inject({
    method: "POST", url: "/me/notion-connection/confirm",
    headers: { "x-security-version": "6" }, payload: { notionUserId: "n-1", notionWorkspaceId: "ws-1" }
  });
  expect(notAttested.statusCode).toBe(409);
  expect(notAttested.json().error).toBe("notion_not_attested");
  expect(notionConnections.userConnection?.suspended).toBe(true);
  await app.close();
});
