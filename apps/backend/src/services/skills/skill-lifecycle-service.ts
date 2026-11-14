import type {
  ActivatedSkillRevisionRecord,
  AdminSkillRevisionRecord,
  AdminSkillRecord,
  SkillRevisionCleanupReport
} from "../admin-config-records.js";
import type { AuditEventInput, AuditEventStore } from "../audit-event-store.js";
import type { DynamicConfigService } from "../dynamic-config-service.js";
import type { PoolClient } from "pg";
import type { AdminSkillReleaseSnapshot } from "@cogniplane/shared-types";

type ImportedSkill = { skill: AdminSkillRecord; revision: AdminSkillRevisionRecord };

/**
 * Admin skill changes. Each change writes its audit events in its own
 * transaction, so a failed event rolls the change back. Only the cleanup
 * report is written on its own: the cleanup is many transactions and storage
 * deletes, with no single transaction to join.
 */
export class SkillLifecycleService {
  constructor(
    private readonly dynamicConfig: Pick<
      DynamicConfigService,
      | "importSkillBundleFromZip"
      | "importSkillBundleFromGithub"
      | "importSkillBundleFromInline"
      | "activateSkillRevision"
      | "cleanupInactiveSkillRevisions"
    >,
    private readonly auditEvents: Pick<AuditEventStore, "create">
  ) {}

  private importedEvent(tenantId: string, actorUserId: string, imported: ImportedSkill,
    source: Record<string, unknown>): AuditEventInput {
    return {
      tenantId,
      sessionId: null,
      userId: actorUserId,
      type: "admin.skill.imported",
      payload: {
        skillId: imported.skill.skillId,
        version: imported.skill.version,
        skillRevisionId: imported.revision.skillRevisionId,
        sourceType: imported.revision.sourceType,
        reviewStatus: imported.revision.reviewStatus,
        ...source
      }
    };
  }

  async importSkillBundleFromZip(tenantId: string, input: {
    archiveBuffer: Buffer;
    originalFileName: string;
    actorUserId: string;
  }): Promise<ImportedSkill> {
    return this.dynamicConfig.importSkillBundleFromZip(tenantId, {
      ...input,
      audit: (imported) => this.importedEvent(tenantId, input.actorUserId, imported, {
        sourceLabel: imported.revision.sourceLabel,
        originalFileName: input.originalFileName
      })
    });
  }

  async importSkillBundleFromGithub(tenantId: string, input: {
    githubUrl: string;
    ref?: string;
    subdirectory?: string;
    actorUserId: string;
    githubToken?: string;
  }): Promise<ImportedSkill> {
    return this.dynamicConfig.importSkillBundleFromGithub(tenantId, {
      ...input,
      audit: (imported) => this.importedEvent(tenantId, input.actorUserId, imported, {
        githubUrl: input.githubUrl,
        ref: input.ref ?? null,
        subdirectory: input.subdirectory ?? null
      })
    });
  }

  async importSkillBundleFromInline(tenantId: string, input: {
    skillId: string;
    skillName: string;
    description: string;
    instructions: string;
    actorUserId: string;
  }): Promise<ImportedSkill> {
    return this.dynamicConfig.importSkillBundleFromInline(tenantId, {
      ...input,
      audit: (imported) => this.importedEvent(tenantId, input.actorUserId, imported, {
        sourceLabel: imported.revision.sourceLabel
      })
    });
  }

  async activateSkillRevision(tenantId: string, input: {
    skillId: string;
    skillRevisionId: number;
    actorUserId: string;
    reviewNotes?: string | null;
    audience?: "test-users" | "members";
    expectedSnapshot?: AdminSkillReleaseSnapshot;
    /** Runs in the activation's transaction after the change: the owner notice of the release. */
    alsoInTransaction?: (client: PoolClient) => Promise<void>;
  }): Promise<ActivatedSkillRevisionRecord | null> {
    return this.dynamicConfig.activateSkillRevision(tenantId, {
      ...input,
      audit: (activated) => activationEvents(tenantId, input.actorUserId, input.reviewNotes ?? null, activated)
    });
  }

  async cleanupInactiveSkillRevisions(tenantId: string, input: {
    actorUserId: string;
    dryRun?: boolean;
  }): Promise<SkillRevisionCleanupReport> {
    const report = await this.dynamicConfig.cleanupInactiveSkillRevisions(tenantId, {
      dryRun: input.dryRun
    });

    await this.auditEvents.create({
      tenantId,
      sessionId: null,
      userId: input.actorUserId,
      type: "admin.skill.cleanup.completed",
      payload: {
        dryRun: report.dryRun,
        deletedRevisionCount: report.deletedRevisionIds.length,
        deletedBundleCount: report.deletedBundleStorageUris.length,
        failureCount: report.failures.length,
        keptCount: report.keptRevisionDecisions.length,
        report
      }
    });

    return report;
  }
}

/** The audit events of an activation: reviewed, activated, and rollback for a move to an older revision. */
function activationEvents(tenantId: string, actorUserId: string, reviewNotes: string | null,
  activated: ActivatedSkillRevisionRecord): AuditEventInput[] {
  const base = { tenantId, sessionId: null, userId: actorUserId };
  const events: AuditEventInput[] = [
    {
      ...base,
      type: "admin.skill.reviewed",
      payload: {
        skillId: activated.skill.skillId,
        version: activated.skill.version,
        skillRevisionId: activated.revision.skillRevisionId,
        reviewStatus: activated.revision.reviewStatus,
        reviewNotes
      }
    },
    {
      ...base,
      type: "admin.skill.activated",
      payload: {
        skillId: activated.skill.skillId,
        version: activated.skill.version,
        skillRevisionId: activated.revision.skillRevisionId,
        reviewStatus: activated.revision.reviewStatus,
        audience: activated.skill.isPublished ? "members" : "test-users",
        isPublished: activated.skill.isPublished,
        enabled: activated.skill.enabled
      }
    }
  ];
  // A rollback is a move to an older revision, not every change of the active one.
  if (
    activated.previousActiveRevisionNumber !== null &&
    activated.revision.revisionNumber < activated.previousActiveRevisionNumber
  ) {
    events.push({
      ...base,
      type: "admin.skill.rollback",
      payload: {
        skillId: activated.skill.skillId,
        version: activated.skill.version,
        fromSkillRevisionId: activated.previousActiveRevisionId,
        toSkillRevisionId: activated.revision.skillRevisionId
      }
    });
  }
  return events;
}
