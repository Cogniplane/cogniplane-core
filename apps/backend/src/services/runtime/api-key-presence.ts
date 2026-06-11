import type { AppConfig } from "../../config.js";

/**
 * Provider API-key presence checks shared by every caller of
 * `resolveRuntimeProviderAndModel` (interactive routes and the scheduler).
 * A server-level key satisfies the check for all tenants; otherwise the
 * tenant's own stored key decides.
 */
export function buildApiKeyPresenceCheckers(input: {
  config: Pick<AppConfig, "ANTHROPIC_API_KEY" | "OPENAI_API_KEY">;
  getTenantAnthropicApiKey: (tenantId: string) => Promise<string | null>;
  getTenantOpenaiApiKey: (tenantId: string) => Promise<string | null>;
}) {
  return {
    hasAnthropicApiKey: async (tenantId: string): Promise<boolean> => {
      if (input.config.ANTHROPIC_API_KEY) return true;
      const tenantKey = await input.getTenantAnthropicApiKey(tenantId);
      return Boolean(tenantKey?.trim());
    },
    hasOpenaiApiKey: async (tenantId: string): Promise<boolean> => {
      if (input.config.OPENAI_API_KEY) return true;
      const tenantKey = await input.getTenantOpenaiApiKey(tenantId);
      return Boolean(tenantKey?.trim());
    }
  };
}
