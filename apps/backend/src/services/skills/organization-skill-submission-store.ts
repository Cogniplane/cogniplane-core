import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { OrganizationSkillSubmission, OrganizationSkillSubmissionDetail,
  OrganizationSkillSubmissionUpdate, AdminSkillReleaseSnapshot } from "@cogniplane/shared-types";
import { type Pool, withTenantScope } from "../../lib/db.js";
import { canActivateRevision } from "../../domain/skill-lifecycle.js";
import { AuditEventStore } from "../audit-event-store.js";
import type { AuditEventType } from "../audit-event-types.js";
import { lockOrganizationSkillNames } from "./organization-skill-name-lock.js";
import { assertSkillReleaseSnapshot, skillReleaseSnapshot, SkillReleaseSnapshotConflictError } from "./skill-release-impact-store.js";

type Row = Record<string, unknown>;
export class SubmissionAccessError extends Error { constructor() { super("Organization membership or reviewer role is required."); } }
export class SubmissionNotFoundError extends Error { constructor() { super("Submission not found."); } }
export class SubmissionConflictError extends Error { constructor(message = "This submission or organization skill changed. Reload and try again.") { super(message); } }
export class SubmissionValidationError extends Error { constructor(message: string) { super(message); } }
const iso = (value: unknown) => new Date(value as string | Date).toISOString();
const hash = (content: { name: string; description: string; instructions: string }) =>
  createHash("sha256").update(JSON.stringify([content.name, content.description, content.instructions])).digest("hex");
const reviewer = (role: string) => role === "admin" || role === "owner";
const skillIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

async function membership(client: PoolClient, tenantId: string, userId: string, lock: boolean): Promise<string> {
  const result = await client.query(`SELECT role FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2 ${lock ? "FOR SHARE" : ""}`,
    [tenantId, userId]);
  if (!result.rowCount) throw new SubmissionAccessError();
  return String(result.rows[0].role);
}
async function sourceSnapshot(client: PoolClient, tenantId: string, userId: string, skillId: string, revision: number) {
  const found = await client.query(`SELECT r.name,r.description,r.instructions,r.validation_messages
    FROM personal_skill_revisions r JOIN personal_skills s ON s.tenant_id=r.tenant_id AND s.user_id=r.user_id AND s.skill_id=r.skill_id
    WHERE r.tenant_id=$1 AND r.user_id=$2 AND r.skill_id=$3 AND r.revision=$4 FOR SHARE OF r,s`,
  [tenantId, userId, skillId, revision]);
  if (!found.rowCount) throw new SubmissionNotFoundError();
  const row = found.rows[0];
  const content = { name: String(row.name), description: String(row.description), instructions: String(row.instructions) };
  return { ...content, hash: hash(content), messages: row.validation_messages as string[] };
}
function attempt(row: Row) {
  return {
    attempt: Number(row.attempt), status: String(row.attempt_status) as OrganizationSkillSubmission["status"],
    note: String(row.note), snapshot: { content: { name: String(row.source_name), description: String(row.source_description),
      instructions: String(row.source_instructions) }, sourceRevision: Number(row.source_revision),
      contentHash: String(row.content_hash), validationMessages: row.validation_messages as string[] },
    submittedAt: iso(row.submitted_at), decidedAt: row.decided_at ? iso(row.decided_at) : null,
    decidedBy: row.decided_by === null ? null : String(row.decided_by),
    decidedByName: row.decider_name === null ? null : String(row.decider_name),
    feedback: row.feedback === null ? null : String(row.feedback),
    acceptedRevisionId: row.accepted_revision_id === null ? null : Number(row.accepted_revision_id)
  };
}
function summary(row: Row): OrganizationSkillSubmission {
  return { id: String(row.submission_id), version: Number(row.version), status: String(row.status) as OrganizationSkillSubmission["status"],
    authorUserId: String(row.author_user_id), authorName: String(row.author_name ?? row.author_user_id),
    authorEmail: row.author_email === null ? null : String(row.author_email),
    sourceSkillId: String(row.source_skill_id), targetOrganizationSkillId: row.target_skill_id === null ? null : String(row.target_skill_id),
    acceptedOrganizationSkillId: row.accepted_skill_id === null ? null : String(row.accepted_skill_id),
    latest: attempt(row), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}
const base = `SELECT s.*, a.attempt, a.status AS attempt_status, a.note, a.source_revision, a.source_name,
 a.source_description, a.source_instructions, a.content_hash, a.validation_messages, a.submitted_at,
 a.decided_at, a.decided_by, a.feedback, a.accepted_revision_id,
 COALESCE(NULLIF(au.display_name,''), au.email, s.author_user_id) AS author_name, au.email AS author_email,
 COALESCE(NULLIF(du.display_name,''), du.email, a.decided_by) AS decider_name
 FROM organization_skill_submissions s
 JOIN organization_skill_submission_attempts a ON a.tenant_id=s.tenant_id AND a.submission_id=s.submission_id AND a.attempt=s.latest_attempt
 LEFT JOIN users au ON au.user_id=s.author_user_id
 LEFT JOIN users du ON du.user_id=a.decided_by`;
async function selectSummary(client: PoolClient, tenantId: string, id: string) {
  const result = await client.query(`${base} WHERE s.tenant_id=$1 AND s.submission_id=$2`, [tenantId, id]);
  if (!result.rowCount) throw new SubmissionNotFoundError();
  return summary(result.rows[0]);
}
async function lockedSubmission(client: PoolClient, tenantId: string, id: string, version: number) {
  const result = await client.query(`SELECT * FROM organization_skill_submissions WHERE tenant_id=$1 AND submission_id=$2 FOR UPDATE`, [tenantId, id]);
  if (!result.rowCount) throw new SubmissionNotFoundError();
  const row = result.rows[0] as Row;
  if (Number(row.version) !== version) throw new SubmissionConflictError();
  return row;
}
async function audit(client: PoolClient, tenantId: string, userId: string, type: AuditEventType, payload: Record<string, unknown>) {
  await AuditEventStore.createInTransaction(client, { tenantId, userId, sessionId: null, type, payload });
}
function authorUpdate(row: Row): OrganizationSkillSubmissionUpdate {
  return { id:String(row.update_id), submissionId:String(row.submission_id), attempt:Number(row.attempt),
    kind:String(row.kind) as OrganizationSkillSubmissionUpdate["kind"], skillName:String(row.skill_name),
    feedback:row.feedback === null ? null : String(row.feedback),
    organizationSkillId:row.organization_skill_id === null ? null : String(row.organization_skill_id),
    organizationRevisionId:row.organization_revision_id === null ? null : Number(row.organization_revision_id),
    audience:row.audience === null ? null : String(row.audience) as "test-users" | "members",
    createdAt:iso(row.created_at), readAt:row.read_at === null ? null : iso(row.read_at) };
}
async function unreadCount(client: PoolClient, tenantId: string, userId: string): Promise<number> {
  const result = await client.query(`SELECT count(*)::integer AS count FROM organization_skill_author_updates
    WHERE tenant_id=$1 AND recipient_user_id=$2 AND read_at IS NULL`, [tenantId,userId]);
  return Number(result.rows[0].count);
}
export async function insertAuthorUpdate(client: PoolClient, input: {
  tenantId:string; recipientUserId:string; submissionId:string; attempt:number;
  kind:OrganizationSkillSubmissionUpdate["kind"]; skillName:string; feedback:string|null;
  organizationSkillId:string|null; organizationRevisionId:number|null;
  audience:"test-users"|"members"|null;
}) {
  // A 'released' update is sent once per revision and audience. Re-activating the
  // same revision notifies the author only when the audience changes. Callers hold
  // the admin_skills row lock, so the NOT EXISTS check cannot race.
  await client.query(`INSERT INTO organization_skill_author_updates
    (tenant_id,update_id,recipient_user_id,submission_id,attempt,kind,skill_name,feedback,
     organization_skill_id,organization_revision_id,audience)
    SELECT $1::text,$2::uuid,$3::text,$4::uuid,$5::int,$6::text,$7::text,$8::text,$9::text,$10::bigint,$11::text
    WHERE $6::text <> 'released' OR NOT EXISTS (SELECT 1 FROM organization_skill_author_updates
      WHERE tenant_id=$1::text AND submission_id=$4::uuid AND attempt=$5::int AND kind='released'
        AND organization_revision_id IS NOT DISTINCT FROM $10::bigint AND audience IS NOT DISTINCT FROM $11::text)
    ON CONFLICT DO NOTHING`, [input.tenantId,randomUUID(),input.recipientUserId,input.submissionId,input.attempt,
      input.kind,input.skillName,input.feedback,input.organizationSkillId,input.organizationRevisionId,input.audience]);
}

export class OrganizationSkillSubmissionStore {
  constructor(private readonly db: Pool) {}
  async listUpdates(tenantId:string,userId:string,limit:number,before?:string) {
    return withTenantScope(this.db,tenantId,async client=>{
      await membership(client,tenantId,userId,false);
      let cursor: Row | null = null;
      if (before) {
        const found = await client.query(`SELECT created_at,update_id FROM organization_skill_author_updates
          WHERE tenant_id=$1 AND recipient_user_id=$2 AND update_id=$3`,[tenantId,userId,before]);
        if (!found.rowCount) throw new SubmissionNotFoundError();
        cursor=found.rows[0];
      }
      const rows=await client.query(`SELECT * FROM organization_skill_author_updates
        WHERE tenant_id=$1 AND recipient_user_id=$2
          AND ($3::timestamptz IS NULL OR (created_at,update_id)<($3::timestamptz,$4::uuid))
        ORDER BY created_at DESC,update_id DESC LIMIT $5`,
      [tenantId,userId,cursor?.created_at ?? null,cursor?.update_id ?? null,limit+1]);
      const page=rows.rows.slice(0,limit).map(authorUpdate);
      return {updates:page,unreadCount:await unreadCount(client,tenantId,userId),
        nextCursor:rows.rows.length>limit ? page[page.length-1].id : null};
    });
  }
  async readUpdate(tenantId:string,userId:string,id:string) {
    return withTenantScope(this.db,tenantId,async client=>{
      await membership(client,tenantId,userId,false);
      const result=await client.query(`UPDATE organization_skill_author_updates SET read_at=COALESCE(read_at,now())
        WHERE tenant_id=$1 AND recipient_user_id=$2 AND update_id=$3 RETURNING read_at`,[tenantId,userId,id]);
      if (!result.rowCount) throw new SubmissionNotFoundError();
      return {id,readAt:iso(result.rows[0].read_at),unreadCount:await unreadCount(client,tenantId,userId)};
    });
  }
  async list(tenantId: string, userId: string, admin: boolean): Promise<OrganizationSkillSubmission[]> {
    return withTenantScope(this.db, tenantId, async client => {
      const role = await membership(client, tenantId, userId, true);
      if (admin && !reviewer(role)) throw new SubmissionAccessError();
      const rows = await client.query(`${base} WHERE s.tenant_id=$1 ${admin ? "" : "AND s.author_user_id=$2"}
        ORDER BY s.updated_at DESC, s.submission_id`, admin ? [tenantId] : [tenantId, userId]);
      return rows.rows.map(summary);
    });
  }
  async get(tenantId: string, userId: string, id: string, admin: boolean): Promise<OrganizationSkillSubmissionDetail> {
    return withTenantScope(this.db, tenantId, async client => {
      const role = await membership(client, tenantId, userId, true);
      if (admin && !reviewer(role)) throw new SubmissionAccessError();
      const item = await selectSummary(client, tenantId, id);
      if (!admin && item.authorUserId !== userId) throw new SubmissionNotFoundError();
      const rows = await client.query(`SELECT a.*, a.status AS attempt_status,
        COALESCE(NULLIF(u.display_name,''),u.email,a.decided_by) AS decider_name
        FROM organization_skill_submission_attempts a LEFT JOIN users u ON u.user_id=a.decided_by
        WHERE a.tenant_id=$1 AND a.submission_id=$2 ORDER BY a.attempt DESC`, [tenantId, id]);
      let organizationSkill: OrganizationSkillSubmissionDetail["organizationSkill"] = null;
      if (admin) {
        const target = item.acceptedOrganizationSkillId ?? item.targetOrganizationSkillId;
        if (target) {
          const org = await client.query(`SELECT s.skill_id,s.version,s.enabled,s.is_published,s.active_revision_id,
            ar.metadata AS active_metadata, dr.skill_revision_id AS draft_id, dr.metadata AS draft_metadata,
            dr.review_status AS draft_status
            FROM admin_skills s LEFT JOIN admin_skill_revisions ar ON ar.skill_revision_id=s.active_revision_id
            LEFT JOIN LATERAL (SELECT skill_revision_id,metadata,review_status FROM admin_skill_revisions
              WHERE tenant_id=s.tenant_id AND skill_id=s.skill_id ORDER BY revision_number DESC LIMIT 1) dr ON true
            WHERE s.tenant_id=$1 AND s.skill_id=$2`, [tenantId, target]);
          if (org.rowCount) {
            const row = org.rows[0];
            const content = (meta: Record<string, unknown> | null) => meta && typeof meta.instructions === "string"
              ? { name: String(meta.skillName ?? ""), description: String(meta.description ?? ""), instructions: meta.instructions } : null;
            const hasDraft = row.draft_status === "pending_review";
            organizationSkill = { skillId: String(row.skill_id), version: Number(row.version), enabled: Boolean(row.enabled),
              isPublished: Boolean(row.is_published), activeRevisionId: row.active_revision_id === null ? null : Number(row.active_revision_id),
              currentDraftRevisionId: hasDraft ? Number(row.draft_id) : null,
              activeContent: content(row.active_metadata), currentDraftContent: hasDraft ? content(row.draft_metadata) : null };
          }
        }
      }
      const updates=admin ? [] : (await client.query(`SELECT * FROM organization_skill_author_updates
        WHERE tenant_id=$1 AND submission_id=$2 AND recipient_user_id=$3
        ORDER BY created_at DESC,update_id DESC`,[tenantId,id,userId])).rows.map(authorUpdate);
      return { ...item, attempts: rows.rows.map(attempt), updates, organizationSkill };
    });
  }
  async create(tenantId: string, userId: string, skillId: string, revision: number, note: string, target: string | null) {
    return withTenantScope(this.db, tenantId, async client => {
      await membership(client, tenantId, userId, true);
      const snap = await sourceSnapshot(client, tenantId, userId, skillId, revision);
      if (target) {
        const linked = await client.query(`SELECT 1 FROM organization_skill_submissions WHERE tenant_id=$1 AND author_user_id=$2
          AND source_skill_id=$3 AND accepted_skill_id=$4 AND status='accepted' LIMIT 1`, [tenantId, userId, skillId, target]);
        if (!linked.rowCount) throw new SubmissionConflictError("Only the source of an accepted organization copy can propose its update.");
        const org = await client.query("SELECT 1 FROM admin_skills WHERE tenant_id=$1 AND skill_id=$2", [tenantId, target]);
        if (!org.rowCount) throw new SubmissionConflictError("The organization copy no longer exists.");
      }
      const id = randomUUID();
      try {
        await client.query(`INSERT INTO organization_skill_submissions
          (tenant_id,submission_id,author_user_id,source_skill_id,target_skill_id) VALUES ($1,$2,$3,$4,$5)`,
        [tenantId,id,userId,skillId,target]);
      } catch (error) { if ((error as { code?: string }).code === "23505") throw new SubmissionConflictError("A submission from this skill is already pending."); throw error; }
      await client.query(`INSERT INTO organization_skill_submission_attempts
        (tenant_id,submission_id,attempt,status,note,source_revision,source_name,source_description,source_instructions,content_hash,validation_messages)
        VALUES ($1,$2,1,'pending',$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [tenantId,id,note,revision,snap.name,snap.description,snap.instructions,snap.hash,JSON.stringify(snap.messages)]);
      await audit(client, tenantId, userId, "organization.skill_submission.created", { submissionId:id, sourceSkillId:skillId, sourceRevision:revision, targetSkillId:target });
      return id;
    });
  }
  async withdraw(tenantId: string, userId: string, id: string, version: number) {
    await withTenantScope(this.db, tenantId, async client => {
      await membership(client, tenantId, userId, true);
      const row = await lockedSubmission(client, tenantId, id, version);
      if (row.author_user_id !== userId) throw new SubmissionNotFoundError();
      if (row.status !== "pending" && row.status !== "changes_requested")
        throw new SubmissionConflictError("Only an open submission can be withdrawn.");
      await client.query("UPDATE organization_skill_submissions SET status='withdrawn',version=version+1,updated_at=now() WHERE tenant_id=$1 AND submission_id=$2", [tenantId,id]);
      await client.query("UPDATE organization_skill_submission_attempts SET status='withdrawn',decided_at=now() WHERE tenant_id=$1 AND submission_id=$2 AND attempt=$3", [tenantId,id,row.latest_attempt]);
      await audit(client, tenantId, userId, "organization.skill_submission.withdrawn", { submissionId:id, attempt:row.latest_attempt });
    });
  }
  async resubmit(tenantId: string, userId: string, id: string, version: number, revision: number, note: string) {
    try {
      await withTenantScope(this.db, tenantId, async client => {
      await membership(client, tenantId, userId, true);
      const row = await lockedSubmission(client, tenantId, id, version);
      if (row.author_user_id !== userId) throw new SubmissionNotFoundError();
      if (row.status !== "changes_requested") throw new SubmissionConflictError("Changes were not requested for this submission.");
      const snap = await sourceSnapshot(client, tenantId, userId, String(row.source_skill_id), revision);
      const next = Number(row.latest_attempt) + 1;
      await client.query(`INSERT INTO organization_skill_submission_attempts
        (tenant_id,submission_id,attempt,status,note,source_revision,source_name,source_description,source_instructions,content_hash,validation_messages)
        VALUES ($1,$2,$3,'pending',$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [tenantId,id,next,note,revision,snap.name,snap.description,snap.instructions,snap.hash,JSON.stringify(snap.messages)]);
      await client.query("UPDATE organization_skill_submissions SET status='pending',latest_attempt=$3,version=version+1,updated_at=now() WHERE tenant_id=$1 AND submission_id=$2", [tenantId,id,next]);
      await audit(client, tenantId, userId, "organization.skill_submission.resubmitted", { submissionId:id, attempt:next, sourceRevision:revision });
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new SubmissionConflictError("Another submission from this skill is open.");
      throw error;
    }
  }
  async decide(tenantId: string, userId: string, id: string, input: {
    version: number; action: "request_changes" | "decline" | "accept"; reason: string | null;
    organizationSkillId: string | null; organizationSkillName: string | null; expectedOrganizationVersion: number | null;
  }) {
    try {
      await withTenantScope(this.db, tenantId, async client => {
      const role = await membership(client, tenantId, userId, true);
      if (!reviewer(role)) throw new SubmissionAccessError();
      const row = await lockedSubmission(client, tenantId, id, input.version);
      if (row.status !== "pending") throw new SubmissionConflictError("This submission is no longer pending.");
      if (input.action !== "accept" && !input.reason) throw new SubmissionValidationError("Add a reason for this decision.");
      let acceptedId: string | null = null;
      let revisionId: number | null = null;
      if (input.action === "accept") {
        await lockOrganizationSkillNames(client, tenantId);
        const target = row.target_skill_id === null ? input.organizationSkillId : String(row.target_skill_id);
        if (!target || !skillIdPattern.test(target) || target.length > 64 || !input.organizationSkillName) {
          throw new SubmissionValidationError("Choose a valid organization skill ID and name.");
        }
        if (row.target_skill_id !== null && input.organizationSkillId !== null && input.organizationSkillId !== row.target_skill_id) {
          throw new SubmissionConflictError("An update cannot change its organization target.");
        }
        const attempt = await client.query(`SELECT * FROM organization_skill_submission_attempts
          WHERE tenant_id=$1 AND submission_id=$2 AND attempt=$3 FOR UPDATE`, [tenantId,id,row.latest_attempt]);
        const source = attempt.rows[0];
        if (row.target_skill_id === null) {
          if (input.expectedOrganizationVersion !== null) throw new SubmissionConflictError();
          const collision = await client.query(`SELECT 1 FROM admin_skills WHERE skill_id=$1 AND tenant_id IN ($2,'system') LIMIT 1`, [target,tenantId]);
          if (collision.rowCount) throw new SubmissionConflictError("This organization skill ID is already in use.");
          const nameCollision = await client.query(`SELECT 1 FROM admin_skills WHERE tenant_id IN ($1,'system') AND lower(skill_name)=lower($2) LIMIT 1`, [tenantId,input.organizationSkillName]);
          if (nameCollision.rowCount) throw new SubmissionConflictError("This organization skill name is already in use.");
          await client.query(`INSERT INTO admin_skills (tenant_id,skill_id,skill_name,description,version,enabled,is_published,created_by)
            VALUES ($1,$2,$3,$4,0,false,false,$5)`, [tenantId,target,input.organizationSkillName,source.source_description,userId]);
        } else {
          const org = await client.query("SELECT version FROM admin_skills WHERE tenant_id=$1 AND skill_id=$2 FOR UPDATE", [tenantId,target]);
          if (!org.rowCount || input.expectedOrganizationVersion !== Number(org.rows[0].version)) throw new SubmissionConflictError();
          const newest = await client.query(`SELECT review_status FROM admin_skill_revisions WHERE tenant_id=$1 AND skill_id=$2
            ORDER BY revision_number DESC LIMIT 1`, [tenantId,target]);
          if (newest.rows[0]?.review_status === "pending_review") throw new SubmissionConflictError("Review the current organization draft before accepting another update.");
          const nameCollision = await client.query(`SELECT 1 FROM admin_skills WHERE tenant_id IN ($1,'system') AND skill_id<>$2 AND lower(skill_name)=lower($3) LIMIT 1`, [tenantId,target,input.organizationSkillName]);
          if (nameCollision.rowCount) throw new SubmissionConflictError("This organization skill name is already in use.");
        }
        const count = await client.query("SELECT COALESCE(MAX(revision_number),0)+1 AS next FROM admin_skill_revisions WHERE tenant_id=$1 AND skill_id=$2", [tenantId,target]);
        const number = Number(count.rows[0].next);
        const metadata = { skillName:input.organizationSkillName, description:String(source.source_description), instructions:String(source.source_instructions),
          organizationSubmissionId:id, organizationSubmissionAttempt:Number(row.latest_attempt), sourceSkillId:String(row.source_skill_id),
          sourceRevision:Number(source.source_revision), contentHash:String(source.content_hash) };
        const inserted = await client.query(`INSERT INTO admin_skill_revisions
          (tenant_id,skill_id,revision_number,source_type,source_label,bundle_name,bundle_hash,validation_status,
           validation_messages,review_status,metadata,created_by,reviewed_by,reviewed_at)
          VALUES ($1,$2,$3,'inline','member submission',$2,$4,$8,$5::jsonb,'pending_review',$6::jsonb,$7,$7,now()) RETURNING skill_revision_id`,
        [tenantId,target,number,String(source.content_hash),JSON.stringify((source.validation_messages as string[]).map(message => ({ level:"warning", message }))),JSON.stringify(metadata),userId,
          (source.validation_messages as string[]).length ? "validated_with_warnings" : "validated"]);
        acceptedId = target;
        revisionId = Number(inserted.rows[0].skill_revision_id);
      }
      const status = input.action === "request_changes" ? "changes_requested" : input.action === "decline" ? "declined" : "accepted";
      await client.query(`UPDATE organization_skill_submissions SET status=$3,accepted_skill_id=$4,version=version+1,updated_at=now()
        WHERE tenant_id=$1 AND submission_id=$2`, [tenantId,id,status,acceptedId]);
      await client.query(`UPDATE organization_skill_submission_attempts SET status=$4,decided_at=now(),decided_by=$5,feedback=$6,accepted_revision_id=$7
        WHERE tenant_id=$1 AND submission_id=$2 AND attempt=$3`, [tenantId,id,row.latest_attempt,status,userId,input.reason,revisionId]);
      await audit(client, tenantId, userId, `organization.skill_submission.${status}` as AuditEventType, {
        submissionId:id, attempt:row.latest_attempt, organizationSkillId:acceptedId, revisionId });
      const decidedAttempt=await client.query(`SELECT source_name FROM organization_skill_submission_attempts
        WHERE tenant_id=$1 AND submission_id=$2 AND attempt=$3`,[tenantId,id,row.latest_attempt]);
      await insertAuthorUpdate(client,{tenantId,recipientUserId:String(row.author_user_id),submissionId:id,
        attempt:Number(row.latest_attempt),kind:status,skillName:input.action === "accept" ? input.organizationSkillName! : String(decidedAttempt.rows[0].source_name),
        feedback:input.reason,organizationSkillId:acceptedId,organizationRevisionId:revisionId,audience:null});
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new SubmissionConflictError("The organization skill or submission changed. Reload and try again.");
      throw error;
    }
  }
  async release(tenantId: string, userId: string, id: string, input: {
    expectedOrganizationVersion: number; expectedActiveRevisionId: number | null;
    expectedDraftRevisionId: number; audience: "test-users" | "members";
    expectedSnapshot?: AdminSkillReleaseSnapshot;
  }) {
    await withTenantScope(this.db, tenantId, async client => {
      const role = await membership(client, tenantId, userId, true);
      if (!reviewer(role)) throw new SubmissionAccessError();
      const submission = await client.query(`SELECT accepted_skill_id,latest_attempt,status,author_user_id FROM organization_skill_submissions
        WHERE tenant_id=$1 AND submission_id=$2`, [tenantId,id]);
      if (!submission.rowCount) throw new SubmissionNotFoundError();
      const sub = submission.rows[0];
      if (sub.status !== "accepted" || !sub.accepted_skill_id) throw new SubmissionConflictError("Accept the submission before release.");
      const skillId = String(sub.accepted_skill_id);
      await lockOrganizationSkillNames(client, tenantId);
      const newestAcceptance = await client.query(`SELECT s.submission_id FROM organization_skill_submissions s
        JOIN organization_skill_submission_attempts a ON a.tenant_id=s.tenant_id AND a.submission_id=s.submission_id
        JOIN admin_skill_revisions r ON r.skill_revision_id=a.accepted_revision_id
        WHERE s.tenant_id=$1 AND s.accepted_skill_id=$2 AND s.status='accepted'
        ORDER BY r.revision_number DESC LIMIT 1`, [tenantId,skillId]);
      if (newestAcceptance.rows[0]?.submission_id !== id) throw new SubmissionConflictError("A newer accepted submission owns this organization draft.");
      const org = await client.query(`SELECT version,active_revision_id,enabled,is_published FROM admin_skills
        WHERE tenant_id=$1 AND skill_id=$2 FOR UPDATE`, [tenantId,skillId]);
      if (!org.rowCount || Number(org.rows[0].version) !== input.expectedOrganizationVersion ||
          (org.rows[0].active_revision_id === null ? null : Number(org.rows[0].active_revision_id)) !== input.expectedActiveRevisionId) {
        throw new SubmissionConflictError();
      }
      const latest = await client.query(`SELECT * FROM admin_skill_revisions WHERE tenant_id=$1 AND skill_id=$2
        ORDER BY revision_number DESC LIMIT 1 FOR UPDATE`, [tenantId,skillId]);
      try { assertSkillReleaseSnapshot(skillReleaseSnapshot(org.rows[0],latest.rowCount ? Number(latest.rows[0].skill_revision_id) : null),input.expectedSnapshot); }
      catch(error) { if (error instanceof SkillReleaseSnapshotConflictError) throw new SubmissionConflictError(error.message); throw error; }
      if (!latest.rowCount || Number(latest.rows[0].skill_revision_id) !== input.expectedDraftRevisionId) throw new SubmissionConflictError();
      if (input.expectedActiveRevisionId === input.expectedDraftRevisionId) throw new SubmissionConflictError("This revision is already active.");
      const revision = latest.rows[0];
      if (revision.review_status !== "pending_review") throw new SubmissionConflictError("The current draft is no longer pending review.");
      if (!canActivateRevision(String(revision.validation_status))) throw new SubmissionConflictError("The current organization draft is not valid for release.");
      const metadata = revision.metadata as Record<string, unknown>;
      if (typeof metadata.skillName !== "string" || typeof metadata.description !== "string" ||
          typeof metadata.instructions !== "string") throw new SubmissionConflictError("The draft has incomplete content.");
      const accepted = await client.query(`SELECT r.revision_number FROM organization_skill_submission_attempts a
        JOIN admin_skill_revisions r ON r.skill_revision_id=a.accepted_revision_id
        WHERE a.tenant_id=$1 AND a.submission_id=$2 AND a.attempt=$3`, [tenantId,id,sub.latest_attempt]);
      if (!accepted.rowCount || Number(revision.revision_number) < Number(accepted.rows[0].revision_number)) throw new SubmissionConflictError();
      await client.query(`UPDATE admin_skill_revisions SET
        review_status=CASE WHEN skill_revision_id=$3 THEN 'active' WHEN review_status='active' THEN 'approved' ELSE review_status END,
        reviewed_by=CASE WHEN skill_revision_id=$3 THEN $4 ELSE reviewed_by END,
        reviewed_at=CASE WHEN skill_revision_id=$3 THEN now() ELSE reviewed_at END,
        activated_at=CASE WHEN skill_revision_id=$3 THEN now() ELSE activated_at END
        WHERE tenant_id=$1 AND skill_id=$2`, [tenantId,skillId,input.expectedDraftRevisionId,userId]);
      await client.query(`UPDATE admin_skills SET skill_name=$3,description=$4,version=version+1,enabled=true,
        is_published=$5,active_revision_id=$6,updated_at=now() WHERE tenant_id=$1 AND skill_id=$2`,
      [tenantId,skillId,metadata.skillName,metadata.description,
        input.audience === "members",input.expectedDraftRevisionId]);
      await audit(client, tenantId, userId, "organization.skill_submission.released", {
        submissionId:id, organizationSkillId:skillId, revisionId:input.expectedDraftRevisionId,
        audience:input.audience, previousRevisionId:input.expectedActiveRevisionId });
      await insertAuthorUpdate(client,{tenantId,recipientUserId:String(sub.author_user_id),submissionId:id,
        attempt:Number(sub.latest_attempt),kind:"released",skillName:String(metadata.skillName),feedback:null,
        organizationSkillId:skillId,organizationRevisionId:input.expectedDraftRevisionId,audience:input.audience});
    });
  }
}
