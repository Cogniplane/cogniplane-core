import { computeConfigHash } from "../lib/crypto-utils.js";

import type {
  AdminMcpServerRecord,
  AdminSkillRecord,
  McpServerRegistration,
  ResolvedRuntimePolicy,
  RuntimeConfigBundle,
  RuntimeSkillDefinition
} from "./admin-config-records.js";
import type { McpServerStore } from "./mcp-server-store.js";
import type { SessionRuntimeOverrideRecord } from "./session-runtime-override-store.js";
import type { SkillConfigStore } from "./skills/skill-config-store.js";

export function normalizeMcpServer(
  record: AdminMcpServerRecord
): McpServerRegistration {
  return {
    id: record.serverId,
    description: record.description ?? record.serverName,
    mode: record.mode,
    routePath: record.routePath,
    upstreamUrl: record.upstreamUrl,
    transportKind: "http",
    headersAllowlist: record.headersAllowlist,
    version: record.version,
    hash: record.configHash
  };
}

function normalizeSkill(record: AdminSkillRecord): RuntimeSkillDefinition {
  return {
    id: record.skillId,
    name: record.skillName,
    description: record.description,
    instructions: record.instructions,
    version: record.version,
    hash: record.contentHash,
    revisionId: record.activeRevisionId,
    bundleHash: record.activeBundleHash,
    sourceType: record.activeSourceType,
    bundleName: record.activeBundleName,
    bundleStorageUri: record.activeBundleStorageUri,
    validationStatus: record.activeValidationStatus,
    reviewStatus: record.activeReviewStatus,
    associatedToolIds: record.associatedToolIds
  };
}

/**
 * Narrows a tenant's resolved runtime policy by the per-session override
 * (when one exists). The override is treated as an *intersection*: it can
 * only remove tools/MCP servers from what the tenant already allows, never
 * add new ones. The runtime-provider, approval policy, and auto-approve flag
 * are full overrides — they replace the tenant value when present.
 *
 * Pure function: no I/O, fully covered by unit tests in the sibling
 * `.test.ts` file.
 */
export function applySessionOverride(input: {
  profile: ResolvedRuntimePolicy;
  override: SessionRuntimeOverrideRecord | null;
}): ResolvedRuntimePolicy {
  const { profile, override } = input;
  if (!override) return profile;

  const enabledToolIds = override.enabledToolIds.length > 0
    ? profile.enabledToolIds.filter((id) => override.enabledToolIds.includes(id))
    : profile.enabledToolIds;
  const enabledMcpServers = override.enabledMcpServerIds.length > 0
    ? profile.enabledMcpServers.filter((id) => override.enabledMcpServerIds.includes(id))
    : profile.enabledMcpServers;

  return {
    ...profile,
    runtimeProvider: override.runtimeProvider ?? profile.runtimeProvider,
    approvalPolicy: override.approvalPolicy,
    autoApproveReadOnlyTools: override.autoApproveReadOnlyTools,
    enabledToolIds,
    enabledMcpServers
  };
}

/**
 * Same intersection rule for the skill list. Returned as a separate helper
 * because skills are listed independently of the runtime policy.
 */
export function filterSkillsByOverride(
  skills: AdminSkillRecord[],
  override: SessionRuntimeOverrideRecord | null
): AdminSkillRecord[] {
  if (!override || override.enabledSkillIds.length === 0) return skills;
  return skills.filter((skill) => override.enabledSkillIds.includes(skill.skillId));
}

export async function compileRuntimeConfig(input: {
  tenantId: string;
  skills: SkillConfigStore;
  mcpServers: McpServerStore;
  runtimePolicy: ResolvedRuntimePolicy;
  isBetaTester?: boolean;
  sessionOverride?: SessionRuntimeOverrideRecord | null;
}): Promise<RuntimeConfigBundle> {
  const isBetaTester = input.isBetaTester ?? true;
  const sessionOverride = input.sessionOverride ?? null;
  const profile = applySessionOverride({
    profile: input.runtimePolicy,
    override: sessionOverride
  });

  const [allSkills, allMcpServers] = await Promise.all([
    input.skills.listSkills(input.tenantId, false, isBetaTester),
    input.mcpServers.listMcpServers(input.tenantId, false, isBetaTester)
  ]);

  const enabledSkills = filterSkillsByOverride(allSkills, sessionOverride).map((skill) =>
    normalizeSkill(skill)
  );
  const enabledMcpServers = allMcpServers
    .filter((server) => profile.enabledMcpServers.includes(server.serverId))
    .map((server) => normalizeMcpServer(server));

  const sources = {
    runtimePolicy: {
      id: profile.id,
      version: profile.version,
      hash: profile.hash
    },
    skills: enabledSkills.map((skill) => ({
      id: skill.id,
      version: skill.version,
      hash: skill.hash,
      revisionId: skill.revisionId,
      bundleHash: skill.bundleHash
    })),
    mcpServers: enabledMcpServers.map((server) => ({
      id: server.id,
      version: server.version,
      hash: server.hash
    }))
  };

  return {
    runtimePolicy: {
      ...profile,
      enabledMcpServers: enabledMcpServers.map((server) => server.id)
    },
    skills: enabledSkills,
    mcpServers: enabledMcpServers,
    hash: computeConfigHash(sources),
    sources
  };
}
