import {
  APPROVAL_REVIEWERS,
  EFFORT_LEVELS,
  POLICY_ENFORCEMENT_MODES,
  WEB_SEARCH_MODES,
  type AdminSettingsComparison
} from "@cogniplane/shared-types";
import type { TenantSettingsField } from "@cogniplane/shared-types/tenant-settings-request";
import { projectHistoryEvent, record, safeIdentifier, type HistoryRow } from "./admin-history-projection.js";

type Value = { display: string; key: string | null };
type Reader = (value: unknown) => Value;
const absent: Value = { display: "Not recorded", key: null };
const unavailable: Value = { display: "Not available in this record", key: null };
const known = (display: string, value: unknown): Value => ({ display, key: JSON.stringify(value) });
const boolean: Reader = (value) => typeof value === "boolean" ? known(value ? "On" : "Off", value) : unavailable;
const choice = (options: readonly string[]): Reader => (value) => typeof value === "string" && options.includes(value)
  ? known(value.replaceAll("_", " "), value) : unavailable;
const identifier: Reader = (value) => {
  const id = safeIdentifier(value);
  return id === null ? unavailable : known(id, id);
};
const list: Reader = (value) => {
  if (!Array.isArray(value) || value.length > 500 || value.some((item) => safeIdentifier(item) === null)) return unavailable;
  const ids = [...new Set(value as string[])].sort();
  return known(ids.length ? ids.join(", ") : "None", ids);
};
// Approved sandbox hosts. `safeIdentifier` rejects the `*` of a wildcard, so
// this reader uses a plain host pattern. The history page does not need the
// public suffix list that the admin API uses.
const sandboxHosts: Reader = (value) => {
  if (!Array.isArray(value) || value.length > 500) return unavailable;
  const hosts: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !/^(\*\.)?[a-z0-9]([a-z0-9.-]{0,126}[a-z0-9])?$/.test(item)) return unavailable;
    hosts.push(item);
  }
  const sorted = [...new Set(hosts)].sort();
  return known(sorted.length ? sorted.join(", ") : "None. The sandbox has no network.", sorted);
};
const nullable = (reader: Reader, label: string): Reader => (value) => value === null ? known(label, null) : reader(value);
const instructions: Reader = (value) => {
  if (value === null || value === "") return known("Not set", value);
  if (typeof value !== "string") return unavailable;
  // Stored redaction can make different originals look equal. Do not claim
  // either a change or equality when the original text is unavailable.
  if (/\[REDACTED\]|\bREDACTED\b/i.test(value)) return { display: "Content was redacted; cannot compare", key: null };
  return known("Set, content hidden", value);
};
const approval: Reader = (value) => {
  if (value === "never" || value === "on-request") return known(value === "never" ? "Never ask" : "Ask when requested", value);
  const granular = record(record(value).granular);
  const fields = { sandbox_approval: "Sandbox", mcp_elicitations: "Connection prompts", rules: "Rules", request_permissions: "Permissions", skill_approval: "Skills" };
  if (["sandbox_approval", "mcp_elicitations", "rules"].some((key) => typeof granular[key] !== "boolean")) return unavailable;
  const entries = Object.entries(fields).map(([key, label]) => [key, label, granular[key]] as const);
  if (entries.some(([, , v]) => v !== undefined && typeof v !== "boolean")) return unavailable;
  return known(entries.map(([, label, v]) => `${label}: ${v === undefined ? "not recorded" : v ? "ask" : "do not ask"}`).join("; "),
    entries.map(([key, , v]) => [key, v ?? null]));
};
const efforts: Reader = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return unavailable;
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length > 500 || entries.some(([id, effort]) => !safeIdentifier(id) || typeof effort !== "string" || !(EFFORT_LEVELS as readonly string[]).includes(effort))) return unavailable;
  return known(entries.length ? entries.map(([id, effort]) => `${id}: ${effort}`).join("; ") : "Catalog defaults", entries);
};
// Keep old rows partial. Reading them through today's TenantSettingsSchema
// would either reject them or invite default values that were never recorded.
// The record type makes a new setting fail to compile until it has a label and
// a reader. The key order is the order of the comparison rows.
const FIELDS: Record<TenantSettingsField, { label: string; read: Reader }> = {
  approvalPolicy: { label: "Approval policy", read: approval },
  approvalReviewer: { label: "Approval reviewer", read: choice(APPROVAL_REVIEWERS) },
  allowCommandExecution: { label: "Command execution", read: boolean },
  autoApproveReadOnlyTools: { label: "Automatic approval for read-only tools", read: boolean },
  policyEnforcementMode: { label: "Policy enforcement", read: choice(POLICY_ENFORCEMENT_MODES) },
  webSearchMode: { label: "Web search", read: choice(WEB_SEARCH_MODES) },
  developerInstructions: { label: "Organization instructions", read: instructions },
  enabledToolIds: { label: "Enabled tools", read: list },
  approvedSandboxEgressDomains: { label: "Approved sandbox hosts", read: sandboxHosts },
  enabledMcpServerIds: { label: "Enabled connections", read: list },
  enabledProviders: { label: "Enabled providers", read: list },
  enabledModelIds: { label: "Enabled models", read: nullable(list, "All catalog models") },
  defaultModelId: { label: "Default model", read: nullable(identifier, "No organization default") },
  modelDefaultEfforts: { label: "Model reasoning defaults", read: efforts },
  showEffortSelector: { label: "Reasoning selector", read: boolean }
};

/** The compared settings, in row order. Exported for the field-set test. */
export const COMPARED_SETTINGS = Object.keys(FIELDS) as TenantSettingsField[];

export function compareSettings(older: HistoryRow, newer: HistoryRow): AdminSettingsComparison {
  const before = record(older.payload), after = record(newer.payload);
  const changes: AdminSettingsComparison["changes"] = [];
  let unchangedCount = 0;
  for (const field of COMPARED_SETTINGS) {
    const { label, read } = FIELDS[field];
    const left = Object.hasOwn(before, field) ? read(before[field]) : absent;
    const right = Object.hasOwn(after, field) ? read(after[field]) : absent;
    if (left.key !== null && right.key !== null && left.key === right.key) { unchangedCount++; continue; }
    changes.push({ field, label, before: left.display, after: right.display,
      status: left.key === null || right.key === null ? "unavailable" : "changed" });
  }
  const ref = (row: HistoryRow) => {
    const event = projectHistoryEvent(row);
    return { eventId: event.eventId, version: event.settingsVersion, createdAt: event.createdAt, actorName: event.actor.name };
  };
  return { before: ref(older), after: ref(newer), changes, unchangedCount };
}
