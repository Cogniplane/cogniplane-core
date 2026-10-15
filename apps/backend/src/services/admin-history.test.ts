import { describe, expect, test } from "vitest";
import { AdminHistoryIdSchema } from "@cogniplane/shared-types";
import { projectHistoryEvent, type HistoryRow } from "./admin-history-projection.js";
import { compareSettings } from "./admin-settings-comparison.js";

const row = (payload: unknown, id = "1"): HistoryRow => ({ id, payload, event_type: "admin.tenant_settings.updated", created_at: "2026-09-27T12:00:00.000001Z", user_id: "actor", display_name: "Alex" });
describe("admin history read boundary", () => {
  test("rejects malformed and overflowing IDs without throwing or rounding", () => {
    for (const id of ["abc", "-1", "0", "1.5", "9223372036854775808", "1e3"]) expect(AdminHistoryIdSchema.safeParse(id).success).toBe(false);
    expect(AdminHistoryIdSchema.parse("9007199254740993")).toBe("9007199254740993");
  });
  test("exposes only reviewed metadata and no historical instructions or unknown payload", () => {
    const event = projectHistoryEvent(row({ version: 4, developerInstructions: "private instructions", apiKey: "secret-value", nested: { credential: "secret-value" } }));
    expect(event.details).toEqual([{ label: "Recorded version", value: "4" }]);
    expect(JSON.stringify(event)).not.toMatch(/private instructions|secret-value|apiKey/);
    expect(projectHistoryEvent({ ...row({}), user_id: null, display_name: null }).actor.name).toBe("Actor no longer available");
    expect(() => projectHistoryEvent({ ...row({}), event_type: "admin.unreviewed" })).toThrow();
  });
  test("shows the credential scope and audience that MCP and skill events store", () => {
    const mcp = projectHistoryEvent({ ...row({ serverId: "crm", version: 2, credentialScope: "personal", enabled: true, audience: "test_users" }),
      event_type: "admin.mcp_server.updated" });
    expect(mcp.details).toEqual([
      { label: "Connection", value: "crm" },
      { label: "Recorded version", value: "2" },
      { label: "Credentials belong to", value: "personal" },
      { label: "Enabled", value: "Yes" },
      { label: "Audience", value: "test users" }
    ]);
    const skill = projectHistoryEvent({ ...row({ skillId: "brief", version: 1, audience: "test-users" }), event_type: "admin.skill.activated" });
    expect(skill.details).toContainEqual({ label: "Audience", value: "test users" });
  });
  test("compares known values, normalizes list order and hides free text", () => {
    const result = compareSettings(row({ enabledToolIds: ["b", "a"], allowCommandExecution: false, developerInstructions: "old private text" }), row({ enabledToolIds: ["a", "b"], allowCommandExecution: true, developerInstructions: "new private text" }, "2"));
    expect(result.unchangedCount).toBe(1);
    expect(result.changes).toContainEqual({ field: "allowCommandExecution", label: "Command execution", before: "Off", after: "On", status: "changed" });
    expect(result.changes.find(c => c.field === "developerInstructions")).toMatchObject({ before: "Set, content hidden", after: "Set, content hidden", status: "changed" });
    expect(JSON.stringify(result)).not.toMatch(/old private text|new private text/);
  });
  test("does not invent historical defaults or equality for redacted values", () => {
    const result = compareSettings(row({ developerInstructions: "[REDACTED]" }), row({ defaultModelId: null, developerInstructions: "[REDACTED]" }, "2"));
    expect(result.changes.find(c => c.field === "defaultModelId")).toMatchObject({ before: "Not recorded", after: "No organization default", status: "unavailable" });
    expect(result.changes.find(c => c.field === "developerInstructions")?.status).toBe("unavailable");
    expect(result.unchangedCount).toBe(0);
  });

  test("compares approval modes and preserves missing optional approval settings", () => {
    const result = compareSettings(row({ approvalPolicy: "never" }), row({ approvalPolicy: "on-request" }, "2"));
    expect(result.changes.find(c => c.field === "approvalPolicy")).toMatchObject({
      before: "Never ask", after: "Ask when requested", status: "changed"
    });
    const granular = { sandbox_approval: true, mcp_elicitations: false, rules: true };
    const change = compareSettings(row({ approvalPolicy: { granular } }), row({ approvalPolicy: {
      granular: { ...granular, request_permissions: false, skill_approval: true }
    } }, "2")).changes.find(c => c.field === "approvalPolicy");
    expect(change).toMatchObject({ status: "changed",
      before: "Sandbox: ask; Connection prompts: do not ask; Rules: ask; Permissions: not recorded; Skills: not recorded",
      after: "Sandbox: ask; Connection prompts: do not ask; Rules: ask; Permissions: do not ask; Skills: ask" });
  });

  test.each([
    ["allowCommandExecution", "false"],
    ["approvalReviewer", "unknown-reviewer"],
    ["webSearchMode", 1],
    ["defaultModelId", "https://example.com/?token=private"],
    ["enabledToolIds", "tool"],
    ["enabledToolIds", ["valid", "invalid identifier"]],
    ["enabledToolIds", Array.from({ length: 501 }, (_, i) => `tool-${i}`)],
    ["developerInstructions", { content: "private instructions" }],
    ["approvalPolicy", { granular: { sandbox_approval: true } }],
    ["approvalPolicy", { granular: { sandbox_approval: true, mcp_elicitations: true, rules: false, skill_approval: "false" } }],
    ["modelDefaultEfforts", null],
    ["modelDefaultEfforts", "high"],
    ["modelDefaultEfforts", []],
    ["modelDefaultEfforts", { "invalid id": "high" }],
    ["modelDefaultEfforts", { model: 1 }],
    ["modelDefaultEfforts", { model: "unknown-effort" }],
    ["modelDefaultEfforts", Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`model-${i}`, "high"]))]
  ])("does not treat malformed %s values as equal or expose their content", (field, value) => {
    const result = compareSettings(row({ [field]: value }), row({ [field]: value }, "2"));
    expect(result.changes.find(c => c.field === field)).toMatchObject({
      before: "Not available in this record", after: "Not available in this record", status: "unavailable"
    });
    expect(result.unchangedCount).toBe(0);
    expect(JSON.stringify(result)).not.toMatch(/private instructions|token=private|unknown-effort/);
  });

  test("compares approved sandbox hosts, wildcards included, and ignores their order", () => {
    const change = (before: unknown, after: unknown) =>
      compareSettings(row({ approvedSandboxEgressDomains: before }), row({ approvedSandboxEgressDomains: after }, "2"))
        .changes.find(c => c.field === "approvedSandboxEgressDomains");
    expect(change([], ["pypi.org", "*.example.com"])).toEqual({
      field: "approvedSandboxEgressDomains", label: "Approved sandbox hosts",
      before: "None. The sandbox has no network.", after: "*.example.com, pypi.org", status: "changed"
    });
    // The same hosts in another order, or repeated, are the same setting.
    expect(change(["pypi.org", "*.example.com"], ["*.example.com", "pypi.org", "pypi.org"])).toBeUndefined();
    // A record from before the field existed is not invented as "no hosts".
    expect(compareSettings(row({}), row({ approvedSandboxEgressDomains: [] }, "2"))
      .changes.find(c => c.field === "approvedSandboxEgressDomains"))
      .toMatchObject({ before: "Not recorded", after: "None. The sandbox has no network.", status: "unavailable" });
  });

  test.each([
    ["not a list", "pypi.org"],
    ["an entry that is not text", ["pypi.org", 4]],
    ["an entry that is not a host", ["pypi.org", "https://x.example/?token=private"]],
    ["too many entries", Array.from({ length: 501 }, (_, i) => `h${i}.example.com`)]
  ])("does not treat approved sandbox hosts as equal when the value is %s", (_label, value) => {
    const result = compareSettings(row({ approvedSandboxEgressDomains: value }), row({ approvedSandboxEgressDomains: value }, "2"));
    expect(result.changes.find(c => c.field === "approvedSandboxEgressDomains")).toMatchObject({
      before: "Not available in this record", after: "Not available in this record", status: "unavailable"
    });
    expect(JSON.stringify(result)).not.toContain("token=private");
  });

  test("normalizes model effort maps and duplicate lists without reporting a change", () => {
    const result = compareSettings(row({ modelDefaultEfforts: { z: "high", a: "low" }, enabledModelIds: ["z", "a", "z"] }),
      row({ modelDefaultEfforts: { a: "low", z: "high" }, enabledModelIds: ["a", "z"] }, "2"));
    expect(result.unchangedCount).toBe(2);
    expect(result.changes.map(c => c.field)).not.toContain("modelDefaultEfforts");
    expect(result.changes.map(c => c.field)).not.toContain("enabledModelIds");
  });

  test("distinguishes explicit defaults, empty values, and selected settings", () => {
    const result = compareSettings(row({ enabledModelIds: null, defaultModelId: null, modelDefaultEfforts: {},
      enabledToolIds: [], developerInstructions: null, approvalReviewer: "user" }),
    row({ enabledModelIds: ["model-a"], defaultModelId: "model-a", modelDefaultEfforts: { "model-a": "high" },
      enabledToolIds: ["search"], developerInstructions: "", approvalReviewer: "guardian_subagent" }, "2"));
    const changes = Object.fromEntries(result.changes.map(c => [c.field, c]));
    expect(changes.enabledModelIds).toMatchObject({ before: "All catalog models", after: "model-a", status: "changed" });
    expect(changes.defaultModelId).toMatchObject({ before: "No organization default", after: "model-a", status: "changed" });
    expect(changes.modelDefaultEfforts).toMatchObject({ before: "Catalog defaults", after: "model-a: high", status: "changed" });
    expect(changes.enabledToolIds).toMatchObject({ before: "None", after: "search", status: "changed" });
    expect(changes.developerInstructions).toMatchObject({ before: "Not set", after: "Not set", status: "changed" });
    expect(changes.approvalReviewer).toMatchObject({ before: "user", after: "guardian subagent", status: "changed" });
  });

  test.each([null, [], "private text"])("handles non-object historical payloads without inventing values: %j", payload => {
    const result = compareSettings(row(payload), row({}, "2"));
    expect(result.unchangedCount).toBe(0);
    expect(result.changes).toHaveLength(15);
    expect(result.changes.every(c => c.status === "unavailable" && c.before === "Not recorded" && c.after === "Not recorded")).toBe(true);
    expect(result.before).toEqual({ eventId: "1", version: null, createdAt: row({}).created_at, actorName: "Alex" });
    expect(result.after.eventId).toBe("2");
  });

  test("projects reviewed policy fields and omits malformed or private data", () => {
    const event = projectHistoryEvent({ ...row({ ruleId: "rule-1", effect: "require_approval", enabled: false, secret: "private text" }),
      event_type: "admin.policy_rule.created", display_name: "   " });
    expect(event.actor.name).toBe("Member, name unavailable");
    expect(event.details).toEqual([
      { label: "Rule", value: "rule-1" }, { label: "Effect", value: "require approval" }, { label: "Enabled", value: "No" }
    ]);
    expect(event.settingsVersion).toBeNull();
    expect(event.target).toEqual({ label: "Open policies", href: "/admin/policy" });
    const malformed = projectHistoryEvent({ ...row({ ruleId: {}, effect: "unknown", enabled: "true" }), event_type: "admin.policy_rule.updated" });
    expect(malformed.details).toEqual([]);
    expect(JSON.stringify(event)).not.toContain("private text");
    expect(projectHistoryEvent({ ...row({ enabled: true }), event_type: "admin.policy_rule.updated" }).details)
      .toEqual([{ label: "Enabled", value: "Yes" }]);
  });

  test("shows counts instead of affected IDs and hides invalid counts", () => {
    const event = (payload: unknown) => projectHistoryEvent({ ...row(payload), event_type: "admin.runtime_rollout.executed" });
    expect(event({ affectedSessionIds: ["private-a", "private-b"] }).details)
      .toEqual([{ label: "Workspaces affected", value: "2" }]);
    expect(event({ affectedSessionIds: "private-a" }).details).toEqual([]);
  });

  test("formats budget values and rejects negative, non-finite, and nonnumeric amounts", () => {
    const event = (payload: unknown) => projectHistoryEvent({ ...row(payload), event_type: "model_spending_policy_updated" });
    expect(event({ monthlyLimitUsd: null, turnReservationUsd: 0.25, version: 2 }).details).toEqual([
      { label: "Monthly limit", value: "No limit" }, { label: "Hold per turn", value: "$0.25" }, { label: "Recorded version", value: "2" }
    ]);
    for (const amount of [-1, Infinity, NaN, "25"]) {
      expect(event({ monthlyLimitUsd: amount, turnReservationUsd: amount }).details).toEqual([]);
    }
  });

  test.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "4", null])("does not display an invalid recorded version: %s", version => {
    const event = projectHistoryEvent(row({ version }));
    expect(event.settingsVersion).toBeNull();
    expect(event.details).toEqual([]);
  });
});
