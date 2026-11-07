// Real-Postgres test for MicrosoftConnectionStore.upsert, the only writer of
// user_microsoft_connections.
//
// apps/backend/src/integration/rls-write-paths.integration.test.ts covers every
// other tenant table through its production writer. That file ships in the
// public mirror, which has no private/ tree, so for this table it seeds the row
// on the superuser pool and tests the policy only. This file is the private
// companion: it runs the real store on the application role, so an upsert that
// loses its withTenantScope fails here.
//
// The core file already probes peer UPDATE, DELETE and WITH CHECK on this
// table. This file does not repeat them. It proves the writer puts exactly one
// row under the caller's tenant, and that RLS, not a WHERE clause, hides it
// from the peer.
//
// Lifecycle: this project has no integration globalSetup, so the file creates
// and drops its own throwaway database and roles with the core harness. It
// skips only when INTEGRATION_DATABASE_URL is absent. When the URL is set, a
// setup error fails the file. It never sweeps orphaned databases, because a
// sweep could drop a database that another run is about to use.
//
// Gating: the root `test:integration` script in package.json runs this file
// after the core integration project. A failure here fails
// `pnpm test:integration`. Keep the file path in step with that script.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  adminDatabaseUrl,
  appPool,
  closePools,
  createRunDatabase,
  dropRunDatabase,
  superuserPool
} from "../../../../apps/backend/src/integration/support/database.js";
import {
  seedMembership,
  seedTenant,
  seedUser
} from "../../../../apps/backend/src/integration/support/fixtures.js";

import { bootstrapLocalTenant } from "../../../../apps/backend/src/scripts/local-auth-commands-lib.js";
import { OwnerSecurityVersionChangedError } from "../../../../apps/backend/src/services/auth/security-change.js";
import { MicrosoftConnectionStore } from "./microsoft-connection-store.js";

const RUN_ENV = ["INTEGRATION_RUN_DATABASE", "INTEGRATION_RUN_ROLE"] as const;

// Same allowance as the core integration project: a cold migration plus the
// checkpointer DDL.
const LIFECYCLE_TIMEOUT_MS = 120_000;

describe.skipIf(!adminDatabaseUrl())("MicrosoftConnectionStore.upsert under RLS", () => {
  const priorEnv = new Map(RUN_ENV.map((name) => [name, process.env[name]]));
  let run: { database: string; role: string } | undefined;
  let tenantA = "";
  let tenantB = "";
  let userId = "";

  beforeAll(async () => {
    run = await createRunDatabase();
    if (!run) throw new Error("createRunDatabase returned nothing, but INTEGRATION_DATABASE_URL is set.");
    // The harness pools read these names. Set them before the first pool call.
    process.env.INTEGRATION_RUN_DATABASE = run.database;
    process.env.INTEGRATION_RUN_ROLE = run.role;

    tenantA = await seedTenant();
    tenantB = await seedTenant();
    userId = await seedUser();
    await seedMembership(tenantA, userId);
  }, LIFECYCLE_TIMEOUT_MS);

  // Vitest runs this hook also when beforeAll fails. createRunDatabase drops
  // what it made if its own migration fails, so `run` is set only for a
  // database that exists.
  afterAll(async () => {
    try {
      await closePools();
      if (run) await dropRunDatabase(run.database, run.role);
    } finally {
      for (const [name, value] of priorEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }, LIFECYCLE_TIMEOUT_MS);

  /**
   * Counts rows for one Microsoft identity as the application role in
   * `tenantId`'s scope. The query has no tenant_id filter, so only the policy
   * decides what the peer sees. The transaction always rolls back.
   */
  async function countInScope(tenantId: string, microsoftUserId: string): Promise<number> {
    const client = await appPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      const { rows } = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM user_microsoft_connections
          WHERE user_id = $1 AND microsoft_user_id = $2`,
        [userId, microsoftUserId]
      );
      return Number(rows[0]?.count);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  async function rowsAsSuperuser(microsoftUserId: string) {
    const { rows } = await superuserPool().query<{ tenant_id: string; access_token_encrypted: string }>(
      `SELECT tenant_id, access_token_encrypted FROM user_microsoft_connections
        WHERE user_id = $1 AND microsoft_user_id = $2`,
      [userId, microsoftUserId]
    );
    return rows;
  }

  function upsertInput(microsoftUserId: string, accessTokenEncrypted: string) {
    // Dummy ciphertext. Nothing here decrypts it or calls Microsoft.
    return {
      tenantId: tenantA,
      userId,
      microsoftUserId,
      microsoftEmail: "person@example.test" as string | null,
      microsoftDisplayName: "Test Person",
      tokenType: "bearer",
      grantedScopes: ["Files.Read", "offline_access"],
      accessTokenEncrypted,
      accessTokenExpiresAt: "2030-01-01T00:00:00.000Z",
      refreshTokenEncrypted: "dummy-encrypted-refresh-token",
      refreshTokenExpiresAt: null,
      tokenLastRefreshedAt: null,
      ownerSecurityVersion: null as number | null
    };
  }

  test("the application role is subject to RLS", async () => {
    const { rows } = await appPool().query<{ user: string; rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT current_user AS user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    );
    expect(rows).toEqual([{ user: run?.role, rolsuper: false, rolbypassrls: false }]);
  });

  test("upsert writes one row under the caller's tenant, and the peer tenant cannot see it", async () => {
    const microsoftUserId = `microsoft-user-${tenantA}`;
    const store = new MicrosoftConnectionStore(appPool());

    const record = await store.upsert(upsertInput(microsoftUserId, "dummy-encrypted-access-token"));

    expect(record).toMatchObject({
      tenantId: tenantA,
      userId,
      microsoftUserId,
      microsoftEmail: "person@example.test",
      grantedScopes: ["Files.Read", "offline_access"],
      accessTokenEncrypted: "dummy-encrypted-access-token",
      accessTokenExpiresAt: "2030-01-01T00:00:00.000Z",
      refreshTokenEncrypted: "dummy-encrypted-refresh-token"
    });
    // Superuser first, with no tenant filter: one row exists, and it is A's.
    // Without this, a zero for the peer could mean that nothing was written.
    expect(await rowsAsSuperuser(microsoftUserId)).toEqual([
      { tenant_id: tenantA, access_token_encrypted: "dummy-encrypted-access-token" }
    ]);
    expect(await countInScope(tenantA, microsoftUserId)).toBe(1);
    expect(await countInScope(tenantB, microsoftUserId)).toBe(0);
    // The store's own read filters on tenant_id in SQL, so it adds practical
    // evidence but cannot replace the raw counts above.
    expect(await store.get(tenantA, userId)).toMatchObject({ tenantId: tenantA, microsoftUserId });
  });

  test("a second upsert for the same user updates the row in place", async () => {
    const microsoftUserId = `microsoft-user-${tenantA}`;
    const store = new MicrosoftConnectionStore(appPool());

    // Write the first row here, so the next upsert goes through ON CONFLICT
    // also when this test runs alone.
    await store.upsert(upsertInput(microsoftUserId, "dummy-encrypted-access-token-1"));
    expect(await rowsAsSuperuser(microsoftUserId)).toEqual([
      { tenant_id: tenantA, access_token_encrypted: "dummy-encrypted-access-token-1" }
    ]);

    await store.upsert(upsertInput(microsoftUserId, "dummy-encrypted-access-token-2"));

    expect(await rowsAsSuperuser(microsoftUserId)).toEqual([
      { tenant_id: tenantA, access_token_encrypted: "dummy-encrypted-access-token-2" }
    ]);
    expect(await countInScope(tenantB, microsoftUserId)).toBe(0);
  });

  // The connection keeps the security version of the session that
  // started the authorization (migration 083). After a security change of the
  // owner's local account, the read for use does not return it; a token
  // refresh keeps the stored version; only a current session's confirm restores it.
  async function localOwner() {
    const boot = await bootstrapLocalTenant(superuserPool(), "https://app.test", {
      tenantName: "Microsoft", ownerEmail: `${randomUUID()}@example.test`, ownerName: "Owner"
    });
    const owner = { tenantId: boot.tenantId, userId: boot.userId };
    const versionNow = async () => (await superuserPool().query<{ security_version: number }>(
      "SELECT security_version FROM local_identities WHERE tenant_id = $1 AND user_id = $2", [owner.tenantId, owner.userId]
    )).rows[0]!.security_version;
    // Every security change increments the version and sets updated_at.
    const securityChange = async () => {
      await superuserPool().query(
        "UPDATE local_identities SET security_version = security_version + 1, updated_at = now() WHERE tenant_id = $1 AND user_id = $2",
        [owner.tenantId, owner.userId]);
      return versionNow();
    };
    const input = (microsoftUserId: string, ownerSecurityVersion: number | null) => ({
      ...upsertInput(microsoftUserId, "dummy-encrypted-access-token"), ...owner, ownerSecurityVersion
    });
    return { owner, versionNow, securityChange, input };
  }

  function refreshInput(owner: { tenantId: string; userId: string }, expectedMicrosoftUserId: string, expectedRefresh: string) {
    return {
      ...owner, expectedMicrosoftUserId, expectedRefreshTokenEncrypted: expectedRefresh, tokenType: "bearer",
      grantedScopes: ["Files.Read"], accessTokenEncrypted: "refreshed-access", accessTokenExpiresAt: "2031-01-01T00:00:00.000Z",
      refreshTokenEncrypted: "rotated-refresh"
    };
  }

  async function confirmedEvents(tenantId: string) {
    const { rows } = await superuserPool().query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM audit_events WHERE tenant_id = $1 AND event_type = 'user.microsoft.confirmed' ORDER BY id", [tenantId]);
    return rows.map((row) => row.payload);
  }

  test("a security change suspends the connection until a current session confirms it", async () => {
    const { owner, versionNow, securityChange, input } = await localOwner();
    const store = new MicrosoftConnectionStore(appPool());
    const saved = await versionNow();
    await store.upsert(input("ms-attached", saved));
    expect((await store.get(owner.tenantId, owner.userId))?.microsoftUserId).toBe("ms-attached");

    const current = await securityChange();
    expect(await store.get(owner.tenantId, owner.userId)).toBeNull();
    expect(await store.getForOwner(owner.tenantId, owner.userId)).toMatchObject({ microsoftUserId: "ms-attached", suspended: true });
    // A refresh that races the security change stores nothing on a suspended connection.
    expect(await store.updateRefreshedToken(refreshInput(owner, "ms-attached", "dummy-encrypted-refresh-token"))).toBeNull();
    expect((await store.getForOwner(owner.tenantId, owner.userId))?.accessTokenEncrypted).toBe("dummy-encrypted-access-token");
    expect(await store.get(owner.tenantId, owner.userId)).toBeNull();

    expect(await store.confirm(owner.tenantId, owner.userId, "ms-other", current)).toBeNull();
    expect(await store.confirm(owner.tenantId, owner.userId, "ms-attached", saved)).toMatchObject({ suspended: true });
    expect(await confirmedEvents(owner.tenantId)).toEqual([]);
    // The confirm writes its audit event in the same transaction.
    expect(await store.confirm(owner.tenantId, owner.userId, "ms-attached", current)).toMatchObject({ suspended: false });
    expect((await store.get(owner.tenantId, owner.userId))?.microsoftUserId).toBe("ms-attached");
    expect(await confirmedEvents(owner.tenantId)).toEqual([{ microsoftUserId: "ms-attached", ownerSecurityVersion: current }]);
    // A refresh after the confirm stores the tokens and keeps the confirmed version.
    expect(await store.updateRefreshedToken(refreshInput(owner, "ms-attached", "dummy-encrypted-refresh-token")))
      .toMatchObject({ accessTokenEncrypted: "refreshed-access" });
    expect(await store.get(owner.tenantId, owner.userId)).not.toBeNull();
  });

  // A confirm needs an identity that the provider attests. With
  // no email from Graph, a display name is all the page could show: no confirm.
  test("a suspended connection without an email cannot be confirmed", async () => {
    const { owner, versionNow, securityChange, input } = await localOwner();
    const store = new MicrosoftConnectionStore(appPool());
    await store.upsert({ ...input("ms-no-email", await versionNow()), microsoftEmail: null });
    const current = await securityChange();
    expect(await store.confirm(owner.tenantId, owner.userId, "ms-no-email", current)).toBeNull();
    expect(await store.getForOwner(owner.tenantId, owner.userId)).toMatchObject({ microsoftEmail: null, suspended: true });
    expect(await confirmedEvents(owner.tenantId)).toEqual([]);
  });

  test("a callback write is bound to the owner's current version", async () => {
    const { owner, versionNow, securityChange, input } = await localOwner();
    const store = new MicrosoftConnectionStore(appPool());
    const before = await versionNow();
    const current = await securityChange();
    await store.upsert(input("ms-mine", current));
    for (const startedAt of [before, null]) {
      await expect(store.upsert(input("ms-attacker", startedAt))).rejects.toBeInstanceOf(OwnerSecurityVersionChangedError);
    }
    expect((await store.get(owner.tenantId, owner.userId))?.microsoftUserId).toBe("ms-mine");
  });

  test("a refresh updates only the row it started from and never creates a row", async () => {
    const { owner, versionNow, input } = await localOwner();
    const store = new MicrosoftConnectionStore(appPool());
    const version = await versionNow();
    await store.upsert(input("ms-1", version));
    const rows = async () => (await superuserPool().query<{ microsoft_user_id: string; access_token_encrypted: string; owner_security_version: number | null }>(
      "SELECT microsoft_user_id, access_token_encrypted, owner_security_version FROM user_microsoft_connections WHERE tenant_id = $1",
      [owner.tenantId])).rows;

    // Another refresh token (a concurrent refresh rotated it): nothing changes.
    expect(await store.updateRefreshedToken(refreshInput(owner, "ms-1", "an-older-refresh-token"))).toBeNull();
    // Another account (a reconnect happened): nothing changes.
    expect(await store.updateRefreshedToken(refreshInput(owner, "ms-0", "dummy-encrypted-refresh-token"))).toBeNull();
    expect(await rows()).toEqual([{ microsoft_user_id: "ms-1", access_token_encrypted: "dummy-encrypted-access-token", owner_security_version: version }]);

    // The row the refresh started from: tokens change, the version does not.
    expect(await store.updateRefreshedToken(refreshInput(owner, "ms-1", "dummy-encrypted-refresh-token")))
      .toMatchObject({ accessTokenEncrypted: "refreshed-access", refreshTokenEncrypted: "rotated-refresh" });
    expect(await rows()).toEqual([{ microsoft_user_id: "ms-1", access_token_encrypted: "refreshed-access", owner_security_version: version }]);

    // After a disconnect, a slow refresh does not create the row again.
    await store.delete(owner.tenantId, owner.userId);
    expect(await store.updateRefreshedToken(refreshInput(owner, "ms-1", "rotated-refresh"))).toBeNull();
    expect(await rows()).toEqual([]);
  });
});
