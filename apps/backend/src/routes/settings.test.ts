import { test, expect } from "vitest";

import Fastify from "fastify";

import { registerSettingsRoutes, type SettingsRouteStores } from "./settings.js";
import type { Pool } from "../lib/db.js";
import { FakeDatabase } from "../test-helpers/fake-database.js";
import { InMemoryAuditEventStore } from "../test-helpers/in-memory-audit-events.js";
import { createTestConfig } from "../test-helpers/test-config.js";
import type {
  ScheduledJobRecord,
  ScheduledJobRunRecord,
  UserSettingsSectionKey,
  UserSettingsSectionRecord
} from "../services/user-settings-store.js";

class InMemoryGithubConnectionService {
  userConnection: {
    githubUserId: string;
    githubLogin: string;
    githubName: string | null;
    githubEmail: string | null;
    githubAvatarUrl: string | null;
    scopes: string[];
    accessTokenExpiresAt: string | null;
    refreshTokenExpiresAt: string | null;
    connectedAt: string;
    updatedAt: string;
    lastUsedAt: string | null;
  } | null = null;
  authorizeRequested = false;

  async getConnectionStatus() {
    return {
      configured: true,
      userConnection: this.userConnection
    };
  }

  async getAuthorizationUrl() {
    this.authorizeRequested = true;
    return "https://github.com/login/oauth/authorize?client_id=test-client";
  }

  async disconnect() {
    if (!this.userConnection) {
      return false;
    }

    this.userConnection = null;
    return true;
  }
}

class InMemoryNotionConnectionService {
  userConnection: {
    notionUserId: string;
    notionWorkspaceId: string | null;
    notionWorkspaceName: string | null;
    connectedAt: string;
    updatedAt: string;
  } | null = null;
  authorizeRequested = false;
  configured = true;

  async getConnectionStatus() {
    return {
      configured: this.configured,
      userConnection: this.userConnection
    };
  }

  async getAuthorizationUrl() {
    this.authorizeRequested = true;
    return "https://api.notion.com/v1/oauth/authorize?client_id=test-client";
  }

  async disconnect() {
    if (!this.userConnection) {
      return false;
    }
    this.userConnection = null;
    return true;
  }
}

class InMemoryUserSettingsStore {
  private readonly sections = new Map<string, UserSettingsSectionRecord>();
  private readonly jobs = new Map<string, ScheduledJobRecord>();

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

  async countActiveScheduledJobs(_tenantId: string, userId: string): Promise<number> {
    return [...this.jobs.values()].filter((job) => job.userId === userId && job.enabled).length;
  }

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
  }): Promise<ScheduledJobRecord> {
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
      lastRunAt: null,
      nextRunAt: input.nextRunAt,
      createdAt: now,
      updatedAt: now
    };
    this.jobs.set(job.jobId, job);
    return job;
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
  }): Promise<ScheduledJobRecord | null> {
    const current = this.jobs.get(input.jobId);
    if (!current || current.userId !== input.userId) {
      return null;
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
      nextRunAt: input.nextRunAt,
      updatedAt: new Date().toISOString()
    };
    this.jobs.set(input.jobId, next);
    return next;
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
  integrationStates?: SettingsRouteStores["integrationStates"];
  integrationRegistry?: SettingsRouteStores["integrationRegistry"];
  config?: SettingsRouteStores["config"];
  limits?: SettingsRouteStores["limits"];
} = {}) {
  const app = Fastify();
  const settings = new InMemoryUserSettingsStore();
  const auditEvents = new InMemoryAuditEventStore();
  const githubConnections = new InMemoryGithubConnectionService();
  const notionConnections = new InMemoryNotionConnectionService();

  app.decorate("config", createTestConfig({ LOCAL_DEV_USER_ID: "settings-user" }));
  app.decorate("db", new FakeDatabase() as unknown as Pool);
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: request.headers["x-user-id"]?.toString() || "settings-user",
      tenantId: request.headers["x-tenant-id"]?.toString() || "settings-tenant",
      isAdmin: false,
      role: "member" as const
    };
  });

  await registerSettingsRoutes(app, {
    settings: settings as SettingsRouteStores["settings"],
    auditEvents,
    githubConnections: githubConnections as SettingsRouteStores["githubConnections"],
    notionConnections: notionConnections as SettingsRouteStores["notionConnections"],
    config: overrides.config ?? createTestConfig({}),
    integrationStates: overrides.integrationStates ?? {
      async get() {
        return null;
      }
    },
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
    }
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
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    connectedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastUsedAt: null
  };

  const statusResponse = await app.inject({
    method: "GET",
    url: "/me/github-connection"
  });
  expect(statusResponse.statusCode).toBe(200);
  expect(statusResponse.json().userConnection.githubLogin).toBe("octocat");

  const authorizeResponse = await app.inject({
    method: "POST",
    url: "/me/github-connection/authorize"
  });
  expect(authorizeResponse.statusCode).toBe(200);
  expect(authorizeResponse.json().url as string).toMatch(/client_id=test-client/);
  expect(githubConnections.authorizeRequested).toBe(true);

  const disconnectResponse = await app.inject({
    method: "DELETE",
    url: "/me/github-connection"
  });
  expect(disconnectResponse.statusCode).toBe(204);
  expect(githubConnections.userConnection).toBe(null);

  await app.close();
});

test("notion connection routes expose status, authorization URL, and disconnect flow", async () => {
  const { app, notionConnections } = await createApp();

  notionConnections.userConnection = {
    notionUserId: "notion-user-1",
    notionWorkspaceId: "ws-xyz",
    notionWorkspaceName: "Test Workspace",
    notionWorkspaceIcon: null,
    notionOwnerEmail: null,
    notionOwnerName: null,
    scopes: [],
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    connectedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastUsedAt: null
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
    url: "/me/notion-connection/authorize"
  });
  expect(authorizeResponse.statusCode).toBe(200);
  expect(authorizeResponse.json().url as string).toMatch(/api\.notion\.com\/v1\/oauth\/authorize/);
  expect(notionConnections.authorizeRequested).toBe(true);

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
