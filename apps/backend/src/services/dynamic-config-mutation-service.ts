import { isReservedMcpUpstreamHeader } from "../lib/mcp-upstream-client.js";
import { mcpUpstreamUrlSchema } from "../lib/url-validation.js";

import { AdminConfigError } from "./admin-config-error.js";

import type { PoolClient } from "pg";

import type { AdminMcpServerRecord } from "./admin-config-records.js";
import type { McpServerStore } from "./mcp-server-store.js";

const UPSTREAM_AUTH_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

export function validateMcpServerInput(input: {
  mode: "managed" | "proxy";
  routePath: string;
  upstreamUrl?: string | null;
  upstreamAuthType?: AdminMcpServerRecord["upstreamAuthType"];
  upstreamAuthName?: string | null;
  upstreamAuthSecret?: string | null;
  credentialScope?: AdminMcpServerRecord["credentialScope"];
}, options: { requireUrlAndSecret: boolean }): void {
  if (!input.routePath.startsWith("/mcp/")) {
    throw new AdminConfigError("routePath must start with /mcp/.");
  }

  if (input.mode === "proxy" && options.requireUrlAndSecret && !input.upstreamUrl) {
    throw new AdminConfigError("Proxy MCP servers require an upstreamUrl.");
  }

  if (input.mode === "managed" && input.upstreamUrl) {
    throw new AdminConfigError("Managed MCP servers cannot configure an upstreamUrl.");
  }
  if (input.credentialScope === "personal") {
    if (input.mode !== "proxy" || input.upstreamAuthType === "none") {
      throw new AdminConfigError("Personal credentials require an authenticated proxy.");
    }
    if (input.upstreamAuthSecret != null) {
      throw new AdminConfigError("Personal MCP connections cannot store a shared secret.");
    }
  }

  if (
    input.mode === "managed" &&
    ((input.upstreamAuthType && input.upstreamAuthType !== "none") ||
      input.upstreamAuthName ||
      input.upstreamAuthSecret)
  ) {
    throw new AdminConfigError("Managed MCP servers cannot configure upstream authentication.");
  }

  if (input.upstreamAuthType === "none") {
    if (input.upstreamAuthName || input.upstreamAuthSecret) {
      throw new AdminConfigError(
        "upstreamAuthName and upstreamAuthSecret require an upstreamAuthType."
      );
    }
  } else if (input.upstreamAuthType) {
    if (options.requireUrlAndSecret && input.credentialScope !== "personal" && !input.upstreamAuthSecret) {
      throw new AdminConfigError(
        "Proxy MCP upstream authentication requires a secret when first configured."
      );
    }
    if (input.upstreamAuthType === "bearer" && input.upstreamAuthName) {
      throw new AdminConfigError("Bearer authentication always uses the Authorization header.");
    }
    if (
      (input.upstreamAuthType === "header" || input.upstreamAuthType === "query") &&
      !input.upstreamAuthName
    ) {
      throw new AdminConfigError(
        `${input.upstreamAuthType} authentication requires upstreamAuthName.`
      );
    }
    if (input.upstreamAuthName && !UPSTREAM_AUTH_NAME.test(input.upstreamAuthName)) {
      throw new AdminConfigError("upstreamAuthName contains invalid characters.");
    }
    if (
      input.upstreamAuthType === "header" &&
      input.upstreamAuthName &&
      isReservedMcpUpstreamHeader(input.upstreamAuthName)
    ) {
      throw new AdminConfigError(
        `The ${input.upstreamAuthName} header is reserved by the MCP proxy transport.`
      );
    }
  }

  // Keep the route and persistence boundary on the same MCP URL policy.
  // The store takes a bare string, so callers outside HTTP still must not
  // write URL credentials into the plaintext upstream_url column.
  if (input.upstreamUrl && !mcpUpstreamUrlSchema.safeParse(input.upstreamUrl).success) {
    throw new AdminConfigError(
      "upstreamUrl must be an HTTP(S) URL and must not carry credentials."
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
  upstreamAuthType: AdminMcpServerRecord["upstreamAuthType"];
  upstreamAuthName: string | null;
  upstreamAuthSecret: string | null;
  credentialScope?: AdminMcpServerRecord["credentialScope"];
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
  upstreamUrl?: string | null;
  upstreamAuthType?: AdminMcpServerRecord["upstreamAuthType"];
  upstreamAuthName?: string | null;
  upstreamAuthSecret?: string | null;
  credentialScope?: AdminMcpServerRecord["credentialScope"];
  enabled: boolean;
};

export async function createMcpServer(input: {
  tenantId: string;
  store: Pick<McpServerStore, "createMcpServer">;
  payload: CreateMcpServerPayload;
  client?: PoolClient;
}): Promise<AdminMcpServerRecord> {
  validateMcpServerInput(input.payload, { requireUrlAndSecret: true });

  return input.store.createMcpServer(input.tenantId, {
    ...input.payload,
    createdBy: input.payload.actorUserId
  }, input.client);
}

export async function updateMcpServer(input: {
  tenantId: string;
  store: Pick<McpServerStore, "updateMcpServer">;
  payload: UpdateMcpServerPayload;
  client?: PoolClient;
}): Promise<AdminMcpServerRecord | null> {
  validateMcpServerInput(input.payload, { requireUrlAndSecret: false });

  return input.store.updateMcpServer(input.tenantId, input.payload, input.client);
}
