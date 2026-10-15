import { describe, expect, test, vi } from "vitest";
import { withTenantScope } from "../lib/db.js";
import { PersonalCapabilityStore } from "../services/personal-capability-store.js";
import { AuditEventStore } from "../services/audit-event-store.js";
import { DynamicConfigService } from "../services/dynamic-config-service.js";
import { ManagedToolCatalog } from "../services/managed-tools/catalog.js";
import { McpServerStore } from "../services/mcp-server-store.js";
import { SessionStore } from "../services/session-store.js";
import { SkillConfigStore } from "../services/skills/skill-config-store.js";
import { TenantSettingsStore } from "../services/tenant-settings-store.js";
import { createTestConfig } from "../test-helpers/test-config.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedTenant, seedUser, seedMembership, seedSession } from "./support/fixtures.js";

const catalog = { skillIds: ["pdf", "writing"], connectorIds: ["docs"] };
describe.skipIf(!adminDatabaseUrl())("personal capability defaults", () => {
  test("saved defaults change the compiled bundle for an existing standalone session", async () => {
    const tenant = await seedTenant(), user = await seedUser();
    await seedMembership(tenant, user);
    const sessionId = await seedSession(tenant, user);
    const connectionId = `personal-runtime-${tenant}`;
    await superuserPool().query(
      `INSERT INTO admin_mcp_servers
         (tenant_id,server_id,server_name,transport_kind,mode,route_path,version,config_hash,enabled,is_published,created_by)
       VALUES ($1,$2,'Personal runtime connection','http','managed',$3,1,'personal-runtime',TRUE,TRUE,$4)`,
      [tenant, connectionId, `/mcp/${connectionId}`, user]
    );
    const settings = new TenantSettingsStore(appPool());
    await settings.upsert(tenant, { enabledMcpServerIds: ["managed-session-context", connectionId] });
    const personal = new PersonalCapabilityStore(appPool());
    const available = {
      skillIds: ["write-artifact", "skill-improver"],
      connectorIds: ["managed-session-context", connectionId]
    };
    expect(await personal.save(tenant, user, { selection: available, version: 0 }, available))
      .toEqual({ selection: available, version: 1 });

    const sessions = new SessionStore(appPool());
    const service = new DynamicConfigService(createTestConfig(), {
      sessions,
      skills: new SkillConfigStore(appPool()),
      skillRevisions: {} as never,
      mcpServers: new McpServerStore(appPool(), "personal-runtime-integration-secret"),
      tenantSettings: settings
    }, { async storeBundle() { throw new Error("unused"); }, async deleteBundle() {} },
    new ManagedToolCatalog());
    const compile = () => service.compileRuntimeConfig(tenant, false, { sessionId, userId: user });
    expect(await sessions.getCapabilitySelection(tenant, sessionId, user)).toEqual(available);
    const before = await compile();
    expect(before.skills.map(skill => skill.id)).toEqual(expect.arrayContaining(available.skillIds));
    expect(before.mcpServers.map(server => server.id)).toEqual(expect.arrayContaining(available.connectorIds));

    const narrowed = { skillIds: ["write-artifact"], connectorIds: ["managed-session-context"] };
    expect(await personal.save(tenant, user, { selection: narrowed, version: 1 }, available))
      .toEqual({ selection: narrowed, version: 2 });
    expect(await sessions.getCapabilitySelection(tenant, sessionId, user)).toEqual(narrowed);
    const after = await compile();
    expect(after.skills.map(skill => skill.id)).toContain("write-artifact");
    expect(after.skills.map(skill => skill.id)).not.toContain("skill-improver");
    expect(after.mcpServers.map(server => server.id)).toContain("managed-session-context");
    expect(after.mcpServers.map(server => server.id)).not.toContain(connectionId);
    expect(after.runtimePolicy.enabledMcpServers).not.toContain(connectionId);
    expect(after.hash).not.toBe(before.hash);
  });

  test("isolates users and organizations, persists empty choices, resets and audits", async () => {
    const tenant = await seedTenant(), otherTenant = await seedTenant();
    const user = await seedUser(), other = await seedUser();
    await Promise.all([seedMembership(tenant, user), seedMembership(otherTenant, user), seedMembership(tenant, other)]);
    const store = new PersonalCapabilityStore(appPool());
    expect(await store.get(tenant, user)).toEqual({ selection: null, version: 0 });
    const selected = { skillIds: ["pdf"], connectorIds: [] };
    expect(await store.save(tenant, user, { selection: selected, version: 0 }, catalog)).toEqual({ selection: selected, version: 1 });
    expect(await store.get(tenant, other)).toEqual({ selection: null, version: 0 });
    expect(await store.get(otherTenant, user)).toEqual({ selection: null, version: 0 });
    await withTenantScope(appPool(), otherTenant, async client => {
      const hidden = await client.query("SELECT * FROM personal_capability_defaults WHERE tenant_id=$1", [tenant]);
      expect(hidden.rows).toEqual([]);
    });
    const empty = { skillIds: [], connectorIds: [] };
    expect(await store.save(tenant, user, { selection: empty, version: 1 }, catalog)).toEqual({ selection: empty, version: 2 });
    expect(await new PersonalCapabilityStore(appPool()).get(tenant, user)).toEqual({ selection: empty, version: 2 });
    expect(await store.save(tenant, user, { selection: null, version: 2 }, catalog)).toEqual({ selection: null, version: 3 });
    const audit = await superuserPool().query("SELECT user_id, payload FROM audit_events WHERE tenant_id=$1 AND event_type='personal_capabilities_changed' ORDER BY created_at", [tenant]);
    expect(audit.rows).toHaveLength(3);
    expect(audit.rows.map(row => row.user_id)).toEqual([user, user, user]);
    expect(audit.rows[2].payload).toEqual({ selection: null, version: 3 });
  });

  test("serializes first saves and competing versions without restoring stale references", async () => {
    const tenant = await seedTenant(), user = await seedUser();
    await seedMembership(tenant, user);
    const store = new PersonalCapabilityStore(appPool());
    const choices = [{ skillIds: ["pdf"], connectorIds: [] }, { skillIds: [], connectorIds: ["docs"] }];
    const results = await Promise.all(choices.map(selection => store.save(tenant, user, { selection, version: 0 }, catalog)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await store.get(tenant, user)).version).toBe(1);
    const updates = await Promise.all(choices.map(selection => store.save(tenant, user, { selection, version: 1 }, catalog)));
    expect(updates.filter(Boolean)).toHaveLength(1);
    expect(await store.save(tenant, user, { selection: null, version: 2 }, catalog)).toEqual({ selection: null, version: 3 });
    expect(await store.save(tenant, user, { selection: choices[0], version: 2 }, catalog)).toBeNull();
    expect(await store.get(tenant, user)).toEqual({ selection: null, version: 3 });
    const audit = await superuserPool().query("SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND event_type='personal_capabilities_changed'", [tenant]);
    expect(Number(audit.rows[0].count)).toBe(3);
  });

  test("retains saved unavailable IDs but rejects new unavailable additions", async () => {
    const tenant = await seedTenant(), user = await seedUser();
    await seedMembership(tenant, user);
    const store = new PersonalCapabilityStore(appPool());
    await store.save(tenant, user, { selection: { skillIds: ["pdf"], connectorIds: [] }, version: 0 }, catalog);
    const changedCatalog = { skillIds: ["writing"], connectorIds: ["docs"] };
    const selection = { skillIds: ["pdf", "writing"], connectorIds: ["docs"] };
    expect(await store.save(tenant, user, { selection, version: 1 }, changedCatalog)).toEqual({ selection, version: 2 });
    expect(await store.save(tenant, user, { selection: { ...selection, skillIds: ["pdf", "unknown"] }, version: 2 }, changedCatalog)).toBeNull();
    expect(await store.get(tenant, user)).toEqual({ selection, version: 2 });
  });

  test("rolls back the first save on audit failure and removes defaults with membership", async () => {
    const tenant = await seedTenant(), user = await seedUser();
    await seedMembership(tenant, user);
    const store = new PersonalCapabilityStore(appPool());
    const failedAudit = vi.spyOn(AuditEventStore, "createInTransaction").mockRejectedValueOnce(new Error("Audit failed"));
    try {
      await expect(store.save(tenant, user, { selection: catalog, version: 0 }, catalog)).rejects.toThrow("Audit failed");
    } finally { failedAudit.mockRestore(); }
    expect(await store.get(tenant, user)).toEqual({ selection: null, version: 0 });
    await store.save(tenant, user, { selection: catalog, version: 0 }, catalog);
    await superuserPool().query("DELETE FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2", [tenant, user]);
    expect((await superuserPool().query("SELECT * FROM personal_capability_defaults WHERE tenant_id=$1", [tenant])).rows).toEqual([]);
    await expect(store.get(tenant, user)).rejects.toThrow("membership");
    await expect(store.save(tenant, user, { selection: null, version: 0 }, catalog)).rejects.toThrow("membership");
  });
});
