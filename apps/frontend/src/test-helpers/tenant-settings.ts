import type { TenantSettings } from "@cogniplane/shared-types";

/**
 * A complete TenantSettings record for tests. One definition, so a new required
 * field in the contract breaks compilation here instead of in every suite.
 */
export function makeTenantSettings(overrides: Partial<TenantSettings> = {}): TenantSettings {
  return {
    tenantId: "tenant-1",
    version: 1,
    configHash: "hash-1",
    updatedAt: "2026-09-07T12:00:00Z",
    enabledProviders: ["openai"],
    enabledModelIds: null,
    modelDefaultEfforts: {},
    showEffortSelector: false,
    webSearchMode: "disabled",
    approvalPolicy: "never",
    approvalReviewer: "user",
    allowCommandExecution: false,
    autoApproveReadOnlyTools: true,
    policyEnforcementMode: "monitor",
    developerInstructions: null,
    enabledToolIds: [],
    enabledMcpServerIds: [],
    ...overrides
  };
}
