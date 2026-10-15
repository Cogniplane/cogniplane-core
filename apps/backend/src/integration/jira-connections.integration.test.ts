// Jira connection lifecycle against real Postgres: RLS on the three Jira
// tables, the member removal trigger from migration 061, and the identity
// check that rejects a selection made stale by a disconnect or a removal.
// Every lifecycle write goes through the production JiraConnectionStore.

import pg from "pg";
import { describe, expect, test } from "vitest";

import { withTenantScope } from "../lib/db.js";
import { JiraConnectionService } from "../services/integrations/pipedream/jira-connection-service.js";
import {
  JiraConnectionStore,
  JiraLifecycleConflictError,
  type JiraConnectionUpsert
} from "../services/integrations/pipedream/jira-connection-store.js";
import {
  PipedreamRequestError,
  type PipedreamAccount,
  type PipedreamConnectClient
} from "../services/integrations/pipedream/pipedream-client.js";
import { createTestConfig } from "../test-helpers/test-config.js";
import { adminDatabaseUrl, appPool, runAppUserUrl, superuserPool } from "./support/database.js";
import { seedMembership, seedTenant, seedUser } from "./support/fixtures.js";

const SITE = "11111111-2222-4333-8444-555555555555";
const BINDING = { projectId: "proj_abc123", environment: "development" as const };
const derive = (generation: number) => `cp1_test_${generation}`;

function mapping(tenantId: string, userId: string, externalUserId: string, accountId = "apn_abc"): JiraConnectionUpsert {
  return {
    tenantId,
    userId,
    externalUserId,
    accountId,
    accountName: "me@example.test",
    cloudId: SITE,
    siteName: "Acme",
    siteUrl: "https://acme.atlassian.net"
  };
}

async function member() {
  const tenant = await seedTenant();
  const user = await seedUser();
  await seedMembership(tenant, user);
  return { tenant, user };
}

async function removeMembership(tenant: string, user: string) {
  // The production route deletes under the app role and tenant scope.
  await withTenantScope(appPool(), tenant, (client) =>
    client.query("DELETE FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2", [tenant, user]));
}

async function cleanupRows(tenant: string) {
  return (await superuserPool().query(
    "SELECT * FROM user_jira_cleanups WHERE tenant_id = $1 ORDER BY created_at", [tenant])).rows;
}

const jira = (id: string, externalId: string): PipedreamAccount =>
  ({ id, external_id: externalId, app: { name_slug: "jira" }, healthy: true });

/** The production service and store, with an in-memory Pipedream. */
function fakeService() {
  const pipedream = {
    accounts: [] as PipedreamAccount[],
    deleteFailure: null as PipedreamRequestError | null,
    async createConnectToken() {
      return { connectLinkUrl: "https://pipedream.com/_static/connect.html?token=ctok", expiresAt: "x" };
    },
    async listAccounts(input: { externalUserId: string }) {
      return this.accounts.filter((account) => account.external_id === input.externalUserId);
    },
    async getAccount(id: string) {
      return this.accounts.find((account) => account.id === id) ?? null;
    },
    async deleteAccount(id: string) {
      if (this.deleteFailure) throw this.deleteFailure;
      this.accounts = this.accounts.filter((account) => account.id !== id);
      return true;
    },
    async proxyGet() {
      return { status: 200, body: [{ id: SITE, name: "Acme", url: "https://acme.atlassian.net" }] };
    }
  };
  const store = new JiraConnectionStore(appPool());
  const service = new JiraConnectionService(
    createTestConfig({ PIPEDREAM_CLIENT_ID: "c", PIPEDREAM_CLIENT_SECRET: "s", PIPEDREAM_PROJECT_ID: "proj_abc123" }),
    store,
    { get: async () => null },
    undefined,
    undefined,
    { warn: () => undefined },
    pipedream as unknown as PipedreamConnectClient
  );
  return { store, pipedream, service };
}

describe.skipIf(!adminDatabaseUrl())("Jira connections", () => {
  test("isolate mappings, identities, and cleanups by tenant and user under the app role", async () => {
    const tenant = await seedTenant(), otherTenant = await seedTenant();
    const user = await seedUser(), other = await seedUser();
    await Promise.all([seedMembership(tenant, user), seedMembership(tenant, other), seedMembership(otherTenant, user)]);
    const store = new JiraConnectionStore(appPool());
    const identity = (await store.bindIdentity(tenant, user, BINDING, derive, true))!;
    const row = mapping(tenant, user, identity.externalUserId);

    expect(await store.upsert(row, identity)).toMatchObject({ accountId: "apn_abc", cloudId: SITE });
    expect(await store.get(tenant, other)).toBeNull();
    expect(await store.get(otherTenant, user)).toBeNull();
    expect(await store.getIdentity(otherTenant, user)).toBeNull();
    expect(await store.retire(otherTenant, user, "user_disconnect", BINDING)).toBeNull();
    expect(await store.get(tenant, user)).not.toBeNull();

    const pending = await store.retire(tenant, user, "user_disconnect", BINDING);
    expect(pending).toMatchObject({ externalUserId: identity.externalUserId, accountId: "apn_abc" });
    expect(await store.listCleanups(otherTenant)).toEqual([]);
    expect(await store.getCleanup(otherTenant, pending!.cleanupId)).toBeNull();
    expect(await store.completeCleanup(otherTenant, pending!.cleanupId)).toBe(false);
    expect(await store.recordCleanupFailure(otherTenant, pending!.cleanupId, "x")).toBeNull();

    await withTenantScope(appPool(), otherTenant, async (client) => {
      for (const table of ["user_jira_connections", "user_jira_identities", "user_jira_cleanups"]) {
        expect((await client.query(`SELECT * FROM ${table} WHERE tenant_id = $1`, [tenant])).rows).toEqual([]);
        expect((await client.query(`UPDATE ${table} SET tenant_id = tenant_id WHERE tenant_id = $1`, [tenant])).rowCount).toBe(0);
        expect((await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenant])).rowCount).toBe(0);
      }
    });
    // A tenant scope cannot write a row for another tenant.
    await expect(withTenantScope(appPool(), otherTenant, (client) => client.query(
      `INSERT INTO user_jira_cleanups (tenant_id, user_id, pipedream_external_user_id, reason)
       VALUES ($1, $2, 'cp1_x', 'user_disconnect')`,
      [tenant, other]
    ))).rejects.toThrow();
    await expect(withTenantScope(appPool(), otherTenant, (client) => client.query(
      `INSERT INTO user_jira_identities (tenant_id, user_id, pipedream_external_user_id) VALUES ($1, $2, 'cp1_x')`,
      [tenant, other]
    ))).rejects.toThrow();
    expect(await cleanupRows(tenant)).toHaveLength(1);
  });

  test("rejects malformed rows and a mapping without membership", async () => {
    const { tenant, user } = await member();
    const store = new JiraConnectionStore(appPool());
    const identity = (await store.bindIdentity(tenant, user, BINDING, derive, true))!;
    await expect(store.upsert({ ...mapping(tenant, user, identity.externalUserId), accountId: "../apn" }, identity)).rejects.toThrow();
    const stranger = await seedUser();
    await expect(superuserPool().query(
      `INSERT INTO user_jira_connections
         (tenant_id, user_id, pipedream_external_user_id, pipedream_account_id, jira_cloud_id, jira_site_name, jira_site_url)
       VALUES ($1, $2, 'cp1_x', 'apn_x', $3, 'x', 'https://x.atlassian.net')`,
      [tenant, stranger, SITE]
    )).rejects.toThrow(/user_jira_connections_membership_fkey/);
  });

  test("member removal retires the identity in the same transaction, and a re-added member starts clean", async () => {
    const { tenant, user } = await member();
    const store = new JiraConnectionStore(appPool());
    const identity = (await store.bindIdentity(tenant, user, BINDING, derive, true))!;
    await store.upsert(mapping(tenant, user, identity.externalUserId, "apn_selected"), identity);

    await removeMembership(tenant, user);

    expect(await store.get(tenant, user)).toBeNull();
    expect(await cleanupRows(tenant)).toEqual([expect.objectContaining({
      user_id: user,
      pipedream_external_user_id: "cp1_test_0",
      pipedream_account_id: "apn_selected",
      pipedream_project_id: "proj_abc123",
      pipedream_environment: "development",
      reason: "member_removed",
      attempts: 0
    })]);
    expect(await store.getIdentity(tenant, user)).toBeNull();
    // A former member cannot create a new identity or mapping.
    await expect(store.bindIdentity(tenant, user, BINDING, derive, true)).rejects.toBeInstanceOf(JiraLifecycleConflictError);

    await seedMembership(tenant, user);
    expect(await store.get(tenant, user)).toBeNull();
    expect(await store.bindIdentity(tenant, user, BINDING, derive, false)).toBeNull();
    expect(await store.bindIdentity(tenant, user, BINDING, derive, true)).toEqual({ generation: 1, externalUserId: "cp1_test_1" });
    expect(await cleanupRows(tenant)).toHaveLength(1);
  });

  test("member removal records authorizations that never had a selected site", async () => {
    const { tenant, user } = await member();
    const store = new JiraConnectionStore(appPool());
    await store.bindIdentity(tenant, user, BINDING, derive, true);
    await removeMembership(tenant, user);
    expect(await cleanupRows(tenant)).toEqual([
      expect.objectContaining({ pipedream_external_user_id: "cp1_test_0", pipedream_account_id: null })
    ]);
  });

  test("a selection made stale by a disconnect fails", async () => {
    const { tenant, user } = await member();
    const store = new JiraConnectionStore(appPool());
    const identity = (await store.bindIdentity(tenant, user, BINDING, derive, true))!;
    await store.retire(tenant, user, "user_disconnect", BINDING);
    await expect(store.upsert(mapping(tenant, user, identity.externalUserId), identity))
      .rejects.toMatchObject({ reason: "identity_changed" });
    expect(await store.get(tenant, user)).toBeNull();
  });

  test("a selection waits for an open member removal, then fails", async () => {
    const { tenant, user } = await member();
    const store = new JiraConnectionStore(appPool());
    const identity = (await store.bindIdentity(tenant, user, BINDING, derive, true))!;

    const blocker = await appPool().connect();
    const selectorPool = new pg.Pool({
      connectionString: runAppUserUrl(),
      max: 1,
      lock_timeout: 10_000,
      statement_timeout: 15_000,
      application_name: "cogniplane-integration-jira-selector"
    });
    let selection: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenant]);
      await blocker.query("DELETE FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2", [tenant, user]);
      const { rows: [{ pid: blockerPid }] } = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const probe = await selectorPool.connect();
      const { rows: [{ pid: selectorPid }] } = await probe.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      probe.release();

      selection = new JiraConnectionStore(selectorPool).upsert(mapping(tenant, user, identity.externalUserId), identity);
      selection.catch(() => undefined);
      await expect.poll(async () => {
        const { rows: [{ blocked }] } = await superuserPool().query<{ blocked: boolean }>(
          "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked", [blockerPid, selectorPid]);
        return blocked;
      }, { timeout: 5_000, interval: 10 }).toBe(true);

      await blocker.query("COMMIT");
      await expect(selection).rejects.toMatchObject({ reason: "not_member" });
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
      await selection?.catch(() => {});
      await selectorPool.end();
    }
    expect(await store.get(tenant, user)).toBeNull();
  });

  test("concurrent selection and disconnect never leave a mapping for a retired identity", async () => {
    for (let round = 0; round < 10; round += 1) {
      const { tenant, user } = await member();
      const store = new JiraConnectionStore(appPool());
      const identity = (await store.bindIdentity(tenant, user, BINDING, derive, true))!;
      await Promise.allSettled([
        store.upsert(mapping(tenant, user, identity.externalUserId), identity),
        store.retire(tenant, user, "user_disconnect", BINDING)
      ]);
      expect(await store.get(tenant, user)).toBeNull();
      expect(await store.getIdentity(tenant, user)).toBeNull();
      expect(await cleanupRows(tenant)).toHaveLength(1);
    }
  });

  test("a disconnect waits for a first authorization that found no identity, then retires its ID", async () => {
    const { tenant, user } = await member();
    const store = new JiraConnectionStore(appPool());
    const poolOptions = { connectionString: runAppUserUrl(), max: 1, lock_timeout: 10_000, statement_timeout: 15_000 };
    const authorizerPool = new pg.Pool({ ...poolOptions, application_name: "cogniplane-integration-jira-authorizer" });
    const disconnectPool = new pg.Pool({ ...poolOptions, application_name: "cogniplane-integration-jira-disconnect" });
    const pidOf = async (pool: pg.Pool) => {
      const client = await pool.connect();
      try {
        return (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      } finally {
        client.release();
      }
    };

    // Pause the authorization after its identity lookup returns no row, with
    // its transaction still open.
    let paused!: () => void, resume!: () => void;
    const atPause = new Promise<void>((resolve) => { paused = resolve; });
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    const pausingPool = {
      async connect() {
        const client = await authorizerPool.connect();
        const query = client.query.bind(client) as (...args: unknown[]) => Promise<pg.QueryResult>;
        return Object.assign(client, {
          async query(...args: unknown[]) {
            const result = await query(...args);
            if (String(args[0]).includes("FROM user_jira_identities") && result.rowCount === 0) {
              paused();
              await resumed;
            }
            return result;
          }
        });
      }
    } as unknown as pg.Pool;

    let authorization: Promise<unknown> | undefined, disconnect: Promise<unknown> | undefined;
    try {
      const authorizerPid = await pidOf(authorizerPool);
      const disconnectPid = await pidOf(disconnectPool);
      authorization = new JiraConnectionStore(pausingPool).bindIdentity(tenant, user, BINDING, derive, true);
      authorization.catch(() => undefined);
      await atPause;

      disconnect = new JiraConnectionStore(disconnectPool).retire(tenant, user, "user_disconnect", BINDING);
      disconnect.catch(() => undefined);
      await expect.poll(async () => {
        const { rows: [{ blocked }] } = await superuserPool().query<{ blocked: boolean }>(
          "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked", [authorizerPid, disconnectPid]);
        return blocked;
      }, { timeout: 5_000, interval: 10 }).toBe(true);

      resume();
      expect(await authorization).toEqual({ generation: 0, externalUserId: "cp1_test_0" });
      expect(await disconnect).toMatchObject({ externalUserId: "cp1_test_0", reason: "user_disconnect" });
    } finally {
      resume();
      await Promise.allSettled([authorization, disconnect]);
      await Promise.all([authorizerPool.end(), disconnectPool.end()]);
    }

    expect(await store.getIdentity(tenant, user)).toBeNull();
    const next = await store.bindIdentity(tenant, user, BINDING, derive, true);
    const cleanups = await store.listCleanups(tenant, user);
    expect(next).toEqual({ generation: 1, externalUserId: "cp1_test_1" });
    expect(cleanups.map((cleanup) => cleanup.externalUserId)).toEqual(["cp1_test_0"]);
  });

  test("a failed remote cleanup stays pending, then a retry deletes only the retired accounts", async () => {
    const { tenant, user } = await member();
    const { store, pipedream, service } = fakeService();
    pipedream.deleteFailure = new PipedreamRequestError("delete_account", 0, "timeout");

    await service.getAuthorizationUrl({ tenantId: tenant, userId: user });
    const oldId = (await store.getIdentity(tenant, user))!.externalUserId;
    pipedream.accounts = [jira("apn_old", oldId)];

    await removeMembership(tenant, user);
    await expect(service.deleteConnection(tenant, user)).rejects.toMatchObject({ code: "cleanup_incomplete" });
    expect(await cleanupRows(tenant)).toEqual([expect.objectContaining({
      attempts: 1, last_error: "Pipedream is unavailable. Try again later."
    })]);

    await seedMembership(tenant, user);
    await service.getAuthorizationUrl({ tenantId: tenant, userId: user });
    const newId = (await store.getIdentity(tenant, user))!.externalUserId;
    expect(newId).not.toBe(oldId);
    pipedream.accounts.push(jira("apn_new", newId));

    pipedream.deleteFailure = null;
    const [pending] = await service.listPendingCleanups(tenant);
    expect(await service.retryCleanup(tenant, pending.cleanupId)).toEqual({ status: "completed", remoteAccountsDeleted: 1 });
    expect(pipedream.accounts.map((account) => account.id)).toEqual(["apn_new"]);
    expect(await cleanupRows(tenant)).toEqual([]);
  });

  test("a removal callback that runs after the member came back keeps the new account", async () => {
    const { tenant, user } = await member();
    const { store, pipedream, service } = fakeService();
    await service.getAuthorizationUrl({ tenantId: tenant, userId: user });
    const oldId = (await store.getIdentity(tenant, user))!.externalUserId;
    pipedream.accounts = [jira("apn_old", oldId)];
    await service.selectConnection(tenant, user, { accountId: "apn_old", siteId: SITE });

    await removeMembership(tenant, user);
    await seedMembership(tenant, user);
    await service.getAuthorizationUrl({ tenantId: tenant, userId: user });
    const fresh = (await store.getIdentity(tenant, user))!;
    expect(fresh.externalUserId).not.toBe(oldId);
    pipedream.accounts.push(jira("apn_new", fresh.externalUserId));
    await service.selectConnection(tenant, user, { accountId: "apn_new", siteId: SITE });

    // The callback of the first removal runs only now.
    expect(await service.deleteConnection(tenant, user)).toBe(true);
    expect(pipedream.accounts.map((account) => account.id)).toEqual(["apn_new"]);
    expect(await store.get(tenant, user)).toMatchObject({ accountId: "apn_new", externalUserId: fresh.externalUserId });
    expect(await store.getIdentity(tenant, user)).toEqual(fresh);
    expect(await cleanupRows(tenant)).toEqual([]);
  });

  test("tenant deletion removes Jira rows without a cleanup from the trigger", async () => {
    const { tenant, user } = await member();
    const store = new JiraConnectionStore(appPool());
    const identity = (await store.bindIdentity(tenant, user, BINDING, derive, true))!;
    await store.upsert(mapping(tenant, user, identity.externalUserId), identity);

    await superuserPool().query("DELETE FROM tenants WHERE tenant_id = $1", [tenant]);

    for (const table of ["user_jira_connections", "user_jira_identities", "user_jira_cleanups"]) {
      expect((await superuserPool().query(`SELECT 1 FROM ${table} WHERE tenant_id = $1`, [tenant])).rowCount).toBe(0);
    }
  });
});
