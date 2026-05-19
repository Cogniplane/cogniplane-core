import { type ManagedToolCatalog, type ManagedToolCatalogEntry } from "./catalog.js";
import { type ManagedToolFactoryRegistry } from "./factory.js";
import { createGithubTools, GITHUB_TOOL_CATALOG } from "./github-tools.js";
import { createNotionTools, NOTION_TOOL_CATALOG } from "./notion-tools.js";
import { createSessionTools, SESSION_TOOL_CATALOG } from "./session-tools.js";
import { createWriteArtifactTool, WRITE_ARTIFACT_CATALOG } from "./write-artifact.js";

type RawCatalogEntry = { name: string; description: string; readOnly: boolean };

function asCatalogEntries(
  entries: ReadonlyArray<RawCatalogEntry>,
  tenantConfigurable: boolean
): ManagedToolCatalogEntry[] {
  return entries.map((entry) => ({
    name: entry.name,
    description: entry.description,
    readOnly: entry.readOnly,
    tenantConfigurable
  }));
}

// Register every built-in managed tool catalog and factory on the supplied
// registry instances. Called once per `buildAppDependencies()`.
//
// Optional overlay tools are not registered here. They register themselves via
// their own bootstrap so they can capture any integration-specific services in
// a closure.
export function registerBuiltinManagedTools(
  catalog: ManagedToolCatalog,
  factoryRegistry: ManagedToolFactoryRegistry
): void {
  // tenantConfigurable=true: managed tools governed by the tenant Agent
  // settings picker (session_context, list_artifacts, write_artifact, ...).
  catalog.register(asCatalogEntries(SESSION_TOOL_CATALOG, true));
  catalog.register(asCatalogEntries(WRITE_ARTIFACT_CATALOG, true));

  // tenantConfigurable=false: integration-owned tools, gated by the
  // integrations system (tenant_integrations toggles + readiness).
  catalog.register(asCatalogEntries(GITHUB_TOOL_CATALOG, false));
  catalog.register(asCatalogEntries(NOTION_TOOL_CATALOG, false));

  factoryRegistry.register("session", createSessionTools);
  factoryRegistry.register("github", createGithubTools);
  factoryRegistry.register("notion", createNotionTools);
  factoryRegistry.register("write-artifact", createWriteArtifactTool);
}
