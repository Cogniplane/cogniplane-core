// The connection editor (Admin > Connections) saves a full draft: every field,
// the audience included. The draft carries the saved version it started from,
// and the save must refuse it when another admin saved a newer version first.
// Otherwise an old draft turns a disabled connection back on for all members
// and sends its kept secret to the old address (GitHub issue #42).
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, test, vi } from "vitest";

import { registerAdminMcpServerRoutes } from "../routes/admin/admin-mcp-server-routes.js";
import { DataRouteControl } from "../services/data-route-control.js";
import { DynamicConfigService } from "../services/dynamic-config-service.js";
import { ManagedToolCatalog } from "../services/managed-tools/catalog.js";
import { MemberMcpCredentialStore } from "../services/member-mcp-credential-store.js";
import { McpServerStore } from "../services/mcp-server-store.js";
import { TenantSettingsStore } from "../services/tenant-settings-store.js";
import { createTestConfig } from "../test-helpers/test-config.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedMembership, seedTenantGraph, seedUser } from "./support/fixtures.js";

const ENCRYPTION_SECRET = "integration-mcp-setup-version-secret-value";
const CONFLICT = {
  error: "mcp_server_conflict",
  message: "This connection changed after you opened it. Review the saved connection before you save again."
};

function service() {
  return new DynamicConfigService(
    createTestConfig(),
    {
      skills: {} as never,
      skillRevisions: {} as never,
      mcpServers: new McpServerStore(appPool(), ENCRYPTION_SECRET),
      tenantSettings: new TenantSettingsStore(appPool())
    },
    { async storeBundle() { throw new Error("unused"); }, async deleteBundle() {} },
    new ManagedToolCatalog()
  );
}

/**
 * The admin routes for one tenant. `x-test-user` picks the acting admin, so
 * two admins can edit the same connection. The owner notice queue records
 * every notice that a change commits.
 */
async function adminApp(tenantId: string, admins: string[]) {
  const notices: unknown[] = [];
  const app = Fastify();
  app.decorate("db", appPool());
  app.addHook("preHandler", async (request) => {
    const userId = String(request.headers["x-test-user"] ?? admins[0]);
    request.auth = { userId, tenantId, isAdmin: admins.includes(userId), role: "admin" };
  });
  const dataRoutes = new DataRouteControl({
    authMode: "dev-headers",
    ownerNotices: { queueOwnerNotice: vi.fn(async (_client, _tenantId, notice) => { notices.push(notice); return 1; }) }
  });
  await registerAdminMcpServerRoutes(app, { dataRoutes, dynamicConfig: service() });
  return { app, notices };
}

async function listed(app: FastifyInstance, serverId: string, userId?: string) {
  const response = await app.inject({
    method: "GET", url: "/admin/mcp-servers", headers: userId ? { "x-test-user": userId } : {}
  });
  expect(response.statusCode).toBe(200);
  const server = (response.json().mcpServers as Array<Record<string, unknown>>).find((row) => row.serverId === serverId);
  if (!server) throw new Error(`${serverId} is not listed`);
  return server as { version: number; upstreamUrl: string; enabled: boolean; isPublished: boolean; isAllowed: boolean };
}

/** Everything a save can write, read past RLS. */
async function savedState(tenantId: string, serverId: string) {
  const db = superuserPool();
  const [row, settings, audits, credentials] = await Promise.all([
    db.query(
      `SELECT enabled, is_published, upstream_url, upstream_auth_type, upstream_auth_secret_encrypted,
              credential_scope, credential_binding_id, config_hash, version::int AS version, description, updated_at
       FROM admin_mcp_servers WHERE tenant_id = $1 AND server_id = $2`,
      [tenantId, serverId]
    ),
    db.query("SELECT enabled_mcp_server_ids, version FROM tenant_settings WHERE tenant_id = $1", [tenantId]),
    db.query("SELECT event_type FROM audit_events WHERE tenant_id = $1 ORDER BY id", [tenantId]),
    db.query(
      `SELECT user_id, credential_binding_id, secret_encrypted IS NOT NULL AS has_secret, version
       FROM member_mcp_credentials WHERE tenant_id = $1 AND server_id = $2 ORDER BY user_id`,
      [tenantId, serverId]
    )
  ]);
  return { row: row.rows[0], settings: settings.rows[0], audits: audits.rows, credentials: credentials.rows };
}

/** Two admins of one tenant and one connection that all members can use. */
async function membersConnection(auth: Record<string, unknown>, upstreamUrl = "https://vendor.example/v1/mcp") {
  const owner = await seedTenantGraph();
  const adminB = await seedUser();
  await seedMembership(owner.tenantId, adminB, "admin");
  const { app, notices } = await adminApp(owner.tenantId, [owner.userId, adminB]);
  const serverId = `vendor-${randomUUID()}`;
  const base = {
    serverId,
    serverName: "Vendor tools",
    description: "Vendor search",
    mode: "proxy",
    routePath: `/mcp/${serverId}`,
    upstreamUrl
  };
  const created = await app.inject({
    method: "POST", url: "/admin/mcp-servers/setup", payload: { ...base, ...auth, audience: "members" }
  });
  expect(created.statusCode, created.body).toBe(201);
  return { owner, adminB, app, notices, serverId, base };
}

describe.skipIf(!adminDatabaseUrl())("MCP connection setup version", () => {
  test.each([
    {
      name: "a bearer secret, new path on the same origin",
      auth: { upstreamAuthType: "bearer", upstreamAuthSecret: "vendor-secret" },
      replacementUrl: "https://vendor.example/v2/mcp"
    },
    {
      name: "no authentication, new origin",
      auth: { upstreamAuthType: "none" },
      replacementUrl: "https://replacement.example/mcp"
    }
  ])("a stale full draft cannot turn a disabled connection back on ($name)", async ({ auth, replacementUrl }) => {
    const { owner, adminB, app, notices, serverId, base } = await membersConnection(auth);
    try {
      // Admin A opens the connection while it is available to members.
      const opened = await listed(app, serverId, owner.userId);
      expect(opened).toMatchObject({ enabled: true, isPublished: true, isAllowed: true });

      // Admin B turns it off and moves the upstream, from a fresh copy.
      const disabled = await app.inject({
        method: "PUT",
        url: `/admin/mcp-servers/${serverId}/setup`,
        headers: { "x-test-user": adminB },
        payload: { ...base, upstreamUrl: replacementUrl, audience: "off", expectedVersion: opened.version }
      });
      expect(disabled.statusCode, disabled.body).toBe(200);
      const afterB = await savedState(owner.tenantId, serverId);
      const noticesAfterB = notices.length;
      expect(afterB.row).toMatchObject({ enabled: false, is_published: false, upstream_url: replacementUrl });
      expect(afterB.settings.enabled_mcp_server_ids).not.toContain(serverId);

      // Admin A saves the old draft: a new description, the rest as opened.
      const stale = await app.inject({
        method: "PUT",
        url: `/admin/mcp-servers/${serverId}/setup`,
        headers: { "x-test-user": owner.userId },
        payload: { ...base, description: "Edited by A", audience: "members", expectedVersion: opened.version }
      });
      expect(stale.statusCode, stale.body).toBe(409);
      expect(stale.json()).toEqual(CONFLICT);

      // Nothing changed: no field, no allow list entry, no version, no audit
      // event, no owner notice.
      expect(await savedState(owner.tenantId, serverId)).toEqual(afterB);
      expect(notices).toHaveLength(noticesAfterB);
      expect(await listed(app, serverId)).toMatchObject({
        enabled: false, isPublished: false, isAllowed: false, upstreamUrl: replacementUrl
      });
    } finally {
      await app.close();
    }
  });

  test("a stale draft gets the conflict before the secret check, and the newer secret stays", async () => {
    const { owner, adminB, app, serverId, base } = await membersConnection({
      upstreamAuthType: "bearer", upstreamAuthSecret: "first-secret"
    });
    try {
      const opened = await listed(app, serverId);
      const moved = await app.inject({
        method: "PUT",
        url: `/admin/mcp-servers/${serverId}/setup`,
        headers: { "x-test-user": adminB },
        payload: {
          ...base, upstreamUrl: "https://replacement.example/mcp", upstreamAuthSecret: "replacement-secret",
          audience: "off", expectedVersion: opened.version
        }
      });
      expect(moved.statusCode, moved.body).toBe(200);
      const before = await savedState(owner.tenantId, serverId);

      // The old draft names the old origin with a blank secret. The current row
      // would ask for the secret again; the version answers first.
      const stale = await app.inject({
        method: "PUT",
        url: `/admin/mcp-servers/${serverId}/setup`,
        payload: { ...base, audience: "members", expectedVersion: opened.version }
      });
      expect(stale.statusCode, stale.body).toBe(409);
      expect(stale.json()).toEqual(CONFLICT);
      expect(stale.body).not.toContain("secret");
      expect(await savedState(owner.tenantId, serverId)).toEqual(before);
      const runtime = await new McpServerStore(appPool(), ENCRYPTION_SECRET).getMcpServer(owner.tenantId, serverId);
      expect(runtime?.upstreamAuth).toEqual({ type: "bearer", secret: "replacement-secret" });
    } finally {
      await app.close();
    }
  });

  test("a stale draft does not revoke member credentials", async () => {
    const { owner, adminB, app, serverId, base } = await membersConnection({
      upstreamAuthType: "header", upstreamAuthName: "X-API-Key", credentialScope: "personal"
    });
    try {
      const opened = await listed(app, serverId);
      const members = new MemberMcpCredentialStore(appPool(), ENCRYPTION_SECRET);
      const saved = await new McpServerStore(appPool(), ENCRYPTION_SECRET).getAdminMcpServer(owner.tenantId, serverId);
      await members.save(owner.tenantId, owner.userId, serverId, {
        version: 0, serverVersion: saved!.version, secret: "member-secret", accountLabel: null
      }, null);
      // Admin B limits the connection to test users. The binding stays.
      const limited = await app.inject({
        method: "PUT",
        url: `/admin/mcp-servers/${serverId}/setup`,
        headers: { "x-test-user": adminB },
        payload: { ...base, audience: "test_users", expectedVersion: opened.version }
      });
      expect(limited.statusCode, limited.body).toBe(200);
      const before = await savedState(owner.tenantId, serverId);
      expect(before.credentials).toEqual([expect.objectContaining({ user_id: owner.userId, has_secret: true })]);

      // The old draft also moves the address, which would revoke every member's
      // credential.
      const stale = await app.inject({
        method: "PUT",
        url: `/admin/mcp-servers/${serverId}/setup`,
        payload: { ...base, upstreamUrl: "https://other.example/mcp", audience: "members", expectedVersion: opened.version }
      });
      expect(stale.statusCode, stale.body).toBe(409);
      expect(await savedState(owner.tenantId, serverId)).toEqual(before);
    } finally {
      await app.close();
    }
  });

  test("the current version saves, and each save gives the next version to send", async () => {
    const { owner, app, notices, serverId, base } = await membersConnection({ upstreamAuthType: "none" });
    try {
      const opened = await listed(app, serverId);
      const first = await app.inject({
        method: "PUT",
        url: `/admin/mcp-servers/${serverId}/setup`,
        payload: { ...base, description: "First edit", audience: "test_users", expectedVersion: opened.version }
      });
      expect(first.statusCode, first.body).toBe(200);
      const firstVersion = first.json().mcpServer.version as number;
      expect(firstVersion).toBeGreaterThan(opened.version);
      expect(await listed(app, serverId)).toMatchObject({ version: firstVersion, isPublished: false, isAllowed: true });

      const second = await app.inject({
        method: "PUT",
        url: `/admin/mcp-servers/${serverId}/setup`,
        payload: { ...base, description: "Second edit", audience: "members", expectedVersion: firstVersion }
      });
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json().mcpServer).toMatchObject({ description: "Second edit", isPublished: true });

      // The first version is old now.
      const before = await savedState(owner.tenantId, serverId);
      const noticesBefore = notices.length;
      const repeated = await app.inject({
        method: "PUT",
        url: `/admin/mcp-servers/${serverId}/setup`,
        payload: { ...base, description: "Third edit", audience: "off", expectedVersion: firstVersion }
      });
      expect(repeated.statusCode).toBe(409);
      expect(await savedState(owner.tenantId, serverId)).toEqual(before);
      expect(notices).toHaveLength(noticesBefore);
    } finally {
      await app.close();
    }
  });

  test("a publish change from another route makes an open draft stale", async () => {
    const { owner, app, serverId, base } = await membersConnection({ upstreamAuthType: "none" });
    try {
      const opened = await listed(app, serverId);
      const unpublished = await app.inject({ method: "POST", url: `/admin/mcp-servers/${serverId}/unpublish` });
      expect(unpublished.statusCode).toBe(200);
      const before = await savedState(owner.tenantId, serverId);
      const stale = await app.inject({
        method: "PUT",
        url: `/admin/mcp-servers/${serverId}/setup`,
        payload: { ...base, audience: "members", expectedVersion: opened.version }
      });
      expect(stale.statusCode).toBe(409);
      expect(await savedState(owner.tenantId, serverId)).toEqual(before);
    } finally {
      await app.close();
    }
  });

  test("two saves from the same version: one saves, the other gets the conflict", async () => {
    const { owner, adminB, app, serverId, base } = await membersConnection({ upstreamAuthType: "none" });
    try {
      const opened = await listed(app, serverId);
      const [fromA, fromB] = await Promise.all([
        app.inject({
          method: "PUT", url: `/admin/mcp-servers/${serverId}/setup`, headers: { "x-test-user": owner.userId },
          payload: { ...base, description: "From A", audience: "members", expectedVersion: opened.version }
        }),
        app.inject({
          method: "PUT", url: `/admin/mcp-servers/${serverId}/setup`, headers: { "x-test-user": adminB },
          payload: { ...base, description: "From B", audience: "off", expectedVersion: opened.version }
        })
      ]);
      expect([fromA.statusCode, fromB.statusCode].sort()).toEqual([200, 409]);
      const winner = fromA.statusCode === 200 ? fromA : fromB;
      const state = await savedState(owner.tenantId, serverId);
      expect(state.row).toMatchObject({
        description: winner.json().mcpServer.description,
        enabled: winner.json().mcpServer.enabled,
        version: winner.json().mcpServer.version
      });
      expect(state.audits.filter((row) => row.event_type === "admin.mcp_server.updated")).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  test.each([
    { outcome: "commits", status: 409 },
    { outcome: "rolls back", status: 200 }
  ])("a save waits for the row lock and compares after a concurrent writer $outcome", async ({ outcome, status }) => {
    const { owner, app, serverId, base } = await membersConnection({ upstreamAuthType: "none" });
    const holder = await superuserPool().connect();
    let holderError: Error | undefined;
    try {
      const opened = await listed(app, serverId);
      await holder.query("BEGIN");
      // Another admin's change is in flight: the row is locked and turned off.
      await holder.query(
        `UPDATE admin_mcp_servers SET enabled = FALSE, is_published = FALSE, version = version + 1, updated_at = NOW()
         WHERE tenant_id = $1 AND server_id = $2`,
        [owner.tenantId, serverId]
      );
      const { rows } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const save = app.inject({
        method: "PUT",
        url: `/admin/mcp-servers/${serverId}/setup`,
        payload: { ...base, description: "Waited", audience: "members", expectedVersion: opened.version }
      });
      await vi.waitFor(async () => {
        const blocked = await superuserPool().query<{ count: string }>(
          "SELECT count(*)::text AS count FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
          [rows[0]!.pid]
        );
        expect(Number(blocked.rows[0]!.count)).toBe(1);
      }, { timeout: 5_000 });
      await holder.query(outcome === "commits" ? "COMMIT" : "ROLLBACK");

      const response = await save;
      expect(response.statusCode, response.body).toBe(status);
      const state = await savedState(owner.tenantId, serverId);
      if (status === 409) {
        expect(response.json()).toEqual(CONFLICT);
        expect(state.row).toMatchObject({ enabled: false, is_published: false, description: "Vendor search" });
        expect(state.audits.map((row) => row.event_type)).not.toContain("admin.mcp_server.updated");
      } else {
        expect(state.row).toMatchObject({ enabled: true, is_published: true, description: "Waited" });
      }
    } catch (error) {
      holderError = error as Error;
      await holder.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      holder.release(holderError);
      await app.close();
    }
  });

  test("an admin of another tenant cannot edit the connection with its version", async () => {
    const { owner, app, serverId, base } = await membersConnection({ upstreamAuthType: "none" });
    const other = await seedTenantGraph();
    const { app: otherApp } = await adminApp(other.tenantId, [other.userId]);
    try {
      const opened = await listed(app, serverId);
      const before = await savedState(owner.tenantId, serverId);
      const response = await otherApp.inject({
        method: "PUT",
        url: `/admin/mcp-servers/${serverId}/setup`,
        payload: { ...base, audience: "off", expectedVersion: opened.version }
      });
      expect(response.statusCode).toBe(404);
      expect(await savedState(owner.tenantId, serverId)).toEqual(before);
    } finally {
      await app.close();
      await otherApp.close();
    }
  });
});
