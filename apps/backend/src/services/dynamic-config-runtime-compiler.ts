import { computeConfigHash, unique } from "../lib/crypto-utils.js";

import type {
  AdminMcpServerRecord,
  AdminSkillRecord,
  McpServerRegistration,
  ResolvedRuntimePolicy,
  RuntimeMcpServerRecord,
  RuntimeConfigBundle,
  RuntimeSkillDefinition
} from "./admin-config-records.js";
import type { McpServerStore } from "./mcp-server-store.js";
import type { SkillConfigStore } from "./skills/skill-config-store.js";
import type { SessionCapabilitySelection } from "@cogniplane/shared-types";

export function normalizeMcpServer(
  record: AdminMcpServerRecord | RuntimeMcpServerRecord
): McpServerRegistration {
  return {
    id: record.serverId,
    description: record.description ?? record.serverName,
    mode: record.mode,
    routePath: record.routePath,
    upstreamUrl: record.upstreamUrl,
    upstreamAuth: "upstreamAuth" in record ? record.upstreamAuth : null,
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
  selection?: SessionCapabilitySelection | null;
  /**
   * Integration tool IDs this session may use (integration toggle on and user
   * connected). The caller removes integration IDs from
   * `runtimePolicy.enabledToolIds` first; the toggles are their only source.
   */
  integrationToolIds?: readonly string[];
}): Promise<RuntimeConfigBundle> {
  const isBetaTester = input.isBetaTester;
  const profile = input.runtimePolicy;

  const [allSkills, allMcpServers] = await Promise.all([
    input.skills.listSkills(input.tenantId, false, isBetaTester),
    input.mcpServers.listMcpServers(input.tenantId, false, isBetaTester)
  ]);

  const enabledSkills = allSkills
    .filter((skill) => !input.selection || input.selection.skillIds.includes(skill.skillId))
    .map((skill) => normalizeSkill(skill));
  const enabledMcpServerIds = new Set<string>();
  const enabledMcpServers = allMcpServers.flatMap((server) => {
    if (!profile.enabledMcpServers.includes(server.serverId) || enabledMcpServerIds.has(server.serverId) ||
        (input.selection && !input.selection.connectorIds.includes(server.serverId))) {
      return [];
    }

    enabledMcpServerIds.add(server.serverId);
    return [normalizeMcpServer(server)];
  });

  // Integration tools reach the agent through a managed server, so the tenant
  // and session server gates apply to them like any other managed tool.
  const integrationToolIds = unique([...(input.integrationToolIds ?? [])]).sort();
  const enabledToolIds = unique([...profile.enabledToolIds, ...integrationToolIds]);

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
    })),
    // The tenant settings hash does not cover the integration toggles or the
    // user's connections, so the resolved IDs are part of the hash.
    integrationToolIds
  };

  return {
    runtimePolicy: {
      ...profile,
      enabledToolIds,
      enabledMcpServers: enabledMcpServers.map((server) => server.id)
    },
    skills: enabledSkills,
    mcpServers: enabledMcpServers,
    hash: computeConfigHash(sources),
    sources
  };
}
