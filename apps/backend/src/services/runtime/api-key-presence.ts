import type { ModelProvider } from "@cogniplane/shared-types";
import { MODEL_PROVIDERS } from "@cogniplane/shared-types";

import type { ProviderCredentials } from "./provider-credentials.js";

/**
 * Provider-presence checkers shared by every caller of `resolveRuntimeModel`
 * (interactive routes, `/models`, and the scheduler). A server-level key
 * satisfies the check for all tenants; otherwise the tenant's own stored key
 * decides. See {@link ProviderCredentials}.
 */
export type ApiKeyPresenceCheckers = {
  /** True when a key exists for the given provider (tenant or platform). */
  hasProviderKey: (tenantId: string, provider: ModelProvider) => Promise<boolean>;
  /**
   * The set of providers this tenant can currently use. `/models` filters the
   * catalog by this; an empty set is the "configure a provider key" state.
   */
  configuredProviders: (tenantId: string) => Promise<Set<ModelProvider>>;
};

export function buildApiKeyPresenceCheckers(input: {
  credentials: ProviderCredentials;
}): ApiKeyPresenceCheckers {
  const { credentials } = input;
  const hasProviderKey = (tenantId: string, provider: ModelProvider): Promise<boolean> =>
    credentials.hasKey(tenantId, provider);

  return {
    hasProviderKey,
    async configuredProviders(tenantId: string): Promise<Set<ModelProvider>> {
      const configured = new Set<ModelProvider>();
      await Promise.all(
        MODEL_PROVIDERS.map(async (provider) => {
          if (await credentials.hasKey(tenantId, provider)) configured.add(provider);
        })
      );
      return configured;
    }
  };
}
