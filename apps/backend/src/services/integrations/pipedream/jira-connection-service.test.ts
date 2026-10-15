import { describe, expect, test, vi } from "vitest";

import { createTestConfig } from "../../../test-helpers/test-config.js";
import type { IntegrationStateRecord } from "../integration-state-store.js";
import { JiraConnectionService } from "./jira-connection-service.js";
import {
  JiraLifecycleConflictError,
  type JiraCleanupReason,
  type JiraCleanupRecord,
  type JiraConnectionRecord,
  type JiraConnectionUpsert,
  type PipedreamBinding
} from "./jira-connection-store.js";
import {
  PipedreamConnectClient,
  PipedreamRequestError,
  type PipedreamAccount,
  type ProxyResult
} from "./pipedream-client.js";

const SITE_A = "11111111-2222-4333-8444-555555555555";
const SITE_B = "99999999-2222-4333-8444-555555555555";
const PIPEDREAM_CONFIG = {
  API_ORIGIN: "https://app.example.test",
  PIPEDREAM_CLIENT_ID: "client-id",
  PIPEDREAM_CLIENT_SECRET: "client-secret",
  PIPEDREAM_PROJECT_ID: "proj_abc123"
};

// Mirrors the lifecycle rules of JiraConnectionStore and the membership
// trigger in migration 061. The real SQL runs in jira-connections.integration.test.ts.
class MemoryStore {
  rows = new Map<string, JiraConnectionRecord>();
  identities = new Map<string, { generation: number; externalUserId: string | null; binding: PipedreamBinding | null }>();
  cleanups = new Map<string, JiraCleanupRecord>();
  removed = new Set<string>();
  /** The LIMIT of the real listCleanups query. */
  cleanupBatch = 500;
  private nextCleanup = 0;

  async get(tenantId: string, userId: string) {
    return this.rows.get(`${tenantId}:${userId}`) ?? null;
  }
  async getIdentity(tenantId: string, userId: string) {
    const identity = this.identities.get(`${tenantId}:${userId}`);
    return identity?.externalUserId ? { generation: identity.generation, externalUserId: identity.externalUserId } : null;
  }
  async bindIdentity(tenantId: string, userId: string, binding: PipedreamBinding, derive: (generation: number) => string, create: boolean) {
    const key = `${tenantId}:${userId}`;
    if (this.removed.has(key)) throw new JiraLifecycleConflictError("not_member");
    let identity = this.identities.get(key);
    if (identity?.externalUserId && identity.binding
      && (identity.binding.projectId !== binding.projectId || identity.binding.environment !== binding.environment)) {
      this.retireNow(tenantId, userId, "project_changed", null);
      identity = this.identities.get(key);
    }
    if (!create && !identity?.externalUserId) return null;
    const generation = identity?.generation ?? 0;
    const externalUserId = identity?.externalUserId ?? derive(generation);
    this.identities.set(key, { generation, externalUserId, binding });
    return { generation, externalUserId };
  }
  async upsert(input: JiraConnectionUpsert, expected: { generation: number; externalUserId: string }) {
    const key = `${input.tenantId}:${input.userId}`;
    if (this.removed.has(key)) throw new JiraLifecycleConflictError("not_member");
    const identity = this.identities.get(key);
    if (!identity || identity.generation !== expected.generation || identity.externalUserId !== expected.externalUserId) {
      throw new JiraLifecycleConflictError("identity_changed");
    }
    const now = "2026-09-30T12:00:00.000Z";
    const row = { ...input, createdAt: now, updatedAt: now };
    this.rows.set(key, row);
    return row;
  }
  async retire(tenantId: string, userId: string, reason: JiraCleanupReason, binding: PipedreamBinding | null) {
    return this.retireNow(tenantId, userId, reason, binding);
  }
  /** What the membership delete trigger does. */
  removeMember(tenantId: string, userId: string) {
    this.retireNow(tenantId, userId, "member_removed", null);
    this.removed.add(`${tenantId}:${userId}`);
  }
  addMember(tenantId: string, userId: string) {
    this.removed.delete(`${tenantId}:${userId}`);
  }
  async listCleanups(tenantId: string, userId?: string) {
    return [...this.cleanups.values()].filter((cleanup) =>
      cleanup.tenantId === tenantId && (userId === undefined || cleanup.userId === userId)).slice(0, this.cleanupBatch);
  }
  async getCleanup(tenantId: string, cleanupId: string) {
    const cleanup = this.cleanups.get(cleanupId);
    return cleanup?.tenantId === tenantId ? cleanup : null;
  }
  async completeCleanup(tenantId: string, cleanupId: string) {
    return (await this.getCleanup(tenantId, cleanupId)) !== null && this.cleanups.delete(cleanupId);
  }
  async recordCleanupFailure(tenantId: string, cleanupId: string, error: string) {
    const cleanup = await this.getCleanup(tenantId, cleanupId);
    if (!cleanup) return null;
    const updated = { ...cleanup, attempts: cleanup.attempts + 1, lastError: error };
    this.cleanups.set(cleanupId, updated);
    return updated;
  }
  private retireNow(tenantId: string, userId: string, reason: JiraCleanupReason, binding: PipedreamBinding | null) {
    const key = `${tenantId}:${userId}`;
    const identity = this.identities.get(key);
    const mapping = this.rows.get(key);
    this.rows.delete(key);
    const externalUserId = identity?.externalUserId ?? mapping?.externalUserId;
    if (!externalUserId) return null;
    const cleanup: JiraCleanupRecord = {
      cleanupId: `00000000-0000-4000-8000-${String(this.nextCleanup++).padStart(12, "0")}`,
      tenantId,
      userId,
      externalUserId,
      accountId: mapping?.accountId ?? null,
      binding: identity?.binding ?? binding,
      reason,
      attempts: 0,
      lastError: null,
      createdAt: "x",
      updatedAt: "x"
    };
    this.cleanups.set(cleanup.cleanupId, cleanup);
    this.identities.set(key, { generation: (identity?.generation ?? 0) + 1, externalUserId: null, binding: null });
    return cleanup;
  }
}

class FakePipedream {
  accounts: PipedreamAccount[] = [];
  deleted: string[] = [];
  deleteFailure: PipedreamRequestError | null = null;
  listFailure: PipedreamRequestError | null = null;
  proxyCalls: Array<{ externalUserId: string; accountId: string; url: string }> = [];
  proxyResponse: (url: string) => ProxyResult | Promise<ProxyResult> = (url) =>
    url.endsWith("/accessible-resources")
      ? { status: 200, body: [{ id: SITE_A, name: "Acme", url: "https://acme.atlassian.net", scopes: ["read:jira-work"] }] }
      : { status: 200, body: { issues: [], isLast: true } };
  tokenRequests: Array<{ externalUserId: string }> = [];

  async createConnectToken(input: { externalUserId: string }) {
    this.tokenRequests.push(input);
    return { connectLinkUrl: "https://pipedream.com/_static/connect.html?token=ctok_x&connectLink=true", expiresAt: "x" };
  }
  async listAccounts(input: { externalUserId: string; app: string }) {
    if (this.listFailure) throw this.listFailure;
    return this.accounts.filter((account) => account.app?.name_slug === input.app && account.external_id === input.externalUserId);
  }
  async getAccount(id: string) {
    return this.accounts.find((account) => account.id === id) ?? null;
  }
  async deleteAccount(id: string) {
    if (this.deleteFailure) throw this.deleteFailure;
    this.deleted.push(id);
    const before = this.accounts.length;
    this.accounts = this.accounts.filter((account) => account.id !== id);
    return this.accounts.length < before;
  }
  async proxyGet(input: { externalUserId: string; accountId: string; url: string }) {
    this.proxyCalls.push(input);
    return this.proxyResponse(input.url);
  }
}

function enabledState(readsEnabled = true): IntegrationStateRecord {
  return {
    tenantId: "tenant-a",
    integrationId: "jira",
    readsEnabled,
    writesEnabled: false,
    config: {},
    createdAt: "x",
    updatedAt: "x",
    updatedBy: null
  };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(options: { readsEnabled?: boolean; client?: PipedreamConnectClient; config?: Record<string, unknown> } = {}) {
  const store = new MemoryStore();
  const pipedream = new FakePipedream();
  const audit = { create: vi.fn(async () => undefined) };
  const runtime = { invalidateRuntimesForIntegration: vi.fn(async () => []) };
  const states = { get: vi.fn(async () => enabledState(options.readsEnabled ?? true)) };
  const service = new JiraConnectionService(
    createTestConfig({ ...PIPEDREAM_CONFIG, ...options.config }),
    store,
    states,
    audit as never,
    runtime,
    { warn: () => undefined },
    options.client ?? (pipedream as unknown as PipedreamConnectClient)
  );
  /** Starts an authorization and returns the external ID that Pipedream will label accounts with. */
  const authorize = async (tenantId = "tenant-a", userId = "user-1") => {
    await service.getAuthorizationUrl({ tenantId, userId });
    return pipedream.tokenRequests.at(-1)!.externalUserId;
  };
  const account = (id: string, externalId: string, extra: Partial<PipedreamAccount> = {}): PipedreamAccount => ({
    id,
    name: `${id}@example.test`,
    external_id: externalId,
    healthy: true,
    dead: false,
    app: { name_slug: "jira" },
    created_at: "2026-09-30T11:00:00.000Z",
    ...extra
  });
  return { service, store, pipedream, audit, runtime, states, account, authorize };
}

describe("external user identity", () => {
  test("is stable per tenant, user, and generation, and does not contain raw IDs", () => {
    const { service } = setup();
    const id = service.externalUserIdFor("tenant-a", "user-1");
    expect(id).toBe(service.externalUserIdFor("tenant-a", "user-1", 0));
    expect(id).not.toBe(service.externalUserIdFor("tenant-b", "user-1"));
    expect(id).not.toBe(service.externalUserIdFor("tenant-a", "user-2"));
    expect(id).not.toBe(service.externalUserIdFor("tenant-a", "user-1", 1));
    expect(service.externalUserIdFor("tenant-a", "user-1", 1)).not.toBe(service.externalUserIdFor("tenant-a", "user-1", 2));
    expect(id).toMatch(/^cp1_[A-Za-z0-9_-]+$/);
    expect(id).not.toContain("tenant-a");
  });
});

describe("authorization", () => {
  test("creates a short-lived token for the derived identity and targets the Jira app", async () => {
    const { service, pipedream } = setup();
    const { url } = await service.getAuthorizationUrl({ tenantId: "tenant-a", userId: "user-1" });
    expect(new URL(url).searchParams.get("app")).toBe("jira");
    expect(pipedream.tokenRequests).toEqual([{
      externalUserId: service.externalUserIdFor("tenant-a", "user-1"),
      successRedirectUri: "https://app.example.test/settings/jira?jiraAuth=return",
      errorRedirectUri: "https://app.example.test/settings/jira?jiraAuth=error",
      expiresInSeconds: 600
    }]);
    expect(await service.getConnectionStatus("tenant-a", "user-1")).toMatchObject({
      authorizationStarted: true,
      cleanupPending: false,
      userConnection: null
    });
  });

  test("reports not configured without Pipedream settings", async () => {
    const store = new MemoryStore();
    const service = new JiraConnectionService(createTestConfig({}), store, { get: async () => enabledState() });
    expect(service.isConfigured()).toBe(false);
    await expect(service.getAuthorizationUrl({ tenantId: "t", userId: "u" }))
      .rejects.toMatchObject({ code: "not_configured" });
    expect(await service.hasConnection("t", "u")).toBe(false);
  });

  test("retires an identity from another Pipedream project and keeps its cleanup pending", async () => {
    const { store, pipedream, authorize } = setup();
    const first = await authorize();
    const moved = new JiraConnectionService(
      createTestConfig({ ...PIPEDREAM_CONFIG, PIPEDREAM_PROJECT_ID: "proj_other" }),
      store, { get: async () => enabledState() }, undefined, undefined, { warn: () => undefined },
      pipedream as unknown as PipedreamConnectClient
    );
    await moved.getAuthorizationUrl({ tenantId: "tenant-a", userId: "user-1" });
    expect(pipedream.tokenRequests.at(-1)!.externalUserId).not.toBe(first);
    const [cleanup] = await store.listCleanups("tenant-a", "user-1");
    expect(cleanup).toMatchObject({ externalUserId: first, reason: "project_changed", binding: { projectId: "proj_abc123" } });

    // The current configuration is another project, so the cleanup fails and stays.
    await expect(moved.disconnect("tenant-a", "user-1")).rejects.toMatchObject({ code: "cleanup_incomplete" });
    expect((await store.getCleanup("tenant-a", cleanup.cleanupId))?.lastError).toContain("another Pipedream project");
  });
});

describe("selecting an account", () => {
  test("binds an owned Jira account and an accessible site, then refreshes runtimes", async () => {
    const { service, store, pipedream, runtime, account, authorize } = setup();
    const externalId = await authorize();
    pipedream.accounts = [account("apn_mine", externalId)];

    const summary = await service.selectConnection("tenant-a", "user-1", { accountId: "apn_mine", siteId: SITE_A });

    expect(summary.site).toEqual({ siteId: SITE_A, name: "Acme", url: "https://acme.atlassian.net" });
    expect(await store.get("tenant-a", "user-1")).toMatchObject({ accountId: "apn_mine", cloudId: SITE_A, externalUserId: externalId });
    expect(pipedream.proxyCalls[0]).toMatchObject({
      externalUserId: externalId,
      accountId: "apn_mine",
      url: "https://api.atlassian.com/oauth/token/accessible-resources"
    });
    expect(runtime.invalidateRuntimesForIntegration).toHaveBeenCalledWith("tenant-a", "user-1", "jira");
  });

  test.each([
    ["another user in the same tenant", "tenant-a", "user-2", {}],
    ["the same user ID in another tenant", "tenant-b", "user-1", {}],
    ["a non-Jira app", "tenant-a", "user-1", { app: { name_slug: "slack" } }]
  ])("rejects an account that belongs to %s", async (_label, tenantId, userId, extra) => {
    const { service, store, pipedream, account, authorize } = setup();
    await authorize();
    pipedream.accounts = [account("apn_other", service.externalUserIdFor(tenantId, userId), extra)];
    await expect(service.selectConnection("tenant-a", "user-1", { accountId: "apn_other", siteId: SITE_A }))
      .rejects.toMatchObject({ code: "account_not_found" });
    await expect(service.listAccountSites("tenant-a", "user-1", "apn_other")).rejects.toMatchObject({ code: "account_not_found" });
    expect(store.rows.size).toBe(0);
    expect(pipedream.proxyCalls).toHaveLength(0);
  });

  test("rejects an unknown account with the same error as a foreign one", async () => {
    const { service, authorize } = setup();
    await authorize();
    await expect(service.selectConnection("tenant-a", "user-1", { accountId: "apn_missing", siteId: SITE_A }))
      .rejects.toMatchObject({ code: "account_not_found" });
  });

  test("rejects every account before an authorization starts", async () => {
    const { service, pipedream, account } = setup();
    pipedream.accounts = [account("apn_mine", service.externalUserIdFor("tenant-a", "user-1"))];
    expect(await service.listCandidates("tenant-a", "user-1")).toEqual([]);
    await expect(service.selectConnection("tenant-a", "user-1", { accountId: "apn_mine", siteId: SITE_A }))
      .rejects.toMatchObject({ code: "account_not_found" });
  });

  test("rejects an unhealthy account", async () => {
    const { service, pipedream, account, authorize } = setup();
    pipedream.accounts = [account("apn_mine", await authorize(), { healthy: false })];
    await expect(service.selectConnection("tenant-a", "user-1", { accountId: "apn_mine", siteId: SITE_A }))
      .rejects.toMatchObject({ code: "account_unhealthy" });
    await expect(service.listAccountSites("tenant-a", "user-1", "apn_mine")).rejects.toMatchObject({ code: "account_unhealthy" });
  });

  test("rejects a site that the account cannot access", async () => {
    const { service, store, pipedream, account, authorize } = setup();
    pipedream.accounts = [account("apn_mine", await authorize())];
    await expect(service.selectConnection("tenant-a", "user-1", { accountId: "apn_mine", siteId: SITE_B }))
      .rejects.toMatchObject({ code: "site_not_accessible" });
    expect(store.rows.size).toBe(0);
  });

  test("lists only owned Jira accounts as candidates, without site lookups", async () => {
    const { service, pipedream, account, authorize } = setup();
    const externalId = await authorize();
    pipedream.accounts = [
      account("apn_mine", externalId),
      account("apn_sick", externalId, { healthy: false }),
      account("apn_other", service.externalUserIdFor("tenant-a", "user-2"))
    ];
    const candidates = await service.listCandidates("tenant-a", "user-1");
    expect(candidates.map((candidate) => [candidate.accountId, candidate.healthy])).toEqual([["apn_mine", true], ["apn_sick", false]]);
    expect(pipedream.proxyCalls).toHaveLength(0);
  });

  test("loads sites for a healthy account after five unhealthy ones", async () => {
    const { service, pipedream, account, authorize } = setup();
    const externalId = await authorize();
    pipedream.accounts = [
      ...[1, 2, 3, 4, 5].map((n) => account(`apn_sick${n}`, externalId, { healthy: false })),
      account("apn_sixth", externalId)
    ];
    expect((await service.listCandidates("tenant-a", "user-1")).at(-1)).toMatchObject({ accountId: "apn_sixth", healthy: true });
    expect(pipedream.proxyCalls).toHaveLength(0);

    const sites = await service.listAccountSites("tenant-a", "user-1", "apn_sixth");
    expect(sites).toEqual([{ siteId: SITE_A, name: "Acme", url: "https://acme.atlassian.net" }]);
    expect(pipedream.proxyCalls).toEqual([expect.objectContaining({ accountId: "apn_sixth" })]);
    expect(await service.selectConnection("tenant-a", "user-1", { accountId: "apn_sixth", siteId: SITE_A }))
      .toMatchObject({ accountId: "apn_sixth" });
  });

  test("reports a failed site lookup as unavailable, not as a reconnect", async () => {
    const { service, pipedream, account, authorize } = setup();
    pipedream.accounts = [account("apn_mine", await authorize())];
    pipedream.proxyResponse = () => ({ status: 500, body: null });
    await expect(service.listAccountSites("tenant-a", "user-1", "apn_mine")).rejects.toMatchObject({ code: "upstream_unavailable" });
  });
});

describe("concurrent lifecycle changes", () => {
  test("a selection that started before a disconnect cannot restore the deleted account", async () => {
    const { service, store, pipedream, account, authorize } = setup();
    pipedream.accounts = [account("apn_A", await authorize())];
    const lookupStarted = deferred();
    const releaseLookup = deferred();
    const proxyResponse = pipedream.proxyResponse;
    pipedream.proxyResponse = async (url) => {
      lookupStarted.resolve();
      await releaseLookup.promise;
      return proxyResponse(url);
    };

    const selection = service.selectConnection("tenant-a", "user-1", { accountId: "apn_A", siteId: SITE_A });
    await lookupStarted.promise;
    expect(await service.disconnect("tenant-a", "user-1")).toBe(true);
    expect(pipedream.deleted).toEqual(["apn_A"]);
    releaseLookup.resolve();

    await expect(selection).rejects.toMatchObject({ code: "connection_changed" });
    expect(store.rows.size).toBe(0);
    expect((await service.getConnectionStatus("tenant-a", "user-1")).userConnection).toBeNull();
  });

  test("a disconnect still running does not delete a mapping or an account made after it started", async () => {
    const { service, store, pipedream, account, authorize } = setup();
    const oldId = await authorize();
    pipedream.accounts = [account("apn_old", oldId)];
    await service.selectConnection("tenant-a", "user-1", { accountId: "apn_old", siteId: SITE_A });

    const listStarted = deferred();
    const releaseList = deferred();
    const list = pipedream.listAccounts.bind(pipedream);
    const spy = vi.spyOn(pipedream, "listAccounts").mockImplementationOnce(async (input) => {
      listStarted.resolve();
      await releaseList.promise;
      return list(input);
    });
    const disconnect = service.disconnect("tenant-a", "user-1");
    await listStarted.promise;
    // The local mapping is already gone before any remote deletion.
    expect(store.rows.size).toBe(0);

    const newId = await authorize();
    expect(newId).not.toBe(oldId);
    pipedream.accounts.push(account("apn_new", newId));
    await service.selectConnection("tenant-a", "user-1", { accountId: "apn_new", siteId: SITE_A });

    releaseList.resolve();
    expect(await disconnect).toBe(true);
    spy.mockRestore();
    expect(pipedream.deleted).toEqual(["apn_old"]);
    expect(pipedream.accounts.map((entry) => entry.id)).toEqual(["apn_new"]);
    expect(await store.get("tenant-a", "user-1")).toMatchObject({ accountId: "apn_new", externalUserId: newId });
  });

  test("a selection fails after the member is removed", async () => {
    const { service, store, pipedream, account, authorize } = setup();
    pipedream.accounts = [account("apn_A", await authorize())];
    const proxyResponse = pipedream.proxyResponse;
    pipedream.proxyResponse = (url) => {
      store.removeMember("tenant-a", "user-1");
      return proxyResponse(url);
    };
    await expect(service.selectConnection("tenant-a", "user-1", { accountId: "apn_A", siteId: SITE_A }))
      .rejects.toMatchObject({ code: "connection_changed" });
    expect(store.rows.size).toBe(0);
  });
});

describe("reads", () => {
  async function connected(options: { readsEnabled?: boolean } = {}) {
    const context = setup(options);
    context.pipedream.accounts = [context.account("apn_mine", await context.authorize())];
    await context.service.selectConnection("tenant-a", "user-1", { accountId: "apn_mine", siteId: SITE_A });
    context.pipedream.proxyCalls = [];
    return context;
  }

  test("uses the stored identity, account, and site", async () => {
    const { service, pipedream } = await connected();
    const result = await service.read("tenant-a", "user-1", { kind: "issue", issueIdOrKey: "ABC-1", fields: [] });
    expect(result.ok).toBe(true);
    expect(pipedream.proxyCalls).toEqual([{
      externalUserId: service.externalUserIdFor("tenant-a", "user-1"),
      accountId: "apn_mine",
      url: `https://api.atlassian.com/ex/jira/${SITE_A}/rest/api/3/issue/ABC-1`
    }]);
  });

  test("refuses a read when the turn recorded another account, and names the connected one", async () => {
    const { service, pipedream } = await connected();
    expect(await service.connectedAccountId("tenant-a", "user-1")).toBe("apn_mine");
    expect(await service.connectedAccountId("tenant-a", "user-2")).toBeNull();

    const switched = await service.read("tenant-a", "user-1", { kind: "sites" }, "apn_previous");
    const unrecorded = await service.read("tenant-a", "user-1", { kind: "sites" }, null);
    expect(switched).toEqual({ ok: false, error: expect.stringContaining("Jira account changed during this turn") });
    expect(unrecorded).toEqual(switched);
    expect(pipedream.proxyCalls).toHaveLength(0);
    expect((await service.read("tenant-a", "user-1", { kind: "sites" }, "apn_mine")).ok).toBe(true);
  });

  test("fails closed when the tenant disables Jira reads", async () => {
    const { service, pipedream, states } = await connected();
    states.get.mockResolvedValue(enabledState(false));
    const result = await service.read("tenant-a", "user-1", { kind: "sites" });
    expect(result).toEqual({ ok: false, error: "Jira reads are disabled for this organization." });
    expect(pipedream.proxyCalls).toHaveLength(0);
  });

  test("does not use another member's connection", async () => {
    const { service, pipedream } = await connected();
    const result = await service.read("tenant-a", "user-2", { kind: "sites" });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("No Jira connection") });
    expect(await service.hasConnection("tenant-b", "user-1")).toBe(false);
    expect(pipedream.proxyCalls).toHaveLength(0);
  });

  test("returns safe errors without upstream bodies", async () => {
    const { service, pipedream } = await connected();
    pipedream.proxyResponse = () => ({ status: 401, body: { access_token: "secret-token", message: "bad" } });
    const denied = await service.read("tenant-a", "user-1", { kind: "issue", issueIdOrKey: "ABC-1", fields: [] });
    expect(denied).toMatchObject({ ok: false, status: 401 });
    expect(JSON.stringify(denied)).not.toContain("secret-token");

    pipedream.proxyResponse = () => ({ status: 400, body: { errorMessages: ["Issue SECRET-1 summary: payroll"], errors: {} } });
    const rejected = await service.read("tenant-a", "user-1", {
      kind: "search", jql: "project = ABC", fields: [], maxResults: 10, nextPageToken: null
    });
    expect(rejected).toEqual({ ok: false, status: 400, error: "Jira rejected the request. Check the JQL query and the field IDs." });

    pipedream.proxyResponse = () => {
      throw new PipedreamRequestError("proxy", 0, "timeout");
    };
    expect(await service.read("tenant-a", "user-1", { kind: "issue", issueIdOrKey: "ABC-1", fields: [] }))
      .toEqual({ ok: false, error: "Jira request timed out." });
  });

  test.each([
    ["moved to another external user", { external_id: "cp1_someone_else" }],
    ["moved to another app", { app: { name_slug: "slack" } }]
  ])("fails closed when the stored account was %s upstream", async (_label, change) => {
    const { service, pipedream } = await connected();
    Object.assign(pipedream.accounts[0], change);
    for (const request of [{ kind: "sites" as const }, { kind: "issue" as const, issueIdOrKey: "ABC-1", fields: [] }]) {
      expect(await service.read("tenant-a", "user-1", request))
        .toMatchObject({ ok: false, error: expect.stringContaining("no longer available") });
    }
    expect(pipedream.proxyCalls).toHaveLength(0);
  });

  test("fails closed when the stored account is gone or unhealthy", async () => {
    const { service, pipedream } = await connected();
    pipedream.accounts[0].dead = true;
    expect(await service.read("tenant-a", "user-1", { kind: "sites" }))
      .toMatchObject({ ok: false, error: expect.stringContaining("needs to be reconnected") });
    pipedream.accounts = [];
    expect(await service.read("tenant-a", "user-1", { kind: "sites" }))
      .toMatchObject({ ok: false, error: expect.stringContaining("no longer available") });
    expect(pipedream.proxyCalls).toHaveLength(0);
  });

  test("checks tenant enablement before the upstream account", async () => {
    const { service, pipedream, states } = await connected();
    const getAccount = vi.spyOn(pipedream, "getAccount");
    states.get.mockResolvedValue(enabledState(false));
    await service.read("tenant-a", "user-1", { kind: "sites" });
    expect(getAccount).not.toHaveBeenCalled();
  });

  test("keeps working with the stored identity after DATA_ENCRYPTION_SECRET rotation", async () => {
    const { service, store, pipedream, account } = setup();
    // The row and the account carry the identity derived from the old secret.
    pipedream.accounts = [account("apn_old", "cp1_old_secret")];
    store.identities.set("tenant-a:user-1", { generation: 0, externalUserId: "cp1_old_secret", binding: null });
    await store.upsert({
      tenantId: "tenant-a", userId: "user-1", externalUserId: "cp1_old_secret", accountId: "apn_old",
      accountName: null, cloudId: SITE_A, siteName: "Acme", siteUrl: "https://acme.atlassian.net"
    }, { generation: 0, externalUserId: "cp1_old_secret" });
    expect(await service.read("tenant-a", "user-1", { kind: "issue", issueIdOrKey: "ABC-1", fields: [] }))
      .toMatchObject({ ok: true });
    expect(pipedream.proxyCalls[0]).toMatchObject({ externalUserId: "cp1_old_secret", accountId: "apn_old" });
  });

  test("rejects an injected issue key before any upstream call", async () => {
    const { service, pipedream } = await connected();
    const result = await service.read("tenant-a", "user-1", { kind: "issue", issueIdOrKey: "../../myself", fields: [] });
    expect(result).toMatchObject({ ok: false });
    expect(pipedream.proxyCalls).toHaveLength(0);
  });
});

describe("disconnect", () => {
  test("deletes owned remote accounts after the row, and retires the identity", async () => {
    const { service, store, pipedream, account, runtime, authorize } = setup();
    const externalId = await authorize();
    pipedream.accounts = [
      account("apn_mine", externalId),
      account("apn_spare", externalId),
      account("apn_other", service.externalUserIdFor("tenant-a", "user-2"))
    ];
    await service.selectConnection("tenant-a", "user-1", { accountId: "apn_mine", siteId: SITE_A });

    expect(await service.disconnect("tenant-a", "user-1")).toBe(true);
    expect(pipedream.deleted.sort()).toEqual(["apn_mine", "apn_spare"]);
    expect(store.rows.size).toBe(0);
    expect(store.cleanups.size).toBe(0);
    expect(await service.getConnectionStatus("tenant-a", "user-1"))
      .toMatchObject({ authorizationStarted: false, cleanupPending: false });
    expect(runtime.invalidateRuntimesForIntegration).toHaveBeenLastCalledWith("tenant-a", "user-1", "jira");
    expect(await authorize()).not.toBe(externalId);
  });

  test("deletes accounts authorized before any site choice", async () => {
    const { service, pipedream, account, authorize } = setup();
    pipedream.accounts = [account("apn_unselected", await authorize())];
    expect(await service.disconnect("tenant-a", "user-1")).toBe(true);
    expect(pipedream.deleted).toEqual(["apn_unselected"]);
  });

  test("removes the row even when the remote deletion fails, and keeps the cleanup for a retry", async () => {
    const { service, store, pipedream, account, authorize } = setup();
    pipedream.accounts = [account("apn_mine", await authorize())];
    await service.selectConnection("tenant-a", "user-1", { accountId: "apn_mine", siteId: SITE_A });
    pipedream.deleteFailure = new PipedreamRequestError("delete_account", 500);

    await expect(service.disconnect("tenant-a", "user-1")).rejects.toMatchObject({ code: "cleanup_incomplete" });
    expect(store.rows.size).toBe(0);
    expect([...store.cleanups.values()]).toEqual([
      expect.objectContaining({ accountId: "apn_mine", attempts: 1, lastError: "Pipedream is unavailable. Try again later." })
    ]);
    expect(await service.getConnectionStatus("tenant-a", "user-1")).toMatchObject({ userConnection: null, cleanupPending: true });

    pipedream.deleteFailure = null;
    expect(await service.disconnect("tenant-a", "user-1")).toBe(true);
    expect(pipedream.accounts).toEqual([]);
    expect(store.cleanups.size).toBe(0);
  });

  test("keeps the cleanup pending when Pipedream is not configured", async () => {
    const store = new MemoryStore();
    store.identities.set("tenant-a:user-1", { generation: 0, externalUserId: "cp1_x", binding: null });
    const service = new JiraConnectionService(createTestConfig({}), store, { get: async () => enabledState() });
    await expect(service.disconnect("tenant-a", "user-1")).rejects.toMatchObject({ code: "cleanup_incomplete" });
    expect([...store.cleanups.values()]).toEqual([expect.objectContaining({ lastError: "Pipedream is not configured on this deployment." })]);
  });

  test("treats an account already deleted in Pipedream as gone", async () => {
    const { service, store, pipedream, account, authorize } = setup();
    pipedream.accounts = [account("apn_mine", await authorize())];
    await service.selectConnection("tenant-a", "user-1", { accountId: "apn_mine", siteId: SITE_A });
    pipedream.accounts = [];

    expect(await service.disconnect("tenant-a", "user-1")).toBe(true);
    expect(pipedream.deleted).toEqual([]);
    expect(store.rows.size).toBe(0);
  });

  test("never deletes a stored account that now belongs to someone else", async () => {
    const { service, store, pipedream, account, authorize } = setup();
    pipedream.accounts = [account("apn_mine", await authorize())];
    await service.selectConnection("tenant-a", "user-1", { accountId: "apn_mine", siteId: SITE_A });
    pipedream.accounts[0].external_id = service.externalUserIdFor("tenant-a", "user-2");

    expect(await service.disconnect("tenant-a", "user-1")).toBe(true);
    expect(pipedream.deleted).toEqual([]);
    expect(pipedream.accounts.map((entry) => entry.id)).toEqual(["apn_mine"]);
    expect(store.rows.size).toBe(0);
  });

  test("returns false when there is nothing to disconnect", async () => {
    const { service } = setup();
    expect(await service.disconnect("tenant-a", "user-1")).toBe(false);
  });

  test("reports cleanups left after one batch as incomplete, and a retry finishes them", async () => {
    const { service, store, pipedream, account, authorize } = setup();
    for (const id of ["apn_a", "apn_b", "apn_c"]) {
      pipedream.accounts.push(account(id, await authorize()));
      await store.retire("tenant-a", "user-1", "user_disconnect", null);
    }
    store.cleanupBatch = 2;

    await expect(service.disconnect("tenant-a", "user-1")).rejects.toMatchObject({
      code: "cleanup_incomplete",
      message: expect.stringContaining("More Jira cleanups are pending.")
    });
    expect(pipedream.deleted).toEqual(["apn_a", "apn_b"]);
    expect(store.cleanups.size).toBe(1);

    expect(await service.disconnect("tenant-a", "user-1")).toBe(true);
    expect(pipedream.deleted).toEqual(["apn_a", "apn_b", "apn_c"]);
    expect(store.cleanups.size).toBe(0);
  });
});

describe("member removal cleanup", () => {
  test("removes the mapping when Pipedream fails, and an administrator retry finishes without touching new accounts", async () => {
    const { service, store, pipedream, account, authorize } = setup();
    const oldId = await authorize();
    pipedream.accounts = [account("apn_old", oldId), account("apn_unselected", oldId)];
    await service.selectConnection("tenant-a", "user-1", { accountId: "apn_old", siteId: SITE_A });

    store.removeMember("tenant-a", "user-1");
    pipedream.listFailure = new PipedreamRequestError("list_accounts", 0, "timeout");
    await expect(service.deleteConnection("tenant-a", "user-1")).rejects.toMatchObject({ code: "cleanup_incomplete" });
    expect(store.rows.size).toBe(0);
    const [pending] = await service.listPendingCleanups("tenant-a");
    expect(pending).toMatchObject({ userId: "user-1", accountId: "apn_old", reason: "member_removed", attempts: 1 });

    // The member comes back: the old mapping does not return, and new
    // authorizations get a new external ID.
    store.addMember("tenant-a", "user-1");
    expect(await service.getConnectionStatus("tenant-a", "user-1")).toMatchObject({ userConnection: null, cleanupPending: true });
    const newId = await authorize();
    expect(newId).not.toBe(oldId);
    pipedream.accounts.push(account("apn_new", newId));
    await service.selectConnection("tenant-a", "user-1", { accountId: "apn_new", siteId: SITE_A });

    pipedream.listFailure = null;
    expect(await service.retryCleanup("tenant-a", pending.cleanupId)).toEqual({ status: "completed", remoteAccountsDeleted: 2 });
    expect(pipedream.deleted.sort()).toEqual(["apn_old", "apn_unselected"]);
    expect(pipedream.accounts.map((entry) => entry.id)).toEqual(["apn_new"]);
    expect(await store.get("tenant-a", "user-1")).toMatchObject({ accountId: "apn_new" });
    expect(await service.listPendingCleanups("tenant-a")).toEqual([]);
  });

  test("a delayed removal callback after the member came back keeps the new identity and mapping", async () => {
    const { service, store, pipedream, account, authorize } = setup();
    const oldId = await authorize();
    pipedream.accounts = [account("apn_old", oldId)];
    await service.selectConnection("tenant-a", "user-1", { accountId: "apn_old", siteId: SITE_A });

    // The trigger retires the identity; the member comes back and selects a
    // new account before the removal callback runs.
    store.removeMember("tenant-a", "user-1");
    store.addMember("tenant-a", "user-1");
    const newId = await authorize();
    pipedream.accounts.push(account("apn_new", newId));
    await service.selectConnection("tenant-a", "user-1", { accountId: "apn_new", siteId: SITE_A });
    const identity = await store.getIdentity("tenant-a", "user-1");

    expect(await service.deleteConnection("tenant-a", "user-1")).toBe(true);
    expect(pipedream.deleted).toEqual(["apn_old"]);
    expect(pipedream.accounts.map((entry) => entry.id)).toEqual(["apn_new"]);
    expect(await store.get("tenant-a", "user-1")).toMatchObject({ accountId: "apn_new", externalUserId: newId });
    expect(await store.getIdentity("tenant-a", "user-1")).toEqual(identity);
    expect(store.cleanups.size).toBe(0);

    // A second callback has nothing to do and still keeps the connection.
    expect(await service.deleteConnection("tenant-a", "user-1")).toBe(false);
    expect(await store.get("tenant-a", "user-1")).toMatchObject({ accountId: "apn_new" });
  });

  test("an administrator retry reports a failure and keeps the record", async () => {
    const { service, store, pipedream, account, authorize } = setup();
    pipedream.accounts = [account("apn_old", await authorize())];
    store.removeMember("tenant-a", "user-1");
    pipedream.deleteFailure = new PipedreamRequestError("delete_account", 503);
    const [pending] = await service.listPendingCleanups("tenant-a");

    expect(await service.retryCleanup("tenant-a", pending.cleanupId)).toMatchObject({
      status: "failed",
      cleanup: { cleanupId: pending.cleanupId, attempts: 1, lastError: "Pipedream is unavailable. Try again later." }
    });
    await expect(service.retryCleanup("tenant-b", pending.cleanupId)).rejects.toMatchObject({ code: "cleanup_not_found" });
  });
});

describe("cleanup with the REST client", () => {
  type FakeAccount = { id: string; external_id: string; app: { name_slug: string }; healthy: boolean };

  function pagedPipedream(accounts: FakeAccount[], options: { page?: (after: string | null, index: number) => object | null } = {}) {
    const requests: string[] = [];
    let listCalls = 0;
    const fetchImpl = async (input: string, init: RequestInit = {}) => {
      const url = new URL(input);
      requests.push(`${init.method ?? "GET"} ${url.pathname}${url.search}`);
      if (url.pathname.endsWith("/oauth/token")) return Response.json({ access_token: "t", expires_in: 3600 });
      const deleteMatch = /\/accounts\/(apn_[A-Za-z0-9]+)$/.exec(url.pathname);
      if (init.method === "DELETE" && deleteMatch) {
        const index = accounts.findIndex((entry) => entry.id === deleteMatch[1]);
        if (index < 0) return new Response(null, { status: 404 });
        accounts.splice(index, 1);
        return new Response(null, { status: 204 });
      }
      if (url.pathname.endsWith("/accounts")) {
        const after = url.searchParams.get("after");
        const custom = options.page?.(after, listCalls++);
        if (custom) return Response.json(custom);
        const owned = accounts.filter((entry) => entry.external_id === url.searchParams.get("external_user_id"));
        const limit = Number(url.searchParams.get("limit"));
        const start = after ? Number(after.slice("cur_".length)) : 0;
        const data = owned.slice(start, start + limit);
        const end = start + data.length;
        return Response.json({
          data,
          page_info: {
            count: data.length,
            total_count: owned.length,
            start_cursor: `cur_${start}`,
            end_cursor: end < owned.length ? `cur_${end}` : null
          }
        });
      }
      return new Response(null, { status: 404 });
    };
    const client = new PipedreamConnectClient(
      { clientId: "c", clientSecret: "s", projectId: "proj_abc123", environment: "development" },
      fetchImpl
    );
    return { client, requests, listRequests: () => requests.filter((entry) => entry.startsWith("GET ") && entry.includes("/accounts?")) };
  }

  async function connectedWith(client: PipedreamConnectClient, accounts: FakeAccount[], count: number) {
    const context = setup({ client });
    const externalId = context.service.externalUserIdFor("tenant-a", "user-1");
    context.store.identities.set("tenant-a:user-1", {
      generation: 0, externalUserId: externalId, binding: { projectId: "proj_abc123", environment: "development" }
    });
    for (let n = 0; n < count; n += 1) {
      accounts.push({ id: `apn_${String(n).padStart(3, "0")}`, external_id: externalId, app: { name_slug: "jira" }, healthy: true });
    }
    return context;
  }

  test("deletes more than one page of accounts before it reports success", async () => {
    const accounts: FakeAccount[] = [];
    const remote = pagedPipedream(accounts);
    const { service, store } = await connectedWith(remote.client, accounts, 45);
    // A foreign account is never deleted.
    accounts.push({ id: "apn_foreign", external_id: service.externalUserIdFor("tenant-a", "user-2"), app: { name_slug: "jira" }, healthy: true });

    expect(await service.disconnect("tenant-a", "user-1")).toBe(true);
    expect(accounts.map((entry) => entry.id)).toEqual(["apn_foreign"]);
    // Three pages of 20 before deletion, and one empty listing that proves completion.
    expect(remote.listRequests().map((entry) => new URL(`https://x${entry.slice(4)}`).searchParams.get("after")))
      .toEqual([null, "cur_20", "cur_40", null]);
    expect(store.cleanups.size).toBe(0);
  });

  test.each([
    ["a repeated cursor", (after: string | null) => ({
      data: [{ id: after ? "apn_b" : "apn_a", external_id: "x", app: { name_slug: "jira" } }],
      page_info: { count: 1, total_count: 3, start_cursor: null, end_cursor: "cur_same" }
    })],
    ["a missing cursor before the total", () => ({
      data: [{ id: "apn_a", external_id: "x", app: { name_slug: "jira" } }],
      page_info: { count: 1, total_count: 3, start_cursor: null, end_cursor: null }
    })],
    ["an empty page before the total", () => ({
      data: [],
      page_info: { count: 0, total_count: 3, start_cursor: null, end_cursor: "cur_next" }
    })]
  ])("fails explicitly on %s and deletes nothing", async (_label, page) => {
    const accounts: FakeAccount[] = [];
    const remote = pagedPipedream(accounts, { page });
    const { service, store } = await connectedWith(remote.client, accounts, 3);

    await expect(service.disconnect("tenant-a", "user-1")).rejects.toMatchObject({ code: "cleanup_incomplete" });
    expect(remote.requests.some((entry) => entry.startsWith("DELETE"))).toBe(false);
    expect([...store.cleanups.values()]).toEqual([
      expect.objectContaining({ lastError: "Pipedream did not return a complete account list." })
    ]);
    expect(accounts).toHaveLength(3);
  });

  test("stops after the page limit", async () => {
    const accounts: FakeAccount[] = [];
    const remote = pagedPipedream(accounts, {
      page: (_after, index) => ({
        data: [{ id: `apn_p${index}`, external_id: "x", app: { name_slug: "jira" } }],
        page_info: { count: 1, total_count: 1000, start_cursor: null, end_cursor: `cur_${index + 1}` }
      })
    });
    const { service } = await connectedWith(remote.client, accounts, 0);
    await expect(service.disconnect("tenant-a", "user-1")).rejects.toMatchObject({ code: "cleanup_incomplete" });
    expect(remote.listRequests()).toHaveLength(25);
  });

  test("fails when accounts keep appearing during deletion", async () => {
    const accounts: FakeAccount[] = [];
    const remote = pagedPipedream(accounts);
    const { service, store } = await connectedWith(remote.client, accounts, 1);
    const externalId = service.externalUserIdFor("tenant-a", "user-1");
    let added = 0;
    const originalSplice = accounts.splice.bind(accounts);
    accounts.splice = ((start: number, count: number) => {
      const removed = originalSplice(start, count);
      accounts.push({ id: `apn_late${added++}`, external_id: externalId, app: { name_slug: "jira" }, healthy: true });
      return removed;
    }) as typeof accounts.splice;

    await expect(service.disconnect("tenant-a", "user-1")).rejects.toMatchObject({ code: "cleanup_incomplete" });
    expect([...store.cleanups.values()]).toEqual([
      expect.objectContaining({ lastError: "Jira accounts remained in Pipedream after deletion." })
    ]);
  });
});
