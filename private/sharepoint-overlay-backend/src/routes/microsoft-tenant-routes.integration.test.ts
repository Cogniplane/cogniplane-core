// Real-Postgres test for the Microsoft app save (PUT /tenant/settings/microsoft):
// the real route, MicrosoftConnectionService, IntegrationStateStore,
// AuditEventStore and owner-notice outbox, on the application role.
//
// A save must write only the fields in its request, onto the row as it is when
// the save writes. A concurrent change of the toggles or of another field
// stays. The row records the admin who saved. The audit event and the owner
// notice name the fields, never a value, and commit or roll back with the
// change.
//
// Lifecycle and gating: the same as microsoft-connection-store.integration.test.ts.
// The root `test:integration` script in package.json runs this file. Keep the
// file path in step with that script.

import { Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  adminDatabaseUrl,
  appPool,
  closePools,
  createRunDatabase,
  dropRunDatabase,
  superuserPool
} from "../../../../apps/backend/src/integration/support/database.js";
import { decrypt, encrypt } from "../../../../apps/backend/src/lib/crypto-utils.js";
import { AuditEventStore } from "../../../../apps/backend/src/services/audit-event-store.js";
import { DataRouteControl } from "../../../../apps/backend/src/services/data-route-control.js";
import {
  IntegrationStateStore,
  type IntegrationStateRecord
} from "../../../../apps/backend/src/services/integrations/integration-state-store.js";
import { MailOutbox, type OwnerNoticeQueue } from "../../../../apps/backend/src/services/mail/mail-outbox.js";
import { createTestConfig } from "../../../../apps/backend/src/test-helpers/test-config.js";
import { MicrosoftConnectionService } from "../services/microsoft-connection-service.js";
import { MicrosoftConnectionStore } from "../services/microsoft-connection-store.js";
import { registerMicrosoftTenantRoutes } from "./microsoft-tenant-routes.js";

const RUN_ENV = ["INTEGRATION_RUN_DATABASE", "INTEGRATION_RUN_ROLE"] as const;
const LIFECYCLE_TIMEOUT_MS = 120_000;
const SECRET = "microsoft-tenant-routes-integration-secret-32";
const OLD_DIRECTORY = "11111111-2222-3333-4444-555555555555";
const NEW_DIRECTORY = "66666666-7777-8888-9999-000000000000";

type Tenant = { tenantId: string; ownerId: string; adminId: string };

async function seedTenant(): Promise<Tenant> {
  const tenantId = `tenant-${randomUUID()}`;
  const ownerId = `owner-${randomUUID()}`;
  const adminId = `admin-${randomUUID()}`;
  const db = superuserPool();
  await db.query(`INSERT INTO tenants (tenant_id, tenant_name, slug) VALUES ($1, 'Acme', $1)`, [tenantId]);
  for (const [userId, role] of [[ownerId, "owner"], [adminId, "admin"]] as const) {
    await db.query(`INSERT INTO users (user_id, email, display_name, auth_source) VALUES ($1, $2, $3, 'workos')`,
      [userId, `${userId}@example.test`, role]);
    await db.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)`, [tenantId, userId, role]);
  }
  return { tenantId, ownerId, adminId };
}

/** The app as the owner configured it: reads and writes on. */
async function seedConfiguredApp(t: Tenant): Promise<IntegrationStateRecord> {
  return new IntegrationStateStore(appPool()).applyChanges(t.tenantId, "microsoft", {
    readsEnabled: true,
    writesEnabled: true,
    configChanges: { clientId: "client-old", clientSecret: encrypt("secret-old", SECRET), entraTenantId: OLD_DIRECTORY },
    updatedBy: t.ownerId
  });
}

async function buildApp(t: Tenant, ownerNotices: OwnerNoticeQueue = new MailOutbox({ secret: SECRET })) {
  const config = createTestConfig({ DATA_ENCRYPTION_SECRET: SECRET });
  const logLines: string[] = [];
  const app = Fastify({
    logger: { level: "trace", stream: new Writable({ write(chunk, _encoding, done) { logLines.push(String(chunk)); done(); } }) }
  });
  // The admin's WorkOS session: no step-up, and the owners get the notice.
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: t.adminId, tenantId: t.tenantId, role: "admin", isAdmin: true,
      session: { authSource: "workos", familyId: "family-1" }
    };
  });
  const integrationStates = new IntegrationStateStore(appPool());
  const service = new MicrosoftConnectionService(
    config, new MicrosoftConnectionStore(appPool()), undefined, undefined, integrationStates, "https://api.example.test/cb"
  );
  registerMicrosoftTenantRoutes(app, {
    microsoftConnections: service,
    auditEvents: new AuditEventStore(appPool()),
    runtimeInvalidator: { invalidateTenantRuntimes: async () => [] },
    dataRoutes: new DataRouteControl({ authMode: "jwt", ownerNotices })
  });
  await app.ready();
  return { app, logLines, integrationStates };
}

async function auditEventsOf(tenantId: string) {
  const result = await superuserPool().query<{ user_id: string; event_type: string; payload: unknown }>(
    `SELECT user_id, event_type, payload FROM audit_events WHERE tenant_id = $1 ORDER BY id`,
    [tenantId]
  );
  return result.rows;
}

async function noticesOf(tenantId: string): Promise<string[]> {
  const result = await superuserPool().query<{ message_encrypted: string }>(
    `SELECT message_encrypted FROM email_outbox
     WHERE tenant_id = $1 AND kind = 'tenant_setting_changed' AND message_encrypted IS NOT NULL`,
    [tenantId]
  );
  return result.rows.map((row) => decrypt(row.message_encrypted, SECRET));
}

/** Resolves when a backend of the run database waits for a lock. */
async function untilSomeoneWaitsForALock(): Promise<void> {
  // Below the test timeout, so that a save that never waits fails with this message.
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const result = await superuserPool().query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`
    );
    if ((result.rows[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("The save never waited for the row lock.");
}

/**
 * Another admin's change holds the row, as IntegrationStateStore.applyChanges
 * does while it writes the change's audit event. The save starts while that
 * change is not committed, and goes on after the commit.
 */
async function saveDuringConcurrentChange(
  app: FastifyInstance,
  t: Tenant,
  concurrentChangeSql: string,
  payload: Record<string, string>
) {
  const other = await superuserPool().connect();
  try {
    await other.query("BEGIN");
    await other.query(`SELECT 1 FROM tenant_integrations WHERE tenant_id = $1 AND integration_id = 'microsoft' FOR UPDATE`, [t.tenantId]);
    await other.query(concurrentChangeSql, [t.tenantId, t.ownerId]);
    const save = app.inject({ method: "PUT", url: "/tenant/settings/microsoft", payload });
    await untilSomeoneWaitsForALock();
    await other.query("COMMIT");
    return await save;
  } finally {
    await other.query("ROLLBACK");
    other.release();
  }
}

describe.skipIf(!adminDatabaseUrl())("PUT /tenant/settings/microsoft on Postgres", () => {
  const priorEnv = new Map(RUN_ENV.map((name) => [name, process.env[name]]));
  let run: { database: string; role: string } | undefined;
  const apps: FastifyInstance[] = [];

  beforeAll(async () => {
    run = await createRunDatabase();
    if (!run) throw new Error("createRunDatabase returned nothing, but INTEGRATION_DATABASE_URL is set.");
    process.env.INTEGRATION_RUN_DATABASE = run.database;
    process.env.INTEGRATION_RUN_ROLE = run.role;
  }, LIFECYCLE_TIMEOUT_MS);

  afterAll(async () => {
    try {
      for (const app of apps.splice(0)) await app.close();
      await closePools();
      if (run) await dropRunDatabase(run.database, run.role);
    } finally {
      for (const [name, value] of priorEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }, LIFECYCLE_TIMEOUT_MS);

  async function harness(t: Tenant, ownerNotices?: OwnerNoticeQueue) {
    const built = await buildApp(t, ownerNotices);
    apps.push(built.app);
    return built;
  }

  test("a client id save that waits for a concurrent change keeps that change, the omitted secret, and records its editor", async () => {
    const t = await seedTenant();
    const seeded = await seedConfiguredApp(t);
    const { app, integrationStates } = await harness(t);

    // The owner turns reads off and replaces the Directory (tenant) ID.
    const response = await saveDuringConcurrentChange(app, t,
      `UPDATE tenant_integrations
       SET reads_enabled = FALSE,
           config_json = config_json || '{"entraTenantId": "${NEW_DIRECTORY}"}'::jsonb,
           updated_by = $2, updated_at = NOW()
       WHERE tenant_id = $1 AND integration_id = 'microsoft'`,
      { clientId: "client-new" });

    expect(response.statusCode, response.body).toBe(200);
    const row = await integrationStates.get(t.tenantId, "microsoft");
    expect(row).toMatchObject({ readsEnabled: false, writesEnabled: true, updatedBy: t.adminId });
    expect(row?.config).toEqual({
      clientId: "client-new",
      clientSecret: seeded.config.clientSecret,
      entraTenantId: NEW_DIRECTORY
    });
    expect(decrypt(String(row?.config.clientSecret), SECRET)).toBe("secret-old");
    expect(await auditEventsOf(t.tenantId)).toEqual([{
      user_id: t.adminId,
      event_type: "tenant.integration.updated",
      payload: { integrationId: "microsoft", configChanged: true, changedFields: ["clientId"] }
    }]);
  });

  test("a new secret saved while reads are turned off keeps reads off, is stored encrypted, and is in no audit event, notice or log", async () => {
    const t = await seedTenant();
    await seedConfiguredApp(t);
    const { app, integrationStates, logLines } = await harness(t);

    const response = await saveDuringConcurrentChange(app, t,
      `UPDATE tenant_integrations SET reads_enabled = FALSE, updated_by = $2, updated_at = NOW()
       WHERE tenant_id = $1 AND integration_id = 'microsoft'`,
      { clientSecret: "  secret-new  " });

    expect(response.statusCode, response.body).toBe(200);
    const row = await integrationStates.get(t.tenantId, "microsoft");
    expect(row).toMatchObject({ readsEnabled: false, writesEnabled: true, updatedBy: t.adminId });
    expect(row?.config).toMatchObject({ clientId: "client-old", entraTenantId: OLD_DIRECTORY });
    expect(row?.config.clientSecret).not.toContain("secret-new");
    expect(decrypt(String(row?.config.clientSecret), SECRET)).toBe("secret-new");

    const audits = await auditEventsOf(t.tenantId);
    expect(audits).toEqual([{
      user_id: t.adminId,
      event_type: "tenant.integration.updated",
      payload: { integrationId: "microsoft", configChanged: true, changedFields: ["clientSecret"] }
    }]);
    const notices = await noticesOf(t.tenantId);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("Client secret");
    expect(logLines.length).toBeGreaterThan(0);
    for (const written of [JSON.stringify(audits), ...notices, ...logLines]) {
      expect(written).not.toContain("secret-new");
    }
  });

  test.each([
    ["no configuration yet", async (_t: Tenant, _app: FastifyInstance) => {}],
    ["a removed configuration", async (t: Tenant, app: FastifyInstance) => {
      await seedConfiguredApp(t);
      expect((await app.inject({ method: "DELETE", url: "/tenant/settings/microsoft" })).statusCode).toBe(204);
    }]
  ])("with %s, a save without all three fields writes nothing", async (_case, setUp) => {
    const t = await seedTenant();
    const { app, integrationStates } = await harness(t);
    await setUp(t, app);
    const before = await integrationStates.get(t.tenantId, "microsoft");
    const auditsBefore = await auditEventsOf(t.tenantId);

    const response = await app.inject({ method: "PUT", url: "/tenant/settings/microsoft", payload: { clientSecret: "secret-new" } });

    expect(response.statusCode).toBe(500);
    expect(await integrationStates.get(t.tenantId, "microsoft")).toEqual(before);
    expect(await auditEventsOf(t.tenantId)).toEqual(auditsBefore);
    expect(await noticesOf(t.tenantId)).toEqual([]);
  });

  test("when the owner notice fails, the save rolls back with its audit event", async () => {
    const t = await seedTenant();
    const seeded = await seedConfiguredApp(t);
    const failingNotices: OwnerNoticeQueue = { queueOwnerNotice: async () => { throw new Error("outbox unavailable"); } };
    const { app, integrationStates } = await harness(t, failingNotices);

    const response = await app.inject({
      method: "PUT", url: "/tenant/settings/microsoft", payload: { clientId: "client-new", clientSecret: "secret-new" }
    });

    expect(response.statusCode).toBe(500);
    expect(await integrationStates.get(t.tenantId, "microsoft")).toEqual(seeded);
    expect(await auditEventsOf(t.tenantId)).toEqual([]);
  });
});
