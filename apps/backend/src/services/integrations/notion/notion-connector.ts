import type { AppConfig } from "../../../config.js";
import {
  registerConnectorIntegration,
  registerConnectorTools,
  type BuiltinConnectorHandles,
  type BuiltinConnectorInput,
  type ConnectorCatalogDescriptor
} from "../../connectors/connector-module.js";
import { createNotionTools, NOTION_TOOL_CATALOG } from "../../managed-tools/notion-tools.js";
import { NotionConnectionService } from "./notion-connection-service.js";
import { NotionConnectionStore } from "./notion-connection-store.js";
import { NOTION_OAUTH_CALLBACK_PATHS, registerNotionOAuthRoutes } from "./notion-oauth-routes.js";
import { registerNotionSettingsRoutes } from "./notion-settings-routes.js";

// Policy Center category of every Notion tool, and the key of its factory.
const NOTION_TOOL_DOMAIN = "notion";

export const NOTION_INTEGRATION_DESCRIPTOR: ConnectorCatalogDescriptor = {
  id: "notion",
  name: "Notion",
  description: "Search, read, and update pages in connected Notion workspaces.",
  longDescription:
    "Each user connects their own Notion workspace via OAuth. The agent can search, fetch pages, query databases, create pages, update properties, and append blocks based on the toggles below.",
  logoSlug: "notion",
  status: "available",
  category: "Productivity",
  readToolIds: ["notion_search", "notion_fetch_page", "notion_query_database"],
  writeToolIds: ["notion_create_page", "notion_update_page", "notion_append_blocks"],
  configMode: "none",
  docsUrl: "https://developers.notion.com/docs/mcp",
  platformStatus: (config: AppConfig) =>
    config.NOTION_OAUTH_CLIENT_ID &&
    config.NOTION_OAUTH_CLIENT_SECRET &&
    config.NOTION_OAUTH_REDIRECT_URI
      ? { configured: true, message: null }
      : {
          configured: false,
          message:
            "Set NOTION_OAUTH_CLIENT_ID, NOTION_OAUTH_CLIENT_SECRET, and NOTION_OAUTH_REDIRECT_URI in the backend environment to enable Notion."
        },
  // The auth allowlist reads these paths before the app attaches its handler.
  oauthCallbackPaths: NOTION_OAUTH_CALLBACK_PATHS
};

export function registerNotionTools(
  registries: Pick<BuiltinConnectorInput, "managedToolCatalog" | "managedToolFactoryRegistry">,
  notionConnections: Pick<NotionConnectionService, "getRuntimeCredentials">
): void {
  registerConnectorTools(registries, NOTION_TOOL_DOMAIN, NOTION_TOOL_CATALOG, () =>
    createNotionTools({ notionConnections }));
}

export function attachNotionConnector(input: BuiltinConnectorInput): BuiltinConnectorHandles {
  const connections = new NotionConnectionService(
    input.config,
    new NotionConnectionStore(input.db),
    input.stores.auditEvents,
    input.runtimeInvalidator,
    input.oauthStates,
    input.logger
  );

  registerConnectorIntegration(input.integrationDescriptors, NOTION_INTEGRATION_DESCRIPTOR, {
    connectionProbe: connections,
    oauthRoutes: {
      paths: NOTION_OAUTH_CALLBACK_PATHS,
      register: (app) => registerNotionOAuthRoutes(app, connections, input.limits)
    }
  });
  registerNotionTools(input, connections);

  return {
    attachRoutes: (app) => registerNotionSettingsRoutes(app, {
      notionConnections: connections,
      loadIntegrationEnablement: input.loadIntegrationEnablement
    })
  };
}
