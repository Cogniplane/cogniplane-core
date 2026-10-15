import { describe, expect, test, vi } from "vitest";
import { PERSON_ACCESS_NOT_COVERED, type McpCredentialStatus } from "@cogniplane/shared-types";
import type { AdminMcpServerRecord, AdminSkillRecord } from "./admin-config-records.js";
import { PersonAccessMemberNotFound, PersonAccessService } from "./person-access-service.js";
import { buildDefaultTenantSettingsInput } from "./tenant-settings-store.js";

type Stores = ConstructorParameters<typeof PersonAccessService>[0];
const timestamp = "2026-09-27T12:00:00Z";

function skill(overrides: Partial<AdminSkillRecord> = {}): AdminSkillRecord {
  return {
    skillId: "briefing", skillName: "Briefing", description: null, instructions: "Write a briefing.",
    version: 1, contentHash: "hash", enabled: true, isPublished: true, createdBy: "admin",
    createdAt: timestamp, updatedAt: timestamp, activeRevisionId: 1, activeSourceType: "inline",
    activeBundleName: null, activeBundleStorageUri: null, activeBundleHash: null,
    activeValidationStatus: "valid", activeReviewStatus: "approved", isInherited: false, ...overrides
  };
}

function server(overrides: Partial<AdminMcpServerRecord> = {}): AdminMcpServerRecord {
  return {
    serverId: "research", serverName: "Research", ownerTenantId: "tenant", description: null,
    transportKind: "http", mode: "proxy", routePath: "/mcp/research",
    upstreamUrl: "https://example.com/mcp", upstreamAuthType: "bearer", upstreamAuthName: null,
    upstreamAuthConfigured: true, credentialScope: "organization", credentialBindingId: "binding",
    version: 1, configHash: "hash", enabled: true, isPublished: true, createdBy: "admin",
    createdAt: timestamp, updatedAt: timestamp, ...overrides
  };
}

function setup(options: {
  skills?: AdminSkillRecord[]; testSkills?: AdminSkillRecord[]; adminSkills?: AdminSkillRecord[];
  servers?: AdminMcpServerRecord[]; testServers?: AdminMcpServerRecord[]; adminServers?: AdminMcpServerRecord[];
} = {}) {
  const skills = options.skills ?? [skill()];
  const servers = options.servers ?? [server()];
  const stores = {
    skills: { listSkills: vi.fn<Stores["skills"]["listSkills"]>()
      .mockResolvedValueOnce(skills).mockResolvedValueOnce(options.testSkills ?? skills)
      .mockResolvedValueOnce(options.adminSkills ?? skills) },
    mcpServers: { listMcpServers: vi.fn<Stores["mcpServers"]["listMcpServers"]>()
      .mockResolvedValueOnce(servers).mockResolvedValueOnce(options.testServers ?? servers)
      .mockResolvedValueOnce(options.adminServers ?? servers) },
    tenantMembers: {
      getRole: vi.fn<Stores["tenantMembers"]["getRole"]>().mockResolvedValue("member"),
      isUserBetaTester: vi.fn<Stores["tenantMembers"]["isUserBetaTester"]>().mockResolvedValue(false)
    },
    personalCapabilities: { get: vi.fn<Stores["personalCapabilities"]["get"]>()
      .mockResolvedValue({ selection: null, version: 0 }) },
    tenantSettings: { get: vi.fn<Stores["tenantSettings"]["get"]>().mockResolvedValue({
      ...buildDefaultTenantSettingsInput(), tenantId: "tenant", enabledMcpServerIds: ["research"],
      version: 1, configHash: "hash", updatedAt: timestamp
    }) },
    memberMcpCredentials: { listStatuses: vi.fn<Stores["memberMcpCredentials"]["listStatuses"]>()
      .mockResolvedValue(new Map()) }
  } satisfies Stores;
  return { stores, explain: () => new PersonAccessService(stores).explain("tenant", "member") };
}

describe("person access explanation", () => {
  test("reports inherited defaults and runtime sources without returning instructions or URLs", async () => {
    const f = setup({ skills: [skill({ isInherited: true })], servers: [server({ ownerTenantId: "system" })] });
    const result = await f.explain();
    expect(result).toMatchObject({ tenantId: "tenant", userId: "member", scope: "new_standalone_chat",
      member: { isTestUser: false, defaults: "inherited" }, notCovered: [...PERSON_ACCESS_NOT_COVERED] });
    expect(result.items).toEqual([
      { kind: "skill", id: "briefing", name: "Briefing", runtimeSource: "system", adminPageSource: "system",
        signIn: null, status: "included", gates: [
          { gate: "visible_to_member", result: "pass" }, { gate: "in_member_defaults", result: "pass" },
          { gate: "has_instructions", result: "pass" }
        ] },
      { kind: "connection", id: "research", name: "Research", runtimeSource: "system", adminPageSource: "system",
        signIn: "organization", status: "included", gates: [
          { gate: "visible_to_member", result: "pass" }, { gate: "allowed_for_organization", result: "pass" },
          { gate: "in_member_defaults", result: "pass" }
        ] }
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Write a briefing|example\.com|binding/);
    expect(f.stores.memberMcpCredentials.listStatuses).toHaveBeenCalledWith("tenant", "member", []);
    expect(f.stores.mcpServers.listMcpServers.mock.calls).toEqual([
      ["tenant", false, false, { migrateLegacyAuth: false }],
      ["tenant", false, true, { migrateLegacyAuth: false }],
      ["tenant", true, true, { migrateLegacyAuth: false }]
    ]);
  });

  test.each([false, true])("distinguishes disabled items from test-only items: test-only=%s", async testOnly => {
    const s = skill(), c = server({ credentialScope: "personal" });
    const f = setup({ skills: [], servers: [], adminSkills: [s], adminServers: [c],
      testSkills: testOnly ? [s] : [], testServers: testOnly ? [c] : [] });
    const result = await f.explain();
    expect(result.items).toHaveLength(2);
    for (const item of result.items) {
      expect(item).toMatchObject({ status: "excluded", runtimeSource: null, adminPageSource: "organization" });
      expect(item.gates[0]).toEqual({ gate: "visible_to_member", result: "fail",
        reason: testOnly ? "test_users_only" : "turned_off" });
      expect(item.gates.slice(1).every(gate => gate.result === "not_checked")).toBe(true);
    }
  });

  test("uses the member's runtime winner when the admin catalog has a different source", async () => {
    const f = setup({ skills: [skill({ skillName: "Runtime skill", isInherited: true })],
      adminSkills: [skill()], servers: [server({ serverName: "Runtime connection", ownerTenantId: "system" })],
      adminServers: [server()] });
    f.stores.tenantMembers.isUserBetaTester.mockResolvedValue(true);
    const result = await f.explain();
    expect(result.member.isTestUser).toBe(true);
    expect(result.items.map(item => [item.name, item.runtimeSource, item.adminPageSource]))
      .toEqual([["Runtime skill", "system", "organization"], ["Runtime connection", "system", "organization"]]);
    expect(f.stores.skills.listSkills).toHaveBeenNthCalledWith(1, "tenant", false, true);
  });

  test.each([
    { selection: { skillIds: [], connectorIds: [] }, defaults: "empty", skillStatus: "excluded", connectionStatus: "excluded" },
    { selection: { skillIds: ["briefing"], connectorIds: [] }, defaults: "custom", skillStatus: "included", connectionStatus: "excluded" },
    { selection: { skillIds: [], connectorIds: ["research"] }, defaults: "custom", skillStatus: "excluded", connectionStatus: "included" }
  ])("applies member defaults $selection", async ({ selection, defaults, skillStatus, connectionStatus }) => {
    const f = setup();
    f.stores.personalCapabilities.get.mockResolvedValue({ selection, version: 2 });
    const result = await f.explain();
    expect(result.member.defaults).toBe(defaults);
    expect(result.items.map(item => item.status)).toEqual([skillStatus, connectionStatus]);
    for (const item of result.items.filter(item => item.status === "excluded")) {
      expect(item.gates).toContainEqual({ gate: "in_member_defaults", result: "fail", reason: "not_in_member_defaults" });
    }
  });

  test("excludes blank instructions and uses the default allowlist when settings do not exist", async () => {
    const f = setup({ skills: [skill({ instructions: " \n\t" })] });
    f.stores.tenantSettings.get.mockResolvedValue(null);
    const result = await f.explain();
    expect(result.items[0]).toMatchObject({ status: "excluded", runtimeSource: "organization" });
    expect(result.items[0]!.gates.at(-1)).toEqual({ gate: "has_instructions", result: "fail", reason: "no_instructions" });
    expect(result.items[1]).toMatchObject({ status: "excluded", runtimeSource: "organization", gates: [
      { gate: "visible_to_member", result: "pass" },
      { gate: "allowed_for_organization", result: "fail", reason: "not_allowed_for_organization" },
      { gate: "in_member_defaults", result: "not_checked" }
    ] });
  });

  test.each([
    ["connected", "included", undefined],
    ["not_connected", "excluded", "member_not_connected"],
    ["reconnect_required", "excluded", "member_must_reconnect"],
    ["no_auth", "excluded", "personal_sign_in_not_configured"],
    ["unavailable", "excluded", "sign_in_not_accepted"]
  ] as const)("explains personal credential state %s", async (status, expected, reason) => {
    const personal = server({ credentialScope: "personal" });
    const f = setup({ skills: [], servers: [personal] });
    f.stores.memberMcpCredentials.listStatuses.mockResolvedValue(new Map([["research", {
      status, credentialVersion: 1, accountLabel: "private account"
    } satisfies McpCredentialStatus]]));
    const result = await f.explain();
    expect(result.items[0]!.status).toBe(expected);
    expect(result.items[0]!.gates.at(-1)).toEqual(reason
      ? { gate: "personal_sign_in", result: "fail", reason }
      : { gate: "personal_sign_in", result: "pass" });
    expect(f.stores.memberMcpCredentials.listStatuses).toHaveBeenCalledWith("tenant", "member", [personal]);
    expect(JSON.stringify(result)).not.toContain("private account");
  });

  test("reports pending legacy authentication as unknown without exposing its secret", async () => {
    const f = setup({ skills: [], servers: [server({ credentialScope: "personal", upstreamAuthType: "none",
      upstreamAuthConfigured: false, upstreamUrl: "https://example.com/mcp?api_key=private-legacy-key" })] });
    f.stores.memberMcpCredentials.listStatuses.mockResolvedValue(new Map([["research", {
      status: "no_auth", credentialVersion: 0, accountLabel: null
    }]]));
    const result = await f.explain();
    expect(result.items[0]).toMatchObject({ status: "unknown" });
    expect(result.items[0]!.gates.at(-1)).toEqual({ gate: "personal_sign_in", result: "unknown", reason: "legacy_settings_pending" });
    expect(JSON.stringify(result)).not.toContain("private-legacy-key");
  });

  test("fails the whole lookup when a permitted personal connection has no credential status", async () => {
    const f = setup({ servers: [server({ credentialScope: "personal" })] });
    await expect(f.explain()).rejects.toThrow("Missing personal connection status");
  });

  test("does not require credentials for a connection outside the organization allowlist", async () => {
    const f = setup({ skills: [], servers: [server({ credentialScope: "personal" })] });
    f.stores.tenantSettings.get.mockResolvedValue(null);
    const result = await f.explain();
    expect(result.items[0]).toMatchObject({ status: "excluded" });
    expect(result.items[0]!.gates.at(-1)).toEqual({ gate: "personal_sign_in", result: "not_checked" });
    expect(f.stores.memberMcpCredentials.listStatuses).toHaveBeenCalledWith("tenant", "member", []);
  });

  test("rejects an absent member before reading catalogs", async () => {
    const f = setup();
    f.stores.tenantMembers.getRole.mockResolvedValue(null);
    await expect(f.explain()).rejects.toBeInstanceOf(PersonAccessMemberNotFound);
    expect(f.stores.skills.listSkills).not.toHaveBeenCalled();
    expect(f.stores.personalCapabilities.get).not.toHaveBeenCalled();
  });

  test("rejects a member removed during lookup instead of returning a stale result", async () => {
    const f = setup();
    f.stores.tenantMembers.getRole.mockResolvedValueOnce("member").mockResolvedValueOnce(null);
    await expect(f.explain()).rejects.toBeInstanceOf(PersonAccessMemberNotFound);
    expect(f.stores.tenantMembers.getRole.mock.calls).toEqual([["tenant", "member"], ["tenant", "member"]]);
  });
});
