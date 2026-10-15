import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import Fastify from "fastify";

import { encrypt } from "../lib/crypto-utils.js";
import { registerAdminMcpServerRoutes } from "../routes/admin/admin-mcp-server-routes.js";
import { DynamicConfigService } from "../services/dynamic-config-service.js";
import { ManagedToolCatalog } from "../services/managed-tools/catalog.js";
import { McpServerStore } from "../services/mcp-server-store.js";
import { TenantSettingsStore } from "../services/tenant-settings-store.js";
import { createTestConfig } from "../test-helpers/test-config.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedTenantGraph } from "./support/fixtures.js";

const ENCRYPTION_SECRET = "integration-mcp-availability-secret-value";

function makeService(failSettingsWrite = false) {
  const servers = new McpServerStore(appPool(), ENCRYPTION_SECRET);
  const settings = new TenantSettingsStore(appPool());
  const tenantSettings = failSettingsWrite
    ? {
        get: settings.get.bind(settings),
        upsert: settings.upsert.bind(settings),
        async setMcpServerAllowed(): Promise<never> {
          throw new Error("settings write failed");
        }
      }
    : settings;
  return new DynamicConfigService(
    createTestConfig(),
    {
      skills: {} as never,
      skillRevisions: {} as never,
      mcpServers: servers,
      tenantSettings
    },
    { async storeBundle() { throw new Error("unused"); }, async deleteBundle() {} },
    new ManagedToolCatalog()
  );
}

describe.skipIf(!adminDatabaseUrl())("MCP connection availability", () => {
  test("changes only tenant allowlists for inherited system connections", async () => {
    const owner = await seedTenantGraph();
    const other = await seedTenantGraph();
    const service = makeService();
    const serverId = "managed-session-context";
    const before = await superuserPool().query(
      "SELECT enabled, is_published, version FROM admin_mcp_servers WHERE tenant_id = 'system' AND server_id = $1",
      [serverId]
    );

    await service.setInheritedMcpAudience(owner.tenantId, serverId, "off");
    expect((await service.getOrCreateTenantSettings(owner.tenantId)).enabledMcpServerIds).not.toContain(serverId);
    expect((await service.getOrCreateTenantSettings(other.tenantId)).enabledMcpServerIds).toContain(serverId);
    await expect(service.setInheritedMcpAudience(owner.tenantId, serverId, "test_users"))
      .rejects.toThrow("published for all members");
    await service.setInheritedMcpAudience(owner.tenantId, serverId, "members");
    expect((await service.getOrCreateTenantSettings(owner.tenantId)).enabledMcpServerIds).toContain(serverId);

    const after = await superuserPool().query(
      "SELECT enabled, is_published, version FROM admin_mcp_servers WHERE tenant_id = 'system' AND server_id = $1",
      [serverId]
    );
    expect(after.rows).toEqual(before.rows);
  });

  test("keeps an unpublished system connection restricted to test users", async () => {
    const owner = await seedTenantGraph();
    const serverId = `system-test-${randomUUID()}`;
    await superuserPool().query(
      `INSERT INTO admin_mcp_servers (
        tenant_id, server_id, server_name, transport_kind, mode, route_path,
        version, config_hash, enabled, is_published, created_by
      ) VALUES ('system', $1, 'System test connection', 'http', 'managed', $2, 1, 'test', TRUE, FALSE, 'system')`,
      [serverId, `/mcp/${serverId}`]
    );
    try {
      const service = makeService();
      await expect(service.setInheritedMcpAudience(owner.tenantId, serverId, "members"))
        .rejects.toThrow("only to test users");
      await service.setInheritedMcpAudience(owner.tenantId, serverId, "test_users");
      expect((await service.getOrCreateTenantSettings(owner.tenantId)).enabledMcpServerIds)
        .toContain(serverId);
    } finally {
      await superuserPool().query(
        "DELETE FROM admin_mcp_servers WHERE tenant_id = 'system' AND server_id = $1",
        [serverId]
      );
    }
  });

  test("never returns a system upstream secret from inherited availability", async () => {
    const owner = await seedTenantGraph();
    const serverId = `system-auth-${randomUUID()}`;
    const secret = "system-upstream-credential";
    await superuserPool().query(
      `INSERT INTO admin_mcp_servers (
        tenant_id, server_id, server_name, transport_kind, mode, route_path,
        upstream_url, upstream_auth_type, upstream_auth_secret_encrypted,
        version, config_hash, enabled, is_published, created_by
      ) VALUES ('system', $1, 'Authenticated system connection', 'http', 'proxy', $2,
                'https://example.com/mcp', 'bearer', $3, 1, 'test', TRUE, FALSE, 'system')`,
      [serverId, `/mcp/${serverId}`, encrypt(secret, ENCRYPTION_SECRET)]
    );
    const app = Fastify();
    app.decorate("db", appPool());
    app.addHook("preHandler", async (request) => {
      request.auth = {
        userId: owner.userId,
        tenantId: owner.tenantId,
        isAdmin: true,
        role: "owner"
      };
    });
    const service = makeService();
    await registerAdminMcpServerRoutes(app, { dynamicConfig: service });
    try {
      const saved = await service.setInheritedMcpAudience(owner.tenantId, serverId, "test_users");
      expect(JSON.stringify(saved)).not.toContain(secret);
      expect(saved).not.toHaveProperty("upstreamAuth");

      const response = await app.inject({
        method: "PUT",
        url: `/admin/mcp-servers/${serverId}/inherited-availability`,
        payload: { audience: "off" }
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(secret);
      expect(response.json().mcpServer).not.toHaveProperty("upstreamAuth");
    } finally {
      await app.close();
      await superuserPool().query(
        "DELETE FROM admin_mcp_servers WHERE tenant_id = 'system' AND server_id = $1",
        [serverId]
      );
    }
  });

  test("saves audience gates together and keeps the connection in its tenant", async () => {
    const owner = await seedTenantGraph();
    const other = await seedTenantGraph();
    const serverId = `research-${randomUUID()}`;
    const service = makeService();
    const input = {
      serverId,
      serverName: "Research",
      description: null,
      transportKind: "http" as const,
      mode: "proxy" as const,
      routePath: `/mcp/${serverId}`,
      upstreamUrl: "https://example.com/mcp",
      upstreamAuthType: "none" as const,
      upstreamAuthName: null,
      upstreamAuthSecret: null,
      enabled: true,
      actorUserId: owner.userId
    };

    const members = await service.saveMcpServerWithAudience(owner.tenantId, input, "members");
    expect(members).toMatchObject({ enabled: true, isPublished: true });
    expect((await service.getOrCreateTenantSettings(owner.tenantId)).enabledMcpServerIds).toContain(serverId);
    expect((await service.listMcpServers(other.tenantId)).some((server) => server.serverId === serverId)).toBe(false);

    const off = await service.saveMcpServerWithAudience(owner.tenantId, input, "off", serverId);
    expect(off).toMatchObject({ enabled: false, isPublished: false });
    expect((await service.getOrCreateTenantSettings(owner.tenantId)).enabledMcpServerIds).not.toContain(serverId);
    expect((await service.getOrCreateTenantSettings(other.tenantId)).enabledMcpServerIds).not.toContain(serverId);
  });

  test("rolls back registration and disable when the allowlist write fails", async () => {
    const owner = await seedTenantGraph();
    const serverId = `rollback-${randomUUID()}`;
    const input = {
      serverId,
      serverName: "Rollback",
      description: null,
      transportKind: "http" as const,
      mode: "proxy" as const,
      routePath: `/mcp/${serverId}`,
      upstreamUrl: "https://example.com/mcp",
      upstreamAuthType: "none" as const,
      upstreamAuthName: null,
      upstreamAuthSecret: null,
      enabled: true,
      actorUserId: owner.userId
    };

    const audit = () => ({
      tenantId: owner.tenantId,
      sessionId: null,
      userId: owner.userId,
      type: "admin.mcp_server.created" as const,
      payload: { serverId }
    });
    await expect(makeService(true).saveMcpServerWithAudience(owner.tenantId, input, "members", undefined, audit))
      .rejects.toThrow("settings write failed");
    const auditAfterFailedCreate = await superuserPool().query(
      "SELECT 1 FROM audit_events WHERE tenant_id = $1 AND payload->>'serverId' = $2",
      [owner.tenantId, serverId]
    );
    expect(auditAfterFailedCreate.rows).toHaveLength(0);
    const afterFailedCreate = await superuserPool().query(
      "SELECT 1 FROM admin_mcp_servers WHERE tenant_id = $1 AND server_id = $2",
      [owner.tenantId, serverId]
    );
    expect(afterFailedCreate.rows).toHaveLength(0);

    await makeService().saveMcpServerWithAudience(owner.tenantId, input, "members");
    await expect(makeService(true).saveMcpServerWithAudience(owner.tenantId, input, "off", serverId))
      .rejects.toThrow("settings write failed");
    const afterFailedDisable = await new McpServerStore(appPool(), ENCRYPTION_SECRET)
      .getMcpServer(owner.tenantId, serverId);
    expect(afterFailedDisable).toMatchObject({ enabled: true, isPublished: true });
    expect((await makeService().getOrCreateTenantSettings(owner.tenantId)).enabledMcpServerIds)
      .toContain(serverId);
  });

  test("rolls back the change when its audit event cannot be written", async () => {
    const owner = await seedTenantGraph();
    const serverId = `audit-${randomUUID()}`;
    const service = makeService();
    // An invalid inet value makes the audit INSERT fail inside the transaction.
    const badAudit = () => ({
      tenantId: owner.tenantId,
      sessionId: null,
      userId: owner.userId,
      type: "admin.mcp_server.created" as const,
      payload: { serverId },
      ipAddress: "not-an-ip"
    });
    await expect(service.saveMcpServerWithAudience(owner.tenantId, {
      serverId,
      serverName: "Audit",
      description: null,
      transportKind: "http",
      mode: "proxy",
      routePath: `/mcp/${serverId}`,
      upstreamUrl: "https://example.com/mcp",
      upstreamAuthType: "none",
      upstreamAuthName: null,
      upstreamAuthSecret: null,
      enabled: true,
      actorUserId: owner.userId
    }, "members", undefined, badAudit)).rejects.toThrow();
    expect((await service.listMcpServers(owner.tenantId)).some((server) => server.serverId === serverId)).toBe(false);
    expect((await service.getOrCreateTenantSettings(owner.tenantId)).enabledMcpServerIds).not.toContain(serverId);

    // Publish, unpublish, disable and the legacy create and update also roll back.
    const legacy = {
      serverId,
      serverName: "Audit",
      description: null,
      transportKind: "http" as const,
      mode: "proxy" as const,
      routePath: `/mcp/${serverId}`,
      upstreamUrl: "https://example.com/mcp",
      upstreamAuthType: "none" as const,
      upstreamAuthName: null,
      upstreamAuthSecret: null,
      enabled: true,
      actorUserId: owner.userId
    };
    await expect(service.createMcpServer(owner.tenantId, legacy, badAudit)).rejects.toThrow();
    expect((await service.listMcpServers(owner.tenantId)).some((server) => server.serverId === serverId)).toBe(false);
    await service.createMcpServer(owner.tenantId, legacy);
    await expect(service.updateMcpServer(owner.tenantId, { ...legacy, serverName: "Renamed" }, badAudit))
      .rejects.toThrow();
    await expect(service.setMcpServerPublished(owner.tenantId, serverId, false, badAudit)).rejects.toThrow();
    await expect(service.disableMcpServer(owner.tenantId, serverId, badAudit)).rejects.toThrow();
    expect(await service.listMcpServers(owner.tenantId).then((servers) =>
      servers.find((server) => server.serverId === serverId))).toMatchObject({
      serverName: "Audit",
      enabled: true,
      isPublished: true,
      version: 1
    });

    const before = await service.getOrCreateTenantSettings(owner.tenantId);
    await expect(service.setInheritedMcpAudience(owner.tenantId, "managed-session-context", "off", badAudit))
      .rejects.toThrow();
    await expect(service.updateTenantSettings(owner.tenantId, {
      policyEnforcementMode: before.policyEnforcementMode === "enforce" ? "monitor" : "enforce"
    }, badAudit)).rejects.toThrow();
    const after = await service.getOrCreateTenantSettings(owner.tenantId);
    expect(after.version).toBe(before.version);
    expect(after.policyEnforcementMode).toBe(before.policyEnforcementMode);
    expect(after.enabledMcpServerIds).toEqual(before.enabledMcpServerIds);
  });

  test("writes the setup audit event and keeps omitted auth fields on edit", async () => {
    const owner = await seedTenantGraph();
    const serverId = `setup-${randomUUID()}`;
    const service = makeService();
    const app = Fastify();
    app.decorate("db", appPool());
    app.addHook("preHandler", async (request) => {
      request.auth = { userId: owner.userId, tenantId: owner.tenantId, isAdmin: true, role: "owner" };
    });
    await registerAdminMcpServerRoutes(app, { dynamicConfig: service });
    const base = {
      serverId,
      serverName: "Setup",
      mode: "proxy",
      routePath: `/mcp/${serverId}`,
      upstreamUrl: "https://example.com/mcp",
      audience: "members"
    };
    try {
      const created = await app.inject({
        method: "POST",
        url: "/admin/mcp-servers/setup",
        payload: { ...base, upstreamAuthType: "header", upstreamAuthName: "X-Api-Key", upstreamAuthSecret: "setup-secret" }
      });
      expect(created.statusCode).toBe(201);

      const edited = await app.inject({
        method: "PUT",
        url: `/admin/mcp-servers/${serverId}/setup`,
        payload: { ...base, serverName: "Setup renamed" }
      });
      expect(edited.statusCode).toBe(200);
      expect(edited.json().mcpServer).toMatchObject({
        serverName: "Setup renamed",
        upstreamAuthType: "header",
        upstreamAuthName: "X-Api-Key",
        upstreamAuthConfigured: true,
        credentialScope: "organization"
      });

      const unpublished = await app.inject({ method: "POST", url: `/admin/mcp-servers/${serverId}/unpublish` });
      expect(unpublished.statusCode).toBe(200);
      const off = await app.inject({
        method: "PUT",
        url: `/admin/mcp-servers/${serverId}/setup`,
        payload: { ...base, audience: "off" }
      });
      expect(off.statusCode).toBe(200);
      const disabled = await app.inject({ method: "POST", url: `/admin/mcp-servers/${serverId}/disable` });
      expect(disabled.statusCode).toBe(200);

      const audits = await superuserPool().query(
        "SELECT event_type FROM audit_events WHERE tenant_id = $1 AND payload->>'serverId' = $2 ORDER BY id",
        [owner.tenantId, serverId]
      );
      expect(audits.rows.map((row) => row.event_type)).toEqual([
        "admin.mcp_server.created",
        "admin.mcp_server.updated",
        "admin.mcp_server.unpublished",
        "admin.mcp_server.updated",
        "admin.mcp_server.disabled"
      ]);
    } finally {
      await app.close();
    }
  });
});
