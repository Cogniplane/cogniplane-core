import { apiError, requestError } from "../../lib/http-errors.js";
import type { ApiError } from "../../lib/http-errors.js";
import { AVAILABLE_MODELS } from "../../domain/models.js";
import type { RuntimeAdapter, RuntimeReasoningEffort } from "../../runtime-contracts.js";
import type { RuntimeProvider } from "../admin-config-records.js";
import type { DynamicConfigService } from "../dynamic-config-service.js";

export type ResolverModel = (typeof AVAILABLE_MODELS)[number];

export type RuntimeResolutionInput = {
  tenantId: string;
  requestedModel: string | undefined;
  requestedEffort: string | undefined;
  defaultAdapter: RuntimeAdapter;
  stores: {
    dynamicConfig?: DynamicConfigService;
    runtimeAdapters?: Partial<Record<RuntimeProvider, RuntimeAdapter>>;
    hasAnthropicApiKey: (tenantId: string) => Promise<boolean>;
    hasOpenaiApiKey: (tenantId: string) => Promise<boolean>;
  };
};

export type RuntimeResolutionResult =
  | {
      kind: "ok";
      runtimeAdapter: RuntimeAdapter;
      provider: RuntimeProvider;
      selectedModel: ResolverModel | null;
    }
  | { kind: "error"; statusCode: number; body: ApiError };

// Resolves the runtime adapter, active provider, and selected model for a
// turn. Enforces tenant-level runtime-provider enablement, Claude adapter
// availability, Anthropic/OpenAI key presence (each gates its own provider),
// model/provider match, and effort capability — returning a discriminated
// result so the caller just maps to HTTP response codes.
export async function resolveRuntimeProviderAndModel(
  input: RuntimeResolutionInput
): Promise<RuntimeResolutionResult> {
  let runtimeAdapter = input.defaultAdapter;
  let provider: RuntimeProvider = "codex";

  const { stores, tenantId, requestedModel } = input;

  if (stores.dynamicConfig && stores.runtimeAdapters) {
    try {
      const settings = await stores.dynamicConfig.getOrCreateTenantSettings(tenantId);
      const enabledRuntimeProviders = settings.enabledRuntimeProviders;
      const requestedProvider = requestedModel
        ? (AVAILABLE_MODELS.find((m) => m.id === requestedModel)?.provider ?? settings.runtimeProvider)
        : settings.runtimeProvider;

      if (!enabledRuntimeProviders.includes(requestedProvider)) {
        return {
          kind: "error",
          statusCode: 400,
          body: requestError([
            {
              path: "model",
              message:
                requestedProvider === "claude-code"
                  ? "Claude models are not enabled for this tenant."
                  : "Codex models are not enabled for this tenant."
            }
          ])
        };
      }

      provider = requestedProvider;
      if (provider === "claude-code") {
        const candidate = stores.runtimeAdapters[provider];
        if (!candidate) {
          return {
            kind: "error",
            statusCode: 503,
            body: apiError(
              "runtime_provider_unavailable",
              "The Claude Code runtime adapter is not available on this server."
            )
          };
        }
        if (!(await stores.hasAnthropicApiKey(tenantId))) {
          return {
            kind: "error",
            statusCode: 400,
            body: apiError(
              "anthropic_api_key_required",
              "Claude models are enabled for this tenant but no Anthropic API key is available. Configure ANTHROPIC_API_KEY at the server level or save an anthropicApiKey in the organization settings."
            )
          };
        }
        runtimeAdapter = candidate;
      } else if (provider === "codex") {
        if (!(await stores.hasOpenaiApiKey(tenantId))) {
          return {
            kind: "error",
            statusCode: 400,
            body: apiError(
              "codex_api_key_required",
              "Codex models are enabled for this tenant but no OpenAI API key is available. Configure OPENAI_API_KEY at the server level or save an openaiApiKey in the organization settings."
            )
          };
        }
      }
    } catch {
      return {
        kind: "error",
        statusCode: 503,
        body: apiError(
          "runtime_provider_unavailable",
          "Could not resolve the runtime provider for this tenant. Try again."
        )
      };
    }
  }

  const selectedModel: ResolverModel | null = requestedModel
    ? (AVAILABLE_MODELS.find((m) => m.id === requestedModel) ?? null)
    : (AVAILABLE_MODELS.find((m) => m.provider === provider && m.isDefault) ??
        AVAILABLE_MODELS.find((m) => m.provider === provider) ??
        null);

  if (requestedModel && selectedModel && selectedModel.provider !== provider) {
    return {
      kind: "error",
      statusCode: 400,
      body: requestError([
        {
          path: "model",
          message: `Model "${requestedModel}" is not available for the "${provider}" runtime provider.`
        }
      ])
    };
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

  return { kind: "ok", runtimeAdapter, provider, selectedModel };
}
