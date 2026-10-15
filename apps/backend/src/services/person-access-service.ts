import {
  PERSON_ACCESS_NOT_COVERED,
  type AdminPersonAccessResponse,
  type PersonAccessGateCheck,
  type PersonAccessItem,
  type PersonAccessReason
} from "@cogniplane/shared-types";
import type { SkillConfigStore } from "./skills/skill-config-store.js";
import { pendingLegacyQueryAuth, type McpServerStore } from "./mcp-server-store.js";
import type { TenantMemberStore } from "./tenant-member-store.js";
import type { PersonalCapabilityStore } from "./personal-capability-store.js";
import { buildDefaultTenantSettingsInput, type TenantSettingsStore } from "./tenant-settings-store.js";
import type { MemberMcpCredentialStore } from "./member-mcp-credential-store.js";
import {
  acceptsPersonalCredential, connectionInclusion, hasSkillInstructions,
  intersectCapabilities, isCapabilitySelected, personalServersToCheck
} from "./capability-selection.js";

type Stores = {
  skills: Pick<SkillConfigStore, "listSkills">;
  mcpServers: Pick<McpServerStore, "listMcpServers">;
  tenantMembers: Pick<TenantMemberStore, "getRole" | "isUserBetaTester">;
  personalCapabilities: Pick<PersonalCapabilityStore, "get">;
  tenantSettings: Pick<TenantSettingsStore, "get">;
  memberMcpCredentials: Pick<MemberMcpCredentialStore, "listStatuses">;
};

export class PersonAccessMemberNotFound extends Error {}

function check(gate: PersonAccessGateCheck["gate"], passed: boolean, reason: PersonAccessReason): PersonAccessGateCheck {
  return passed ? { gate, result: "pass" } : { gate, result: "fail", reason };
}

function finish(item: Omit<PersonAccessItem, "status">): PersonAccessItem {
  let status: PersonAccessItem["status"] = "included";
  const gates = item.gates.map((gate): PersonAccessGateCheck => {
    if (status !== "included") return { gate: gate.gate, result: "not_checked" };
    if (gate.result === "fail") status = "excluded";
    if (gate.result === "unknown") status = "unknown";
    return gate;
  });
  return { ...item, status, gates };
}

export class PersonAccessService {
  constructor(private readonly stores: Stores) {}

  async explain(tenantId: string, userId: string): Promise<AdminPersonAccessResponse> {
    const s = this.stores;
    if (!await s.tenantMembers.getRole(tenantId, userId)) throw new PersonAccessMemberNotFound();
    const [isTestUser, defaults, settings] = await Promise.all([
      s.tenantMembers.isUserBetaTester(tenantId, userId),
      s.personalCapabilities.get(tenantId, userId),
      s.tenantSettings.get(tenantId)
    ]);
    const selection = intersectCapabilities(null, defaults.selection);
    const allowedServerIds = settings?.enabledMcpServerIds ?? buildDefaultTenantSettingsInput().enabledMcpServerIds;
    // The filtered winner can differ from the admin winner for a legacy shared ID.
    const [skills, testSkills, adminSkills, servers, testServers, adminServers] = await Promise.all([
      s.skills.listSkills(tenantId, false, isTestUser),
      s.skills.listSkills(tenantId, false, true),
      s.skills.listSkills(tenantId, true, true),
      s.mcpServers.listMcpServers(tenantId, false, isTestUser, { migrateLegacyAuth: false }),
      s.mcpServers.listMcpServers(tenantId, false, true, { migrateLegacyAuth: false }),
      s.mcpServers.listMcpServers(tenantId, true, true, { migrateLegacyAuth: false })
    ]);
    // Runtime validates legacy auth before applying the allowlist or chat selection.
    // Preserve that failure without migrating, encrypting, or returning URL data.
    for (const server of servers) pendingLegacyQueryAuth(server);
    const statuses = await s.memberMcpCredentials.listStatuses(tenantId, userId,
      personalServersToCheck(servers, allowedServerIds));
    const skillsById = new Map(skills.map(skill => [skill.skillId, skill]));
    const testSkillIds = new Set(testSkills.map(skill => skill.skillId));
    const serversById = new Map(servers.map(server => [server.serverId, server]));
    const testServerIds = new Set(testServers.map(server => server.serverId));
    const items: PersonAccessItem[] = adminSkills.map(adminSkill => {
      const runtime = skillsById.get(adminSkill.skillId);
      const display = runtime ?? adminSkill;
      return finish({
        kind: "skill", id: display.skillId, name: display.skillName,
        runtimeSource: runtime ? runtime.isInherited ? "system" : "organization" : null,
        adminPageSource: adminSkill.isInherited ? "system" : "organization", signIn: null,
        gates: [
          check("visible_to_member", Boolean(runtime), testSkillIds.has(display.skillId) ? "test_users_only" : "turned_off"),
          check("in_member_defaults", isCapabilitySelected(selection, "skill", display.skillId), "not_in_member_defaults"),
          check("has_instructions", hasSkillInstructions(runtime?.instructions), "no_instructions")
        ]
      });
    });
    for (const adminServer of adminServers) {
      const runtime = serversById.get(adminServer.serverId);
      const display = runtime ?? adminServer;
      const credentialStatus = statuses.get(display.serverId)?.status;
      const checks = connectionInclusion({
        serverId: display.serverId, credentialScope: display.credentialScope,
        allowedServerIds, selection, executingSession: true,
        hasPersonalCredential: acceptsPersonalCredential(credentialStatus)
      });
      const gates: PersonAccessGateCheck[] = [
        check("visible_to_member", Boolean(runtime), testServerIds.has(display.serverId) ? "test_users_only" : "turned_off"),
        check("allowed_for_organization", checks.allowedForOrganization, "not_allowed_for_organization"),
        check("in_member_defaults", checks.inSelection, "not_in_member_defaults")
      ];
      if (runtime && checks.allowedForOrganization && runtime.credentialScope === "personal" && !credentialStatus) {
        throw new Error("Missing personal connection status");
      }
      if (display.credentialScope === "personal") {
        const pending = runtime && pendingLegacyQueryAuth(runtime);
        const reason: PersonAccessReason = credentialStatus === "not_connected" ? "member_not_connected"
          : credentialStatus === "reconnect_required" ? "member_must_reconnect"
          : credentialStatus === "no_auth" ? "personal_sign_in_not_configured" : "sign_in_not_accepted";
        gates.push(pending ? { gate: "personal_sign_in", result: "unknown", reason: "legacy_settings_pending" }
          : check("personal_sign_in", checks.personalCredentialAccepted, reason));
      }
      items.push(finish({
        kind: "connection", id: display.serverId, name: display.serverName,
        runtimeSource: runtime ? runtime.ownerTenantId === "system" ? "system" : "organization" : null,
        adminPageSource: adminServer.ownerTenantId === "system" ? "system" : "organization",
        signIn: display.credentialScope, gates
      }));
    }
    // A member removed during the lookup must not receive a stale success result.
    if (!await s.tenantMembers.getRole(tenantId, userId)) throw new PersonAccessMemberNotFound();
    return {
      tenantId, userId, scope: "new_standalone_chat", checkedAt: new Date().toISOString(),
      member: { isTestUser, defaults: !selection ? "inherited"
        : selection.skillIds.length === 0 && selection.connectorIds.length === 0 ? "empty" : "custom" },
      notCovered: [...PERSON_ACCESS_NOT_COVERED], items
    };
  }
}
