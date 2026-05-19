import { type Pool, withTenantScope } from "../../lib/db.js";

/**
 * Links a session (sessions.purpose = 'skill_improvement') to the target
 * skill being improved, the corpus artifact pre-loaded into the session,
 * and the model/effort/sessionLimit selected when the improver was
 * launched. Powers the "Improvement sessions" tab on a skill and the
 * audit trail for improver runs.
 */
export type SkillImprovementSessionRecord = {
  tenantId: string;
  sessionId: string;
  skillId: string;
  corpusArtifactId: string | null;
  sessionLimit: number;
  model: string | null;
  effort: string | null;
  createdBy: string;
  createdAt: string;
};

export type SkillImprovementSessionInput = {
  skillId: string;
  corpusArtifactId: string | null;
  sessionLimit: number;
  model: string | null;
  effort: string | null;
  createdBy: string;
};

function mapRow(row: Record<string, unknown>): SkillImprovementSessionRecord {
  return {
    tenantId: String(row.tenant_id),
    sessionId: String(row.session_id),
    skillId: String(row.skill_id),
    corpusArtifactId: row.corpus_artifact_id ? String(row.corpus_artifact_id) : null,
    sessionLimit: Number(row.session_limit),
    model: row.model ? String(row.model) : null,
    effort: row.effort ? String(row.effort) : null,
    createdBy: String(row.created_by),
    createdAt: new Date(String(row.created_at)).toISOString()
  };
}

export class SkillImprovementSessionStore {
  constructor(private readonly db: Pool) {}

  async create(
    tenantId: string,
    sessionId: string,
    input: SkillImprovementSessionInput
  ): Promise<SkillImprovementSessionRecord> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          INSERT INTO skill_improvement_sessions (
            tenant_id, session_id, skill_id, corpus_artifact_id,
            session_limit, model, effort, created_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING *
        `,
        [
          tenantId,
          sessionId,
          input.skillId,
          input.corpusArtifactId,
          input.sessionLimit,
          input.model,
          input.effort,
          input.createdBy
        ]
      );
      return mapRow(result.rows[0]);
    });
  }

  async get(tenantId: string, sessionId: string): Promise<SkillImprovementSessionRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM skill_improvement_sessions WHERE tenant_id = $1 AND session_id = $2`,
        [tenantId, sessionId]
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    });
  }

  async listForSkill(
    tenantId: string,
    skillId: string,
    limit = 50
  ): Promise<SkillImprovementSessionRecord[]> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          SELECT * FROM skill_improvement_sessions
          WHERE tenant_id = $1 AND skill_id = $2
          ORDER BY created_at DESC
          LIMIT $3
        `,
        [tenantId, skillId, limit]
      );
      return result.rows.map(mapRow);
    });
  }
}
