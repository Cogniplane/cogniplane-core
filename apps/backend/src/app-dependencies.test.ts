import Fastify from "fastify";
import { afterEach, expect, test, vi } from "vitest";

import { buildAppDependencies } from "./app-dependencies.js";
import { Pool } from "./lib/db.js";
import type { ToolExecutionContext } from "./services/auth/tool-execution-context-store.js";
import { getIntegrationDescriptor } from "./services/integrations/integration-registry.js";
import type { ManagedToolFactoryDeps } from "./services/managed-tools/factory.js";
import { ProjectFileStore } from "./services/project-file-store.js";
import { createSilentLogger } from "./test-helpers/silent-logger.js";
import { createTestConfig } from "./test-helpers/test-config.js";

// These tests build the real dependency graph. The pools never connect: no
// test here sends a query.
const pools: Pool[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

function build() {
  const db = new Pool();
  pools.push(db);
  return buildAppDependencies({ db, config: createTestConfig(), logger: createSilentLogger() });
}

function unused(): never {
  throw new Error("unexpected call");
}

// The factories read these slots only when a tool runs. The project factory
// needs `projectFiles` to produce its tools.
function factoryDeps(): ManagedToolFactoryDeps {
  return {
    db: new Pool(),
    dynamicConfig: { listSkills: unused },
    sessions: { getReadable: unused },
    messages: { listBySession: unused },
    memories: { search: unused, save: unused, remove: unused },
    artifacts: {
      create: unused, createGenerated: unused, getReadable: unused, listBySession: unused,
      findLatestReadableDerived: unused
    },
    storage: { put: unused, openReadStream: unused, delete: unused },
    auditEvents: { create: unused },
    artifactMaxBytes: 1024,
    limits: { consumeRateLimit: unused, refundRateLimit: unused },
    projectFiles: {
      readRuntimeSnapshotFile: unused, createAgentDraftFromContent: unused,
      readConflictContext: unused, readConflictMetadata: unused
    }
  };
}

function toolContext(): ToolExecutionContext {
  return {
    toolContextId: "ctx-1", tenantId: "tenant-1", sessionId: "session-1", userId: "user-1",
    runtimeId: "runtime-1", runtimePolicyId: "policy-1", messageId: null, credentialEnvelope: {},
    metadata: {}, createdAt: "2026-10-27T00:00:00.000Z", expiresAt: "2026-10-27T01:00:00.000Z"
  };
}

const unique = (values: readonly (string | undefined)[]) => [...new Set(values)];

// Overlays (for example the private SharePoint overlay) register after these.
const BUILTIN_FACTORY_ORDER = [
  "session", "skill-corpus", "github", "notion", "jira", "write-artifact", "project", "memory", "interactive-ui"
];
const BUILTIN_CATALOG_ORDER = [
  "session", "skill-corpus", "write-artifact", "project", "memory", "interactive-ui", "github", "notion", "jira"
];

test("the app's project file store gets the app's PII service and PDF text extractor", () => {
  const attach = vi.spyOn(ProjectFileStore.prototype, "setPiiProtection");

  const deps = build();

  // The project file routes and the project tools use `deps.projectFiles`.
  // Without this service, the store refuses every agent draft.
  expect(attach).toHaveBeenCalledOnce();
  expect(attach.mock.contexts[0]).toBe(deps.projectFiles);
  expect(attach.mock.calls[0]?.[0]).toBe(deps.piiProtection);
  expect(attach.mock.calls[0]?.[1]).toBeTypeOf("function");
});

test("built-in connectors put their OAuth callback paths in the app registry that the auth allowlist reads", () => {
  const deps = build();

  // `app.ts` reads these paths right after `buildAppDependencies()` returns.
  const paths = deps.integrationDescriptors.oauthCallbackPaths();
  expect(paths).toContain("/auth/github/user/callback");
  expect(paths).toContain("/integrations/notion/callback");
  for (const id of ["github", "notion"]) {
    expect(deps.integrationDescriptors.get(id)?.oauthRoutes?.register, id).toBeTypeOf("function");
  }
  // Pipedream hosts the Jira callback.
  expect(deps.integrationDescriptors.get("jira")?.oauthRoutes).toBeUndefined();
});

test("the managed tool and integration orders stay the same", () => {
  const deps = build();

  // The factory order is the MCP `tools/list` order that the agent runtime loads.
  const factoryDomains = unique(
    deps.managedToolFactoryRegistry.createDefinitions(factoryDeps()).map((definition) => definition.category)
  );
  expect(factoryDomains.slice(0, BUILTIN_FACTORY_ORDER.length)).toEqual(BUILTIN_FACTORY_ORDER);

  const catalogDomains = unique(
    deps.managedToolCatalog.listIds().map((id) => deps.managedToolCatalog.get(id)?.category)
  );
  expect(catalogDomains.slice(0, BUILTIN_CATALOG_ORDER.length)).toEqual(BUILTIN_CATALOG_ORDER);
  // Overlays add the same domains to both registries, after the built-ins.
  expect(factoryDomains.slice(BUILTIN_FACTORY_ORDER.length))
    .toEqual(catalogDomains.slice(BUILTIN_CATALOG_ORDER.length));

  expect(deps.integrationDescriptors.list().map((descriptor) => descriptor.id).slice(0, 4))
    .toEqual(["notion", "github", "jira", "linear"]);
});

test("every integration tool is an integration-gated catalog entry with a factory", () => {
  const deps = build();
  const definitions = new Map(
    deps.managedToolFactoryRegistry.createDefinitions(factoryDeps()).map((definition) => [definition.name, definition])
  );

  for (const descriptor of deps.integrationDescriptors.list()) {
    if (descriptor.status !== "available") continue;
    for (const toolId of [...descriptor.readToolIds, ...descriptor.writeToolIds]) {
      const entry = deps.managedToolCatalog.get(toolId);
      expect(entry, toolId).toMatchObject({ tenantConfigurable: false });
      expect(definitions.get(toolId)?.category, toolId).toBe(entry?.category);
    }
  }
});

test("two apps built in one process keep their own connector services", async () => {
  const first = build();
  const second = build();

  expect(second.githubConnectionService).not.toBe(first.githubConnectionService);
  expect(first.integrationDescriptors.get("github")?.connectionProbe).toBe(first.githubConnectionService);
  expect(second.integrationDescriptors.get("github")?.connectionProbe).toBe(second.githubConnectionService);
  for (const id of ["github", "notion", "jira"]) {
    const firstProbe = first.integrationDescriptors.get(id)?.connectionProbe;
    expect(firstProbe, id).toBeDefined();
    expect(second.integrationDescriptors.get(id)?.connectionProbe, id).not.toBe(firstProbe);
    // The process-wide catalog holds no app service.
    expect(getIntegrationDescriptor(id)?.connectionProbe, id).toBeUndefined();
  }
  expect(second.managedToolCatalog).not.toBe(first.managedToolCatalog);
  expect(second.managedToolCatalog.listIds()).toEqual(first.managedToolCatalog.listIds());

  // Each app's GitHub tool reads credentials through that app's service.
  const firstCredentials = vi.spyOn(first.githubConnectionService, "getRuntimeCredentials").mockResolvedValue(null);
  const secondCredentials = vi.spyOn(second.githubConnectionService, "getRuntimeCredentials").mockResolvedValue(null);
  const readFile = first.managedToolFactoryRegistry.createDefinitions(factoryDeps())
    .find((definition) => definition.name === "github_read_file");
  const result = await readFile?.handler({
    context: toolContext(),
    arguments: { toolContextId: "ctx-1", repo: "org/repo", path: "a.ts" }
  });
  expect(result).toEqual({ error: "No GitHub connection found. Connect your GitHub account in settings." });
  expect(firstCredentials).toHaveBeenCalledTimes(1);
  expect(secondCredentials).not.toHaveBeenCalled();
});

// The member and admin routes that the built-in connector modules attach.
const CONNECTOR_ROUTES = [
  ["GET", "/me/github-connection"], ["POST", "/me/github-connection/authorize"],
  ["GET", "/me/github-connection/repositories"], ["PUT", "/me/github-connection/repositories"],
  ["DELETE", "/me/github-connection"],
  ["GET", "/me/notion-connection"], ["POST", "/me/notion-connection/authorize"], ["DELETE", "/me/notion-connection"],
  ["GET", "/me/jira-connection"], ["POST", "/me/jira-connection/authorize"], ["GET", "/me/jira-connection/accounts"],
  ["GET", "/me/jira-connection/accounts/:accountId/sites"], ["PUT", "/me/jira-connection"],
  ["DELETE", "/me/jira-connection"],
  ["GET", "/admin/integrations/jira/cleanups"], ["POST", "/admin/integrations/jira/cleanups/:cleanupId/retry"]
] as const;

test("each app attaches the real connector routes and OAuth callbacks once", async () => {
  for (const deps of [build(), build()]) {
    const app = Fastify();
    try {
      await deps.builtinConnectors.attachRoutes(app);
      // `routes/auth.ts` registers the callbacks in the same way. Fastify
      // rejects a second registration of the same method and URL.
      for (const descriptor of deps.integrationDescriptors.list()) {
        await descriptor.oauthRoutes?.register(app);
      }
      await app.ready();

      for (const [method, url] of CONNECTOR_ROUTES) {
        expect(app.hasRoute({ method, url }), `${method} ${url}`).toBe(true);
      }
      for (const url of deps.integrationDescriptors.oauthCallbackPaths()) {
        expect(app.hasRoute({ method: "GET", url }), url).toBe(true);
      }
    } finally {
      await app.close();
    }
  }
});

test("the PII import scope registry is frozen once the overlays have registered", () => {
  const deps = build();
  expect(() => deps.piiImportScopes.register({ subjectKind: "late_import", scopeKey: "lateImports", defaultOn: true }))
    .toThrow(/frozen/);
});
