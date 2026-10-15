import type { AdminHistoryCategory, AdminHistoryEvent } from "@cogniplane/shared-types";
import type { AuditEventType } from "./audit-event-types.js";
import { redactSecrets } from "./redact-secrets.js";

type Definition = { category: AdminHistoryCategory; title: string; fields: readonly string[] };
const entry = (category: AdminHistoryCategory, title: string, fields: readonly string[] = []): Definition => ({ category, title, fields });
// Each entry opts into both an event type and its displayable fields. Do not
// replace this with an admin.* prefix filter or a raw payload response.
export const HISTORY_EVENTS = {
  "admin.tenant_settings.updated": entry("settings", "Organization settings saved", ["version"]),
  "admin.policy_rule.created": entry("policies", "Policy rule created", ["ruleId", "effect", "enabled"]),
  "admin.policy_rule.updated": entry("policies", "Policy rule updated", ["ruleId", "effect", "enabled"]),
  "admin.policy_rule.deleted": entry("policies", "Policy rule deleted", ["ruleId"]),
  "admin.policy_rule.reordered": entry("policies", "Policy rule order changed", ["ruleIds"]),
  "tenant.member.role_changed": entry("people", "Member role changed", ["targetUserId", "previousRole", "role"]),
  "tenant.member.removed": entry("people", "Member removed", ["targetUserId", "previousRole"]),
  "admin.user.beta_tester_updated": entry("people", "Test access changed", ["targetUserId", "isBetaTester"]),
  "tenant.provider_key.updated": entry("models", "Provider credentials changed", ["provider"]),
  "admin.custom_model.created": entry("models", "Custom model added", ["modelId", "provider", "contextWindow"]),
  "admin.custom_model.deleted": entry("models", "Custom model removed", ["modelId"]),
  "tenant.marketplace_url.updated": entry("skills", "Skill marketplace changed"),
  "tenant.pii_protection.updated": entry("policies", "Privacy protection changed"),
  "admin.mcp_server.created": entry("connections", "Connection added", ["serverId", "version", "credentialScope", "enabled", "audience"]),
  "admin.mcp_server.updated": entry("connections", "Connection updated", ["serverId", "version", "credentialScope", "enabled", "audience"]),
  "admin.mcp_server.disabled": entry("connections", "Connection disabled", ["serverId", "version"]),
  "admin.mcp_server.published": entry("connections", "Connection made available", ["serverId", "version"]),
  "admin.mcp_server.unpublished": entry("connections", "Connection availability removed", ["serverId", "version"]),
  "tenant.integration.updated": entry("connections", "Integration access changed", ["integrationId", "readsEnabled", "writesEnabled", "configChanged"]),
  "tenant.integration.config_cleared": entry("connections", "Integration configuration cleared", ["integrationId"]),
  "tenant.integration.runtime_invalidated": entry("connections", "Integration workspaces refreshed", ["integrationId"]),
  "admin.skill.activated": entry("skills", "Skill activated", ["skillId", "version", "audience"]),
  "admin.skill.disabled": entry("skills", "Skill disabled", ["skillId", "version"]),
  "admin.skill.imported": entry("skills", "Skill imported", ["skillId", "version"]),
  "admin.skill.published": entry("skills", "Skill released", ["skillId", "version"]),
  "admin.skill.unpublished": entry("skills", "Skill availability removed", ["skillId", "version"]),
  "admin.skill.reviewed": entry("skills", "Skill reviewed", ["skillId", "version"]),
  "admin.skill.rollback": entry("skills", "Skill version rolled back", ["skillId", "version"]),
  "admin.skill.cleanup.completed": entry("skills", "Skill cleanup completed"),
  "organization.skill_submission.changes_requested": entry("skills", "Changes requested for a submitted skill", ["submissionId"]),
  "organization.skill_submission.declined": entry("skills", "Skill submission declined", ["submissionId"]),
  "organization.skill_submission.accepted": entry("skills", "Skill submission accepted", ["submissionId", "organizationSkillId"]),
  "organization.skill_submission.released": entry("skills", "Submitted skill released", ["submissionId", "organizationSkillId", "audience"]),
  "model_spending_policy_updated": entry("budgets", "Model budget changed", ["monthlyLimitUsd", "turnReservationUsd", "version"]),
  "model_spending_closed": entry("budgets", "Model reservation closed", ["reservationId"]),
  "model_spending_reconciled": entry("budgets", "Model cost reconciled", ["reservationId", "actualUsd"]),
  "admin.runtime_rollout.executed": entry("runtime", "Workspace rollout completed", ["affectedSessionIds"])
} as const satisfies Partial<Record<AuditEventType, Definition>>;
export type HistoryEventType = keyof typeof HISTORY_EVENTS;
export const HISTORY_EVENT_TYPES = Object.keys(HISTORY_EVENTS) as HistoryEventType[];
export const SETTINGS_EVENT = "admin.tenant_settings.updated";
export const isHistoryEventType = (value: string): value is HistoryEventType => Object.hasOwn(HISTORY_EVENTS, value);

export type HistoryRow = {
  id: string; event_type: string; created_at: string; user_id: string | null;
  display_name: string | null; payload: unknown;
};
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function safeIdentifier(value: unknown): string | null {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(value)) return null;
  return redactSecrets(value) === value ? value : null;
}
const LABELS: Record<string, string> = {
  version: "Recorded version", ruleId: "Rule", effect: "Effect", enabled: "Enabled", ruleIds: "Rules reordered",
  targetUserId: "Member", previousRole: "Previous role", role: "New role", userId: "Member", isBetaTester: "Test access",
  provider: "Provider", modelId: "Model", contextWindow: "Context window", serverId: "Connection", credentialScope: "Credentials belong to",
  audience: "Audience", integrationId: "Integration", readsEnabled: "Read access", writesEnabled: "Write access", configChanged: "Configuration changed",
  skillId: "Skill", submissionId: "Submission", organizationSkillId: "Organization skill", monthlyLimitUsd: "Monthly limit",
  turnReservationUsd: "Hold per turn", reservationId: "Reservation", actualUsd: "Verified cost", affectedSessionIds: "Workspaces affected"
};
// MCP events store "personal" and "test_users". Skill events store "test-users".
// Accept every stored spelling so old rows still render.
const ENUMS: Record<string, readonly string[]> = {
  previousRole: ["owner", "admin", "member"], role: ["owner", "admin", "member"],
  effect: ["allow", "block", "require_approval"], credentialScope: ["organization", "personal", "member"],
  audience: ["off", "test_users", "test-users", "members"],
  provider: ["anthropic", "openai", "google", "openrouter", "zai"]
};
const BOOLEANS = new Set(["enabled", "isBetaTester", "readsEnabled", "writesEnabled", "configChanged"]);
const USD = new Set(["monthlyLimitUsd", "turnReservationUsd", "actualUsd"]);
function detailValue(key: string, value: unknown): string | null {
  if (ENUMS[key]) return typeof value === "string" && ENUMS[key].includes(value) ? value.replace(/[_-]/g, " ") : null;
  if (BOOLEANS.has(key)) return typeof value === "boolean" ? value ? "Yes" : "No" : null;
  if (key === "affectedSessionIds" || key === "ruleIds") return Array.isArray(value) ? String(value.length) : null;
  if (USD.has(key)) {
    if (key === "monthlyLimitUsd" && value === null) return "No limit";
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(value) : null;
  }
  if (key === "version" || key === "contextWindow") return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  return safeIdentifier(value);
}
export function settingsVersion(payload: unknown): number | null {
  const value = record(payload).version;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
export function projectHistoryEvent(row: HistoryRow): AdminHistoryEvent {
  if (!isHistoryEventType(row.event_type)) throw new Error("Unreviewed audit event.");
  const def = HISTORY_EVENTS[row.event_type];
  const payload = record(row.payload);
  const targets: Partial<Record<AdminHistoryCategory, {label: string; href: string}>> = {
    settings: { label: "Open agent behavior", href: "/admin/capabilities" },
    policies: { label: "Open policies", href: "/admin/policy" },
    models: { label: "Open models", href: "/admin/models" },
    connections: { label: "Open connections", href: "/admin/connections" },
    skills: { label: "Open skills", href: "/admin/skills" },
    budgets: { label: "Open usage", href: "/admin/token-usage" },
    people: { label: "Open people", href: "/admin/users" },
    runtime: { label: "Open runtime diagnostics", href: "/admin/runtime" }
  };
  return {
    eventId: String(row.id), type: row.event_type, category: def.category, title: def.title, createdAt: row.created_at,
    actor: { userId: row.user_id, name: row.user_id ? redactSecrets(row.display_name?.trim() || "Member, name unavailable").slice(0, 200) : "Actor no longer available" },
    details: def.fields.flatMap((key) => {
      const value = detailValue(key, payload[key]);
      return value === null ? [] : [{ label: LABELS[key] ?? key, value }];
    }),
    target: targets[def.category] ?? null,
    settingsVersion: row.event_type === SETTINGS_EVENT ? settingsVersion(payload) : null
  };
}
