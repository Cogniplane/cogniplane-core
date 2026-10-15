// Row-visibility cases that rls-write-paths.integration.test.ts does not cover.
//
// The catalog test proves RLS is switched on. rls-write-paths.integration.test.ts
// proves it works for every tenant table: row visibility, the peer's UPDATE and
// DELETE, and WITH CHECK, all through the production write path. This file keeps
// the cases that file does not probe:
//
//   - the audit trail is append-only, even for the owning tenant;
//   - the application pool without withTenantScope sees nothing;
//   - system-tenant defaults are readable by every tenant and writable by none.
//
// Fixtures are seeded on the superuser pool, so no store runs here.

import { beforeAll, describe, expect, test } from "vitest";

import { withTenantScope } from "../lib/db.js";

import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedTenantGraph, type TenantFixture } from "./support/fixtures.js";

/** Postgres raises this when an RLS policy rejects a write. */
const INSUFFICIENT_PRIVILEGE = "42501";

describe.skipIf(!adminDatabaseUrl())("RLS row isolation", () => {
  let tenant: TenantFixture;

  beforeAll(async () => {
    tenant = await seedTenantGraph();
  });

  test("audit_events cannot be updated or deleted, even by the owning tenant", async () => {
    // Two RESTRICTIVE policies make the audit trail append-only. Restrictive
    // policies AND with the permissive tenant policy, so being the owner does
    // not help. Nothing else covers this.
    // audit_events has no natural text key; the surrogate `id` is what the
    // table actually offers, so seed and read back by that.
    const { rows: inserted } = await superuserPool().query<{ id: string }>(
      `INSERT INTO audit_events (tenant_id, session_id, user_id, event_type)
       VALUES ($1, $2, $3, 'test.event')
       RETURNING id::text AS id`,
      [tenant.tenantId, tenant.sessionId, tenant.userId]
    );
    const eventId = inserted[0]!.id;

    const { updated, deleted } = await withTenantScope(
      appPool(),
      tenant.tenantId,
      async (client) => {
        const u = await client.query(
          `UPDATE audit_events SET event_type = 'tampered' WHERE id = $1::bigint`,
          [eventId]
        );
        const d = await client.query(`DELETE FROM audit_events WHERE id = $1::bigint`, [eventId]);
        return { updated: u.rowCount ?? 0, deleted: d.rowCount ?? 0 };
      }
    );

    expect(updated).toBe(0);
    expect(deleted).toBe(0);

    const { rows } = await superuserPool().query<{ event_type: string }>(
      `SELECT event_type FROM audit_events WHERE id = $1::bigint`,
      [eventId]
    );
    expect(rows[0]?.event_type).toBe("test.event");
  });

  test("a query on the app pool WITHOUT withTenantScope sees nothing", async () => {
    // The GUC is unset outside withTenantScope, so `tenant_id = current_setting(...)`
    // matches no row and the query returns empty rather than erroring. That
    // fail-closed shape is why a store method that skips withTenantScope on
    // this pool is a silent no-op instead of a visible fault.
    //
    // Asserted once here, generically. It is one fact about the pool, so
    // repeating it per store method would be the same fact many times. What it
    // does NOT catch: a store that skips withTenantScope (this test constructs
    // the query itself), or app.ts wiring a store to the wrong pool.
    const { rows } = await appPool().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM sessions WHERE session_id = $1`,
      [tenant.sessionId]
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });
});

// ── System-tenant rows: readable by all, writable by none. ─────────────────
//
// Three admin tables carry a read policy shaped
// `tenant_id = current_setting(...) OR tenant_id = 'system'`, plus
// tenant-only INSERT/UPDATE/DELETE policies. That is how platform defaults
// reach every tenant. It is materially different from the single-clause policy
// on most other tenant tables, and nothing tested it.
describe.skipIf(!adminDatabaseUrl())("system-tenant defaults", () => {
  const SYSTEM_TABLES = ["admin_skills", "admin_skill_revisions", "admin_mcp_servers"] as const;

  test.each(SYSTEM_TABLES)("%s: any tenant can read the system rows", async (table) => {
    const fixture = await seedTenantGraph();

    const visible = await withTenantScope(appPool(), fixture.tenantId, async (client) => {
      const { rows } = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ${table} WHERE tenant_id = 'system'`
      );
      return Number(rows[0]?.count);
    });

    // Seeded by 002_seed_system_data.sql. A zero here means either the seed did
    // not run or the OR-'system' clause was lost, and both are worth failing on.
    expect(visible).toBeGreaterThan(0);
  });

  test.each(SYSTEM_TABLES)("%s: a tenant cannot UPDATE or DELETE a system row", async (table) => {
    const fixture = await seedTenantGraph();

    const { updated, deleted } = await withTenantScope(
      appPool(),
      fixture.tenantId,
      async (client) => {
        // `created_by` is the one nullable text column all three share.
        // (`updated_at` is NOT on admin_skill_revisions.)
        const u = await client.query(
          `UPDATE ${table} SET created_by = 'tampered' WHERE tenant_id = 'system'`
        );
        const d = await client.query(`DELETE FROM ${table} WHERE tenant_id = 'system'`);
        return { updated: u.rowCount ?? 0, deleted: d.rowCount ?? 0 };
      }
    );

    // The write policies have no 'system' clause, so USING matches nothing and
    // both statements affect zero rows rather than erroring.
    expect(updated).toBe(0);
    expect(deleted).toBe(0);
  });

  /**
   * Fully valid INSERTs, one per table, differing ONLY in `tenant_id`.
   *
   * Every NOT NULL column is supplied deliberately. An INSERT missing columns
   * fails with 23502 (not-null violation) whether or not a policy would have
   * rejected it, so a test that accepted 23502 would pass with the INSERT
   * policy deleted. Verified: dropping `admin_skills_tenant_insert` left an
   * earlier version of this test green. Only 42501 proves the policy acted.
   */
  const SYSTEM_INSERTS: Record<
    (typeof SYSTEM_TABLES)[number],
    (tenantId: string, id: string) => { sql: string; values: unknown[] }
  > = {
    admin_skills: (tenantId, id) => ({
      sql: `INSERT INTO admin_skills (skill_id, tenant_id, skill_name, created_by)
            VALUES ($1, $2, 'smuggled', 'integration')`,
      values: [id, tenantId]
    }),
    // `skill_revision_id` is sequence-backed, so it is omitted. The parent
    // skill is seeded first by the caller: the FK here is
    // (tenant_id, skill_id) -> admin_skills, which is tenant-scoped. Session
    // references also use composite tenant/session keys after migration 036.
    admin_skill_revisions: (tenantId, id) => ({
      sql: `INSERT INTO admin_skill_revisions
              (tenant_id, skill_id, revision_number, source_type, bundle_hash, created_by)
            VALUES ($1, $2, 1, 'inline', 'hash', 'integration')`,
      values: [tenantId, id]
    }),
    admin_mcp_servers: (tenantId, id) => ({
      sql: `INSERT INTO admin_mcp_servers
              (server_id, tenant_id, server_name, mode, route_path, config_hash, created_by)
            VALUES ($1, $2, 'smuggled', 'managed', $3, 'hash', 'integration')`,
      values: [id, tenantId, `/mcp/${id}`]
    })
  };

  /**
   * `admin_skill_revisions` needs a parent skill in the SAME tenant, because
   * its FK is composite. Seeded on the superuser pool so the parent's own
   * policy never confuses the result under test.
   */
  async function seedParentSkill(tenantId: string, id: string): Promise<void> {
    await superuserPool().query(
      `INSERT INTO admin_skills (skill_id, tenant_id, skill_name, created_by)
       VALUES ($1, $2, 'parent', 'integration')`,
      [id, tenantId]
    );
  }

  test.each(SYSTEM_TABLES)(
    "%s: the INSERT is valid, so a rejection can only come from the policy",
    async (table) => {
      // The control for the two tests below. The SAME row, differing only in
      // tenant_id, must succeed for the caller's own tenant. If this fails, the
      // row shape is wrong and the rejections below prove nothing.
      const fixture = await seedTenantGraph();
      const id = `own_${Date.now()}_${table}`;
      if (table === "admin_skill_revisions") await seedParentSkill(fixture.tenantId, id);
      const { sql, values } = SYSTEM_INSERTS[table](fixture.tenantId, id);

      await withTenantScope(appPool(), fixture.tenantId, async (client) => {
        await client.query(sql, values);
      });

      const { rows } = await superuserPool().query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ${table} WHERE tenant_id = $1`,
        [fixture.tenantId]
      );
      expect(Number(rows[0]?.count)).toBeGreaterThan(0);
    }
  );

  test.each(SYSTEM_TABLES)(
    "%s: a tenant cannot INSERT a system row (SQLSTATE 42501)",
    async (table) => {
      // A tenant that could write tenant_id='system' would be editing every
      // other tenant's defaults.
      const fixture = await seedTenantGraph();
      const id = `sys_${Date.now()}_${table}`;
      // Parent in the SYSTEM tenant, so the composite FK is satisfied and the
      // only thing left to reject the write is the INSERT policy.
      if (table === "admin_skill_revisions") await seedParentSkill("system", id);
      const { sql, values } = SYSTEM_INSERTS[table]("system", id);

      const attempt = withTenantScope(appPool(), fixture.tenantId, async (client) => {
        await client.query(sql, values);
      });

      await expect(attempt).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    }
  );

  test.each(SYSTEM_TABLES)(
    "%s: a tenant cannot INSERT a peer tenant's row (SQLSTATE 42501)",
    async (table) => {
      // The 'system' clause is only on the READ policy, so writing to a peer
      // tenant must fail the same way writing to 'system' does. Testing both
      // rules out a policy that special-cased 'system' and let other tenants
      // through.
      const author = await seedTenantGraph();
      const victim = await seedTenantGraph();
      const id = `peer_${Date.now()}_${table}`;
      if (table === "admin_skill_revisions") await seedParentSkill(victim.tenantId, id);
      const { sql, values } = SYSTEM_INSERTS[table](victim.tenantId, id);

      const attempt = withTenantScope(appPool(), author.tenantId, async (client) => {
        await client.query(sql, values);
      });

      await expect(attempt).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    }
  );
});
