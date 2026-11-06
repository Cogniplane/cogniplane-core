import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { IntegrationRegistryService } from "./integration-registry-service.js";
import { createTestConfig } from "../../test-helpers/test-config.js";
import { test, expect } from "vitest";

import { Pool } from "../../lib/db.js";
import type { BuiltinConnectorInput } from "../connectors/connector-module.js";
import { registerConnectorIntegration } from "../connectors/connector-module.js";
import { ManagedToolCatalog } from "../managed-tools/catalog.js";
import { ManagedToolFactoryRegistry } from "../managed-tools/factory.js";
import { GITHUB_INTEGRATION_DESCRIPTOR, attachGithubConnector } from "./github/github-connector.js";
import { registerGithubOAuthRoutes } from "./github/github-oauth-routes.js";
import { IntegrationOAuthStateStore } from "./integration-oauth-state-store.js";
import {
  IntegrationRegistry,
  __resetIntegrationRegistryForTesting,
  getIntegrationDescriptor,
  listIntegrationDescriptors,
  listIntegrationOAuthCallbackPaths
} from "./integration-registry.js";
import { JIRA_INTEGRATION_DESCRIPTOR } from "./pipedream/jira-connector.js";
import { registerBuiltinIntegrations } from "./register-builtin-integrations.js";
import { PiiImportScopeRegistry } from "../pii/pii-import-scopes.js";

function fakeOAuthHandler(label: string) {
  return {
    label,
    async completeAuthorization(): Promise<string> {
      return `/done?label=${label}`;
    }
  };
}

function connectorInput(
  integrationDescriptors: IntegrationRegistry,
  managedToolCatalog = new ManagedToolCatalog()
): BuiltinConnectorInput {
  return {
    config: createTestConfig(),
    logger: { warn() {} },
    db: new Pool(),
    uploadAdmission: {
      async begin() { throw new Error("unexpected upload"); },
      async admit() { throw new Error("unexpected upload"); }
    },
    stores: {
      auditEvents: { async create() {} },
      integrationStates: { async get() { return null; }, async upsert() { throw new Error("unexpected write"); } }
    },
    integrationDescriptors,
    loadIntegrationEnablement: async () => {
      throw new Error("unexpected enablement read");
    },
    oauthStates: new IntegrationOAuthStateStore(),
    runtimeInvalidator: {
      async invalidateRuntimesForIntegration() { return []; },
      async invalidateTenantRuntimes() { return []; }
    },
    managedToolCatalog,
    managedToolFactoryRegistry: new ManagedToolFactoryRegistry(),
    piiImportScopes: new PiiImportScopeRegistry()
  };
}

test("the static catalog keeps its order, holds no app services, and allows a second call", () => {
  __resetIntegrationRegistryForTesting();

  registerBuiltinIntegrations();
  // A second call must not throw "Integration already registered".
  registerBuiltinIntegrations();

  expect(listIntegrationDescriptors().map((descriptor) => descriptor.id)).toEqual([
    "notion", "github", "jira",
    "linear", "slack", "confluence", "asana", "salesforce", "hubspot", "google-drive", "gmail", "google-calendar"
  ]);
  const github = getIntegrationDescriptor("github");
  expect(github?.connectionProbe).toBeUndefined();
  expect(github?.oauthRoutes).toBeUndefined();
  // Microsoft 365 ships from the SharePoint private overlay package and is
  // not registered by `registerBuiltinIntegrations`.
  expect(getIntegrationDescriptor("microsoft")).toBe(null);

  const callbackPaths = listIntegrationOAuthCallbackPaths();
  expect(callbackPaths).toContain("/auth/github/user/callback");
  expect(callbackPaths).toContain("/integrations/notion/callback");
  expect(callbackPaths).not.toContain("/auth/github/install/callback");
});

test("a connector module registers its descriptor once and attaches hooks to its own app", () => {
  __resetIntegrationRegistryForTesting();
  // An app registry that took its snapshot before the static catalog had GitHub.
  const registry = new IntegrationRegistry();
  const catalog = new ManagedToolCatalog();

  const handles = attachGithubConnector(connectorInput(registry, catalog));

  expect(getIntegrationDescriptor("github")?.connectionProbe).toBeUndefined();
  const github = registry.get("github");
  expect(github?.connectionProbe).toBe(handles.services.connections);
  expect(github?.oauthRoutes?.paths).toEqual(["/auth/github/user/callback"]);
  expect(registry.oauthCallbackPaths()).toEqual(["/auth/github/user/callback"]);

  // The tools are integration-gated and use the factory key as the Policy
  // Center category.
  expect(catalog.listIds()).toEqual(["github_read_file", "github_write_file", "github_create_pr"]);
  for (const id of catalog.listIds()) {
    expect(catalog.get(id)).toMatchObject({ tenantConfigurable: false, category: "github" });
  }

  // A second app in the same process: no duplicate registration error.
  const secondRegistry = new IntegrationRegistry();
  const second = attachGithubConnector(connectorInput(secondRegistry));
  expect(secondRegistry.get("github")?.connectionProbe).toBe(second.services.connections);
  expect(second.services.connections).not.toBe(handles.services.connections);
  expect(registry.get("github")?.connectionProbe).toBe(handles.services.connections);
});

test("independent apps retain their own probes and OAuth handlers", async () => {
  registerBuiltinIntegrations();
  const firstRegistry = new IntegrationRegistry();
  const secondRegistry = new IntegrationRegistry();
  const firstOAuth = fakeOAuthHandler("first");
  const secondOAuth = fakeOAuthHandler("second");
  registerConnectorIntegration(firstRegistry, GITHUB_INTEGRATION_DESCRIPTOR, {
    connectionProbe: { async hasConnection() { return true; } },
    oauthRoutes: { paths: ["/auth/github/user/callback"], register: (app) => registerGithubOAuthRoutes(app, firstOAuth) }
  });
  registerConnectorIntegration(secondRegistry, GITHUB_INTEGRATION_DESCRIPTOR, {
    connectionProbe: { async hasConnection() { return false; } },
    oauthRoutes: { paths: ["/auth/github/user/callback"], register: (app) => registerGithubOAuthRoutes(app, secondOAuth) }
  });
  const state = {
    tenantId: "tenant", integrationId: "github", readsEnabled: true, writesEnabled: false,
    config: {}, createdAt: "2026-09-04T00:00:00.000Z", updatedAt: "2026-09-04T00:00:00.000Z", updatedBy: "user"
  };
  const store = { async get() { return state; }, async list() { return [state]; } };
  const firstService = new IntegrationRegistryService(createTestConfig(), store, {}, firstRegistry);
  const secondService = new IntegrationRegistryService(createTestConfig(), store, {}, secondRegistry);
  expect(await firstService.resolveSessionToolIds("tenant", "user")).toEqual(["github_read_file"]);
  expect(await secondService.resolveSessionToolIds("tenant", "user")).toEqual([]);
  expect(await firstService.resolveSessionToolIds("tenant", "user")).toEqual(["github_read_file"]);

  const firstApp = Fastify();
  const secondApp = Fastify();
  try {
    await Promise.all([firstApp.register(cookie), secondApp.register(cookie)]);
    await firstRegistry.get("github")!.oauthRoutes!.register(firstApp);
    await secondRegistry.get("github")!.oauthRoutes!.register(secondApp);
    const firstResponse = await firstApp.inject({ url: "/auth/github/user/callback?code=c&state=s" });
    const secondResponse = await secondApp.inject({ url: "/auth/github/user/callback?code=c&state=s" });
    expect(firstResponse.headers.location).toBe("/done?label=first");
    expect(secondResponse.headers.location).toBe("/done?label=second");
  } finally {
    await Promise.all([firstApp.close(), secondApp.close()]);
  }
  // The process-wide catalog contains no app service references.
  expect(getIntegrationDescriptor("github")?.connectionProbe).toBeUndefined();
});

test("Jira tools reach a session only with reads enabled and a stored connection", async () => {
  registerBuiltinIntegrations();
  const registry = new IntegrationRegistry();
  let connected = true;
  registerConnectorIntegration(registry, JIRA_INTEGRATION_DESCRIPTOR, {
    connectionProbe: { async hasConnection() { return connected; } }
  });
  const descriptor = registry.get("jira");
  expect(descriptor).toMatchObject({ status: "available", writeToolIds: [] });
  expect(descriptor?.oauthRoutes).toBeUndefined();
  expect(descriptor?.platformStatus?.(createTestConfig())).toMatchObject({ configured: false });

  let readsEnabled = true;
  const store = {
    async get() { return null; },
    async list() {
      return [{
        tenantId: "tenant", integrationId: "jira", readsEnabled, writesEnabled: true,
        config: {}, createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z", updatedBy: "admin"
      }];
    }
  };
  const service = new IntegrationRegistryService(createTestConfig(), store, {}, registry);
  expect(await service.resolveSessionToolIds("tenant", "user")).toEqual([
    "jira_list_sites", "jira_search_issues", "jira_get_issue", "jira_get_issue_changelog"
  ]);
  connected = false;
  expect(await service.resolveSessionToolIds("tenant", "user")).toEqual([]);
  connected = true;
  readsEnabled = false;
  // A stored write toggle adds nothing: Jira has no write tools.
  expect(await service.resolveSessionToolIds("tenant", "user")).toEqual([]);
});
