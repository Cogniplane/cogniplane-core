import { test, expect } from "vitest";

import type { RuntimeAdapter } from "../../runtime-contracts.js";
import {
  resolveRuntimeProviderAndModel,
  type RuntimeResolutionInput
} from "./runtime-provider-resolver.js";

const stubAdapter = {
  hasActiveTurn: () => false
} as unknown as RuntimeAdapter;

function makeInput(overrides: Partial<RuntimeResolutionInput> = {}): RuntimeResolutionInput {
  return {
    tenantId: "t",
    requestedModel: undefined,
    requestedEffort: undefined,
    defaultAdapter: stubAdapter,
    stores: {
      dynamicConfig: {
        async getOrCreateTenantSettings() {
          return {
            enabledRuntimeProviders: ["codex"],
            runtimeProvider: "codex"
          } as never;
        }
      },
      runtimeAdapters: { codex: stubAdapter as never },
      hasAnthropicApiKey: async () => true,
      hasOpenaiApiKey: async () => true
    },
    ...overrides
  };
}

test("resolveRuntimeProviderAndModel: codex without OPENAI key returns codex_api_key_required", async () => {
  const result = await resolveRuntimeProviderAndModel(
    makeInput({
      stores: {
        dynamicConfig: {
          async getOrCreateTenantSettings() {
            return {
              enabledRuntimeProviders: ["codex"],
              runtimeProvider: "codex"
            } as never;
          }
        },
        runtimeAdapters: { codex: stubAdapter as never },
        hasAnthropicApiKey: async () => true,
        hasOpenaiApiKey: async () => false
      }
    })
  );
  expect(result.kind).toBe("error");
  if (result.kind !== "error") return;
  expect(result.statusCode).toBe(400);
  expect(result.body.error).toBe("codex_api_key_required");
  expect(result.body.message).toMatch(/OpenAI API key/);
});

test("resolveRuntimeProviderAndModel: codex with OPENAI key resolves ok", async () => {
  const result = await resolveRuntimeProviderAndModel(makeInput());
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") return;
  expect(result.provider).toBe("codex");
});

test("resolveRuntimeProviderAndModel: tenant-settings lookup error returns 503 runtime_provider_unavailable", async () => {
  const result = await resolveRuntimeProviderAndModel(
    makeInput({
      stores: {
        dynamicConfig: {
          async getOrCreateTenantSettings() {
            throw new Error("postgres connection refused");
          }
        },
        runtimeAdapters: { codex: stubAdapter as never },
        hasAnthropicApiKey: async () => true,
        hasOpenaiApiKey: async () => true
      }
    })
  );
  expect(result.kind).toBe("error");
  if (result.kind !== "error") return;
  expect(result.statusCode).toBe(503);
  expect(result.body.error).toBe("runtime_provider_unavailable");
});

test("resolveRuntimeProviderAndModel: skips tenant lookup when stores incomplete and falls through to model selection", async () => {
  // Without dynamicConfig + runtimeAdapters wired in, the resolver leaves
  // provider="codex" and the default adapter, then picks the codex default.
  const result = await resolveRuntimeProviderAndModel({
    tenantId: "t",
    requestedModel: undefined,
    requestedEffort: undefined,
    defaultAdapter: stubAdapter,
    stores: {
      hasAnthropicApiKey: async () => false,
      hasOpenaiApiKey: async () => false
    }
  });
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") return;
  expect(result.provider).toBe("codex");
  // Codex default model — `gpt-5.4-mini` is the only isDefault=true in codex
  expect(result.selectedModel?.id).toBe("gpt-5.4-mini");
});

test("resolveRuntimeProviderAndModel: tenant disables codex but request implies codex returns 400", async () => {
  const result = await resolveRuntimeProviderAndModel(
    makeInput({
      stores: {
        dynamicConfig: {
          async getOrCreateTenantSettings() {
            return {
              enabledRuntimeProviders: ["claude-code"],
              runtimeProvider: "claude-code"
            } as never;
          }
        },
        runtimeAdapters: { codex: stubAdapter as never },
        hasAnthropicApiKey: async () => true,
        hasOpenaiApiKey: async () => true
      },
      requestedModel: "gpt-5.4-mini" // codex
    })
  );
  expect(result.kind).toBe("error");
  if (result.kind !== "error") return;
  expect(result.statusCode).toBe(400);
  expect(result.body.error).toBe("invalid_request");
  expect(result.body.details?.[0]?.message).toMatch(/Codex models are not enabled/);
});

test("resolveRuntimeProviderAndModel: claude requested but adapter not registered returns 503", async () => {
  const result = await resolveRuntimeProviderAndModel(
    makeInput({
      stores: {
        dynamicConfig: {
          async getOrCreateTenantSettings() {
            return {
              enabledRuntimeProviders: ["claude-code", "codex"],
              runtimeProvider: "claude-code"
            } as never;
          }
        },
        // NOTE: only codex registered — no claude-code adapter
        runtimeAdapters: { codex: stubAdapter as never },
        hasAnthropicApiKey: async () => true,
        hasOpenaiApiKey: async () => true
      }
    })
  );
  expect(result.kind).toBe("error");
  if (result.kind !== "error") return;
  expect(result.statusCode).toBe(503);
  expect(result.body.error).toBe("runtime_provider_unavailable");
  expect(result.body.message).toMatch(/Claude Code runtime adapter is not available/);
});

test("resolveRuntimeProviderAndModel: claude with no Anthropic key returns anthropic_api_key_required", async () => {
  const result = await resolveRuntimeProviderAndModel(
    makeInput({
      stores: {
        dynamicConfig: {
          async getOrCreateTenantSettings() {
            return {
              enabledRuntimeProviders: ["claude-code", "codex"],
              runtimeProvider: "claude-code"
            } as never;
          }
        },
        runtimeAdapters: {
          codex: stubAdapter as never,
          "claude-code": stubAdapter as never
        },
        hasAnthropicApiKey: async () => false,
        hasOpenaiApiKey: async () => true
      }
    })
  );
  expect(result.kind).toBe("error");
  if (result.kind !== "error") return;
  expect(result.statusCode).toBe(400);
  expect(result.body.error).toBe("anthropic_api_key_required");
});

test("resolveRuntimeProviderAndModel: claude with key resolves ok using the claude adapter", async () => {
  const claudeAdapter = { hasActiveTurn: () => false } as never;
  const result = await resolveRuntimeProviderAndModel(
    makeInput({
      stores: {
        dynamicConfig: {
          async getOrCreateTenantSettings() {
            return {
              enabledRuntimeProviders: ["claude-code", "codex"],
              runtimeProvider: "claude-code"
            } as never;
          }
        },
        runtimeAdapters: { codex: stubAdapter as never, "claude-code": claudeAdapter },
        hasAnthropicApiKey: async () => true,
        hasOpenaiApiKey: async () => true
      }
    })
  );
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") return;
  expect(result.provider).toBe("claude-code");
  expect(result.runtimeAdapter).toBe(claudeAdapter);
  // Claude default model
  expect(result.selectedModel?.id).toBe("claude-sonnet-4-6");
});

test("resolveRuntimeProviderAndModel: requested model overrides tenant default provider", async () => {
  const claudeAdapter = { hasActiveTurn: () => false } as never;
  const result = await resolveRuntimeProviderAndModel(
    makeInput({
      requestedModel: "claude-opus-4-7",
      stores: {
        dynamicConfig: {
          async getOrCreateTenantSettings() {
            return {
              enabledRuntimeProviders: ["claude-code", "codex"],
              runtimeProvider: "codex" // tenant default is codex
            } as never;
          }
        },
        runtimeAdapters: { codex: stubAdapter as never, "claude-code": claudeAdapter },
        hasAnthropicApiKey: async () => true,
        hasOpenaiApiKey: async () => true
      }
    })
  );
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") return;
  expect(result.provider).toBe("claude-code");
  expect(result.selectedModel?.id).toBe("claude-opus-4-7");
});

test("resolveRuntimeProviderAndModel: unknown requested model — provider falls back to tenant default; selectedModel is null", async () => {
  const result = await resolveRuntimeProviderAndModel(
    makeInput({
      requestedModel: "totally-made-up-model"
    })
  );
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") return;
  expect(result.provider).toBe("codex");
  expect(result.selectedModel).toBeNull();
});

test("resolveRuntimeProviderAndModel: unsupported effort for the chosen model returns 400", async () => {
  const result = await resolveRuntimeProviderAndModel(
    makeInput({
      requestedModel: "gpt-5.4-mini",
      requestedEffort: "max" // gpt-5.4-mini supports up to xhigh, not max
    })
  );
  expect(result.kind).toBe("error");
  if (result.kind !== "error") return;
  expect(result.statusCode).toBe(400);
  expect(result.body.error).toBe("invalid_request");
  expect(result.body.details?.[0]?.message).toMatch(/Effort "max" is not supported/);
});

test("resolveRuntimeProviderAndModel: requested model belongs to wrong provider returns 400", async () => {
  // Force tenant default = claude-code, but request a codex model. Provider
  // becomes codex (model trumps tenant default), passes the enabled-providers
  // check (codex enabled), but if we set up so that the resolved provider is
  // claude and selectedModel.provider !== provider — exactly the mismatch path.
  // We do this with a stricter setup: the model "gpt-5.4-mini" is found in
  // AVAILABLE_MODELS, so requestedProvider becomes "codex", which is fine.
  // The mismatch path is reached only if the provider in tenant settings is
  // forced to claude-code AND only claude-code is enabled. Then provider="claude-code",
  // selectedModel.provider="codex" — mismatch.
  const claudeAdapter = { hasActiveTurn: () => false } as never;
  const result = await resolveRuntimeProviderAndModel(
    makeInput({
      requestedModel: "gpt-5.4-mini", // codex model
      stores: {
        dynamicConfig: {
          async getOrCreateTenantSettings() {
            return {
              enabledRuntimeProviders: ["claude-code"],
              runtimeProvider: "claude-code"
            } as never;
          }
        },
        runtimeAdapters: {
          codex: stubAdapter as never,
          "claude-code": claudeAdapter
        },
        hasAnthropicApiKey: async () => true,
        hasOpenaiApiKey: async () => true
      }
    })
  );
  // Tenant rejects codex up-front because it's not enabled — error path returns
  // BEFORE the model/provider mismatch branch. Here we just verify the tenant
  // gate fires first.
  expect(result.kind).toBe("error");
  if (result.kind !== "error") return;
  expect(result.body.error).toBe("invalid_request");
  expect(result.body.details?.[0]?.message).toMatch(/Codex models are not enabled/);
});

test("resolveRuntimeProviderAndModel: supported effort passes through", async () => {
  const result = await resolveRuntimeProviderAndModel(
    makeInput({
      requestedModel: "gpt-5.4-mini",
      requestedEffort: "high"
    })
  );
  expect(result.kind).toBe("ok");
});
