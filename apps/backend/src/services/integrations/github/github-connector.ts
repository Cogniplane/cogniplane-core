import type { AppConfig } from "../../../config.js";
import {
  registerConnectorIntegration,
  registerConnectorTools,
  type BuiltinConnectorHandles,
  type BuiltinConnectorInput,
  type ConnectorCatalogDescriptor
} from "../../connectors/connector-module.js";
import { createGithubTools, GITHUB_TOOL_CATALOG } from "../../managed-tools/github-tools.js";
import { GithubConnectionService } from "./github-connection-service.js";
import { GithubConnectionStore } from "./github-connection-store.js";
import { GITHUB_OAUTH_CALLBACK_PATHS, registerGithubOAuthRoutes } from "./github-oauth-routes.js";
import { registerGithubSettingsRoutes } from "./github-settings-routes.js";

// Policy Center category of every GitHub tool, and the key of its factory.
const GITHUB_TOOL_DOMAIN = "github";

export const GITHUB_INTEGRATION_DESCRIPTOR: ConnectorCatalogDescriptor = {
  id: "github",
  name: "GitHub",
  description: "Read and write files, open PRs in connected repositories.",
  longDescription:
    "Each user connects their own GitHub account via OAuth. The agent can read files, write files, and open pull requests, but only in the repositories that the user selects in their GitHub settings. Until the user selects a repository, the agent cannot use any.",
  logoSlug: "github",
  status: "available",
  category: "Code",
  readToolIds: ["github_read_file"],
  writeToolIds: ["github_write_file", "github_create_pr"],
  configMode: "none",
  docsUrl: "https://docs.github.com/en/apps/oauth-apps",
  platformStatus: (config: AppConfig) =>
    config.GITHUB_OAUTH_CLIENT_ID &&
    config.GITHUB_OAUTH_CLIENT_SECRET &&
    config.GITHUB_OAUTH_REDIRECT_URI
      ? { configured: true, message: null }
      : {
          configured: false,
          message:
            "Set GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET, and GITHUB_OAUTH_REDIRECT_URI in the backend environment to enable GitHub."
        },
  // The auth allowlist reads these paths before the app attaches its handler.
  oauthCallbackPaths: GITHUB_OAUTH_CALLBACK_PATHS
};

export type GithubConnectorHandles = BuiltinConnectorHandles & {
  // Core routes that are not GitHub routes read this service: the tenant
  // details response and the admin skill import, which uses the admin's
  // GitHub token.
  services: { connections: GithubConnectionService };
};

export function registerGithubTools(
  registries: Pick<BuiltinConnectorInput, "managedToolCatalog" | "managedToolFactoryRegistry">,
  githubConnections: Pick<GithubConnectionService, "getRuntimeCredentials">
): void {
  registerConnectorTools(registries, GITHUB_TOOL_DOMAIN, GITHUB_TOOL_CATALOG, () =>
    createGithubTools({ githubConnections }));
}

export function attachGithubConnector(input: BuiltinConnectorInput): GithubConnectorHandles {
  const connections = new GithubConnectionService(
    input.config,
    new GithubConnectionStore(input.db),
    input.stores.auditEvents,
    input.runtimeInvalidator,
    input.oauthStates,
    input.logger
  );

  registerConnectorIntegration(input.integrationDescriptors, GITHUB_INTEGRATION_DESCRIPTOR, {
    connectionProbe: connections,
    oauthRoutes: {
      paths: GITHUB_OAUTH_CALLBACK_PATHS,
      register: (app) => registerGithubOAuthRoutes(app, connections, input.limits)
    }
  });
  registerGithubTools(input, connections);

  return {
    attachRoutes: (app) => registerGithubSettingsRoutes(app, {
      githubConnections: connections,
      loadIntegrationEnablement: input.loadIntegrationEnablement
    }),
    services: { connections }
  };
}
