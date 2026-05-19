import { test, expect, onTestFinished } from "vitest";

import Fastify from "fastify";

import { decrypt } from "../../lib/crypto-utils.js";
import type { Pool } from "../../lib/db.js";
import type { AppConfig } from "../../config.js";
import {
  IntegrationRegistryService,
  type IntegrationConnectionProbes
} from "../../services/integrations/integration-registry-service.js";
import {
  getIntegrationDescriptor,
  registerIntegration,
  type IntegrationConnectionProbe
} from "../../services/integrations/integration-registry.js";
import { registerBuiltinIntegrations } from "../../services/integrations/register-builtin-integrations.js";
import type {
  IntegrationStateRecord,
  IntegrationStateStore
} from "../../services/integrations/integration-state-store.js";
import { FakeDatabase } from "../../test-helpers/fake-database.js";

registerBuiltinIntegrations();
// Microsoft 365 ships from the SharePoint private overlay package — its
// descriptor is not registered by `registerBuiltinIntegrations` in core.
// The admin-integration tests below use Microsoft as a worked example for
// CRUD on `tenant_integrations` rows, so register the descriptor here.
if (!getIntegrationDescriptor("microsoft")) {
  registerIntegration({
    id: "microsoft",
    name: "Microsoft 365",
    description: "",
    longDescription: "",
    logoSlug: "microsoft",
    status: "available",
    category: "Productivity",
    readToolIds: [
      "sharepoint_list_sites",
      "sharepoint_list_files",
      "sharepoint_read_file",
      "sharepoint_search"
    ],
    writeToolIds: [
      "sharepoint_upload_file",
      "sharepoint_create_folder",
      "sharepoint_import_file_to_session"
    ],
    configMode: "oauth_app",
    configFields: [
      { key: "clientId", label: "Application (client) ID", type: "text", required: true },
      { key: "clientSecret", label: "Client secret", type: "password", required: true },
      { key: "entraTenantId", label: "Directory (tenant) ID", type: "text", required: true }
    ],
    platformStatus: () => ({ configured: true, message: null })
  });
}
import { InMemoryAuditEventStore } from "../../test-helpers/in-memory-audit-events.js";
import { createTestConfig } from "../../test-helpers/test-config.js";

import { registerAdminIntegrationsRoutes } from "./admin-integrations-routes.js";

class FakeStateStore implements Pick<IntegrationStateStore, "list" | "get" | "upsert" | "clearConfig"> {
  records: IntegrationStateRecord[] = [];
  upsertCalls: Array<{
    tenantId: string;
    integrationId: string;
    patch: Parameters<IntegrationStateStore["upsert"]>[2];
  }> = [];

  async list(tenantId: string): Promise<IntegrationStateRecord[]> {
    return this.records.filter((r) => r.tenantId === tenantId);
  }

  async get(tenantId: string, integrationId: string): Promise<IntegrationStateRecord | null> {
    return (
      this.records.find((r) => r.tenantId === tenantId && r.integrationId === integrationId) ?? null
    );
  }

  async upsert(
    tenantId: string,
    integrationId: string,
    patch: Parameters<IntegrationStateStore["upsert"]>[2]
  ): Promise<IntegrationStateRecord> {
    this.upsertCalls.push({ tenantId, integrationId, patch });
    const existingIdx = this.records.findIndex(
      (r) => r.tenantId === tenantId && r.integrationId === integrationId
    );
    const existing = existingIdx >= 0 ? this.records[existingIdx] : null;
    const next: IntegrationStateRecord = {
      tenantId,
      integrationId,
      readsEnabled: patch.readsEnabled ?? existing?.readsEnabled ?? false,
      writesEnabled: patch.writesEnabled ?? existing?.writesEnabled ?? false,
      config: patch.config ?? existing?.config ?? {},
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      updatedBy: patch.updatedBy === undefined ? existing?.updatedBy ?? null : patch.updatedBy
    };
    if (existingIdx >= 0) this.records[existingIdx] = next;
    else this.records.push(next);
    return next;
  }

  async clearConfig(
    tenantId: string,
    integrationId: string,
    updatedBy: string | null
  ): Promise<IntegrationStateRecord> {
    return this.upsert(tenantId, integrationId, {
      readsEnabled: false,
      writesEnabled: false,
      config: {},
      updatedBy
    });
  }
}

class FakeRuntimeManager {
  invalidations: Array<{ tenantId: string; integrationId: string }> = [];

  async invalidateIntegrationRuntimesForTenant(
    tenantId: string,
    integrationId: string
  ): Promise<string[]> {
    this.invalidations.push({ tenantId, integrationId });
    return ["session-1"];
  }
}

class FakeClaudeAdapter {
  invalidations: Array<{ tenantId: string; integrationId: string }> = [];

  async invalidateIntegrationRuntimesForTenant(
    tenantId: string,
    integrationId: string
  ): Promise<string[]> {
    this.invalidations.push({ tenantId, integrationId });
    return ["claude-session-1"];
  }
}

function probe(connected: boolean): IntegrationConnectionProbe {
  return { async hasConnection() { return connected; } };
}

function buildProbes(): IntegrationConnectionProbes {
  return {
    notion: probe(true),
    microsoft: probe(true),
    github: probe(true)
  };
}

async function buildApp(opts: {
  config?: Partial<AppConfig>;
  states?: IntegrationStateRecord[];
  withClaude?: boolean;
}) {
  const app = Fastify();
  const config = createTestConfig({
    NOTION_OAUTH_CLIENT_ID: "client",
    NOTION_OAUTH_CLIENT_SECRET: "secret",
    NOTION_OAUTH_REDIRECT_URI: "https://example.com/notion/callback",
    ...(opts.config ?? {})
  });
  app.decorate("config", config);
  app.decorate("db", new FakeDatabase() as unknown as Pool);
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: "admin-user",
      tenantId: "tenant-1",
      isAdmin: true,
      role: "owner" as const
    };
  });

  const stateStore = new FakeStateStore();
  if (opts.states) stateStore.records = [...opts.states];

  const registry = new IntegrationRegistryService(config, stateStore, buildProbes());
  const runtime = new FakeRuntimeManager();
  const claudeAdapter = opts.withClaude ? new FakeClaudeAdapter() : undefined;
  const auditEvents = new InMemoryAuditEventStore();

  const runtimeAdapters: Record<string, { invalidateIntegrationRuntimesForTenant?: (tenantId: string, integrationId: string) => Promise<string[]> }> = {
    codex: runtime
  };
  if (claudeAdapter) runtimeAdapters["claude-code"] = claudeAdapter;

  await registerAdminIntegrationsRoutes(app, {
    config,
    integrationRegistry: registry,
    integrationStates: stateStore,
    auditEvents,
    runtimeAdapters: runtimeAdapters as never
  });
  await app.ready();

  return { app, stateStore, runtime, claudeAdapter, auditEvents, config };
}

test("GET /admin/integrations returns the registry with per-tenant state", async () => {
  const { app, stateStore } = await buildApp({
    states: [
      {
        tenantId: "tenant-1",
        integrationId: "notion",
        readsEnabled: true,
        writesEnabled: false,
        config: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        updatedBy: "admin-user"
      }
    ]
  });
  onTestFinished(() => app.close());
  void stateStore;

  const response = await app.inject({ method: "GET", url: "/admin/integrations" });
  expect(response.statusCode).toBe(200);

  const body = response.json() as { integrations: Array<{ id: string; readsEnabled: boolean }> };
  const notion = body.integrations.find((i) => i.id === "notion");
  expect(notion).toBeTruthy();
  expect(notion!.readsEnabled).toBe(true);
  // Ensure coming-soon entries are present (admin can see roadmap).
  expect(body.integrations.find((i) => i.id === "linear")).toBeTruthy();
});

test("PUT /admin/integrations/:id flips toggles, audits, and invalidates runtimes", async () => {
  const { app, stateStore, runtime, auditEvents } = await buildApp({});
  onTestFinished(() => app.close());

  const response = await app.inject({
    method: "PUT",
    url: "/admin/integrations/notion",
    payload: { readsEnabled: true }
  });
  expect(response.statusCode).toBe(200);

  // State persisted.
  const notion = stateStore.records.find((r) => r.integrationId === "notion");
  expect(notion).toBeTruthy();
  expect(notion!.readsEnabled).toBe(true);
  expect(notion!.updatedBy).toBe("admin-user");

  // Audit + runtime invalidation triggered (since toggles changed).
  expect(runtime.invalidations.length).toBe(1);
  expect(runtime.invalidations[0].integrationId).toBe("notion");

  const updateEvents = auditEvents.events.filter((e) => e.type === "tenant.integration.updated");
  expect(updateEvents.length).toBe(1);
  expect((updateEvents[0].payload as { integrationId: string }).integrationId).toBe("notion");
});

test("PUT /admin/integrations/:id rejects toggle-on without required oauth_app config", async () => {
  const { app, stateStore } = await buildApp({});
  onTestFinished(() => app.close());

  const response = await app.inject({
    method: "PUT",
    url: "/admin/integrations/microsoft",
    payload: { readsEnabled: true }
  });
  expect(response.statusCode).toBe(400);
  const body = response.json() as { error: string };
  expect(body.error).toBe("integration_config_required");
  // Nothing persisted.
  expect(stateStore.upsertCalls.length).toBe(0);
});

test("PUT /admin/integrations/:id encrypts password fields and stores plain-text fields", async () => {
  const { app, stateStore, config } = await buildApp({});
  onTestFinished(() => app.close());

  const response = await app.inject({
    method: "PUT",
    url: "/admin/integrations/microsoft",
    payload: {
      config: {
        clientId: "abc",
        clientSecret: "super-secret",
        entraTenantId: "xyz"
      }
    }
  });
  expect(response.statusCode).toBe(200);

  const ms = stateStore.records.find((r) => r.integrationId === "microsoft");
  expect(ms).toBeTruthy();
  expect(ms!.config.clientId).toBe("abc");
  expect(ms!.config.entraTenantId).toBe("xyz");
  // clientSecret must NOT be the raw value.
  const storedSecret = ms!.config.clientSecret;
  expect(typeof storedSecret).toBe("string");
  expect(storedSecret).not.toBe("super-secret");
  // Round-trips through decrypt.
  expect(decrypt(storedSecret as string, config.DATA_ENCRYPTION_SECRET)).toBe("super-secret");
});

test("PUT /admin/integrations/:id with empty password preserves existing encrypted secret", async () => {
  const { app, stateStore, config } = await buildApp({
    states: [
      {
        tenantId: "tenant-1",
        integrationId: "microsoft",
        readsEnabled: false,
        writesEnabled: false,
        config: {
          clientId: "abc",
          clientSecret: "ENCRYPTED_BLOB_PLACEHOLDER",
          entraTenantId: "xyz"
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        updatedBy: "admin-user"
      }
    ]
  });
  onTestFinished(() => app.close());
  void config;

  const response = await app.inject({
    method: "PUT",
    url: "/admin/integrations/microsoft",
    payload: {
      config: {
        clientId: "new-id",
        clientSecret: "" // unchanged sentinel
      }
    }
  });
  expect(response.statusCode).toBe(200);

  const ms = stateStore.records.find((r) => r.integrationId === "microsoft");
  expect(ms).toBeTruthy();
  expect(ms!.config.clientId).toBe("new-id");
  expect(ms!.config.clientSecret).toBe("ENCRYPTED_BLOB_PLACEHOLDER");
  expect(ms!.config.entraTenantId).toBe("xyz");
});

test("PUT /admin/integrations/:id rejects coming-soon integrations", async () => {
  const { app } = await buildApp({});
  onTestFinished(() => app.close());

  const response = await app.inject({
    method: "PUT",
    url: "/admin/integrations/linear",
    payload: { readsEnabled: true }
  });
  expect(response.statusCode).toBe(400);
  const body = response.json() as { error: string };
  expect(body.error).toBe("integration_unavailable");
});

test("PUT /admin/integrations/:id 404s for unknown integration ids", async () => {
  const { app } = await buildApp({});
  onTestFinished(() => app.close());

  const response = await app.inject({
    method: "PUT",
    url: "/admin/integrations/nonexistent",
    payload: { readsEnabled: true }
  });
  expect(response.statusCode).toBe(404);
});

test("PUT /admin/integrations/:id does not invalidate runtimes when toggles are unchanged", async () => {
  const { app, runtime } = await buildApp({
    states: [
      {
        tenantId: "tenant-1",
        integrationId: "notion",
        readsEnabled: true,
        writesEnabled: false,
        config: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        updatedBy: "admin-user"
      }
    ]
  });
  onTestFinished(() => app.close());

  // Re-submit identical toggle state (no-op).
  const response = await app.inject({
    method: "PUT",
    url: "/admin/integrations/notion",
    payload: { readsEnabled: true, writesEnabled: false }
  });
  expect(response.statusCode).toBe(200);
  expect(runtime.invalidations.length).toBe(0);
});

test("DELETE /admin/integrations/:id/config clears state and invalidates runtimes", async () => {
  const { app, stateStore, runtime, auditEvents } = await buildApp({
    states: [
      {
        tenantId: "tenant-1",
        integrationId: "microsoft",
        readsEnabled: true,
        writesEnabled: true,
        config: { clientId: "abc", clientSecret: "blob", entraTenantId: "xyz" },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        updatedBy: "admin-user"
      }
    ]
  });
  onTestFinished(() => app.close());

  const response = await app.inject({
    method: "DELETE",
    url: "/admin/integrations/microsoft/config"
  });
  expect(response.statusCode).toBe(200);

  const ms = stateStore.records.find((r) => r.integrationId === "microsoft");
  expect(ms).toBeTruthy();
  expect(ms!.readsEnabled).toBe(false);
  expect(ms!.writesEnabled).toBe(false);
  expect(ms!.config).toEqual({});

  expect(runtime.invalidations.length).toBe(1);
  const cleared = auditEvents.events.find((e) => e.type === "tenant.integration.config_cleared");
  expect(cleared).toBeTruthy();
});

test("non-admin requests are rejected with 403", async () => {
  const app = Fastify();
  onTestFinished(() => app.close());
  const config = createTestConfig({});
  app.decorate("config", config);
  app.decorate("db", new FakeDatabase() as unknown as Pool);
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: "regular-user",
      tenantId: "tenant-1",
      isAdmin: false,
      role: "member" as const
    };
  });

  const stateStore = new FakeStateStore();
  const registry = new IntegrationRegistryService(config, stateStore, buildProbes());
  await registerAdminIntegrationsRoutes(app, {
    config,
    integrationRegistry: registry,
    integrationStates: stateStore,
    auditEvents: new InMemoryAuditEventStore(),
    runtimeAdapters: { codex: new FakeRuntimeManager() } as never
  });
  await app.ready();

  const response = await app.inject({ method: "GET", url: "/admin/integrations" });
  expect(response.statusCode).toBe(403);
});

test("PUT /admin/integrations/github enables under configMode=none (no per-tenant config required)", async () => {
  const { app, stateStore } = await buildApp({
    config: {
      GITHUB_OAUTH_CLIENT_ID: "client",
      GITHUB_OAUTH_CLIENT_SECRET: "secret",
      GITHUB_OAUTH_REDIRECT_URI: "https://example.com/gh/cb"
    }
  });
  onTestFinished(() => app.close());

  const response = await app.inject({
    method: "PUT",
    url: "/admin/integrations/github",
    payload: { readsEnabled: true }
  });
  expect(response.statusCode).toBe(200);

  const gh = stateStore.records.find((r) => r.integrationId === "github");
  expect(gh).toBeTruthy();
  expect(gh!.readsEnabled).toBe(true);
});

test("GET /admin/integrations reports github hasConfig=true (configMode=none)", async () => {
  const { app } = await buildApp({
    config: {
      GITHUB_OAUTH_CLIENT_ID: "client",
      GITHUB_OAUTH_CLIENT_SECRET: "secret",
      GITHUB_OAUTH_REDIRECT_URI: "https://example.com/gh/cb"
    }
  });
  onTestFinished(() => app.close());

  const response = await app.inject({ method: "GET", url: "/admin/integrations" });
  const body = response.json() as { integrations: Array<{ id: string; hasConfig: boolean; platformConfigured: boolean }> };
  const gh = body.integrations.find((i) => i.id === "github");
  expect(gh).toBeTruthy();
  expect(gh!.hasConfig).toBe(true);
  expect(gh!.platformConfigured).toBe(true);
});

test("GET /admin/integrations reports github platform unconfigured when env vars are missing", async () => {
  const { app } = await buildApp({});
  onTestFinished(() => app.close());

  const response = await app.inject({ method: "GET", url: "/admin/integrations" });
  const body = response.json() as {
    integrations: Array<{ id: string; platformConfigured: boolean; platformConfigMessage: string | null }>;
  };
  const gh = body.integrations.find((i) => i.id === "github")!;
  expect(gh.platformConfigured).toBe(false);
  expect(gh.platformConfigMessage?.includes("GITHUB_OAUTH_CLIENT_ID")).toBeTruthy();
});

test("toggle changes also invalidate Claude sessions when the adapter is wired", async () => {
  const { app, runtime, claudeAdapter } = await buildApp({ withClaude: true });
  onTestFinished(() => app.close());

  const response = await app.inject({
    method: "PUT",
    url: "/admin/integrations/notion",
    payload: { readsEnabled: true }
  });
  expect(response.statusCode).toBe(200);
  expect(runtime.invalidations.length).toBe(1);
  expect(claudeAdapter!.invalidations.length).toBe(1);
  expect(claudeAdapter!.invalidations[0].integrationId).toBe("notion");
});

test("DELETE /admin/integrations/microsoft/config clears the integration row", async () => {
  const { app, stateStore } = await buildApp({
    states: [
      {
        tenantId: "tenant-1",
        integrationId: "microsoft",
        readsEnabled: true,
        writesEnabled: false,
        config: { clientId: "abc", clientSecret: "blob", entraTenantId: "xyz" },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        updatedBy: "admin-user"
      }
    ]
  });
  onTestFinished(() => app.close());

  const response = await app.inject({
    method: "DELETE",
    url: "/admin/integrations/microsoft/config"
  });
  expect(response.statusCode).toBe(200);
  const row = stateStore.records.find((r) => r.integrationId === "microsoft");
  expect(row).toBeTruthy();
  expect(row!.config).toEqual({});
  expect(row!.readsEnabled).toBe(false);
  expect(row!.writesEnabled).toBe(false);
});
