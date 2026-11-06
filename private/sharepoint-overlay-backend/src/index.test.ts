import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Fastify, { type FastifyInstance } from "fastify";

import type { Pool } from "../../../apps/backend/src/lib/db.js";
import type { AttachOverlaysInput, OverlayBootstrap, OverlayHandles } from "../../../apps/backend/src/overlay-contracts.js";
import type { IntegrationStateRecord } from "../../../apps/backend/src/services/integrations/integration-state-store.js";
import {
  __resetIntegrationRegistryForTesting,
  getIntegrationDescriptor,
  IntegrationRegistry
} from "../../../apps/backend/src/services/integrations/integration-registry.js";
import { ManagedToolCatalog } from "../../../apps/backend/src/services/managed-tools/catalog.js";
import {
  ManagedToolFactoryRegistry,
  type ManagedToolFactoryDeps
} from "../../../apps/backend/src/services/managed-tools/factory.js";
import { devDataRoutes } from "../../../apps/backend/src/test-helpers/data-routes.js";
import { createTestConfig } from "../../../apps/backend/src/test-helpers/test-config.js";

import { bootstrap } from "./index.js";
import { SHAREPOINT_TOOL_CATALOG } from "./managed-tools/sharepoint-tools.js";
import { PiiImportScopeRegistry } from "../../../apps/backend/src/services/pii/pii-import-scopes.js";

// Compile-time check: the overlay entrypoint implements the core contract.
const contractBootstrap: OverlayBootstrap = bootstrap;

const TENANT_ID = "tenant-1";
const USER_ID = "user-1";
const MICROSOFT_TENANT_CONFIG = {
  clientId: "client-id",
  clientSecret: "encrypted-secret",
  entraTenantId: "contoso.onmicrosoft.com"
};

// Answers every query with no rows, so no Microsoft user connection exists.
function emptyPool(): Pool {
  const client = { query: async () => ({ rows: [] }), release: () => {} };
  return { connect: async () => client, query: async () => ({ rows: [] }) } as unknown as Pool;
}

function integrationState(config: Record<string, unknown>): IntegrationStateRecord {
  return {
    tenantId: TENANT_ID,
    integrationId: "microsoft",
    readsEnabled: true,
    writesEnabled: false,
    config,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    updatedBy: null
  };
}

type TestApp = {
  input: AttachOverlaysInput;
  registry: IntegrationRegistry;
  catalog: ManagedToolCatalog;
  factories: ManagedToolFactoryRegistry;
  piiImportScopes: PiiImportScopeRegistry;
};

// Mirrors `buildAppDependencies`: the app registry snapshots the static
// catalog before the overlay bootstraps.
function buildTestApp(microsoftConfig: Record<string, unknown> | null): TestApp {
  const registry = new IntegrationRegistry();
  const catalog = new ManagedToolCatalog();
  const factories = new ManagedToolFactoryRegistry();
  const piiImportScopes = new PiiImportScopeRegistry();
  const input: AttachOverlaysInput = {
    config: createTestConfig(),
    db: emptyPool(),
    uploadAdmission: { begin: vi.fn(), admit: vi.fn() },
    stores: {
      auditEvents: { create: vi.fn() },
      integrationStates: {
        get: vi.fn(async () => (microsoftConfig ? integrationState(microsoftConfig) : null)),
        upsert: vi.fn()
      }
    },
    integrationDescriptors: registry,
    loadIntegrationEnablement: vi.fn(async () => ({
      tenantEnabled: true,
      tenantReadsEnabled: true,
      tenantWritesEnabled: false,
      platformConfigured: true
    })),
    oauthStates: { issue: vi.fn(), consume: vi.fn() },
    runtimeInvalidator: { invalidateRuntimesForIntegration: vi.fn(async () => []), invalidateTenantRuntimes: vi.fn(async () => []) },
    managedToolCatalog: catalog,
    managedToolFactoryRegistry: factories,
    piiImportScopes
  };
  return { input, registry, catalog, factories, piiImportScopes };
}

// Serves the overlay routes as a member of the test tenant.
async function serveOverlayRoutes(handles: OverlayHandles): Promise<FastifyInstance> {
  const server = Fastify();
  server.decorate("db", emptyPool() as never);
  server.addHook("preHandler", async (request) => {
    request.auth = { userId: USER_ID, tenantId: TENANT_ID, isAdmin: false, role: "member" };
  });
  handles.attachRoutes(server, { dataRoutes: devDataRoutes() });
  await server.ready();
  return server;
}

describe("SharePoint overlay bootstrap", () => {
  const originalRedirectUri = process.env.MICROSOFT_OAUTH_REDIRECT_URI;

  beforeEach(() => {
    __resetIntegrationRegistryForTesting();
    process.env.MICROSOFT_OAUTH_REDIRECT_URI = "https://api.example.com/integrations/microsoft/callback";
  });

  afterEach(() => {
    if (originalRedirectUri === undefined) delete process.env.MICROSOFT_OAUTH_REDIRECT_URI;
    else process.env.MICROSOFT_OAUTH_REDIRECT_URI = originalRedirectUri;
    __resetIntegrationRegistryForTesting();
  });

  it("registers the Microsoft import PII scope with the stored names", () => {
    const app = buildTestApp(null);
    contractBootstrap(app.input);
    expect(app.piiImportScopes.list()).toEqual([
      { subjectKind: "microsoft_import", scopeKey: "microsoftImports", defaultOn: true }
    ]);
  });

  it("registers the static descriptor and attaches live hooks to the app registry", () => {
    const app = buildTestApp(null);
    expect(app.registry.get("microsoft")).toBeNull();

    contractBootstrap(app.input);

    expect(getIntegrationDescriptor("microsoft")?.connectionProbe).toBeUndefined();
    const descriptor = app.registry.get("microsoft");
    expect(descriptor?.connectionProbe).toBeDefined();
    expect(descriptor?.oauthRoutes?.paths).toEqual(["/integrations/microsoft/callback"]);
    expect(app.registry.oauthCallbackPaths()).toContain("/integrations/microsoft/callback");
  });

  it("registers integration-gated catalog entries and the sharepoint factory", () => {
    const app = buildTestApp(null);
    bootstrap(app.input);

    const toolNames = SHAREPOINT_TOOL_CATALOG.map((entry) => entry.name);
    expect(app.catalog.listIds()).toEqual(toolNames);
    for (const name of toolNames) {
      expect(app.catalog.get(name)).toMatchObject({ tenantConfigurable: false, category: "sharepoint" });
    }
    expect(app.catalog.listTenantConfigurable()).toEqual([]);

    const definitions = app.factories.createDefinitions({
      storage: { put: vi.fn(), openReadStream: vi.fn(), delete: vi.fn() }
    } as unknown as ManagedToolFactoryDeps);
    expect(definitions.map((definition) => definition.name).sort()).toEqual([...toolNames].sort());
    expect(new Set(definitions.map((definition) => definition.category))).toEqual(new Set(["sharepoint"]));
    // The graph evaluates Policy Center with the catalog category and the
    // gateway with the definition category. They must agree for every tool.
    for (const definition of definitions) {
      expect(app.catalog.get(definition.name)?.category, definition.name).toBe(definition.category);
    }
  });

  it("attaches settings, tenant, and file routes, and uses the enablement capability", async () => {
    const app = buildTestApp(MICROSOFT_TENANT_CONFIG);
    const server = await serveOverlayRoutes(bootstrap(app.input));

    for (const [method, url] of [
      ["GET", "/me/microsoft-connection"],
      ["POST", "/me/microsoft-connection/authorize"],
      ["DELETE", "/me/microsoft-connection"],
      ["PUT", "/tenant/settings/microsoft"],
      ["DELETE", "/tenant/settings/microsoft"],
      ["GET", "/integrations/microsoft/sites"],
      ["GET", "/integrations/microsoft/files"],
      ["GET", "/integrations/microsoft/files/search"],
      ["POST", "/sessions/:sessionId/import-microsoft-file"]
    ] as const) {
      expect(server.hasRoute({ method, url }), `${method} ${url}`).toBe(true);
    }
    // Core registers OAuth callbacks from the app registry, not attachRoutes.
    expect(server.hasRoute({ method: "GET", url: "/integrations/microsoft/callback" })).toBe(false);

    const response = await server.inject({ method: "GET", url: "/me/microsoft-connection" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      configured: true,
      userConnection: null,
      tenantEnabled: true,
      platformConfigured: true
    });
    expect(app.input.loadIntegrationEnablement).toHaveBeenCalledWith(TENANT_ID, "microsoft");
    await server.close();
  });

  it("keeps hooks and handles separate for two apps in one process", async () => {
    const first = buildTestApp(MICROSOFT_TENANT_CONFIG);
    const firstHandles = bootstrap(first.input);
    // The second app snapshots the catalog after the first bootstrap.
    const second = buildTestApp(null);
    expect(second.registry.get("microsoft")?.connectionProbe).toBeUndefined();
    const secondHandles = bootstrap(second.input);

    const firstProbe = first.registry.get("microsoft")?.connectionProbe;
    const secondProbe = second.registry.get("microsoft")?.connectionProbe;
    expect(firstProbe).toBeDefined();
    expect(secondProbe).toBeDefined();
    expect(secondProbe).not.toBe(firstProbe);
    expect(second.catalog.listIds()).toEqual(first.catalog.listIds());

    // Each app's routes read the tenant configuration from that app's store.
    const firstServer = await serveOverlayRoutes(firstHandles);
    const secondServer = await serveOverlayRoutes(secondHandles);
    const firstStatus = await firstServer.inject({ method: "GET", url: "/me/microsoft-connection" });
    const secondStatus = await secondServer.inject({ method: "GET", url: "/me/microsoft-connection" });
    expect(firstStatus.json()).toMatchObject({ configured: true });
    expect(secondStatus.json()).toMatchObject({ configured: false });
    expect(first.input.stores.integrationStates.get).toHaveBeenCalled();
    expect(second.input.stores.integrationStates.get).toHaveBeenCalled();
    await firstServer.close();
    await secondServer.close();
  });
});
