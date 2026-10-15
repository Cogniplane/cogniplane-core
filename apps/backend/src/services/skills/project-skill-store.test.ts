import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { FakePool, type QueryResult } from "../../test-helpers/fake-pool.js";
import {
  ProjectSkillConflictError, ProjectSkillLimitError, ProjectSkillNotFoundError,
  ProjectSkillSelectionFullError, ProjectSkillSourceError, ProjectSkillStore
} from "./project-skill-store.js";
import { SkillSourceValidationError } from "./personal-skill-validation.js";

const tenant = "tenant-a", owner = "owner-a", project = "project-a", id = "project-skill-1";
const personalId = "personal-skill-00000000-0000-4000-8000-000000000001";
const source = { kind: "inline" as const, name: "meeting-notes", description: "Write meeting notes", instructions: "Write decisions." };
const timestamp = "2026-09-26T12:00:00.000Z";
const joined = {
  skill_id: id, version: "3", enabled: true, updated_at: timestamp,
  source_user_id: owner, source_skill_id: personalId, source_revision: "4",
  latest_number: "2", latest_name: "meeting-notes", latest_description: "New purpose", latest_instructions: "Write actions.",
  latest_messages: [], latest_source_revision: null, latest_created_at: timestamp,
  active_number: "1", active_name: "meeting-notes", active_description: "Write meeting notes",
  active_instructions: "Write decisions.", active_messages: [], active_source_revision: "4", active_created_at: timestamp
};
const rows = (items: Record<string, unknown>[]): QueryResult => ({ rowCount: items.length, rows: items });
type Handler = (statement: string, params: unknown[]) => QueryResult | undefined;
type Options = { role?: string; archived?: string | null; idle?: boolean; member?: boolean;
  selection?: { skillIds: string[]; connectorIds: string[] } | null };

function setup(handler: Handler, options: Options = {}) {
  const audits: { type: unknown; payload: Record<string, unknown> }[] = [];
  const db = new FakePool()
    .onQuery("INSERT INTO audit_events", (_statement, params) => {
      audits.push({ type: params[4], payload: JSON.parse(String(params[5])) });
      return rows([]);
    })
    .onQuery("", (statement, params) => {
      const handled = handler(statement, params);
      if (handled) return handled;
      if (statement.includes("FROM projects WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE")) return rows([{ project_id: project }]);
      if (statement.includes("AS role")) {
        return rows(options.role === undefined || options.role
          ? [{ role: options.role ?? "owner", archived_at: options.archived ?? null, visibility: "private", organization_role: "viewer" }] : []);
      }
      if (statement.includes("FROM tenant_memberships")) return rows(options.member === false ? [] : [{}]);
      if (statement.includes("FROM projects p WHERE") && statement.includes("NOT EXISTS")) return rows(options.idle === false ? [] : [{}]);
      if (statement.includes("SELECT capability_selection, capability_version FROM projects")) {
        return rows([{ capability_selection: options.selection ?? null, capability_version: 7 }]);
      }
      throw new Error(`Unexpected query: ${statement}`);
    });
  return { db, audits, store: new ProjectSkillStore(db.asPool()) };
}
const has = (db: FakePool, text: string) => db.queries.some(query => query.text.includes(text));
const outcome = (db: FakePool) => db.queries.map(query => query.text.trim()).filter(text => text === "COMMIT" || text === "ROLLBACK");

describe("ProjectSkillStore reads", () => {
  test("shows source IDs only to the member who copied the skill and reports owner edit access", async () => {
    const read = (role: string, archived: string | null = null) => setup((statement, params) => {
      if (statement.includes("ORDER BY s.updated_at DESC")) {
        expect(params).toEqual([tenant, project]);
        return rows([joined, { ...joined, skill_id: "draft", source_user_id: null, source_skill_id: null, source_revision: null, active_number: null }]);
      }
      return undefined;
    }, { role, archived }).store;
    const mine = await read("owner").list(tenant, owner, project);
    expect(mine.canEdit).toBe(true);
    expect(mine.skills[0]).toEqual({
      id, version: 3, enabled: true, updatedAt: timestamp,
      copiedFrom: { mine: true, personalSkillId: personalId, revision: 4 },
      latest: { revision: 2, content: { name: "meeting-notes", description: "New purpose", instructions: "Write actions." },
        validationMessages: [], copiedFromRevision: null, createdAt: timestamp },
      active: { revision: 1, content: { name: "meeting-notes", description: "Write meeting notes", instructions: "Write decisions." },
        validationMessages: [], copiedFromRevision: 4, createdAt: timestamp }
    });
    expect(mine.skills[1]).toMatchObject({ id: "draft", active: null, copiedFrom: null });
    const viewer = await read("viewer").list(tenant, "viewer-a", project);
    expect(viewer.canEdit).toBe(false);
    expect(viewer.skills[0]?.copiedFrom).toEqual({ mine: false, personalSkillId: null, revision: 4 });
    expect((await read("owner", timestamp).list(tenant, owner, project)).canEdit).toBe(false);
  });

  test("denies outsiders before reading skills and bounds history", async () => {
    const outsider = setup(() => undefined, { role: "" });
    await expect(outsider.store.list(tenant, "outsider", project)).rejects.toMatchObject({ status: 404 });
    await expect(outsider.store.history(tenant, "outsider", project, id)).rejects.toMatchObject({ status: 404 });
    expect(has(outsider.db, "project_skills")).toBe(false);

    const { store } = setup((statement, params) => {
      if (statement.includes("SELECT 1 FROM project_skills WHERE")) return rows(params[2] === id ? [{}] : []);
      if (statement.includes("FROM project_skill_revisions r")) {
        expect(params).toEqual([tenant, project, id, 50]);
        return rows([{ item_number: "2", item_name: "notes", item_description: "Notes", item_instructions: "Copy",
          item_messages: ["Check"], item_source_revision: "5", item_created_at: timestamp }]);
      }
      if (statement.includes("FROM project_skills s")) return rows([]);
      return undefined;
    }, { role: "viewer" });
    expect(await store.history(tenant, "viewer-a", project, id)).toEqual([{ revision: 2,
      content: { name: "notes", description: "Notes", instructions: "Copy" }, validationMessages: ["Check"],
      copiedFromRevision: 5, createdAt: timestamp }]);
    await expect(store.history(tenant, "viewer-a", project, "missing")).rejects.toBeInstanceOf(ProjectSkillNotFoundError);
    await expect(store.get(tenant, "viewer-a", project, "missing")).rejects.toBeInstanceOf(ProjectSkillNotFoundError);
  });

  test("maps released project skills to runtime definitions without tool grants", async () => {
    let instructions = "Write decisions.";
    const { store } = setup((statement, params) => {
      if (statement.includes("s.enabled=true")) {
        expect(params).toEqual([tenant, project, owner]);
        return rows([{ skill_id: id, revision: "3", name: "meeting-notes", description: "Notes", instructions }]);
      }
      return undefined;
    });
    const first = await store.listRuntimeSkills(tenant, project, owner);
    expect(first).toEqual([{ id, name: "meeting-notes", description: "Notes", instructions, version: 3,
      hash: expect.stringMatching(/^[a-f0-9]{64}$/), revisionId: null, bundleHash: null, sourceType: "project",
      bundleName: id, bundleStorageUri: null, validationStatus: "valid", reviewStatus: "approved", associatedToolIds: [] }]);
    instructions = "Write actions.";
    expect((await store.listRuntimeSkills(tenant, project, owner))[0]?.hash).not.toBe(first[0]?.hash);
  });
});

describe("ProjectSkillStore drafts", () => {
  test("requires a current project owner and membership before any write", async () => {
    for (const options of [{ role: "editor" }, { role: "viewer" }, { role: "" }, { archived: timestamp }, { member: false }]) {
      const { db, audits, store } = setup(() => undefined, options);
      await expect(store.create(tenant, owner, project, source)).rejects.toMatchObject({
        status: options.role === "editor" || options.role === "viewer" ? 403 : options.archived ? 409 : 404 });
      expect(has(db, "INSERT INTO project_skills")).toBe(false);
      expect(audits).toEqual([]);
      expect(outcome(db)).toEqual(["ROLLBACK"]);
    }
  });

  test("creates a validated draft under the project lock and audits identifiers only", async () => {
    const { db, audits, store } = setup((statement, params) => {
      if (statement.includes("JOIN project_skill_revisions r")) return rows([]);
      if (statement.includes("SELECT count(*) AS total FROM project_skills")) return rows([{ total: "99" }]);
      if (statement.startsWith("INSERT INTO project_skills")) {
        expect(params).toEqual([tenant, project, expect.stringMatching(/^project-skill-[0-9a-f-]{36}$/), owner]);
        return rows([]);
      }
      if (statement.includes("INSERT INTO project_skill_revisions")) {
        expect(params.slice(4)).toEqual([source.name, source.description, source.instructions, "[]", owner, null, null]);
        return rows([]);
      }
      if (statement.includes("FROM project_skills s")) return rows([{ ...joined, source_user_id: null, source_skill_id: null, source_revision: null }]);
      return undefined;
    });
    expect((await store.create(tenant, owner, project, source)).copiedFrom).toBeNull();
    const lock = db.queries.findIndex(query => query.text.includes("FOR UPDATE"));
    const insert = db.queries.findIndex(query => query.text.startsWith("INSERT INTO project_skills"));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(insert);
    expect(audits).toEqual([{ type: "project.skill.created",
      payload: { projectId: project, skillId: expect.stringMatching(/^project-skill-/), revision: 1, version: 1 } }]);
    expect(JSON.stringify(audits)).not.toContain(source.instructions);
    expect(outcome(db)).toEqual(["COMMIT"]);
  });

  test("rejects invalid sources, duplicate names, and full projects before insertion", async () => {
    const invalid = setup(() => undefined);
    await expect(invalid.store.create(tenant, owner, project, { ...source, name: "Bad Name" })).rejects.toBeInstanceOf(SkillSourceValidationError);
    const duplicate = setup(statement => statement.includes("JOIN project_skill_revisions r") ? rows([{}]) : undefined);
    await expect(duplicate.store.create(tenant, owner, project, source)).rejects.toThrow("This project already has a skill with this name.");
    const full = setup(statement => statement.includes("JOIN project_skill_revisions r") ? rows([])
      : statement.includes("count(*)") ? rows([{ total: "100" }]) : undefined);
    await expect(full.store.create(tenant, owner, project, source)).rejects.toBeInstanceOf(ProjectSkillLimitError);
    for (const { db } of [invalid, duplicate, full]) {
      expect(has(db, "INSERT INTO project_skills")).toBe(false);
      expect(outcome(db)).toEqual(["ROLLBACK"]);
    }
  });

  test("saves a new revision without changing the active one and keeps the active revision when pruning", async () => {
    const { db, audits, store } = setup((statement, params) => {
      if (statement.includes("FROM project_skills WHERE") && statement.includes("FOR UPDATE")) {
        return rows([{ version: 3, latest_revision: 2, active_revision: 1, enabled: true, source_user_id: null, source_skill_id: null }]);
      }
      if (statement.includes("JOIN project_skill_revisions r")) {
        expect(params).toEqual([tenant, project, source.name, id]);
        return rows([]);
      }
      if (statement.includes("INSERT INTO project_skill_revisions")) { expect(params[3]).toBe(3); return rows([]); }
      if (statement.startsWith("UPDATE project_skills SET latest_revision")) return rows([]);
      if (statement.includes("DELETE FROM project_skill_revisions")) { expect(params).toEqual([tenant, project, id, 49, 1]); return rows([]); }
      if (statement.includes("FROM project_skills s")) return rows([joined]);
      return undefined;
    });
    await store.update(tenant, owner, project, id, source, 3);
    expect(has(db, "active_revision=latest_revision")).toBe(false);
    expect(audits).toEqual([{ type: "project.skill.draft_saved", payload: { projectId: project, skillId: id, revision: 3, version: 4 } }]);
    await expect(store.update(tenant, owner, project, id, source, 2)).rejects.toBeInstanceOf(ProjectSkillConflictError);
  });
});

describe("ProjectSkillStore personal copies", () => {
  const released = { revision: "4", name: "meeting-notes", description: "Write meeting notes",
    instructions: "Write decisions.", validation_messages: ["Only SKILL.md is saved."] };
  const hash = createHash("sha256").update(JSON.stringify([released.name, released.description, released.instructions])).digest("hex");

  test("copies only the member's own released revision as an independent draft with provenance", async () => {
    const { db, audits, store } = setup((statement, params) => {
      if (statement.includes("FROM personal_skills s JOIN personal_skill_revisions r")) {
        expect(statement).toContain("s.enabled=true");
        expect(statement).toContain("r.revision=s.active_revision");
        expect(params).toEqual([tenant, owner, personalId]);
        return rows([released]);
      }
      if (statement.includes("JOIN project_skill_revisions r")) return rows([]);
      if (statement.includes("count(*)")) return rows([{ total: "0" }]);
      if (statement.startsWith("INSERT INTO project_skills")) {
        expect(params.slice(3)).toEqual([owner, personalId, 4]);
        return rows([]);
      }
      if (statement.includes("INSERT INTO project_skill_revisions")) {
        expect(params.slice(4)).toEqual([released.name, released.description, released.instructions,
          JSON.stringify(released.validation_messages), owner, 4, hash]);
        return rows([]);
      }
      if (statement.includes("FROM project_skills s")) return rows([joined]);
      return undefined;
    });
    await store.copyFromPersonal(tenant, owner, project, personalId, 4);
    expect(has(db, "personal_skills SET")).toBe(false);
    expect(audits).toEqual([{ type: "project.skill.copied", payload: { projectId: project, skillId: expect.stringMatching(/^project-skill-/),
      revision: 1, version: 1, sourceSkillId: personalId, sourceRevision: 4 } }]);
    expect(JSON.stringify(audits)).not.toContain(released.instructions);
  });

  test("rejects a missing, unreleased, or newer personal source without writing", async () => {
    for (const [result, code] of [[[], "personal_source_unavailable"], [[{ ...released, revision: "5" }], "personal_source_changed"]] as const) {
      const { db, store } = setup(statement => statement.includes("FROM personal_skills s") ? rows([...result]) : undefined);
      const error = await store.copyFromPersonal(tenant, owner, project, personalId, 4).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(ProjectSkillSourceError);
      expect((error as ProjectSkillSourceError).code).toBe(code);
      expect(has(db, "INSERT INTO")).toBe(false);
    }
  });

  test("lets only the source member pull a new release into a draft", async () => {
    const locked = (sourceUser: string | null) => setup((statement, params) => {
      if (statement.includes("FROM project_skills WHERE") && statement.includes("FOR UPDATE")) {
        return rows([{ version: 3, latest_revision: 2, active_revision: 1, enabled: true,
          source_user_id: sourceUser, source_skill_id: sourceUser ? personalId : null }]);
      }
      if (statement.includes("FROM personal_skills s JOIN")) { expect(params).toEqual([tenant, owner, personalId]); return rows([released]); }
      if (statement.includes("JOIN project_skill_revisions r")) return rows([]);
      if (statement.includes("INSERT INTO project_skill_revisions")) { expect(params.slice(9)).toEqual([4, hash]); return rows([]); }
      if (statement.includes("UPDATE project_skills SET latest_revision=$4, source_revision=$5")) {
        expect(params).toEqual([tenant, project, id, 3, 4]);
        return rows([]);
      }
      if (statement.includes("DELETE FROM project_skill_revisions")) return rows([]);
      if (statement.includes("FROM project_skills s")) return rows([joined]);
      return undefined;
    });
    for (const sourceUser of ["other-owner", null]) {
      const { db, store } = locked(sourceUser);
      await expect(store.updateFromPersonal(tenant, owner, project, id, 4, 3)).rejects.toMatchObject({
        status: 403, code: "project_skill_source_owner_required" });
      expect(has(db, "FROM personal_skills")).toBe(false);
    }
    const { audits, store } = locked(owner);
    await store.updateFromPersonal(tenant, owner, project, id, 4, 3);
    expect(audits).toEqual([{ type: "project.skill.copied", payload: { projectId: project, skillId: id, revision: 3, version: 4,
      sourceSkillId: personalId, sourceRevision: 4 } }]);
  });
});

describe("ProjectSkillStore runtime changes", () => {
  const lockRow = (statement: string) => statement.includes("FROM project_skills WHERE") && statement.includes("FOR UPDATE")
    ? rows([{ version: 3, latest_revision: 2, active_revision: 1, enabled: true, source_user_id: null, source_skill_id: null }]) : undefined;

  test("rejects release, disable, and delete while project work is active", async () => {
    const { db, audits, store } = setup(lockRow, { idle: false });
    for (const run of [() => store.action(tenant, owner, project, id, "release", 3), () => store.action(tenant, owner, project, id, "disable", 3),
      () => store.remove(tenant, owner, project, id, 3)]) {
      await expect(run()).rejects.toMatchObject({ status: 409, code: "project_busy" });
    }
    expect(db.queries.some(query => /^(UPDATE|DELETE)/.test(query.text.trim()))).toBe(false);
    expect(audits).toEqual([]);
  });

  test("release adds the skill to a custom selection and commits selection and skill audits together", async () => {
    const { db, audits, store } = setup((statement, params) => {
      if (statement.startsWith("UPDATE projects SET capability_selection")) {
        expect(params).toEqual([tenant, project, JSON.stringify({ skillIds: ["pdf", id], connectorIds: ["docs"] }), 8]);
        return rows([]);
      }
      if (statement.includes("SET active_revision=latest_revision, enabled=true")) return rows([]);
      if (statement.includes("FROM project_skills s")) return rows([joined]);
      return lockRow(statement);
    }, { selection: { skillIds: ["pdf"], connectorIds: ["docs"] } });
    await store.action(tenant, owner, project, id, "release", 3);
    expect(audits).toEqual([
      { type: "project_capabilities_changed", payload: { projectId: project,
        selection: { skillIds: ["pdf", id], connectorIds: ["docs"] }, version: 8 } },
      { type: "project.skill.released", payload: { projectId: project, skillId: id, revision: 2, version: 4 } }
    ]);
    expect(outcome(db)).toEqual(["COMMIT"]);
  });

  test.each([
    { name: "inherited", selection: null },
    { name: "already selected", selection: { skillIds: [id], connectorIds: [] } }
  ])("release leaves an $name selection unchanged", async ({ selection }) => {
    const { db, audits, store } = setup(statement => statement.includes("SET active_revision") ? rows([])
      : statement.includes("FROM project_skills s") ? rows([joined]) : lockRow(statement), { selection });
    await store.action(tenant, owner, project, id, "release", 3);
    expect(has(db, "UPDATE projects")).toBe(false);
    expect(audits.map(audit => audit.type)).toEqual(["project.skill.released"]);
  });

  test("rejects release into a full selection before changing the skill", async () => {
    const { db, audits, store } = setup(lockRow,
      { selection: { skillIds: Array.from({ length: 500 }, (_, index) => `skill-${index}`), connectorIds: [] } });
    await expect(store.action(tenant, owner, project, id, "release", 3)).rejects.toBeInstanceOf(ProjectSkillSelectionFullError);
    expect(db.queries.some(query => query.text.trim().startsWith("UPDATE"))).toBe(false);
    expect(audits).toEqual([]);
    expect(outcome(db)).toEqual(["ROLLBACK"]);
  });

  test("disable keeps the selection and delete removes only this skill from it", async () => {
    const { db, audits, store } = setup((statement, params) => {
      if (statement.includes("SET enabled=false")) return rows([]);
      if (statement.startsWith("DELETE FROM project_skills")) { expect(params).toEqual([tenant, project, id]); return rows([]); }
      if (statement.startsWith("UPDATE projects SET capability_selection")) {
        expect(params[2]).toBe(JSON.stringify({ skillIds: ["pdf"], connectorIds: [] }));
        return rows([]);
      }
      if (statement.includes("FROM project_skills s")) return rows([{ ...joined, enabled: false }]);
      return lockRow(statement);
    }, { selection: { skillIds: ["pdf", id], connectorIds: [] } });
    expect((await store.action(tenant, owner, project, id, "disable", 3)).enabled).toBe(false);
    expect(has(db, "UPDATE projects")).toBe(false);
    await store.remove(tenant, owner, project, id, 3);
    expect(audits.map(audit => audit.type)).toEqual(["project.skill.disabled", "project_capabilities_changed", "project.skill.deleted"]);
    await expect(store.remove(tenant, owner, project, id, 2)).rejects.toBeInstanceOf(ProjectSkillConflictError);
  });
});
