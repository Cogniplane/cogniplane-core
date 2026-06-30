// HTTP client for proxy-mode MCP upstreams. Owns the transport-level security
// posture of the MCP gateway's outbound calls: SSRF-safe DNS-pinned dispatch,
// manual redirect validation, and response decoding. The route module
// (routes/mcp.ts) stays focused on JSON-RPC authorization and policy.

import { fetch as undiciFetch } from "undici";

import { isPrivateOrReservedHost, ssrfSafeAgent } from "./url-validation.js";

export type McpRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
};

export type McpRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
};

export function rpcOk(id: string | number | undefined, result: unknown): McpRpcResponse {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    result
  };
}

export function rpcFailure(
  id: string | number | undefined,
  code: number,
  message: string
): McpRpcResponse {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message }
  };
}

const MAX_MCP_PROXY_REDIRECTS = 5;

export async function forwardRpc(
  upstreamUrl: string | null,
  payload: McpRpcRequest,
  headers: Record<string, string>,
  fetchFn: typeof undiciFetch = undiciFetch
): Promise<McpRpcResponse> {
  if (!upstreamUrl) {
    return rpcFailure(payload.id, -32601, "MCP upstream is not configured.");
  }

  let currentUrl = new URL(upstreamUrl);
  for (let hop = 0; hop <= MAX_MCP_PROXY_REDIRECTS; hop += 1) {
    // Manual redirect handling is security-critical: automatic fetch redirects
    // can downgrade HTTPS and replay signed identity headers + tool arguments
    // to an attacker-controlled target. The dispatcher still pins DNS on every
    // accepted hop to close the rebinding window.
    const response = await fetchFn(currentUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers
      },
      body: JSON.stringify(payload),
      redirect: "manual",
      dispatcher: ssrfSafeAgent
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return rpcFailure(payload.id, -32000, "Upstream MCP redirect did not include a location.");
      }

      let nextUrl: URL;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        return rpcFailure(payload.id, -32000, "Upstream MCP redirect location is invalid.");
      }
      if (nextUrl.protocol !== "https:") {
        return rpcFailure(payload.id, -32000, "Upstream MCP redirect must use HTTPS.");
      }
      if (isPrivateOrReservedHost(nextUrl.hostname)) {
        return rpcFailure(
          payload.id,
          -32000,
          "Upstream MCP redirect points to a private or reserved address."
        );
      }
      if (nextUrl.origin !== currentUrl.origin) {
        return rpcFailure(payload.id, -32000, "Upstream MCP cross-origin redirect is not allowed.");
      }
      currentUrl = nextUrl;
      continue;
    }

    if (!response.ok) {
      return rpcFailure(payload.id, -32000, `Upstream MCP request failed with ${response.status}.`);
    }

    return (await response.json()) as McpRpcResponse;
  }

  return rpcFailure(payload.id, -32000, "Upstream MCP request exceeded the redirect limit.");
}

/**
 * Picks the incoming request headers named in the MCP server's
 * `headersAllowlist` so they can be forwarded to the proxy upstream. Header
 * names are matched case-insensitively (Fastify lower-cases incoming header
 * keys). Two classes of header are reserved and dropped regardless of the
 * allowlist:
 *   - The framework's own signed identity headers (`X-Framework-*`), which are
 *     set separately and take priority so a caller can never spoof them.
 *   - Inbound credential headers. The request that reaches `/mcp` carries the
 *     gateway runtime token (`Authorization: Bearer rt_*`) plus any session
 *     cookies; reflecting those to a third-party proxy upstream would hand it a
 *     gateway credential it could replay against `/mcp` until expiry. These are
 *     NEVER forwardable, even if an admin lists them in `headersAllowlist`.
 */
export function selectAllowlistedHeaders(
  requestHeaders: Record<string, string | string[] | undefined>,
  allowlist: string[]
): Record<string, string> {
  const reservedLower = new Set(
    [
      "x-framework-user-id",
      "x-framework-session-id",
      "x-framework-runtime-id",
      "x-framework-timestamp",
      "x-framework-signature",
      // Inbound credentials — must never leak to a proxy upstream.
      "authorization",
      "proxy-authorization",
      "cookie",
      "x-api-key"
    ]
  );
  const selected: Record<string, string> = {};
  for (const name of allowlist) {
    const lower = name.toLowerCase();
    if (reservedLower.has(lower)) continue;
    const value = requestHeaders[lower];
    const resolved = Array.isArray(value) ? value[0] : value;
    if (typeof resolved === "string") {
      selected[name] = resolved;
    }
  }
  return selected;
}
