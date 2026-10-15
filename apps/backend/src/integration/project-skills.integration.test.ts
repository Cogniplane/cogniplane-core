import { randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { withTenantScope } from "../lib/db.js";
import { AuditEventStore } from "../services/audit-event-store.js";
import { ProjectStore } from "../services/project-store.js";
import { SessionExecutionStore } from "../services/session-execution-store.js";
import { PersonalSkillStore } from "../services/skills/personal-skill-store.js";
import { SkillSourceValidationError } from "../services/skills/personal-skill-validation.js";
import {
  ProjectSkillConflictError, ProjectSkillLimitError, ProjectSkillNotFoundError,
  ProjectSkillSelectionFullError, ProjectSkillSourceError, ProjectSkillStore
} from "../services/skills/project-skill-store.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedApproval, seedMembership, seedRuntimeSession, seedTenant, seedUser } from "./support/fixtures.js";

const source = { kind: "inline" as const, name: "review-notes", description: "Review notes", instructions: "Summarize decisions." };
const skills = () => new ProjectSkillStore(appPool());

async function projectWithRoles() {
  const tenant = await seedTenant(), owner = await seedUser(), editor = await seedUser(), viewer = await seedUser();
  for (const user of [owner, editor, viewer]) await seedMembership(tenant, user);
  const project = await new ProjectStore(appPool()).create(tenant, owner, "Research");
  for (const [user, role] of [[editor, "editor"], [viewer, "viewer"]] as const) {
    await superuserPool().query("INSERT INTO project_memberships (tenant_id,project_id,user_id,role) VALUES ($1,$2,$3,$4)",
      [tenant, project.projectId, user, role]);
  }
  return { tenant, owner, editor, viewer, projectId: project.projectId };
}
const auditPayloads = async (tenant: string, projectId: string) => (await superuserPool().query(
  "SELECT event_type, payload FROM audit_events WHERE tenant_id=$1 AND payload->>'projectId'=$2 ORDER BY id", [tenant, projectId])).rows;

describe.skipIf(!adminDatabaseUrl())("project skills", () => {
  test("lets owners manage drafts and releases while members only read and other tenants see nothing", async () => {
    const { tenant, owner, editor, viewer, projectId } = await projectWithRoles();
    const outsider = await seedUser(), foreignTenant = await seedTenant();
    await seedMembership(tenant, outsider);
    await seedMembership(foreignTenant, owner);
    const store = skills();
    const created = await store.create(tenant, owner, projectId, source);
    expect(created.id).toMatch(/^project-skill-[0-9a-f-]{36}$/);
    expect(created).toMatchObject({ version: 1, enabled: false, active: null, copiedFrom: null, latest: { revision: 1 } });
    expect(await store.listRuntimeSkills(tenant, projectId, owner)).toEqual([]);

    for (const reader of [editor, viewer]) {
      expect(await store.list(tenant, reader, projectId)).toEqual({ canEdit: false, skills: [created] });
      expect(await store.history(tenant, reader, projectId, created.id)).toHaveLength(1);
      await expect(store.create(tenant, reader, projectId, source)).rejects.toMatchObject({ status: 403 });
      await expect(store.update(tenant, reader, projectId, created.id, source, 1)).rejects.toMatchObject({ status: 403 });
      await expect(store.action(tenant, reader, projectId, created.id, "release", 1)).rejects.toMatchObject({ status: 403 });
      await expect(store.remove(tenant, reader, projectId, created.id, 1)).rejects.toMatchObject({ status: 403 });
    }
    for (const [otherTenant, user] of [[tenant, outsider], [foreignTenant, owner]]) {
      await expect(store.list(otherTenant, user, projectId)).rejects.toMatchObject({ status: 404 });
      await expect(store.get(otherTenant, user, projectId, created.id)).rejects.toMatchObject({ status: 404 });
      await expect(store.action(otherTenant, user, projectId, created.id, "release", 1)).rejects.toMatchObject({ status: 404 });
    }
    await withTenantScope(appPool(), foreignTenant, async client => {
      expect((await client.query("SELECT * FROM project_skills WHERE tenant_id=$1", [tenant])).rows).toEqual([]);
      expect((await client.query("SELECT * FROM project_skill_revisions WHERE tenant_id=$1", [tenant])).rows).toEqual([]);
    });
    await expect(withTenantScope(appPool(), foreignTenant, client => client.query(
      "INSERT INTO project_skills (tenant_id,project_id,skill_id,created_by) VALUES ($1,$2,$3,$4)",
      [tenant, projectId, `project-skill-${randomUUID()}`, owner]))).rejects.toThrow();

    const released = await store.action(tenant, owner, projectId, created.id, "release", 1);
    expect(released).toMatchObject({ version: 2, enabled: true, active: { revision: 1 } });
    const drafted = await store.update(tenant, owner, projectId, created.id, { ...source, instructions: "Draft only." }, 2);
    expect(drafted).toMatchObject({ version: 3, latest: { revision: 2 }, active: { revision: 1 } });
    expect((await store.listRuntimeSkills(tenant, projectId, owner))[0]?.instructions).toBe(source.instructions);
    await expect(store.update(tenant, owner, projectId, created.id, source, 2)).rejects.toBeInstanceOf(ProjectSkillConflictError);
    const disabled = await store.action(tenant, owner, projectId, created.id, "disable", 3);
    expect(await store.listRuntimeSkills(tenant, projectId, owner)).toEqual([]);
    const reenabled = await store.action(tenant, owner, projectId, created.id, "release", disabled.version);
    expect(reenabled).toMatchObject({ version: 5, enabled: true, active: { revision: 2 } });
    await store.remove(tenant, owner, projectId, created.id, reenabled.version);
    await expect(store.get(tenant, viewer, projectId, created.id)).rejects.toBeInstanceOf(ProjectSkillNotFoundError);
    expect((await superuserPool().query("SELECT 1 FROM project_skill_revisions WHERE skill_id=$1", [created.id])).rowCount).toBe(0);
    expect((await auditPayloads(tenant, projectId)).filter(row => String(row.event_type).startsWith("project.skill."))
      .map(row => row.event_type)).toEqual(["project.skill.created", "project.skill.released", "project.skill.draft_saved",
      "project.skill.disabled", "project.skill.released", "project.skill.deleted"]);

    await new ProjectStore(appPool()).setArchived(tenant, owner, projectId, true);
    expect((await store.list(tenant, owner, projectId)).canEdit).toBe(false);
    await expect(store.create(tenant, owner, projectId, source)).rejects.toMatchObject({ code: "project_archived" });
  });

  test("copies only the member's own release and keeps the copy independent of later source changes", async () => {
    const { tenant, owner, editor, viewer, projectId } = await projectWithRoles();
    const coOwner = await seedUser();
    await seedMembership(tenant, coOwner);
    await superuserPool().query("INSERT INTO project_memberships (tenant_id,project_id,user_id,role) VALUES ($1,$2,$3,'owner')",
      [tenant, projectId, coOwner]);
    const personal = new PersonalSkillStore(appPool()), store = skills();
    const draftOnly = await personal.create(tenant, owner, { ...source, name: "unreleased" });
    await expect(store.copyFromPersonal(tenant, owner, projectId, draftOnly.id, 1))
      .rejects.toMatchObject({ code: "personal_source_unavailable" });
    const original = await personal.create(tenant, owner, source);
    const releasedSource = await personal.action(tenant, owner, original.id, "release", 1);
    const colleague = await personal.create(tenant, editor, { ...source, name: "editor-notes" });
    await personal.action(tenant, editor, colleague.id, "release", 1);
    await expect(store.copyFromPersonal(tenant, owner, projectId, colleague.id, 1))
      .rejects.toMatchObject({ code: "personal_source_unavailable" });
    await expect(store.copyFromPersonal(tenant, coOwner, projectId, original.id, 1))
      .rejects.toMatchObject({ code: "personal_source_unavailable" });
    await expect(store.copyFromPersonal(tenant, editor, projectId, colleague.id, 1)).rejects.toMatchObject({ status: 403 });
    await expect(store.copyFromPersonal(tenant, owner, projectId, original.id, 2)).rejects.toBeInstanceOf(ProjectSkillSourceError);

    const copied = await store.copyFromPersonal(tenant, owner, projectId, original.id, 1);
    expect(copied).toMatchObject({ enabled: false, active: null,
      copiedFrom: { mine: true, personalSkillId: original.id, revision: 1 }, latest: { copiedFromRevision: 1,
        content: { name: source.name, description: source.description, instructions: source.instructions } } });
    expect((await store.get(tenant, viewer, projectId, copied.id)).copiedFrom).toEqual({ mine: false, personalSkillId: null, revision: 1 });
    const stored = await superuserPool().query(
      "SELECT source_revision, source_content_hash, created_by FROM project_skill_revisions WHERE skill_id=$1", [copied.id]);
    expect(stored.rows[0]).toMatchObject({ source_revision: 1, created_by: owner, source_content_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    await expect(store.copyFromPersonal(tenant, owner, projectId, original.id, 1)).rejects.toBeInstanceOf(SkillSourceValidationError);
    const live = await store.action(tenant, owner, projectId, copied.id, "release", copied.version);

    const sourceDraft = await personal.update(tenant, owner, original.id, { ...source, instructions: "Private second release." }, releasedSource.version);
    const secondRelease = await personal.action(tenant, owner, original.id, "release", sourceDraft.version);
    await expect(store.copyFromPersonal(tenant, owner, projectId, original.id, 1)).rejects.toMatchObject({ code: "personal_source_changed" });
    expect((await store.listRuntimeSkills(tenant, projectId, owner))[0]?.instructions).toBe(source.instructions);

    const coOwnerEdit = await store.update(tenant, coOwner, projectId, copied.id,
      { ...source, instructions: "Project edit." }, live.version);
    await expect(store.updateFromPersonal(tenant, coOwner, projectId, copied.id, 2, coOwnerEdit.version))
      .rejects.toMatchObject({ status: 403, code: "project_skill_source_owner_required" });
    await expect(store.updateFromPersonal(tenant, owner, projectId, copied.id, 1, coOwnerEdit.version))
      .rejects.toMatchObject({ code: "personal_source_changed" });
    const pulled = await store.updateFromPersonal(tenant, owner, projectId, copied.id, 2, coOwnerEdit.version);
    expect(pulled).toMatchObject({ latest: { revision: 3, copiedFromRevision: 2, content: { instructions: "Private second release." } },
      active: { revision: 1 }, copiedFrom: { revision: 2 } });
    expect((await store.listRuntimeSkills(tenant, projectId, owner))[0]?.instructions).toBe(source.instructions);

    await personal.action(tenant, owner, original.id, "disable", secondRelease.version);
    await expect(store.updateFromPersonal(tenant, owner, projectId, copied.id, 2, pulled.version))
      .rejects.toMatchObject({ code: "personal_source_unavailable" });
    await superuserPool().query("DELETE FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2", [tenant, owner]);
    expect((await superuserPool().query("SELECT 1 FROM personal_skills WHERE tenant_id=$1 AND user_id=$2", [tenant, owner])).rowCount).toBe(0);
    const remaining = await store.get(tenant, coOwner, projectId, copied.id);
    expect(remaining).toMatchObject({ enabled: true, active: { revision: 1 }, copiedFrom: { mine: false, personalSkillId: null } });
    expect((await store.listRuntimeSkills(tenant, projectId, coOwner))[0]?.instructions).toBe(source.instructions);
    expect(await store.history(tenant, viewer, projectId, copied.id)).toHaveLength(3);
    const audit = await auditPayloads(tenant, projectId);
    expect(audit.filter(row => row.event_type === "project.skill.copied").map(row => row.payload)).toEqual([
      { projectId, skillId: copied.id, revision: 1, version: 1, sourceSkillId: original.id, sourceRevision: 1 },
      { projectId, skillId: copied.id, revision: 3, version: pulled.version, sourceSkillId: original.id, sourceRevision: 2 }
    ]);
    expect(JSON.stringify(audit)).not.toContain("Private second release.");
    expect(JSON.stringify(audit)).not.toContain(source.instructions);
  });

  test("adds releases to custom selections atomically and removes deleted skills from them", async () => {
    const { tenant, owner, projectId } = await projectWithRoles();
    const projects = new ProjectStore(appPool()), store = skills();
    const inherited = await store.create(tenant, owner, projectId, { ...source, name: "inherited" });
    await store.action(tenant, owner, projectId, inherited.id, "release", 1);
    expect(await projects.getCapabilities(tenant, owner, projectId)).toMatchObject({ selection: null, version: 0 });

    const empty = { skillIds: [], connectorIds: [] };
    expect(await projects.setCapabilities(tenant, owner, projectId, { selection: empty, version: 0 })).toBe(true);
    const created = await store.create(tenant, owner, projectId, source);
    expect((await projects.getCapabilities(tenant, owner, projectId)).selection).toEqual(empty);
    const failed = vi.spyOn(AuditEventStore, "createInTransaction").mockRejectedValueOnce(new Error("Audit failed"));
    try {
      await expect(store.action(tenant, owner, projectId, created.id, "release", 1)).rejects.toThrow("Audit failed");
    } finally { failed.mockRestore(); }
    expect(await store.get(tenant, owner, projectId, created.id)).toEqual(created);
    expect(await projects.getCapabilities(tenant, owner, projectId)).toMatchObject({ selection: empty, version: 1 });

    const released = await store.action(tenant, owner, projectId, created.id, "release", 1);
    expect(await projects.getCapabilities(tenant, owner, projectId)).toMatchObject({
      selection: { skillIds: [created.id], connectorIds: [] }, version: 2 });
    const disabled = await store.action(tenant, owner, projectId, created.id, "disable", released.version);
    expect((await projects.getCapabilities(tenant, owner, projectId)).version).toBe(2);
    await store.remove(tenant, owner, projectId, created.id, disabled.version);
    expect(await projects.getCapabilities(tenant, owner, projectId)).toMatchObject({ selection: empty, version: 3 });

    const full = { skillIds: Array.from({ length: 500 }, (_, index) => `old-${index}`), connectorIds: [] };
    expect(await projects.setCapabilities(tenant, owner, projectId, { selection: full, version: 3 })).toBe(true);
    const blocked = await store.create(tenant, owner, projectId, { ...source, name: "blocked" });
    const auditCount = (await auditPayloads(tenant, projectId)).length;
    await expect(store.action(tenant, owner, projectId, blocked.id, "release", 1)).rejects.toBeInstanceOf(ProjectSkillSelectionFullError);
    expect(await store.get(tenant, owner, projectId, blocked.id)).toEqual(blocked);
    expect(await projects.getCapabilities(tenant, owner, projectId)).toMatchObject({ selection: full, version: 4 });
    expect((await auditPayloads(tenant, projectId)).length).toBe(auditCount);
  });

  test("rejects runtime changes during active work but still saves drafts", async () => {
    const { tenant, owner, projectId } = await projectWithRoles();
    const store = skills(), projects = new ProjectStore(appPool());
    const created = await store.create(tenant, owner, projectId, source);
    const sessionId = (await projects.createSession(tenant, owner, projectId, "Chat"))!;
    const executions = new SessionExecutionStore(appPool());
    const execution = await executions.acquire({ tenantId: tenant, userId: owner, sessionId }, 30_000);
    await expect(store.action(tenant, owner, projectId, created.id, "release", 1)).rejects.toMatchObject({ code: "project_busy", status: 409 });
    const drafted = await store.update(tenant, owner, projectId, created.id, { ...source, description: "Changed" }, 1);
    await executions.release(execution);
    const runtime = await seedRuntimeSession(tenant, owner, sessionId);
    const approval = await seedApproval({ tenantId: tenant, userId: owner, sessionId, runtimeId: runtime });
    await expect(store.remove(tenant, owner, projectId, created.id, drafted.version)).rejects.toMatchObject({ code: "project_busy" });
    await superuserPool().query("UPDATE approvals SET status='approved' WHERE approval_id=$1", [approval]);
    expect((await store.action(tenant, owner, projectId, created.id, "release", drafted.version)).enabled).toBe(true);
  });

  test("serializes competing writers, bounds history, and cascades with the project", async () => {
    const { tenant, owner, viewer, projectId } = await projectWithRoles();
    const store = skills();
    const created = await store.create(tenant, owner, projectId, source);
    const results = await Promise.allSettled([
      store.update(tenant, owner, projectId, created.id, { ...source, instructions: "First" }, 1),
      store.update(tenant, owner, projectId, created.id, { ...source, instructions: "Second" }, 1)
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected" && result.reason instanceof ProjectSkillConflictError)).toHaveLength(1);
    const names = await Promise.allSettled([
      store.create(tenant, owner, projectId, { ...source, name: "same-name" }),
      store.create(tenant, owner, projectId, { ...source, name: "same-name" })
    ]);
    expect(names.filter(result => result.status === "rejected" && result.reason instanceof SkillSourceValidationError)).toHaveLength(1);

    let current = await store.action(tenant, owner, projectId, created.id, "release", 2);
    for (let number = 3; number <= 55; number++) {
      current = await store.update(tenant, owner, projectId, created.id, { ...source, instructions: `Draft ${number}` }, current.version);
    }
    const history = await store.history(tenant, viewer, projectId, created.id);
    expect(history).toHaveLength(50);
    expect(history.at(-1)?.revision).toBe(2);
    expect(history[0]?.revision).toBe(55);
    expect((await store.listRuntimeSkills(tenant, projectId, owner))[0]?.version).toBe(2);

    await superuserPool().query("DELETE FROM sessions WHERE tenant_id=$1 AND project_id=$2", [tenant, projectId]);
    await superuserPool().query("DELETE FROM project_memberships WHERE tenant_id=$1 AND project_id=$2", [tenant, projectId]);
    await superuserPool().query("DELETE FROM projects WHERE tenant_id=$1 AND project_id=$2", [tenant, projectId]);
    for (const table of ["project_skills", "project_skill_revisions"]) {
      expect((await superuserPool().query(`SELECT 1 FROM ${table} WHERE tenant_id=$1 AND project_id=$2`, [tenant, projectId])).rowCount).toBe(0);
    }
  });

  test("caps each project at 100 skills", async () => {
    const { tenant, owner, projectId } = await projectWithRoles();
    const store = skills();
    for (let index = 0; index < 100; index++) await store.create(tenant, owner, projectId, { ...source, name: `notes-${index}` });
    await expect(store.create(tenant, owner, projectId, { ...source, name: "over-limit" })).rejects.toBeInstanceOf(ProjectSkillLimitError);
    const other = await new ProjectStore(appPool()).create(tenant, owner, "Other");
    expect((await store.create(tenant, owner, other.projectId, source)).latest.content.name).toBe(source.name);
  });
});
