import { test, expect } from "vitest";

import type { AdminMcpServerRecord, AdminSkillRecord, ResolvedRuntimePolicy } from "./admin-config-records.js";
import {
  applySessionOverride,
  compileRuntimeConfig,
  filterSkillsByOverride
} from "./dynamic-config-runtime-compiler.js";
import type { SessionRuntimeOverrideRecord } from "./session-runtime-override-store.js";

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
  runtimeProvider: "codex",
  approvalPolicy: "never",
  approvalReviewer: "user",
  sandboxMode: "workspace-write",
  networkMode: "restricted",
  allowCommandExecution: false,
  allowUserTokenForwarding: true,
  autoApproveReadOnlyTools: true,
  developerInstructions: null,
  enabledToolIds: ["write_artifact"],
  enabledMcpServers: [],
  version: 1,
  hash: "hash-profile"
};

test("compileRuntimeConfig propagates associatedToolIds onto each skill", async () => {
  const bundle = await compileRuntimeConfig({
    tenantId: "tenant-1",
    skills: { listSkills: async () => [baseSkill] },
    mcpServers: { listMcpServers: async () => [] as AdminMcpServerRecord[] },
    runtimePolicy: profile
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
    runtimePolicy: profile
  });

  expect(bundle.skills.length).toBe(1);
  expect(bundle.skills[0].associatedToolIds).toEqual(undefined);
});

// ── applySessionOverride / filterSkillsByOverride ───────────────────────────

const tenantProfile: ResolvedRuntimePolicy = {
  ...profile,
  approvalPolicy: "on-request",
  autoApproveReadOnlyTools: false,
  enabledToolIds: ["session_context", "list_artifacts", "read_text_artifact", "write_artifact", "shell"],
  enabledMcpServers: ["managed-session-context", "github", "notion"]
};

function makeOverride(overrides: Partial<SessionRuntimeOverrideRecord> = {}): SessionRuntimeOverrideRecord {
  return {
    tenantId: "tenant-1",
    sessionId: "session-1",
    runtimeProvider: null,
    enabledToolIds: [],
    enabledMcpServerIds: [],
    enabledSkillIds: [],
    approvalPolicy: "never",
    autoApproveReadOnlyTools: true,
    createdBy: "user-1",
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

test("applySessionOverride returns the profile unchanged when no override exists", () => {
  const result = applySessionOverride({ profile: tenantProfile, override: null });
  expect(result).toEqual(tenantProfile);
});

test("applySessionOverride intersects enabled tool/MCP ids — never adds", () => {
  const result = applySessionOverride({
    profile: tenantProfile,
    override: makeOverride({
      enabledToolIds: ["session_context", "write_artifact", "tool-not-in-tenant"],
      enabledMcpServerIds: ["managed-session-context", "server-not-in-tenant"]
    })
  });

  // Tenant tools narrowed to the intersection; the rogue id is dropped.
  expect(result.enabledToolIds).toEqual(["session_context", "write_artifact"]);
  expect(result.enabledMcpServers).toEqual(["managed-session-context"]);
});

test("applySessionOverride leaves tool/MCP lists untouched when the override is empty", () => {
  const result = applySessionOverride({
    profile: tenantProfile,
    override: makeOverride()
  });
  expect(result.enabledToolIds).toEqual(tenantProfile.enabledToolIds);
  expect(result.enabledMcpServers).toEqual(tenantProfile.enabledMcpServers);
});

test("applySessionOverride replaces approval policy and auto-approve flag", () => {
  const result = applySessionOverride({
    profile: tenantProfile,
    override: makeOverride({ approvalPolicy: "never", autoApproveReadOnlyTools: true })
  });
  expect(result.approvalPolicy).toBe("never");
  expect(result.autoApproveReadOnlyTools).toBe(true);
});

test("applySessionOverride replaces runtimeProvider when present, otherwise keeps the tenant value", () => {
  const overridden = applySessionOverride({
    profile: tenantProfile,
    override: makeOverride({ runtimeProvider: "claude-code" })
  });
  expect(overridden.runtimeProvider).toBe("claude-code");

  const untouched = applySessionOverride({
    profile: tenantProfile,
    override: makeOverride({ runtimeProvider: null })
  });
  expect(untouched.runtimeProvider).toBe(tenantProfile.runtimeProvider);
});

test("filterSkillsByOverride keeps every skill when the override's skill list is empty", () => {
  const skills = [baseSkill, { ...baseSkill, skillId: "other-skill" }];
  const result = filterSkillsByOverride(skills, makeOverride());
  expect(result.length).toBe(2);
});

test("filterSkillsByOverride keeps only skills listed in the override", () => {
  const skills = [
    baseSkill,
    { ...baseSkill, skillId: "other-skill" },
    { ...baseSkill, skillId: "third-skill" }
  ];
  const result = filterSkillsByOverride(skills, makeOverride({ enabledSkillIds: ["other-skill"] }));
  expect(result.length).toBe(1);
  expect(result[0]?.skillId).toBe("other-skill");
});

test("compileRuntimeConfig honors the session override end-to-end", async () => {
  const otherSkill: AdminSkillRecord = { ...baseSkill, skillId: "other-skill", skillName: "Other" };
  const tenantMcpServer: AdminMcpServerRecord = {
    serverId: "managed-session-context",
    serverName: "Session context",
    description: null,
    transportKind: "http",
    mode: "managed",
    routePath: "/mcp/managed-session-context",
    upstreamUrl: null,
    headersAllowlist: [],
    version: 1,
    configHash: "hash-mcp",
    enabled: true,
    isPublished: true,
    createdBy: "system",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const otherMcpServer: AdminMcpServerRecord = {
    ...tenantMcpServer,
    serverId: "github",
    serverName: "GitHub",
    routePath: "/mcp/github",
    configHash: "hash-github"
  };

  const bundle = await compileRuntimeConfig({
    tenantId: "tenant-1",
    skills: { listSkills: async () => [baseSkill, otherSkill] },
    mcpServers: { listMcpServers: async () => [tenantMcpServer, otherMcpServer] },
    runtimePolicy: tenantProfile,
    sessionOverride: makeOverride({
      enabledSkillIds: ["skill-improver"],
      enabledMcpServerIds: ["managed-session-context"],
      enabledToolIds: ["session_context", "write_artifact"],
      approvalPolicy: "never"
    })
  });

  expect(bundle.skills.map((s) => s.id)).toEqual(["skill-improver"]);
  expect(bundle.mcpServers.map((s) => s.id)).toEqual(["managed-session-context"]);
  expect(bundle.runtimePolicy.enabledToolIds).toEqual(["session_context", "write_artifact"]);
  expect(bundle.runtimePolicy.approvalPolicy).toBe("never");
});
