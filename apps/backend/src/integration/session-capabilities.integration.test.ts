import { describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { SessionStore } from "../services/session-store.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedTenant, seedUser, seedMembership, seedSession, seedRuntimeSession, seedApproval, seedStreamingMessage } from "./support/fixtures.js";

describe.skipIf(!adminDatabaseUrl())("session capability persistence", () => {
  test("personal defaults follow the session owner and only normal standalone chats", async () => {
    const tenant = await seedTenant(), otherTenant = await seedTenant();
    const owner = await seedUser(), colleague = await seedUser();
    await Promise.all([seedMembership(tenant, owner), seedMembership(tenant, colleague),
      seedMembership(otherTenant, owner)]);
    const ownerSession = await seedSession(tenant, owner);
    const colleagueSession = await seedSession(tenant, colleague);
    const otherTenantSession = await seedSession(otherTenant, owner);
    const scheduled = await seedSession(tenant, owner);
    const skillImprovement = await seedSession(tenant, owner);
    await superuserPool().query("UPDATE sessions SET purpose='scheduled' WHERE session_id=$1", [scheduled]);
    await superuserPool().query("UPDATE sessions SET purpose='skill_improvement' WHERE session_id=$1", [skillImprovement]);
    const ownerDefaults = { skillIds: ["pdf"], connectorIds: [] };
    const colleagueDefaults = { skillIds: [], connectorIds: ["docs"] };
    const empty = { skillIds: [], connectorIds: [] };
    for (const [tenantId, userId, selection] of [
      [tenant, owner, ownerDefaults], [tenant, colleague, colleagueDefaults], [otherTenant, owner, empty]
    ] as const) {
      await superuserPool().query(
        "INSERT INTO personal_capability_defaults (tenant_id,user_id,capability_selection) VALUES ($1,$2,$3::jsonb)",
        [tenantId, userId, JSON.stringify(selection)]
      );
    }
    const store = new SessionStore(appPool());
    expect(await store.getCapabilitySelection(tenant, ownerSession, owner)).toEqual(ownerDefaults);
    expect(await store.getCapabilitySelection(tenant, colleagueSession, colleague)).toEqual(colleagueDefaults);
    expect(await store.getCapabilitySelection(otherTenant, otherTenantSession, owner)).toEqual(empty);
    expect(await store.getCapabilitySelection(tenant, scheduled, owner)).toBeNull();
    expect(await store.getCapabilitySelection(tenant, skillImprovement, owner)).toBeNull();
    expect(await store.getCapabilities(tenant, ownerSession, owner)).toMatchObject({
      defaultsSource: "personal", defaultsSelection: ownerDefaults, personalUserId: owner
    });
    expect(await store.getCapabilities(tenant, scheduled, owner)).toMatchObject({
      defaultsSource: "organization", defaultsSelection: null, personalUserId: null
    });
    expect(await store.getCapabilities(tenant, skillImprovement, owner)).toMatchObject({
      defaultsSource: "organization", defaultsSelection: null, personalUserId: null
    });
    await superuserPool().query(
      "UPDATE personal_capability_defaults SET capability_selection=NULL WHERE tenant_id=$1 AND user_id=$2",
      [tenant, owner]
    );
    expect(await store.getCapabilitySelection(tenant, ownerSession, owner)).toBeNull();
    expect(await store.getCapabilities(tenant, ownerSession, owner)).toMatchObject({
      defaultsSource: "personal", defaultsSelection: null
    });
    await superuserPool().query(
      "UPDATE personal_capability_defaults SET capability_selection=$3::jsonb WHERE tenant_id=$1 AND user_id=$2",
      [tenant, owner, JSON.stringify(ownerDefaults)]
    );
    const projectId = `project_${randomUUID()}`;
    await superuserPool().query("INSERT INTO projects (project_id,tenant_id,user_id,name,capability_selection) VALUES ($1,$2,$3,'Attached',$4::jsonb)",
      [projectId, tenant, owner, JSON.stringify(colleagueDefaults)]);
    await superuserPool().query(
      "INSERT INTO project_memberships (tenant_id,project_id,user_id,role) VALUES ($1,$2,$3,'owner')",
      [tenant, projectId, owner]);
    await superuserPool().query("UPDATE sessions SET project_id=$2 WHERE session_id=$1", [ownerSession, projectId]);
    expect(await store.getCapabilitySelection(tenant, ownerSession, owner)).toEqual(colleagueDefaults);
    expect(await store.getCapabilities(tenant, ownerSession, owner)).toMatchObject({
      defaultsSource: "project", defaultsSelection: colleagueDefaults, personalUserId: null
    });
    await superuserPool().query("UPDATE sessions SET project_id=NULL WHERE session_id=$1", [ownerSession]);
    expect(await store.getCapabilitySelection(tenant, ownerSession, owner)).toEqual(ownerDefaults);
  });

  test("personal caps restrict new additions while saved references remain removable", async () => {
    const tenant = await seedTenant(), owner = await seedUser();
    await seedMembership(tenant, owner);
    const sessionId = await seedSession(tenant, owner);
    const saved = { skillIds: ["retired"], connectorIds: ["disabled"] };
    const defaults = { skillIds: ["pdf"], connectorIds: ["docs"] };
    const catalog = { skillIds: ["pdf", "other"], connectorIds: ["docs", "other"] };
    await superuserPool().query("UPDATE sessions SET capability_selection=$2::jsonb WHERE session_id=$1",
      [sessionId, JSON.stringify(saved)]);
    await superuserPool().query(
      "INSERT INTO personal_capability_defaults (tenant_id,user_id,capability_selection) VALUES ($1,$2,$3::jsonb)",
      [tenant, owner, JSON.stringify(defaults)]
    );
    const store = new SessionStore(appPool());
    const retained = { skillIds: ["retired", "pdf"], connectorIds: ["disabled", "docs"] };
    expect(await store.setCapabilities(tenant, sessionId, owner, { selection: retained, version: 0 }, catalog)).toBe(true);
    expect(await store.getCapabilitySelection(tenant, sessionId, owner)).toEqual(defaults);
    expect(await store.setCapabilities(tenant, sessionId, owner, { selection: {
      skillIds: ["retired", "other"], connectorIds: ["disabled", "docs"] }, version: 1 }, catalog)).toBe(false);
    expect(await store.setCapabilities(tenant, sessionId, owner, { selection: defaults, version: 1 }, catalog)).toBe(true);
    expect(await store.setCapabilities(tenant, sessionId, owner, { selection: retained, version: 1 }, catalog)).toBe(false);
    expect(await store.setCapabilities(tenant, sessionId, owner, { selection: retained, version: 2 }, catalog)).toBe(false);
    await superuserPool().query(
      "UPDATE personal_capability_defaults SET capability_selection=$3::jsonb WHERE tenant_id=$1 AND user_id=$2",
      [tenant, owner, JSON.stringify({ skillIds: [], connectorIds: [] })]
    );
    expect(await store.getCapabilitySelection(tenant, sessionId, owner)).toEqual({ skillIds: [], connectorIds: [] });
    expect((await store.getCapabilities(tenant, sessionId, owner)).selection).toEqual(defaults);
    expect(await store.setCapabilities(tenant, sessionId, owner, { selection: {
      skillIds: ["pdf", "other"], connectorIds: ["docs"] }, version: 2 }, catalog)).toBe(false);
    expect(await store.setCapabilities(tenant, sessionId, owner, { selection: defaults, version: 2 }, catalog)).toBe(true);
  });

  test("project chats inherit organization defaults when the owner has narrower personal defaults", async () => {
    const tenant = await seedTenant(), owner = await seedUser();
    await seedMembership(tenant, owner);
    const standalone = await seedSession(tenant, owner);
    const projectSession = await seedSession(tenant, owner);
    const projectId = `project_${randomUUID()}`;
    await superuserPool().query(
      "INSERT INTO projects (project_id,tenant_id,user_id,name) VALUES ($1,$2,$3,'Inherited capabilities')",
      [projectId, tenant, owner]
    );
    await superuserPool().query(
      "INSERT INTO project_memberships (tenant_id,project_id,user_id,role) VALUES ($1,$2,$3,'owner')",
      [tenant, projectId, owner]
    );
    await superuserPool().query("UPDATE sessions SET project_id=$2 WHERE session_id=$1", [projectSession, projectId]);
    const personal = { skillIds: ["pdf"], connectorIds: ["docs"] };
    const organization = { skillIds: ["pdf", "other"], connectorIds: ["docs", "other"] };
    await superuserPool().query(
      "INSERT INTO personal_capability_defaults (tenant_id,user_id,capability_selection) VALUES ($1,$2,$3::jsonb)",
      [tenant, owner, JSON.stringify(personal)]
    );

    const store = new SessionStore(appPool());
    expect(await store.getCapabilitySelection(tenant, standalone, owner)).toEqual(personal);
    expect(await store.getCapabilitySelection(tenant, projectSession, owner)).toBeNull();
    expect(await store.getCapabilities(tenant, projectSession, owner)).toMatchObject({
      selection: null, defaultsSource: "project", defaultsSelection: null, canEdit: true
    });
    const outsidePersonal = { skillIds: ["other"], connectorIds: ["other"] };
    expect(await store.setCapabilities(tenant, standalone, owner,
      { selection: outsidePersonal, version: 0 }, organization)).toBe(false);
    expect(await store.setCapabilities(tenant, projectSession, owner,
      { selection: outsidePersonal, version: 0 }, organization)).toBe(true);
    expect(await store.getCapabilitySelection(tenant, projectSession, owner)).toEqual(outsidePersonal);
    expect(await store.getCapabilities(tenant, projectSession, owner)).toMatchObject({
      selection: outsidePersonal, defaultsSource: "project", defaultsSelection: null, version: 1
    });
    expect(await store.setCapabilities(tenant, projectSession, owner,
      { selection: null, version: 1 }, organization)).toBe(true);
    expect(await store.getCapabilitySelection(tenant, projectSession, owner)).toBeNull();
  });
  test("persists choices and defaults, enforces ownership and isolates tenants", async () => {
    const tenant = await seedTenant(), foreignTenant = await seedTenant();
    const user = await seedUser(), foreignUser = await seedUser();
    const id = await seedSession(tenant, user);
    const store = new SessionStore(appPool());
    expect(await store.getCapabilities(tenant, id, user)).toEqual({ selection: null, version: 0,
      canEdit: true, defaultsSource: "personal", defaultsSelection: null, personalUserId: user, projectId: null });
    await expect(store.getCapabilities(tenant, id, foreignUser)).rejects.toThrow("Session not found");
    await expect(store.getCapabilitySelection(tenant, id, foreignUser)).rejects.toThrow("Session not found");
    await expect(store.getCapabilitySelection(foreignTenant, id, user)).rejects.toThrow("Session not found");
    expect(await store.getCapabilitySelection(tenant, id, user)).toBeNull();
    const selection = { skillIds: ["pdf"], connectorIds: [] };
    expect(await store.setCapabilities(foreignTenant, id, user, { selection, version: 0 })).toBe(false);
    expect(await store.setCapabilities(tenant, id, foreignUser, { selection, version: 0 })).toBe(false);
    await expect(store.getCapabilities(foreignTenant, id, user)).rejects.toThrow("Session not found");
    expect(await store.setCapabilities(tenant, id, user, { selection, version: 0 })).toBe(true);
    expect(await store.getCapabilitySelection(tenant, id, user)).toEqual(selection);
    expect(await new SessionStore(appPool()).getCapabilities(tenant, id, user)).toEqual({ selection, version: 1,
      canEdit: true, defaultsSource: "personal", defaultsSelection: null, personalUserId: user, projectId: null });
    expect(await store.setCapabilities(tenant, id, user, { selection: null, version: 0 })).toBe(false);
    const results = await Promise.all([
      store.setCapabilities(tenant, id, user, { selection: null, version: 1 }),
      store.setCapabilities(tenant, id, user, { selection: { skillIds: [], connectorIds: [] }, version: 1 })
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect(await store.setCapabilities(tenant, id, user, { selection: null, version: 2 })).toBe(true);
    expect((await store.getCapabilities(tenant, id, user)).selection).toBeNull();
    await store.setArchived(tenant, id, user, true);
    expect(await store.setCapabilities(tenant, id, user, { selection, version: 3 })).toBe(false);
  });

  test("project defaults narrow session overrides and follow current membership", async () => {
    const tenant = await seedTenant(), otherTenant = await seedTenant();
    const owner = await seedUser(), editor = await seedUser(), outsider = await seedUser();
    await Promise.all([seedMembership(tenant, owner), seedMembership(tenant, editor),
      seedMembership(tenant, outsider), seedMembership(otherTenant, owner)]);
    const id = await seedSession(tenant, owner);
    const attachedId = await seedSession(tenant, owner);
    await superuserPool().query("UPDATE sessions SET capability_selection=$2::jsonb WHERE session_id=$1",
      [attachedId, JSON.stringify({ skillIds: ["pdf", "other"], connectorIds: ["docs", "other"] })]);
    const projectId = `project_${randomUUID()}`;
    await superuserPool().query(
      "INSERT INTO projects (project_id,tenant_id,user_id,name) VALUES ($1,$2,$3,'Capabilities')",
      [projectId, tenant, owner]
    );
    await superuserPool().query(
      "INSERT INTO project_memberships (tenant_id,project_id,user_id,role) VALUES ($1,$2,$3,'owner'),($1,$2,$4,'editor')",
      [tenant, projectId, owner, editor]
    );
    const project = { skillIds: ["pdf"], connectorIds: ["docs"] };
    await superuserPool().query("UPDATE projects SET capability_selection=$2::jsonb WHERE project_id=$1",
      [projectId, JSON.stringify(project)]);
    await superuserPool().query("UPDATE sessions SET project_id=$2 WHERE session_id=$1", [id, projectId]);
    await superuserPool().query("UPDATE sessions SET project_id=$2 WHERE session_id=$1", [attachedId, projectId]);
    const store = new SessionStore(appPool());
    expect(await store.getCapabilitySelection(tenant, attachedId, editor)).toEqual(project);
    expect((await store.getCapabilities(tenant, attachedId, editor)).selection).toEqual({
      skillIds: ["pdf", "other"], connectorIds: ["docs", "other"]
    });
    expect(await store.getCapabilitySelection(tenant, id, editor)).toEqual(project);
    expect(await store.getCapabilities(tenant, id, editor)).toMatchObject({ selection: null,
      defaultsSource: "project", defaultsSelection: project, canEdit: true, personalUserId: null, projectId });
    expect(await store.setCapabilities(tenant, id, editor, { selection: {
      skillIds: ["other"], connectorIds: [] }, version: 0 })).toBe(false);
    expect(await store.setCapabilities(tenant, id, editor, { selection: {
      skillIds: ["pdf"], connectorIds: [] }, version: 0 })).toBe(true);
    expect(await store.getCapabilitySelection(tenant, id, editor)).toEqual({ skillIds: ["pdf"], connectorIds: [] });
    await superuserPool().query("UPDATE projects SET capability_selection=$2::jsonb WHERE project_id=$1",
      [projectId, JSON.stringify({ skillIds: [], connectorIds: ["docs"] })]);
    expect(await store.getCapabilitySelection(tenant, id, editor)).toEqual({ skillIds: [], connectorIds: [] });
    expect((await store.getCapabilities(tenant, id, editor)).selection).toEqual({ skillIds: ["pdf"], connectorIds: [] });
    expect(await store.setCapabilities(tenant, id, editor, { selection: null, version: 1 })).toBe(true);
    expect(await store.getCapabilitySelection(tenant, id, editor)).toEqual({ skillIds: [], connectorIds: ["docs"] });
    await superuserPool().query("UPDATE projects SET capability_selection=NULL WHERE project_id=$1", [projectId]);
    expect(await store.getCapabilitySelection(tenant, id, editor)).toBeNull();
    await superuserPool().query("DELETE FROM project_memberships WHERE project_id=$1 AND user_id=$2", [projectId, editor]);
    await expect(store.getCapabilitySelection(tenant, id, editor)).rejects.toThrow("Session not found");
    await expect(store.getCapabilitySelection(otherTenant, id, owner)).rejects.toThrow("Session not found");
    await expect(store.getCapabilitySelection(tenant, id, outsider)).rejects.toThrow("Session not found");
  });

  test("pending approvals and streaming turns lock changes", async () => {
    const tenant = await seedTenant(), user = await seedUser();
    const id = await seedSession(tenant, user), runtimeId = await seedRuntimeSession(tenant, user, id);
    const store = new SessionStore(appPool());
    const approval = await seedApproval({ tenantId: tenant, userId: user, sessionId: id, runtimeId });
    const update = { selection: { skillIds: [], connectorIds: [] }, version: 0 };
    expect((await store.getCapabilities(tenant, id, user)).canEdit).toBe(false);
    expect(await store.setCapabilities(tenant, id, user, update)).toBe(false);
    await superuserPool().query("UPDATE approvals SET status = 'approved' WHERE approval_id = $1", [approval]);
    const message = await seedStreamingMessage(tenant, user, id);
    expect((await store.getCapabilities(tenant, id, user)).canEdit).toBe(false);
    expect(await store.setCapabilities(tenant, id, user, update)).toBe(false);
    await superuserPool().query("UPDATE messages SET status = 'completed' WHERE message_id = $1", [message]);
    expect(await store.setCapabilities(tenant, id, user, update)).toBe(true);
  });

  test("retains saved IDs after the project cap changes but rejects new unavailable IDs", async () => {
    const tenant = await seedTenant(), owner = await seedUser();
    await seedMembership(tenant, owner);
    const id = await seedSession(tenant, owner);
    const projectId = `project_${randomUUID()}`;
    await superuserPool().query("INSERT INTO projects (project_id,tenant_id,user_id,name) VALUES ($1,$2,$3,'Changing cap')",
      [projectId, tenant, owner]);
    await superuserPool().query(
      "INSERT INTO project_memberships (tenant_id,project_id,user_id,role) VALUES ($1,$2,$3,'owner')",
      [tenant, projectId, owner]);
    await superuserPool().query("UPDATE sessions SET project_id=$2 WHERE session_id=$1", [id, projectId]);
    const store = new SessionStore(appPool());
    const original = { skillIds: ["retired"], connectorIds: ["disabled"] };
    expect(await store.setCapabilities(tenant, id, owner, { selection: original, version: 0 })).toBe(true);
    await superuserPool().query("UPDATE projects SET capability_selection=$2::jsonb WHERE project_id=$1",
      [projectId, JSON.stringify({ skillIds: ["pdf"], connectorIds: ["docs"] })]);
    const available = { skillIds: ["pdf"], connectorIds: ["docs"] };
    const retained = { skillIds: ["retired", "pdf"], connectorIds: ["disabled", "docs"] };
    expect(await store.setCapabilities(tenant, id, owner, { selection: retained, version: 1 }, available)).toBe(true);
    expect(await store.getCapabilitySelection(tenant, id, owner)).toEqual(available);
    expect(await store.setCapabilities(tenant, id, owner, { selection: {
      skillIds: ["retired", "new"], connectorIds: ["disabled", "docs"] }, version: 2 }, available)).toBe(false);
    expect(await store.setCapabilities(tenant, id, owner, { selection: {
      skillIds: ["retired", "new"], connectorIds: ["disabled", "docs"] }, version: 2 },
    { skillIds: ["pdf", "new"], connectorIds: ["docs"] })).toBe(false);
    expect(await store.setCapabilities(tenant, id, owner, { selection: available, version: 2 }, available)).toBe(true);
    expect(await store.setCapabilities(tenant, id, owner, { selection: retained, version: 2 }, available)).toBe(false);
    expect(await store.setCapabilities(tenant, id, owner, { selection: retained, version: 3 }, available)).toBe(false);
    expect(await store.getCapabilities(tenant, id, owner)).toMatchObject({ selection: available, version: 3 });
  });
});
