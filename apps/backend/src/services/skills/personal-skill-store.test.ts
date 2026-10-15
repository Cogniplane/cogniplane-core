import { describe, expect, test } from "vitest";
import { FakePool, type QueryResult } from "../../test-helpers/fake-pool.js";
import {
  PersonalSkillAccessError, PersonalSkillConflictError, PersonalSkillDefaultsFullError,
  PersonalSkillLimitError, PersonalSkillNotFoundError, PersonalSkillStore
} from "./personal-skill-store.js";
import { PersonalSkillValidationError } from "./personal-skill-validation.js";

const tenant = "tenant-a", user = "user-a", id = "personal-skill-1";
const source = { kind: "inline" as const, name: "meeting-notes", description: "Write meeting notes", instructions: "Write decisions." };
const timestamp = "2026-09-26T12:00:00.000Z";
const joined = {
  skill_id: id, version: "3", enabled: true, updated_at: timestamp,
  latest_number: "2", latest_name: "meeting-notes", latest_description: "New purpose",
  latest_instructions: "Write actions.", latest_messages: ["Companion files are unavailable."], latest_created_at: timestamp,
  active_number: "1", active_name: "meeting-notes", active_description: "Write meeting notes",
  active_instructions: "Write decisions.", active_messages: [], active_created_at: timestamp
};
const rows = (items: Record<string, unknown>[]): QueryResult => ({ rowCount: items.length, rows: items });
type Handler = (statement: string, params: unknown[]) => QueryResult;
type Audit = { tenantId: unknown; userId: unknown; type: unknown; payload: unknown };

function setup(handler: Handler) {
  const audits: Audit[] = [];
  const db = new FakePool()
    .onQuery("INSERT INTO audit_events", (_statement, params) => {
      audits.push({ tenantId: params[0], userId: params[2], type: params[4], payload: JSON.parse(String(params[5])) });
      return rows([]);
    })
    .onQuery("", handler);
  return { db, audits, store: new PersonalSkillStore(db.asPool()) };
}

function committed(db: FakePool) {
  expect(db.queries.map(query => query.text.trim())).toContain("COMMIT");
  expect(db.queries.map(query => query.text.trim())).not.toContain("ROLLBACK");
  expect(db.queries.find(query => query.text.includes("set_config"))?.values).toEqual([tenant]);
}

function rolledBack(db: FakePool) {
  expect(db.queries.map(query => query.text.trim())).toContain("ROLLBACK");
  expect(db.queries.map(query => query.text.trim())).not.toContain("COMMIT");
}

describe("PersonalSkillStore row mapping", () => {
  test("lists a pending draft separately from the released revision", async () => {
    const { db, store } = setup((statement, params) => {
      if (statement.includes("FROM tenant_memberships")) return rows([{}]);
      if (statement.includes("ORDER BY s.updated_at DESC")) {
        expect(params).toEqual([tenant, user]);
        return rows([joined, { ...joined, skill_id: "draft-only", version: 1, enabled: false, active_number: null }]);
      }
      throw new Error(`Unexpected query: ${statement}`);
    });
    const result = await store.list(tenant, user);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id, version: 3, enabled: true, updatedAt: timestamp,
      latest: { revision: 2, content: { name: "meeting-notes", description: "New purpose", instructions: "Write actions." },
        validationMessages: ["Companion files are unavailable."], createdAt: timestamp },
      active: { revision: 1, content: { name: "meeting-notes", description: "Write meeting notes", instructions: "Write decisions." },
        validationMessages: [], createdAt: timestamp }
    });
    expect(result[1]).toMatchObject({ id: "draft-only", enabled: false, active: null });
    committed(db);
  });

  test("requests bounded history and maps content and validation messages", async () => {
    const { db, store } = setup((statement, params) => {
      if (statement.includes("FROM tenant_memberships")) return rows([{}]);
      if (statement.includes("SELECT 1 FROM personal_skills WHERE")) return rows([{}]);
      if (statement.includes("FROM personal_skill_revisions WHERE")) {
        expect(params).toEqual([tenant, user, id, 50]);
        return rows([
          { revision: "2", name: "meeting-notes", description: "New purpose", instructions: "Write actions.",
            validation_messages: ["Check this."], created_at: timestamp },
          { revision: "1", name: "meeting-notes", description: "Write meeting notes", instructions: "Write decisions.",
            validation_messages: [], created_at: timestamp }
        ]);
      }
      throw new Error(`Unexpected query: ${statement}`);
    });
    expect(await store.history(tenant, user, id)).toEqual([
      { revision: 2, content: { name: "meeting-notes", description: "New purpose", instructions: "Write actions." },
        validationMessages: ["Check this."], createdAt: timestamp },
      { revision: 1, content: { name: "meeting-notes", description: "Write meeting notes", instructions: "Write decisions." },
        validationMessages: [], createdAt: timestamp }
    ]);
    committed(db);
  });

  test("maps runtime snapshots with stable hashes that change with revision or content", async () => {
    let revision = "1", instructions = "Write decisions.";
    const { db, store } = setup((statement, params) => {
      if (statement.includes("FROM personal_skills s") && statement.includes("s.enabled=true")) {
        expect(params).toEqual([tenant, user]);
        return rows([{ skill_id: id, revision, name: "meeting-notes", description: "Write meeting notes", instructions }]);
      }
      throw new Error(`Unexpected query: ${statement}`);
    });
    const first = await store.listRuntimeSkills(tenant, user);
    expect(first).toEqual([{ id, name: "meeting-notes", description: "Write meeting notes", instructions: "Write decisions.",
      version: 1, hash: expect.stringMatching(/^[a-f0-9]{64}$/), revisionId: null, bundleHash: null, sourceType: "personal", bundleName: id,
      bundleStorageUri: null, validationStatus: "valid", reviewStatus: "approved", associatedToolIds: [] }]);
    expect((await store.listRuntimeSkills(tenant, user))[0].hash).toBe(first[0].hash);
    revision = "2";
    const second = await store.listRuntimeSkills(tenant, user);
    expect(second[0].version).toBe(2);
    expect(second[0].hash).not.toBe(first[0].hash);
    instructions = "Write actions.";
    expect((await store.listRuntimeSkills(tenant, user))[0].hash).not.toBe(second[0].hash);
    committed(db);
  });
});

describe("PersonalSkillStore failures", () => {
  test("stops reads and writes when membership is gone", async () => {
    const { db, store } = setup((statement) => {
      if (statement.includes("FROM tenant_memberships")) return rows([]);
      throw new Error(`Unexpected query: ${statement}`);
    });
    await expect(store.get(tenant, user, id)).rejects.toBeInstanceOf(PersonalSkillAccessError);
    await expect(store.create(tenant, user, source)).rejects.toBeInstanceOf(PersonalSkillAccessError);
    expect(db.queries.filter(query => query.text.includes("FROM tenant_memberships"))).toHaveLength(2);
    expect(db.queries.filter(query => query.text.trim() === "ROLLBACK")).toHaveLength(2);
  });

  test("reports missing resources before reading history or returning a skill", async () => {
    const { db, store } = setup((statement) => {
      if (statement.includes("FROM tenant_memberships")) return rows([{}]);
      if (statement.includes("FROM personal_skills s") || statement.includes("SELECT 1 FROM personal_skills WHERE")) return rows([]);
      throw new Error(`Unexpected query: ${statement}`);
    });
    await expect(store.get(tenant, user, id)).rejects.toBeInstanceOf(PersonalSkillNotFoundError);
    await expect(store.history(tenant, user, id)).rejects.toBeInstanceOf(PersonalSkillNotFoundError);
    expect(db.queries.filter(query => query.text.includes("FROM personal_skill_revisions WHERE"))).toHaveLength(0);
    expect(db.queries.filter(query => query.text.trim() === "ROLLBACK")).toHaveLength(2);
  });

  test("rejects an invalid source before checking names or inserting rows", async () => {
    const { db, store } = setup((statement) => {
      if (statement.includes("FROM tenant_memberships")) return rows([{}]);
      throw new Error(`Unexpected query: ${statement}`);
    });
    await expect(store.create(tenant, user, { ...source, name: "Bad Name" }))
      .rejects.toBeInstanceOf(PersonalSkillValidationError);
    expect(db.queries.some(query => query.text.includes("JOIN personal_skill_revisions r"))).toBe(false);
    expect(db.queries.some(query => query.text.startsWith("INSERT INTO personal_skills"))).toBe(false);
    rolledBack(db);
  });

  test("rejects a stale update before saving a new revision", async () => {
    const { db, store } = setup((statement) => {
      if (statement.includes("FROM tenant_memberships")) return rows([{}]);
      if (statement.includes("FROM personal_skills WHERE") && statement.includes("FOR UPDATE")) {
        return rows([{ version: 3, latest_revision: 2, active_revision: 1, enabled: true }]);
      }
      throw new Error(`Unexpected query: ${statement}`);
    });
    await expect(store.update(tenant, user, id, source, 2)).rejects.toBeInstanceOf(PersonalSkillConflictError);
    expect(db.queries.some(query => query.text.startsWith("INSERT INTO personal_skill_revisions"))).toBe(false);
    rolledBack(db);
  });

  test("rejects duplicate names and a full allocation before insertion", async () => {
    const duplicate = setup((statement) => {
      if (statement.includes("FROM tenant_memberships")) return rows([{}]);
      if (statement.includes("JOIN personal_skill_revisions r")) return rows([{}]);
      throw new Error(`Unexpected query: ${statement}`);
    });
    await expect(duplicate.store.create(tenant, user, source)).rejects.toThrow("You already have a personal skill with this name.");
    expect(duplicate.db.queries.some(query => query.text.startsWith("INSERT INTO personal_skills"))).toBe(false);
    rolledBack(duplicate.db);

    const full = setup((statement) => {
      if (statement.includes("FROM tenant_memberships")) return rows([{}]);
      if (statement.includes("JOIN personal_skill_revisions r")) return rows([]);
      if (statement.includes("SELECT count(*) AS total FROM personal_skills")) return rows([{ total: "100" }]);
      throw new Error(`Unexpected query: ${statement}`);
    });
    await expect(full.store.create(tenant, user, source)).rejects.toBeInstanceOf(PersonalSkillLimitError);
    expect(full.db.queries.some(query => query.text.startsWith("INSERT INTO personal_skills"))).toBe(false);
    rolledBack(full.db);
  });

  test("rejects release when custom defaults are full before changing the active revision", async () => {
    const { db, audits, store } = setup((statement) => {
      if (statement.includes("FROM tenant_memberships")) return rows([{}]);
      if (statement.includes("FROM personal_skills WHERE") && statement.includes("FOR UPDATE")) {
        return rows([{ version: 3, latest_revision: 2, active_revision: 1, enabled: true }]);
      }
      if (statement.includes("FROM personal_capability_defaults")) {
        return rows([{ capability_selection: { skillIds: Array.from({ length: 500 }, (_, index) => `skill-${index}`), connectorIds: [] }, capability_version: 4 }]);
      }
      throw new Error(`Unexpected query: ${statement}`);
    });
    await expect(store.action(tenant, user, id, "release", 3)).rejects.toBeInstanceOf(PersonalSkillDefaultsFullError);
    expect(db.queries.some(query => query.text.startsWith("UPDATE personal_skills"))).toBe(false);
    expect(audits).toEqual([]);
    rolledBack(db);
  });
});

describe("PersonalSkillStore actions", () => {
  test("release adds a skill to custom defaults and writes both audit records in one transaction", async () => {
    const { db, audits, store } = setup((statement, params) => {
      if (statement.includes("FROM tenant_memberships")) return rows([{}]);
      if (statement.includes("FROM personal_skills WHERE") && statement.includes("FOR UPDATE")) {
        expect(params).toEqual([tenant, user, id]);
        return rows([{ version: 3, latest_revision: 2, active_revision: 1, enabled: true }]);
      }
      if (statement.includes("FROM personal_capability_defaults")) {
        return rows([{ capability_selection: { skillIds: ["existing"], connectorIds: ["docs"] }, capability_version: 4 }]);
      }
      if (statement.includes("UPDATE personal_capability_defaults")) {
        expect(params).toEqual([tenant, user, JSON.stringify({ skillIds: ["existing", id], connectorIds: ["docs"] }), 5]);
        return rows([]);
      }
      if (statement.includes("UPDATE personal_skills SET active_revision")) {
        expect(params).toEqual([tenant, user, id]);
        return rows([]);
      }
      if (statement.includes("FROM personal_skills s")) return rows([{ ...joined, version: "4", active_number: "2", active_description: "New purpose", active_instructions: "Write actions." }]);
      throw new Error(`Unexpected query: ${statement}`);
    });
    expect(await store.action(tenant, user, id, "release", 3)).toMatchObject({ version: 4, active: { revision: 2 } });
    expect(audits).toEqual([
      { tenantId: tenant, userId: user, type: "personal_capabilities_changed",
        payload: { selection: { skillIds: ["existing", id], connectorIds: ["docs"] }, version: 5 } },
      { tenantId: tenant, userId: user, type: "personal.skill.released", payload: { skillId: id, revision: 2, version: 4 } }
    ]);
    expect(db.queries.filter(query => query.text.trim() === "BEGIN")).toHaveLength(1);
    committed(db);
  });

  test.each([
    { name: "inherited defaults", selection: null },
    { name: "already selected", selection: { skillIds: [id], connectorIds: [] } }
  ])("release keeps $name unchanged", async ({ selection }) => {
    const { db, audits, store } = setup((statement) => {
      if (statement.includes("FROM tenant_memberships")) return rows([{}]);
      if (statement.includes("FROM personal_skills WHERE") && statement.includes("FOR UPDATE")) {
        return rows([{ version: 3, latest_revision: 2, active_revision: 1, enabled: true }]);
      }
      if (statement.includes("FROM personal_capability_defaults")) return rows([{ capability_selection: selection, capability_version: 4 }]);
      if (statement.includes("UPDATE personal_skills SET active_revision")) return rows([]);
      if (statement.includes("FROM personal_skills s")) return rows([{ ...joined, version: "4", active_number: "2" }]);
      throw new Error(`Unexpected query: ${statement}`);
    });
    await store.action(tenant, user, id, "release", 3);
    expect(db.queries.some(query => query.text.includes("UPDATE personal_capability_defaults"))).toBe(false);
    expect(audits).toEqual([{ tenantId: tenant, userId: user, type: "personal.skill.released",
      payload: { skillId: id, revision: 2, version: 4 } }]);
    committed(db);
  });

  test("disable and remove check versions and record their skill revision", async () => {
    let version = 3;
    const { db, audits, store } = setup((statement, params) => {
      if (statement.includes("FROM tenant_memberships")) return rows([{}]);
      if (statement.includes("FROM personal_skills WHERE") && statement.includes("FOR UPDATE")) {
        expect(params).toEqual([tenant, user, id]);
        return rows([{ version, latest_revision: 2, active_revision: 1, enabled: version === 3 }]);
      }
      if (statement.includes("UPDATE personal_skills SET enabled=false")) { version++; return rows([]); }
      if (statement.includes("DELETE FROM personal_skills WHERE")) { expect(params).toEqual([tenant, user, id]); return rows([]); }
      if (statement.includes("FROM personal_capability_defaults")) return rows([]);
      if (statement.includes("FROM personal_skills s")) return rows([{ ...joined, version, enabled: false }]);
      throw new Error(`Unexpected query: ${statement}`);
    });
    expect(await store.action(tenant, user, id, "disable", 3)).toMatchObject({ version: 4, enabled: false, active: { revision: 1 } });
    await expect(store.remove(tenant, user, id, 3)).rejects.toBeInstanceOf(PersonalSkillConflictError);
    expect(audits).toEqual([{ tenantId: tenant, userId: user, type: "personal.skill.disabled",
      payload: { skillId: id, revision: 2, version: 4 } }]);
    await store.remove(tenant, user, id, 4);
    expect(audits[1]).toEqual({ tenantId: tenant, userId: user, type: "personal.skill.deleted",
      payload: { skillId: id, revision: 2, version: 5 } });
    expect(db.queries.filter(query => query.text.startsWith("DELETE FROM personal_skills"))).toHaveLength(1);
    expect(db.queries.filter(query => query.text.trim() === "ROLLBACK")).toHaveLength(1);
    expect(db.queries.filter(query => query.text.trim() === "COMMIT")).toHaveLength(2);
  });
});
