import type { MemberMcpCredentialStore } from "../services/member-mcp-credential-store.js";

export type MemberMcpStatusStore = Pick<MemberMcpCredentialStore, "list">;

export async function memberMcpStatuses(store: MemberMcpStatusStore | undefined, tenantId: string, userId: string) {
  const connections = store ? await store.list(tenantId, userId) : [];
  return new Map(connections.map(connection => [connection.serverId, {
    connectionStatus: connection.status, accountLabel: connection.accountLabel
  }]));
}
