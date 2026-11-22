import {
  MemberMcpConnectionsResponseSchema, MemberMcpConnectionResponseSchema,
  MemberMcpCredentialRemoveResponseSchema,
  type MemberMcpCredentialSave, type MemberMcpCredentialRemove
} from "@cogniplane/shared-types";
import { requestJson } from "./api-client";

const path = "/me/mcp-connections";
const credentialsPath = (serverId: string) => `${path}/${encodeURIComponent(serverId)}/credentials`;

export async function getMemberMcpConnections() {
  return await requestJson(path, MemberMcpConnectionsResponseSchema);
}

export async function saveMemberMcpCredentials(serverId: string, input: MemberMcpCredentialSave) {
  const url = credentialsPath(serverId);
  return await requestJson(url, MemberMcpConnectionResponseSchema, { method: "PUT", body: JSON.stringify(input) });
}

export async function removeMemberMcpCredentials(serverId: string, input: MemberMcpCredentialRemove) {
  const url = credentialsPath(serverId);
  return await requestJson(url, MemberMcpCredentialRemoveResponseSchema, { method: "DELETE", body: JSON.stringify(input) });
}
