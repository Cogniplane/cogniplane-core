import type { AppConfig } from "../../config.js";
import { proxySignatureSecret } from "../../lib/derived-secrets.js";
import { forwardRpc, type ForwardRpcLimits, type McpRpcRequest } from "../../lib/mcp-upstream-client.js";
import { signProxyHeaders } from "../../lib/mcp-proxy-signature.js";
import type { McpServerRegistration } from "../admin-config-records.js";

export function proxyUpstreamLimits(config: AppConfig, logger: ForwardRpcLimits["logger"]): ForwardRpcLimits {
  return {
    timeoutMs: config.MCP_UPSTREAM_TIMEOUT_MS,
    maxResponseBytes: config.MCP_UPSTREAM_MAX_RESPONSE_BYTES,
    logger
  };
}

export function forwardSignedProxyRpc(input: {
  server: McpServerRegistration;
  rpc: McpRpcRequest;
  tenantId: string;
  userId: string;
  sessionId: string;
  runtimeId: string;
  signingSecret: string;
  limits: ForwardRpcLimits;
}) {
  const { server, rpc, tenantId, userId, sessionId, runtimeId, signingSecret, limits } = input;
  if (!server.upstreamUrl) throw new Error("Proxy upstream is not configured");
  return forwardRpc(
    server.upstreamUrl,
    rpc,
    (body) => signProxyHeaders({ tenantId, serverId: server.id, userId, sessionId, runtimeId, body, secret: signingSecret }),
    undefined,
    { ...limits, serverId: server.id },
    server.upstreamAuth ?? null
  );
}

export function proxySigningSecret(config: AppConfig): string {
  return proxySignatureSecret(config.DATA_ENCRYPTION_SECRET, config.MCP_UPSTREAM_SIGNING_ROOT_SECRET);
}
