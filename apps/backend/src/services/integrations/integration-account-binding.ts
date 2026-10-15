import { ToolCallError } from "../../lib/tool-call-error.js";

/**
 * The upstream account a turn recorded for an integration, read from the tool
 * execution context metadata.
 *
 * - `undefined`: the context has no record (it predates the binding), so
 *   nothing is compared.
 * - `null`: the turn recorded accounts, but none for this integration. A call
 *   must not use whatever account is connected now.
 * - a string: the call must use this account.
 */
export function boundIntegrationAccount(
  metadata: Readonly<Record<string, unknown>> | undefined,
  integrationId: string
): string | null | undefined {
  const accounts = metadata?.integrationAccounts;
  if (accounts === null || typeof accounts !== "object" || Array.isArray(accounts)) return undefined;
  const accountId = (accounts as Record<string, unknown>)[integrationId];
  return typeof accountId === "string" ? accountId : null;
}

export function integrationAccountChangedMessage(integrationName: string): string {
  return `Your ${integrationName} account changed during this turn. Send a new message to use the connected account.`;
}

/**
 * Refuses a credential that belongs to another account than the turn recorded.
 * Credential lookups call this with the same connection row that holds the
 * token, so a reconnect between a check and the lookup cannot switch accounts.
 */
export function assertBoundIntegrationAccount(
  integrationName: string,
  expected: string | null | undefined,
  actual: string
): void {
  if (expected !== undefined && expected !== actual) {
    throw new ToolCallError(integrationAccountChangedMessage(integrationName));
  }
}
