// `withTenantScope`'s tenant GUC does not survive the transaction that set it.
//
// This is the R46 case. `set_config('app.current_tenant_id', $1, true)` passes
// `true` for is_local, so the value is supposed to die with the transaction. If
// it ever leaked, a pooled connection would serve the NEXT borrower under the
// previous tenant's RLS context, and every query would still look correct. That
// is a cross-tenant read with no error anywhere.
//
// `db.test.ts` covers the same helper against a fake client, which pins the
// call sequence. It cannot prove what Postgres does with those calls. This
// file does, and it does it on the SAME physical connection: the success-path
// test compares `pg_backend_pid()` before believing a clean read, because a
// fresh connection would make it pass for free. The failure-path test cannot
// make that comparison — pg-pool may legitimately destroy and replace the
// client — so it pins the outcome instead, on a one-connection pool where the
// next borrow is the one that would inherit a leak.
//
// Deliberately NOT tested here: the release-with-error path for a failed
// ROLLBACK. Forcing it means terminating the backend, which makes the
// connection non-queryable — and pg-pool discards a non-queryable client
// whether or not `release()` was handed an error. The test would pass with the
// contract it claims to guard deleted. `db.test.ts:165` is the real test of
// that, and it already exists.

import { beforeAll, describe, expect, test } from "vitest";
import pg from "pg";

import { withTenantScope, withTransaction } from "../lib/db.js";

import { adminDatabaseUrl, appPool, runAppUserUrl } from "./support/database.js";
import { seedTenantGraph, type TenantFixture } from "./support/fixtures.js";

/**
 * Runs `fn` against a pool of exactly ONE connection, then closes it.
 *
 * Every claim in this file is about what a REUSED connection sees, so the
 * shared `appPool()` (max 5) is unusable: consecutive checkouts may land on
 * different backends and a leaked GUC would go unnoticed. max:1 removes that
 * escape hatch.
 */
async function withOneConnectionPool(fn: (pool: pg.Pool) => Promise<void>): Promise<void> {
  const pool = new pg.Pool({
    connectionString: runAppUserUrl(),
    max: 1,
    application_name: "cogniplane-integration-db-scope"
  });
  try {
    await fn(pool);
  } finally {
    await pool.end();
  }
}

describe.skipIf(!adminDatabaseUrl())("withTenantScope GUC lifetime", () => {
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;

  beforeAll(async () => {
    tenantA = await seedTenantGraph();
    tenantB = await seedTenantGraph();
  });

  test("the GUC is set inside the scope", async () => {
    // The positive control. Without it, "the GUC is empty afterwards" could
    // mean set_config never ran at all.
    const value = await withTenantScope(appPool(), tenantA.tenantId, async (client) => {
      const { rows } = await client.query<{ value: string | null }>(
        "SELECT current_setting('app.current_tenant_id', true) AS value"
      );
      return rows[0]?.value;
    });
    expect(value).toBe(tenantA.tenantId);
  });

  test("the GUC is gone after withTenantScope commits, on the same connection", async () => {
    // A max:1 pool is what makes this meaningful: every checkout is the SAME
    // backend, so an empty GUC afterwards cannot be explained by having been
    // handed a fresh connection. Asserted on pid too, belt and braces.
    //
    // Runs the real `withTenantScope`. An earlier version hand-rolled
    // BEGIN/set_config/COMMIT, which tested PostgreSQL's SET LOCAL semantics
    // rather than the helper.
    await withOneConnectionPool(async (pool) => {
      const pidInside = await withTenantScope(pool, tenantA.tenantId, async (client) => {
        const { rows } = await client.query<{ pid: number; value: string | null }>(
          "SELECT pg_backend_pid() AS pid, current_setting('app.current_tenant_id', true) AS value"
        );
        expect(rows[0]?.value).toBe(tenantA.tenantId);
        return rows[0]!.pid;
      });

      const { rows } = await pool.query<{ pid: number; value: string | null }>(
        "SELECT pg_backend_pid() AS pid, current_setting('app.current_tenant_id', true) AS value"
      );
      expect(rows[0]?.pid).toBe(pidInside);
      expect(rows[0]?.value ?? "").toBe("");
    });
  });

  test("a throwing withTenantScope leaves no GUC behind on the same connection", async () => {
    // The failure path of the same claim. `withTenantScope`'s catch must ROLLBACK
    // (and, if the rollback itself fails, hand the error to release so pg-pool
    // destroys the client) or the next borrower of this connection inherits
    // tenant A's RLS context.
    await withOneConnectionPool(async (pool) => {
      await expect(
        withTenantScope(pool, tenantA.tenantId, async () => {
          throw new Error("scope exploded");
        })
      ).rejects.toThrow("scope exploded");

      const { rows } = await pool.query<{ value: string | null }>(
        "SELECT current_setting('app.current_tenant_id', true) AS value"
      );
      // Deliberately not asserted against the pre-scope backend pid: either the
      // same connection came back clean or pg-pool destroyed and replaced it,
      // and both are correct. Only a leaked tenant value is a failure, and with
      // a one-connection pool this next borrow is the one that would inherit it.
      expect(rows[0]?.value ?? "").toBe("");
    });
  });

  test("withTenantScope rejects with the original error, not a rollback error", async () => {
    const boom = new Error("callback exploded");
    await expect(
      withTenantScope(appPool(), tenantA.tenantId, async () => {
        throw boom;
      })
    ).rejects.toBe(boom);
  });

  test("a second scope on the same connection sees the second tenant, never the first", async () => {
    // The end-to-end leak check, and the reason max:1 matters. Two scopes back
    // to back on one backend: if the first tenant's GUC survived, the second
    // scope's BEGIN would nest inside the still-open transaction and its
    // queries would run as tenant A.
    //
    // The read happens BEFORE the second scope's own set_config takes effect,
    // which is what an earlier version got wrong: reading inside the second
    // scope always shows tenant B, because B just set it.
    await withOneConnectionPool(async (pool) => {
      const firstPid = await withTenantScope(pool, tenantA.tenantId, async (client) => {
        const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        return rows[0]!.pid;
      });

      // Same backend, outside any scope: must be empty, not tenant A.
      const { rows: between } = await pool.query<{ pid: number; value: string | null }>(
        "SELECT pg_backend_pid() AS pid, current_setting('app.current_tenant_id', true) AS value"
      );
      expect(between[0]?.pid).toBe(firstPid);
      expect(between[0]?.value ?? "").toBe("");

      const seen = await withTenantScope(pool, tenantB.tenantId, async (client) => {
        const { rows } = await client.query<{ value: string | null }>(
          "SELECT current_setting('app.current_tenant_id', true) AS value"
        );
        return rows[0]?.value;
      });
      expect(seen).toBe(tenantB.tenantId);
    });
  });

  test("a scope that threw does not leave the connection scoped to that tenant", async () => {
    // Deliberately uses tenant B for the recovery read. An earlier version
    // reused tenant A, so a leaked A context would have satisfied the follow-up
    // query and the test would have passed with the rollback removed.
    await withOneConnectionPool(async (pool) => {
      await expect(
        withTenantScope(pool, tenantA.tenantId, async () => {
          throw new Error("first scope fails");
        })
      ).rejects.toThrow("first scope fails");

      // Tenant B must see ITS OWN row count, not tenant A's. Under a leaked A
      // context this returns 0 for B's own session, which fails.
      const count = await withTenantScope(pool, tenantB.tenantId, async (client) => {
        const { rows } = await client.query<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM sessions WHERE session_id = $1",
          [tenantB.sessionId]
        );
        return Number(rows[0]?.count);
      });
      expect(count).toBe(1);
    });
  });

  test("withTransaction does NOT set a tenant GUC", async () => {
    // Easy to assume it does, given the name pairing. It does not, and a store
    // that reached for withTransaction expecting tenant scoping would run with
    // no tenant context — which on the RLS pool means zero rows, silently.
    const value = await withTransaction(appPool(), async (client) => {
      const { rows } = await client.query<{ value: string | null }>(
        "SELECT current_setting('app.current_tenant_id', true) AS value"
      );
      return rows[0]?.value ?? "";
    });
    expect(value).toBe("");
  });
});
