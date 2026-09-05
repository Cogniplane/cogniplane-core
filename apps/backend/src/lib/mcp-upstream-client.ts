// HTTP client for proxy-mode MCP upstreams. Owns the transport-level security
// posture of the MCP gateway's outbound calls: SSRF-safe DNS-pinned dispatch,
// manual redirect validation, and response decoding. The route module
// (routes/mcp.ts) stays focused on JSON-RPC authorization and policy.

import type { FastifyBaseLogger } from "fastify";
import { fetch as undiciFetch } from "undici";
import { z } from "zod";

import { isPrivateOrReservedHost, logSafeUrl, ssrfSafeAgent } from "./url-validation.js";

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

/**
 * Fallbacks used when a caller does not pass limits. Production always passes
 * them from config (MCP_UPSTREAM_TIMEOUT_MS / MCP_UPSTREAM_MAX_RESPONSE_BYTES);
 * these keep the defaults bounded for tests and any future call site rather
 * than silently reinstating "no limit".
 */
const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;
const DEFAULT_UPSTREAM_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export type ForwardRpcLimits = {
  /** Per-hop wall-clock budget. Applied per request, not to the redirect chain. */
  timeoutMs?: number;
  /** Hard cap on the decoded response body. */
  maxResponseBytes?: number;
  /**
   * Where the real transport error goes.
   *
   * The JSON-RPC error this function returns is deliberately a fixed string —
   * an upstream `ECONNREFUSED` naming an internal host must not reach the
   * model. But before this had a timeout the same failure escaped as a Fastify
   * 500 and Fastify's handler logged it, so collapsing it without a logger
   * would have traded a leak for a blind spot: an operator with a
   * misconfigured upstream URL would see a generic tool failure and find
   * nothing anywhere.
   */
  logger?: Pick<FastifyBaseLogger, "warn">;
  /**
   * The MCP server row's id, logged alongside the upstream origin.
   *
   * This is what identifies WHICH upstream failed. The logged URL is reduced
   * to its origin (see `logSafeUrl`), so two servers configured on one origin
   * are indistinguishable by URL alone — this id tells them apart, and unlike
   * a path it can never carry a credential.
   */
  serverId?: string;
  /**
   * Skip the first-hop private-address check. TEST ONLY.
   *
   * Integration tests run a real upstream on 127.0.0.1, which the check
   * correctly refuses. Production never sets this: the flag exists so the
   * guard can stay unconditional in the code path that matters, rather than
   * being softened to accommodate a fixture. Scheme and credential checks are
   * NOT skipped — only the address-range check the loopback fixture trips.
   */
  allowPrivateUpstreamForTests?: boolean;
};

/**
 * A JSON-RPC 2.0 response envelope. A proxy upstream is a third party: without
 * this, whatever it returned was handed to the model as a tool result — a bare
 * array, a string, an object with an `error` field shaped nothing like the
 * protocol. `passthrough` keeps unknown members (MCP extensions) intact.
 */
const upstreamResponseSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number(), z.null()]),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.number(),
        message: z.string()
      })
      .passthrough()
      .optional()
  })
  .passthrough();

/**
 * Read a response body with a hard byte cap, aborting the stream the moment it
 * is exceeded. `response.json()` would buffer the whole thing first, so a
 * hostile or broken upstream could OOM the shared backend with a multi-GB body
 * before any check ran. Returns null past the cap.
 */
async function readBodyWithLimit(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number
): Promise<string | null> {
  if (!body) return "";

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

/**
 * Node transport codes that are safe to log verbatim.
 *
 * These come from the OS socket layer (`error.cause.code`), name a failure
 * class rather than a request, and are what an operator actually acts on —
 * unlike the error message, which undici may compose from the request URL.
 * An unrecognised code is reported as "other" rather than passed through: the
 * allowlist is the guarantee, not the shape of the value.
 */
const LOGGABLE_TRANSPORT_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "EPROTO",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_OVERFLOW",
  "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
  "UND_ERR_RES_EXCEEDED_MAX_SIZE",
  "UND_ERR_ABORTED"
]);

/** Error constructor names reachable on this path. Anything else logs as "other". */
const LOGGABLE_ERROR_NAMES: ReadonlySet<string> = new Set([
  "Error",
  "TypeError",
  "TimeoutError",
  "AbortError",
  "RangeError",
  "SyntaxError",
  "DOMException"
]);

/**
 * Classify a rejection into two allowlisted strings.
 *
 * Wrapped in try/catch because neither input is guaranteed to be a plain
 * Error: `name`, `cause` and `cause.code` can each be a getter, and one that
 * throws here would escape into the caller's catch — where the default
 * handler logs the new error in full, reinstating the leak this function
 * exists to prevent. A classifier that cannot classify returns "unknown"
 * rather than failing the request.
 */
function classifyTransportError(error: unknown): { errorName: string; errorCode: string } {
  try {
    const name = error instanceof Error && typeof error.name === "string" ? error.name : "unknown";
    const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
    const rawCode = typeof cause?.code === "string" ? cause.code : undefined;
    const code = !rawCode ? "none" : LOGGABLE_TRANSPORT_CODES.has(rawCode) ? rawCode : "other";
    // `name` is allowlisted the same way the code is. On the real undici path
    // it is a fixed constructor name, but a custom transport could compose it
    // from the URL, and it is logged unfiltered.
    return {
      errorName: LOGGABLE_ERROR_NAMES.has(name) ? name : "other",
      errorCode: code
    };
  } catch {
    return { errorName: "unknown", errorCode: "unknown" };
  }
}

/**
 * POST a JSON-RPC request to a proxy MCP upstream.
 *
 * Every failure mode returns a JSON-RPC error rather than throwing. The caller
 * (`routes/mcp.ts` `handleForwardedToolCall`) invokes this outside its try
 * block, so a throw would escape as an HTTP 500 outside the JSON-RPC envelope,
 * which the runtime's MCP client cannot read as a tool failure. Messages are
 * fixed strings: an upstream `ECONNREFUSED` naming an internal host belongs in
 * the log, not in a model-visible tool result.
 */
export async function forwardRpc(
  upstreamUrl: string | null,
  payload: McpRpcRequest,
  headers: Record<string, string>,
  fetchFn: typeof undiciFetch = undiciFetch,
  limits: ForwardRpcLimits = {}
): Promise<McpRpcResponse> {
  if (!upstreamUrl) {
    return rpcFailure(payload.id, -32601, "MCP upstream is not configured.");
  }

  const timeoutMs = limits.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  const maxResponseBytes = limits.maxResponseBytes ?? DEFAULT_UPSTREAM_MAX_RESPONSE_BYTES;

  try {
    return await forwardRpcInner(
      upstreamUrl,
      payload,
      headers,
      fetchFn,
      timeoutMs,
      maxResponseBytes,
      limits.allowPrivateUpstreamForTests === true
    );
  } catch (error) {
    // AbortSignal.timeout rejects with a TimeoutError; everything else is a
    // transport fault. Both collapse to the same client-visible message — and
    // both are logged here, which is the only place they survive.
    //
    // The URL is reduced to origin + pathname first. It is admin-supplied, and
    // several MCP vendors authenticate by API key in the query string, so
    // logging it whole would write that credential into log retention on the
    // first upstream timeout. Central `redactSecrets()` does not help: it
    // covers tool results and persisted errors, not logger fields. Origin and
    // path are what an operator needs to identify which upstream failed.
    // Classified once, through the same guarded read the log record uses, so a
    // throwing `name` getter cannot escape between here and the response.
    const { errorName, errorCode } = classifyTransportError(error);
    const timedOut = errorName === "TimeoutError";
    limits.logger?.warn(
      {
        // Deliberately NOT the error object. An undici error message can quote
        // the request URL verbatim (a credentialed URL yields "Request cannot
        // be constructed from a URL that includes credentials: <full url>"),
        // and `message`/`stack` are non-enumerable — so a JSON-shaped redactor
        // cannot see the secret, while pino's error serializer prints it. Log
        // an allowlisted classification instead of anything the transport
        // composed from the URL.
        errorName,
        errorCode,
        upstreamOrigin: logSafeUrl(upstreamUrl),
        serverId: limits.serverId,
        method: payload.method,
        timedOut
      },
      "Proxy MCP upstream request failed"
    );
    return rpcFailure(
      payload.id,
      -32000,
      timedOut
        ? `Upstream MCP request timed out after ${timeoutMs}ms.`
        : "Upstream MCP request failed."
    );
  }
}

/**
 * Discard a response body we are not going to read.
 *
 * Undici keeps the connection allocated until the body is consumed or
 * cancelled, so a redirect or an error response that we return early on would
 * otherwise pin a socket — and let a hostile upstream stream an unbounded body
 * on a path with no cap. Best-effort by design: failing to drain must not
 * change the outcome we already decided.
 */
async function discardBody(response: { body?: unknown }): Promise<void> {
  const body = response.body as ReadableStream<Uint8Array> | null | undefined;
  if (!body) return;
  try {
    await body.cancel();
  } catch {
    // Already closed or errored; nothing to release.
  }
}

async function forwardRpcInner(
  upstreamUrl: string,
  payload: McpRpcRequest,
  headers: Record<string, string>,
  fetchFn: typeof undiciFetch,
  timeoutMs: number,
  maxResponseBytes: number,
  allowPrivateUpstreamForTests: boolean
): Promise<McpRpcResponse> {
  let currentUrl: URL;
  try {
    currentUrl = new URL(upstreamUrl);
  } catch {
    return rpcFailure(payload.id, -32000, "Upstream MCP URL is invalid.");
  }

  // Re-validate the FIRST hop, not only redirects.
  //
  // The admin route and the persistence boundary both reject these already, so
  // this is defence in depth — but it is the layer that does not depend on
  // every stored row having passed through today's write path. A row written
  // before those checks existed, or inserted directly against the database,
  // otherwise goes straight to the socket: `upstream_url` is read back and
  // dispatched with no validation in between.
  //
  // A literal IP is the case that makes this load-bearing rather than
  // theoretical. undici skips the connect-time DNS hook entirely for literal
  // addresses (verified), so `http://127.0.0.1/...` is seen by NO other guard
  // on this path — not the schema (already written), not ssrfSafeLookup
  // (never consulted).
  if (currentUrl.protocol !== "https:" && currentUrl.protocol !== "http:") {
    return rpcFailure(payload.id, -32000, "Upstream MCP URL must use HTTP(S).");
  }
  if (currentUrl.username !== "" || currentUrl.password !== "") {
    return rpcFailure(payload.id, -32000, "Upstream MCP URL must not embed credentials.");
  }
  if (!allowPrivateUpstreamForTests && isPrivateOrReservedHost(currentUrl.hostname)) {
    return rpcFailure(
      payload.id,
      -32000,
      "Upstream MCP URL points to a private or reserved address."
    );
  }

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
      dispatcher: ssrfSafeAgent,
      // Per hop, not per chain: the redirect cap already bounds the number of
      // hops, and a per-hop budget is the one an operator can reason about
      // against a single upstream's latency.
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (response.status >= 300 && response.status < 400) {
      await discardBody(response);
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
      // A redirect target is built from a Location header, so it never passed
      // through `httpsUrlSchema` the way the configured upstream did. Without
      // this check a same-origin redirect can reintroduce userinfo that the
      // write-time validation rejects — and undici's refusal to send it throws
      // a TypeError echoing the whole URL, query string included.
      if (nextUrl.username !== "" || nextUrl.password !== "") {
        return rpcFailure(payload.id, -32000, "Upstream MCP redirect must not embed credentials.");
      }
      // A redirect target is built from a Location header, so it never passed
      // through `httpsUrlSchema` the way the configured upstream did. Without
      // this check a same-origin redirect can reintroduce userinfo that the
      // write-time validation rejects — and undici's refusal to send it throws
      // a TypeError echoing the whole URL, query string included.
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
      // The error body is never surfaced (it would carry upstream internals
      // into a model-visible message), so drain it rather than leaving a
      // hostile upstream free to stream into an unread socket.
      await discardBody(response);
      return rpcFailure(payload.id, -32000, `Upstream MCP request failed with ${response.status}.`);
    }

    const body = await readBodyWithLimit(
      response.body as ReadableStream<Uint8Array> | null,
      maxResponseBytes
    );
    if (body === null) {
      return rpcFailure(
        payload.id,
        -32000,
        `Upstream MCP response exceeded the maximum size of ${maxResponseBytes} bytes.`
      );
    }

    if (body.length === 0) {
      return rpcFailure(payload.id, -32000, "Upstream MCP returned an empty response.");
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(body);
    } catch {
      return rpcFailure(payload.id, -32000, "Upstream MCP response was not valid JSON.");
    }

    const parsed = upstreamResponseSchema.safeParse(decoded);
    if (!parsed.success) {
      return rpcFailure(
        payload.id,
        -32000,
        "Upstream MCP response was not a valid JSON-RPC envelope."
      );
    }

    return parsed.data as McpRpcResponse;
  }

  return rpcFailure(payload.id, -32000, "Upstream MCP request exceeded the redirect limit.");
}
