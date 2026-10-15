import { test, expect } from "vitest";

import type { AppConfig } from "../../config.js";

import {
  IntegrationRegistryService,
  type IntegrationConnectionProbes
} from "./integration-registry-service.js";
import {
  getIntegrationDescriptor,
  IntegrationRegistry,
  registerIntegration,
  type IntegrationConnectionProbe
} from "./integration-registry.js";
import { registerBuiltinIntegrations } from "./register-builtin-integrations.js";
import type { IntegrationStateRecord, IntegrationStateStore } from "./integration-state-store.js";

// Tests use the built-in registry but inject probes via the service's
// override map per test, so nothing here depends on the descriptor-attached
// probes from production wiring.
registerBuiltinIntegrations();
// Microsoft 365 ships from the SharePoint private overlay package — its
// descriptor is not registered by `registerBuiltinIntegrations` in core.
// The tests below use Microsoft as a worked example for the registry
// resolution mechanism, so register the descriptor here directly. The
// shape mirrors the overlay's `registerMicrosoftDescriptor`.
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

function buildConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    NOTION_OAUTH_CLIENT_ID: "notion-client",
    NOTION_OAUTH_CLIENT_SECRET: "notion-secret",
    NOTION_OAUTH_REDIRECT_URI: "https://example.com/notion/callback",
    GITHUB_OAUTH_CLIENT_ID: "github-oauth-client",
    GITHUB_OAUTH_CLIENT_SECRET: "github-oauth-secret",
    GITHUB_OAUTH_REDIRECT_URI: "https://example.com/gh/user",
    ...overrides
  } as unknown as AppConfig;
}

class FakeStateStore implements Pick<IntegrationStateStore, "list" | "get"> {
  constructor(public records: IntegrationStateRecord[] = []) {}

  async list(tenantId: string): Promise<IntegrationStateRecord[]> {
    return this.records.filter((r) => r.tenantId === tenantId);
  }

  async get(tenantId: string, integrationId: string): Promise<IntegrationStateRecord | null> {
    return (
      this.records.find((r) => r.tenantId === tenantId && r.integrationId === integrationId) ?? null
    );
  }
}

function probe(connected: boolean): IntegrationConnectionProbe {
  return {
    async hasConnection(): Promise<boolean> {
      return connected;
    }
  };
}

function makeState(overrides: Partial<IntegrationStateRecord> & {
  tenantId: string;
  integrationId: string;
}): IntegrationStateRecord {
  return {
    tenantId: overrides.tenantId,
    integrationId: overrides.integrationId,
    readsEnabled: overrides.readsEnabled ?? false,
    writesEnabled: overrides.writesEnabled ?? false,
    config: overrides.config ?? {},
    createdAt: overrides.createdAt ?? "2026-04-25T12:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-25T12:00:00.000Z",
    updatedBy: overrides.updatedBy ?? null
  };
}

const probes: IntegrationConnectionProbes = {
  notion: probe(true),
  microsoft: probe(true),
  github: probe(true)
};

test("resolveSessionToolIds returns empty when no toggles are enabled", async () => {
  const store = new FakeStateStore([]);
  const service = new IntegrationRegistryService(buildConfig(), store, probes);

  const ids = await service.resolveSessionToolIds("tenant-1", "user-1");
  expect(ids).toEqual([]);
});

test("resolveSessionToolIds returns only readToolIds when reads enabled and writes disabled", async () => {
  const store = new FakeStateStore([
    makeState({ tenantId: "tenant-1", integrationId: "notion", readsEnabled: true })
  ]);
  const service = new IntegrationRegistryService(buildConfig(), store, probes);

  const ids = await service.resolveSessionToolIds("tenant-1", "user-1");
  expect(ids.sort()).toEqual(["notion_fetch_page", "notion_query_database", "notion_search"].sort());
});

test("resolveSessionToolIds returns reads + writes when both enabled", async () => {
  const store = new FakeStateStore([
    makeState({
      tenantId: "tenant-1",
      integrationId: "notion",
      readsEnabled: true,
      writesEnabled: true
    })
  ]);
  const service = new IntegrationRegistryService(buildConfig(), store, probes);

  const ids = await service.resolveSessionToolIds("tenant-1", "user-1");
  expect(ids.length).toBe(6);
  expect(ids.includes("notion_search")).toBe(true);
  expect(ids.includes("notion_create_page")).toBe(true);
});

test("resolveSessionToolIds skips integrations without a user connection", async () => {
  const store = new FakeStateStore([
    makeState({ tenantId: "tenant-1", integrationId: "notion", readsEnabled: true })
  ]);
  const service = new IntegrationRegistryService(buildConfig(), store, {
    ...probes,
    notion: probe(false)
  });

  const ids = await service.resolveSessionToolIds("tenant-1", "user-1");
  expect(ids).toEqual([]);
});

test("resolveSessionToolIds excludes coming-soon integrations even if a state row exists", async () => {
  const store = new FakeStateStore([
    makeState({ tenantId: "tenant-1", integrationId: "linear", readsEnabled: true })
  ]);
  const service = new IntegrationRegistryService(buildConfig(), store, probes);

  const ids = await service.resolveSessionToolIds("tenant-1", "user-1");
  expect(ids).toEqual([]);
});

test("resolveSessionToolIds combines multiple integrations and deduplicates", async () => {
  const store = new FakeStateStore([
    makeState({ tenantId: "tenant-1", integrationId: "notion", readsEnabled: true }),
    makeState({ tenantId: "tenant-1", integrationId: "github", writesEnabled: true })
  ]);
  const service = new IntegrationRegistryService(buildConfig(), store, probes);

  const ids = await service.resolveSessionToolIds("tenant-1", "user-1");
  expect(ids.includes("notion_search")).toBe(true);
  expect(ids.includes("github_write_file")).toBe(true);
  // No duplicates.
  expect(new Set(ids).size).toBe(ids.length);
});

test("getIntegrationsForAdmin returns one row per descriptor with platform status", async () => {
  const store = new FakeStateStore([
    makeState({
      tenantId: "tenant-1",
      integrationId: "notion",
      readsEnabled: true,
      updatedBy: "user-99"
    })
  ]);
  const service = new IntegrationRegistryService(buildConfig(), store, probes);

  const views = await service.getIntegrationsForAdmin("tenant-1");
  const notion = views.find((v) => v.id === "notion");
  expect(notion).toBeTruthy();
  expect(notion!.readsEnabled).toBe(true);
  expect(notion!.writesEnabled).toBe(false);
  expect(notion!.platformConfigured).toBe(true);
  expect(notion!.updatedBy).toBe("user-99");

  const linear = views.find((v) => v.id === "linear");
  expect(linear).toBeTruthy();
  expect(linear!.status).toBe("coming_soon");
  // coming-soon entries should never report as enabled even if a stale state exists.
  expect(linear!.readsEnabled).toBe(false);
});

test("getIntegrationsForAdmin reports platform unconfigured when env vars are missing", async () => {
  const store = new FakeStateStore([]);
  const service = new IntegrationRegistryService(
    buildConfig({ NOTION_OAUTH_CLIENT_ID: undefined } as unknown as AppConfig),
    store,
    probes
  );

  const views = await service.getIntegrationsForAdmin("tenant-1");
  const notion = views.find((v) => v.id === "notion")!;
  expect(notion.platformConfigured).toBe(false);
  expect(notion.platformConfigMessage?.includes("NOTION_OAUTH_CLIENT_ID")).toBe(true);
});

test("getIntegrationsForAdmin hasConfig is true only when all required fields are present for oauth_app", async () => {
  const store = new FakeStateStore([
    makeState({
      tenantId: "tenant-1",
      integrationId: "microsoft",
      config: { clientId: "abc", clientSecret: "encrypted-blob" }
      // entraTenantId missing → hasConfig should be false
    })
  ]);
  const service = new IntegrationRegistryService(buildConfig(), store, probes);

  const views = await service.getIntegrationsForAdmin("tenant-1");
  const ms = views.find((v) => v.id === "microsoft")!;
  expect(ms.hasConfig).toBe(false);

  // Add the missing field and the flag should flip.
  store.records[0] = makeState({
    tenantId: "tenant-1",
    integrationId: "microsoft",
    config: { clientId: "abc", clientSecret: "encrypted-blob", entraTenantId: "xyz" }
  });
  const views2 = await service.getIntegrationsForAdmin("tenant-1");
  expect(views2.find((v) => v.id === "microsoft")!.hasConfig).toBe(true);
});

test("getIntegrationsForAdmin configSummary excludes password fields", async () => {
  const store = new FakeStateStore([
    makeState({
      tenantId: "tenant-1",
      integrationId: "microsoft",
      config: { clientId: "abc", clientSecret: "encrypted-blob", entraTenantId: "xyz" }
    })
  ]);
  const service = new IntegrationRegistryService(buildConfig(), store, probes);

  const ms = (await service.getIntegrationsForAdmin("tenant-1")).find((v) => v.id === "microsoft")!;
  expect(ms.configSummary).toEqual({ clientId: "abc", entraTenantId: "xyz" });
  expect("clientSecret" in ms.configSummary).toBe(false);
});

test("getIntegrationsForUser only returns enabled, available integrations", async () => {
  const store = new FakeStateStore([
    makeState({ tenantId: "tenant-1", integrationId: "notion", readsEnabled: true }),
    makeState({ tenantId: "tenant-1", integrationId: "github", readsEnabled: false, writesEnabled: false }),
    makeState({ tenantId: "tenant-1", integrationId: "linear", readsEnabled: true })
  ]);
  const service = new IntegrationRegistryService(buildConfig(), store, probes);

  const views = await service.getIntegrationsForUser("tenant-1", "user-1");
  expect(views.map((v) => v.id).sort()).toEqual(["notion"]);
});


test("isReadyToEnable for github (configMode=none) is always true regardless of probe state", async () => {
  const store = new FakeStateStore([]);
  const service = new IntegrationRegistryService(buildConfig(), store, probes);
  expect(await service.isReadyToEnable("tenant-1", "github")).toBe(true);
});

test("isReadyToEnable for oauth_app honors prospectiveConfig", async () => {
  const store = new FakeStateStore([]);
  const service = new IntegrationRegistryService(buildConfig(), store, probes);

  // Without prospective config and no row → not ready.
  expect(await service.isReadyToEnable("tenant-1", "microsoft")).toBe(false);
  // With a complete prospective config → ready, even though no row exists yet.
  expect(await service.isReadyToEnable("tenant-1", "microsoft", {
          clientId: "abc",
          clientSecret: "encrypted",
          entraTenantId: "xyz"
        })).toBe(true);
  // Missing required field → not ready.
  expect(await service.isReadyToEnable("tenant-1", "microsoft", {
          clientId: "abc"
        })).toBe(false);
});

test("isReadyToEnable for configMode=none always returns true", async () => {
  const store = new FakeStateStore([]);
  const service = new IntegrationRegistryService(buildConfig(), store, probes);
  expect(await service.isReadyToEnable("tenant-1", "notion")).toBe(true);
});

test("resolveSessionToolIds with sharepoint reads-only excludes sharepoint_import_file_to_session", async () => {
  const store = new FakeStateStore([
    makeState({
      tenantId: "tenant-1",
      integrationId: "microsoft",
      readsEnabled: true,
      writesEnabled: false
    })
  ]);
  const service = new IntegrationRegistryService(buildConfig(), store, probes);

  const ids = await service.resolveSessionToolIds("tenant-1", "user-1");
  expect(ids.includes("sharepoint_search")).toBe(true);
  expect(ids.includes("sharepoint_import_file_to_session")).toBe(false);
  expect(ids.includes("sharepoint_upload_file")).toBe(false);
});

test("resolveSessionToolIds with sharepoint writes enabled includes sharepoint_import_file_to_session", async () => {
  const store = new FakeStateStore([
    makeState({
      tenantId: "tenant-1",
      integrationId: "microsoft",
      readsEnabled: false,
      writesEnabled: true
    })
  ]);
  const service = new IntegrationRegistryService(buildConfig(), store, probes);

  const ids = await service.resolveSessionToolIds("tenant-1", "user-1");
  expect(ids.includes("sharepoint_import_file_to_session")).toBe(true);
  expect(ids.includes("sharepoint_upload_file")).toBe(true);
});

// ── Per-call integration checks (H10) ────────────────────────────────────────

function accountProbe(accountId: string | null): IntegrationConnectionProbe {
  return {
    async hasConnection() { return accountId !== null; },
    async connectedAccountId() { return accountId; }
  };
}

test("resolveSessionIntegrations records the account of each integration that grants tools", async () => {
  const store = new FakeStateStore([
    makeState({ tenantId: "tenant-1", integrationId: "github", readsEnabled: true }),
    makeState({ tenantId: "tenant-1", integrationId: "notion", writesEnabled: true }),
    // Off: no tools and no account.
    makeState({ tenantId: "tenant-1", integrationId: "microsoft" })
  ]);
  const service = new IntegrationRegistryService(buildConfig(), store, {
    github: accountProbe("gh-1"),
    notion: accountProbe(null),
    microsoft: accountProbe("ms-1")
  });

  await expect(service.resolveSessionIntegrations("tenant-1", "user-1"))
    .resolves.toEqual({ toolIds: ["github_read_file"], accounts: { github: "gh-1" } });
});

test("resolveSessionIntegrations grants no tools when a binding probe names no account", async () => {
  const store = new FakeStateStore([makeState({ tenantId: "tenant-1", integrationId: "github", readsEnabled: true })]);
  // The connection disappears between the presence check and the account read.
  const service = new IntegrationRegistryService(buildConfig(), store, {
    github: { async hasConnection() { return true; }, async connectedAccountId() { return null; } }
  });

  await expect(service.resolveSessionIntegrations("tenant-1", "user-1")).resolves.toEqual({ toolIds: [], accounts: {} });
});

test("checkToolCall allows a tool that belongs to no integration", async () => {
  const service = new IntegrationRegistryService(buildConfig(), new FakeStateStore([]), probes);

  await expect(service.checkToolCall({ tenantId: "tenant-1", userId: "user-1", toolName: "write_artifact",
    boundAccounts: {} })).resolves.toBeNull();
});

test.each([
  ["reads are off", { readsEnabled: false, writesEnabled: true }, "github_read_file", "GitHub reads are disabled for this organization."],
  ["only reads are on", { readsEnabled: true, writesEnabled: false }, "github_write_file", "GitHub writes are disabled for this organization."]
])("checkToolCall refuses a call when %s now", async (_name, toggles, toolName, message) => {
  const store = new FakeStateStore([makeState({ tenantId: "tenant-1", integrationId: "github", ...toggles })]);
  const service = new IntegrationRegistryService(buildConfig(), store, { github: accountProbe("gh-1") });

  await expect(service.checkToolCall({ tenantId: "tenant-1", userId: "user-1", toolName,
    boundAccounts: { github: "gh-1" } })).resolves.toBe(message);
});

test("checkToolCall refuses a call when the integration state row is gone", async () => {
  const service = new IntegrationRegistryService(buildConfig(), new FakeStateStore([]), { github: accountProbe("gh-1") });

  await expect(service.checkToolCall({ tenantId: "tenant-1", userId: "user-1", toolName: "github_read_file",
    boundAccounts: { github: "gh-1" } })).resolves.toMatch(/disabled/);
});

test.each([
  ["the same account", "gh-1", null],
  ["another account", "gh-2", "Your GitHub account changed during this turn. Send a new message to use the connected account."],
  ["no account", null, "Your GitHub account changed during this turn. Send a new message to use the connected account."]
])("checkToolCall compares the turn's account with %s", async (_name, current, expected) => {
  const store = new FakeStateStore([makeState({ tenantId: "tenant-1", integrationId: "github", readsEnabled: true })]);
  const service = new IntegrationRegistryService(buildConfig(), store, { github: accountProbe(current) });

  await expect(service.checkToolCall({ tenantId: "tenant-1", userId: "user-1", toolName: "github_read_file",
    boundAccounts: { github: "gh-1" } })).resolves.toBe(expected);
});

test("checkToolCall skips the account comparison for a context without a record", async () => {
  const store = new FakeStateStore([makeState({ tenantId: "tenant-1", integrationId: "github", readsEnabled: true })]);
  const service = new IntegrationRegistryService(buildConfig(), store, { github: accountProbe("gh-2") });

  await expect(service.checkToolCall({ tenantId: "tenant-1", userId: "user-1", toolName: "github_read_file",
    boundAccounts: undefined })).resolves.toBeNull();
});

test("checkToolCall refuses a turn that recorded accounts but none for the integration", async () => {
  const store = new FakeStateStore([makeState({ tenantId: "tenant-1", integrationId: "github", readsEnabled: true })]);
  const service = new IntegrationRegistryService(buildConfig(), store, { github: accountProbe("gh-1") });

  await expect(service.checkToolCall({ tenantId: "tenant-1", userId: "user-1", toolName: "github_read_file",
    boundAccounts: { notion: "n-1" } })).resolves.toMatch(/account changed/);
});

test("checkToolCall does not compare accounts for a probe that cannot name one", async () => {
  const store = new FakeStateStore([makeState({ tenantId: "tenant-1", integrationId: "github", readsEnabled: true })]);
  const service = new IntegrationRegistryService(buildConfig(), store, { github: probe(true) });

  await expect(service.checkToolCall({ tenantId: "tenant-1", userId: "user-1", toolName: "github_read_file",
    boundAccounts: {} })).resolves.toBeNull();
});

test.each([["first", ["shared-on", "shared-off"]], ["second", ["shared-off", "shared-on"]]])(
  "checkToolCall refuses a tool that a disabled integration also lists, registered %s", async (_order, ids) => {
    const registry = new IntegrationRegistry([]);
    for (const id of ids) {
      registry.register({ id, name: id, description: "", longDescription: "", logoSlug: id, status: "available",
        category: "Test", readToolIds: ["shared_tool"], writeToolIds: [], configMode: "none" });
    }
    const store = new FakeStateStore([
      makeState({ tenantId: "tenant-1", integrationId: "shared-on", readsEnabled: true }),
      makeState({ tenantId: "tenant-1", integrationId: "shared-off" })
    ]);
    const service = new IntegrationRegistryService(buildConfig(), store, {}, registry);

    await expect(service.checkToolCall({ tenantId: "tenant-1", userId: "user-1", toolName: "shared_tool",
      boundAccounts: undefined })).resolves.toBe("shared-off reads are disabled for this organization.");
  });
