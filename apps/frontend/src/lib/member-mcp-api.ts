import {
  MemberMcpConnectionsResponseSchema, MemberMcpConnectionResponseSchema,
  MemberMcpCredentialRemoveResponseSchema,
  type MemberMcpCredentialSave, type MemberMcpCredentialRemove
} from "@cogniplane/shared-types";
import { request } from "./api-client";
import { parseResponse } from "./validate-response";

const path = "/me/mcp-connections";
const credentialsPath = (serverId: string) => `${path}/${encodeURIComponent(serverId)}/credentials`;

export async function getMemberMcpConnections() {
  return parseResponse(MemberMcpConnectionsResponseSchema, await request<unknown>(path), `GET ${path}`);
}

export async function saveMemberMcpCredentials(serverId: string, input: MemberMcpCredentialSave) {
  const url = credentialsPath(serverId);
  return parseResponse(MemberMcpConnectionResponseSchema,
    await request<unknown>(url, { method: "PUT", body: JSON.stringify(input) }), `PUT ${url}`);
}

export async function removeMemberMcpCredentials(serverId: string, input: MemberMcpCredentialRemove) {
  const url = credentialsPath(serverId);
  return parseResponse(MemberMcpCredentialRemoveResponseSchema,
    await request<unknown>(url, { method: "DELETE", body: JSON.stringify(input) }), `DELETE ${url}`);
}
