import { computeConfigHash, unique } from "../lib/crypto-utils.js";

import { AdminConfigError } from "./admin-config-error.js";

import type { AdminMcpServerRecord } from "./admin-config-records.js";
import type { McpServerStore } from "./mcp-server-store.js";

function validateMcpServerInput(input: {
  mode: "managed" | "proxy";
  routePath: string;
  upstreamUrl: string | null;
}): void {
  if (!input.routePath.startsWith("/mcp/")) {
    throw new AdminConfigError("routePath must start with /mcp/.");
  }

  if (input.mode === "proxy" && !input.upstreamUrl) {
    throw new AdminConfigError("Proxy MCP servers require an upstreamUrl.");
  }
}

export type CreateMcpServerPayload = {
  serverId: string;
  serverName: string;
  description: string | null;
  transportKind: "http";
  mode: "managed" | "proxy";
  routePath: string;
  upstreamUrl: string | null;
  headersAllowlist: string[];
  enabled: boolean;
  actorUserId: string;
};

export type UpdateMcpServerPayload = {
  serverId: string;
  serverName: string;
  description: string | null;
  transportKind: "http";
  mode: "managed" | "proxy";
  routePath: string;
  upstreamUrl: string | null;
  headersAllowlist: string[];
  enabled: boolean;
};

export async function createMcpServer(input: {
  tenantId: string;
  store: McpServerStore;
  payload: CreateMcpServerPayload;
}): Promise<AdminMcpServerRecord> {
  validateMcpServerInput(input.payload);

  return input.store.createMcpServer(input.tenantId, {
    ...input.payload,
    createdBy: input.payload.actorUserId,
    configHash: computeConfigHash({
      serverId: input.payload.serverId,
      serverName: input.payload.serverName,
      description: input.payload.description,
      transportKind: input.payload.transportKind,
      mode: input.payload.mode,
      routePath: input.payload.routePath,
      upstreamUrl: input.payload.upstreamUrl,
      headersAllowlist: unique(input.payload.headersAllowlist)
    })
  });
}

export async function updateMcpServer(input: {
  tenantId: string;
  store: McpServerStore;
  payload: UpdateMcpServerPayload;
}): Promise<AdminMcpServerRecord | null> {
  validateMcpServerInput(input.payload);

  return input.store.updateMcpServer(input.tenantId, {
    ...input.payload,
    headersAllowlist: unique(input.payload.headersAllowlist),
    configHash: computeConfigHash({
      serverId: input.payload.serverId,
      serverName: input.payload.serverName,
      description: input.payload.description,
      transportKind: input.payload.transportKind,
      mode: input.payload.mode,
      routePath: input.payload.routePath,
      upstreamUrl: input.payload.upstreamUrl,
      headersAllowlist: unique(input.payload.headersAllowlist)
    })
  });
}
