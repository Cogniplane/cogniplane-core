import type { PoolClient } from "pg";
import type { AdminSkillReleaseSnapshot } from "@cogniplane/shared-types";

import type { Pool } from "../../lib/db.js";
import { withTenantScope } from "../../lib/db.js";
import { canActivateRevision } from "../../domain/skill-lifecycle.js";
import { AdminConfigError } from "../admin-config-error.js";

import type { SkillConfigStore } from "./skill-config-store.js";
import {
  type ActivatedSkillRevisionRecord,
  type ActiveRuntimeSkillReference,
  type AdminSkillRevisionRecord,
  type ImportedSkillBundleRecord
} from "../admin-config-records.js";
import { mapSkillRevision, parseSkillActivationMetadata, skillReferencesFromManifest } from "../admin-config-store-mappers.js";
import { lockOrganizationSkillNames } from "./organization-skill-name-lock.js";
import { insertAuthorUpdate } from "./organization-skill-submission-store.js";
import { assertSkillReleaseSnapshot, latestSkillRevisionId, skillReleaseSnapshot } from "./skill-release-impact-store.js";

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

  // Tenant-owned revisions only: cleanup can never delete inherited `system` revisions.
  async listAllSkillRevisions(tenantId: string): Promise<AdminSkillRevisionRecord[]> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const revisionRows = await client.query(
        `
          SELECT *
          FROM admin_skill_revisions
          WHERE tenant_id = $1
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
      await lockOrganizationSkillNames(client, tenantId);
      // Scope the existence check to THIS tenant only. Including the 'system'
      // row here would make a tenant import whose skillId collides with a
      // platform-default skill skip the per-tenant INSERT below, so the
      // subsequent revision insert would reference a (tenant_id, skill_id) that
      // doesn't exist for this tenant and fail with an opaque FK violation.
      const existing = await client.query(
        `
          SELECT *
          FROM admin_skills
          WHERE skill_id = $1
            AND tenant_id = $2
          LIMIT 1
        `,
        [input.skillId, tenantId]
      );

      // System skill IDs are reserved. Continue to support a pre-existing
      // tenant-owned row with the same ID, but do not create any new collision.
      if (!existing.rows[0] && tenantId !== "system") {
        const systemSkill = await client.query(
          `
            SELECT 1
            FROM admin_skills
            WHERE skill_id = $1
              AND tenant_id = 'system'
            LIMIT 1
          `,
          [input.skillId]
        );

        if (systemSkill.rows[0]) {
          throw new AdminConfigError(
            `Skill "${input.skillId}" is a system-provided skill and cannot be imported. ` +
              "Create a copy under a different skill id to customize it."
          );
        }
      }

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

      const metadata = { ...input.metadata };
      delete metadata.organizationSubmissionId;
      delete metadata.organizationSubmissionAttempt;
      if (input.sourceType === "inline") {
        const previous = await client.query(`SELECT revision_number,review_status,source_type,metadata
          FROM admin_skill_revisions WHERE tenant_id=$1 AND skill_id=$2
          ORDER BY revision_number DESC LIMIT 1 FOR UPDATE`,[tenantId,input.skillId]);
        const parent = previous.rows[0];
        const parentMetadata = parent?.metadata as Record<string, unknown> | undefined;
        if (parent?.review_status === "pending_review" && parent.source_type === "inline" &&
            Number(parent.revision_number) === revisionNumber-1 &&
            typeof parentMetadata?.organizationSubmissionId === "string" &&
            Number.isInteger(parentMetadata.organizationSubmissionAttempt)) {
          const linked = await client.query(`SELECT 1 FROM organization_skill_submissions s
            JOIN organization_skill_submission_attempts a ON a.tenant_id=s.tenant_id
              AND a.submission_id=s.submission_id AND a.attempt=$4
            JOIN admin_skill_revisions accepted ON accepted.tenant_id=s.tenant_id
              AND accepted.skill_revision_id=a.accepted_revision_id
            WHERE s.tenant_id=$1 AND s.submission_id::text=$2 AND s.accepted_skill_id=$3
              AND s.status='accepted' AND accepted.revision_number<=$5`,
          [tenantId,parentMetadata.organizationSubmissionId,input.skillId,
            parentMetadata.organizationSubmissionAttempt,parent.revision_number]);
          if (linked.rowCount) {
            metadata.organizationSubmissionId=parentMetadata.organizationSubmissionId;
            metadata.organizationSubmissionAttempt=parentMetadata.organizationSubmissionAttempt;
          }
        }
      }

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
          ...metadata,
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
    audience?: "test-users" | "members";
    expectedSnapshot?: AdminSkillReleaseSnapshot;
  }): Promise<ActivatedSkillRevisionRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      await lockOrganizationSkillNames(client, tenantId);
      const existing = await client.query(
        `SELECT version,active_revision_id,enabled,is_published FROM admin_skills
         WHERE tenant_id = $1 AND skill_id = $2 FOR UPDATE`,
        [tenantId, input.skillId]
      );
      if (!existing.rows[0]) return null;
      assertSkillReleaseSnapshot(skillReleaseSnapshot(existing.rows[0],
        await latestSkillRevisionId(client,tenantId,input.skillId)),input.expectedSnapshot);

      const previousActiveRevisionId = existing.rows[0].active_revision_id === null
        ? null : Number(existing.rows[0].active_revision_id);
      const previous = previousActiveRevisionId === null ? null : await client.query(
        `SELECT revision_number FROM admin_skill_revisions
         WHERE tenant_id = $1 AND skill_id = $2 AND skill_revision_id = $3`,
        [tenantId, input.skillId, previousActiveRevisionId]
      );

      const selected = await client.query(
        `SELECT * FROM admin_skill_revisions
         WHERE tenant_id = $1 AND skill_id = $2 AND skill_revision_id = $3 FOR UPDATE`,
        [tenantId, input.skillId, input.skillRevisionId]
      );
      if (!selected.rows[0]) return null;
      const revision = mapSkillRevision(selected.rows[0]);
      if (!canActivateRevision(revision.validationStatus)) {
        throw new AdminConfigError(`Skill revision ${input.skillRevisionId} is not valid for activation.`);
      }
      const parsed = parseSkillActivationMetadata(revision.metadata);
      if (!parsed.ok) {
        throw new AdminConfigError(
          `Skill revision ${input.skillRevisionId} is missing activation metadata: ${parsed.missing.join(", ")}.`
        );
      }
      const { skillName, description } = parsed.value;

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
            version = version + 1,
            enabled = TRUE,
            is_published = COALESCE($6::boolean, is_published),
            active_revision_id = $4,
            updated_at = NOW()
          WHERE skill_id = $1
            AND tenant_id = $5
        `,
        [input.skillId, skillName, description, input.skillRevisionId, tenantId,
          input.audience === undefined ? null : input.audience === "members"]
      );
      const submissionId = revision.metadata.organizationSubmissionId;
      const submissionAttempt = revision.metadata.organizationSubmissionAttempt;
      if (typeof submissionId === "string" && Number.isInteger(submissionAttempt)) {
        const linked = await client.query(`SELECT s.author_user_id,s.submission_id,a.attempt,sk.is_published
        FROM organization_skill_submissions s
        JOIN organization_skill_submission_attempts a ON a.tenant_id=s.tenant_id
          AND a.submission_id=s.submission_id AND a.attempt=$4
        JOIN admin_skill_revisions accepted_revision ON accepted_revision.tenant_id=s.tenant_id
          AND accepted_revision.skill_revision_id=a.accepted_revision_id
        JOIN admin_skills sk ON sk.tenant_id=s.tenant_id AND sk.skill_id=s.accepted_skill_id
        WHERE s.tenant_id=$1 AND s.submission_id::text=$2 AND s.accepted_skill_id=$3
          AND s.status='accepted' AND accepted_revision.revision_number<=$5`,
        [tenantId,submissionId,input.skillId,submissionAttempt,revision.revisionNumber]);
        if (linked.rowCount) {
          await insertAuthorUpdate(client,{tenantId,recipientUserId:String(linked.rows[0].author_user_id),
            submissionId,attempt:Number(submissionAttempt),kind:"released",skillName,
            feedback:null,organizationSkillId:input.skillId,organizationRevisionId:input.skillRevisionId,
            audience:linked.rows[0].is_published ? "members" : "test-users"});
        }
      }
      const skill = await this.skillStore.getSkill(tenantId, input.skillId, client);
      const active = await client.query(
        `SELECT * FROM admin_skill_revisions
         WHERE tenant_id = $1 AND skill_id = $2 AND skill_revision_id = $3`,
        [tenantId, input.skillId, input.skillRevisionId]
      );
      if (!skill || !active.rows[0]) {
        throw new Error(`Failed to load activated skill revision ${input.skillRevisionId}.`);
      }
      return {
        skill,
        revision: mapSkillRevision(active.rows[0]),
        previousActiveRevisionId,
        previousActiveRevisionNumber: previous?.rows[0] ? Number(previous.rows[0].revision_number) : null
      };
    });
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

      return runtimeSessionRows.rows.flatMap((row) =>
        skillReferencesFromManifest(String(row.session_id), row.manifest_metadata));
    });
  }

  async deleteSkillRevision(tenantId: string, skillId: string, skillRevisionId: number): Promise<AdminSkillRevisionRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      // Lock the skill row as activateSkillRevision does, so a revision that a
      // concurrent activation makes active is never deleted.
      const skill = await client.query(
        `SELECT active_revision_id FROM admin_skills
         WHERE tenant_id = $1 AND skill_id = $2 FOR UPDATE`,
        [tenantId, skillId]
      );
      if (!skill.rowCount) return null;
      const deletedRevisionRows = await client.query(
        `
          DELETE FROM admin_skill_revisions
          WHERE skill_id = $1 AND skill_revision_id = $2
            AND tenant_id = $3
            AND review_status <> 'active'
            AND skill_revision_id IS DISTINCT FROM $4::bigint
          RETURNING *
        `,
        [skillId, skillRevisionId, tenantId, skill.rows[0].active_revision_id]
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
