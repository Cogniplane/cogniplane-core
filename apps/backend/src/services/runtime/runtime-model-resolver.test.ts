import { test, expect } from "vitest";

import type { RuntimeAdapter } from "../../runtime-contracts.js";
import { resolveRuntimeModel, type RuntimeResolutionInput } from "./runtime-model-resolver.js";

const stubAdapter = {
  hasActiveTurn: () => false
} as unknown as RuntimeAdapter;

function makeInput(overrides: Partial<RuntimeResolutionInput> = {}): RuntimeResolutionInput {
  return {
    tenantId: "t",
    requestedModel: undefined,
    requestedEffort: undefined,
    runtimeAdapter: stubAdapter,
    stores: {
      hasProviderKey: async () => true
    },
    ...overrides
  };
}

test("resolveRuntimeModel: resolves ok with the adapter and default model", async () => {
  const result = await resolveRuntimeModel(makeInput());
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") return;
  expect(result.runtimeAdapter).toBe(stubAdapter);
  // `deepagents/claude-sonnet-5` is the isDefault=true model
  expect(result.selectedModel?.id).toBe("deepagents/claude-sonnet-5");
});

test("resolveRuntimeModel: key-presence lookup error returns 503 runtime_provider_unavailable", async () => {
  const result = await resolveRuntimeModel(
    makeInput({
      stores: {
        hasProviderKey: async () => {
          throw new Error("postgres connection refused");
        }
      }
    })
  );
  expect(result.kind).toBe("error");
  if (result.kind !== "error") return;
  expect(result.statusCode).toBe(503);
  expect(result.body.error).toBe("runtime_provider_unavailable");
});

test("resolveRuntimeModel: missing key checker skips the key gate (caller wires it later)", async () => {
  const result = await resolveRuntimeModel({
    tenantId: "t",
    requestedModel: undefined,
    requestedEffort: undefined,
    runtimeAdapter: stubAdapter,
    stores: {}
  });
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") return;
  expect(result.selectedModel?.id).toBe("deepagents/claude-sonnet-5");
});

test("resolveRuntimeModel: no key for the selected model's provider returns provider_api_key_required", async () => {
  const result = await resolveRuntimeModel(
    makeInput({
      stores: {
        hasProviderKey: async () => false
      }
    })
  );
  expect(result.kind).toBe("error");
  if (result.kind !== "error") return;
  expect(result.statusCode).toBe(400);
  expect(result.body.error).toBe("provider_api_key_required");
});

test("resolveRuntimeModel: no-model path picks a configured non-Anthropic provider's model", async () => {
  // Codex P2: a tenant with ONLY an OpenAI key running a scheduled job (no
  // explicit model) must not be rejected on the Anthropic default.
  const result = await resolveRuntimeModel(
    makeInput({
      requestedModel: undefined,
      stores: {
        hasProviderKey: async (_tenantId, provider) => provider === "openai"
      }
    })
  );
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") return;
  expect(result.selectedModel?.provider).toBe("openai");
});

test("resolveRuntimeModel: no-model path keeps the Anthropic default when Anthropic is configured", async () => {
  const result = await resolveRuntimeModel(
    makeInput({
      requestedModel: undefined,
      stores: {
        hasProviderKey: async (_tenantId, provider) => provider === "anthropic"
      }
    })
  );
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") return;
  expect(result.selectedModel?.id).toBe("deepagents/claude-sonnet-5");
});

test("resolveRuntimeModel: no-model path with zero configured providers returns provider_api_key_required for the default", async () => {
  const result = await resolveRuntimeModel(
    makeInput({
      requestedModel: undefined,
      stores: {
        hasProviderKey: async () => false
      }
    })
  );
  expect(result.kind).toBe("error");
  if (result.kind !== "error") return;
  expect(result.statusCode).toBe(400);
  expect(result.body.error).toBe("provider_api_key_required");
  // The default is Anthropic, so the error names Anthropic.
  expect(result.body.message).toMatch(/Anthropic/);
});

test("resolveRuntimeModel: an EXPLICIT model with no key is still rejected (not silently swapped)", async () => {
  const result = await resolveRuntimeModel(
    makeInput({
      requestedModel: "openai/gpt-5.6-sol",
      stores: {
        // Anthropic is configured, but the user explicitly asked for OpenAI.
        hasProviderKey: async (_tenantId, provider) => provider === "anthropic"
      }
    })
  );
  expect(result.kind).toBe("error");
  if (result.kind !== "error") return;
  expect(result.body.error).toBe("provider_api_key_required");
});

test("resolveRuntimeModel: gates on the SELECTED model's provider", async () => {
  const seen: string[] = [];
  const result = await resolveRuntimeModel(
    makeInput({
      requestedModel: "openai/gpt-5.6-sol",
      stores: {
        hasProviderKey: async (_tenantId, provider) => {
          seen.push(provider);
          return provider === "openai";
        }
      }
    })
  );
  expect(result.kind).toBe("ok");
  // The outcome above (ok under an openai-only key) already proves it gates on
  // the selected provider. Guard against probing the wrong provider — it must
  // check openai and NOT fall back to probing anthropic — without pinning the
  // exact call sequence (refactor-fragile).
  expect(seen).toContain("openai");
  expect(seen).not.toContain("anthropic");
});

test("resolveRuntimeModel: requested model selects that model", async () => {
  const result = await resolveRuntimeModel(
    makeInput({
      requestedModel: "deepagents/claude-haiku-4-5"
    })
  );
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") return;
  expect(result.selectedModel?.id).toBe("deepagents/claude-haiku-4-5");
});

test("resolveRuntimeModel: unknown requested model returns 400", async () => {
  const result = await resolveRuntimeModel(
    makeInput({
      requestedModel: "totally-made-up-model"
    })
  );
  expect(result.kind).toBe("error");
  if (result.kind !== "error") return;
  expect(result.statusCode).toBe(400);
  expect(result.body.error).toBe("invalid_request");
  expect(result.body.details?.[0]?.message).toMatch(/is not available/);
});

test("resolveRuntimeModel: unsupported effort for the chosen model returns 400", async () => {
  const result = await resolveRuntimeModel(
    makeInput({
      requestedModel: "deepagents/claude-sonnet-5",
      // sonnet-5 supports none/low/medium/high, not "max" — an out-of-range
      // effort for the chosen model is rejected.
      requestedEffort: "max"
    })
  );
  expect(result.kind).toBe("error");
  if (result.kind !== "error") return;
  expect(result.statusCode).toBe(400);
  expect(result.body.error).toBe("invalid_request");
  expect(result.body.details?.[0]?.message).toMatch(/Effort "max" is not supported/);
});

// ── Tenant model availability (admin-controlled) ────────────────────────────

const availability = (overrides: Partial<{
  enabledProviders: string[];
  enabledModelIds: string[] | null;
  modelDefaultEfforts: Record<string, string>;
}> = {}) =>
  async () =>
    ({
      enabledProviders: ["anthropic", "openai", "google", "openrouter", "zai"],
      enabledModelIds: null,
      modelDefaultEfforts: {},
      ...overrides
    }) as never;

test("resolveRuntimeModel: an explicitly requested model disabled by the allowlist returns 400", async () => {
  const result = await resolveRuntimeModel(
    makeInput({
      requestedModel: "openai/gpt-5.5",
      stores: {
        hasProviderKey: async () => true,
        getModelAvailability: availability({ enabledModelIds: ["deepagents/claude-sonnet-5"] })
      }
    })
  );
  expect(result.kind).toBe("error");
  if (result.kind !== "error") return;
  expect(result.statusCode).toBe(400);
  expect(result.body.details?.[0]?.message).toContain("not enabled for this organization");
});

test("resolveRuntimeModel: an explicitly requested model of a disabled provider returns 400", async () => {
  const result = await resolveRuntimeModel(
    makeInput({
      requestedModel: "openai/gpt-5.5",
      stores: {
        hasProviderKey: async () => true,
        getModelAvailability: availability({ enabledProviders: ["anthropic"] })
      }
    })
  );
  expect(result.kind).toBe("error");
  if (result.kind !== "error") return;
  expect(result.statusCode).toBe(400);
});

test("resolveRuntimeModel: the no-model default skips disabled providers/models", async () => {
  // Default (claude-sonnet-5) is disabled → the first enabled+configured model wins.
  const result = await resolveRuntimeModel(
    makeInput({
      stores: {
        hasProviderKey: async () => true,
        getModelAvailability: availability({ enabledProviders: ["openai"] })
      }
    })
  );
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") return;
  expect(result.selectedModel?.provider).toBe("openai");
});

test("resolveRuntimeModel: availability lookup failure returns 503", async () => {
  const result = await resolveRuntimeModel(
    makeInput({
      stores: {
        hasProviderKey: async () => true,
        getModelAvailability: async () => {
          throw new Error("postgres unreachable");
        }
      }
    })
  );
  expect(result.kind).toBe("error");
  if (result.kind !== "error") return;
  expect(result.statusCode).toBe(503);
});

test("resolveRuntimeModel: tenant default-effort override fills selectedEffort when none requested", async () => {
  const result = await resolveRuntimeModel(
    makeInput({
      requestedModel: "deepagents/claude-sonnet-5",
      stores: {
        hasProviderKey: async () => true,
        getModelAvailability: availability({
          modelDefaultEfforts: { "deepagents/claude-sonnet-5": "high" }
        })
      }
    })
  );
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") return;
  expect(result.selectedEffort).toBe("high");
});

test("resolveRuntimeModel: an explicit requested effort wins over the tenant override", async () => {
  const result = await resolveRuntimeModel(
    makeInput({
      requestedModel: "deepagents/claude-sonnet-5",
      requestedEffort: "low",
      stores: {
        hasProviderKey: async () => true,
        getModelAvailability: availability({
          modelDefaultEfforts: { "deepagents/claude-sonnet-5": "high" }
        })
      }
    })
  );
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") return;
  expect(result.selectedEffort).toBe("low");
});

test("resolveRuntimeModel: no availability wiring leaves selectedEffort as the requested effort", async () => {
  const result = await resolveRuntimeModel(
    makeInput({ requestedModel: "deepagents/claude-sonnet-5" })
  );
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") return;
  expect(result.selectedEffort).toBeUndefined();
});

// ── Admin-added custom models (listModels) ──────────────────────────────────

const CUSTOM_MODEL = {
  id: "openrouter/moonshotai/kimi-k3",
  displayName: "Kimi K3 (OpenRouter)",
  description: "Custom OpenRouter model.",
  isDefault: false,
  provider: "openrouter",
  supportedEfforts: [],
  defaultEffort: null,
  contextWindow: 262_144
} as never;

test("resolveRuntimeModel: an explicitly requested custom model resolves through listModels", async () => {
  const result = await resolveRuntimeModel(
    makeInput({
      requestedModel: "openrouter/moonshotai/kimi-k3",
      stores: {
        hasProviderKey: async () => true,
        listModels: async () => [CUSTOM_MODEL]
      }
    })
  );
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") return;
  expect(result.selectedModel?.id).toBe("openrouter/moonshotai/kimi-k3");
  expect(result.selectedModel?.provider).toBe("openrouter");
});

test("resolveRuntimeModel: a custom model not in the tenant catalog is rejected", async () => {
  const result = await resolveRuntimeModel(
    makeInput({
      requestedModel: "openrouter/moonshotai/kimi-k3",
      stores: { hasProviderKey: async () => true }
    })
  );
  expect(result.kind).toBe("error");
  if (result.kind !== "error") return;
  expect(result.statusCode).toBe(400);
});

test("resolveRuntimeModel: custom models respect the availability allowlist", async () => {
  const result = await resolveRuntimeModel(
    makeInput({
      requestedModel: "openrouter/moonshotai/kimi-k3",
      stores: {
        hasProviderKey: async () => true,
        listModels: async () => [CUSTOM_MODEL],
        getModelAvailability: availability({ enabledModelIds: ["deepagents/claude-sonnet-5"] })
      }
    })
  );
  expect(result.kind).toBe("error");
  if (result.kind !== "error") return;
  expect(result.statusCode).toBe(400);
});
