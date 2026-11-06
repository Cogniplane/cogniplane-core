import { GITHUB_INTEGRATION_DESCRIPTOR } from "./github/github-connector.js";
import {
  getIntegrationDescriptor,
  registerIntegration
} from "./integration-registry.js";
import { NOTION_INTEGRATION_DESCRIPTOR } from "./notion/notion-connector.js";
import { JIRA_INTEGRATION_DESCRIPTOR } from "./pipedream/jira-connector.js";

// The static catalog of built-in integrations. It holds data only: each app
// attaches its own live hooks through the connector modules
// (`services/connectors/builtin-connectors.ts`).
//
// Keep this order: it is the order of the integration lists. A connector
// module also registers its own descriptor when it is absent, the same as an
// overlay, so a module works without this function.
export function registerBuiltinIntegrations(): void {
  for (const descriptor of [
    NOTION_INTEGRATION_DESCRIPTOR,
    GITHUB_INTEGRATION_DESCRIPTOR,
    JIRA_INTEGRATION_DESCRIPTOR
  ]) {
    registerIntegrationIfAbsent(descriptor);
  }
  registerComingSoonIntegrations();
}

// Registry-state guard: the static catalog is process-wide, and each
// `buildAppDependencies()` calls this again.
function registerIntegrationIfAbsent(descriptor: Parameters<typeof registerIntegration>[0]): void {
  if (!getIntegrationDescriptor(descriptor.id)) registerIntegration(descriptor);
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
    registerIntegrationIfAbsent({
      ...entry,
      status: "coming_soon",
      readToolIds: [],
      writeToolIds: [],
      configMode: "none"
    });
  }
}
