import { createHash, randomUUID } from "node:crypto";
import {
  SessionCapabilitySelectionSchema, type PersonalSkillContent, type ProjectSkill,
  type ProjectSkillRevision, type ProjectSkillSource
} from "@cogniplane/shared-types";
import type { PoolClient } from "pg";
import { type Pool, withTenantScope } from "../../lib/db.js";
import type { RuntimeSkillDefinition } from "../admin-config-records.js";
import { AuditEventStore } from "../audit-event-store.js";
import type { AuditEventType } from "../audit-event-types.js";
import { ProjectAccessError, projectRoleSql, requireProjectAccess } from "../project-access.js";
import { projectCapabilityIdleSql } from "../project-store.js";
import { SkillSourceValidationError, validateSkillSource } from "./personal-skill-validation.js";

const MAX_PROJECT_SKILLS = 100;
const MAX_PROJECT_SKILL_REVISIONS = 50;
const MAX_SELECTED_SKILLS = 500;

export class ProjectSkillNotFoundError extends Error {
  constructor() { super("Project skill not found."); }
}
export class ProjectSkillConflictError extends Error {
  constructor(message = "This skill changed. Reload it and try again.") { super(message); }
}
export class ProjectSkillLimitError extends Error {
  constructor() { super(`A project can have at most ${MAX_PROJECT_SKILLS} skills.`); }
}
export class ProjectSkillSelectionFullError extends Error {
  constructor() { super("This project's skill selection is full. Remove a skill from the selection before releasing this one."); }
}
export class ProjectSkillSourceError extends Error {
  constructor(readonly code: "personal_source_unavailable" | "personal_source_changed") {
    super(code === "personal_source_unavailable"
      ? "This personal skill is not released or no longer exists. Release it in your settings, then try again."
      : "Your personal skill has a newer release. Review the current release before you copy it.");
  }
}

type Actor = { tenantId: string; userId: string; projectId: string };
type SkillRow = Record<string, unknown>;
type Snapshot = { content: PersonalSkillContent; validationMessages: string[] };
type Source = { skillId: string; revision: number; hash: string };

const revisionColumns = (alias: string, prefix: string) => `${alias}.revision AS ${prefix}_number,
  ${alias}.name AS ${prefix}_name, ${alias}.description AS ${prefix}_description,
  ${alias}.instructions AS ${prefix}_instructions, ${alias}.validation_messages AS ${prefix}_messages,
  ${alias}.source_revision AS ${prefix}_source_revision, ${alias}.created_at AS ${prefix}_created_at`;
const skillSelect = `SELECT s.skill_id, s.version, s.enabled, s.updated_at,
  s.source_user_id, s.source_skill_id, s.source_revision,
  ${revisionColumns("l", "latest")}, ${revisionColumns("a", "active")}
  FROM project_skills s
  JOIN project_skill_revisions l ON l.tenant_id=s.tenant_id AND l.project_id=s.project_id
    AND l.skill_id=s.skill_id AND l.revision=s.latest_revision
  LEFT JOIN project_skill_revisions a ON a.tenant_id=s.tenant_id AND a.project_id=s.project_id
    AND a.skill_id=s.skill_id AND a.revision=s.active_revision`;

function date(value: unknown): string { return new Date(value as string | Date).toISOString(); }
function contentHash(content: PersonalSkillContent): string {
  return createHash("sha256").update(JSON.stringify([content.name, content.description, content.instructions])).digest("hex");
}
function revision(row: SkillRow, prefix: string): ProjectSkillRevision {
  const copied = row[`${prefix}_source_revision`];
  return { revision: Number(row[`${prefix}_number`]), content: {
    name: String(row[`${prefix}_name`]), description: String(row[`${prefix}_description`]),
    instructions: String(row[`${prefix}_instructions`])
  }, validationMessages: row[`${prefix}_messages`] as string[],
  copiedFromRevision: copied == null ? null : Number(copied), createdAt: date(row[`${prefix}_created_at`]) };
}
function skill(row: SkillRow, userId: string): ProjectSkill {
  const mine = row.source_user_id === userId;
  return { id: String(row.skill_id), version: Number(row.version), enabled: Boolean(row.enabled),
    latest: revision(row, "latest"), active: row.active_number == null ? null : revision(row, "active"),
    // Other members see that a copy exists, not which private library entry it came from.
    copiedFrom: row.source_skill_id == null ? null : {
      mine, personalSkillId: mine ? String(row.source_skill_id) : null, revision: Number(row.source_revision)
    },
    updatedAt: date(row.updated_at) };
}

// The project lock serializes all project skill and selection writers.
// Locking the membership row keeps the owner present until commit.
async function lockOwner(client: PoolClient, actor: Actor): Promise<void> {
  await requireProjectAccess(client, actor, "owner", { lock: true, active: true });
  const member = await client.query(
    "SELECT 1 FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2 FOR KEY SHARE", [actor.tenantId, actor.userId]);
  if (!member.rowCount) throw new ProjectAccessError("project_not_found", "This project is unavailable.", 404);
}
async function assertIdle(client: PoolClient, actor: Actor): Promise<void> {
  const idle = await client.query(`SELECT 1 FROM projects p WHERE p.tenant_id=$1 AND p.project_id=$2 AND ${projectCapabilityIdleSql}`,
    [actor.tenantId, actor.projectId]);
  if (!idle.rowCount) {
    throw new ProjectAccessError("project_busy",
      "Finish active project turns and resolve pending approvals before changing released skills.", 409);
  }
}
async function readSkill(client: PoolClient, actor: Actor, skillId: string): Promise<ProjectSkill> {
  const result = await client.query(`${skillSelect} WHERE s.tenant_id=$1 AND s.project_id=$2 AND s.skill_id=$3`,
    [actor.tenantId, actor.projectId, skillId]);
  if (!result.rowCount) throw new ProjectSkillNotFoundError();
  return skill(result.rows[0], actor.userId);
}
async function lockSkill(client: PoolClient, actor: Actor, skillId: string, version: number): Promise<SkillRow> {
  const result = await client.query(
    `SELECT version, latest_revision, active_revision, enabled, source_user_id, source_skill_id
     FROM project_skills WHERE tenant_id=$1 AND project_id=$2 AND skill_id=$3 FOR UPDATE`,
    [actor.tenantId, actor.projectId, skillId]);
  if (!result.rowCount) throw new ProjectSkillNotFoundError();
  const row = result.rows[0] as SkillRow;
  if (Number(row.version) !== version) throw new ProjectSkillConflictError();
  return row;
}
async function assertUniqueName(client: PoolClient, actor: Actor, name: string, exceptSkillId: string | null): Promise<void> {
  const duplicate = await client.query(
    `SELECT 1 FROM project_skills s
     JOIN project_skill_revisions r ON r.tenant_id=s.tenant_id AND r.project_id=s.project_id
       AND r.skill_id=s.skill_id AND r.revision IN (s.latest_revision, s.active_revision)
     WHERE s.tenant_id=$1 AND s.project_id=$2 AND r.name=$3
       AND ($4::text IS NULL OR s.skill_id<>$4) LIMIT 1`,
    [actor.tenantId, actor.projectId, name, exceptSkillId]);
  if (duplicate.rowCount) throw new SkillSourceValidationError("This project already has a skill with this name.");
}
async function assertCapacity(client: PoolClient, actor: Actor): Promise<void> {
  const count = await client.query("SELECT count(*) AS total FROM project_skills WHERE tenant_id=$1 AND project_id=$2",
    [actor.tenantId, actor.projectId]);
  if (Number(count.rows[0].total) >= MAX_PROJECT_SKILLS) throw new ProjectSkillLimitError();
}
// Reads only the member's own released revision. Drafts and history stay private.
async function releasedPersonal(client: PoolClient, actor: Actor, personalSkillId: string, expectedRevision: number) {
  const result = await client.query(
    `SELECT r.revision, r.name, r.description, r.instructions, r.validation_messages
     FROM personal_skills s JOIN personal_skill_revisions r ON r.tenant_id=s.tenant_id AND r.user_id=s.user_id
       AND r.skill_id=s.skill_id AND r.revision=s.active_revision
     WHERE s.tenant_id=$1 AND s.user_id=$2 AND s.skill_id=$3 AND s.enabled=true`,
    [actor.tenantId, actor.userId, personalSkillId]);
  const row = result.rows[0];
  if (!row) throw new ProjectSkillSourceError("personal_source_unavailable");
  if (Number(row.revision) !== expectedRevision) throw new ProjectSkillSourceError("personal_source_changed");
  const content = { name: String(row.name), description: String(row.description), instructions: String(row.instructions) };
  return { snapshot: { content, validationMessages: row.validation_messages as string[] },
    source: { skillId: personalSkillId, revision: expectedRevision, hash: contentHash(content) } };
}
async function insertRevision(client: PoolClient, actor: Actor, skillId: string, number: number,
  snapshot: Snapshot, source: Source | null): Promise<void> {
  await client.query(
    `INSERT INTO project_skill_revisions
     (tenant_id,project_id,skill_id,revision,name,description,instructions,validation_messages,
      created_by,source_revision,source_content_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`,
    [actor.tenantId, actor.projectId, skillId, number, snapshot.content.name, snapshot.content.description,
      snapshot.content.instructions, JSON.stringify(snapshot.validationMessages), actor.userId,
      source?.revision ?? null, source?.hash ?? null]);
}
async function pruneRevisions(client: PoolClient, actor: Actor, skillId: string, activeRevision: unknown): Promise<void> {
  await client.query(
    `DELETE FROM project_skill_revisions
     WHERE tenant_id=$1 AND project_id=$2 AND skill_id=$3
       AND revision NOT IN (
         SELECT revision FROM project_skill_revisions
         WHERE tenant_id=$1 AND project_id=$2 AND skill_id=$3
         ORDER BY revision DESC LIMIT $4
       ) AND revision IS DISTINCT FROM $5::integer`,
    [actor.tenantId, actor.projectId, skillId,
      activeRevision == null ? MAX_PROJECT_SKILL_REVISIONS : MAX_PROJECT_SKILL_REVISIONS - 1, activeRevision]);
}
async function audit(client: PoolClient, actor: Actor, type: AuditEventType, payload: Record<string, unknown>): Promise<void> {
  await AuditEventStore.createInTransaction(client, { tenantId: actor.tenantId, userId: actor.userId, sessionId: null,
    type, payload: { projectId: actor.projectId, ...payload } });
}
// Custom selections change only through explicit release or removal.
async function changeSelection(client: PoolClient, actor: Actor, skillId: string, include: boolean): Promise<void> {
  const current = await client.query("SELECT capability_selection, capability_version FROM projects WHERE tenant_id=$1 AND project_id=$2",
    [actor.tenantId, actor.projectId]);
  const selection = SessionCapabilitySelectionSchema.nullable().parse(current.rows[0]?.capability_selection ?? null);
  if (!selection || selection.skillIds.includes(skillId) === include) return;
  if (include && selection.skillIds.length >= MAX_SELECTED_SKILLS) throw new ProjectSkillSelectionFullError();
  const updated = { ...selection, skillIds: include
    ? [...selection.skillIds, skillId] : selection.skillIds.filter(id => id !== skillId) };
  const nextVersion = Number(current.rows[0].capability_version) + 1;
  await client.query("UPDATE projects SET capability_selection=$3::jsonb, capability_version=$4 WHERE tenant_id=$1 AND project_id=$2",
    [actor.tenantId, actor.projectId, JSON.stringify(updated), nextVersion]);
  await audit(client, actor, "project_capabilities_changed", { selection: updated, version: nextVersion });
}

export class ProjectSkillStore {
  constructor(private readonly db: Pool) {}

  async list(tenantId: string, userId: string, projectId: string): Promise<{ canEdit: boolean; skills: ProjectSkill[] }> {
    const actor = { tenantId, userId, projectId };
    return withTenantScope(this.db, tenantId, async client => {
      const access = await requireProjectAccess(client, actor);
      const result = await client.query(`${skillSelect} WHERE s.tenant_id=$1 AND s.project_id=$2 ORDER BY s.updated_at DESC, s.skill_id`,
        [tenantId, projectId]);
      return { canEdit: access.role === "owner" && !access.archivedAt, skills: result.rows.map(row => skill(row, userId)) };
    });
  }

  async get(tenantId: string, userId: string, projectId: string, skillId: string): Promise<ProjectSkill> {
    const actor = { tenantId, userId, projectId };
    return withTenantScope(this.db, tenantId, async client => {
      await requireProjectAccess(client, actor);
      return readSkill(client, actor, skillId);
    });
  }

  async history(tenantId: string, userId: string, projectId: string, skillId: string): Promise<ProjectSkillRevision[]> {
    const actor = { tenantId, userId, projectId };
    return withTenantScope(this.db, tenantId, async client => {
      await requireProjectAccess(client, actor);
      const exists = await client.query("SELECT 1 FROM project_skills WHERE tenant_id=$1 AND project_id=$2 AND skill_id=$3",
        [tenantId, projectId, skillId]);
      if (!exists.rowCount) throw new ProjectSkillNotFoundError();
      const result = await client.query(
        `SELECT ${revisionColumns("r", "item")} FROM project_skill_revisions r
         WHERE r.tenant_id=$1 AND r.project_id=$2 AND r.skill_id=$3 ORDER BY r.revision DESC LIMIT $4`,
        [tenantId, projectId, skillId, MAX_PROJECT_SKILL_REVISIONS]);
      return result.rows.map(row => revision(row, "item"));
    });
  }

  async create(tenantId: string, userId: string, projectId: string, source: ProjectSkillSource): Promise<ProjectSkill> {
    const actor = { tenantId, userId, projectId };
    return withTenantScope(this.db, tenantId, async client => {
      await lockOwner(client, actor);
      const validated = validateSkillSource(source, "project");
      await assertUniqueName(client, actor, validated.content.name, null);
      await assertCapacity(client, actor);
      const skillId = `project-skill-${randomUUID()}`;
      await client.query("INSERT INTO project_skills (tenant_id,project_id,skill_id,created_by) VALUES ($1,$2,$3,$4)",
        [tenantId, projectId, skillId, userId]);
      await insertRevision(client, actor, skillId, 1, validated, null);
      await audit(client, actor, "project.skill.created", { skillId, revision: 1, version: 1 });
      return readSkill(client, actor, skillId);
    });
  }

  // Stores an independent draft. Later personal changes never reach the project copy.
  async copyFromPersonal(tenantId: string, userId: string, projectId: string,
    personalSkillId: string, sourceRevision: number): Promise<ProjectSkill> {
    const actor = { tenantId, userId, projectId };
    return withTenantScope(this.db, tenantId, async client => {
      await lockOwner(client, actor);
      const { snapshot, source } = await releasedPersonal(client, actor, personalSkillId, sourceRevision);
      await assertUniqueName(client, actor, snapshot.content.name, null);
      await assertCapacity(client, actor);
      const skillId = `project-skill-${randomUUID()}`;
      await client.query(
        `INSERT INTO project_skills (tenant_id,project_id,skill_id,created_by,source_user_id,source_skill_id,source_revision)
         VALUES ($1,$2,$3,$4,$4,$5,$6)`, [tenantId, projectId, skillId, userId, personalSkillId, sourceRevision]);
      await insertRevision(client, actor, skillId, 1, snapshot, source);
      await audit(client, actor, "project.skill.copied", { skillId, revision: 1, version: 1,
        sourceSkillId: personalSkillId, sourceRevision });
      return readSkill(client, actor, skillId);
    });
  }

  async update(tenantId: string, userId: string, projectId: string, skillId: string,
    source: ProjectSkillSource, version: number): Promise<ProjectSkill> {
    const actor = { tenantId, userId, projectId };
    return withTenantScope(this.db, tenantId, async client => {
      await lockOwner(client, actor);
      const row = await lockSkill(client, actor, skillId, version);
      const validated = validateSkillSource(source, "project");
      await assertUniqueName(client, actor, validated.content.name, skillId);
      const next = Number(row.latest_revision) + 1;
      await insertRevision(client, actor, skillId, next, validated, null);
      await client.query(
        "UPDATE project_skills SET latest_revision=$4, version=version+1, updated_at=now() WHERE tenant_id=$1 AND project_id=$2 AND skill_id=$3",
        [tenantId, projectId, skillId, next]);
      await pruneRevisions(client, actor, skillId, row.active_revision);
      await audit(client, actor, "project.skill.draft_saved", { skillId, revision: next, version: version + 1 });
      return readSkill(client, actor, skillId);
    });
  }

  // Only the member who copied the skill can pull their current release as a new draft.
  async updateFromPersonal(tenantId: string, userId: string, projectId: string, skillId: string,
    sourceRevision: number, version: number): Promise<ProjectSkill> {
    const actor = { tenantId, userId, projectId };
    return withTenantScope(this.db, tenantId, async client => {
      await lockOwner(client, actor);
      const row = await lockSkill(client, actor, skillId, version);
      if (row.source_skill_id == null || row.source_user_id !== userId) {
        throw new ProjectAccessError("project_skill_source_owner_required",
          "Only the member who copied this skill can update it from their personal skill.");
      }
      const { snapshot, source } = await releasedPersonal(client, actor, String(row.source_skill_id), sourceRevision);
      await assertUniqueName(client, actor, snapshot.content.name, skillId);
      const next = Number(row.latest_revision) + 1;
      await insertRevision(client, actor, skillId, next, snapshot, source);
      await client.query(
        `UPDATE project_skills SET latest_revision=$4, source_revision=$5, version=version+1, updated_at=now()
         WHERE tenant_id=$1 AND project_id=$2 AND skill_id=$3`, [tenantId, projectId, skillId, next, sourceRevision]);
      await pruneRevisions(client, actor, skillId, row.active_revision);
      await audit(client, actor, "project.skill.copied", { skillId, revision: next, version: version + 1,
        sourceSkillId: source.skillId, sourceRevision });
      return readSkill(client, actor, skillId);
    });
  }

  async action(tenantId: string, userId: string, projectId: string, skillId: string,
    action: "release" | "disable", version: number): Promise<ProjectSkill> {
    const actor = { tenantId, userId, projectId };
    return withTenantScope(this.db, tenantId, async client => {
      await lockOwner(client, actor);
      const row = await lockSkill(client, actor, skillId, version);
      await assertIdle(client, actor);
      if (action === "release") {
        await changeSelection(client, actor, skillId, true);
        await client.query(
          `UPDATE project_skills SET active_revision=latest_revision, enabled=true, version=version+1, updated_at=now()
           WHERE tenant_id=$1 AND project_id=$2 AND skill_id=$3`, [tenantId, projectId, skillId]);
      } else {
        await client.query(
          "UPDATE project_skills SET enabled=false, version=version+1, updated_at=now() WHERE tenant_id=$1 AND project_id=$2 AND skill_id=$3",
          [tenantId, projectId, skillId]);
      }
      await audit(client, actor, action === "release" ? "project.skill.released" : "project.skill.disabled",
        { skillId, revision: Number(row.latest_revision), version: version + 1 });
      return readSkill(client, actor, skillId);
    });
  }

  async remove(tenantId: string, userId: string, projectId: string, skillId: string, version: number): Promise<void> {
    const actor = { tenantId, userId, projectId };
    await withTenantScope(this.db, tenantId, async client => {
      await lockOwner(client, actor);
      const row = await lockSkill(client, actor, skillId, version);
      await assertIdle(client, actor);
      await client.query("DELETE FROM project_skills WHERE tenant_id=$1 AND project_id=$2 AND skill_id=$3", [tenantId, projectId, skillId]);
      await changeSelection(client, actor, skillId, false);
      await audit(client, actor, "project.skill.deleted", { skillId, revision: Number(row.latest_revision), version: version + 1 });
    });
  }

  // Check the current role in the content query, including after an earlier access check.
  async listRuntimeSkills(tenantId: string, projectId: string, userId: string, forExecution = false): Promise<RuntimeSkillDefinition[]> {
    return withTenantScope(this.db, tenantId, async client => {
      const result = await client.query(
        `SELECT s.skill_id, r.revision, r.name, r.description, r.instructions
         FROM project_skills s
         JOIN projects p ON p.tenant_id=s.tenant_id AND p.project_id=s.project_id
         JOIN project_skill_revisions r ON r.tenant_id=s.tenant_id AND r.project_id=s.project_id
           AND r.skill_id=s.skill_id AND r.revision=s.active_revision
         WHERE s.tenant_id=$1 AND s.project_id=$2 AND s.enabled=true
           AND ${projectRoleSql("p", "$3")} IN ('owner', 'editor'${forExecution ? "" : ", 'viewer'"})
           ${forExecution ? "AND p.archived_at IS NULL" : ""}
         ORDER BY s.skill_id`, [tenantId, projectId, userId]);
      return result.rows.map(row => {
        const id = String(row.skill_id), revisionNumber = Number(row.revision);
        const name = String(row.name), description = String(row.description), instructions = String(row.instructions);
        const hash = createHash("sha256").update(JSON.stringify([id, revisionNumber, name, description, instructions])).digest("hex");
        return { id, name, description, instructions, version: revisionNumber, hash, revisionId: null,
          bundleHash: null, sourceType: "project", bundleName: id, bundleStorageUri: null,
          validationStatus: "valid", reviewStatus: "approved", associatedToolIds: [] };
      });
    });
  }
}
