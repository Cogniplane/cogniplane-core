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

export async function compileRuntimeConfig(input: {
  tenantId: string;
  skills: Pick<SkillConfigStore, "listSkills">;
  mcpServers: Pick<McpServerStore, "listMcpServers">;
  runtimePolicy: ResolvedRuntimePolicy;
  isBetaTester: boolean;
}): Promise<RuntimeConfigBundle> {
  const isBetaTester = input.isBetaTester;
  const profile = input.runtimePolicy;

  const [allSkills, allMcpServers] = await Promise.all([
    input.skills.listSkills(input.tenantId, false, isBetaTester),
    input.mcpServers.listMcpServers(input.tenantId, false, isBetaTester)
  ]);

  const enabledSkills = allSkills.map((skill) => normalizeSkill(skill));
  const enabledMcpServerIds = new Set<string>();
  const enabledMcpServers = allMcpServers.flatMap((server) => {
    if (!profile.enabledMcpServers.includes(server.serverId) || enabledMcpServerIds.has(server.serverId)) {
      return [];
    }

    enabledMcpServerIds.add(server.serverId);
    return [normalizeMcpServer(server)];
  });

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
