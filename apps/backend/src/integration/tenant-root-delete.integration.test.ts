// The application role cannot delete a tenant.
//
// Every tenant table cascades from `tenants` (migration 038), and foreign-key
// cascades ignore row security. One DELETE of the tenants row would remove all
// rows of the tenant, the append-only audit_events rows too. Only the operator
// command (tenant:delete, as the migration role) deletes a tenant.
//
// Two controls keep the application role out, and this file tests each one:
//
//   - privilege: ensureAppUserRole revokes DELETE and TRUNCATE on tenants after
//     its bulk grant, on each migration run;
//   - row security: the restrictive policy tenants_no_delete refuses DELETE to
//     every role under row security, whatever grants the role has.
//
// The file also checks that the controls keep what the application needs: the
// tenant reads and renames itself through the tenant routes, a peer tenant
// stays out, and the operator command still deletes the tenant.

import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { describe, expect, test, vi } from "vitest";

import { withTenantScope } from "../lib/db.js";
import { registerTenantRoutes } from "../routes/tenant.js";
import { ensureAppUserRole } from "../scripts/migrate-lib.js";
import { setupDeepAgentsCheckpointer } from "../services/deep-agents/deep-agents-checkpointer.js";
import { TenantDeletionService } from "../services/tenant-deletion-service.js";
import { TenantOrgSettingsStore } from "../services/tenant-org-settings-store.js";
import { devDataRoutes } from "../test-helpers/data-routes.js";
import { IGNORE_SECURITY_CHANGE } from "../test-helpers/security-change.js";

import {
  adminDatabaseUrl,
  APP_USER_PASSWORD,
  appPool,
  runRoleName,
  superuserPool
} from "./support/database.js";
import { seedTenantGraph, type TenantFixture } from "./support/fixtures.js";
import { withStagedDatabase } from "./support/staged-migrations.js";

const SECRET = "tenant-root-delete-integration-secret-32";

/** The privilege error. Row security gives the same SQLSTATE with another text. */
const NO_PRIVILEGE = { code: "42501", message: "permission denied for table tenants" };

type Outcome = { rows: number } | { code: string; message: string };

/** Runs one statement as the application role in the tenant's scope, and commits, as a request does. */
async function inScope(tenantId: string, sql: string, values: unknown[] = []): Promise<Outcome> {
  try {
    const result = await withTenantScope(appPool(), tenantId, (client) => client.query(sql, values));
    return { rows: result.rowCount ?? 0 };
  } catch (error) {
    const { code, message } = error as { code?: string; message: string };
    return { code: code ?? "none", message };
  }
}

/** Rows of the tenant in each table with a tenant_id column, read past row security. */
async function tenantRows(tenantId: string): Promise<Record<string, number>> {
  const tables = await superuserPool().query<{ table_name: string }>(`
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname
  `);
  const counts: Record<string, number> = {};
  for (const { table_name: table } of tables.rows) {
    const quoted = `"${table.replaceAll('"', '""')}"`;
    const { rows } = await superuserPool().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM public.${quoted} WHERE tenant_id = $1`,
      [tenantId]
    );
    counts[table] = Number(rows[0]!.count);
  }
  return counts;
}

/** A tenant with a full object graph and two audit events. */
async function tenantWithAudit(): Promise<TenantFixture> {
  const tenant = await seedTenantGraph();
  await superuserPool().query(
    `INSERT INTO audit_events (tenant_id, session_id, user_id, event_type)
     VALUES ($1, $2, $3, 'test.first'), ($1, $2, $3, 'test.second')`,
    [tenant.tenantId, tenant.sessionId, tenant.userId]
  );
  return tenant;
}

async function tablePrivileges(role: string): Promise<Record<string, boolean>> {
  const { rows } = await superuserPool().query<Record<string, boolean>>(
    `SELECT has_table_privilege($1, 'public.tenants', 'SELECT') AS select,
            has_table_privilege($1, 'public.tenants', 'UPDATE') AS update,
            has_table_privilege($1, 'public.tenants', 'DELETE') AS delete,
            has_table_privilege($1, 'public.tenants', 'TRUNCATE') AS truncate`,
    [role]
  );
  return rows[0]!;
}

describe.skipIf(!adminDatabaseUrl())("the application role cannot delete a tenant", () => {
  test("a tenant cannot delete or truncate its own row, and every row of the tenant stays", async () => {
    const tenant = await tenantWithAudit();
    const before = await tenantRows(tenant.tenantId);
    expect(before.tenants).toBe(1);
    expect(before.audit_events).toBe(2);
    expect(before.sessions).toBe(1);

    const attempts = [
      await inScope(tenant.tenantId, `DELETE FROM tenants WHERE tenant_id = $1`, [tenant.tenantId]),
      await inScope(tenant.tenantId, `DELETE FROM tenants`),
      await inScope(tenant.tenantId, `TRUNCATE tenants CASCADE`)
    ];

    // The rows first: a failure then shows what the attempts removed.
    expect(await tenantRows(tenant.tenantId)).toEqual(before);
    expect(attempts).toEqual([NO_PRIVILEGE, NO_PRIVILEGE, NO_PRIVILEGE]);
  });

  test("a bulk grant of DELETE does not let the tenant delete its row", async () => {
    // The grant ensureAppUserRole applies to every table, without the revoke
    // that follows it. Row security alone must stop the DELETE. Rolled back.
    const tenant = await tenantWithAudit();
    const role = runRoleName();
    const client = await superuserPool().connect();
    let rollbackError: Error | undefined;
    try {
      await client.query("BEGIN");
      // runRoleName() is generated by the harness, never input.
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
      await client.query(`SET LOCAL ROLE ${role}`);
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenant.tenantId]);
      expect(await client.query("SELECT has_table_privilege('public.tenants', 'DELETE') AS d"))
        .toMatchObject({ rows: [{ d: true }] });

      const deleted = await client.query(`DELETE FROM tenants WHERE tenant_id = $1`, [tenant.tenantId]);
      expect(deleted.rowCount).toBe(0);

      await client.query("RESET ROLE");
      const left = await client.query<{ tenants: number; audit: number }>(
        `SELECT (SELECT COUNT(*)::int FROM tenants WHERE tenant_id = $1) AS tenants,
                (SELECT COUNT(*)::int FROM audit_events WHERE tenant_id = $1) AS audit`,
        [tenant.tenantId]
      );
      expect(left.rows[0]).toEqual({ tenants: 1, audit: 2 });
    } finally {
      await client.query("ROLLBACK").catch((error: Error) => {
        rollbackError = error;
      });
      client.release(rollbackError);
    }
  });

  test("tenants has a restrictive DELETE policy for every role, and row security is forced", async () => {
    const policies = await superuserPool().query(
      `SELECT policyname, permissive, roles::text AS roles, cmd, qual
       FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tenants' AND permissive = 'RESTRICTIVE'`
    );
    expect(policies.rows).toEqual([
      { policyname: "tenants_no_delete", permissive: "RESTRICTIVE", roles: "{public}", cmd: "DELETE", qual: "false" }
    ]);

    const table = await superuserPool().query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.tenants'::regclass`
    );
    expect(table.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  test("the application role has SELECT and UPDATE on tenants, but no DELETE or TRUNCATE, also after re-provisioning", async () => {
    const role = runRoleName();
    const expected = { select: true, update: true, delete: false, truncate: false };
    expect(await tablePrivileges(role)).toEqual(expected);

    // The migration runner calls ensureAppUserRole on each run, after every
    // migration. Its bulk grant must not give DELETE back.
    const client = await superuserPool().connect();
    try {
      await ensureAppUserRole(client, APP_USER_PASSWORD, role);
      await ensureAppUserRole(client, APP_USER_PASSWORD, role);
    } finally {
      client.release();
    }
    expect(await tablePrivileges(role)).toEqual(expected);

    const tenant = await tenantWithAudit();
    const before = await tenantRows(tenant.tenantId);
    expect(await inScope(tenant.tenantId, `DELETE FROM tenants WHERE tenant_id = $1`, [tenant.tenantId]))
      .toEqual(NO_PRIVILEGE);
    expect(await tenantRows(tenant.tenantId)).toEqual(before);
  });

  test("a peer tenant cannot read, change or delete the tenant row", async () => {
    const owner = await tenantWithAudit();
    const peer = await seedTenantGraph();
    const before = await superuserPool().query(`SELECT * FROM tenants WHERE tenant_id = $1`, [owner.tenantId]);

    expect(await inScope(peer.tenantId, `SELECT 1 FROM tenants WHERE tenant_id = $1`, [owner.tenantId]))
      .toEqual({ rows: 0 });
    expect(
      await inScope(peer.tenantId, `UPDATE tenants SET tenant_name = 'Taken' WHERE tenant_id = $1`, [owner.tenantId])
    ).toEqual({ rows: 0 });
    // Refused by the privilege; without it, row security finds no row.
    expect(await inScope(peer.tenantId, `DELETE FROM tenants WHERE tenant_id = $1`, [owner.tenantId]))
      .toEqual(NO_PRIVILEGE);

    expect((await superuserPool().query(`SELECT * FROM tenants WHERE tenant_id = $1`, [owner.tenantId])).rows)
      .toEqual(before.rows);
    expect((await tenantRows(owner.tenantId)).audit_events).toBe(2);
  });

  test("the tenant reads and renames itself through the tenant routes", async () => {
    const tenant = await seedTenantGraph();
    const app = Fastify();
    app.addHook("preHandler", async (request) => {
      request.auth = {
        userId: tenant.userId, tenantId: tenant.tenantId, role: "owner", isAdmin: true,
        email: `${tenant.userId}@example.test`
      };
    });
    await registerTenantRoutes(app, {
      db: appPool(),
      tenantOrgSettings: new TenantOrgSettingsStore(appPool(), SECRET),
      afterSecurityChange: IGNORE_SECURITY_CHANGE,
      dataRoutes: devDataRoutes()
    });
    await app.ready();
    try {
      const read = await app.inject({ method: "GET", url: "/tenant" });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toMatchObject({ tenantId: tenant.tenantId, tenantName: `Tenant ${tenant.tenantId}` });

      const renamed = await app.inject({ method: "PUT", url: "/tenant", payload: { tenantName: "Renamed organization" } });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json()).toMatchObject({ tenant_id: tenant.tenantId, tenant_name: "Renamed organization" });
    } finally {
      await app.close();
    }

    const stored = await superuserPool().query(`SELECT tenant_name FROM tenants WHERE tenant_id = $1`, [tenant.tenantId]);
    expect(stored.rows).toEqual([{ tenant_name: "Renamed organization" }]);
    const audit = await superuserPool().query(
      `SELECT payload FROM audit_events WHERE tenant_id = $1 AND event_type = 'tenant.renamed'`,
      [tenant.tenantId]
    );
    expect(audit.rows).toEqual([
      { payload: { previousName: `Tenant ${tenant.tenantId}`, tenantName: "Renamed organization" } }
    ]);
  });

  test("the operator command still deletes the tenant and all of its rows", async () => {
    const tenant = await tenantWithAudit();
    const service = new TenantDeletionService({
      db: superuserPool(),
      artifactStorage: { delete: vi.fn(async () => undefined) },
      skillBundleStorage: { deleteBundle: vi.fn(async () => undefined) },
      purgeRuntimeThread: vi.fn(async () => undefined),
      flushRedis: vi.fn(async () => undefined)
    });

    const receipt = await service.execute({
      requestId: `NONPROD-ROOT-DELETE-${randomUUID()}`,
      tenantId: tenant.tenantId,
      redisDisposition: "Integration Redis double flushed.",
      thirdPartyDisposition: "None.",
      backupDisposition: "Throwaway integration database."
    });

    expect(receipt.status).toBe("completed");
    expect(receipt.rowCounts).toMatchObject({ tenants: 1, audit_events: 2 });
    const left = Object.entries(await tenantRows(tenant.tenantId)).filter(([, count]) => count > 0);
    expect(left).toEqual([]);
  });
});

describe.skipIf(!adminDatabaseUrl())("upgrade of a database whose application role can delete a tenant", () => {
  test("the next migration run takes the DELETE away, and the tenant's rows stay", async () => {
    await withStagedDatabase(async ({ db, migrate }) => {
      await migrate((file) => Number.parseInt(file, 10) < 88);
      const { rows } = await db.query<{ name: string }>("SELECT current_database() AS name");
      const database = rows[0]!.name;
      // withStagedDatabase drops this role with the database.
      const role = database.replace(/^cogniplane_it_/, "cogniplane_it_role_");
      const url = new URL(adminDatabaseUrl()!);
      url.pathname = `/${database}`;
      await setupDeepAgentsCheckpointer(url.toString());

      // The role as the earlier runner left it: its bulk grant included DELETE
      // on tenants.
      const setup = await db.connect();
      try {
        await ensureAppUserRole(setup, APP_USER_PASSWORD, role);
      } finally {
        setup.release();
      }
      await db.query(`GRANT DELETE ON public.tenants TO ${role}`);

      const tenantId = `tenant_${randomUUID()}`;
      await db.query(`INSERT INTO tenants (tenant_id, tenant_name, slug) VALUES ($1, 'Upgraded', $1)`, [tenantId]);
      await db.query(
        `INSERT INTO audit_events (tenant_id, event_type) VALUES ($1, 'test.before_upgrade')`,
        [tenantId]
      );

      url.username = role;
      url.password = APP_USER_PASSWORD;
      const app = new pg.Pool({ connectionString: url.toString(), max: 1 });
      const deleteOwnTenant = async (commit: boolean): Promise<Outcome> => {
        const client = await app.connect();
        try {
          await client.query("BEGIN");
          await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
          const result = await client.query(`DELETE FROM tenants WHERE tenant_id = $1`, [tenantId]);
          await client.query(commit ? "COMMIT" : "ROLLBACK");
          return { rows: result.rowCount ?? 0 };
        } catch (error) {
          await client.query("ROLLBACK");
          const { code, message } = error as { code?: string; message: string };
          return { code: code ?? "none", message };
        } finally {
          client.release();
        }
      };
      try {
        // Before the upgrade the defect is there. Rolled back.
        expect(await deleteOwnTenant(false)).toEqual({ rows: 1 });

        // The runner's order: the migrations, then the role.
        await migrate(() => true);
        const client = await db.connect();
        try {
          await ensureAppUserRole(client, APP_USER_PASSWORD, role);
        } finally {
          client.release();
        }

        expect(await deleteOwnTenant(true)).toEqual(NO_PRIVILEGE);
        const left = await db.query(
          `SELECT (SELECT COUNT(*)::int FROM tenants WHERE tenant_id = $1) AS tenants,
                  (SELECT COUNT(*)::int FROM audit_events WHERE tenant_id = $1) AS audit`,
          [tenantId]
        );
        expect(left.rows[0]).toEqual({ tenants: 1, audit: 1 });
      } finally {
        await app.end();
      }
    });
  });
});
