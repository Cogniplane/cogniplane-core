// Acceptance test for the D4 refactor (OSS launch prep): proves the
// registries can be populated with the OSS-only subset (GitHub + Notion,
// no SharePoint/Microsoft) and the integration registry service still
// returns a coherent admin view + resolves session tool ids.
//
// This is the "delete SharePoint and GitHub+Notion still work" check
// without actually deleting the SharePoint files — a private overlay's
// equivalent boot sequence is what we're emulating here.
import { test, expect, onTestFinished } from "vitest";

import type { AppConfig } from "../../config.js";

import {
  __resetIntegrationRegistryForTesting,
  getIntegrationDescriptor,
  listIntegrationDescriptors,
  registerIntegration
} from "./integration-registry.js";
import {
  IntegrationRegistryService
} from "./integration-registry-service.js";
import type { IntegrationStateRecord, IntegrationStateStore } from "./integration-state-store.js";

import { ManagedToolCatalog } from "../managed-tools/catalog.js";
import { ManagedToolFactoryRegistry } from "../managed-tools/factory.js";
import { createGithubTools, GITHUB_TOOL_CATALOG } from "../managed-tools/github-tools.js";
import { createNotionTools, NOTION_TOOL_CATALOG } from "../managed-tools/notion-tools.js";
import { createSessionTools, SESSION_TOOL_CATALOG } from "../managed-tools/session-tools.js";
import { createWriteArtifactTool, WRITE_ARTIFACT_CATALOG } from "../managed-tools/write-artifact.js";

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

function buildConfig(): AppConfig {
  return {
    NOTION_OAUTH_CLIENT_ID: "x",
    NOTION_OAUTH_CLIENT_SECRET: "y",
    NOTION_OAUTH_REDIRECT_URI: "https://example.com/notion",
    GITHUB_OAUTH_CLIENT_ID: "x",
    GITHUB_OAUTH_CLIENT_SECRET: "y",
    GITHUB_OAUTH_REDIRECT_URI: "https://example.com/github"
  } as unknown as AppConfig;
}

const ossSubsetSetup = test("OSS subset (no SharePoint): registers only GitHub + Notion descriptors and tools", async () => {
  // The integration registry stays module-level (Path B intentionally), so
  // snapshot it for this test only. The managed-tool registries are now
  // per-instance, so we just construct fresh ones here.
  __resetIntegrationRegistryForTesting();
  onTestFinished(() => {
        __resetIntegrationRegistryForTesting();
      });

  const catalog = new ManagedToolCatalog();
  const factoryRegistry = new ManagedToolFactoryRegistry();

  // === Boot sequence as if SharePoint had been moved to a private overlay ===

  // 1) Managed tools — register only GitHub + Notion + Session + WriteArtifact.
  catalog.register(
    SESSION_TOOL_CATALOG.map((e) => ({ ...e, tenantConfigurable: true }))
  );
  catalog.register(
    WRITE_ARTIFACT_CATALOG.map((e) => ({ ...e, tenantConfigurable: true }))
  );
  catalog.register(
    GITHUB_TOOL_CATALOG.map((e) => ({ ...e, tenantConfigurable: false }))
  );
  catalog.register(
    NOTION_TOOL_CATALOG.map((e) => ({ ...e, tenantConfigurable: false }))
  );
  factoryRegistry.register("session", createSessionTools);
  factoryRegistry.register("github", createGithubTools);
  factoryRegistry.register("notion", createNotionTools);
  factoryRegistry.register("write-artifact", createWriteArtifactTool);

  // 2) Integration descriptors — register only GitHub + Notion.
  registerIntegration({
    id: "github",
    name: "GitHub",
    description: "",
    longDescription: "",
    logoSlug: "github",
    status: "available",
    category: "Code",
    readToolIds: ["github_read_file"],
    writeToolIds: ["github_write_file", "github_create_pr"],
    configMode: "none"
  });
  registerIntegration({
    id: "notion",
    name: "Notion",
    description: "",
    longDescription: "",
    logoSlug: "notion",
    status: "available",
    category: "Productivity",
    readToolIds: ["notion_search", "notion_fetch_page", "notion_query_database"],
    writeToolIds: ["notion_create_page", "notion_update_page", "notion_append_blocks"],
    configMode: "none"
  });

  // === Verify the OSS-only world works ===

  const descriptors = listIntegrationDescriptors();
  const ids = descriptors.map((d) => d.id);
  expect(ids.sort()).toEqual(["github", "notion"]);
  expect(getIntegrationDescriptor("microsoft")).toBe(null);

  // Managed tool catalog has no sharepoint_* tools.
  const toolIds = catalog.listIds();
  expect(toolIds.includes("github_read_file")).toBe(true);
  expect(toolIds.includes("notion_search")).toBe(true);
  expect(toolIds.includes("session_context")).toBe(true);
  expect(toolIds.includes("write_artifact")).toBe(true);
  expect(toolIds.some((id) => id.startsWith("sharepoint_"))).toBe(false);

  // Service produces an admin view that lists exactly the registered
  // descriptors and resolves session tool ids correctly.
  const states: IntegrationStateRecord[] = [
    {
      tenantId: "t1",
      integrationId: "github",
      readsEnabled: true,
      writesEnabled: false,
      config: {},
      createdAt: "2026-05-06T00:00:00.000Z",
      updatedAt: "2026-05-06T00:00:00.000Z",
      updatedBy: null
    },
    {
      tenantId: "t1",
      integrationId: "notion",
      readsEnabled: true,
      writesEnabled: true,
      config: {},
      createdAt: "2026-05-06T00:00:00.000Z",
      updatedAt: "2026-05-06T00:00:00.000Z",
      updatedBy: null
    }
  ];
  const service = new IntegrationRegistryService(buildConfig(), new FakeStateStore(states), {
    github: { async hasConnection() { return true; } },
    notion: { async hasConnection() { return true; } }
  });

  const adminView = await service.getIntegrationsForAdmin("t1");
  expect(adminView.map((v) => v.id).sort()).toEqual(["github", "notion"]);

  const sessionToolIds = await service.resolveSessionToolIds("t1", "u1");
  expect(sessionToolIds.includes("github_read_file")).toBe(true);
  expect(sessionToolIds.includes("notion_search")).toBe(true);
  expect(sessionToolIds.includes("notion_create_page")).toBe(true);
  expect(sessionToolIds.some((id) => id.startsWith("sharepoint_"))).toBe(false);

  // The factory builds tool definitions for every registered factory.
  // Plug in cheap stubs for the per-provider connection deps — the
  // factories don't *call* them at construction time, only when a tool is
  // invoked, so we don't need real implementations.
  const fakeConnections = { getRuntimeCredentials: async () => null };
  const tools = factoryRegistry.createDefinitions({
    sessions: { getOwned: async () => null } as never,
    messages: { listBySession: async () => [] } as never,
    artifacts: {
      create: async () => ({}) as never,
      getOwned: async () => null,
      listBySession: async () => [],
      findLatestReadableDerived: async () => null
    } as never,
    storage: { openReadStream: async () => ({}) as never, put: async () => ({}) as never } as never,
    auditEvents: { create: async () => undefined } as never,
    githubConnections: fakeConnections as never,
    microsoftConnections: fakeConnections as never,
    notionConnections: fakeConnections as never
  });
  const toolNames = tools.map((t) => t.name);
  expect(toolNames.includes("github_read_file")).toBe(true);
  expect(toolNames.includes("notion_search")).toBe(true);
  expect(toolNames.includes("session_context")).toBe(true);
  expect(toolNames.includes("write_artifact")).toBe(true);
  expect(toolNames.some((n) => n.startsWith("sharepoint_"))).toBe(false);
});

void ossSubsetSetup;
