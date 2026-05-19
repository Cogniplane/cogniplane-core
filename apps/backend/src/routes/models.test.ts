import Fastify from "fastify";
import { test, afterEach, expect } from "vitest";

import type { AvailableModel } from "../domain/models.js";
import type { RuntimeAdapter } from "../runtime-contracts.js";

import {
  enrichClaudeModelsFromAnthropic,
  registerModelRoutes,
  resolveAvailableRuntimeProviders,
  type ModelRouteStores
} from "./models.js";
import { createAnthropicCapabilitiesCache } from "./models-anthropic-cache.js";

const stubAdapter = { hasActiveTurn: () => false } as unknown as RuntimeAdapter;

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function makeStores(overrides: Partial<ModelRouteStores> = {}): ModelRouteStores {
  return {
    dynamicConfig: {
      async getOrCreateTenantSettings() {
        return {
          enabledRuntimeProviders: ["codex"],
          runtimeProvider: "codex",
          showEffortSelector: false
        } as never;
      }
    },
    ...overrides
  };
}

// resolveAvailableRuntimeProviders

test("resolveAvailableRuntimeProviders: returns just codex when only codex is enabled", async () => {
  const result = await resolveAvailableRuntimeProviders(makeStores(), "t");
  expect(result.enabledRuntimeProviders).toEqual(["codex"]);
  expect(result.defaultRuntimeProvider).toBe("codex");
});

test("resolveAvailableRuntimeProviders: drops codex when no openai key", async () => {
  const stores: ModelRouteStores = {
    dynamicConfig: {
      async getOrCreateTenantSettings() {
        return {
          enabledRuntimeProviders: ["codex"],
          runtimeProvider: "codex",
          showEffortSelector: false
        } as never;
      }
    },
    hasOpenaiApiKey: async () => false
  };
  const result = await resolveAvailableRuntimeProviders(stores, "t");
  expect(result.enabledRuntimeProviders).toEqual([]);
});

test("resolveAvailableRuntimeProviders: returns empty list when neither key is set", async () => {
  const stores: ModelRouteStores = {
    dynamicConfig: {
      async getOrCreateTenantSettings() {
        return {
          enabledRuntimeProviders: ["codex", "claude-code"],
          runtimeProvider: "codex",
          showEffortSelector: false
        } as never;
      }
    },
    runtimeAdapters: { "claude-code": {} },
    hasOpenaiApiKey: async () => false,
    hasAnthropicApiKey: async () => false
  };
  const result = await resolveAvailableRuntimeProviders(stores, "t");
  expect(result.enabledRuntimeProviders).toEqual([]);
});

test("resolveAvailableRuntimeProviders: returns codex only when only OPENAI key is set", async () => {
  const stores: ModelRouteStores = {
    dynamicConfig: {
      async getOrCreateTenantSettings() {
        return {
          enabledRuntimeProviders: ["codex", "claude-code"],
          runtimeProvider: "codex",
          showEffortSelector: false
        } as never;
      }
    },
    runtimeAdapters: { "claude-code": {} },
    hasOpenaiApiKey: async () => true,
    hasAnthropicApiKey: async () => false
  };
  const result = await resolveAvailableRuntimeProviders(stores, "t");
  expect(result.enabledRuntimeProviders).toEqual(["codex"]);
  expect(result.defaultRuntimeProvider).toBe("codex");
});

test("resolveAvailableRuntimeProviders: returns claude-code only when only ANTHROPIC key is set", async () => {
  const stores: ModelRouteStores = {
    dynamicConfig: {
      async getOrCreateTenantSettings() {
        return {
          enabledRuntimeProviders: ["codex", "claude-code"],
          runtimeProvider: "codex",
          showEffortSelector: false
        } as never;
      }
    },
    runtimeAdapters: { "claude-code": {} },
    hasOpenaiApiKey: async () => false,
    hasAnthropicApiKey: async () => true
  };
  const result = await resolveAvailableRuntimeProviders(stores, "t");
  expect(result.enabledRuntimeProviders).toEqual(["claude-code"]);
  expect(result.defaultRuntimeProvider).toBe("claude-code");
});

test("resolveAvailableRuntimeProviders: includes both providers when both keys are set", async () => {
  const stores: ModelRouteStores = {
    dynamicConfig: {
      async getOrCreateTenantSettings() {
        return {
          enabledRuntimeProviders: ["codex", "claude-code"],
          runtimeProvider: "claude-code",
          showEffortSelector: false
        } as never;
      }
    },
    runtimeAdapters: { "claude-code": {} },
    hasOpenaiApiKey: async () => true,
    hasAnthropicApiKey: async () => true
  };
  const result = await resolveAvailableRuntimeProviders(stores, "t");
  expect(result.enabledRuntimeProviders).toEqual(["codex", "claude-code"]);
  expect(result.defaultRuntimeProvider).toBe("claude-code");
});

test("resolveAvailableRuntimeProviders: drops claude-code when adapter not configured", async () => {
  const stores = makeStores({
    dynamicConfig: {
      async getOrCreateTenantSettings() {
        return {
          enabledRuntimeProviders: ["codex", "claude-code"],
          runtimeProvider: "claude-code",
          showEffortSelector: true
        } as never;
      }
    }
    // no runtimeAdapters
  });
  const result = await resolveAvailableRuntimeProviders(stores, "t");
  expect(result.enabledRuntimeProviders).toEqual(["codex"]);
  expect(result.defaultRuntimeProvider).toBe("codex");
  expect(result.showEffortSelector).toBe(true);
});

test("resolveAvailableRuntimeProviders: drops claude-code when no anthropic key", async () => {
  const stores: ModelRouteStores = {
    dynamicConfig: {
      async getOrCreateTenantSettings() {
        return {
          enabledRuntimeProviders: ["codex", "claude-code"],
          runtimeProvider: "claude-code",
          showEffortSelector: true
        } as never;
      }
    },
    runtimeAdapters: { "claude-code": {} },
    hasAnthropicApiKey: async () => false
  };
  const result = await resolveAvailableRuntimeProviders(stores, "t");
  expect(result.enabledRuntimeProviders).toEqual(["codex"]);
});

test("resolveAvailableRuntimeProviders: includes claude-code when adapter+key present", async () => {
  const stores: ModelRouteStores = {
    dynamicConfig: {
      async getOrCreateTenantSettings() {
        return {
          enabledRuntimeProviders: ["codex", "claude-code"],
          runtimeProvider: "claude-code",
          showEffortSelector: false
        } as never;
      }
    },
    runtimeAdapters: { "claude-code": {} },
    hasAnthropicApiKey: async () => true
  };
  const result = await resolveAvailableRuntimeProviders(stores, "t");
  expect(result.enabledRuntimeProviders).toEqual(["codex", "claude-code"]);
  expect(result.defaultRuntimeProvider).toBe("claude-code");
});

test("resolveAvailableRuntimeProviders: when nothing enables, returns empty providers", async () => {
  const stores: ModelRouteStores = {
    dynamicConfig: {
      async getOrCreateTenantSettings() {
        return {
          enabledRuntimeProviders: ["claude-code"],
          runtimeProvider: "claude-code",
          showEffortSelector: false
        } as never;
      }
    },
    runtimeAdapters: {},
    hasAnthropicApiKey: async () => false
  };
  const result = await resolveAvailableRuntimeProviders(stores, "t");
  expect(result.enabledRuntimeProviders).toEqual([]);
  // Schema requires non-null; falls back to settings.runtimeProvider as a structural placeholder
  expect(result.defaultRuntimeProvider).toBe("claude-code");
});

test("resolveAvailableRuntimeProviders: keeps default if it's still in the enabled list", async () => {
  const stores: ModelRouteStores = {
    dynamicConfig: {
      async getOrCreateTenantSettings() {
        return {
          enabledRuntimeProviders: ["claude-code", "codex"],
          runtimeProvider: "codex",
          showEffortSelector: false
        } as never;
      }
    },
    runtimeAdapters: { "claude-code": {} },
    hasAnthropicApiKey: async () => true
  };
  const result = await resolveAvailableRuntimeProviders(stores, "t");
  expect(result.defaultRuntimeProvider).toBe("codex");
});

// enrichClaudeModelsFromAnthropic

const claudeModel: AvailableModel = {
  id: "claude-sonnet",
  label: "Sonnet",
  provider: "claude-code",
  supportedEfforts: [],
  defaultEffort: null
};

const codexModel: AvailableModel = {
  id: "gpt-5",
  label: "GPT 5",
  provider: "codex",
  supportedEfforts: [],
  defaultEffort: null
};

test("enrichClaudeModelsFromAnthropic: returns models unchanged when no claude-code models present", async () => {
  const stores = makeStores();
  const result = await enrichClaudeModelsFromAnthropic("t", [codexModel], stores, 100);
  expect(result).toEqual([codexModel]);
});

test("enrichClaudeModelsFromAnthropic: returns models unchanged when no API key getter", async () => {
  const stores = makeStores(); // no getAnthropicApiKey
  const result = await enrichClaudeModelsFromAnthropic("t", [claudeModel], stores, 100);
  expect(result).toEqual([claudeModel]);
});

test("enrichClaudeModelsFromAnthropic: returns models unchanged when API key empty", async () => {
  const stores = makeStores({
    getAnthropicApiKey: async () => "  "
  });
  const result = await enrichClaudeModelsFromAnthropic("t", [claudeModel], stores, 100);
  expect(result).toEqual([claudeModel]);
});

test("enrichClaudeModelsFromAnthropic: returns unchanged when Anthropic API responds non-2xx", async () => {
  globalThis.fetch = (async () => new Response("err", { status: 500 })) as typeof fetch;
  const stores = makeStores({ getAnthropicApiKey: async () => "k" });
  const result = await enrichClaudeModelsFromAnthropic("t", [claudeModel], stores, 100);
  expect(result).toEqual([claudeModel]);
});

test("enrichClaudeModelsFromAnthropic: returns unchanged when fetch rejects (timeout/network)", async () => {
  globalThis.fetch = (async () => {
    throw new Error("net");
  }) as typeof fetch;
  const stores = makeStores({ getAnthropicApiKey: async () => "k" });
  const result = await enrichClaudeModelsFromAnthropic("t", [claudeModel], stores, 100);
  expect(result).toEqual([claudeModel]);
});

test("enrichClaudeModelsFromAnthropic: cache reuses the upstream result on a second call within TTL", async () => {
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response(
      JSON.stringify({
        data: [
          {
            id: "claude-sonnet",
            capabilities: {
              effort: { supported: true, high: { supported: true } }
            }
          }
        ]
      }),
      { status: 200 }
    );
  }) as typeof fetch;

  const cache = createAnthropicCapabilitiesCache({
    successTtlMs: 60_000,
    negativeTtlMs: 1_000
  });
  const stores = makeStores({
    getAnthropicApiKey: async () => "k",
    anthropicCapabilitiesCache: cache
  });

  const first = await enrichClaudeModelsFromAnthropic("t", [claudeModel], stores, 100);
  const second = await enrichClaudeModelsFromAnthropic("t", [claudeModel], stores, 100);

  expect(fetchCalls).toBe(1);
  expect(first[0].supportedEfforts).toEqual(["high"]);
  expect(second[0].supportedEfforts).toEqual(["high"]);
});

test("enrichClaudeModelsFromAnthropic: maps supportedEfforts and defaultEffort='high' when present", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: [
          {
            id: "claude-sonnet",
            capabilities: {
              effort: {
                supported: true,
                low: { supported: true },
                medium: { supported: true },
                high: { supported: true },
                xhigh: { supported: false }
              }
            }
          }
        ]
      }),
      { status: 200 }
    )) as typeof fetch;
  const stores = makeStores({ getAnthropicApiKey: async () => "k" });
  const result = await enrichClaudeModelsFromAnthropic("t", [claudeModel], stores, 100);
  expect(result[0].supportedEfforts).toEqual(["low", "medium", "high"]);
  expect(result[0].defaultEffort).toBe("high");
});

test("enrichClaudeModelsFromAnthropic: defaultEffort falls back to first supported when no 'high'", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: [
          {
            id: "claude-sonnet",
            capabilities: {
              effort: { supported: true, low: { supported: true } }
            }
          }
        ]
      }),
      { status: 200 }
    )) as typeof fetch;
  const stores = makeStores({ getAnthropicApiKey: async () => "k" });
  const result = await enrichClaudeModelsFromAnthropic("t", [claudeModel], stores, 100);
  expect(result[0].defaultEffort).toBe("low");
});

test("enrichClaudeModelsFromAnthropic: model with effort.supported=false maps to empty arrays", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: [
          { id: "claude-sonnet", capabilities: { effort: { supported: false } } }
        ]
      }),
      { status: 200 }
    )) as typeof fetch;
  const stores = makeStores({ getAnthropicApiKey: async () => "k" });
  const result = await enrichClaudeModelsFromAnthropic("t", [claudeModel], stores, 100);
  expect(result[0].supportedEfforts).toEqual([]);
  expect(result[0].defaultEffort).toBe(null);
});

test("enrichClaudeModelsFromAnthropic: skips models the API does not return", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ data: [{ id: "claude-other", capabilities: { effort: { supported: false } } }] }),
      { status: 200 }
    )) as typeof fetch;
  const stores = makeStores({ getAnthropicApiKey: async () => "k" });
  const result = await enrichClaudeModelsFromAnthropic("t", [claudeModel], stores, 100);
  // claude-sonnet not in response → returned unchanged
  expect(result[0]).toEqual(claudeModel);
});

test("enrichClaudeModelsFromAnthropic: codex models in the same list are not modified", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: [
          {
            id: "claude-sonnet",
            capabilities: { effort: { supported: true, high: { supported: true } } }
          }
        ]
      }),
      { status: 200 }
    )) as typeof fetch;
  const stores = makeStores({ getAnthropicApiKey: async () => "k" });
  const result = await enrichClaudeModelsFromAnthropic("t", [claudeModel, codexModel], stores, 100);
  expect(result[1]).toBe(codexModel);
  expect(result[0].supportedEfforts).toEqual(["high"]);
});

test("enrichClaudeModelsFromAnthropic: skips models with no id in the API response", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: [{ capabilities: { effort: { supported: true } } }]
      }),
      { status: 200 }
    )) as typeof fetch;
  const stores = makeStores({ getAnthropicApiKey: async () => "k" });
  const result = await enrichClaudeModelsFromAnthropic("t", [claudeModel], stores, 100);
  expect(result[0]).toEqual(claudeModel);
});

// /models route — fallback path symmetry (M13 fix)

async function makeModelsApp(stores: ModelRouteStores) {
  const app = Fastify();
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: "u",
      tenantId: "t",
      role: "member",
      isAdmin: false
    };
  });
  await registerModelRoutes(app, stores);
  return app;
}

test("/models fallback (tenant lookup throws): includes Claude when ANTHROPIC_API_KEY is set", async () => {
  const stores: ModelRouteStores = {
    dynamicConfig: {
      async getOrCreateTenantSettings() {
        throw new Error("postgres unreachable");
      }
    },
    runtimeAdapters: { "claude-code": stubAdapter as never },
    hasOpenaiApiKey: async () => false,
    hasAnthropicApiKey: async () => true
  };
  const app = await makeModelsApp(stores);
  try {
    const response = await app.inject({ method: "GET", url: "/models" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.enabledRuntimeProviders).toEqual(["claude-code"]);
    expect(body.defaultRuntimeProvider).toBe("claude-code");
    expect(body.models.every((m: { provider: string }) => m.provider === "claude-code")).toBe(true);
  } finally {
    await app.close();
  }
});

test("/models fallback: returns empty providers when neither key is set", async () => {
  const stores: ModelRouteStores = {
    dynamicConfig: {
      async getOrCreateTenantSettings() {
        throw new Error("postgres unreachable");
      }
    },
    runtimeAdapters: { "claude-code": stubAdapter as never },
    hasOpenaiApiKey: async () => false,
    hasAnthropicApiKey: async () => false
  };
  const app = await makeModelsApp(stores);
  try {
    const response = await app.inject({ method: "GET", url: "/models" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.enabledRuntimeProviders).toEqual([]);
    expect(body.models).toEqual([]);
  } finally {
    await app.close();
  }
});

test("/models fallback: includes both providers when both keys are set", async () => {
  const stores: ModelRouteStores = {
    dynamicConfig: {
      async getOrCreateTenantSettings() {
        throw new Error("postgres unreachable");
      }
    },
    runtimeAdapters: { "claude-code": stubAdapter as never },
    hasOpenaiApiKey: async () => true,
    hasAnthropicApiKey: async () => true
  };
  const app = await makeModelsApp(stores);
  try {
    const response = await app.inject({ method: "GET", url: "/models" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.enabledRuntimeProviders).toEqual(["codex", "claude-code"]);
  } finally {
    await app.close();
  }
});
