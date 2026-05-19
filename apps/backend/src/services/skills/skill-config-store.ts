import { type Pool, withTenantScope } from "../../lib/db.js";

import type { AdminSkillRecord } from "../admin-config-records.js";
import { mapSkill } from "../admin-config-store-mappers.js";

const skillSelectSql = `
  SELECT
    skill.tenant_id,
    skill.skill_id,
    skill.skill_name,
    skill.description,
    COALESCE(revision.metadata ->> 'instructions', '') AS instructions,
    skill.version,
    COALESCE(revision.bundle_hash, '') AS content_hash,
    skill.enabled,
    skill.is_published,
    skill.created_by,
    skill.created_at,
    skill.updated_at,
    revision.skill_revision_id AS active_revision_id,
    revision.source_type AS active_source_type,
    revision.bundle_name AS active_bundle_name,
    revision.bundle_storage_uri AS active_bundle_storage_uri,
    revision.bundle_hash AS active_bundle_hash,
    revision.validation_status AS active_validation_status,
    revision.review_status AS active_review_status,
    revision.metadata -> 'associatedToolIds' AS active_associated_tool_ids
  FROM admin_skills AS skill
  LEFT JOIN admin_skill_revisions AS revision
    ON revision.skill_revision_id = skill.active_revision_id
`;

export class SkillConfigStore {
  constructor(private readonly db: Pool) {}

  async listSkills(tenantId: string, includeDisabled = true, isBetaTester = true): Promise<AdminSkillRecord[]> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          ${skillSelectSql}
          WHERE ($1::boolean = TRUE OR skill.enabled = TRUE)
            AND ($3::boolean = TRUE OR skill.is_published = TRUE)
            AND skill.tenant_id IN ($2::text, 'system')
          ORDER BY skill.skill_name ASC, skill.updated_at DESC
        `,
        [includeDisabled, tenantId, isBetaTester]
      );

      return result.rows.map((row) => mapSkill(row, tenantId));
    });
  }

  async getSkill(tenantId: string, skillId: string): Promise<AdminSkillRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          ${skillSelectSql}
          WHERE skill.skill_id = $1
            AND skill.tenant_id IN ($2::text, 'system')
          LIMIT 1
        `,
        [skillId, tenantId]
      );

      return result.rows[0] ? mapSkill(result.rows[0], tenantId) : null;
    });
  }

  async disableSkill(tenantId: string, skillId: string): Promise<AdminSkillRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          UPDATE admin_skills
          SET enabled = FALSE, version = version + 1, updated_at = NOW()
          WHERE skill_id = $1
            AND tenant_id = $2
          RETURNING *
        `,
        [skillId, tenantId]
      );

      return result.rows[0] ? mapSkill(result.rows[0], tenantId) : null;
    });
  }

  // Returns the owning tenant of the skill row visible to `tenantId`, or null
  // if no row exists. Used to reject inline edits of inherited (`system`)
  // skills before the (tenant_id, skill_id) FK rejects them with a less
  // helpful error.
  async getSkillOwnerTenantId(tenantId: string, skillId: string): Promise<string | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          SELECT tenant_id
          FROM admin_skills
          WHERE skill_id = $1
            AND tenant_id IN ($2::text, 'system')
          ORDER BY (tenant_id = $2::text) DESC
          LIMIT 1
        `,
        [skillId, tenantId]
      );

      return result.rows[0] ? String(result.rows[0].tenant_id) : null;
    });
  }

  async setSkillPublished(tenantId: string, skillId: string, isPublished: boolean): Promise<AdminSkillRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          UPDATE admin_skills
          SET is_published = $3, version = version + 1, updated_at = NOW()
          WHERE skill_id = $1
            AND tenant_id = $2
          RETURNING *
        `,
        [skillId, tenantId, isPublished]
      );

      return result.rows[0] ? mapSkill(result.rows[0], tenantId) : null;
    });
  }
}
