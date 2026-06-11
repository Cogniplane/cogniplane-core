// Provider-agnostic LLM proxy core.
//
// Both runtimes run inside E2B sandboxes that hold only a session-scoped rt_*
// runtime token. The real ANTHROPIC_API_KEY / OPENAI_API_KEY never leaves
// the backend; this proxy verifies the rt_*, looks up the real key, and
// forwards the request upstream while streaming the response back.
//
// One handler implementation parameterised by `ProviderConfig`. Each
// provider's route registration (registerLlmAnthropicRoutes /
// registerLlmOpenaiRoutes) supplies the auth-header conventions and
// upstream URL.

import type { BlockList } from "node:net";

import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { fetch as undiciFetch } from "undici";

import { cidrAllowlistAllows } from "../lib/cidr-allowlist.js";
import { resolveEgressClientIp } from "../lib/egress-client-ip.js";
import type { ActiveTurnMessageMap } from "../services/active-turn-message-map.js";
import type { AuditEventStore } from "../services/audit-event-store.js";
import { verifyRuntimeToken } from "../services/auth/runtime-token.js";
import type { MessageStore } from "../services/message-store.js";
import type { RuntimeEgressIpPinStore } from "../services/runtime-egress-ip-pin.js";
import { calculateCostUsd } from "../services/token-cost-calculator.js";
import {
  createUsageSniffer,
  extractUsageFromJson,
  type UsageSniffer
} from "./llm-usage-extractor.js";

export type LlmProviderId = "anthropic" | "openai";

export type LlmProviderConfig = {
  /** Stable id stamped into audit rows. */
  providerId: LlmProviderId;
  /** Route prefix this handler is mounted under, e.g. "/llm/anthropic". */
  routePrefix: string;
  /** Upstream base URL the proxy forwards to (no trailing slash). */
  upstreamBaseUrl: string;
  /** Tenant-level API-key lookup. Null/empty means "fall through to platform key". */
  getTenantApiKey: (tenantId: string) => Promise<string | null>;
  /** Platform-wide fallback API key. */
  platformApiKey: string | null;
  /**
   * Builds the upstream auth header from the real key. Anthropic uses
   * `x-api-key: <key>`; OpenAI uses `authorization: Bearer <key>`. The
   * proxy strips inbound auth headers and replaces them with whatever
   * this returns.
   */
  buildUpstreamAuthHeaders: (realApiKey: string) => Record<string, string>;
  /**
   * Reads the inbound API-key value from request headers, regardless of
   * which header the provider uses to carry it. Returned only for
   * defense-in-depth checks (e.g. "is this a real key prefix?"); the
   * actual auth uses the rt_* token claims.
   */
  readInboundApiKey: (
    headers: Record<string, string | string[] | undefined>
  ) => string | null;
  /**
   * Real-key prefixes that must never appear in the inbound x-api-key /
   * Authorization. If any inbound value starts with one of these, the
   * proxy refuses the call — the sandbox should only ever send rt_*.
   */
  realKeyPrefixes: ReadonlyArray<string>;
};

export type LlmProxyRouteStores = {
  runtimeTokenSecret: string;
  egressAllowlist: BlockList | null;
  egressIpPins: RuntimeEgressIpPinStore;
  auditEvents: AuditEventStore;
  messages: MessageStore;
  activeTurnMessageMap: ActiveTurnMessageMap;
};

type RuntimeClaims = {
  tenantId: string;
  userId: string;
  sessionId: string;
  runtimeId: string;
};

function extractRuntimeClaims(
  headers: Record<string, string | string[] | undefined>,
  secret: string
): RuntimeClaims | null {
  // The rt_* token may arrive as `Authorization: Bearer rt_...`, as
  // `x-api-key: rt_...` (Anthropic Agent SDK), or — rarely — as the raw
  // value of an OpenAI Bearer. Accept any of them.
  const authHeaderRaw = headers["authorization"];
  const authHeader = Array.isArray(authHeaderRaw) ? authHeaderRaw[0] : authHeaderRaw;
  const xApiKeyRaw = headers["x-api-key"];
  const xApiKey = Array.isArray(xApiKeyRaw) ? xApiKeyRaw[0] : xApiKeyRaw;

  let token: string | undefined;
  if (authHeader?.startsWith("Bearer rt_")) {
    token = authHeader.slice("Bearer ".length);
  } else if (typeof xApiKey === "string" && xApiKey.startsWith("rt_")) {
    token = xApiKey;
  }
  if (!token) return null;

  const result = verifyRuntimeToken(token, secret);
  if (result.kind !== "valid") return null;
  return {
    tenantId: result.claims.tid,
    userId: result.claims.uid,
    sessionId: result.claims.sid,
    runtimeId: result.claims.rid
  };
}

async function recordRejection(
  stores: LlmProxyRouteStores,
  provider: LlmProviderId,
  reason: string,
  ctx: {
    tenantId: string | null;
    sessionId: string | null;
    userId: string | null;
    ipAddress: string | null;
    pathname: string;
  },
  log: FastifyBaseLogger
): Promise<void> {
  if (!ctx.tenantId || !ctx.userId) {
    log.warn(
      { reason, provider, pathname: ctx.pathname, ipAddress: ctx.ipAddress },
      "llm.proxy.rejected (unattributed — no tenant context)"
    );
    return;
  }
  try {
    await stores.auditEvents.create({
      tenantId: ctx.tenantId,
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      type: "llm.proxy.rejected",
      payload: { provider, reason, pathname: ctx.pathname },
      ipAddress: ctx.ipAddress
    });
  } catch (err) {
    log.warn({ err, reason, provider }, "failed to persist llm.proxy.rejected audit event");
  }
}

// Hop-by-hop or sensitive headers we never forward upstream regardless of
// what the SDK sends. Auth-bearing headers are replaced by the provider's
// buildUpstreamAuthHeaders.
const STRIPPED_INBOUND_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "authorization",
  "x-api-key",
  "cookie",
  "x-user-id",
  "x-tenant-id"
]);

const STRIPPED_UPSTREAM_HEADERS = new Set([
  "set-cookie",
  "connection",
  "transfer-encoding",
  "content-length",
  "content-encoding"
]);

function buildUpstreamHeaders(
  inbound: Record<string, string | string[] | undefined>,
  authHeaders: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(inbound)) {
    const lower = key.toLowerCase();
    if (STRIPPED_INBOUND_HEADERS.has(lower)) continue;
    if (lower.startsWith("x-cogniplane-")) continue;
    if (value === undefined) continue;
    out[lower] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  for (const [k, v] of Object.entries(authHeaders)) {
    out[k.toLowerCase()] = v;
  }
  out["accept-encoding"] = "identity";
  return out;
}

async function handleProxyRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  provider: LlmProviderConfig,
  stores: LlmProxyRouteStores
): Promise<unknown> {
  const pathname = request.url.split("?", 1)[0]!;
  const ipAddress = resolveEgressClientIp(request);

  const claims = extractRuntimeClaims(
    request.headers as Record<string, string | string[] | undefined>,
    stores.runtimeTokenSecret
  );
  if (!claims) {
    await recordRejection(
      stores,
      provider.providerId,
      "missing_or_invalid_runtime_token",
      {
        tenantId: request.auth?.tenantId ?? null,
        sessionId: null,
        userId: request.auth?.userId ?? null,
        ipAddress,
        pathname
      },
      request.log
    );
    reply.code(401);
    return { error: "missing_or_invalid_runtime_token" };
  }

  // Defense in depth: the auth middleware should already have rejected this,
  // but if a future refactor lets a non-runtime caller through, refuse
  // anything that smells like a real provider key.
  const inboundKey = provider.readInboundApiKey(
    request.headers as Record<string, string | string[] | undefined>
  );
  if (
    inboundKey &&
    provider.realKeyPrefixes.some((prefix) => inboundKey.startsWith(prefix))
  ) {
    await recordRejection(
      stores,
      provider.providerId,
      "real_api_key_present",
      { ...claims, ipAddress, pathname },
      request.log
    );
    reply.code(400);
    return { error: "real_api_key_not_allowed" };
  }

  if (stores.egressAllowlist && !cidrAllowlistAllows(stores.egressAllowlist, ipAddress ?? "")) {
    await recordRejection(
      stores,
      provider.providerId,
      "egress_ip_not_allowed",
      { ...claims, ipAddress, pathname },
      request.log
    );
    reply.code(403);
    return { error: "egress_ip_not_allowed" };
  }

  // Per-runtime IP pin. The first /llm/* call for a given runtimeId
  // pins the observed peer IP; every later call from the same runtime
  // must come from that same IP. Combined with the CIDR allowlist this
  // narrows blast radius from "any host in E2B's NAT" down to "the
  // single sandbox that made the first call." Pin TTL aligns with the
  // rt_* token's TTL, so eviction is handled by token expiry rather
  // than an explicit teardown hook.
  if (ipAddress) {
    const pinResult = stores.egressIpPins.checkAndPin(claims.runtimeId, ipAddress);
    if (pinResult.kind === "mismatch") {
      await recordRejection(
        stores,
        provider.providerId,
        "egress_ip_mismatch",
        { ...claims, ipAddress, pathname },
        request.log
      );
      // Log expected/observed at warn so an operator investigating a
      // leak can see both — audit payload deliberately omits the
      // expected IP to avoid storing per-runtime peer addresses in a
      // long-retention table.
      request.log.warn(
        {
          runtimeId: claims.runtimeId,
          expectedIp: pinResult.expectedIp,
          observedIp: pinResult.observedIp
        },
        "llm.proxy egress IP mismatch — refusing rt_* call from unexpected peer"
      );
      reply.code(403);
      return { error: "egress_ip_mismatch" };
    }
  }

  const tenantKey = (await provider.getTenantApiKey(claims.tenantId))?.trim() || null;
  const realApiKey = tenantKey || provider.platformApiKey;
  if (!realApiKey) {
    await recordRejection(
      stores,
      provider.providerId,
      "no_api_key_configured",
      { ...claims, ipAddress, pathname },
      request.log
    );
    reply.code(503);
    return { error: "api_key_not_configured" };
  }

  const suffix = pathname.slice(provider.routePrefix.length);
  const upstreamUrl = `${provider.upstreamBaseUrl}${suffix}`;

  const upstreamHeaders = buildUpstreamHeaders(
    request.headers as Record<string, string | string[] | undefined>,
    provider.buildUpstreamAuthHeaders(realApiKey)
  );

  const requestBody =
    request.body === undefined || request.body === null
      ? undefined
      : typeof request.body === "string"
        ? request.body
        : JSON.stringify(request.body);

  const startedAt = Date.now();
  let upstreamResponse;
  try {
    upstreamResponse = await undiciFetch(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: requestBody
    });
  } catch (err) {
    request.log.error({ err, upstreamUrl, provider: provider.providerId }, "llm.proxy upstream fetch failed");
    reply.code(502);
    return { error: "upstream_unreachable" };
  }

  reply.hijack();
  const raw = reply.raw;
  const responseHeaders: Record<string, string> = {};
  upstreamResponse.headers.forEach((value: string, key: string) => {
    if (STRIPPED_UPSTREAM_HEADERS.has(key.toLowerCase())) return;
    responseHeaders[key] = value;
  });
  raw.writeHead(upstreamResponse.status, responseHeaders);

  // Usage capture runs alongside the byte pipe — sniffer never mutates
  // chunks, just parses SSE frames out of band. Non-streaming JSON
  // responses are reassembled here for a single JSON.parse at end-of-stream.
  const contentType = upstreamResponse.headers.get("content-type") ?? "";
  const isSse = contentType.includes("text/event-stream");
  const sniffer: UsageSniffer | null =
    upstreamResponse.ok && isSse ? createUsageSniffer(provider.providerId) : null;
  const jsonChunks: Uint8Array[] = [];
  const wantsJsonCapture = upstreamResponse.ok && !isSse;

  if (!upstreamResponse.body) {
    raw.end();
  } else {
    try {
      for await (const chunk of upstreamResponse.body as unknown as AsyncIterable<Uint8Array>) {
        sniffer?.push(chunk);
        if (wantsJsonCapture) jsonChunks.push(chunk);
        if (!raw.write(chunk)) {
          await new Promise<void>((resolve) => raw.once("drain", () => resolve()));
        }
      }
      raw.end();
    } catch (err) {
      request.log.warn(
        { err, sessionId: claims.sessionId, provider: provider.providerId },
        "llm.proxy stream interrupted"
      );
      try {
        raw.destroy(err as Error);
      } catch {
        // socket already closed
      }
    }
  }

  // Charge the active turn — if any. count_tokens and other auxiliary
  // endpoints don't have an active turn registered, so they no-op.
  const tokenUsage = sniffer
    ? sniffer.finalize()
    : wantsJsonCapture
      ? extractUsageFromJson(provider.providerId, Buffer.concat(jsonChunks).toString("utf8"))
      : null;
  // Token usage from a single upstream call is a *delta* against the
  // assistant message: tool-using turns can produce many upstream calls
  // before the assistant message is done, and we have to sum them. The
  // store atomically increments the columns and returns the new running
  // total so we can recompute cost from cumulative numbers (cost calc has
  // tiered pricing — running it on a single delta would systematically
  // misclassify long-context tiers).
  let costUsd: number | null = null;
  let cumulativeUsage: typeof tokenUsage = null;
  if (tokenUsage) {
    const active = stores.activeTurnMessageMap.get(claims.sessionId, claims.runtimeId);
    if (active) {
      const modelName = active.modelName ?? null;
      try {
        cumulativeUsage = await stores.messages.addTokenUsage(
          claims.tenantId,
          active.assistantMessageId,
          claims.userId,
          tokenUsage,
          modelName
        );
        if (cumulativeUsage && modelName) {
          costUsd = calculateCostUsd(modelName, cumulativeUsage);
          await stores.messages.setCostUsd(
            claims.tenantId,
            active.assistantMessageId,
            claims.userId,
            costUsd
          );
        }
      } catch (err) {
        request.log.warn(
          { err, sessionId: claims.sessionId, messageId: active.assistantMessageId },
          "llm.proxy failed to persist token usage to messages"
        );
      }
    }
  }

  const latencyMs = Date.now() - startedAt;
  try {
    await stores.auditEvents.create({
      tenantId: claims.tenantId,
      sessionId: claims.sessionId,
      userId: claims.userId,
      type: "llm.proxy.forwarded",
      payload: {
        provider: provider.providerId,
        pathname,
        upstreamStatus: upstreamResponse.status,
        latencyMs,
        runtimeId: claims.runtimeId,
        stream: requestBody?.includes('"stream":true') ?? false,
        // Per-call delta (what this single upstream request consumed).
        // The cumulative usage + cost for the assistant message lives on
        // the messages row; this audit row is the per-call breakdown so
        // multi-step turns are forensically reproducible.
        ...(tokenUsage ? { tokenUsage } : {}),
        ...(cumulativeUsage ? { cumulativeUsage } : {}),
        ...(costUsd !== null ? { cumulativeCostUsd: costUsd } : {})
      },
      ipAddress
    });
  } catch (err) {
    request.log.warn(
      { err, provider: provider.providerId },
      "failed to persist llm.proxy.forwarded audit event"
    );
  }
}

// Fastify's default JSON body limit is 1 MiB. Real agent turns easily
// exceed that — long conversation histories, base64 image inputs, large
// tool outputs in the context — and the upstream providers themselves
// accept much larger payloads. A 413 here would manifest as a turn that
// silently fails the moment the proxy is enabled. 32 MiB matches the
// largest provider-side limits we routinely see (Anthropic ~32 MB for
// PDF inputs, OpenAI ~25 MB for multimodal); operators can override via
// env if their workloads need more.
const LLM_PROXY_BODY_LIMIT_BYTES = 32 * 1024 * 1024;

/**
 * Register a provider-specific proxy route. The route uses a wildcard so
 * provider minor versions don't require redeploys — anything under the
 * route prefix is forwarded with the same auth + audit semantics.
 */
export function registerLlmProxyRoute(
  app: FastifyInstance,
  provider: LlmProviderConfig,
  stores: LlmProxyRouteStores
): void {
  const wildcard = `${provider.routePrefix}/*`;
  app.post(
    wildcard,
    { bodyLimit: LLM_PROXY_BODY_LIMIT_BYTES },
    async (request, reply) => {
      return handleProxyRequest(request, reply, provider, stores);
    }
  );
}
