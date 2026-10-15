import type { AppConfig } from "../../config.js";
import type { GithubConnectionService } from "./github/github-connection-service.js";
import {
  GITHUB_OAUTH_CALLBACK_PATHS,
  registerGithubOAuthRoutes
} from "./github/github-oauth-routes.js";
import {
  registerIntegration,
  type IntegrationRegistry,
  type IntegrationConnectionProbe,
  type IntegrationOAuthRoutes
} from "./integration-registry.js";
import type { NotionConnectionService } from "./notion/notion-connection-service.js";
import {
  NOTION_OAUTH_CALLBACK_PATHS,
  registerNotionOAuthRoutes
} from "./notion/notion-oauth-routes.js";
import type { RequestLimitsInterface } from "../request-limits.js";
import { JIRA_READ_TOOL_IDS } from "../managed-tools/jira-tools.js";
import { readPipedreamSettings } from "./pipedream/pipedream-client.js";

// The catalog contains static descriptors. Each app attaches its own live hooks.

export type BuiltinIntegrationProbes = {
  notion?: IntegrationConnectionProbe;
  github?: IntegrationConnectionProbe;
  jira?: IntegrationConnectionProbe;
};

export type BuiltinIntegrationOAuthCallbacks = {
  notion?: Pick<NotionConnectionService, "completeAuthorization">;
  github?: Pick<GithubConnectionService, "completeAuthorization">;
};

export type AttachBuiltinIntegrationRuntimeOptions = {
  probes?: BuiltinIntegrationProbes;
  oauth?: BuiltinIntegrationOAuthCallbacks;
  /** Rate limiter for the unauthenticated OAuth callback routes (per-IP). */
  limits?: RequestLimitsInterface;
};

let descriptorsRegistered = false;

export function registerBuiltinIntegrations(): void {
  if (descriptorsRegistered) return;
  descriptorsRegistered = true;

  registerNotionDescriptor();
  registerGithubDescriptor();
  registerJiraDescriptor();
  registerComingSoonIntegrations();
}

export function attachBuiltinIntegrationRuntime(
  registry: IntegrationRegistry,
  options: AttachBuiltinIntegrationRuntimeOptions = {}
): void {
  const probes = options.probes ?? {};
  const oauth = options.oauth ?? {};

  registry.setRuntimeWiring("notion", {
    connectionProbe: probes.notion,
    oauthRoutes: buildNotionOAuthRoutes(oauth.notion, options.limits)
  });
  registry.setRuntimeWiring("github", {
    connectionProbe: probes.github,
    oauthRoutes: buildGithubOAuthRoutes(oauth.github, options.limits)
  });
  // Pipedream hosts the Jira authorization callback, so there is no OAuth route.
  registry.setRuntimeWiring("jira", { connectionProbe: probes.jira });
}

function buildNotionOAuthRoutes(
  callbackHandler: Pick<NotionConnectionService, "completeAuthorization"> | undefined,
  limits?: RequestLimitsInterface
): IntegrationOAuthRoutes {
  return {
    paths: NOTION_OAUTH_CALLBACK_PATHS,
    register: callbackHandler
      ? (app) => registerNotionOAuthRoutes(app, callbackHandler, limits)
      : () => {}
  };
}

function buildGithubOAuthRoutes(
  callbackHandler: Pick<GithubConnectionService, "completeAuthorization"> | undefined,
  limits?: RequestLimitsInterface
): IntegrationOAuthRoutes {
  return {
    paths: GITHUB_OAUTH_CALLBACK_PATHS,
    register: callbackHandler
      ? (app) => registerGithubOAuthRoutes(app, callbackHandler, limits)
      : () => {}
  };
}

function registerNotionDescriptor(): void {
  registerIntegration({
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
    // Live wiring (probe + OAuth handler) attached later via
    // `attachBuiltinIntegrationRuntime`. The OAuth route paths are
    // stamped on now so the auth middleware allowlist is correct even
    // before any handler is bound.
    oauthCallbackPaths: NOTION_OAUTH_CALLBACK_PATHS
  });
}

function registerGithubDescriptor(): void {
  registerIntegration({
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
    oauthCallbackPaths: GITHUB_OAUTH_CALLBACK_PATHS
  });
}

function registerJiraDescriptor(): void {
  registerIntegration({
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
  });
}

function registerComingSoonIntegrations(): void {
  const comingSoon: Array<{
    id: string;
    name: string;
    description: string;
    longDescription: string;
    logoSlug: string;
    category: string;
  }> = [
    {
      id: "linear",
      name: "Linear",
      description: "Create and update issues in your Linear workspace.",
      longDescription:
        "Coming soon. The agent will be able to search issues, create new ones, update status, and link related work.",
      logoSlug: "linear",
      category: "Productivity"
    },
    {
      id: "slack",
      name: "Slack",
      description: "Read channels and post messages on your behalf.",
      longDescription:
        "Coming soon. Each user connects their own Slack workspace; the agent can search messages, summarize threads, and post replies.",
      logoSlug: "slack",
      category: "Communication"
    },
    {
      id: "confluence",
      name: "Confluence",
      description: "Search pages and create new pages in Confluence spaces.",
      longDescription: "Coming soon.",
      logoSlug: "confluence",
      category: "Productivity"
    },
    {
      id: "asana",
      name: "Asana",
      description: "Read tasks and create new ones in Asana projects.",
      longDescription: "Coming soon.",
      logoSlug: "asana",
      category: "Productivity"
    },
    {
      id: "salesforce",
      name: "Salesforce",
      description: "Query records and create updates in Salesforce.",
      longDescription: "Coming soon.",
      logoSlug: "salesforce",
      category: "CRM"
    },
    {
      id: "hubspot",
      name: "HubSpot",
      description: "Read CRM data and create contacts/companies/deals.",
      longDescription: "Coming soon.",
      logoSlug: "hubspot",
      category: "CRM"
    },
    {
      id: "google-drive",
      name: "Google Drive",
      description: "Browse and read files from Google Drive.",
      longDescription: "Coming soon.",
      logoSlug: "googledrive",
      category: "Productivity"
    },
    {
      id: "gmail",
      name: "Gmail",
      description: "Search messages and draft emails on your behalf.",
      longDescription: "Coming soon.",
      logoSlug: "gmail",
      category: "Communication"
    },
    {
      id: "google-calendar",
      name: "Google Calendar",
      description: "Read events and schedule meetings.",
      longDescription: "Coming soon.",
      logoSlug: "googlecalendar",
      category: "Productivity"
    }
  ];

  for (const entry of comingSoon) {
    registerIntegration({
      ...entry,
      status: "coming_soon",
      readToolIds: [],
      writeToolIds: [],
      configMode: "none"
    });
  }
}

// Test-only: reset the idempotency guard.
export function __resetBuiltinIntegrationsRegistrationForTesting(): void {
  descriptorsRegistered = false;
}
