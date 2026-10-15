import { expect, test } from "vitest";
import { FakePool } from "../../test-helpers/fake-pool.js";
import { assertSkillReleaseSnapshot, SkillReleaseImpactNotFoundError,
  SkillReleaseImpactStore, SkillReleaseSnapshotConflictError } from "./skill-release-impact-store.js";

const result = (rows: Record<string, unknown>[]) => ({ rows, rowCount: rows.length });
const skill = { version: 4, active_revision_id: 7, active_revision_number: 2,
  enabled: true, is_published: false };
const snapshot = { version: 4, activeRevisionId: 7, latestRevisionId: 8,
  enabled: true, isPublished: false };

function setup(row: Record<string, unknown> = skill, target: Record<string, unknown> | null = {
  revision_number: 3, validation_status: "validated", metadata: { skillName: "Skill", description: "Purpose" }
}) {
  const pool = new FakePool()
    .onQuery("FROM admin_skills s", () => result([row]))
    .onQuery("SELECT skill_revision_id FROM admin_skill_revisions", () => result([{ skill_revision_id: 8 }]))
    .onQuery("SELECT revision_number, validation_status, metadata", () => result(target ? [target] : []))
    .onQuery("FROM tenant_memberships WHERE", () => result([{ total: 5, test_users: 2 }]))
    .onQuery("FROM projects WHERE", () => result([{ inherited: 3, explicit_selected: 1 }]))
    .onQuery("FROM tenant_memberships m", () => result([{ inherited: 4, explicit_selected: 1 }]))
    .onQuery("FROM sessions WHERE", () => result([{ inherited: 2, explicit_selected: 1 }]));
  return { pool, store: new SkillReleaseImpactStore(pool.asPool()) };
}

test("previews activation and audience changes using beta tester access", async () => {
  const { store, pool } = setup();
  const release = await store.preview("tenant", "skill", {
    action: "activate", revisionId: 8, audience: "members"
  });
  expect(release).toMatchObject({ snapshot,
    current: { revisionId: 7, revisionNumber: 2, audience: "test-users" },
    proposed: { revisionId: 8, revisionNumber: 3, audience: "members" },
    members: { total: 5, testUsers: 2, gaining: 3, losing: 0 },
    configuredReferences: { projects: { inherited: 3, explicitSelected: 1 } } });
  expect(pool.queries.some(query => query.text.includes("FOR SHARE OF s"))).toBe(true);

  const disable = await store.preview("tenant", "skill", {
    action: "audience", revisionId: 7, audience: "off"
  });
  expect(disable.members).toMatchObject({ gaining: 0, losing: 2 });
  const stillTesting = await store.preview("tenant", "skill", {
    action: "audience", revisionId: 7, audience: "test-users"
  });
  expect(stillTesting.members).toMatchObject({ gaining: 0, losing: 0 });
});

test("disabled skills remain unavailable when only publication changes", async () => {
  const { store } = setup({ ...skill, enabled: false });
  const impact = await store.preview("tenant", "skill", {
    action: "audience", revisionId: 7, audience: "members"
  });
  expect(impact).toMatchObject({ current: { audience: "off" },
    proposed: { audience: "off" }, members: { gaining: 0, losing: 0 } });
});

test("rejects missing resources and invalid activation metadata", async () => {
  const absent = new FakePool().onQuery("FROM admin_skills s", () => result([]));
  await expect(new SkillReleaseImpactStore(absent.asPool()).preview("tenant", "skill", {
    action: "audience", revisionId: null, audience: "off"
  })).rejects.toBeInstanceOf(SkillReleaseImpactNotFoundError);

  const missingRevision = setup(skill, null);
  await expect(missingRevision.store.preview("tenant", "skill", {
    action: "activate", revisionId: 8, audience: "members"
  })).rejects.toBeInstanceOf(SkillReleaseImpactNotFoundError);

  for (const target of [
    { revision_number: 3, validation_status: "invalid", metadata: { skillName: "Skill", description: "Purpose" } },
    { revision_number: 3, validation_status: "validated", metadata: { skillName: "Skill" } }
  ]) {
    const { store } = setup(skill, target);
    await expect(store.preview("tenant", "skill", {
      action: "activate", revisionId: 8, audience: "members"
    })).rejects.toBeInstanceOf(SkillReleaseSnapshotConflictError);
  }
  const { store } = setup();
  await expect(store.preview("tenant", "skill", {
    action: "activate", revisionId: null, audience: "off"
  })).rejects.toBeInstanceOf(SkillReleaseSnapshotConflictError);
});

test("checks every release snapshot field", () => {
  expect(() => assertSkillReleaseSnapshot(snapshot)).not.toThrow();
  expect(() => assertSkillReleaseSnapshot(snapshot, snapshot)).not.toThrow();
  for (const expected of [
    { ...snapshot, version: 5 },
    { ...snapshot, activeRevisionId: 9 },
    { ...snapshot, latestRevisionId: 9 },
    { ...snapshot, enabled: false },
    { ...snapshot, isPublished: true }
  ]) {
    expect(() => assertSkillReleaseSnapshot(snapshot, expected)).toThrow(SkillReleaseSnapshotConflictError);
  }
});
