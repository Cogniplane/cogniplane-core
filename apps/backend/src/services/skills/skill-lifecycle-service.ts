import type {
  ActivatedSkillRevisionRecord,
  AdminSkillRevisionRecord,
  AdminSkillRecord,
  SkillRevisionCleanupReport
} from "../admin-config-records.js";
import type { DynamicConfigService } from "../dynamic-config-service.js";
import type { AdminSkillReleaseSnapshot } from "@cogniplane/shared-types";

type AuditEventStore = {
  create(input: {
    tenantId: string;
    sessionId?: string | null;
    userId?: string;
    approvalId?: string | null;
    type: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
};

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
    private readonly auditEvents: AuditEventStore
  ) {}

  async importSkillBundleFromZip(tenantId: string, input: {
    archiveBuffer: Buffer;
    originalFileName: string;
    actorUserId: string;
  }): Promise<{ skill: AdminSkillRecord; revision: AdminSkillRevisionRecord }> {
    const imported = await this.dynamicConfig.importSkillBundleFromZip(tenantId, input);

    await this.auditEvents.create({
      tenantId,
      sessionId: null,
      userId: input.actorUserId,
      type: "admin.skill.imported",
      payload: {
        skillId: imported.skill.skillId,
        version: imported.skill.version,
        skillRevisionId: imported.revision.skillRevisionId,
        sourceType: imported.revision.sourceType,
        reviewStatus: imported.revision.reviewStatus,
        sourceLabel: imported.revision.sourceLabel,
        originalFileName: input.originalFileName
      }
    });

    return imported;
  }

  async importSkillBundleFromGithub(tenantId: string, input: {
    githubUrl: string;
    ref?: string;
    subdirectory?: string;
    actorUserId: string;
    githubToken?: string;
  }): Promise<{ skill: AdminSkillRecord; revision: AdminSkillRevisionRecord }> {
    const imported = await this.dynamicConfig.importSkillBundleFromGithub(tenantId, input);

    await this.auditEvents.create({
      tenantId,
      sessionId: null,
      userId: input.actorUserId,
      type: "admin.skill.imported",
      payload: {
        skillId: imported.skill.skillId,
        version: imported.skill.version,
        skillRevisionId: imported.revision.skillRevisionId,
        sourceType: imported.revision.sourceType,
        reviewStatus: imported.revision.reviewStatus,
        githubUrl: input.githubUrl,
        ref: input.ref ?? null,
        subdirectory: input.subdirectory ?? null
      }
    });

    return imported;
  }

  async importSkillBundleFromInline(tenantId: string, input: {
    skillId: string;
    skillName: string;
    description: string;
    instructions: string;
    actorUserId: string;
  }): Promise<{ skill: AdminSkillRecord; revision: AdminSkillRevisionRecord }> {
    const imported = await this.dynamicConfig.importSkillBundleFromInline(tenantId, input);

    await this.auditEvents.create({
      tenantId,
      sessionId: null,
      userId: input.actorUserId,
      type: "admin.skill.imported",
      payload: {
        skillId: imported.skill.skillId,
        version: imported.skill.version,
        skillRevisionId: imported.revision.skillRevisionId,
        sourceType: imported.revision.sourceType,
        reviewStatus: imported.revision.reviewStatus,
        sourceLabel: imported.revision.sourceLabel
      }
    });

    return imported;
  }

  async activateSkillRevision(tenantId: string, input: {
    skillId: string;
    skillRevisionId: number;
    actorUserId: string;
    reviewNotes?: string | null;
    audience?: "test-users" | "members";
    expectedSnapshot?: AdminSkillReleaseSnapshot;
  }): Promise<ActivatedSkillRevisionRecord | null> {
    const activated = await this.dynamicConfig.activateSkillRevision(tenantId, input);
    if (!activated) {
      return null;
    }

    await this.auditEvents.create({
      tenantId,
      sessionId: null,
      userId: input.actorUserId,
      type: "admin.skill.reviewed",
      payload: {
        skillId: activated.skill.skillId,
        version: activated.skill.version,
        skillRevisionId: activated.revision.skillRevisionId,
        reviewStatus: activated.revision.reviewStatus,
        reviewNotes: input.reviewNotes ?? null
      }
    });

    await this.auditEvents.create({
      tenantId,
      sessionId: null,
      userId: input.actorUserId,
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
    });

    // A rollback is a move to an older revision, not every change of the active one.
    if (
      activated.previousActiveRevisionNumber !== null &&
      activated.revision.revisionNumber < activated.previousActiveRevisionNumber
    ) {
      await this.auditEvents.create({
        tenantId,
        sessionId: null,
        userId: input.actorUserId,
        type: "admin.skill.rollback",
        payload: {
          skillId: activated.skill.skillId,
        version: activated.skill.version,
          fromSkillRevisionId: activated.previousActiveRevisionId,
          toSkillRevisionId: activated.revision.skillRevisionId
        }
      });
    }

    return activated;
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
