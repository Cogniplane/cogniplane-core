import type { McpConnection } from "@cogniplane/shared-types";
import type { McpServerRegistration, RuntimeSkillDefinition } from "../services/admin-config-records.js";
import { skillSource } from "../services/capability-selection.js";
import type { MemberMcpCredentialStore } from "../services/member-mcp-credential-store.js";

export type MemberMcpStatusStore = Pick<MemberMcpCredentialStore, "list">;

// Maps catalog entries to the skill and connector options of a capabilities
// response, in the order given. Callers choose the entries; the session route
// filters them by its defaults first.
export function capabilityOptions(input: {
  skills: readonly Pick<RuntimeSkillDefinition, "id" | "name" | "description" | "sourceType">[];
  mcpServers: readonly Pick<McpServerRegistration, "id" | "name" | "description" | "credentialScope">[];
  connections: readonly McpConnection[];
}) {
  const connections = new Map(input.connections.map(connection => [connection.serverId, connection]));
  return {
    skills: input.skills.map(s => ({ id: s.id, name: s.name, description: s.description ?? "",
      source: skillSource(s.sourceType) })),
    connectors: input.mcpServers.flatMap(server => {
      const connection = connections.get(server.id);
      if (server.credentialScope === "personal" && !connection?.canConnect) return [];
      const option = { id: server.id, name: server.name ?? server.id, description: server.description };
      if (!connection || connection.status === "unavailable" ||
          (server.credentialScope && server.credentialScope !== connection.credentialScope)) return [option];
      return [{
        ...option, connectionStatus: connection.status, accountLabel: connection.accountLabel,
        ...(connection.suspended ? { connectionSuspended: true } : {})
      }];
    })
  };
}
