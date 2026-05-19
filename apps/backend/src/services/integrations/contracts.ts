// Structural contracts integration services depend on.
//
// Integration connection services (`github-`/`microsoft-`/`notion-connection-service.ts`)
// must invalidate live runtimes when a user (re)connects or disconnects a provider.
// Importing `CodexRuntimeManager` directly creates a cycle through `runtime-workspace`
// and the managed-tool catalog. This narrowed interface captures only the structural
// shape integrations need; the real `CodexRuntimeManager` already implements it.

export interface RuntimeInvalidator {
  // Restart any running session whose runtime needs to refresh credentials
  // for the given integration. The `integrationId` is the same id the
  // integration is registered under (e.g. "github", "microsoft", "notion")
  // and shows up in audit log reasons / messages.
  invalidateRuntimesForIntegration(
    tenantId: string,
    userId: string,
    integrationId: string
  ): Promise<string[]>;
}
