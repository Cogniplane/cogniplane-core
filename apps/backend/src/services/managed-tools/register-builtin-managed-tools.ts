import { type ManagedToolCatalog, type ManagedToolCatalogEntry } from "./catalog.js";
import { type ManagedToolFactoryRegistry } from "./factory.js";
import { createMemoryTools, MEMORY_TOOL_CATALOG } from "./memory-tools.js";
import { createSessionTools, SESSION_TOOL_CATALOG } from "./session-tools.js";
import { createSkillCorpusTool, SKILL_CORPUS_TOOL_CATALOG } from "./skill-corpus-tool.js";
import { createWriteArtifactTool, WRITE_ARTIFACT_CATALOG } from "./write-artifact.js";
import { createProjectTools, PROJECT_TOOL_CATALOG } from "./project-tools.js";
import { createInteractiveUiTool, INTERACTIVE_UI_CATALOG } from "./interactive-ui.js";
import type { ManagedToolAppResource } from "./types.js";

export type RawCatalogEntry = {
  name: string;
  description: string;
  readOnly: boolean;
  appResource?: ManagedToolAppResource;
  requiresUserApproval?: boolean;
};

export function asCatalogEntries(
  entries: ReadonlyArray<RawCatalogEntry>,
  tenantConfigurable: boolean,
  category: string
): ManagedToolCatalogEntry[] {
  return entries.map((entry) => ({
    name: entry.name,
    description: entry.description,
    readOnly: entry.readOnly,
    tenantConfigurable,
    category,
    ...(entry.appResource ? { appResource: entry.appResource } : {}),
    ...(entry.requiresUserApproval ? { requiresUserApproval: true } : {})
  }));
}

// Register the built-in managed tool catalog and the factories that come
// before the built-in connector modules. Called once per
// `buildAppDependencies()`.
//
// The factory order sets the order of the MCP `tools/list` response. The agent
// runtime loads its managed tools from that response. Keep this order:
//   1. `registerBuiltinManagedTools`: session, skill-corpus.
//   2. The built-in connector modules (`services/connectors/builtin-connectors.ts`):
//      github, notion, jira.
//   3. `registerBuiltinManagedToolsAfterConnectors`: write-artifact, project,
//      memory, interactive-ui.
//   4. Overlays.
//
// Connector and overlay tools are not registered here. Each registers its own
// catalog entries and a factory closure that captures its own services.
export function registerBuiltinManagedTools(
  catalog: ManagedToolCatalog,
  factoryRegistry: ManagedToolFactoryRegistry
): void {
  // tenantConfigurable=true: managed tools governed by the tenant Agent
  // settings picker (session_context, list_artifacts, write_artifact, ...).
  catalog.register(asCatalogEntries(SESSION_TOOL_CATALOG, true, "session"));
  catalog.register(asCatalogEntries(SKILL_CORPUS_TOOL_CATALOG, true, "skill-corpus"));
  catalog.register(asCatalogEntries(WRITE_ARTIFACT_CATALOG, true, "write-artifact"));
  catalog.register(asCatalogEntries(PROJECT_TOOL_CATALOG, true, "project"));
  catalog.register(asCatalogEntries(MEMORY_TOOL_CATALOG, true, "memory"));
  catalog.register(asCatalogEntries(INTERACTIVE_UI_CATALOG, true, "interactive-ui"));

  factoryRegistry.register("session", createSessionTools);
  factoryRegistry.register("skill-corpus", createSkillCorpusTool);
}

// Register the built-in factories that come after the built-in connector
// modules. See the order in `registerBuiltinManagedTools`.
export function registerBuiltinManagedToolsAfterConnectors(
  factoryRegistry: ManagedToolFactoryRegistry
): void {
  factoryRegistry.register("write-artifact", createWriteArtifactTool);
  factoryRegistry.register("project", (deps) => deps.projectFiles ? createProjectTools({
    projectFiles: deps.projectFiles,
    storage: deps.storage,
    readRuntimeFile: deps.readRuntimeFile,
    statRuntimeFile: deps.statRuntimeFile,
    maxProjectFileBytes: deps.artifactMaxBytes,
    limits: deps.limits
  }) : []);
  factoryRegistry.register("memory", createMemoryTools);
  factoryRegistry.register("interactive-ui", createInteractiveUiTool);
}
