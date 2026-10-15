import { randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { AdminPersonAccessResponseSchema, type SessionCapabilitySelection } from "@cogniplane/shared-types";
import { PersonAccessService, PersonAccessMemberNotFound } from "../services/person-access-service.js";
import { SkillConfigStore } from "../services/skills/skill-config-store.js";
import { McpServerStore } from "../services/mcp-server-store.js";
import { TenantMemberStore } from "../services/tenant-member-store.js";
import { TenantSettingsStore } from "../services/tenant-settings-store.js";
import { PersonalCapabilityStore } from "../services/personal-capability-store.js";
import { MemberMcpCredentialStore } from "../services/member-mcp-credential-store.js";
import { SessionStore } from "../services/session-store.js";
import { DynamicConfigService } from "../services/dynamic-config-service.js";
import { SkillRevisionStore } from "../services/skills/skill-revision-store.js";
import { PersonalSkillStore } from "../services/skills/personal-skill-store.js";
import { ProjectSkillStore } from "../services/skills/project-skill-store.js";
import { ManagedToolCatalog } from "../services/managed-tools/catalog.js";
import { createTestConfig } from "../test-helpers/test-config.js";
import { buildSkillsLibraryFiles } from "../services/deep-agents/deep-agents-skills-library.js";
import * as crypto from "../lib/crypto-utils.js";
import type { FastifyBaseLogger } from "fastify";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedTenant, seedUser, seedMembership, seedSession } from "./support/fixtures.js";

const secret = "person-access-test-encryption-secret";
async function setup() {
  const tenantId = await seedTenant(), userId = await seedUser();
  await seedMembership(tenantId, userId);
  const stores = {
    skills: new SkillConfigStore(appPool()), mcpServers: new McpServerStore(appPool(), secret),
    tenantMembers: new TenantMemberStore(appPool()), tenantSettings: new TenantSettingsStore(appPool()),
    personalCapabilities: new PersonalCapabilityStore(appPool()),
    memberMcpCredentials: new MemberMcpCredentialStore(appPool(), secret)
  };
  return { tenantId, userId, stores, service: new PersonAccessService(stores) };
}
async function skill(tenantId: string, userId: string, options: {
  id?: string; enabled?: boolean; published?: boolean; instructions?: string; name?: string
} = {}) {
  const id = options.id ?? `skill-${randomUUID()}`;
  await superuserPool().query(`INSERT INTO admin_skills
    (tenant_id,skill_id,skill_name,enabled,is_published,created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
  [tenantId, id, options.name ?? id, options.enabled ?? true, options.published ?? true, userId]);
  const revision = await superuserPool().query(`INSERT INTO admin_skill_revisions
    (tenant_id,skill_id,revision_number,source_type,bundle_hash,metadata,created_by)
    VALUES ($1,$2,1,'inline','test-hash',$3::jsonb,$4) RETURNING skill_revision_id`,
  [tenantId, id, JSON.stringify({ instructions: options.instructions ?? "Follow these steps." }), userId]);
  await superuserPool().query("UPDATE admin_skills SET active_revision_id=$3 WHERE tenant_id=$1 AND skill_id=$2",
    [tenantId, id, revision.rows[0].skill_revision_id]);
  return id;
}
async function server(tenantId: string, userId: string, options: {
  id?: string; personal?: boolean; enabled?: boolean; published?: boolean; legacy?: boolean; managed?: boolean
} = {}) {
  const id = options.id ?? `server-${randomUUID()}`;
  await superuserPool().query(`INSERT INTO admin_mcp_servers
    (tenant_id,server_id,server_name,mode,route_path,upstream_url,upstream_auth_type,upstream_auth_name,
     credential_scope,config_hash,enabled,is_published,created_by)
    VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,'test-hash',$9,$10,$11)`,
  [tenantId, id, options.managed ? "managed" : "proxy", `/mcp/${id}`,
    options.legacy ? "https://vendor.example/mcp?api_key=private-legacy-key" : "https://vendor.example/mcp",
    options.legacy || !options.personal ? "none" : "header", options.personal && !options.legacy ? "X-API-Key" : null,
    options.personal ? "personal" : "organization", options.enabled ?? true, options.published ?? true, userId]);
  return id;
}
async function defaults(tenantId: string, userId: string, selection: SessionCapabilitySelection | null) {
  await superuserPool().query(`INSERT INTO personal_capability_defaults(tenant_id,user_id,capability_selection)
    VALUES ($1,$2,$3::jsonb) ON CONFLICT (tenant_id,user_id) DO UPDATE SET capability_selection=EXCLUDED.capability_selection`,
  [tenantId, userId, JSON.stringify(selection)]);
}
async function snapshot(tenantId: string) {
  const result: Record<string, unknown> = {};
  for (const table of ["tenant_settings", "admin_skills", "admin_mcp_servers", "member_mcp_credentials", "audit_events"]) {
    result[table] = (await superuserPool().query(`SELECT row_to_json(t) AS row FROM ${table} t WHERE tenant_id IN ($1,'system') ORDER BY row_to_json(t)::text`, [tenantId])).rows;
  }
  return result;
}
function runtime(f: Awaited<ReturnType<typeof setup>>) {
  return new DynamicConfigService(createTestConfig(), {
    ...f.stores, sessions: new SessionStore(appPool()),
    skillRevisions: new SkillRevisionStore(appPool(), f.stores.skills),
    personalSkills: new PersonalSkillStore(appPool()), projectSkills: new ProjectSkillStore(appPool())
  }, { storeBundle: async () => { throw new Error("Unexpected bundle write"); },
    deleteBundle: async () => { throw new Error("Unexpected bundle deletion"); } }, new ManagedToolCatalog());
}
async function parity(f: Awaited<ReturnType<typeof setup>>) {
  const preview = AdminPersonAccessResponseSchema.parse(await f.service.explain(f.tenantId, f.userId));
  const sessionId = await seedSession(f.tenantId, f.userId);
  const beta = await f.stores.tenantMembers.isUserBetaTester(f.tenantId, f.userId);
  const compiled = await runtime(f).compileRuntimeConfig(f.tenantId, beta, { sessionId, userId: f.userId });
  const files = await buildSkillsLibraryFiles({ skills: compiled.skills, logger: { warn: vi.fn() } as unknown as FastifyBaseLogger });
  const loadedSkills = compiled.skills.filter(row => row.instructions.trim());
  expect(Object.keys(files).filter(path => path.endsWith("/SKILL.md"))).toHaveLength(loadedSkills.length);
  expect(preview.items.filter(row => row.status === "included" && row.kind === "skill").map(row => row.id).sort())
    .toEqual(loadedSkills.map(row => row.id).sort());
  expect(preview.items.filter(row => row.status === "included" && row.kind === "connection").map(row => row.id).sort())
    .toEqual(compiled.mcpServers.map(row => row.id).sort());
  const sourceRows = await f.stores.skills.listSkills(f.tenantId, false, beta);
  for (const loaded of loadedSkills) {
    const source = sourceRows.find(row => row.skillId === loaded.id)!;
    expect(preview.items.find(row => row.id === loaded.id)).toMatchObject({ name: loaded.name,
      runtimeSource: source.isInherited ? "system" : "organization" });
    expect(compiled.sources.skills.find(row => row.id === loaded.id)).toMatchObject({ version: source.version, revisionId: source.activeRevisionId });
  }
  const serverRows = await f.stores.mcpServers.listMcpServers(f.tenantId, false, beta);
  for (const loaded of compiled.mcpServers) {
    const source = serverRows.find(row => row.serverId === loaded.id)!;
    expect(preview.items.find(row => row.id === loaded.id)).toMatchObject({ name: source.serverName,
      runtimeSource: source.ownerTenantId === "system" ? "system" : "organization" });
    expect(compiled.sources.mcpServers.find(row => row.id === loaded.id)).toMatchObject({ version: source.version, hash: source.configHash });
  }
  return preview;
}

describe.skipIf(!adminDatabaseUrl())("person access explanation", () => {
  test.each([false, true])("matches new chat runtime for test access %s, inherited/custom/empty defaults and blank instructions", async beta => {
    const f = await setup();
    const publicId = await skill(f.tenantId, f.userId);
    const testId = await skill(f.tenantId, f.userId, { published: false });
    const disabledId = await skill(f.tenantId, f.userId, { enabled: false });
    const blanks = await Promise.all(["", " \n\t", "\u00a0"].map(instructions => skill(f.tenantId, f.userId, { instructions })));
    const connection = await server(f.tenantId, f.userId);
    const testConnection = await server(f.tenantId, f.userId, { published: false });
    const denied = await server(f.tenantId, f.userId, { personal: true });
    await f.stores.tenantSettings.upsert(f.tenantId, { enabledMcpServerIds: [connection, testConnection] });
    await superuserPool().query("UPDATE tenant_memberships SET is_beta_tester=$3 WHERE tenant_id=$1 AND user_id=$2", [f.tenantId, f.userId, beta]);
    const initial = await parity(f);
    expect(initial.items.find(row => row.id === testId)?.status).toBe(beta ? "included" : "excluded");
    expect(initial.items.find(row => row.id === testConnection)?.status).toBe(beta ? "included" : "excluded");
    if (!beta) expect(initial.items.find(row => row.id === testConnection)?.gates[0].reason).toBe("test_users_only");
    expect(initial.items.find(row => row.id === disabledId)?.gates[0].reason).toBe("turned_off");
    for (const id of blanks) expect(initial.items.find(row => row.id === id)?.gates.at(-1)?.reason).toBe("no_instructions");
    expect(initial.items.find(row => row.id === denied)?.gates).toEqual([
      { gate: "visible_to_member", result: "pass" },
      { gate: "allowed_for_organization", result: "fail", reason: "not_allowed_for_organization" },
      { gate: "in_member_defaults", result: "not_checked" }, { gate: "personal_sign_in", result: "not_checked" }
    ]);
    await defaults(f.tenantId, f.userId, { skillIds: [publicId, "private-skill-id"], connectorIds: [connection, "private-connector-id"] });
    const custom = await parity(f);
    expect(JSON.stringify(custom)).not.toContain("private-skill-id");
    expect(JSON.stringify(custom)).not.toContain("private-connector-id");
    await defaults(f.tenantId, f.userId, { skillIds: [], connectorIds: [] });
    expect((await parity(f)).member.defaults).toBe("empty");
  });

  test("distinguishes missing and stale sign-in; does not decrypt or change settings on preview", async () => {
    const f = await setup();
    const id = await server(f.tenantId, f.userId, { personal: true });
    await f.stores.tenantSettings.upsert(f.tenantId, { enabledMcpServerIds: [id] });
    const missing = await parity(f);
    expect(missing.items.find(row => row.id === id)?.gates.at(-1)?.reason).toBe("member_not_connected");
    const record = (await f.stores.mcpServers.getAdminMcpServer(f.tenantId, id))!;
    await f.stores.memberMcpCredentials.save(f.tenantId, f.userId, id,
      { version: 0, serverVersion: record.version, secret: "private-member-secret", accountLabel: "Private account" });
    expect((await parity(f)).items.find(row => row.id === id)?.status).toBe("included");
    await superuserPool().query("UPDATE admin_mcp_servers SET credential_binding_id=$3 WHERE tenant_id=$1 AND server_id=$2", [f.tenantId, id, randomUUID()]);
    expect((await parity(f)).items.find(row => row.id === id)?.gates.at(-1)?.reason).toBe("member_must_reconnect");
    const before = await snapshot(f.tenantId);
    const decrypt = vi.spyOn(crypto, "decrypt"), encrypt = vi.spyOn(crypto, "encrypt"), fetch = vi.spyOn(globalThis, "fetch");
    try {
      const result = JSON.stringify(await f.service.explain(f.tenantId, f.userId));
      for (const value of ["private-member-secret", "Private account", "credentialBindingId", "credentialVersion", "upstreamUrl", "Follow these steps."]) {
        expect(result).not.toContain(value);
      }
      expect(decrypt).not.toHaveBeenCalled(); expect(encrypt).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
      expect(await snapshot(f.tenantId)).toEqual(before);
    } finally { vi.restoreAllMocks(); }
  });

  test.each(["disabled", "unpublished"])("preserves filter-before-precedence for %s tenant copies", async variant => {
    const f = await setup();
    const id = await skill("system", f.userId, { name: "System winner" });
    await skill(f.tenantId, f.userId, { id, name: "Tenant copy", enabled: variant !== "disabled", published: variant !== "unpublished" });
    const connection = await server("system", f.userId, { personal: true });
    await server(f.tenantId, f.userId, { id: connection, personal: true, enabled: variant !== "disabled", published: variant !== "unpublished" });
    await f.stores.tenantSettings.upsert(f.tenantId, { enabledMcpServerIds: [connection] });
    const result = await parity(f);
    expect(result.items.find(row => row.id === id)).toMatchObject({ name: "System winner", status: "included",
      runtimeSource: "system", adminPageSource: "organization" });
    expect(result.items.find(row => row.id === connection)).toMatchObject({ status: "excluded", runtimeSource: "system" });
  });

  test("does not migrate legacy organization credentials on tenant or system rows", async () => {
    const f = await setup();
    const ids: string[] = [];
    for (const tenant of [f.tenantId, "system"]) {
      ids.push(await server(tenant, f.userId, { legacy: true }));
    }
    await f.stores.tenantSettings.upsert(f.tenantId, { enabledMcpServerIds: ids });
    const before = await snapshot(f.tenantId);
    const encrypt = vi.spyOn(crypto, "encrypt");
    try {
      const result = AdminPersonAccessResponseSchema.parse(await f.service.explain(f.tenantId, f.userId));
      for (const id of ids) expect(result.items.find(row => row.id === id)?.status).toBe("included");
      expect(JSON.stringify(result)).not.toContain("private-legacy-key");
      expect(encrypt).not.toHaveBeenCalled();
      expect(await snapshot(f.tenantId)).toEqual(before);
    } finally { vi.restoreAllMocks(); }
  });

  test("fails the lookup when visible legacy auth would prevent runtime compilation, even off the allowlist", async () => {
    const f = await setup();
    const id = await server(f.tenantId, f.userId, { legacy: true });
    await superuserPool().query("UPDATE admin_mcp_servers SET upstream_url=$3 WHERE tenant_id=$1 AND server_id=$2",
      [f.tenantId, id, "https://vendor.example/mcp?api_key=private-one&token=private-two"]);
    await f.stores.tenantSettings.upsert(f.tenantId, { enabledMcpServerIds: [] });
    const before = await snapshot(f.tenantId);
    await expect(f.service.explain(f.tenantId, f.userId)).rejects.toThrow("multiple credential-like query parameters");
    expect(await snapshot(f.tenantId)).toEqual(before);
    const sessionId = await seedSession(f.tenantId, f.userId);
    await expect(runtime(f).compileRuntimeConfig(f.tenantId, false, { sessionId, userId: f.userId }))
      .rejects.toThrow("multiple credential-like query parameters");
  });

  test("the database rejects managed personal connections and unauthenticated personal legacy rows", async () => {
    const f = await setup();
    for (const options of [{ personal: true, managed: true }, { personal: true, legacy: true }]) {
      await expect(server(f.tenantId, f.userId, options)).rejects.toMatchObject({
        constraint: "admin_mcp_servers_personal_scope_check"
      });
    }
  });

  test("does not create tenant settings and hides other tenants and removed members", async () => {
    const f = await setup(), other = await setup();
    const otherSkill = await skill(other.tenantId, other.userId);
    expect(await f.stores.tenantSettings.get(f.tenantId)).toBeNull();
    await server(f.tenantId, f.userId, { id: "managed-session-context", managed: true });
    const result = await f.service.explain(f.tenantId, f.userId);
    expect(result.items.some(row => row.id === otherSkill)).toBe(false);
    expect(result.items.find(row => row.id === "managed-session-context")?.status).toBe("included");
    expect(await f.stores.tenantSettings.get(f.tenantId)).toBeNull();
    await parity(f);
    await expect(f.service.explain(f.tenantId, other.userId)).rejects.toBeInstanceOf(PersonAccessMemberNotFound);
    await superuserPool().query("DELETE FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2", [f.tenantId, f.userId]);
    await expect(f.service.explain(f.tenantId, f.userId)).rejects.toBeInstanceOf(PersonAccessMemberNotFound);
  });
});
