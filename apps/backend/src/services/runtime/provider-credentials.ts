import type { ModelProvider } from "@cogniplane/shared-types";
import { MODEL_PROVIDERS, MODEL_PROVIDER_META } from "@cogniplane/shared-types";

import type { AppConfig } from "../../config.js";

/**
 * Resolves LLM-provider credentials for the Deep Agents runtime.
 *
 * Resolution is DEFERRED to model-selection time (not session creation): a
 * session's provider is only known once the turn's model is chosen, so the
 * adapter is handed a resolver rather than a single pre-resolved key. For each
 * provider the tenant's stored key wins; a platform-level env key
 * (MODEL_PROVIDER_META.envKey) is the fallback that satisfies every tenant.
 */
export type ProviderCredentials = {
  /** Whether any tenant/platform key exists for `provider`. */
  hasKey(tenantId: string, provider: ModelProvider): Promise<boolean>;
  /** The resolved key for `provider`, or null when none is configured. */
  resolveKey(tenantId: string, provider: ModelProvider): Promise<string | null>;
  /** Set of providers with a platform-level env key (tenant-independent). */
  readonly platformProviders: ReadonlySet<ModelProvider>;
};

export function buildProviderCredentials(input: {
  config: Pick<
    AppConfig,
    "ANTHROPIC_API_KEY" | "OPENAI_API_KEY" | "GOOGLE_API_KEY" | "OPENROUTER_API_KEY" | "ZAI_API_KEY"
  >;
  /** Decrypted tenant key lookup (privileged — runs outside request scope). */
  getTenantProviderKey: (tenantId: string, provider: ModelProvider) => Promise<string | null>;
}): ProviderCredentials {
  const platformKey = (provider: ModelProvider): string | undefined => {
    const value = input.config[MODEL_PROVIDER_META[provider].envKey];
    return value?.trim() ? value.trim() : undefined;
  };

  const platformProviders = new Set<ModelProvider>(
    MODEL_PROVIDERS.filter((provider) => platformKey(provider) !== undefined)
  );

  const resolveKey = async (
    tenantId: string,
    provider: ModelProvider
  ): Promise<string | null> => {
    const tenantKey = (await input.getTenantProviderKey(tenantId, provider))?.trim();
    if (tenantKey) return tenantKey;
    return platformKey(provider) ?? null;
  };

  return {
    resolveKey,
    async hasKey(tenantId, provider) {
      if (platformProviders.has(provider)) return true;
      return Boolean(await resolveKey(tenantId, provider));
    },
    platformProviders
  };
}
