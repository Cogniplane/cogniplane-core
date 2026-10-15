// HTTP client for proxy-mode MCP upstreams. Owns the transport-level security
// posture of the MCP gateway's outbound calls: manual same-origin redirect
// validation and response decoding. The route module
// (routes/mcp.ts) stays focused on JSON-RPC authorization and policy.

import type { FastifyBaseLogger } from "fastify";
import { createParser } from "eventsource-parser";
import { fetch as undiciFetch } from "undici";
import { z } from "zod";

import { logSafeUrl } from "./url-validation.js";

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

export type McpUpstreamAuth =
  | { type: "bearer"; secret: string }
  | { type: "header" | "query"; name: string; secret: string };

const RESERVED_AUTH_HEADERS = new Set([
  "accept",
  "connection",
  "content-length",
  "content-type",
  "host",
  "transfer-encoding",
  "x-forwarded-by",
  "x-framework-user-id",
  "x-framework-session-id",
  "x-framework-runtime-id",
  "x-framework-timestamp",
  "x-framework-signature"
]);

export function isReservedMcpUpstreamHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized.startsWith("x-framework-") || RESERVED_AUTH_HEADERS.has(normalized);
}

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
  /** Cancels the full request chain when the caller's overall budget expires. */
  signal?: AbortSignal;
  /** Safe transport facts for callers that need a connection diagnosis. */
  onDiagnostic?: (diagnostic: { kind: "http"; status: number } | { kind: "transport" }) => void;
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
export async function readBodyWithLimit(
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

type SseReadResult =
  | { kind: "response"; response: McpRpcResponse }
  | { kind: "too_large" | "invalid" | "empty" | "unsupported_request" };

/** Read SSE events until the response for this request arrives. */
async function readSseResponseWithLimit(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  requestId: string | number | undefined
): Promise<SseReadResult> {
  if (!body) return { kind: "empty" };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let lastCharWasCr = false;
  let result: SseReadResult | null = null;
  const parser = createParser({
    maxBufferSize: maxBytes,
    onError(error) {
      if (error.type === "max-buffer-size-exceeded") result = { kind: "too_large" };
    },
    onEvent(event) {
      // A priming event can contain an ID and an empty data field.
      if (result || event.data === "") return;
      let decoded: unknown;
      try {
        decoded = JSON.parse(event.data);
      } catch {
        result = { kind: "invalid" };
        return;
      }
      if (decoded && typeof decoded === "object" && "method" in decoded) {
        if ("id" in decoded) result = { kind: "unsupported_request" };
        return;
      }
      const parsed = upstreamResponseSchema.safeParse(decoded);
      if (!parsed.success || parsed.data.id !== requestId) {
        result = { kind: "invalid" };
        return;
      }
      result = { kind: "response", response: parsed.data as McpRpcResponse };
    }
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        const tail = decoder.decode();
        if (tail) {
          lastCharWasCr = tail.endsWith("\r");
          parser.feed(tail);
        }
        // The parser holds a final CR until it knows whether LF follows.
        if (lastCharWasCr) parser.feed("\n");
        return result ?? { kind: "empty" };
      }
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) return { kind: "too_large" };
      const text = decoder.decode(value, { stream: true });
      if (!text) continue;
      lastCharWasCr = text.endsWith("\r");
      parser.feed(text);
      if (result) return result;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
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
/**
 * Outbound headers, or a function that builds them from the serialized body.
 * Use the function form when a header must cover the exact bytes sent (the v2
 * proxy signature signs a hash of the body).
 */
export type ForwardRpcHeaders =
  | Record<string, string>
  | ((body: string) => Record<string, string>);

export async function forwardRpc(
  upstreamUrl: string | null,
  payload: McpRpcRequest,
  headers: ForwardRpcHeaders,
  fetchFn: typeof undiciFetch = undiciFetch,
  limits: ForwardRpcLimits = {},
  upstreamAuth: McpUpstreamAuth | null = null
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
      upstreamAuth,
      limits.signal,
      limits.onDiagnostic
    );
  } catch (error) {
    limits.onDiagnostic?.({ kind: "transport" });
    // AbortSignal.timeout rejects with a TimeoutError; everything else is a
    // transport fault. Both collapse to the same client-visible message — and
    // both are logged here, which is the only place they survive.
    //
    // The URL is reduced to its origin first. It is admin-supplied, so logging
    // it whole could write a legacy query or path credential into retention.
    // Central `redactSecrets()` does not help: it covers tool results and
    // persisted errors, not logger fields. The server id identifies the route.
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
  headersOrBuilder: ForwardRpcHeaders,
  fetchFn: typeof undiciFetch,
  timeoutMs: number,
  maxResponseBytes: number,
  upstreamAuth: McpUpstreamAuth | null,
  overallSignal?: AbortSignal,
  onDiagnostic?: ForwardRpcLimits["onDiagnostic"]
): Promise<McpRpcResponse> {
  let currentUrl: URL;
  try {
    currentUrl = new URL(upstreamUrl);
  } catch {
    return rpcFailure(payload.id, -32000, "Upstream MCP URL is invalid.");
  }

  // Recheck the scheme and embedded credentials for legacy or directly
  // inserted rows before sending a request.
  if (currentUrl.protocol !== "https:" && currentUrl.protocol !== "http:") {
    return rpcFailure(payload.id, -32000, "Upstream MCP URL must use HTTP(S).");
  }
  if (currentUrl.username !== "" || currentUrl.password !== "") {
    return rpcFailure(payload.id, -32000, "Upstream MCP URL must not embed credentials.");
  }

  // Serialize once. Every hop sends these same bytes, and a signed body hash in
  // `headers` covers exactly them.
  const requestBody = JSON.stringify(payload);
  const headers =
    typeof headersOrBuilder === "function" ? headersOrBuilder(requestBody) : headersOrBuilder;

  for (let hop = 0; hop <= MAX_MCP_PROXY_REDIRECTS; hop += 1) {
    if (overallSignal?.aborted) {
      return rpcFailure(payload.id, -32000, "Upstream MCP request timed out.");
    }
    // Manual redirects keep signed headers and tool arguments on the
    // configured origin. HTTP and private destinations are operator choices.
    const requestUrl = new URL(currentUrl);
    const requestHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      ...headers,
      Accept: "application/json, text/event-stream"
    };
    if (upstreamAuth?.type === "query") {
      requestUrl.searchParams.set(upstreamAuth.name, upstreamAuth.secret);
    } else if (upstreamAuth?.type === "bearer") {
      requestHeaders.Authorization = `Bearer ${upstreamAuth.secret}`;
    } else if (upstreamAuth?.type === "header") {
      if (isReservedMcpUpstreamHeader(upstreamAuth.name)) {
        return rpcFailure(payload.id, -32000, "Upstream MCP authentication is invalid.");
      }
      requestHeaders[upstreamAuth.name] = upstreamAuth.secret;
    }

    const response = await fetchFn(requestUrl, {
      method: "POST",
      headers: requestHeaders,
      body: requestBody,
      redirect: "manual",
      // Per hop, not per chain: the redirect cap already bounds the number of
      // hops, and a per-hop budget is the one an operator can reason about
      // against a single upstream's latency.
      signal: overallSignal
        ? AbortSignal.any([AbortSignal.timeout(timeoutMs), overallSignal])
        : AbortSignal.timeout(timeoutMs)
    });
    onDiagnostic?.({ kind: "http", status: response.status });

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
      if (nextUrl.protocol !== "https:" && nextUrl.protocol !== "http:") {
        return rpcFailure(payload.id, -32000, "Upstream MCP redirect must use HTTP(S).");
      }
      // A redirect target bypasses the admin URL schema. Reject userinfo
      // before undici can throw an error that includes the full URL.
      if (nextUrl.username !== "" || nextUrl.password !== "") {
        return rpcFailure(payload.id, -32000, "Upstream MCP redirect must not embed credentials.");
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

    if (response.headers.get("content-type")?.toLowerCase().split(";", 1)[0]?.trim() === "text/event-stream") {
      const sse = await readSseResponseWithLimit(
        response.body as ReadableStream<Uint8Array> | null,
        maxResponseBytes,
        payload.id
      );
      if (sse.kind === "response") return sse.response;
      if (sse.kind === "too_large") {
        return rpcFailure(payload.id, -32000, `Upstream MCP response exceeded the maximum size of ${maxResponseBytes} bytes.`);
      }
      if (sse.kind === "invalid") {
        return rpcFailure(payload.id, -32000, "Upstream MCP response was not a valid JSON-RPC envelope.");
      }
      if (sse.kind === "unsupported_request") {
        return rpcFailure(payload.id, -32000, "Upstream MCP requested unsupported server-to-client interaction.");
      }
      return rpcFailure(payload.id, -32000, "Upstream MCP returned an empty response.");
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
    if (parsed.data.id !== payload.id) {
      return rpcFailure(payload.id, -32000, "Upstream MCP response was not a valid JSON-RPC envelope.");
    }

    return parsed.data as McpRpcResponse;
  }

  return rpcFailure(payload.id, -32000, "Upstream MCP request exceeded the redirect limit.");
}
