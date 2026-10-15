import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { IntegrationRegistryService } from "./integration-registry-service.js";
import { createTestConfig } from "../../test-helpers/test-config.js";
import { test, expect } from "vitest";

import {
  IntegrationRegistry,
  __resetIntegrationRegistryForTesting,
  getIntegrationDescriptor,
  listIntegrationOAuthCallbackPaths
} from "./integration-registry.js";
import {
  __resetBuiltinIntegrationsRegistrationForTesting,
  attachBuiltinIntegrationRuntime,
  registerBuiltinIntegrations
} from "./register-builtin-integrations.js";

function fakeProbe(label: string) {
  return {
    label,
    async hasConnection(): Promise<boolean> {
      return true;
    }
  };
}

function fakeOAuthHandler(label: string) {
  return {
    label,
    async completeAuthorization(): Promise<string> {
      return `/done?label=${label}`;
    }
  };
}

test("attaches app hooks without changing the static catalog", () => {
  __resetIntegrationRegistryForTesting();
  __resetBuiltinIntegrationsRegistrationForTesting();

  // Registering the static catalog must not capture app services.
  registerBuiltinIntegrations();
  const registry = new IntegrationRegistry();

  const githubBefore = getIntegrationDescriptor("github");
  if (!githubBefore) throw new Error("Expected GitHub integration descriptor.");
  expect(githubBefore.connectionProbe).toBe(undefined);
  expect(githubBefore.oauthCallbackPaths).toContain("/auth/github/user/callback");

  // Live wiring attaches only to this app's registry.
  const probe = fakeProbe("github-probe");
  const oauth = fakeOAuthHandler("github-oauth");
  attachBuiltinIntegrationRuntime(registry, {
    probes: { github: probe },
    oauth: { github: oauth }
  });

  const githubAfter = registry.get("github");
  if (!githubAfter) throw new Error("Expected rewired GitHub integration descriptor.");
  expect(githubAfter.connectionProbe).toBe(probe);

  const callbackPaths = listIntegrationOAuthCallbackPaths();
  expect(callbackPaths.includes("/auth/github/user/callback")).toBeTruthy();
  expect(callbackPaths.includes("/auth/github/install/callback")).toBeFalsy();
  expect(callbackPaths.includes("/integrations/notion/callback")).toBeTruthy();
});

test("independent apps retain their own probes and OAuth handlers", async () => {
  registerBuiltinIntegrations();
  const firstRegistry = new IntegrationRegistry();
  const secondRegistry = new IntegrationRegistry();
  attachBuiltinIntegrationRuntime(firstRegistry, {
    probes: { github: { async hasConnection() { return true; } } },
    oauth: { github: fakeOAuthHandler("first") }
  });
  attachBuiltinIntegrationRuntime(secondRegistry, {
    probes: { github: { async hasConnection() { return false; } } },
    oauth: { github: fakeOAuthHandler("second") }
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

test("registerBuiltinIntegrations is idempotent across repeated calls", () => {
  __resetIntegrationRegistryForTesting();
  __resetBuiltinIntegrationsRegistrationForTesting();

  registerBuiltinIntegrations();
  // A second call must not throw "Integration already registered".
  registerBuiltinIntegrations();

  expect(getIntegrationDescriptor("github")).toBeTruthy();
  expect(getIntegrationDescriptor("notion")).toBeTruthy();
  // Microsoft 365 ships from the SharePoint private overlay package and is
  // not registered by `registerBuiltinIntegrations`.
  expect(getIntegrationDescriptor("microsoft")).toBe(null);
});

test("Jira tools reach a session only with reads enabled and a stored connection", async () => {
  registerBuiltinIntegrations();
  const registry = new IntegrationRegistry();
  let connected = true;
  attachBuiltinIntegrationRuntime(registry, { probes: { jira: { async hasConnection() { return connected; } } } });
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
