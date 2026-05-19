import type { PoolClient } from "pg";

import type { Pool } from "../../lib/db.js";
import { withTenantScope } from "../../lib/db.js";
import { canActivateRevision } from "../../domain/skill-lifecycle.js";

import type { SkillConfigStore } from "./skill-config-store.js";
import {
  type ActivatedSkillRevisionRecord,
  type ActiveRuntimeSkillReference,
  type AdminSkillRevisionRecord,
  type ImportedSkillBundleRecord
} from "../admin-config-records.js";
import { mapSkillRevision, parseSkillActivationMetadata } from "../admin-config-store-mappers.js";

export class SkillRevisionStore {
  constructor(
    private readonly db: Pool,
    private readonly skillStore: SkillConfigStore
  ) {}

  async listSkillRevisions(tenantId: string, skillId: string): Promise<AdminSkillRevisionRecord[]> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const revisionRows = await client.query(
        `
          SELECT *
          FROM admin_skill_revisions
          WHERE skill_id = $1
            AND tenant_id IN ($2::text, 'system')
          ORDER BY revision_number DESC, created_at DESC
        `,
        [skillId, tenantId]
      );

      return revisionRows.rows.map((row) => mapSkillRevision(row));
    });
  }

  async listAllSkillRevisions(tenantId: string): Promise<AdminSkillRevisionRecord[]> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const revisionRows = await client.query(
        `
          SELECT *
          FROM admin_skill_revisions
          WHERE tenant_id IN ($1::text, 'system')
          ORDER BY skill_id ASC, revision_number DESC, created_at DESC
        `,
        [tenantId]
      );

      return revisionRows.rows.map((row) => mapSkillRevision(row));
    });
  }

  async getSkillRevision(tenantId: string, skillId: string, skillRevisionId: number): Promise<AdminSkillRevisionRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const revisionRows = await client.query(
        `
          SELECT *
          FROM admin_skill_revisions
          WHERE skill_id = $1 AND skill_revision_id = $2
            AND tenant_id IN ($3::text, 'system')
          LIMIT 1
        `,
        [skillId, skillRevisionId, tenantId]
      );

      return revisionRows.rows[0] ? mapSkillRevision(revisionRows.rows[0]) : null;
    });
  }

  private async insertSkillRevision(
    client: PoolClient | Pool,
    tenantId: string,
    input: {
      skillId: string;
      revisionNumber: number;
      sourceType: string;
      sourceLabel: string | null;
      bundleName: string | null;
      bundleStorageUri: string | null;
      bundleHash: string;
      validationStatus: string;
      validationMessages: Array<Record<string, unknown>>;
      reviewStatus: string;
      reviewNotes: string | null;
      metadata: Record<string, unknown>;
      createdBy: string;
      reviewedBy: string | null;
      reviewedAt: string | null;
      activatedAt: string | null;
    }
  ): Promise<AdminSkillRevisionRecord> {
    const insertedRevision = await client.query(
      `
        INSERT INTO admin_skill_revisions (
          tenant_id,
          skill_id,
          revision_number,
          source_type,
          source_label,
          bundle_name,
          bundle_storage_uri,
          bundle_hash,
          validation_status,
          validation_messages,
          review_status,
          review_notes,
          metadata,
          created_by,
          reviewed_by,
          reviewed_at,
          activated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13::jsonb, $14, $15, $16, $17)
        RETURNING *
      `,
      [
        tenantId,
        input.skillId,
        input.revisionNumber,
        input.sourceType,
        input.sourceLabel,
        input.bundleName,
        input.bundleStorageUri,
        input.bundleHash,
        input.validationStatus,
        JSON.stringify(input.validationMessages),
        input.reviewStatus,
        input.reviewNotes,
        JSON.stringify(input.metadata),
        input.createdBy,
        input.reviewedBy,
        input.reviewedAt,
        input.activatedAt
      ]
    );

    return mapSkillRevision(insertedRevision.rows[0]);
  }

  async createSkillRevision(tenantId: string, input: {
    skillId: string;
    revisionNumber: number;
    sourceType: string;
    sourceLabel: string | null;
    bundleName: string | null;
    bundleStorageUri: string | null;
    bundleHash: string;
    validationStatus: string;
    validationMessages: Array<Record<string, unknown>>;
    reviewStatus: string;
    reviewNotes: string | null;
    metadata: Record<string, unknown>;
    createdBy: string;
    reviewedBy: string | null;
    reviewedAt: string | null;
    activatedAt: string | null;
  }): Promise<AdminSkillRevisionRecord> {
    return withTenantScope(this.db, tenantId, (client) => this.insertSkillRevision(client, tenantId, input));
  }

  async importSkillBundle(tenantId: string, input: {
    skillId: string;
    skillName: string;
    description: string;
    instructions: string;
    sourceType: string;
    sourceLabel: string;
    bundleName: string;
    bundleHash: string;
    validationStatus: string;
    validationMessages: Array<Record<string, unknown>>;
    metadata: Record<string, unknown>;
    createdBy: string;
    // Called with the freshly-allocated revision number. The bundle is
    // uploaded to storage here so the S3 key can embed the revision number.
    // Inline (single-file SKILL.md) revisions return { storageUri: null } —
    // no bundle is persisted and the SKILL.md body lives in metadata.instructions.
    storeBundle: (input: { revisionNumber: number }) => Promise<{ storageUri: string | null }>;
  }): Promise<ImportedSkillBundleRecord> {
    let allocatedRevisionNumber: number | null = null;

    await withTenantScope(this.db, tenantId, async (client) => {
      const existing = await client.query(
        `
          SELECT *
          FROM admin_skills
          WHERE skill_id = $1
            AND tenant_id IN ($2::text, 'system')
          LIMIT 1
        `,
        [input.skillId, tenantId]
      );

      if (!existing.rows[0]) {
        await client.query(
          `
            INSERT INTO admin_skills (
              tenant_id,
              skill_id,
              skill_name,
              description,
              version,
              enabled,
              created_by,
              active_revision_id
            )
            VALUES ($1, $2, $3, $4, 0, FALSE, $5, NULL)
          `,
          [tenantId, input.skillId, input.skillName, input.description, input.createdBy]
        );
      }

      const revisionNumberResult = await client.query(
        `
          SELECT COALESCE(MAX(revision_number), 0) + 1 AS next_revision_number
          FROM admin_skill_revisions
          WHERE skill_id = $1
            AND tenant_id IN ($2::text, 'system')
        `,
        [input.skillId, tenantId]
      );
      const revisionNumber = Number(revisionNumberResult.rows[0]?.next_revision_number ?? 1);
      allocatedRevisionNumber = revisionNumber;

      const { storageUri } = await input.storeBundle({ revisionNumber });

      await this.insertSkillRevision(client, tenantId, {
        skillId: input.skillId,
        revisionNumber,
        sourceType: input.sourceType,
        sourceLabel: input.sourceLabel,
        bundleName: input.bundleName,
        bundleStorageUri: storageUri,
        bundleHash: input.bundleHash,
        validationStatus: input.validationStatus,
        validationMessages: input.validationMessages,
        reviewStatus: "pending_review",
        reviewNotes: null,
        metadata: {
          ...input.metadata,
          skillName: input.skillName,
          description: input.description,
          instructions: input.instructions
        },
        createdBy: input.createdBy,
        reviewedBy: null,
        reviewedAt: null,
        activatedAt: null
      });
    });

    const skill = await this.skillStore.getSkill(tenantId, input.skillId);
    if (!skill) {
      throw new Error(`Failed to load imported skill ${input.skillId}.`);
    }

    const revisions = await this.listSkillRevisions(tenantId, input.skillId);
    const revision = revisions[0];
    if (!revision || revision.revisionNumber !== allocatedRevisionNumber) {
      throw new Error(`Failed to load imported revision for skill ${input.skillId}.`);
    }

    return { skill, revision };
  }

  async activateSkillRevision(tenantId: string, input: {
    skillId: string;
    skillRevisionId: number;
    reviewedBy: string;
    reviewNotes: string | null;
  }): Promise<ActivatedSkillRevisionRecord | null> {
    const existingSkill = await this.skillStore.getSkill(tenantId, input.skillId);
    const revision = await this.getSkillRevision(tenantId, input.skillId, input.skillRevisionId);
    if (!revision) {
      return null;
    }

    if (!canActivateRevision(revision.validationStatus)) {
      throw new Error(`Skill revision ${input.skillRevisionId} is not valid for activation.`);
    }

    const parsed = parseSkillActivationMetadata(revision.metadata);
    if (!parsed.ok) {
      throw new Error(
        `Skill revision ${input.skillRevisionId} is missing activation metadata: ${parsed.missing.join(", ")}.`
      );
    }
    const { skillName, description } = parsed.value;

    await withTenantScope(this.db, tenantId, async (client) => {
      await client.query(
        `
          UPDATE admin_skill_revisions
          SET
            review_status = CASE
              WHEN skill_revision_id = $2 THEN 'active'
              WHEN review_status = 'active' THEN 'approved'
              ELSE review_status
            END,
            review_notes = CASE WHEN skill_revision_id = $2 THEN $4 ELSE review_notes END,
            reviewed_by = CASE WHEN skill_revision_id = $2 THEN $3 ELSE reviewed_by END,
            reviewed_at = CASE WHEN skill_revision_id = $2 THEN NOW() ELSE reviewed_at END,
            activated_at = CASE WHEN skill_revision_id = $2 THEN NOW() ELSE activated_at END
          WHERE skill_id = $1
            AND tenant_id = $5
        `,
        [input.skillId, input.skillRevisionId, input.reviewedBy, input.reviewNotes, tenantId]
      );

      await client.query(
        `
          UPDATE admin_skills
          SET
            skill_name = $2,
            description = $3,
            version = $4,
            enabled = TRUE,
            active_revision_id = $5,
            updated_at = NOW()
          WHERE skill_id = $1
            AND tenant_id = $6
        `,
        [input.skillId, skillName, description, revision.revisionNumber, input.skillRevisionId, tenantId]
      );
    });

    const skill = await this.skillStore.getSkill(tenantId, input.skillId);
    const activeRevision = await this.getSkillRevision(tenantId, input.skillId, input.skillRevisionId);
    if (!skill || !activeRevision) {
      throw new Error(`Failed to load activated skill revision ${input.skillRevisionId}.`);
    }

    return {
      skill,
      revision: activeRevision,
      previousActiveRevisionId: existingSkill?.activeRevisionId ?? null
    };
  }

  async listActiveRuntimeSkillReferences(tenantId: string): Promise<ActiveRuntimeSkillReference[]> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const runtimeSessionRows = await client.query(
        `
          SELECT session_id, manifest_metadata
          FROM runtime_sessions
          WHERE tenant_id = $1
            AND status IN ('starting', 'active', 'terminating')
        `,
        [tenantId]
      );

      const references: ActiveRuntimeSkillReference[] = [];
      for (const row of runtimeSessionRows.rows) {
        const manifestMetadata =
          row.manifest_metadata && typeof row.manifest_metadata === "object"
            ? (row.manifest_metadata as Record<string, unknown>)
            : {};
        const skills = Array.isArray(manifestMetadata.skills) ? manifestMetadata.skills : [];

        for (const skill of skills) {
          if (typeof skill !== "object" || skill === null) {
            continue;
          }

          const record = skill as Record<string, unknown>;
          references.push({
            sessionId: String(row.session_id),
            skillId: typeof record.id === "string" ? record.id : "",
            revisionId: typeof record.revisionId === "number" ? record.revisionId : null,
            bundleHash: typeof record.bundleHash === "string" ? record.bundleHash : null
          });
        }
      }

      return references;
    });
  }

  async deleteSkillRevision(tenantId: string, skillId: string, skillRevisionId: number): Promise<AdminSkillRevisionRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const deletedRevisionRows = await client.query(
        `
          DELETE FROM admin_skill_revisions
          WHERE skill_id = $1 AND skill_revision_id = $2
            AND tenant_id = $3
          RETURNING *
        `,
        [skillId, skillRevisionId, tenantId]
      );

      return deletedRevisionRows.rows[0] ? mapSkillRevision(deletedRevisionRows.rows[0]) : null;
    });
  }

  async countSkillRevisionsByBundleStorageUri(tenantId: string, bundleStorageUri: string): Promise<number> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const countRows = await client.query(
        `
          SELECT COUNT(*)::int AS revision_count
          FROM admin_skill_revisions
          WHERE bundle_storage_uri = $1
            AND tenant_id IN ($2::text, 'system')
        `,
        [bundleStorageUri, tenantId]
      );

      return Number(countRows.rows[0]?.revision_count ?? 0);
    });
  }
}
