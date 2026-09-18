import type { ModelProvider } from "@cogniplane/shared-types";
import { isModelEnabled, MODEL_PROVIDER_META } from "@cogniplane/shared-types";

import { apiError, requestError } from "../../lib/http-errors.js";
import type { ApiError } from "../../lib/http-errors.js";
import { AVAILABLE_MODELS } from "../../domain/models.js";
import {
  effectiveDefaultEffort,
  listEnabledModels
} from "../../domain/model-availability.js";
import type { ModelAvailabilitySettings } from "../../domain/model-availability.js";
import type { RuntimeAdapter, RuntimeReasoningEffort } from "../../runtime-contracts.js";

export type ResolverModel = (typeof AVAILABLE_MODELS)[number];

export type RuntimeResolutionInput = {
  tenantId: string;
  requestedModel: string | undefined;
  requestedEffort: string | undefined;
  runtimeAdapter: RuntimeAdapter;
  stores: {
    /**
     * Presence check for the SELECTED model's provider. Absent means "don't
     * gate on key presence" (some callers wire it later). Gating on the model's
     * own provider — not Anthropic specifically — lets a tenant with only e.g.
     * an OpenAI key use OpenAI models.
     */
    hasProviderKey?: (tenantId: string, provider: ModelProvider) => Promise<boolean>;
    /**
     * Tenant model-availability settings (enabled providers/models + default
     * efforts). Absent means "everything enabled, catalog defaults" — some
     * callers (tests, minimal wirings) don't gate on tenant config.
     */
    getModelAvailability?: (tenantId: string) => Promise<ModelAvailabilitySettings>;
    /**
     * The tenant's full model catalog: built-ins merged with admin-added
     * custom models. Absent means the static AVAILABLE_MODELS only.
     */
    listModels?: (tenantId: string) => Promise<readonly ResolverModel[]>;
  };
};

export type RuntimeResolutionResult =
  | {
      kind: "ok";
      runtimeAdapter: RuntimeAdapter;
      selectedModel: ResolverModel | null;
      /**
       * The effort the turn should run with: the validated requested effort,
       * else the tenant's per-model default-effort override, else undefined
       * (the adapter then falls back to the catalog default). Callers should
       * pass this to the adapter instead of the raw requested effort.
       */
      selectedEffort: RuntimeReasoningEffort | undefined;
    }
  | { kind: "error"; statusCode: number; body: ApiError };

function runtimeUnavailableError(): RuntimeResolutionResult {
  return {
    kind: "error",
    statusCode: 503,
    body: apiError(
      "runtime_provider_unavailable",
      "Could not resolve the runtime configuration for this tenant. Try again."
    )
  };
}

/**
 * Chooses the default model for the no-explicit-model path, preferring one
 * whose provider the tenant has a key for. Preference order:
 *   1. the catalog default (isDefault) if its provider is configured,
 *   2. otherwise the first catalog model with a configured provider,
 *   3. otherwise the catalog default unchanged — so the caller's provider gate
 *      emits the honest "no key" error for that provider.
 * Providers are probed at most once each (memoized) to bound hasProviderKey
 * calls regardless of catalog size.
 */
async function pickDefaultForConfiguredProvider(
  tenantId: string,
  hasProviderKey: (tenantId: string, provider: ModelProvider) => Promise<boolean>,
  enabledCatalog: readonly ResolverModel[],
  catalogDefault: ResolverModel | null
): Promise<ResolverModel | null> {
  const probed = new Map<ModelProvider, boolean>();
  const isConfigured = async (provider: ModelProvider): Promise<boolean> => {
    const cached = probed.get(provider);
    if (cached !== undefined) return cached;
    const result = await hasProviderKey(tenantId, provider);
    probed.set(provider, result);
    return result;
  };

  if (catalogDefault && (await isConfigured(catalogDefault.provider))) {
    return catalogDefault;
  }
  for (const model of enabledCatalog) {
    if (await isConfigured(model.provider)) return model;
  }
  return catalogDefault;
}

// Resolves the selected model for a turn on the Deep Agents runtime. Validates
// the selected model's provider-key presence (models resolve through
// initChatModel "<provider>:*") and model/effort capability — returning a
// discriminated result so the caller just maps to HTTP response codes.
export async function resolveRuntimeModel(
  input: RuntimeResolutionInput
): Promise<RuntimeResolutionResult> {
  const { stores, tenantId, requestedModel, runtimeAdapter } = input;

  // Tenant catalog (built-ins + admin-added custom models) and availability
  // settings (admin-controlled enablement + default-effort overrides). Absent
  // wiring means "static catalog, everything enabled".
  let availability: ModelAvailabilitySettings | null = null;
  let catalog: readonly ResolverModel[] = AVAILABLE_MODELS;
  try {
    if (stores.listModels) catalog = await stores.listModels(tenantId);
    if (stores.getModelAvailability) {
      availability = await stores.getModelAvailability(tenantId);
    }
  } catch {
    return runtimeUnavailableError();
  }
  const enabledCatalog: readonly ResolverModel[] = availability
    ? listEnabledModels(availability, catalog)
    : catalog;

  // The catalog default (isDefault, else first ENABLED entry). Used as the
  // fallback when no model is requested; restricted to enabled models so a
  // disabled provider/model is never picked implicitly.
  const catalogDefault: ResolverModel | null =
    enabledCatalog.find((m) => m.isDefault) ?? enabledCatalog[0] ?? null;

  if (requestedModel && !catalog.some((m) => m.id === requestedModel)) {
    return {
      kind: "error",
      statusCode: 400,
      body: requestError([
        {
          path: "model",
          message: `Model "${requestedModel}" is not available.`
        }
      ])
    };
  }

  let selectedModel: ResolverModel | null;
  if (requestedModel) {
    // Explicit choice: honor it exactly and gate on its provider below — a
    // tenant asked for this specific model, so a missing key is a real error.
    selectedModel = catalog.find((m) => m.id === requestedModel) ?? null;
    // ...unless the admin disabled the model or its provider for this tenant.
    // Enforced here (not just in /models) so direct API calls and scheduled
    // jobs cannot run a disabled model.
    if (selectedModel && availability && !isModelEnabled(selectedModel, availability)) {
      return {
        kind: "error",
        statusCode: 400,
        body: requestError([
          {
            path: "model",
            message: `Model "${requestedModel}" is not enabled for this organization.`
          }
        ])
      };
    }
  } else if (stores.hasProviderKey) {
    // No model requested (scheduled jobs, API calls without a model): prefer a
    // default whose provider is actually configured, so a tenant with only a
    // non-Anthropic key still runs. Falls back to the catalog default only when
    // NOTHING is configured, letting the gate emit "no key" for that provider.
    try {
      selectedModel = await pickDefaultForConfiguredProvider(
        tenantId,
        stores.hasProviderKey,
        enabledCatalog,
        catalogDefault
      );
    } catch {
      return runtimeUnavailableError();
    }
  } else {
    selectedModel = catalogDefault;
  }

  // Gate on the SELECTED model's provider (known only after resolving the
  // model above), so a tenant with only a non-Anthropic key can still use that
  // provider's models.
  if (selectedModel && stores.hasProviderKey) {
    const provider = selectedModel.provider;
    try {
      if (!(await stores.hasProviderKey(tenantId, provider))) {
        const label = MODEL_PROVIDER_META[provider].label;
        return {
          kind: "error",
          statusCode: 400,
          body: apiError(
            "provider_api_key_required",
            `No ${label} API key is available for this tenant. Configure ${MODEL_PROVIDER_META[provider].envKey} at the server level or save a ${provider} key in the organization settings.`
          )
        };
      }
    } catch {
      return runtimeUnavailableError();
    }
  }

  if (
    input.requestedEffort &&
    selectedModel &&
    !selectedModel.supportedEfforts.includes(input.requestedEffort as RuntimeReasoningEffort)
  ) {
    return {
      kind: "error",
      statusCode: 400,
      body: requestError([
        {
          path: "effort",
          message: `Effort "${input.requestedEffort}" is not supported by model "${selectedModel.id}".`
        }
      ])
    };
  }

  // Effort for the turn: the (validated) explicit request wins; otherwise the
  // tenant's per-model default-effort override. Undefined lets the adapter
  // fall back to the catalog default. Applied here — not only in /models —
  // because clients omit effort entirely when the effort selector is hidden.
  let selectedEffort = input.requestedEffort as RuntimeReasoningEffort | undefined;
  if (!selectedEffort && selectedModel && availability) {
    const effective = effectiveDefaultEffort(selectedModel, availability);
    selectedEffort = effective ?? undefined;
  }

  return { kind: "ok", runtimeAdapter, selectedModel, selectedEffort };
}
