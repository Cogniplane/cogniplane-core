import { describe, expect, test } from "vitest";

import { createTestConfig } from "../test-helpers/test-config.js";
import { testRuntimePolicy } from "../test-helpers/test-runtime-policy.js";
import { DynamicConfigService } from "../services/dynamic-config-service.js";
import { ManagedToolCatalog } from "../services/managed-tools/catalog.js";
import { ProjectStore } from "../services/project-store.js";
import { SessionStore } from "../services/session-store.js";
import { PersonalSkillStore } from "../services/skills/personal-skill-store.js";
import { ProjectSkillStore } from "../services/skills/project-skill-store.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedMembership, seedSession, seedTenant, seedUser } from "./support/fixtures.js";

function runtimeConfig(sessions = new SessionStore(appPool())) {
  const stores = {
    sessions,
    personalSkills: new PersonalSkillStore(appPool()),
    projectSkills: new ProjectSkillStore(appPool()),
    skills: { async listSkills() { return []; } },
    mcpServers: { async listMcpServers() { return []; } }
  } as unknown as ConstructorParameters<typeof DynamicConfigService>[1];
  const service = new DynamicConfigService(createTestConfig(), stores,
    { async storeBundle() { throw new Error("unused"); }, async deleteBundle() {} }, new ManagedToolCatalog());
  service.getRuntimePolicy = async () => testRuntimePolicy;
  return service;
}
const ids = async (service: DynamicConfigService, tenantId: string, sessionId: string, userId: string) =>
  (await service.compileRuntimeConfig(tenantId, false, { sessionId, userId })).skills.map(skill => skill.id);

describe.skipIf(!adminDatabaseUrl())("project skills runtime isolation", () => {
  test("only the current project's released skills reach its executing members", async () => {
    const tenant = await seedTenant(), otherTenant = await seedTenant();
    const owner = await seedUser(), editor = await seedUser(), viewer = await seedUser();
    for (const user of [owner, editor, viewer]) await seedMembership(tenant, user);
    await seedMembership(otherTenant, owner);
    const projects = new ProjectStore(appPool()), skills = new ProjectSkillStore(appPool());
    const personal = new PersonalSkillStore(appPool()), service = runtimeConfig();
    const project = (await projects.create(tenant, owner, "Research")).projectId;
    const otherProject = (await projects.create(tenant, owner, "Other")).projectId;
    for (const [user, role] of [[editor, "editor"], [viewer, "viewer"]] as const) {
      await superuserPool().query("INSERT INTO project_memberships (tenant_id,project_id,user_id,role) VALUES ($1,$2,$3,$4)",
        [tenant, project, user, role]);
    }
    const chat = (await projects.createSession(tenant, owner, project, "Chat"))!;
    const otherChat = (await projects.createSession(tenant, owner, otherProject, "Other chat"))!;
    const internal = (await projects.createSession(tenant, owner, project, "Improver"))!;
    await superuserPool().query("UPDATE sessions SET purpose='skill_improvement' WHERE session_id=$1", [internal]);
    const standalone = await seedSession(tenant, owner);
    const otherTenantChat = await seedSession(otherTenant, owner);

    const privateSkill = await personal.create(tenant, owner, { kind: "inline", name: "private-notes",
      description: "Private", instructions: "Private instructions." });
    await personal.action(tenant, owner, privateSkill.id, "release", 1);
    const created = await skills.create(tenant, owner, project, { kind: "inline", name: "shared-notes",
      description: "Shared", instructions: "Shared instructions." });
    expect(await ids(service, tenant, chat, owner)).toEqual([]);
    const released = await skills.action(tenant, owner, project, created.id, "release", created.version);

    const bundle = await service.compileRuntimeConfig(tenant, false, { sessionId: chat, userId: owner });
    expect(bundle.skills.map(skill => [skill.id, skill.sourceType, skill.instructions]))
      .toEqual([[created.id, "project", "Shared instructions."]]);
    expect(bundle.skills[0]?.associatedToolIds).toEqual([]);
    expect(bundle.runtimePolicy).toEqual((await service.compileRuntimeConfig(tenant, false)).runtimePolicy);
    expect(await ids(service, tenant, chat, editor)).toEqual([created.id]);
    expect(await ids(service, tenant, chat, viewer)).toEqual([]);
    expect(await ids(service, tenant, otherChat, owner)).toEqual([]);
    expect(await ids(service, tenant, internal, owner)).toEqual([]);
    expect(await ids(service, tenant, standalone, owner)).toEqual([privateSkill.id]);
    expect(await ids(service, otherTenant, otherTenantChat, owner)).toEqual([]);
    expect((await service.compileProjectCatalog(tenant, false, project, owner)).skills.map(skill => skill.id)).toEqual([created.id]);
    expect((await service.compileProjectCatalog(tenant, false, otherProject, owner)).skills).toEqual([]);
    expect((await service.compilePersonalCatalog(tenant, false, owner)).skills.map(skill => skill.id)).toEqual([privateSkill.id]);

    await superuserPool().query("UPDATE project_memberships SET role='viewer' WHERE tenant_id=$1 AND project_id=$2 AND user_id=$3",
      [tenant, project, editor]);
    expect(await ids(service, tenant, chat, editor)).toEqual([]);

    const setSession = (selection: unknown) => superuserPool().query(
      "UPDATE sessions SET capability_selection=$2::jsonb WHERE session_id=$1", [chat, selection === null ? null : JSON.stringify(selection)]);
    await setSession({ skillIds: [], connectorIds: [] });
    expect(await ids(service, tenant, chat, owner)).toEqual([]);
    await setSession({ skillIds: [created.id, privateSkill.id], connectorIds: [] });
    expect(await ids(service, tenant, chat, owner)).toEqual([created.id]);
    await setSession(null);
    expect(await projects.setCapabilities(tenant, owner, project, { selection: { skillIds: [], connectorIds: [] }, version: 0 })).toBe(true);
    expect(await ids(service, tenant, chat, owner)).toEqual([]);
    expect(await projects.setCapabilities(tenant, owner, project, { selection: null, version: 1 })).toBe(true);

    const drafted = await skills.update(tenant, owner, project, created.id, { kind: "inline", name: "shared-notes",
      description: "Shared", instructions: "Draft instructions." }, released.version);
    expect((await service.compileRuntimeConfig(tenant, false, { sessionId: chat, userId: owner })).hash).toBe(bundle.hash);
    const rereleased = await skills.action(tenant, owner, project, created.id, "release", drafted.version);
    const next = await service.compileRuntimeConfig(tenant, false, { sessionId: chat, userId: owner });
    expect(next.hash).not.toBe(bundle.hash);
    expect(next.skills[0]?.instructions).toBe("Draft instructions.");
    await skills.action(tenant, owner, project, created.id, "disable", rereleased.version);
    expect(await ids(service, tenant, chat, owner)).toEqual([]);
    expect((await service.compileProjectCatalog(tenant, false, project, owner)).skills).toEqual([]);
  });
  test("rechecks membership in the skill query after catalog or runtime access was read", async () => {
    const tenant = await seedTenant(), owner = await seedUser(), member = await seedUser();
    await seedMembership(tenant, owner);
    await seedMembership(tenant, member);
    const projects = new ProjectStore(appPool()), skills = new ProjectSkillStore(appPool());
    const project = (await projects.create(tenant, owner, "Revocation")).projectId;
    await superuserPool().query("INSERT INTO project_memberships (tenant_id,project_id,user_id,role) VALUES ($1,$2,$3,'editor')",
      [tenant, project, member]);
    const chat = (await projects.createSession(tenant, owner, project, "Chat"))!;
    const created = await skills.create(tenant, owner, project, { kind: "inline", name: "private-project-notes",
      description: "Project information", instructions: "Instructions only for current members." });
    await skills.action(tenant, owner, project, created.id, "release", 1);
    expect((await skills.listRuntimeSkills(tenant, project, member, true)).map(skill => skill.id)).toEqual([created.id]);

    const sessions = new SessionStore(appPool());
    const readContext = sessions.getRuntimeCapabilities.bind(sessions);
    sessions.getRuntimeCapabilities = async (...args) => {
      const context = await readContext(...args);
      expect(context.projectId).toBe(project);
      await superuserPool().query("UPDATE project_memberships SET role='viewer' WHERE tenant_id=$1 AND project_id=$2 AND user_id=$3",
        [tenant, project, member]);
      return context;
    };
    // Demotion lands after runtime authorization, before released content is read.
    expect(await ids(runtimeConfig(sessions), tenant, chat, member)).toEqual([]);
    expect((await runtimeConfig().compileProjectCatalog(tenant, false, project, member)).skills.map(skill => skill.id))
      .toEqual([created.id]);
    await projects.getCapabilities(tenant, member, project);
    await superuserPool().query("DELETE FROM project_memberships WHERE tenant_id=$1 AND project_id=$2 AND user_id=$3",
      [tenant, project, member]);
    expect((await runtimeConfig().compileProjectCatalog(tenant, false, project, member)).skills).toEqual([]);
    expect(await skills.listRuntimeSkills(tenant, project, member, true)).toEqual([]);
    // Organization-wide membership removal also closes an otherwise inherited project role.
    await superuserPool().query("UPDATE projects SET visibility='organization', organization_role='editor' WHERE tenant_id=$1 AND project_id=$2",
      [tenant, project]);
    expect((await skills.listRuntimeSkills(tenant, project, member, true)).map(skill => skill.id)).toEqual([created.id]);
    await superuserPool().query("DELETE FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2", [tenant, member]);
    expect(await skills.listRuntimeSkills(tenant, project, member, true)).toEqual([]);
  });

});
