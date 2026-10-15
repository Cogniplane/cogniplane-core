import { createHash, randomUUID } from "node:crypto";
import { SessionCapabilitySelectionSchema, type PersonalSkill, type PersonalSkillRevision, type PersonalSkillSource } from "@cogniplane/shared-types";
import type { PoolClient } from "pg";
import { type Pool, withTenantScope } from "../../lib/db.js";
import type { RuntimeSkillDefinition } from "../admin-config-records.js";
import { AuditEventStore } from "../audit-event-store.js";
import { PersonalSkillValidationError, validatePersonalSkillSource } from "./personal-skill-validation.js";

const MAX_PERSONAL_SKILLS = 100;
const MAX_PERSONAL_SKILL_REVISIONS = 50;

export class PersonalSkillAccessError extends Error {
  constructor() { super("Your organization membership is no longer available."); }
}
export class PersonalSkillNotFoundError extends Error {
  constructor() { super("Personal skill not found."); }
}
export class PersonalSkillConflictError extends Error {
  constructor(message = "This skill changed. Reload it and try again.") { super(message); }
}
export class PersonalSkillLimitError extends Error {
  constructor() { super(`You can save at most ${MAX_PERSONAL_SKILLS} personal skills.`); }
}
export class PersonalSkillDefaultsFullError extends Error {
  constructor() { super("Your selected skill list is full. Remove one before making this skill available."); }
}

type SkillRow = Record<string, unknown>;
const skillSelect = `SELECT s.skill_id, s.version, s.enabled, s.updated_at,
  l.revision AS latest_number, l.name AS latest_name, l.description AS latest_description,
  l.instructions AS latest_instructions, l.validation_messages AS latest_messages,
  l.created_at AS latest_created_at,
  a.revision AS active_number, a.name AS active_name, a.description AS active_description,
  a.instructions AS active_instructions, a.validation_messages AS active_messages,
  a.created_at AS active_created_at
  FROM personal_skills s
  JOIN personal_skill_revisions l ON l.tenant_id=s.tenant_id AND l.user_id=s.user_id
    AND l.skill_id=s.skill_id AND l.revision=s.latest_revision
  LEFT JOIN personal_skill_revisions a ON a.tenant_id=s.tenant_id AND a.user_id=s.user_id
    AND a.skill_id=s.skill_id AND a.revision=s.active_revision`;

function date(value: unknown): string { return new Date(value as string | Date).toISOString(); }
function revision(row: SkillRow, prefix: "latest" | "active"): PersonalSkillRevision {
  return { revision: Number(row[`${prefix}_number`]), content: {
    name: String(row[`${prefix}_name`]), description: String(row[`${prefix}_description`]),
    instructions: String(row[`${prefix}_instructions`])
  }, validationMessages: row[`${prefix}_messages`] as string[], createdAt: date(row[`${prefix}_created_at`]) };
}
function skill(row: SkillRow): PersonalSkill {
  return { id: String(row.skill_id), version: Number(row.version), enabled: Boolean(row.enabled),
    latest: revision(row, "latest"), active: row.active_number === null ? null : revision(row, "active"),
    updatedAt: date(row.updated_at) };
}
async function member(client: PoolClient, tenantId: string, userId: string, lock: boolean): Promise<void> {
  const result = await client.query(
    `SELECT 1 FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2 ${lock ? "FOR KEY SHARE" : ""}`,
    [tenantId, userId]);
  if (!result.rowCount) throw new PersonalSkillAccessError();
}
// Add or remove one skill in the member's custom defaults. Null defaults follow the catalog.
async function changeDefaults(client: PoolClient, tenantId: string, userId: string, skillId: string,
  include: boolean): Promise<void> {
  const defaults = await client.query(
    "SELECT capability_selection, capability_version FROM personal_capability_defaults WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE",
    [tenantId, userId]);
  const selection = SessionCapabilitySelectionSchema.nullable().parse(defaults.rows[0]?.capability_selection ?? null);
  if (!selection || selection.skillIds.includes(skillId) === include) return;
  if (include && selection.skillIds.length >= 500) throw new PersonalSkillDefaultsFullError();
  const updated = { ...selection, skillIds: include
    ? [...selection.skillIds, skillId] : selection.skillIds.filter(id => id !== skillId) };
  const nextVersion = Number(defaults.rows[0].capability_version) + 1;
  await client.query(
    `UPDATE personal_capability_defaults SET capability_selection=$3::jsonb, capability_version=$4, updated_at=now()
     WHERE tenant_id=$1 AND user_id=$2`, [tenantId, userId, JSON.stringify(updated), nextVersion]);
  await AuditEventStore.createInTransaction(client, { tenantId, userId, sessionId: null,
    type: "personal_capabilities_changed", payload: { selection: updated, version: nextVersion } });
}

async function lockWrites(client: PoolClient, tenantId: string, userId: string): Promise<void> {
  await member(client, tenantId, userId, true);
  // Share the advisory lock with PersonalCapabilityStore.save, including its first insert.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [JSON.stringify(["personal-capabilities", tenantId, userId])]);
}
async function readSkill(client: PoolClient, tenantId: string, userId: string, skillId: string): Promise<PersonalSkill> {
  const result = await client.query(`${skillSelect} WHERE s.tenant_id=$1 AND s.user_id=$2 AND s.skill_id=$3`,
    [tenantId, userId, skillId]);
  if (!result.rowCount) throw new PersonalSkillNotFoundError();
  return skill(result.rows[0]);
}
async function lockSkill(client: PoolClient, tenantId: string, userId: string, skillId: string, version: number): Promise<SkillRow> {
  const result = await client.query(
    "SELECT version, latest_revision, active_revision, enabled FROM personal_skills WHERE tenant_id=$1 AND user_id=$2 AND skill_id=$3 FOR UPDATE",
    [tenantId, userId, skillId]);
  if (!result.rowCount) throw new PersonalSkillNotFoundError();
  const row = result.rows[0] as SkillRow;
  if (Number(row.version) !== version) throw new PersonalSkillConflictError();
  return row;
}
async function assertUniqueName(client: PoolClient, tenantId: string, userId: string,
  name: string, exceptSkillId: string | null): Promise<void> {
  const duplicate = await client.query(
    `SELECT 1 FROM personal_skills s
     JOIN personal_skill_revisions r ON r.tenant_id=s.tenant_id AND r.user_id=s.user_id
       AND r.skill_id=s.skill_id AND r.revision IN (s.latest_revision, s.active_revision)
     WHERE s.tenant_id=$1 AND s.user_id=$2 AND r.name=$3
       AND ($4::text IS NULL OR s.skill_id<>$4) LIMIT 1`,
    [tenantId, userId, name, exceptSkillId]);
  if (duplicate.rowCount) throw new PersonalSkillValidationError("You already have a personal skill with this name.");
}
async function audit(client: PoolClient, tenantId: string, userId: string, skillId: string,
  type: "personal.skill.created" | "personal.skill.draft_saved" | "personal.skill.released" | "personal.skill.disabled" | "personal.skill.deleted",
  revisionNumber: number, version: number): Promise<void> {
  await AuditEventStore.createInTransaction(client, { tenantId, userId, sessionId: null, type,
    payload: { skillId, revision: revisionNumber, version } });
}

export class PersonalSkillStore {
  constructor(private readonly db: Pool) {}

  async list(tenantId: string, userId: string): Promise<PersonalSkill[]> {
    return withTenantScope(this.db, tenantId, async client => {
      await member(client, tenantId, userId, false);
      const result = await client.query(`${skillSelect} WHERE s.tenant_id=$1 AND s.user_id=$2 ORDER BY s.updated_at DESC, s.skill_id`,
        [tenantId, userId]);
      return result.rows.map(skill);
    });
  }

  async get(tenantId: string, userId: string, skillId: string): Promise<PersonalSkill> {
    return withTenantScope(this.db, tenantId, async client => {
      await member(client, tenantId, userId, false);
      return readSkill(client, tenantId, userId, skillId);
    });
  }

  async history(tenantId: string, userId: string, skillId: string): Promise<PersonalSkillRevision[]> {
    return withTenantScope(this.db, tenantId, async client => {
      await member(client, tenantId, userId, false);
      const exists = await client.query("SELECT 1 FROM personal_skills WHERE tenant_id=$1 AND user_id=$2 AND skill_id=$3",
        [tenantId, userId, skillId]);
      if (!exists.rowCount) throw new PersonalSkillNotFoundError();
      const result = await client.query(
        `SELECT revision, name, description, instructions, validation_messages, created_at
         FROM personal_skill_revisions WHERE tenant_id=$1 AND user_id=$2 AND skill_id=$3
         ORDER BY revision DESC LIMIT $4`,
        [tenantId, userId, skillId, MAX_PERSONAL_SKILL_REVISIONS]);
      return result.rows.map(row => ({ revision: Number(row.revision), content: {
        name: String(row.name), description: String(row.description), instructions: String(row.instructions)
      }, validationMessages: row.validation_messages as string[], createdAt: date(row.created_at) }));
    });
  }

  async create(tenantId: string, userId: string, source: PersonalSkillSource): Promise<PersonalSkill> {
    return withTenantScope(this.db, tenantId, async client => {
      await lockWrites(client, tenantId, userId);
      const validated = validatePersonalSkillSource(source);
      await assertUniqueName(client, tenantId, userId, validated.content.name, null);
      const count = await client.query("SELECT count(*) AS total FROM personal_skills WHERE tenant_id=$1 AND user_id=$2", [tenantId, userId]);
      if (Number(count.rows[0].total) >= MAX_PERSONAL_SKILLS) throw new PersonalSkillLimitError();
      const skillId = `personal-skill-${randomUUID()}`;
      await client.query("INSERT INTO personal_skills (tenant_id,user_id,skill_id) VALUES ($1,$2,$3)", [tenantId, userId, skillId]);
      await client.query(
        `INSERT INTO personal_skill_revisions
         (tenant_id,user_id,skill_id,revision,name,description,instructions,validation_messages)
         VALUES ($1,$2,$3,1,$4,$5,$6,$7::jsonb)`, [tenantId, userId, skillId, validated.content.name,
          validated.content.description, validated.content.instructions, JSON.stringify(validated.validationMessages)]);
      await audit(client, tenantId, userId, skillId, "personal.skill.created", 1, 1);
      return readSkill(client, tenantId, userId, skillId);
    });
  }

  async update(tenantId: string, userId: string, skillId: string, source: PersonalSkillSource, version: number): Promise<PersonalSkill> {
    return withTenantScope(this.db, tenantId, async client => {
      await lockWrites(client, tenantId, userId);
      const row = await lockSkill(client, tenantId, userId, skillId, version);
      const validated = validatePersonalSkillSource(source);
      await assertUniqueName(client, tenantId, userId, validated.content.name, skillId);
      const nextRevision = Number(row.latest_revision) + 1;
      await client.query(
        `INSERT INTO personal_skill_revisions
         (tenant_id,user_id,skill_id,revision,name,description,instructions,validation_messages)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [tenantId, userId, skillId, nextRevision,
          validated.content.name, validated.content.description, validated.content.instructions,
          JSON.stringify(validated.validationMessages)]);
      await client.query(
        "UPDATE personal_skills SET latest_revision=$4, version=version+1, updated_at=now() WHERE tenant_id=$1 AND user_id=$2 AND skill_id=$3",
        [tenantId, userId, skillId, nextRevision]);
      await client.query(
        `DELETE FROM personal_skill_revisions
         WHERE tenant_id=$1 AND user_id=$2 AND skill_id=$3
           AND revision NOT IN (
             SELECT revision FROM personal_skill_revisions
             WHERE tenant_id=$1 AND user_id=$2 AND skill_id=$3
             ORDER BY revision DESC LIMIT $4
           ) AND revision IS DISTINCT FROM $5::integer`,
        [tenantId, userId, skillId, row.active_revision == null ? MAX_PERSONAL_SKILL_REVISIONS : MAX_PERSONAL_SKILL_REVISIONS - 1,
          row.active_revision]);
      await audit(client, tenantId, userId, skillId, "personal.skill.draft_saved", nextRevision, version + 1);
      return readSkill(client, tenantId, userId, skillId);
    });
  }

  async action(tenantId: string, userId: string, skillId: string, action: "release" | "disable", version: number): Promise<PersonalSkill> {
    return withTenantScope(this.db, tenantId, async client => {
      await lockWrites(client, tenantId, userId);
      const row = await lockSkill(client, tenantId, userId, skillId, version);
      if (action === "release") {
        await changeDefaults(client, tenantId, userId, skillId, true);
        await client.query(
          `UPDATE personal_skills SET active_revision=latest_revision, enabled=true, version=version+1, updated_at=now()
           WHERE tenant_id=$1 AND user_id=$2 AND skill_id=$3`, [tenantId, userId, skillId]);
        await audit(client, tenantId, userId, skillId, "personal.skill.released", Number(row.latest_revision), version + 1);
      } else {
        await client.query(
          "UPDATE personal_skills SET enabled=false, version=version+1, updated_at=now() WHERE tenant_id=$1 AND user_id=$2 AND skill_id=$3",
          [tenantId, userId, skillId]);
        await audit(client, tenantId, userId, skillId, "personal.skill.disabled", Number(row.latest_revision), version + 1);
      }
      return readSkill(client, tenantId, userId, skillId);
    });
  }

  async remove(tenantId: string, userId: string, skillId: string, version: number): Promise<void> {
    await withTenantScope(this.db, tenantId, async client => {
      await lockWrites(client, tenantId, userId);
      const row = await lockSkill(client, tenantId, userId, skillId, version);
      await client.query("DELETE FROM personal_skills WHERE tenant_id=$1 AND user_id=$2 AND skill_id=$3", [tenantId, userId, skillId]);
      await changeDefaults(client, tenantId, userId, skillId, false);
      await audit(client, tenantId, userId, skillId, "personal.skill.deleted", Number(row.latest_revision), version + 1);
    });
  }

  async listRuntimeSkills(tenantId: string, userId: string): Promise<RuntimeSkillDefinition[]> {
    return withTenantScope(this.db, tenantId, async client => {
      const result = await client.query(
        `SELECT s.skill_id, r.revision, r.name, r.description, r.instructions
         FROM personal_skills s
         JOIN tenant_memberships m ON m.tenant_id=s.tenant_id AND m.user_id=s.user_id
         JOIN personal_skill_revisions r ON r.tenant_id=s.tenant_id AND r.user_id=s.user_id
           AND r.skill_id=s.skill_id AND r.revision=s.active_revision
         WHERE s.tenant_id=$1 AND s.user_id=$2 AND s.enabled=true ORDER BY s.skill_id`, [tenantId, userId]);
      return result.rows.map(row => {
        const id = String(row.skill_id), revisionNumber = Number(row.revision);
        const name = String(row.name), description = String(row.description), instructions = String(row.instructions);
        const hash = createHash("sha256").update(JSON.stringify([id, revisionNumber, name, description, instructions])).digest("hex");
        return { id, name, description, instructions, version: revisionNumber, hash, revisionId: null,
          bundleHash: null, sourceType: "personal", bundleName: id, bundleStorageUri: null,
          validationStatus: "valid", reviewStatus: "approved", associatedToolIds: [] };
      });
    });
  }
}
