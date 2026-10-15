import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";

import { createTestConfig } from "../test-helpers/test-config.js";
import { testRuntimePolicy } from "../test-helpers/test-runtime-policy.js";
import { createSilentLogger } from "../test-helpers/silent-logger.js";
import { DynamicConfigService } from "../services/dynamic-config-service.js";
import { buildSkillsLibraryFiles } from "../services/deep-agents/deep-agents-skills-library.js";
import { ManagedToolCatalog } from "../services/managed-tools/catalog.js";
import { SessionStore } from "../services/session-store.js";
import { PersonalSkillStore } from "../services/skills/personal-skill-store.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedMembership, seedSession, seedTenant, seedUser } from "./support/fixtures.js";

function runtimeConfig(sessions: SessionStore, personalSkills: PersonalSkillStore) {
  const stores = {
    sessions, personalSkills,
    skills: { async listSkills() { return []; } },
    mcpServers: { async listMcpServers() { return []; } }
  } as unknown as ConstructorParameters<typeof DynamicConfigService>[1];
  const service = new DynamicConfigService(createTestConfig(), stores,
    { async storeBundle() { throw new Error("unused"); }, async deleteBundle() {} }, new ManagedToolCatalog());
  service.getRuntimePolicy = async () => testRuntimePolicy;
  return service;
}

describe.skipIf(!adminDatabaseUrl())("personal skills runtime isolation", () => {
  test("only released skills reach the owner's standalone runtime", async () => {
    const tenant = await seedTenant(), otherTenant = await seedTenant();
    const owner = await seedUser(), colleague = await seedUser();
    await Promise.all([seedMembership(tenant, owner), seedMembership(tenant, colleague),
      seedMembership(otherTenant, owner)]);
    const standalone = await seedSession(tenant, owner);
    const colleagueSession = await seedSession(tenant, colleague);
    const scheduled = await seedSession(tenant, owner);
    const internal = await seedSession(tenant, owner);
    const otherTenantSession = await seedSession(otherTenant, owner);
    await superuserPool().query("UPDATE sessions SET purpose='scheduled' WHERE session_id=$1", [scheduled]);
    await superuserPool().query("UPDATE sessions SET purpose='skill_improvement' WHERE session_id=$1", [internal]);
    const personal = new PersonalSkillStore(appPool());
    const service = runtimeConfig(new SessionStore(appPool()), personal);
    const created = await personal.create(tenant, owner, { kind: "inline", name: "my-notes",
      description: "Private notes", instructions: "Use private instructions." });
    const session = { sessionId: standalone, userId: owner };
    expect((await service.compileRuntimeConfig(tenant, false, session)).skills).toEqual([]);
    const released = await personal.action(tenant, owner, created.id, "release", created.version);
    const active = await service.compileRuntimeConfig(tenant, false, session);
    expect(active.skills.map(skill => skill.id)).toEqual([created.id]);
    expect(active.skills[0]?.instructions).toBe("Use private instructions.");
    expect(active.runtimePolicy).toEqual((await service.compileRuntimeConfig(tenant, false)).runtimePolicy);
    const files = await buildSkillsLibraryFiles({ skills: active.skills, logger: createSilentLogger() });
    expect(Object.keys(files)).toEqual(["/my-notes/SKILL.md"]);
    expect(files["/my-notes/SKILL.md"]?.content).toContain("Use private instructions.");
    expect((await service.compileRuntimeConfig(tenant, false)).skills).toEqual([]);
    expect((await service.compilePersonalCatalog(tenant, false, colleague)).skills).toEqual([]);
    expect((await service.compileRuntimeConfig(tenant, false,
      { sessionId: colleagueSession, userId: colleague })).skills).toEqual([]);
    expect((await service.compileRuntimeConfig(otherTenant, false,
      { sessionId: otherTenantSession, userId: owner })).skills).toEqual([]);
    expect((await service.compileRuntimeConfig(tenant, false,
      { sessionId: scheduled, userId: owner })).skills).toEqual([]);
    expect((await service.compileRuntimeConfig(tenant, false,
      { sessionId: internal, userId: owner })).skills).toEqual([]);

    const colleagueSkill = await personal.create(tenant, colleague, { kind: "inline", name: "colleague-notes",
      description: "Colleague notes", instructions: "Keep private." });
    await personal.action(tenant, colleague, colleagueSkill.id, "release", colleagueSkill.version);
    await superuserPool().query("UPDATE sessions SET capability_selection=$2::jsonb WHERE session_id=$1",
      [standalone, JSON.stringify({ skillIds: [colleagueSkill.id], connectorIds: [] })]);
    expect((await service.compileRuntimeConfig(tenant, false, session)).skills).toEqual([]);
    await superuserPool().query("UPDATE sessions SET capability_selection=NULL WHERE session_id=$1", [standalone]);

    const drafted = await personal.update(tenant, owner, created.id, { kind: "inline", name: "my-notes",
      description: "Private notes", instructions: "Draft instructions." }, released.version);
    expect((await service.compileRuntimeConfig(tenant, false, session)).hash).toBe(active.hash);
    const rereleased = await personal.action(tenant, owner, created.id, "release", drafted.version);
    const next = await service.compileRuntimeConfig(tenant, false, session);
    expect(next.hash).not.toBe(active.hash);
    expect(next.skills[0]?.instructions).toBe("Draft instructions.");

    await superuserPool().query("INSERT INTO personal_capability_defaults (tenant_id,user_id,capability_selection) VALUES ($1,$2,$3::jsonb)",
      [tenant, owner, JSON.stringify({ skillIds: [], connectorIds: [] })]);
    expect((await service.compileRuntimeConfig(tenant, false, session)).skills).toEqual([]);
    await superuserPool().query("UPDATE personal_capability_defaults SET capability_selection=NULL WHERE tenant_id=$1 AND user_id=$2",
      [tenant, owner]);
    const projectId = `project_${randomUUID()}`;
    await superuserPool().query("INSERT INTO projects (project_id,tenant_id,user_id,name) VALUES ($1,$2,$3,'Shared')",
      [projectId, tenant, owner]);
    await superuserPool().query("INSERT INTO project_memberships (tenant_id,project_id,user_id,role) VALUES ($1,$2,$3,'owner')",
      [tenant, projectId, owner]);
    await superuserPool().query("UPDATE sessions SET project_id=$2 WHERE session_id=$1", [standalone, projectId]);
    expect((await service.compileRuntimeConfig(tenant, false, session)).skills).toEqual([]);
    expect((await service.compileRuntimeConfig(tenant, false, session)).hash).not.toBe(next.hash);

    const disabled = await personal.action(tenant, owner, created.id, "disable", rereleased.version);
    expect(disabled.enabled).toBe(false);
    expect((await service.compilePersonalCatalog(tenant, false, owner)).skills).toEqual([]);
  });
});
