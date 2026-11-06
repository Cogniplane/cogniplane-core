import type { FastifyInstance } from "fastify";

import { attachGithubConnector } from "../integrations/github/github-connector.js";
import { attachNotionConnector } from "../integrations/notion/notion-connector.js";
import { attachJiraConnector } from "../integrations/pipedream/jira-connector.js";
import type { BuiltinConnectorHandles, BuiltinConnectorInput } from "./connector-module.js";

// Attach the built-in connector modules for one app. Called once per
// `buildAppDependencies()`, before the overlays.
//
// Keep this order. It sets the order of the connector managed-tool factories,
// and so the order of the MCP `tools/list` response (see
// `register-builtin-managed-tools.ts`). The integration list order comes from
// the static catalog in `register-builtin-integrations.ts`.
export function attachBuiltinConnectors(input: BuiltinConnectorInput) {
  const github = attachGithubConnector(input);
  const connectors: BuiltinConnectorHandles[] = [
    github,
    attachNotionConnector(input),
    attachJiraConnector(input)
  ];

  return {
    attachRoutes: async (app: FastifyInstance): Promise<void> => {
      for (const connector of connectors) await connector.attachRoutes(app);
    },
    githubConnections: github.services.connections
  };
}

export type BuiltinConnectors = ReturnType<typeof attachBuiltinConnectors>;
