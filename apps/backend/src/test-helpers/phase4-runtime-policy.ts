export const phase4RuntimePolicy = {
  id: "tenant-settings:test-tenant",
  label: "Tenant Settings",
  description: null,
  runtimeProvider: "codex" as const,
  webSearchMode: "disabled" as const,
  approvalPolicy: "on-request" as const,
  sandboxMode: "workspace-write" as const,
  networkMode: "restricted" as const,
  allowCommandExecution: false,
  allowUserTokenForwarding: true,
  autoApproveReadOnlyTools: true,
  policyEnforcementMode: "monitor" as const,
  developerInstructions: null,
  approvalReviewer: "user" as const,
  enabledToolIds: [
    "managed-session-context",
    "session_context",
    "list_artifacts",
    "read_text_artifact",
    "write_artifact"
  ],
  enabledMcpServers: ["managed-session-context"],
  version: 1,
  hash: "hash-phase4-tools"
};
