import Fastify from "fastify";
import { test, expect } from "vitest";

import type { ModelProvider, TenantSettings } from "@cogniplane/shared-types";

import type { Pool } from "../../lib/db.js";
import { FakeDatabase } from "../../test-helpers/fake-database.js";
import { InMemoryAuditEventStore } from "../../test-helpers/in-memory-audit-events.js";
import type { AuditEventStore } from "../../services/audit-event-store.js";
import type { CustomModelInput, CustomModelRecord } from "../../services/custom-model-store.js";
import { customModelId } from "../../services/custom-model-store.js";
import type { OpenRouterCatalogEntry } from "../../services/openrouter-catalog.js";
import { registerAdminModelRoutes, type ModelAdminRouteStores } from "./admin-model-routes.js";

class InMemoryCustomModels {
  records = new Map<string, CustomModelRecord>();

  async list(_tenantId: string): Promise<CustomModelRecord[]> {
    return [...this.records.values()];
  }

  async create(_tenantId: string, input: CustomModelInput): Promise<CustomModelRecord | null> {
    const modelId = customModelId(input.provider, input.vendorModelId);
    if (this.records.has(modelId)) return null;
    const record: CustomModelRecord = {
      modelId,
      provider: input.provider,
      vendorModelId: input.vendorModelId,
      displayName: input.displayName,
      description: input.description,
      contextWindow: input.contextWindow,
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.records.set(modelId, record);
    return record;
  }

  // Queries run inside the delete transaction. `failQuery` makes one fail,
  // and then the delete does not happen, like a rollback.
  readonly transactionQueries: unknown[][] = [];
  failQuery = false;

  async delete(
    _tenantId: string,
    modelId: string,
    inTransaction?: (client: never) => Promise<void>
  ): Promise<boolean> {
    if (!this.records.has(modelId)) return false;
    const client = {
      query: async (_sql: string, params: unknown[]) => {
        if (this.failQuery) throw new Error("audit insert failed");
        this.transactionQueries.push(params);
        return { rows: [], rowCount: 1 };
      }
    };
    await inTransaction?.(client as never);
    return this.records.delete(modelId);
  }
}

const OPENROUTER_CATALOG: OpenRouterCatalogEntry[] = [
  { id: "moonshotai/kimi-k3", name: "MoonshotAI: Kimi K3", contextLength: 262_144 },
  { id: "mistralai/mistral-large-3", name: "Mistral Large 3", contextLength: null }
];

function makeSettings(overrides: Partial<TenantSettings> = {}): TenantSettings {
  return {
    tenantId: "admin-tenant",
    version: 1,
    configHash: "hash-1",
    updatedAt: "2026-09-07T12:00:00Z",
    enabledProviders: ["openai"],
    enabledModelIds: null,
    defaultModelId: null,
    modelDefaultEfforts: {},
    approvedSandboxEgressDomains: [],
    showEffortSelector: false,
    webSearchMode: "disabled",
    approvalPolicy: "never",
    approvalReviewer: "user",
    allowCommandExecution: false,
    autoApproveReadOnlyTools: true,
    policyEnforcementMode: "monitor",
    developerInstructions: null,
    enabledToolIds: [],
    enabledMcpServerIds: [],
    ...overrides
  };
}

async function makeApp(options: {
  customModels?: InMemoryCustomModels;
  catalog?: OpenRouterCatalogEntry[] | Error;
  settings?: ReturnType<typeof makeSettings>;
  // The settings that the locked read returns, when they differ from a plain read.
  lockedSettings?: ReturnType<typeof makeSettings>;
  // Runs when the settings lock is taken: the moment a concurrent writer has
  // committed and this request starts to read.
  onLock?: () => Promise<void>;
} = {}) {
  const customModels = options.customModels ?? new InMemoryCustomModels();
  const auditEvents = new InMemoryAuditEventStore();
  const settingsUpdates: Record<string, unknown>[] = [];
  const settingsAudits: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const settings = options.settings ?? makeSettings();
  let lockedReads = 0;

  const app = Fastify();
  app.decorate("db", new FakeDatabase() as unknown as Pool);
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: "admin-user",
      tenantId: "admin-tenant",
      isAdmin: true,
      role: "owner" as const
    };
  });
  await registerAdminModelRoutes(app, {
    customModels: customModels as never,
    dynamicConfig: {
      async getOrCreateTenantSettings() {
        return settings;
      },
      async lockTenantSettings() {
        lockedReads += 1;
        await options.onLock?.();
        if (options.lockedSettings) Object.assign(settings, options.lockedSettings);
        return settings;
      },
      async updateTenantSettings(_tenantId: string, { expectedVersion, ...input }: Record<string, unknown>,
        audit?: (saved: typeof settings) => { type: string; payload: Record<string, unknown> }) {
        // Only the locked read's version may be expected.
        expect(expectedVersion).toBe(settings.version);
        settingsUpdates.push(input);
        Object.assign(settings, input);
        if (audit) settingsAudits.push(audit(settings));
        return settings;
      }
    } as never,
    auditEvents: auditEvents as unknown as AuditEventStore,
    providerKeySources: async () =>
      ({
        anthropic: "platform",
        openai: "none",
        google: "none",
        openrouter: "tenant",
        zai: "none"
      }) as Record<ModelProvider, "tenant" | "platform" | "none">,
    fetchOpenRouterCatalog: async () => {
      const catalog = options.catalog ?? OPENROUTER_CATALOG;
      if (catalog instanceof Error) throw catalog;
      return catalog;
    }
  } satisfies ModelAdminRouteStores);
  await app.ready();
  return { app, customModels, auditEvents, settingsUpdates, settingsAudits, lockedReads: () => lockedReads };
}

test("GET /admin/models merges built-ins and custom models with source flags", async () => {
  const customModels = new InMemoryCustomModels();
  await customModels.create("admin-tenant", {
    provider: "openrouter",
    vendorModelId: "moonshotai/kimi-k3",
    displayName: "Kimi K3",
    description: "",
    contextWindow: 262_144,
    createdBy: "admin-user"
  });
  const { app } = await makeApp({ customModels });
  try {
    const response = await app.inject({ method: "GET", url: "/admin/models" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const custom = body.models.find((m: { id: string }) => m.id === "openrouter/moonshotai/kimi-k3");
    expect(custom.source).toBe("custom");
    expect(custom.supportedEfforts).toEqual([]);
    expect(body.models.find((m: { id: string }) => m.id === "deepagents/claude-sonnet-5").source).toBe("builtin");
    expect(body.providers.find((p: { id: string }) => p.id === "openrouter").keySource).toBe("tenant");
  } finally {
    await app.close();
  }
});

test("GET /admin/openrouter-models returns the slim catalog, 503 when upstream fails", async () => {
  const { app } = await makeApp();
  try {
    const response = await app.inject({ method: "GET", url: "/admin/openrouter-models" });
    expect(response.statusCode).toBe(200);
    expect(response.json().models).toEqual([
      { id: "moonshotai/kimi-k3", name: "MoonshotAI: Kimi K3", contextLength: 262_144 },
      { id: "mistralai/mistral-large-3", name: "Mistral Large 3", contextLength: null }
    ]);
  } finally {
    await app.close();
  }

  const { app: failing } = await makeApp({ catalog: new Error("upstream down") });
  try {
    const response = await failing.inject({ method: "GET", url: "/admin/openrouter-models" });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe("openrouter_catalog_unavailable");
  } finally {
    await failing.close();
  }
});

test("POST /admin/custom-models validates the OpenRouter slug and auto-fills metadata", async () => {
  const { app, auditEvents } = await makeApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/admin/custom-models",
      payload: { provider: "openrouter", vendorModelId: "moonshotai/kimi-k3" }
    });
    expect(response.statusCode).toBe(200);
    const { model } = response.json();
    expect(model.id).toBe("openrouter/moonshotai/kimi-k3");
    expect(model.displayName).toBe("MoonshotAI: Kimi K3 (OpenRouter)");
    expect(model.contextWindow).toBe(262_144);
    expect(model.source).toBe("custom");
    expect(model.supportedEfforts).toEqual([]);
    expect(auditEvents.events.at(-1)?.type).toBe("admin.custom_model.created");

    const unknown = await app.inject({
      method: "POST",
      url: "/admin/custom-models",
      payload: { provider: "openrouter", vendorModelId: "nonexistent/slug" }
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toBe("unknown_openrouter_model");
  } finally {
    await app.close();
  }
});

test("POST /admin/custom-models falls back to a null context length sanely", async () => {
  const { app } = await makeApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/admin/custom-models",
      payload: { provider: "openrouter", vendorModelId: "mistralai/mistral-large-3" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().model.contextWindow).toBe(128_000);
  } finally {
    await app.close();
  }
});

test("POST /admin/custom-models rejects built-in collisions and duplicates", async () => {
  const { app } = await makeApp();
  try {
    // "openrouter/tencent/hy3" is a built-in catalog id.
    const collision = await app.inject({
      method: "POST",
      url: "/admin/custom-models",
      payload: { provider: "openrouter", vendorModelId: "tencent/hy3" }
    });
    expect(collision.statusCode).toBe(409);
    expect(collision.json().error).toBe("model_already_in_catalog");

    const first = await app.inject({
      method: "POST",
      url: "/admin/custom-models",
      payload: { provider: "openrouter", vendorModelId: "moonshotai/kimi-k3" }
    });
    expect(first.statusCode).toBe(200);
    const duplicate = await app.inject({
      method: "POST",
      url: "/admin/custom-models",
      payload: { provider: "openrouter", vendorModelId: "moonshotai/kimi-k3" }
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error).toBe("custom_model_exists");
  } finally {
    await app.close();
  }
});

test("POST /admin/custom-models requires manual metadata for non-OpenRouter providers", async () => {
  const { app } = await makeApp();
  try {
    const missing = await app.inject({
      method: "POST",
      url: "/admin/custom-models",
      payload: { provider: "openai", vendorModelId: "gpt-6-preview" }
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe("missing_model_metadata");

    const response = await app.inject({
      method: "POST",
      url: "/admin/custom-models",
      payload: {
        provider: "openai",
        vendorModelId: "gpt-6-preview",
        displayName: "GPT-6 Preview",
        contextWindow: 400_000
      }
    });
    expect(response.statusCode).toBe(200);
    const { model } = response.json();
    expect(model.id).toBe("openai/gpt-6-preview");
    expect(model.provider).toBe("openai");
  } finally {
    await app.close();
  }
});

test("POST /admin/custom-models rejects malformed vendor ids", async () => {
  const { app } = await makeApp();
  try {
    for (const vendorModelId of ["../etc/passwd", "a//b", "has space", "/leading"]) {
      const response = await app.inject({
        method: "POST",
        url: "/admin/custom-models",
        payload: { provider: "openrouter", vendorModelId }
      });
      expect(response.statusCode, vendorModelId).toBe(400);
    }
  } finally {
    await app.close();
  }
});

test("DELETE /admin/custom-models removes the model and scrubs availability references", async () => {
  const customModels = new InMemoryCustomModels();
  await customModels.create("admin-tenant", {
    provider: "openrouter",
    vendorModelId: "moonshotai/kimi-k3",
    displayName: "Kimi K3",
    description: "",
    contextWindow: 262_144,
    createdBy: "admin-user"
  });
  const settings = makeSettings({
    enabledModelIds: ["deepagents/claude-sonnet-5", "openrouter/moonshotai/kimi-k3"],
    defaultModelId: "openrouter/moonshotai/kimi-k3",
    modelDefaultEfforts: { "openrouter/moonshotai/kimi-k3": "high" }
  });
  const { app, settingsUpdates, settingsAudits, auditEvents } = await makeApp({ customModels, settings });
  try {
    const response = await app.inject({
      method: "DELETE",
      url: `/admin/custom-models?modelId=${encodeURIComponent("openrouter/moonshotai/kimi-k3")}`
    });
    expect(response.statusCode).toBe(200);
    expect(customModels.records.size).toBe(0);
    expect(response.json().settings).toEqual(settings);
    expect(settingsUpdates).toEqual([
      {
        enabledModelIds: ["deepagents/claude-sonnet-5"],
        modelDefaultEfforts: {},
        defaultModelId: null
      }
    ]);
    // The audit event is written in the delete transaction, not after it.
    expect(auditEvents.events).toHaveLength(0);
    expect(customModels.transactionQueries.at(-1)).toContain("admin.custom_model.deleted");
    // The settings change has its own audit event in the same transaction.
    expect(settingsAudits).toEqual([expect.objectContaining({
      type: "admin.tenant_settings.updated",
      payload: expect.objectContaining({ reason: "custom_model_deleted", modelId: "openrouter/moonshotai/kimi-k3",
        enabledModelIds: ["deepagents/claude-sonnet-5"], defaultModelId: null })
    })]);

    const missing = await app.inject({
      method: "DELETE",
      url: "/admin/custom-models?modelId=nope"
    });
    expect(missing.statusCode).toBe(404);
  } finally {
    await app.close();
  }
});


test("DELETE /admin/custom-models keeps the model when its audit event fails", async () => {
  const customModels = new InMemoryCustomModels();
  await customModels.create("admin-tenant", {
    provider: "openrouter", vendorModelId: "moonshotai/kimi-k3", displayName: "Kimi",
    description: "", contextWindow: 1000, createdBy: "admin-user"
  });
  customModels.failQuery = true;
  const { app } = await makeApp({ customModels });
  try {
    const response = await app.inject({ method: "DELETE", url: "/admin/custom-models?modelId=openrouter%2Fmoonshotai%2Fkimi-k3" });
    expect(response.statusCode).toBe(500);
    expect(customModels.records.has("openrouter/moonshotai/kimi-k3")).toBe(true);
  } finally {
    await app.close();
  }
});

test.each([
  { name: "last selected model", ids: ["openrouter/moonshotai/kimi-k3"], expected: null },
  { name: "explicit empty list", ids: [], expected: [] },
  { name: "unrestricted list", ids: null, expected: null },
  { name: "unrelated retired model", ids: ["openai/retired", "deepagents/claude-sonnet-5"], expected: ["deepagents/claude-sonnet-5"] },
  { name: "deleted and retired models", ids: ["openrouter/moonshotai/kimi-k3", "openai/retired"], expected: null }
])("DELETE normalizes $name and returns persisted settings", async ({ ids, expected }) => {
  const { app, customModels, settingsUpdates } = await makeApp({ settings: makeSettings({ enabledModelIds: ids }) });
  await customModels.create("admin-tenant", {
    provider: "openrouter", vendorModelId: "moonshotai/kimi-k3", displayName: "Kimi",
    description: "", contextWindow: 1000, createdBy: "admin-user"
  });
  try {
    const response = await app.inject({ method: "DELETE", url: "/admin/custom-models?modelId=openrouter%2Fmoonshotai%2Fkimi-k3" });
    expect(response.statusCode).toBe(200);
    expect(response.json().settings.enabledModelIds).toEqual(expected);
    if (ids === null || ids.length === 0) expect(settingsUpdates).toEqual([]);
    else expect(settingsUpdates).toEqual([{ enabledModelIds: expected }]);
  } finally {
    await app.close();
  }
});

test("DELETE prunes the settings read under the settings lock, not an earlier read", async () => {
  const customModels = new InMemoryCustomModels();
  await customModels.create("admin-tenant", {
    provider: "openrouter", vendorModelId: "moonshotai/kimi-k3", displayName: "Kimi",
    description: "", contextWindow: 1000, createdBy: "admin-user"
  });
  // A plain read is stale: a concurrent save enabled another built-in model.
  const { app, settingsUpdates, lockedReads } = await makeApp({
    customModels,
    settings: makeSettings({ enabledModelIds: ["openrouter/moonshotai/kimi-k3"] }),
    lockedSettings: makeSettings({
      enabledModelIds: ["openrouter/moonshotai/kimi-k3", "deepagents/claude-sonnet-5"], version: 7
    })
  });
  try {
    const response = await app.inject({ method: "DELETE", url: "/admin/custom-models?modelId=openrouter%2Fmoonshotai%2Fkimi-k3" });
    expect(response.statusCode).toBe(200);
    expect(lockedReads()).toBe(1);
    // The concurrent save is kept.
    expect(settingsUpdates).toEqual([{ enabledModelIds: ["deepagents/claude-sonnet-5"] }]);
  } finally {
    await app.close();
  }
});

test("DELETE keeps a model that was added and enabled before the settings lock", async () => {
  const customModels = new InMemoryCustomModels();
  const kimi = { provider: "openrouter" as const, vendorModelId: "moonshotai/kimi-k3", displayName: "Kimi",
    description: "", contextWindow: 1000, createdBy: "admin-user" };
  await customModels.create("admin-tenant", kimi);
  const settings = makeSettings({ enabledModelIds: ["openrouter/moonshotai/kimi-k3"] });
  const { app, settingsUpdates } = await makeApp({
    customModels,
    settings,
    // Another admin adds model B and enables it; both commit before the lock.
    onLock: async () => {
      await customModels.create("admin-tenant", { ...kimi, vendorModelId: "mistralai/mistral-large-3", displayName: "B" });
      settings.enabledModelIds = ["openrouter/moonshotai/kimi-k3", "openrouter/mistralai/mistral-large-3"];
    }
  });
  try {
    const response = await app.inject({ method: "DELETE", url: "/admin/custom-models?modelId=openrouter%2Fmoonshotai%2Fkimi-k3" });
    expect(response.statusCode).toBe(200);
    // B is in the catalog read under the lock, so it stays enabled.
    expect(settingsUpdates).toEqual([{ enabledModelIds: ["openrouter/mistralai/mistral-large-3"] }]);
  } finally {
    await app.close();
  }
});
