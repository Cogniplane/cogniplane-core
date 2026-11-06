import type { AdminMcpServerRecord, McpServerRegistration, RuntimeSkillDefinition } from "../services/admin-config-records.js";
import { skillSource } from "../services/capability-selection.js";
import type { memberMcpStatuses } from "./member-mcp-status.js";

// Maps catalog entries to the skill and connector options of a capabilities
// response, in the order given. Callers choose the entries; the session route
// filters them by its defaults first.
export function capabilityOptions(input: {
  skills: readonly Pick<RuntimeSkillDefinition, "id" | "name" | "description" | "sourceType">[];
  mcpServers: readonly Pick<McpServerRegistration, "id" | "description">[];
  servers: readonly Pick<AdminMcpServerRecord, "serverId" | "serverName">[];
  connectionStatuses: Awaited<ReturnType<typeof memberMcpStatuses>>;
}) {
  const { servers, connectionStatuses } = input;
  return {
    skills: input.skills.map(s => ({ id: s.id, name: s.name, description: s.description ?? "",
      source: skillSource(s.sourceType) })),
    connectors: input.mcpServers.map(s => ({
      id: s.id,
      name: servers.find(server => server.serverId === s.id)?.serverName ?? s.id,
      description: s.description, ...connectionStatuses.get(s.id)
    }))
  };
}
