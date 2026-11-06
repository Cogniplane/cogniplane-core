import type { AppConfig } from "../../../config.js";
import {
  registerConnectorIntegration,
  registerConnectorTools,
  type BuiltinConnectorHandles,
  type BuiltinConnectorInput,
  type ConnectorCatalogDescriptor
} from "../../connectors/connector-module.js";
import { createJiraTools, JIRA_READ_TOOL_IDS, JIRA_TOOL_CATALOG } from "../../managed-tools/jira-tools.js";
import { registerJiraConnectionRoutes } from "./jira-connection-routes.js";
import { JiraConnectionService } from "./jira-connection-service.js";
import { JiraConnectionStore } from "./jira-connection-store.js";
import { readPipedreamSettings } from "./pipedream-client.js";

// Policy Center category of every Jira tool, and the key of its factory.
const JIRA_TOOL_DOMAIN = "jira";

export const JIRA_INTEGRATION_DESCRIPTOR: ConnectorCatalogDescriptor = {
  id: "jira",
  name: "Jira",
  description: "Search issues and read issue details and history in Jira Cloud.",
  longDescription:
    "Each user connects their own Jira Cloud account through Pipedream Connect and selects one Jira site. The agent can list sites, search issues with JQL, read issue details, and read issue change history. Read-only: the agent cannot create, edit, or comment on issues.",
  logoSlug: "jira",
  status: "available",
  category: "Productivity",
  readToolIds: [...JIRA_READ_TOOL_IDS],
  writeToolIds: [],
  configMode: "none",
  docsUrl: "https://pipedream.com/docs/connect",
  platformStatus: (config: AppConfig) =>
    readPipedreamSettings(config)
      ? { configured: true, message: null }
      : {
          configured: false,
          message:
            "Set PIPEDREAM_CLIENT_ID, PIPEDREAM_CLIENT_SECRET, and PIPEDREAM_PROJECT_ID in the backend environment to enable Jira."
        }
};

export function registerJiraTools(
  registries: Pick<BuiltinConnectorInput, "managedToolCatalog" | "managedToolFactoryRegistry">,
  jiraConnections: Pick<JiraConnectionService, "read">
): void {
  registerConnectorTools(registries, JIRA_TOOL_DOMAIN, JIRA_TOOL_CATALOG, () =>
    createJiraTools({ jiraConnections }));
}

export function attachJiraConnector(input: BuiltinConnectorInput): BuiltinConnectorHandles {
  const connections = new JiraConnectionService(
    input.config,
    new JiraConnectionStore(input.db),
    input.stores.integrationStates,
    input.stores.auditEvents,
    input.runtimeInvalidator,
    input.logger
  );

  // Pipedream hosts the Jira authorization callback, so there is no OAuth route.
  registerConnectorIntegration(input.integrationDescriptors, JIRA_INTEGRATION_DESCRIPTOR, {
    connectionProbe: connections
  });
  registerJiraTools(input, connections);

  return {
    attachRoutes: (app) => registerJiraConnectionRoutes(app, {
      jiraConnections: connections,
      integrationStates: input.stores.integrationStates,
      config: input.config
    })
  };
}
