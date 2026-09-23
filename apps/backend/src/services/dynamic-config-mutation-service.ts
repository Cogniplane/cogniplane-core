import { isReservedMcpUpstreamHeader } from "../lib/mcp-upstream-client.js";
import { httpsUrlSchema } from "../lib/url-validation.js";

import { AdminConfigError } from "./admin-config-error.js";

import type { AdminMcpServerRecord } from "./admin-config-records.js";
import type { McpServerStore } from "./mcp-server-store.js";

const UPSTREAM_AUTH_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

function validateMcpServerInput(input: {
  mode: "managed" | "proxy";
  routePath: string;
  upstreamUrl?: string | null;
  upstreamAuthType?: AdminMcpServerRecord["upstreamAuthType"];
  upstreamAuthName?: string | null;
  upstreamAuthSecret?: string | null;
}, options: { requireUrlAndSecret: boolean }): void {
  if (!input.routePath.startsWith("/mcp/")) {
    throw new AdminConfigError("routePath must start with /mcp/.");
  }

  if (input.mode === "proxy" && options.requireUrlAndSecret && !input.upstreamUrl) {
    throw new AdminConfigError("Proxy MCP servers require an upstreamUrl.");
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
    if (options.requireUrlAndSecret && !input.upstreamAuthSecret) {
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

  // Re-run the SAME schema the admin route applies, not a hand-picked subset
  // of it. This is the persistence boundary — the store below takes a bare
  // string — so a caller that does not go through the HTTP route must still be
  // held to the whole policy: https-only, no private or reserved address, no
  // embedded credentials. Duplicating only the credential check here would
  // leave this path SSRF-capable while looking validated.
  if (input.upstreamUrl && !httpsUrlSchema.safeParse(input.upstreamUrl).success) {
    throw new AdminConfigError(
      "upstreamUrl must be an https URL, must not point to a private or reserved address, " +
        "and must not carry credentials."
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
  enabled: boolean;
};

export async function createMcpServer(input: {
  tenantId: string;
  store: Pick<McpServerStore, "createMcpServer">;
  payload: CreateMcpServerPayload;
}): Promise<AdminMcpServerRecord> {
  validateMcpServerInput(input.payload, { requireUrlAndSecret: true });

  return input.store.createMcpServer(input.tenantId, {
    ...input.payload,
    createdBy: input.payload.actorUserId
  });
}

export async function updateMcpServer(input: {
  tenantId: string;
  store: Pick<McpServerStore, "updateMcpServer">;
  payload: UpdateMcpServerPayload;
}): Promise<AdminMcpServerRecord | null> {
  validateMcpServerInput(input.payload, { requireUrlAndSecret: false });

  return input.store.updateMcpServer(input.tenantId, input.payload);
}
