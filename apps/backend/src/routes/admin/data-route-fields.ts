import type { z } from "zod";

import type { IntegrationDescriptor } from "../../services/integrations/integration-registry.js";
import type { tenantSettingsBodySchema } from "./admin-route-schemas.js";

// Which changes of a data route need step-up and an owner notice
// (docs/ARCHITECTURE.md, "Authentication", "Data routes"). A save that
// changes none of them needs neither: a small change (the effort selector,
// an integration turned off) must not ask for a password or send email.

type TenantSettingsBody = z.infer<typeof tenantSettingsBodySchema>;
export type TenantSettingsField = Exclude<keyof TenantSettingsBody, "expectedVersion">;

/**
 * Why a field matters:
 * - `data_route`: the field decides where the tenant's data goes (a model
 *   provider, a network host, an MCP server, a tool, web search).
 * - `control`: the field can make a control weaker for every user (approval,
 *   Policy Center enforcement, command execution, the agent's instructions).
 * - `null`: neither. A change needs no step-up and sends no notice.
 * Every field of the request schema is in this list; the type makes a new
 * field fail to compile until it is classified.
 */
export const TENANT_SETTINGS_FIELDS: Record<TenantSettingsField, { label: string; kind: "data_route" | "control" | null }> = {
  enabledProviders: { label: "Enabled model providers", kind: "data_route" },
  enabledModelIds: { label: "Enabled models", kind: "data_route" },
  defaultModelId: { label: "Default model", kind: "data_route" },
  webSearchMode: { label: "Web search", kind: "data_route" },
  approvedSandboxEgressDomains: { label: "Sandbox network hosts", kind: "data_route" },
  enabledMcpServerIds: { label: "Enabled MCP servers", kind: "data_route" },
  enabledToolIds: { label: "Enabled tools", kind: "data_route" },
  developerInstructions: { label: "Agent instructions", kind: "control" },
  policyEnforcementMode: { label: "Policy enforcement mode", kind: "control" },
  approvalPolicy: { label: "Approval policy", kind: "control" },
  allowCommandExecution: { label: "Command execution", kind: "control" },
  autoApproveReadOnlyTools: { label: "Automatic approval of read-only tools", kind: "control" },
  // No runtime reads it today (docs/ARCHITECTURE.md, "Policy Center"), but it
  // names who approves: a control when a runtime reads it again.
  approvalReviewer: { label: "Approval reviewer", kind: "control" },
  showEffortSelector: { label: "Effort selector", kind: null },
  modelDefaultEfforts: { label: "Default model efforts", kind: null }
};

const PROTECTED_FIELDS = (Object.keys(TENANT_SETTINGS_FIELDS) as TenantSettingsField[])
  .filter((field) => TENANT_SETTINGS_FIELDS[field].kind !== null);

/** One form for a comparison: lists as sets, object keys sorted, an empty string as no value. */
function canonical(value: unknown): string {
  const normal = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map((entry) => JSON.stringify(normal(entry))).sort();
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, normal((item as Record<string, unknown>)[key])]));
    }
    return item === "" || item === undefined ? null : item;
  };
  return JSON.stringify(normal(value));
}

/**
 * Compares a tenant settings save with the stored settings. `changed`: the
 * protected fields whose new value differs, in list order. `write`: the save
 * without the protected fields that do not change, so a save with no step-up
 * never writes a protected field (also when another save changes it
 * meanwhile).
 */
export function classifyTenantSettingsSave<T extends Partial<Record<TenantSettingsField, unknown>>>(
  input: T,
  current: Record<TenantSettingsField, unknown>
): { changed: TenantSettingsField[]; write: T } {
  const changed: TenantSettingsField[] = [];
  const write = { ...input };
  for (const field of PROTECTED_FIELDS) {
    if (!Object.hasOwn(input, field) || input[field] === undefined) continue;
    if (canonical(input[field]) === canonical(current[field])) delete write[field];
    else changed.push(field);
  }
  return { changed, write };
}

export function tenantSettingsLabels(fields: readonly TenantSettingsField[]): string[] {
  return fields.map((field) => TENANT_SETTINGS_FIELDS[field].label);
}

/**
 * Compares an integration save with the stored copy. `changes`: what needs
 * step-up and a notice, as labels: reads or writes turned on, and each
 * settings field that the save changes (a password field changes when the
 * save sends a value; an empty one keeps the stored secret). Turning reads or
 * writes off, or saving the same values, changes nothing that sends data.
 * `write`: only the toggles and settings keys that differ from the copy.
 * The store writes them onto the locked row (IntegrationStateStore.
 * applyChanges), so a save without step-up never writes back an older
 * toggle or secret, also when another save changed it after this read.
 */
export function classifyIntegrationSave(input: {
  descriptor: Pick<IntegrationDescriptor, "configFields">;
  existing: { readsEnabled: boolean; writesEnabled: boolean; config: Record<string, unknown> } | null;
  body: { readsEnabled?: boolean; writesEnabled?: boolean; config?: Record<string, string> };
}): { changes: string[]; write: { readsEnabled?: boolean; writesEnabled?: boolean; config: Record<string, string> } } {
  const changes: string[] = [];
  const write: { readsEnabled?: boolean; writesEnabled?: boolean; config: Record<string, string> } = { config: {} };
  for (const [toggle, label] of [["readsEnabled", "Read access turned on"], ["writesEnabled", "Write access turned on"]] as const) {
    const value = input.body[toggle];
    if (value === undefined || value === Boolean(input.existing?.[toggle])) continue;
    write[toggle] = value;
    if (value) changes.push(label);
  }
  for (const [key, value] of Object.entries(input.body.config ?? {})) {
    const field = input.descriptor.configFields?.find((candidate) => candidate.key === key);
    if (!field) continue;
    const changed = field.type === "password" ? value.length > 0 : canonical(value) !== canonical(input.existing?.config[key]);
    if (!changed) continue;
    write.config[key] = value;
    changes.push(field.label);
  }
  return { changes, write };
}
