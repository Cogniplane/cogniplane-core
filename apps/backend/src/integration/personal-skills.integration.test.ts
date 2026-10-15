import { describe, expect, test, vi } from "vitest";
import { withTenantScope } from "../lib/db.js";
import { AuditEventStore } from "../services/audit-event-store.js";
import { PersonalCapabilityStore } from "../services/personal-capability-store.js";
import {
  PersonalSkillAccessError, PersonalSkillConflictError, PersonalSkillDefaultsFullError,
  PersonalSkillLimitError, PersonalSkillNotFoundError, PersonalSkillStore
} from "../services/skills/personal-skill-store.js";
import { PersonalSkillValidationError } from "../services/skills/personal-skill-validation.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedMembership, seedTenant, seedUser } from "./support/fixtures.js";

const source = { kind: "inline" as const, name: "notes", description: "Write notes", instructions: "Write short notes." };
const store = () => new PersonalSkillStore(appPool());

describe.skipIf(!adminDatabaseUrl())("personal skills", () => {
  test("isolates owners and tenants, keeps drafts separate from active content, and retains stale defaults", async () => {
    const tenant = await seedTenant(), otherTenant = await seedTenant();
    const user = await seedUser(), other = await seedUser();
    await Promise.all([seedMembership(tenant, user), seedMembership(tenant, other), seedMembership(otherTenant, user)]);
    const personal = store();
    const created = await personal.create(tenant, user, source);
    expect(created.id).toMatch(/^personal-skill-[0-9a-f-]{36}$/);
    expect(created).toMatchObject({ version: 1, enabled: false, active: null, latest: { revision: 1 } });
    expect(await personal.listRuntimeSkills(tenant, user)).toEqual([]);
    expect(await personal.list(tenant, other)).toEqual([]);
    expect(await personal.list(otherTenant, user)).toEqual([]);
    await expect(personal.get(tenant, other, created.id)).rejects.toBeInstanceOf(PersonalSkillNotFoundError);
    await expect(personal.history(otherTenant, user, created.id)).rejects.toBeInstanceOf(PersonalSkillNotFoundError);
    for (const [wrongTenant, wrongUser] of [[tenant, other], [otherTenant, user]]) {
      await expect(personal.update(wrongTenant, wrongUser, created.id, source, 1)).rejects.toBeInstanceOf(PersonalSkillNotFoundError);
      await expect(personal.action(wrongTenant, wrongUser, created.id, "release", 1)).rejects.toBeInstanceOf(PersonalSkillNotFoundError);
      await expect(personal.remove(wrongTenant, wrongUser, created.id, 1)).rejects.toBeInstanceOf(PersonalSkillNotFoundError);
    }
    await withTenantScope(appPool(), otherTenant, async client => {
      expect((await client.query("SELECT * FROM personal_skills WHERE tenant_id=$1 AND user_id=$2", [tenant, user])).rows).toEqual([]);
      expect((await client.query("SELECT * FROM personal_skill_revisions WHERE tenant_id=$1 AND user_id=$2", [tenant, user])).rows).toEqual([]);
    });
    await expect(withTenantScope(appPool(), otherTenant, client => client.query(
      "INSERT INTO personal_skills (tenant_id,user_id,skill_id) VALUES ($1,$2,$3)",
      [tenant, user, "personal-skill-00000000-0000-4000-8000-000000000000"]
    ))).rejects.toThrow();
    const released = await personal.action(tenant, user, created.id, "release", 1);
    expect(released).toMatchObject({ version: 2, enabled: true, active: { revision: 1 } });
    const active = await personal.listRuntimeSkills(tenant, user);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ id: created.id, instructions: source.instructions, revisionId: null,
      sourceType: "personal", bundleName: created.id, bundleStorageUri: null, associatedToolIds: [] });
    const changed = await personal.update(tenant, user, created.id, { ...source, instructions: "Use bullet points." }, 2);
    expect(changed).toMatchObject({ version: 3, latest: { revision: 2 }, active: { revision: 1 } });
    expect((await personal.listRuntimeSkills(tenant, user))[0].instructions).toBe(source.instructions);
    expect(await personal.history(tenant, user, created.id)).toHaveLength(2);
    await expect(personal.action(tenant, user, created.id, "release", 2)).rejects.toBeInstanceOf(PersonalSkillConflictError);
    const releasedDraft = await personal.action(tenant, user, created.id, "release", 3);
    expect(releasedDraft.active?.content.instructions).toBe("Use bullet points.");
    expect((await personal.listRuntimeSkills(tenant, user))[0].hash).not.toBe(active[0].hash);
    const disabled = await personal.action(tenant, user, created.id, "disable", 4);
    expect(disabled.active?.revision).toBe(2);
    expect(await personal.listRuntimeSkills(tenant, user)).toEqual([]);
    const defaults = await new PersonalCapabilityStore(appPool()).get(tenant, user);
    expect(defaults).toEqual({ selection: null, version: 0 });
    await personal.remove(tenant, user, created.id, 5);
    expect(await personal.list(tenant, user)).toEqual([]);
    expect((await superuserPool().query("SELECT * FROM personal_skill_revisions WHERE tenant_id=$1 AND user_id=$2 AND skill_id=$3", [tenant, user, created.id])).rows).toEqual([]);
  });

  test("adds releases to custom defaults once, keeps other choices, and rolls back audit failure", async () => {
    const tenant = await seedTenant(), user = await seedUser();
    await seedMembership(tenant, user);
    const personal = store();
    const created = await personal.create(tenant, user, source);
    const defaults = new PersonalCapabilityStore(appPool());
    const selection = { skillIds: ["retired"], connectorIds: ["old-connector"] };
    await defaults.save(tenant, user, { selection, version: 0 }, selection);
    const failed = vi.spyOn(AuditEventStore, "createInTransaction").mockRejectedValueOnce(new Error("Audit failed"));
    try {
      await expect(personal.action(tenant, user, created.id, "release", 1)).rejects.toThrow("Audit failed");
    } finally { failed.mockRestore(); }
    expect(await personal.get(tenant, user, created.id)).toMatchObject({ version: 1, enabled: false, active: null });
    expect(await defaults.get(tenant, user)).toEqual({ selection, version: 1 });
    await personal.action(tenant, user, created.id, "release", 1);
    expect(await defaults.get(tenant, user)).toEqual({ selection: {
      skillIds: ["retired", created.id], connectorIds: ["old-connector"] }, version: 2 });
    await personal.action(tenant, user, created.id, "release", 2);
    expect((await defaults.get(tenant, user)).version).toBe(2);
    await personal.action(tenant, user, created.id, "disable", 3);
    expect((await defaults.get(tenant, user)).selection?.skillIds).toContain(created.id);
    const audit = await superuserPool().query(
      "SELECT event_type,payload FROM audit_events WHERE tenant_id=$1 AND user_id=$2 AND event_type LIKE 'personal.skill.%' ORDER BY id", [tenant, user]);
    expect(audit.rows.map(row => row.event_type)).toEqual([
      "personal.skill.created", "personal.skill.released", "personal.skill.released", "personal.skill.disabled"]);
    expect(JSON.stringify(audit.rows)).not.toContain(source.instructions);
    await personal.remove(tenant, user, created.id, 4);
    expect(await defaults.get(tenant, user)).toEqual({ selection, version: 3 });
    const change = await superuserPool().query(
      "SELECT payload FROM audit_events WHERE tenant_id=$1 AND user_id=$2 AND event_type='personal_capabilities_changed' ORDER BY id DESC LIMIT 1",
      [tenant, user]);
    expect(change.rows[0].payload).toEqual({ selection, version: 3 });
  });

  test("serializes competing changes and cascades with membership removal", async () => {
    const tenant = await seedTenant(), user = await seedUser();
    await seedMembership(tenant, user);
    const personal = store();
    const created = await personal.create(tenant, user, source);
    const results = await Promise.allSettled([
      personal.update(tenant, user, created.id, { ...source, instructions: "First" }, 1),
      personal.update(tenant, user, created.id, { ...source, instructions: "Second" }, 1)
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected" && result.reason instanceof PersonalSkillConflictError)).toHaveLength(1);
    expect(await personal.history(tenant, user, created.id)).toHaveLength(2);
    await superuserPool().query("DELETE FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2", [tenant, user]);
    expect((await superuserPool().query("SELECT * FROM personal_skills WHERE tenant_id=$1 AND user_id=$2", [tenant, user])).rows).toEqual([]);
    expect((await superuserPool().query("SELECT * FROM personal_skill_revisions WHERE tenant_id=$1 AND user_id=$2", [tenant, user])).rows).toEqual([]);
    await expect(personal.list(tenant, user)).rejects.toBeInstanceOf(PersonalSkillAccessError);
    await expect(personal.create(tenant, user, source)).rejects.toBeInstanceOf(PersonalSkillAccessError);
  });

  test("a racing defaults save cannot remove a newly released skill", async () => {
    const tenant = await seedTenant(), user = await seedUser();
    await seedMembership(tenant, user);
    const personal = store(), defaults = new PersonalCapabilityStore(appPool());
    const created = await personal.create(tenant, user, source);
    const empty = { skillIds: [], connectorIds: [] };
    const preference = { skillIds: [], connectorIds: ["docs"] };
    await defaults.save(tenant, user, { selection: empty, version: 0 }, preference);
    const [released, saved] = await Promise.all([
      personal.action(tenant, user, created.id, "release", 1),
      defaults.save(tenant, user, { selection: preference, version: 1 }, preference)
    ]);
    expect(released.enabled).toBe(true);
    expect(await defaults.get(tenant, user)).toEqual({
      selection: { skillIds: [created.id], connectorIds: saved ? ["docs"] : [] },
      version: saved ? 3 : 2
    });
  });

  test("retains the active revision and newest 49 drafts within a fixed allocation", async () => {
    const tenant = await seedTenant(), user = await seedUser();
    await seedMembership(tenant, user);
    const personal = store();
    const created = await personal.create(tenant, user, source);
    await personal.action(tenant, user, created.id, "release", 1);
    let version = 2;
    for (let number = 2; number <= 56; number++) {
      const updated = await personal.update(tenant, user, created.id, {
        ...source, instructions: `${number}:${"x".repeat(62_990)}`
      }, version);
      version = updated.version;
      expect(updated.latest.revision).toBe(number);
      expect(updated.active?.revision).toBe(1);
    }
    const history = await personal.history(tenant, user, created.id);
    expect(history).toHaveLength(50);
    expect(history.map(item => item.revision)).toEqual([
      ...Array.from({ length: 49 }, (_, index) => 56 - index), 1
    ]);
    const storage = await superuserPool().query(
      `SELECT count(*)::integer AS revision_count, sum(octet_length(instructions))::integer AS instruction_bytes
       FROM personal_skill_revisions WHERE tenant_id=$1 AND user_id=$2 AND skill_id=$3`,
      [tenant, user, created.id]);
    expect(storage.rows[0].revision_count).toBe(50);
    expect(storage.rows[0].instruction_bytes).toBeLessThanOrEqual(50 * 64_000);
    expect((await personal.listRuntimeSkills(tenant, user))[0].instructions).toBe(source.instructions);
    const released = await personal.action(tenant, user, created.id, "release", version);
    expect(released.active?.revision).toBe(56);
  });

  test("rejects full custom defaults without changing the skill, defaults, or audit", async () => {
    const tenant = await seedTenant(), user = await seedUser();
    await seedMembership(tenant, user);
    const personal = store();
    const created = await personal.create(tenant, user, source);
    const defaults = new PersonalCapabilityStore(appPool());
    const selection = { skillIds: Array.from({ length: 500 }, (_, index) => `old-${index}`), connectorIds: [] };
    await defaults.save(tenant, user, { selection, version: 0 }, selection);
    const countAudit = async () => Number((await superuserPool().query(
      "SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND user_id=$2", [tenant, user])).rows[0].count);
    const auditBefore = await countAudit();
    await expect(personal.action(tenant, user, created.id, "release", 1)).rejects.toBeInstanceOf(PersonalSkillDefaultsFullError);
    expect(await personal.get(tenant, user, created.id)).toEqual(created);
    expect(await defaults.get(tenant, user)).toEqual({ selection, version: 1 });
    expect(await countAudit()).toBe(auditBefore);
  });

  test("rejects duplicate names for one owner without changing drafts or other owners", async () => {
    const tenant = await seedTenant(), otherTenant = await seedTenant();
    const user = await seedUser(), other = await seedUser();
    await Promise.all([seedMembership(tenant, user), seedMembership(tenant, other), seedMembership(otherTenant, user)]);
    const personal = store();
    const first = await personal.create(tenant, user, source);
    const second = await personal.create(tenant, user, { ...source, name: "other-notes" });
    await expect(personal.create(tenant, user, source)).rejects.toBeInstanceOf(PersonalSkillValidationError);
    await expect(personal.update(tenant, user, second.id, source, second.version)).rejects.toBeInstanceOf(PersonalSkillValidationError);
    expect(await personal.get(tenant, user, second.id)).toEqual(second);
    expect(await personal.history(tenant, user, second.id)).toHaveLength(1);
    expect((await personal.create(tenant, other, source)).latest.content.name).toBe(source.name);
    expect((await personal.create(otherTenant, user, source)).latest.content.name).toBe(source.name);
    await personal.update(tenant, user, first.id, { ...source, description: "Updated" }, first.version);
    const released = await personal.action(tenant, user, first.id, "release", 2);
    const renamed = await personal.update(tenant, user, first.id, { ...source, name: "renamed-notes" }, released.version);
    expect(renamed.active?.content.name).toBe("notes");
    await expect(personal.create(tenant, user, source)).rejects.toBeInstanceOf(PersonalSkillValidationError);
    await expect(personal.update(tenant, user, second.id, source, second.version)).rejects.toBeInstanceOf(PersonalSkillValidationError);
  });

  test("caps each owner's skill allocation at 100", async () => {
    const tenant = await seedTenant(), user = await seedUser();
    await seedMembership(tenant, user);
    const personal = store();
    for (let index = 0; index < 100; index++) {
      await personal.create(tenant, user, { ...source, name: `notes-${index}` });
    }
    expect(await personal.list(tenant, user)).toHaveLength(100);
    await expect(personal.create(tenant, user, { ...source, name: "notes-over-limit" }))
      .rejects.toBeInstanceOf(PersonalSkillLimitError);
    const count = await superuserPool().query(
      "SELECT count(*)::integer AS total FROM personal_skills WHERE tenant_id=$1 AND user_id=$2", [tenant, user]);
    expect(count.rows[0].total).toBe(100);
  });
});
