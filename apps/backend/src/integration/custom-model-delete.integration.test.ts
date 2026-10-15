import Fastify from "fastify";
import { describe, expect, onTestFinished, test } from "vitest";

import { registerAdminModelRoutes, type ModelAdminRouteStores } from "../routes/admin/admin-model-routes.js";
import { AuditEventStore } from "../services/audit-event-store.js";
import { CustomModelStore } from "../services/custom-model-store.js";
import { DynamicConfigService } from "../services/dynamic-config-service.js";
import { ManagedToolCatalog } from "../services/managed-tools/catalog.js";
import { TenantSettingsStore } from "../services/tenant-settings-store.js";
import { createTestConfig } from "../test-helpers/test-config.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedTenantGraph } from "./support/fixtures.js";

const KIMI = "openrouter/moonshotai/kimi-k3";

async function setup(options: { failSettingsWrite?: boolean } = {}) {
  const owner = await seedTenantGraph();
  const customModels = new CustomModelStore(appPool());
  const tenantSettings = new TenantSettingsStore(appPool());
  // Model fields need only the settings store; tool and server references are not touched.
  const dynamicConfig = new DynamicConfigService(createTestConfig(), { tenantSettings } as never,
    {} as never, new ManagedToolCatalog());
  await customModels.create(owner.tenantId, { provider: "openrouter", vendorModelId: "moonshotai/kimi-k3",
    displayName: "Kimi", description: "", contextWindow: 1000, createdBy: owner.userId });
  await tenantSettings.upsert(owner.tenantId, { enabledModelIds: [KIMI, "deepagents/claude-sonnet-5"], defaultModelId: KIMI });

  const app = Fastify();
  onTestFinished(() => app.close());
  app.decorate("db", appPool());
  app.addHook("preHandler", async (request) => {
    request.auth = { userId: owner.userId, tenantId: owner.tenantId, isAdmin: true, role: "owner" };
  });
  await registerAdminModelRoutes(app, {
    customModels,
    dynamicConfig: options.failSettingsWrite ? {
      getOrCreateTenantSettings: (tenantId) => dynamicConfig.getOrCreateTenantSettings(tenantId),
      lockTenantSettings: (tenantId, client) => dynamicConfig.lockTenantSettings(tenantId, client),
      async updateTenantSettings(...args) {
        await dynamicConfig.updateTenantSettings(...args);
        throw new Error("settings write failed after the audit");
      }
    } : dynamicConfig,
    auditEvents: new AuditEventStore(appPool()),
    providerKeySources: async () => ({ anthropic: "none", openai: "none", google: "none", openrouter: "tenant", zai: "none" }),
    fetchOpenRouterCatalog: async () => []
  } satisfies ModelAdminRouteStores);
  await app.ready();
  const state = async () => ({
    models: (await customModels.list(owner.tenantId)).map((model) => model.modelId),
    settings: await tenantSettings.get(owner.tenantId),
    audits: (await superuserPool().query<{ event_type: string }>(
      "SELECT event_type FROM audit_events WHERE tenant_id = $1 ORDER BY event_type", [owner.tenantId])).rows
      .map((row) => row.event_type)
  });
  return { app, state };
}

describe.skipIf(!adminDatabaseUrl())("custom model deletion", () => {
  test("deletes the model, prunes the settings and writes both audit events together", async () => {
    const { app, state } = await setup();

    const response = await app.inject({ method: "DELETE", url: `/admin/custom-models?modelId=${encodeURIComponent(KIMI)}` });

    expect(response.statusCode).toBe(200);
    const after = await state();
    expect(after.models).toEqual([]);
    expect(after.settings).toMatchObject({ enabledModelIds: ["deepagents/claude-sonnet-5"], defaultModelId: null });
    expect(after.audits).toEqual(["admin.custom_model.deleted", "admin.tenant_settings.updated"]);
  });

  test("a failure after the settings write rolls the deletion, the settings and the audits back", async () => {
    const { app, state } = await setup({ failSettingsWrite: true });
    const before = await state();

    const response = await app.inject({ method: "DELETE", url: `/admin/custom-models?modelId=${encodeURIComponent(KIMI)}` });

    expect(response.statusCode).toBe(500);
    expect(await state()).toEqual(before);
  });
});
