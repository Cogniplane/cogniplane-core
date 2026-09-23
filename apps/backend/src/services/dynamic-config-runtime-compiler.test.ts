import { test, expect } from "vitest";

import type { AdminMcpServerRecord, AdminSkillRecord, ResolvedRuntimePolicy } from "./admin-config-records.js";
import { compileRuntimeConfig } from "./dynamic-config-runtime-compiler.js";

const baseSkill: AdminSkillRecord = {
  skillId: "skill-improver",
  skillName: "Skill improver",
  description: null,
  instructions: "Analyze a corpus and propose improvements.",
  version: 1,
  contentHash: "hash-skill-improver",
  enabled: true,
  isPublished: true,
  createdBy: "system",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  activeRevisionId: 1,
  activeSourceType: "inline",
  activeBundleName: null,
  activeBundleStorageUri: null,
  activeBundleHash: "hash-skill-improver",
  activeValidationStatus: "validated",
  activeReviewStatus: "active",
  associatedToolIds: ["write_artifact"],
  isInherited: false
};

const profile: ResolvedRuntimePolicy = {
  id: "tenant-settings:tenant-1",
  label: "Tenant Settings",
  description: null,
  webSearchMode: "disabled",
  approvalPolicy: "never",
  approvalReviewer: "user",
  sandboxMode: "workspace-write",
  networkMode: "restricted",
  allowCommandExecution: false,
  autoApproveReadOnlyTools: true,
  policyEnforcementMode: "monitor",
  developerInstructions: null,
  enabledToolIds: ["write_artifact"],
  enabledMcpServers: [],
  version: 1,
  hash: "hash-profile"
};

test("session choices intersect current admin availability, including empty and stale selections", async () => {
  const server: AdminMcpServerRecord = {
    serverId: "docs", serverName: "Docs", description: null, mode: "proxy", routePath: "/mcp/docs",
    transportKind: "http", upstreamUrl: "https://example.test/mcp", version: 1, configHash: "docs-hash",
    upstreamAuthType: "none", upstreamAuthName: null, upstreamAuthConfigured: false,
    enabled: true, isPublished: true, createdBy: "admin", createdAt: "", updatedAt: ""
  };
  const input = { tenantId: "tenant", isBetaTester: false, runtimePolicy: { ...profile, enabledMcpServers: ["docs"] },
    skills: { listSkills: async () => [baseSkill] }, mcpServers: { listMcpServers: async () => [server] } };
  const defaults = await compileRuntimeConfig(input);
  const none = await compileRuntimeConfig({ ...input, selection: { skillIds: [], connectorIds: [] } });
  expect(none.skills).toEqual([]);
  expect(none.mcpServers).toEqual([]);
  expect(none.runtimePolicy.enabledMcpServers).toEqual([]);
  expect(none.hash).not.toBe(defaults.hash);
  const selected = await compileRuntimeConfig({ ...input,
    selection: { skillIds: [baseSkill.skillId, "removed"], connectorIds: ["docs", "foreign"] } });
  expect(selected.skills.map((s) => s.id)).toEqual([baseSkill.skillId]);
  expect(selected.mcpServers.map((s) => s.id)).toEqual(["docs"]);
  const revoked = await compileRuntimeConfig({ ...input, runtimePolicy: profile,
    skills: { listSkills: async () => [] }, selection: { skillIds: [baseSkill.skillId], connectorIds: ["docs"] } });
  expect(revoked.skills).toEqual([]);
  expect(revoked.runtimePolicy.enabledMcpServers).toEqual([]);
});

test("compileRuntimeConfig propagates associatedToolIds onto each skill", async () => {
  const bundle = await compileRuntimeConfig({
    tenantId: "tenant-1",
    skills: { listSkills: async () => [baseSkill] },
    mcpServers: { listMcpServers: async () => [] as AdminMcpServerRecord[] },
    runtimePolicy: profile,
    isBetaTester: true
  });

  expect(bundle.skills.length).toBe(1);
  expect(bundle.skills[0].associatedToolIds).toEqual(["write_artifact"]);
});

test("compileRuntimeConfig defaults associatedToolIds to empty when missing", async () => {
  const skillWithoutTools: AdminSkillRecord = { ...baseSkill, associatedToolIds: undefined };

  const bundle = await compileRuntimeConfig({
    tenantId: "tenant-1",
    skills: { listSkills: async () => [skillWithoutTools] },
    mcpServers: { listMcpServers: async () => [] as AdminMcpServerRecord[] },
    runtimePolicy: profile,
    isBetaTester: true
  });

  expect(bundle.skills.length).toBe(1);
  expect(bundle.skills[0].associatedToolIds).toEqual(undefined);
});

test("compileRuntimeConfig filters MCP servers to the tenant policy's enabled set", async () => {
  const tenantProfile: ResolvedRuntimePolicy = {
    ...profile,
    enabledMcpServers: ["managed-session-context"]
  };
  const enabledServer: AdminMcpServerRecord = {
    serverId: "managed-session-context",
    serverName: "Session context",
    description: null,
    transportKind: "http",
    mode: "managed",
    routePath: "/mcp/managed-session-context",
    upstreamUrl: null,
    upstreamAuthType: "none",
    upstreamAuthName: null,
    upstreamAuthConfigured: false,
    version: 1,
    configHash: "hash-mcp",
    enabled: true,
    isPublished: true,
    createdBy: "system",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const disabledServer: AdminMcpServerRecord = {
    ...enabledServer,
    serverId: "github",
    serverName: "GitHub",
    routePath: "/mcp/github",
    configHash: "hash-github"
  };

  const bundle = await compileRuntimeConfig({
    tenantId: "tenant-1",
    skills: { listSkills: async () => [baseSkill] },
    mcpServers: { listMcpServers: async () => [enabledServer, disabledServer] },
    runtimePolicy: tenantProfile,
    isBetaTester: true
  });

  // Only servers the tenant policy enables survive; skills are not narrowed.
  expect(bundle.mcpServers.map((s) => s.id)).toEqual(["managed-session-context"]);
  expect(bundle.skills.map((s) => s.id)).toEqual(["skill-improver"]);
});

test("compileRuntimeConfig keeps only one enabled MCP server per server ID", async () => {
  const tenantProfile: ResolvedRuntimePolicy = {
    ...profile,
    enabledMcpServers: ["managed-session-context"]
  };
  const firstServer: AdminMcpServerRecord = {
    serverId: "managed-session-context",
    serverName: "Tenant context",
    description: null,
    transportKind: "http",
    mode: "managed",
    routePath: "/mcp/tenant-context",
    upstreamUrl: null,
    upstreamAuthType: "none",
    upstreamAuthName: null,
    upstreamAuthConfigured: false,
    version: 2,
    configHash: "tenant-hash",
    enabled: true,
    isPublished: true,
    createdBy: "tenant-admin",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const duplicateServer: AdminMcpServerRecord = {
    ...firstServer,
    serverName: "System context",
    routePath: "/mcp/system-context",
    configHash: "system-hash"
  };

  const bundle = await compileRuntimeConfig({
    tenantId: "tenant-1",
    skills: { listSkills: async () => [baseSkill] },
    mcpServers: { listMcpServers: async () => [firstServer, duplicateServer] },
    runtimePolicy: tenantProfile,
    isBetaTester: true
  });

  expect(bundle.mcpServers).toHaveLength(1);
  expect(bundle.mcpServers[0]).toMatchObject({ id: "managed-session-context", hash: "tenant-hash" });
});

test("compileRuntimeConfig adds integration tool IDs and hashes them", async () => {
  const managedServer: AdminMcpServerRecord = {
    serverId: "managed-session-context", serverName: "Session context", description: null, mode: "managed",
    routePath: "/mcp/managed-session-context", transportKind: "http", upstreamUrl: null,
    upstreamAuthType: "none", upstreamAuthName: null, upstreamAuthConfigured: false, version: 1,
    configHash: "managed-hash", enabled: true, isPublished: true, createdBy: "system", createdAt: "", updatedAt: ""
  };
  const input = {
    tenantId: "tenant-1",
    isBetaTester: false,
    skills: { listSkills: async () => [] },
    mcpServers: { listMcpServers: async () => [managedServer] },
    runtimePolicy: { ...profile, enabledMcpServers: ["managed-session-context"] }
  };

  const withoutIntegrations = await compileRuntimeConfig(input);
  const readOnly = await compileRuntimeConfig({ ...input, integrationToolIds: ["github_read_file"] });
  const readWrite = await compileRuntimeConfig({
    ...input, integrationToolIds: ["github_read_file", "github_write_file", "github_read_file"]
  });

  expect(withoutIntegrations.runtimePolicy.enabledToolIds).toEqual(["write_artifact"]);
  expect(readOnly.runtimePolicy.enabledToolIds).toEqual(["write_artifact", "github_read_file"]);
  expect(readWrite.runtimePolicy.enabledToolIds).toEqual(["write_artifact", "github_read_file", "github_write_file"]);
  // Toggle and connection changes do not touch tenant settings, so the
  // resolved IDs must change the hash that refreshes a warm runtime.
  expect(new Set([withoutIntegrations.hash, readOnly.hash, readWrite.hash]).size).toBe(3);
});
