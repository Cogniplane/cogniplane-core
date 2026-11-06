import type { GithubConnectionService } from "../services/integrations/github/github-connection-service.js";
import { registerGithubTools } from "../services/integrations/github/github-connector.js";
import type { NotionConnectionService } from "../services/integrations/notion/notion-connection-service.js";
import { registerNotionTools } from "../services/integrations/notion/notion-connector.js";
import type { JiraConnectionService } from "../services/integrations/pipedream/jira-connection-service.js";
import { registerJiraTools } from "../services/integrations/pipedream/jira-connector.js";
import type { ManagedToolCatalog } from "../services/managed-tools/catalog.js";
import type { ManagedToolFactoryRegistry } from "../services/managed-tools/factory.js";
import {
  registerBuiltinManagedTools,
  registerBuiltinManagedToolsAfterConnectors
} from "../services/managed-tools/register-builtin-managed-tools.js";

export type TestConnectorConnections = {
  github?: Pick<GithubConnectionService, "getRuntimeCredentials">;
  notion?: Pick<NotionConnectionService, "getRuntimeCredentials">;
  jira?: Pick<JiraConnectionService, "read">;
};

// Registers every built-in managed tool in the production order: core tools,
// then the built-in connector tools, then the remaining core tools. Without a
// fake, a connector has no stored connection.
export function registerAllBuiltinManagedTools(
  catalog: ManagedToolCatalog,
  factoryRegistry: ManagedToolFactoryRegistry,
  connections: TestConnectorConnections = {}
): void {
  const registries = { managedToolCatalog: catalog, managedToolFactoryRegistry: factoryRegistry };
  registerBuiltinManagedTools(catalog, factoryRegistry);
  registerGithubTools(registries, connections.github ?? { async getRuntimeCredentials() { return null; } });
  registerNotionTools(registries, connections.notion ?? { async getRuntimeCredentials() { return null; } });
  registerJiraTools(registries, connections.jira ?? {
    async read() { return { ok: false as const, error: "No Jira connection found." }; }
  });
  registerBuiltinManagedToolsAfterConnectors(factoryRegistry);
}
