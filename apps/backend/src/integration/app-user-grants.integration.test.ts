import { randomUUID } from "node:crypto";

import { describe, expect, test } from "vitest";

import { withTenantScope } from "../lib/db.js";
import { ensureAppUserRole } from "../scripts/migrate-lib.js";
import { PlatformEventStore } from "../services/platform-event-store.js";
import { APP_USER_PASSWORD, adminDatabaseUrl, appPool, runRoleName, superuserPool } from "./support/database.js";
import { seedTenantGraph } from "./support/fixtures.js";

const denied = { code: "42501" };

describe.skipIf(!adminDatabaseUrl())("application database privileges", () => {
  test("runtime user creation, event append/read and tenant updates remain allowed", async () => {
    const userId = `grants-${randomUUID()}`;
    await appPool().query("INSERT INTO users (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [userId]);
    expect((await appPool().query("SELECT user_id FROM users WHERE user_id = $1", [userId])).rows)
      .toEqual([{ user_id: userId }]);
    const store = new PlatformEventStore(appPool());
    const type = `grants.${randomUUID()}`;
    await store.create({ type, payload: { allowed: true } });
    expect(await store.listByType(type)).toMatchObject([{ eventType: type, payload: { allowed: true } }]);
    const tenant = await seedTenantGraph();
    await withTenantScope(appPool(), tenant.tenantId, async client => {
      expect((await client.query("UPDATE tenants SET tenant_name = 'Allowed' WHERE tenant_id = $1 RETURNING tenant_name", [tenant.tenantId])).rows)
        .toEqual([{ tenant_name: "Allowed" }]);
      await client.query("INSERT INTO session_storage_gc (tenant_id, session_id, storage_key) VALUES ($1, $2, $3)",
        [tenant.tenantId, tenant.sessionId, `grants/${randomUUID()}`]);
    });
  });

  test.each([
    "SELECT * FROM schema_migrations",
    "INSERT INTO schema_migrations (version) VALUES ('grants_test')",
    "UPDATE schema_migrations SET checksum = NULL",
    "DELETE FROM schema_migrations",
    "TRUNCATE schema_migrations",
    "SELECT * FROM deep_agents.checkpoint_migrations",
    "INSERT INTO deep_agents.checkpoint_migrations (v) VALUES (99999)",
    "UPDATE deep_agents.checkpoint_migrations SET v = v",
    "DELETE FROM deep_agents.checkpoint_migrations",
    "SELECT * FROM tenant_deletion_receipts",
    "SELECT * FROM tenant_deletion_cleanup",
    "UPDATE users SET display_name = 'Forbidden'",
    "DELETE FROM users",
    "UPDATE platform_events SET payload = '{}'::jsonb",
    "DELETE FROM platform_events",
    "TRUNCATE platform_events",
    "INSERT INTO tenants (tenant_id, tenant_name) VALUES ('grants_forbidden', 'Forbidden')",
    "DELETE FROM tenants",
    "SELECT * FROM session_runtime_gc",
    "SELECT * FROM session_storage_gc",
    "UPDATE session_storage_gc SET attempts = attempts + 1",
    "DELETE FROM skill_bundle_storage_gc",
    "SELECT setval('public.platform_events_id_seq', 1)",
    "CREATE TABLE public.grants_forbidden (id int)",
    "CREATE TABLE deep_agents.grants_forbidden (id int)"
  ])("denies %s", async sql => {
    await expect(appPool().query(sql)).rejects.toMatchObject(denied);
  });

  test("re-provisioning removes legacy grants and never grants future objects", async () => {
    const role = runRoleName();
    const client = await superuserPool().connect();
    try {
      await client.query("CREATE TABLE public.grants_future_table (id int)");
      await client.query("CREATE SEQUENCE deep_agents.grants_future_sequence");
      await client.query(`GRANT ALL ON ALL TABLES IN SCHEMA public, deep_agents TO ${role}`);
      await client.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public, deep_agents TO ${role}`);
      await client.query(`GRANT CREATE ON SCHEMA public, deep_agents TO ${role}`);
      await client.query(`GRANT UPDATE (display_name) ON public.users TO ${role}`);
      await client.query(`GRANT SELECT (checksum) ON public.schema_migrations TO ${role}`);
      // Simulate an existing deployment, including grants broader than those
      // made by the old runner. Repeating setup must give the same result.
      await ensureAppUserRole(client, APP_USER_PASSWORD, role);
      await ensureAppUserRole(client, APP_USER_PASSWORD, role);
      for (const table of ["schema_migrations", "deep_agents.checkpoint_migrations", "tenant_deletion_receipts", "tenant_deletion_cleanup", "grants_future_table"]) {
        for (const operation of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
          const result = await client.query("SELECT has_table_privilege($1, $2, $3) AS allowed", [role, table, operation]);
          expect(result.rows[0], `${table} ${operation}`).toEqual({ allowed: false });
        }
      }
      await expect(appPool().query("SELECT * FROM grants_future_table")).rejects.toMatchObject(denied);
      await expect(appPool().query("SELECT nextval('deep_agents.grants_future_sequence')")).rejects.toMatchObject(denied);
      await expect(appPool().query("SELECT setval('platform_events_id_seq', 1)")).rejects.toMatchObject(denied);
      await expect(appPool().query("DELETE FROM users")).rejects.toMatchObject(denied);
      await expect(appPool().query("SELECT checksum FROM schema_migrations")).rejects.toMatchObject(denied);
      await expect(appPool().query("UPDATE users SET display_name = 'Forbidden'")).rejects.toMatchObject(denied);
      await client.query("CREATE TABLE public.grants_after_setup (id int)");
      await expect(appPool().query("SELECT * FROM grants_after_setup")).rejects.toMatchObject(denied);
    } finally {
      await client.query("DROP TABLE IF EXISTS public.grants_future_table, public.grants_after_setup");
      await client.query("DROP SEQUENCE IF EXISTS deep_agents.grants_future_sequence");
      client.release();
    }
  });
});
