import { computeConfigHash } from "../lib/crypto-utils.js";
import { httpsUrlSchema } from "../lib/url-validation.js";

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

  // Re-run the SAME schema the admin route applies, not a hand-picked subset
  // of it. This is the persistence boundary — the store below takes a bare
  // string — so a caller that does not go through the HTTP route must still be
  // held to the whole policy: https-only, no private or reserved address, no
  // embedded credentials. Duplicating only the credential check here would
  // leave this path SSRF-capable while looking validated.
  if (input.upstreamUrl && !httpsUrlSchema.safeParse(input.upstreamUrl).success) {
    throw new AdminConfigError(
      "upstreamUrl must be an https URL, must not point to a private or reserved address, " +
        "and must not embed credentials."
    );
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
  enabled: boolean;
};

export async function createMcpServer(input: {
  tenantId: string;
  store: Pick<McpServerStore, "createMcpServer">;
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
      upstreamUrl: input.payload.upstreamUrl
    })
  });
}

export async function updateMcpServer(input: {
  tenantId: string;
  store: Pick<McpServerStore, "updateMcpServer">;
  payload: UpdateMcpServerPayload;
}): Promise<AdminMcpServerRecord | null> {
  validateMcpServerInput(input.payload);

  return input.store.updateMcpServer(input.tenantId, {
    ...input.payload,
    configHash: computeConfigHash({
      serverId: input.payload.serverId,
      serverName: input.payload.serverName,
      description: input.payload.description,
      transportKind: input.payload.transportKind,
      mode: input.payload.mode,
      routePath: input.payload.routePath,
      upstreamUrl: input.payload.upstreamUrl
    })
  });
}
