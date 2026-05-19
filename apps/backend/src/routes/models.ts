import type { FastifyInstance } from "fastify";

import { ModelsListResponseSchema } from "@cogniplane/shared-types";

import type { AppDependencies } from "../app-dependencies.js";
import { AVAILABLE_MODELS, type AvailableModel } from "../domain/models.js";
import { serialize } from "../lib/serialize-response.js";
import type { RuntimeReasoningEffort } from "../runtime-contracts.js";
import type { RuntimeProvider } from "../services/admin-config-records.js";
import type { AnthropicCapabilitiesCache } from "./models-anthropic-cache.js";

export function buildModelRouteStores(
  deps: AppDependencies,
  extras: {
    hasAnthropicApiKey: (tenantId: string) => Promise<boolean>;
    hasOpenaiApiKey: (tenantId: string) => Promise<boolean>;
    getAnthropicApiKey: (tenantId: string) => Promise<string | null>;
    anthropicCapabilitiesCache?: AnthropicCapabilitiesCache;
  }
) {
  return {
    dynamicConfig: deps.dynamicConfig,
    runtimeAdapters: deps.runtimeAdapters,
    hasAnthropicApiKey: extras.hasAnthropicApiKey,
    hasOpenaiApiKey: extras.hasOpenaiApiKey,
    getAnthropicApiKey: extras.getAnthropicApiKey,
    anthropicCapabilitiesCache: extras.anthropicCapabilitiesCache
  };
}

export type ModelRouteStores = ReturnType<typeof buildModelRouteStores>;

const ANTHROPIC_MODELS_API_URL = "https://api.anthropic.com/v1/models?limit=1000";
const ANTHROPIC_EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly RuntimeReasoningEffort[];

async function listAnthropicEffortCapabilities(apiKey: string, timeoutMs: number): Promise<Map<string, {
  supportedEfforts: RuntimeReasoningEffort[];
  defaultEffort: RuntimeReasoningEffort | null;
}> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(ANTHROPIC_MODELS_API_URL, {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      signal: controller.signal
    });
    if (!response.ok) {
      return null;
    }

    const body = await response.json() as {
      data?: Array<{
        id?: string;
        capabilities?: {
          effort?: {
            supported?: boolean;
            low?: { supported?: boolean };
            medium?: { supported?: boolean };
            high?: { supported?: boolean };
            xhigh?: { supported?: boolean };
            max?: { supported?: boolean };
          } | null;
        } | null;
      }>;
    };

    const capabilities = new Map<string, {
      supportedEfforts: RuntimeReasoningEffort[];
      defaultEffort: RuntimeReasoningEffort | null;
    }>();
    for (const model of body.data ?? []) {
      if (!model.id) {
        continue;
      }
      const effortCapability = model.capabilities?.effort;
      if (!effortCapability?.supported) {
        capabilities.set(model.id, { supportedEfforts: [], defaultEffort: null });
        continue;
      }

      const supportedEfforts = ANTHROPIC_EFFORT_ORDER.filter((effort) => effortCapability[effort]?.supported === true);
      capabilities.set(model.id, {
        supportedEfforts,
        defaultEffort: supportedEfforts.includes("high")
          ? "high"
          : (supportedEfforts[0] ?? null)
      });
    }
    return capabilities;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function enrichClaudeModelsFromAnthropic(
  tenantId: string,
  models: AvailableModel[],
  stores: ModelRouteStores,
  timeoutMs: number
): Promise<AvailableModel[]> {
  if (!models.some((model) => model.provider === "claude-code")) {
    return models;
  }

  const apiKey = (await stores.getAnthropicApiKey?.(tenantId))?.trim();
  if (!apiKey) {
    return models;
  }

  const effortCapabilities = stores.anthropicCapabilitiesCache
    ? await stores.anthropicCapabilitiesCache.getOrLoad(tenantId, () =>
        listAnthropicEffortCapabilities(apiKey, timeoutMs)
      )
    : await listAnthropicEffortCapabilities(apiKey, timeoutMs);
  if (!effortCapabilities) {
    return models;
  }

  return models.map((model) => {
    if (model.provider !== "claude-code") {
      return model;
    }
    const capabilities = effortCapabilities.get(model.id);
    if (!capabilities) {
      return model;
    }
    return {
      ...model,
      supportedEfforts: capabilities.supportedEfforts,
      defaultEffort: capabilities.defaultEffort
    };
  });
}

export async function resolveAvailableRuntimeProviders(
  stores: ModelRouteStores,
  tenantId: string
): Promise<{
  enabledRuntimeProviders: RuntimeProvider[];
  defaultRuntimeProvider: RuntimeProvider;
  showEffortSelector: boolean;
}> {
  const settings = await stores.dynamicConfig.getOrCreateTenantSettings(tenantId);

  const enabledRuntimeProviders: RuntimeProvider[] = [];
  for (const provider of settings.enabledRuntimeProviders) {
    if (provider === "codex") {
      if (!stores.hasOpenaiApiKey || await stores.hasOpenaiApiKey(tenantId)) {
        enabledRuntimeProviders.push(provider);
      }
      continue;
    }
    if (!stores.runtimeAdapters?.[provider]) {
      continue;
    }
    if (!stores.hasAnthropicApiKey || await stores.hasAnthropicApiKey(tenantId)) {
      enabledRuntimeProviders.push(provider);
    }
  }

  // When no provider has a usable key, return an empty provider list so the
  // frontend can render a "configure a model provider key" empty state. The
  // schema still requires a non-null `defaultRuntimeProvider`, so we keep
  // `settings.runtimeProvider` as a structural placeholder — it never gets
  // selected because the picker filters by `enabledRuntimeProviders`.
  const defaultRuntimeProvider = enabledRuntimeProviders.includes(settings.runtimeProvider)
    ? settings.runtimeProvider
    : (enabledRuntimeProviders[0] ?? settings.runtimeProvider);

  return {
    enabledRuntimeProviders,
    defaultRuntimeProvider,
    showEffortSelector: settings.showEffortSelector
  };
}

export async function registerModelRoutes(app: FastifyInstance, stores: ModelRouteStores): Promise<void> {
  app.get("/models", async (request) => {
    try {
      const { enabledRuntimeProviders, defaultRuntimeProvider, showEffortSelector } = await resolveAvailableRuntimeProviders(
        stores,
        request.auth.tenantId
      );
      const configuredModels = AVAILABLE_MODELS
        .filter((model) => enabledRuntimeProviders.includes(model.provider))
        .sort((left, right) => {
          if (left.provider === right.provider) return 0;
          if (left.provider === defaultRuntimeProvider) return -1;
          if (right.provider === defaultRuntimeProvider) return 1;
          return 0;
        });
      const models = await enrichClaudeModelsFromAnthropic(
        request.auth.tenantId,
        configuredModels,
        stores,
        app.config.MODEL_LIST_FETCH_TIMEOUT_MS
      );
      return serialize(ModelsListResponseSchema, {
        models,
        enabledRuntimeProviders,
        defaultRuntimeProvider,
        showEffortSelector
      });
    } catch {
      // When the tenant lookup fails we cannot trust per-tenant settings, so
      // we fall back to whatever providers have a usable key. Mirror the
      // main path's symmetry: probe both Codex and Claude. An empty provider
      // list lets the frontend surface the "configure a model provider key"
      // empty state.
      const tenantId = request.auth.tenantId;
      const fallbackProviders: RuntimeProvider[] = [];
      if (!stores.hasOpenaiApiKey || await stores.hasOpenaiApiKey(tenantId)) {
        fallbackProviders.push("codex");
      }
      if (
        stores.runtimeAdapters?.["claude-code"] &&
        (!stores.hasAnthropicApiKey || await stores.hasAnthropicApiKey(tenantId))
      ) {
        fallbackProviders.push("claude-code");
      }
      const defaultProvider: RuntimeProvider = fallbackProviders[0] ?? "codex";
      return serialize(ModelsListResponseSchema, {
        models: AVAILABLE_MODELS.filter((model) => fallbackProviders.includes(model.provider)),
        enabledRuntimeProviders: fallbackProviders,
        defaultRuntimeProvider: defaultProvider,
        showEffortSelector: false
      });
    }
  });
}
