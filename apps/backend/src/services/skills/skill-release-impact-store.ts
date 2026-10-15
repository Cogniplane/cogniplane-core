import type { PoolClient } from "pg";
import type { AdminSkillReleaseImpact, AdminSkillReleaseSnapshot } from "@cogniplane/shared-types";
import { canActivateRevision } from "../../domain/skill-lifecycle.js";
import { type Pool, withTenantScope } from "../../lib/db.js";
import { lockOrganizationSkillNames } from "./organization-skill-name-lock.js";

export class SkillReleaseImpactNotFoundError extends Error {}
export class SkillReleaseSnapshotConflictError extends Error {
  constructor() {
    super("The skill changed after the preview. Refresh and review the impact again.");
  }
}

export async function latestSkillRevisionId(
  client: PoolClient,
  tenantId: string,
  skillId: string
): Promise<number | null> {
  const result = await client.query(
    `SELECT skill_revision_id FROM admin_skill_revisions
     WHERE tenant_id=$1 AND skill_id=$2 ORDER BY revision_number DESC LIMIT 1`,
    [tenantId, skillId]
  );
  return result.rowCount ? Number(result.rows[0].skill_revision_id) : null;
}
export function skillReleaseSnapshot(
  row: Record<string, unknown>,
  latestRevisionId: number | null
): AdminSkillReleaseSnapshot {
  return {
    version: Number(row.version),
    activeRevisionId: row.active_revision_id === null ? null : Number(row.active_revision_id),
    latestRevisionId,
    enabled: Boolean(row.enabled),
    isPublished: Boolean(row.is_published)
  };
}
export function assertSkillReleaseSnapshot(
  actual: AdminSkillReleaseSnapshot,
  expected?: AdminSkillReleaseSnapshot
) {
  if (!expected) return;
  if (actual.version !== expected.version ||
      actual.activeRevisionId !== expected.activeRevisionId ||
      actual.latestRevisionId !== expected.latestRevisionId ||
      actual.enabled !== expected.enabled ||
      actual.isPublished !== expected.isPublished) {
    throw new SkillReleaseSnapshotConflictError();
  }
}
function available(audience: "off" | "test-users" | "members", testUser: boolean) {
  return audience === "members" || (audience === "test-users" && testUser);
}
const numeric = (value: unknown) => Number(value ?? 0);
export class SkillReleaseImpactStore {
  constructor(private readonly db: Pool) {}

  async preview(
    tenantId: string,
    skillId: string,
    input: { action: "activate" | "audience"; revisionId: number | null; audience: "off" | "test-users" | "members" }
  ): Promise<AdminSkillReleaseImpact> {
    return withTenantScope(this.db, tenantId, async client => {
      await lockOrganizationSkillNames(client, tenantId);
      const found = await client.query(
        `SELECT s.version, s.active_revision_id, s.enabled, s.is_published,
                r.revision_number AS active_revision_number
         FROM admin_skills s
         LEFT JOIN admin_skill_revisions r
           ON r.tenant_id=s.tenant_id AND r.skill_revision_id=s.active_revision_id
         WHERE s.tenant_id=$1 AND s.skill_id=$2 FOR SHARE OF s`,
        [tenantId, skillId]
      );
      if (!found.rowCount) throw new SkillReleaseImpactNotFoundError("Skill not found.");
      const snapshot = skillReleaseSnapshot(found.rows[0], await latestSkillRevisionId(client, tenantId, skillId));
      const currentRevisionNumber = found.rows[0].active_revision_number === null
        ? null : Number(found.rows[0].active_revision_number);
      let proposedRevisionNumber = currentRevisionNumber;
      if (input.action === "activate") {
        if (input.revisionId === null || input.audience === "off") throw new SkillReleaseSnapshotConflictError();
        const target = await client.query(
          `SELECT revision_number, validation_status, metadata FROM admin_skill_revisions
           WHERE tenant_id=$1 AND skill_id=$2 AND skill_revision_id=$3`,
          [tenantId, skillId, input.revisionId]
        );
        if (!target.rowCount) throw new SkillReleaseImpactNotFoundError("Revision not found.");
        proposedRevisionNumber = Number(target.rows[0].revision_number);
        const meta = target.rows[0].metadata as Record<string, unknown>;
        if (!canActivateRevision(String(target.rows[0].validation_status)) ||
            typeof meta?.skillName !== "string" || typeof meta.description !== "string")
          throw new SkillReleaseSnapshotConflictError();
      } else if (input.revisionId !== snapshot.activeRevisionId) {
        throw new SkillReleaseSnapshotConflictError();
      }
      const currentAudience: "off" | "test-users" | "members" = snapshot.enabled && snapshot.activeRevisionId !== null
        ? snapshot.isPublished ? "members" : "test-users" : "off";
      const proposedRevisionId = input.action === "activate" ? input.revisionId : snapshot.activeRevisionId;
      const proposedAudience = input.action === "activate" ? input.audience
        : input.audience === "off" || !snapshot.enabled || proposedRevisionId === null ? "off" : input.audience;
      const membership = await client.query(
        `SELECT count(*)::integer AS total,
                count(*) FILTER (WHERE is_beta_tester)::integer AS test_users
         FROM tenant_memberships WHERE tenant_id=$1`,
        [tenantId]
      );
      const total = numeric(membership.rows[0].total);
      const testUsers = numeric(membership.rows[0].test_users);
      const gaining =
        (available(proposedAudience, true) && !available(currentAudience, true) ? testUsers : 0) +
        (available(proposedAudience, false) && !available(currentAudience, false) ? total - testUsers : 0);
      const losing =
        (!available(proposedAudience, true) && available(currentAudience, true) ? testUsers : 0) +
        (!available(proposedAudience, false) && available(currentAudience, false) ? total - testUsers : 0);

      const projects = await client.query(
        `SELECT count(*) FILTER (WHERE capability_selection IS NULL)::integer AS inherited,
                count(*) FILTER (WHERE capability_selection->'skillIds' ? $2)::integer AS explicit_selected
         FROM projects WHERE tenant_id=$1 AND archived_at IS NULL`,
        [tenantId, skillId]
      );
      const personal = await client.query(
        `SELECT count(*) FILTER (WHERE d.capability_selection IS NULL)::integer AS inherited,
                count(*) FILTER (WHERE d.capability_selection->'skillIds' ? $2)::integer AS explicit_selected
         FROM tenant_memberships m LEFT JOIN personal_capability_defaults d
           ON d.tenant_id=m.tenant_id AND d.user_id=m.user_id WHERE m.tenant_id=$1`,
        [tenantId, skillId]
      );
      const sessions = await client.query(
        `SELECT count(*) FILTER (WHERE capability_selection IS NULL)::integer AS inherited,
                count(*) FILTER (WHERE capability_selection->'skillIds' ? $2)::integer AS explicit_selected
         FROM sessions WHERE tenant_id=$1 AND status='active' AND purpose='normal'`,
        [tenantId, skillId]
      );
      const refs = (row: Record<string, unknown>) => ({
        inherited: numeric(row.inherited), explicitSelected: numeric(row.explicit_selected)
      });

      return {
        skillId,
        snapshot,
        current: { revisionId: snapshot.activeRevisionId, revisionNumber: currentRevisionNumber, audience: currentAudience },
        proposed: { revisionId: proposedRevisionId, revisionNumber: proposedRevisionNumber, audience: proposedAudience },
        members: { total, testUsers, gaining, losing },
        configuredReferences: {
          projects: refs(projects.rows[0]),
          personalDefaults: refs(personal.rows[0]),
          sessions: refs(sessions.rows[0])
        }
      };
    });
  }
}
