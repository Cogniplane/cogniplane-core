import type {
  ActiveRuntimeSkillReference,
  AdminSkillRevisionRecord
} from "../services/admin-config-records.js";

export type SkillCleanupDecision = {
  retain: boolean;
  reason: string | null;
};

export function getLatestRevisionIds(revisions: AdminSkillRevisionRecord[]): Set<number> {
  const revisionsBySkill = new Map<string, AdminSkillRevisionRecord[]>();

  for (const revision of revisions) {
    const current = revisionsBySkill.get(revision.skillId) ?? [];
    current.push(revision);
    revisionsBySkill.set(revision.skillId, current);
  }

  const latestRevisionIds = new Set<number>();
  for (const skillRevisions of revisionsBySkill.values()) {
    const latest = skillRevisions
      .slice()
      .sort(
        (left, right) =>
          right.revisionNumber - left.revisionNumber || right.createdAt.localeCompare(left.createdAt)
      )[0];
    if (latest) {
      latestRevisionIds.add(latest.skillRevisionId);
    }
  }

  return latestRevisionIds;
}

export function getCleanupDecision(input: {
  revision: AdminSkillRevisionRecord;
  activeRevisionIds: Set<number>;
  activeRuntimeReferences: ActiveRuntimeSkillReference[];
  activeRuntimeRevisionIds: Set<number>;
  latestRevisionIds: Set<number>;
  retentionCutoff: number;
}): SkillCleanupDecision {
  if (input.activeRevisionIds.has(input.revision.skillRevisionId)) {
    return { retain: true, reason: "active_registry_revision" };
  }

  if (input.activeRuntimeRevisionIds.has(input.revision.skillRevisionId)) {
    const activeSessionIds = input.activeRuntimeReferences
      .filter((reference) => reference.revisionId === input.revision.skillRevisionId)
      .map((reference) => reference.sessionId);
    return {
      retain: true,
      reason: `active_runtime_reference:${activeSessionIds.join(",")}`
    };
  }

  if (input.latestRevisionIds.has(input.revision.skillRevisionId)) {
    return { retain: true, reason: "latest_revision_for_skill" };
  }

  if (Date.parse(input.revision.createdAt) >= input.retentionCutoff) {
    return { retain: true, reason: "within_retention_window" };
  }

  return { retain: false, reason: null };
}
