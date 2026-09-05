import Fastify from "fastify";
import { test, expect } from "vitest";

import type { EffortLevel, ModelProvider } from "@cogniplane/shared-types";
import { MODEL_PROVIDERS } from "@cogniplane/shared-types";

import type { TenantSettingsRecord } from "../services/tenant-settings-store.js";

import { registerModelRoutes, type ModelRouteStores } from "./models.js";

function settingsWith(overrides: Partial<TenantSettingsRecord> = {}): TenantSettingsRecord {
  return {
    tenantId: "t",
    showEffortSelector: false,
    webSearchMode: "disabled",
    approvalPolicy: "on-request",
    approvalReviewer: "user",
    allowCommandExecution: false,
    autoApproveReadOnlyTools: true,
    policyEnforcementMode: "monitor",
    developerInstructions: null,
    enabledToolIds: [],
    enabledMcpServerIds: [],
    enabledProviders: [...MODEL_PROVIDERS],
    enabledModelIds: null,
    modelDefaultEfforts: {},
    version: 1,
    configHash: "test-config",
    updatedAt: "2026-09-04T00:00:00.000Z",
    ...overrides
  };
}

function makeStores(overrides: Partial<ModelRouteStores> = {}): ModelRouteStores {
  return {
    dynamicConfig: {
      async getOrCreateTenantSettings() {
        return settingsWith();
      }
    },
    configuredProviders: configured(),
    ...overrides
  };
}

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

const configured = (...providers: ModelProvider[]) =>
  async () => new Set<ModelProvider>(providers);

test("/models lists only Anthropic models when only the Anthropic key is present", async () => {
  const app = await makeModelsApp(
    makeStores({
      configuredProviders: configured("anthropic")
    })
  );
  try {
    const response = await app.inject({ method: "GET", url: "/models" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.models.length).toBeGreaterThan(0);
    expect(body.models.every((m: { provider: string }) => m.provider === "anthropic")).toBe(true);
  } finally {
    await app.close();
  }
});

test("/models lists a provider's models when only that provider is configured", async () => {
  const app = await makeModelsApp(
    makeStores({
      configuredProviders: configured("openai")
    })
  );
  try {
    const response = await app.inject({ method: "GET", url: "/models" });
    const body = response.json();
    expect(body.models.length).toBeGreaterThan(0);
    expect(body.models.every((m: { provider: string }) => m.provider === "openai")).toBe(true);
  } finally {
    await app.close();
  }
});

test("/models returns an empty list when no provider key is available", async () => {
  const app = await makeModelsApp(
    makeStores({
      configuredProviders: configured()
    })
  );
  try {
    const response = await app.inject({ method: "GET", url: "/models" });
    expect(response.statusCode).toBe(200);
    expect(response.json().models).toEqual([]);
  } finally {
    await app.close();
  }
});

test("/models surfaces showEffortSelector from tenant settings", async () => {
  const app = await makeModelsApp(
    makeStores({
      dynamicConfig: {
        async getOrCreateTenantSettings() {
          return settingsWith({ showEffortSelector: true });
        }
      },
      configuredProviders: configured("anthropic")
    })
  );
  try {
    const response = await app.inject({ method: "GET", url: "/models" });
    expect(response.json().showEffortSelector).toBe(true);
  } finally {
    await app.close();
  }
});

test("/models hides models of a disabled provider even when its key is configured", async () => {
  const app = await makeModelsApp(
    makeStores({
      dynamicConfig: {
        async getOrCreateTenantSettings() {
          return settingsWith({ enabledProviders: ["openai"] });
        }
      },
      configuredProviders: configured("anthropic", "openai")
    })
  );
  try {
    const response = await app.inject({ method: "GET", url: "/models" });
    const body = response.json();
    expect(body.models.length).toBeGreaterThan(0);
    expect(body.models.every((m: { provider: string }) => m.provider === "openai")).toBe(true);
  } finally {
    await app.close();
  }
});

test("/models applies the enabledModelIds allowlist", async () => {
  const app = await makeModelsApp(
    makeStores({
      dynamicConfig: {
        async getOrCreateTenantSettings() {
          return settingsWith({ enabledModelIds: ["deepagents/claude-sonnet-5"] });
        }
      },
      configuredProviders: configured("anthropic", "openai")
    })
  );
  try {
    const response = await app.inject({ method: "GET", url: "/models" });
    const body = response.json();
    expect(body.models.map((m: { id: string }) => m.id)).toEqual(["deepagents/claude-sonnet-5"]);
  } finally {
    await app.close();
  }
});

test("/models overrides defaultEffort from tenant modelDefaultEfforts", async () => {
  const app = await makeModelsApp(
    makeStores({
      dynamicConfig: {
        async getOrCreateTenantSettings() {
          return settingsWith({
            modelDefaultEfforts: { "deepagents/claude-sonnet-5": "high" satisfies EffortLevel }
          });
        }
      },
      configuredProviders: configured("anthropic")
    })
  );
  try {
    const response = await app.inject({ method: "GET", url: "/models" });
    const sonnet = response
      .json()
      .models.find((m: { id: string }) => m.id === "deepagents/claude-sonnet-5");
    expect(sonnet.defaultEffort).toBe("high");
  } finally {
    await app.close();
  }
});

test("/models ignores a defaultEffort override the model does not support", async () => {
  const app = await makeModelsApp(
    makeStores({
      dynamicConfig: {
        async getOrCreateTenantSettings() {
          // Haiku 4.5 only supports "none"; a stale "high" override is ignored.
          return settingsWith({
            modelDefaultEfforts: { "deepagents/claude-haiku-4-5": "high" satisfies EffortLevel }
          });
        }
      },
      configuredProviders: configured("anthropic")
    })
  );
  try {
    const response = await app.inject({ method: "GET", url: "/models" });
    const haiku = response
      .json()
      .models.find((m: { id: string }) => m.id === "deepagents/claude-haiku-4-5");
    expect(haiku.defaultEffort).toBe("none");
  } finally {
    await app.close();
  }
});

test("/models fails closed when the tenant settings lookup throws", async () => {
  // Availability is an admin policy control now — degrading to "all models"
  // on a settings failure would silently ignore admin restrictions.
  const app = await makeModelsApp(
    makeStores({
      dynamicConfig: {
        async getOrCreateTenantSettings() {
          throw new Error("postgres unreachable");
        }
      },
      configuredProviders: configured("anthropic")
    })
  );
  try {
    const response = await app.inject({ method: "GET", url: "/models" });
    expect(response.statusCode).toBe(500);
  } finally {
    await app.close();
  }
});
