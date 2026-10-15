import Fastify from "fastify";
import { afterEach, describe, expect, test, vi } from "vitest";
import { MODEL_PROVIDERS, type ModelProvider } from "@cogniplane/shared-types";

import { AdminConfigError } from "../../services/admin-config-error.js";
import type { ManagedToolCatalogEntry } from "../../services/managed-tools/catalog.js";
import { TenantSettingsConflictError, type TenantSettingsRecord } from "../../services/tenant-settings-store.js";
import { FakePool } from "../../test-helpers/fake-pool.js";
import { registerAdminTenantSettingsRoutes } from "./admin-tenant-settings-routes.js";

// Built-in catalog entries: Sonnet 5.5 supports low..max, Haiku 4.5 only "none".
const SONNET = "deepagents/claude-sonnet-5-5";
const HAIKU = "deepagents/claude-haiku-4-5";
const CUSTOM = "custom/acme-llm";
const customModels = [{ id: CUSTOM, provider: "openrouter" as ModelProvider, supportedEfforts: ["low"] }];

function settingsWith(overrides: Partial<TenantSettingsRecord> = {}): TenantSettingsRecord {
  return {
    tenantId: "tenant-A", showEffortSelector: false, webSearchMode: "disabled", approvalPolicy: "on-request",
    approvalReviewer: "user", allowCommandExecution: false, autoApproveReadOnlyTools: true,
    policyEnforcementMode: "monitor", developerInstructions: null, enabledToolIds: [], enabledMcpServerIds: [],
    enabledProviders: [...MODEL_PROVIDERS], enabledModelIds: null, defaultModelId: null, modelDefaultEfforts: {},
    approvedSandboxEgressDomains: [], version: 4, configHash: "hash", updatedAt: "2026-10-01T00:00:00.000Z", ...overrides
  };
}

const tools: ManagedToolCatalogEntry[] = [
  { name: "write_artifact", description: "Save a file.", readOnly: false, tenantConfigurable: true, category: "write-artifact" },
  { name: "read_project", description: "Read project files.", readOnly: true, tenantConfigurable: true, category: "project" }
];

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function buildApp(options: {
  role?: "owner" | "admin" | "member";
  current?: TenantSettingsRecord;
  update?: (tenantId: string, input: Record<string, unknown>, audit?: unknown) => Promise<TenantSettingsRecord>;
} = {}) {
  const role = options.role ?? "owner";
  const current = options.current ?? settingsWith();
  const dynamicConfig = {
    getOrCreateTenantSettings: vi.fn(async (_tenantId: string) => current),
    updateTenantSettings: vi.fn(options.update ?? (async (_tenantId: string, _input: Record<string, unknown>, _audit?: unknown) =>
      settingsWith({ version: current.version + 1 })))
  };
  const managedToolCatalog = { listTenantConfigurable: vi.fn(() => tools) };
  const listCustomModels = vi.fn(async (_tenantId: string) => customModels);
  const app = Fastify();
  apps.push(app);
  app.decorate("db", new FakePool().onQuery(/INSERT INTO users/, () => ({ rows: [], rowCount: 1 })).asPool());
  app.addHook("preHandler", async (request) => {
    request.auth = { tenantId: "tenant-A", userId: "user-1", role, isAdmin: role !== "member" };
  });
  await registerAdminTenantSettingsRoutes(app, { dynamicConfig, managedToolCatalog, listCustomModels });
  return { app, dynamicConfig, managedToolCatalog, listCustomModels };
}

const put = (payload: Record<string, unknown>) => ({ method: "PUT" as const, url: "/admin/tenant-settings", payload });

describe("GET /admin/tenant-settings", () => {
  test("keeps built-in and custom models, and drops ids the catalog no longer has", async () => {
    const { app, dynamicConfig, listCustomModels } = await buildApp({
      current: settingsWith({ enabledModelIds: [SONNET, CUSTOM, "openai/gpt-5.4"] })
    });

    const response = await app.inject({ method: "GET", url: "/admin/tenant-settings" });

    expect(response.statusCode).toBe(200);
    expect(response.json().settings.enabledModelIds).toEqual([SONNET, CUSTOM]);
    expect(dynamicConfig.getOrCreateTenantSettings).toHaveBeenCalledWith("tenant-A");
    expect(listCustomModels).toHaveBeenCalledWith("tenant-A");
  });
});

describe("GET /admin/managed-tools", () => {
  test("lists the tenant-configurable tools", async () => {
    const { app } = await buildApp();

    const response = await app.inject({ method: "GET", url: "/admin/managed-tools" });

    expect(response.json()).toEqual({
      tools: [
        { id: "write_artifact", description: "Save a file.", readOnly: false },
        { id: "read_project", description: "Read project files.", readOnly: true }
      ]
    });
  });
});

test.each([
  ["GET", "/admin/tenant-settings", undefined],
  ["GET", "/admin/managed-tools", undefined],
  ["PUT", "/admin/tenant-settings", { showEffortSelector: true }]
] as const)("refuses a member on %s %s before reading or writing", async (method, url, payload) => {
  const { app, dynamicConfig, managedToolCatalog } = await buildApp({ role: "member" });

  const response = await app.inject({ method, url, payload });

  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({ error: "admin_required" });
  expect(dynamicConfig.getOrCreateTenantSettings).not.toHaveBeenCalled();
  expect(dynamicConfig.updateTenantSettings).not.toHaveBeenCalled();
  expect(managedToolCatalog.listTenantConfigurable).not.toHaveBeenCalled();
});

describe("PUT /admin/tenant-settings", () => {
  test.each([
    ["a field of the wrong shape", { webSearchMode: "always" }, /./],
    ["an unknown default model", { defaultModelId: "openai/gpt-5.4" }, /^Unknown default model: openai\/gpt-5\.4$/],
    ["unknown enabled models", { enabledModelIds: [SONNET, "a/x", "b/y"] }, /^Unknown model ids: a\/x, b\/y$/],
    ["an effort for an unknown model", { modelDefaultEfforts: { "a/x": "low" } }, /^Unknown model id in modelDefaultEfforts: a\/x$/],
    ["an effort the model does not support", { modelDefaultEfforts: { [HAIKU]: "high" } }, /^Effort "high" is not supported by model "deepagents\/claude-haiku-4-5"\.$/]
  ])("rejects %s before writing", async (_case, payload, message) => {
    const { app, dynamicConfig } = await buildApp();

    const response = await app.inject(put(payload));

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("validation_error");
    expect(response.json().message).toMatch(message);
    expect(dynamicConfig.updateTenantSettings).not.toHaveBeenCalled();
  });

  test("accepts a custom model as the default, with its own effort, for the caller's tenant", async () => {
    const { app, dynamicConfig } = await buildApp();

    const response = await app.inject(put({
      tenantId: "tenant-B",
      enabledModelIds: [SONNET, CUSTOM],
      defaultModelId: CUSTOM,
      modelDefaultEfforts: { [CUSTOM]: "low", [SONNET]: "max" }
    }));

    expect(response.statusCode).toBe(200);
    expect(dynamicConfig.updateTenantSettings).toHaveBeenCalledWith(
      "tenant-A",
      expect.objectContaining({ defaultModelId: CUSTOM, expectedVersion: 4 }),
      expect.any(Function)
    );
    expect(dynamicConfig.updateTenantSettings.mock.calls[0]![1]).not.toHaveProperty("tenantId");
  });

  test("refuses a default model whose provider is turned off", async () => {
    const { app, dynamicConfig } = await buildApp();

    const response = await app.inject(put({ enabledProviders: ["anthropic"], defaultModelId: CUSTOM }));

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "validation_error",
      message: "Enable the default model and its provider before selecting it."
    });
    expect(dynamicConfig.updateTenantSettings).not.toHaveBeenCalled();
  });

  test("answers 409 when the settings changed since the form loaded", async () => {
    const { app } = await buildApp({ update: async () => { throw new TenantSettingsConflictError(); } });

    const response = await app.inject(put({ showEffortSelector: true }));

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("settings_conflict");
  });

  // The route rethrows unexpected errors; the app's global error handler (not
  // registered here) turns them into an opaque 500.
  test("turns a configuration error into 400 and rethrows an unexpected error", async () => {
    const config = await buildApp({ update: async () => { throw new AdminConfigError("Unknown MCP server: docs."); } });
    const configResponse = await config.app.inject(put({ showEffortSelector: true }));
    expect(configResponse.statusCode).toBe(400);
    expect(configResponse.json()).toEqual({ error: "invalid_config", message: "Unknown MCP server: docs." });

    const crash = await buildApp({ update: async () => { throw new Error("database is down"); } });
    expect((await crash.app.inject(put({ showEffortSelector: true }))).statusCode).toBe(500);
  });
});

// VULN-13: the hosts that agent-run code in the sandbox may reach. The provider
// accepts any text in this list, so the route is the only check.
describe("PUT /admin/tenant-settings approved sandbox hosts", () => {
  test("saves a valid list for an admin, who does not hold the owner-only command switch", async () => {
    const { app, dynamicConfig } = await buildApp({ role: "admin" });

    const response = await app.inject(put({
      approvedSandboxEgressDomains: ["pypi.org", "files.pythonhosted.org", "*.example.com"],
      // An admin form sends the owner field back unchanged. It is dropped, the list is kept.
      allowCommandExecution: false
    }));

    expect(response.statusCode).toBe(200);
    const input = dynamicConfig.updateTenantSettings.mock.calls[0]![1];
    expect(input.approvedSandboxEgressDomains).toEqual(["pypi.org", "files.pythonhosted.org", "*.example.com"]);
    expect(input).not.toHaveProperty("allowCommandExecution");
  });

  test("saves an empty list: the sandbox then has no network", async () => {
    const { app, dynamicConfig } = await buildApp();

    const response = await app.inject(put({ approvedSandboxEgressDomains: [] }));

    expect(response.statusCode).toBe(200);
    expect(dynamicConfig.updateTenantSettings.mock.calls[0]![1].approvedSandboxEgressDomains).toEqual([]);
  });

  test("leaves the list out of the update when the request does not carry it", async () => {
    const { app, dynamicConfig } = await buildApp();

    await app.inject(put({ showEffortSelector: true }));

    expect(dynamicConfig.updateTenantSettings.mock.calls[0]![1]).not.toHaveProperty("approvedSandboxEgressDomains");
  });

  test.each([
    ["a lone star", ["*"], /"\*" can use \* only as a first label/],
    ["a star over a top-level domain", ["*.com"], /"\*\.com" would approve every host under a public suffix/],
    ["a star over a private suffix", ["pypi.org", "*.github.io"], /"\*\.github\.io" would approve every host under a public suffix/],
    ["a URL", ["https://pypi.org"], /"https:\/\/pypi\.org" must be a host name only/],
    ["a port", ["pypi.org:443"], /must not contain a port or an IP address/],
    ["an IP address", ["93.184.216.34"], /is an IP address/],
    ["the metadata name", ["metadata.google.internal"], /is a name that is not a public internet host/],
    ["upper case", ["PyPI.org"], /must be lower case/],
    ["a non-string entry", ["pypi.org", 4], /Invalid input|expected string/i]
  ])("rejects %s and saves nothing", async (_case, list, message) => {
    const { app, dynamicConfig } = await buildApp();

    const response = await app.inject(put({ approvedSandboxEgressDomains: list }));

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("validation_error");
    expect(response.json().message).toMatch(message);
    expect(dynamicConfig.updateTenantSettings).not.toHaveBeenCalled();
  });

  test("rejects the whole list when one entry fails, and names every failing entry", async () => {
    const { app, dynamicConfig } = await buildApp();

    const response = await app.inject(put({ approvedSandboxEgressDomains: ["pypi.org", "*.com", "bad host"] }));

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain('"*.com"');
    expect(response.json().message).toContain('"bad host"');
    expect(dynamicConfig.updateTenantSettings).not.toHaveBeenCalled();
  });

  test("rejects more than 25 hosts", async () => {
    const { app, dynamicConfig } = await buildApp();
    const many = Array.from({ length: 26 }, (_, i) => `host${i}.example.com`);

    const response = await app.inject(put({ approvedSandboxEgressDomains: many }));

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toBe("Approve at most 25 hosts. This list has 26.");
    expect(dynamicConfig.updateTenantSettings).not.toHaveBeenCalled();
  });

  test("records the saved list in the audit event, in the same call as the change", async () => {
    let audit: ((saved: TenantSettingsRecord) => { type: string; payload: Record<string, unknown> }) | undefined;
    const { app } = await buildApp({
      update: async (_tenantId, _input, auditFn) => {
        audit = auditFn as typeof audit;
        return settingsWith({ version: 5, approvedSandboxEgressDomains: ["*.example.com", "pypi.org"] });
      }
    });

    const response = await app.inject(put({ approvedSandboxEgressDomains: ["pypi.org", "*.example.com"] }));

    expect(response.statusCode).toBe(200);
    expect(response.json().settings.approvedSandboxEgressDomains).toEqual(["*.example.com", "pypi.org"]);
    const event = audit!(settingsWith({ version: 5, approvedSandboxEgressDomains: ["*.example.com", "pypi.org"] }));
    expect(event.type).toBe("admin.tenant_settings.updated");
    expect(event.payload.approvedSandboxEgressDomains).toEqual(["*.example.com", "pypi.org"]);
  });

  test("GET returns the saved list", async () => {
    const { app } = await buildApp({ current: settingsWith({ approvedSandboxEgressDomains: ["pypi.org"] }) });

    const response = await app.inject({ method: "GET", url: "/admin/tenant-settings" });

    expect(response.json().settings.approvedSandboxEgressDomains).toEqual(["pypi.org"]);
  });
});
