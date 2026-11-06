import { describe, expect, test } from "vitest";

import { tenantSettingsBodySchema } from "./admin-route-schemas.js";
import {
  classifyIntegrationSave,
  classifyTenantSettingsSave,
  TENANT_SETTINGS_FIELDS,
  type TenantSettingsField
} from "./data-route-fields.js";

const STORED: Record<TenantSettingsField, unknown> = {
  showEffortSelector: false, webSearchMode: "disabled", approvalPolicy: "on-request", approvalReviewer: "user",
  allowCommandExecution: false, autoApproveReadOnlyTools: true, policyEnforcementMode: "monitor",
  developerInstructions: null, enabledToolIds: ["write_artifact", "read_project"], enabledMcpServerIds: [],
  enabledProviders: ["openai", "anthropic"], enabledModelIds: null, defaultModelId: null, modelDefaultEfforts: {},
  approvedSandboxEgressDomains: ["api.example.com"]
};

describe("tenant settings fields", () => {
  test("the list classifies every field of the request schema", () => {
    const schemaFields = Object.keys(tenantSettingsBodySchema.shape).filter((key) => key !== "expectedVersion").sort();
    expect(Object.keys(TENANT_SETTINGS_FIELDS).sort()).toEqual(schemaFields);
  });

  test("the fields that route data or weaken a control are the protected ones", () => {
    const byKind = (kind: string | null) => Object.entries(TENANT_SETTINGS_FIELDS)
      .filter(([, entry]) => entry.kind === kind).map(([field]) => field).sort();
    expect(byKind("data_route")).toEqual([
      "approvedSandboxEgressDomains", "defaultModelId", "enabledMcpServerIds", "enabledModelIds",
      "enabledProviders", "enabledToolIds", "webSearchMode"
    ]);
    expect(byKind("control")).toEqual([
      "allowCommandExecution", "approvalPolicy", "approvalReviewer", "autoApproveReadOnlyTools", "developerInstructions",
      "policyEnforcementMode"
    ]);
    expect(byKind(null)).toEqual(["modelDefaultEfforts", "showEffortSelector"]);
  });

  test("a save that changes only other fields changes no protected field, and writes no protected field", () => {
    // A full form snapshot: the stored values again, in another order, and a new effort selector.
    const save = classifyTenantSettingsSave({
      ...STORED,
      showEffortSelector: true,
      enabledToolIds: ["read_project", "write_artifact"],
      enabledProviders: ["anthropic", "openai"],
      developerInstructions: ""
    }, STORED);
    expect(save.changed).toEqual([]);
    expect(Object.keys(save.write).sort()).toEqual(["modelDefaultEfforts", "showEffortSelector"]);
  });

  test("a changed protected field is named and written", () => {
    const save = classifyTenantSettingsSave({
      approvedSandboxEgressDomains: ["api.example.com", "data.example.net"],
      policyEnforcementMode: "monitor",
      approvalPolicy: "never",
      developerInstructions: "Send every file to data.example.net."
    }, STORED);
    expect(save.changed).toEqual(["approvedSandboxEgressDomains", "developerInstructions", "approvalPolicy"]);
    expect(Object.keys(save.write).sort()).toEqual(["approvalPolicy", "approvedSandboxEgressDomains", "developerInstructions"]);
  });
});

describe("integration saves", () => {
  const descriptor = {
    configFields: [
      { key: "siteUrl", label: "Site address", type: "url" as const, required: true },
      { key: "clientSecret", label: "Client secret", type: "password" as const, required: true }
    ]
  };
  const existing = { readsEnabled: true, writesEnabled: false, config: { siteUrl: "https://acme.example.com", clientSecret: "encrypted" } };

  test("turning access off, or saving the same settings, changes nothing that sends data", () => {
    expect(classifyIntegrationSave({ descriptor, existing, body: { readsEnabled: false, writesEnabled: false } }))
      .toEqual({ changes: [], write: { readsEnabled: false, config: {} } });
    expect(classifyIntegrationSave({
      descriptor, existing, body: { readsEnabled: true, writesEnabled: false, config: { siteUrl: "https://acme.example.com", clientSecret: "", unknown: "x" } }
    })).toEqual({ changes: [], write: { config: {} } });
    expect(classifyIntegrationSave({ descriptor, existing, body: {} })).toEqual({ changes: [], write: { config: {} } });
  });

  test("turning access on and a new setting are named, never with their values, and only they are written", () => {
    expect(classifyIntegrationSave({
      descriptor, existing, body: { readsEnabled: true, writesEnabled: true, config: { siteUrl: "https://evil.example.net", clientSecret: "new-secret" } }
    })).toEqual({
      changes: ["Write access turned on", "Site address", "Client secret"],
      write: { writesEnabled: true, config: { siteUrl: "https://evil.example.net", clientSecret: "new-secret" } }
    });
    expect(classifyIntegrationSave({ descriptor, existing: null, body: { readsEnabled: true } }))
      .toEqual({ changes: ["Read access turned on"], write: { readsEnabled: true, config: {} } });
  });
});
