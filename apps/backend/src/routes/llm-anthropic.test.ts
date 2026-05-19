import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import Fastify from "fastify";

import {
  buildLlmAnthropicRouteStores,
  registerLlmAnthropicRoutes,
  type LlmAnthropicRouteStores
} from "./llm-anthropic.js";
import { ActiveTurnMessageMap } from "../services/active-turn-message-map.js";
import { InMemoryAuditEventStore } from "../test-helpers/in-memory-audit-events.js";
import { generateRuntimeToken } from "../services/auth/runtime-token.js";
import type { MessageStore, TokenUsageRecord } from "../services/message-store.js";
import { RuntimeEgressIpPinStore } from "../services/runtime-egress-ip-pin.js";

const SECRET = "test-encryption-secret-must-be-at-least-32chars!";

type UpstreamBehavior = "stream" | "json" | "401" | "slow-stream";

async function createUpstream(behavior: UpstreamBehavior) {
  const received: Array<{
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
  }> = [];

  const app = Fastify();

  app.post("/v1/messages", async (request, reply) => {
    received.push({ headers: request.headers, body: request.body });
    if (behavior === "401") {
      reply.code(401);
      return { error: "upstream_auth_failed" };
    }
    if (behavior === "json") {
      return {
        id: "msg_123",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 17, output_tokens: 3 }
      };
    }
    // Stream: emit SSE frames with realistic usage payloads so the
    // proxy's sniffer has something to extract.
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache"
    });
    raw.write(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":20}}}\n\n'
    );
    raw.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n');
    if (behavior === "slow-stream") {
      await new Promise((r) => setTimeout(r, 20));
    }
    raw.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n');
    raw.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    raw.end();
  });

  app.post("/v1/messages/count_tokens", async () => ({ input_tokens: 42 }));

  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, url, received };
}

function makeFakeMessages() {
  // Simulates the messages table: tracks per-message cumulative tokens +
  // cost so tests can verify that multi-call turns accumulate correctly
  // instead of replacing.
  const rows = new Map<
    string,
    { tokens: TokenUsageRecord; modelName: string | null; costUsd: number | null }
  >();
  const calls: Array<
    | { kind: "addTokenUsage"; messageId: string; delta: TokenUsageRecord; modelName: string | null }
    | { kind: "setCostUsd"; messageId: string; costUsd: number | null }
  > = [];

  const zero = (): TokenUsageRecord => ({
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  });

  const store = {
    async addTokenUsage(
      _tenantId: string,
      messageId: string,
      _userId: string,
      delta: TokenUsageRecord,
      modelName: string | null
    ): Promise<TokenUsageRecord | null> {
      calls.push({ kind: "addTokenUsage", messageId, delta, modelName });
      const existing = rows.get(messageId) ?? { tokens: zero(), modelName: null, costUsd: null };
      const updated: TokenUsageRecord = {
        inputTokens: existing.tokens.inputTokens + delta.inputTokens,
        cachedInputTokens: existing.tokens.cachedInputTokens + delta.cachedInputTokens,
        outputTokens: existing.tokens.outputTokens + delta.outputTokens,
        reasoningOutputTokens:
          existing.tokens.reasoningOutputTokens + delta.reasoningOutputTokens,
        totalTokens: existing.tokens.totalTokens + delta.totalTokens
      };
      rows.set(messageId, {
        tokens: updated,
        modelName: modelName ?? existing.modelName,
        costUsd: existing.costUsd
      });
      return updated;
    },
    async setCostUsd(
      _tenantId: string,
      messageId: string,
      _userId: string,
      costUsd: number | null
    ): Promise<void> {
      calls.push({ kind: "setCostUsd", messageId, costUsd });
      const existing = rows.get(messageId);
      if (existing) existing.costUsd = costUsd;
    }
  };
  return { store: store as unknown as MessageStore, rows, calls };
}

async function buildHarness(opts: {
  upstreamUrl: string;
  tenantApiKey?: string | null;
  platformApiKey?: string | null;
  egressCidrs?: string;
  egressIpPins?: RuntimeEgressIpPinStore;
  activeTurn?: { sessionId: string; runtimeId: string; messageId: string; modelName: string | null };
}) {
  const audit = new InMemoryAuditEventStore();
  const messages = makeFakeMessages();
  const activeTurnMessageMap = new ActiveTurnMessageMap();
  const egressIpPins = opts.egressIpPins ?? new RuntimeEgressIpPinStore(60_000);
  if (opts.activeTurn) {
    activeTurnMessageMap.set(
      opts.activeTurn.sessionId,
      opts.activeTurn.runtimeId,
      opts.activeTurn.messageId,
      opts.activeTurn.modelName
    );
  }
  const stores: LlmAnthropicRouteStores = buildLlmAnthropicRouteStores({
    upstreamBaseUrl: opts.upstreamUrl,
    runtimeTokenSecret: SECRET,
    platformAnthropicApiKey: opts.platformApiKey ?? null,
    egressCidrs: opts.egressCidrs ?? "",
    egressIpPins,
    getTenantAnthropicApiKey: async () => opts.tenantApiKey ?? null,
    auditEvents: audit as unknown as LlmAnthropicRouteStores["auditEvents"],
    messages: messages.store,
    activeTurnMessageMap
  });

  const app = Fastify();
  await registerLlmAnthropicRoutes(app, stores);
  await app.ready();
  return { app, audit, stores, messages, egressIpPins };
}

function mintToken(overrides: Partial<{ exp: string }> = {}) {
  return generateRuntimeToken(
    {
      sid: "session-1",
      tid: "tenant-1",
      uid: "user-1",
      rid: "runtime-1",
      ...overrides
    },
    SECRET
  );
}

describe("POST /llm/anthropic/v1/messages", () => {
  let upstream: Awaited<ReturnType<typeof createUpstream>>;
  let harness: Awaited<ReturnType<typeof buildHarness>>;

  beforeAll(async () => {
    upstream = await createUpstream("stream");
  });

  afterAll(async () => {
    await upstream.app.close();
  });

  afterEach(async () => {
    await harness?.app.close();
    upstream.received.length = 0;
  });

  test("accepts rt_* via x-api-key, swaps for real key, forwards stream", async () => {
    harness = await buildHarness({
      upstreamUrl: upstream.url,
      tenantApiKey: "sk-ant-tenant-real-key"
    });
    const token = mintToken();

    const res = await harness.app.inject({
      method: "POST",
      url: "/llm/anthropic/v1/messages",
      headers: {
        "content-type": "application/json",
        "x-api-key": token
      },
      payload: { model: "claude-sonnet-4-6", stream: true, messages: [] }
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("message_start");
    expect(res.body).toContain("message_stop");

    expect(upstream.received).toHaveLength(1);
    expect(upstream.received[0]!.headers["x-api-key"]).toBe("sk-ant-tenant-real-key");
    // The rt_* token must never reach upstream — only the real key does.
    expect(upstream.received[0]!.headers.authorization).toBeUndefined();

    const forwarded = harness.audit.events.find((e) => e.type === "llm.proxy.forwarded");
    expect(forwarded?.payload.upstreamStatus).toBe(200);
    expect(forwarded?.payload.stream).toBe(true);
  });

  test("accepts rt_* via Authorization: Bearer", async () => {
    harness = await buildHarness({
      upstreamUrl: upstream.url,
      platformApiKey: "sk-ant-platform-key"
    });
    const token = mintToken();

    const res = await harness.app.inject({
      method: "POST",
      url: "/llm/anthropic/v1/messages",
      headers: { authorization: `Bearer ${token}` },
      payload: { model: "x", messages: [] }
    });

    expect(res.statusCode).toBe(200);
    expect(upstream.received[0]!.headers["x-api-key"]).toBe("sk-ant-platform-key");
  });

  test("prefers tenant key over platform key", async () => {
    harness = await buildHarness({
      upstreamUrl: upstream.url,
      tenantApiKey: "sk-ant-TENANT",
      platformApiKey: "sk-ant-PLATFORM"
    });
    const token = mintToken();

    await harness.app.inject({
      method: "POST",
      url: "/llm/anthropic/v1/messages",
      headers: { "x-api-key": token },
      payload: { model: "x", messages: [] }
    });

    expect(upstream.received[0]!.headers["x-api-key"]).toBe("sk-ant-TENANT");
  });

  test("rejects sk-ant-* in x-api-key (defense in depth)", async () => {
    harness = await buildHarness({
      upstreamUrl: upstream.url,
      tenantApiKey: "sk-ant-real"
    });

    const res = await harness.app.inject({
      method: "POST",
      url: "/llm/anthropic/v1/messages",
      headers: { "x-api-key": "sk-ant-leaked-key" },
      payload: { model: "x", messages: [] }
    });

    expect(res.statusCode).toBe(401);
    expect(upstream.received).toHaveLength(0);
  });

  test("rejects missing token with 401", async () => {
    harness = await buildHarness({ upstreamUrl: upstream.url, tenantApiKey: "sk-real" });

    const res = await harness.app.inject({
      method: "POST",
      url: "/llm/anthropic/v1/messages",
      payload: { model: "x", messages: [] }
    });

    expect(res.statusCode).toBe(401);
  });

  test("rejects expired rt_* with 401", async () => {
    harness = await buildHarness({ upstreamUrl: upstream.url, tenantApiKey: "sk-real" });
    const expired = mintToken({ exp: new Date(Date.now() - 60_000).toISOString() });

    const res = await harness.app.inject({
      method: "POST",
      url: "/llm/anthropic/v1/messages",
      headers: { "x-api-key": expired },
      payload: { model: "x", messages: [] }
    });

    expect(res.statusCode).toBe(401);
    expect(upstream.received).toHaveLength(0);
  });

  test("rejects when no real API key configured (503)", async () => {
    harness = await buildHarness({ upstreamUrl: upstream.url });
    const token = mintToken();

    const res = await harness.app.inject({
      method: "POST",
      url: "/llm/anthropic/v1/messages",
      headers: { "x-api-key": token },
      payload: { model: "x", messages: [] }
    });

    expect(res.statusCode).toBe(503);
    expect(upstream.received).toHaveLength(0);
  });

  test("egress allowlist admits loopback so the same-process backend caller can use the proxy", async () => {
    // Local Claude SDK routes through /llm/anthropic in both local and e2b
    // mode now, so the in-process caller (peer = loopback) must not be
    // blocked by E2B_EGRESS_CIDRS — the allowlist is for sandbox egress.
    harness = await buildHarness({
      upstreamUrl: upstream.url,
      tenantApiKey: "sk-real",
      egressCidrs: "203.0.113.0/24"
    });
    const token = mintToken();

    const res = await harness.app.inject({
      method: "POST",
      url: "/llm/anthropic/v1/messages",
      headers: { "x-api-key": token },
      payload: { model: "x", messages: [] }
    });

    expect(res.statusCode).toBe(200);
    expect(upstream.received).toHaveLength(1);
  });

  test("egress allowlist blocks unknown peer (403)", async () => {
    harness = await buildHarness({
      upstreamUrl: upstream.url,
      tenantApiKey: "sk-real",
      egressCidrs: "203.0.113.0/24"
    });
    const token = mintToken();

    // Simulate an off-host peer outside the allowlist. The carve-out for
    // loopback (127.0.0.1 / ::1) is intentional — see cidr-allowlist.ts —
    // so this test uses a non-loopback address to exercise the block path.
    const res = await harness.app.inject({
      method: "POST",
      url: "/llm/anthropic/v1/messages",
      headers: { "x-api-key": token },
      payload: { model: "x", messages: [] },
      remoteAddress: "198.51.100.42"
    });

    expect(res.statusCode).toBe(403);
    expect(upstream.received).toHaveLength(0);

    const rejected = harness.audit.events.find((e) => e.type === "llm.proxy.rejected");
    expect(rejected?.payload.reason).toBe("egress_ip_not_allowed");
  });

  test("forwards JSON (non-streaming) responses", async () => {
    const jsonUpstream = await createUpstream("json");
    try {
      harness = await buildHarness({
        upstreamUrl: jsonUpstream.url,
        tenantApiKey: "sk-real"
      });
      const token = mintToken();

      const res = await harness.app.inject({
        method: "POST",
        url: "/llm/anthropic/v1/messages",
        headers: { "x-api-key": token },
        payload: { model: "x", messages: [] }
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        id: "msg_123",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 17, output_tokens: 3 }
      });
    } finally {
      await jsonUpstream.app.close();
    }
  });

  test("mirrors non-2xx upstream status (auth failure surfaces as upstream's status)", async () => {
    const failingUpstream = await createUpstream("401");
    try {
      harness = await buildHarness({
        upstreamUrl: failingUpstream.url,
        tenantApiKey: "sk-real"
      });
      const token = mintToken();

      const res = await harness.app.inject({
        method: "POST",
        url: "/llm/anthropic/v1/messages",
        headers: { "x-api-key": token },
        payload: { model: "x", messages: [] }
      });

      expect(res.statusCode).toBe(401);
    } finally {
      await failingUpstream.app.close();
    }
  });

  test("forwards count_tokens through the wildcard route", async () => {
    harness = await buildHarness({
      upstreamUrl: upstream.url,
      tenantApiKey: "sk-real"
    });
    const token = mintToken();

    const res = await harness.app.inject({
      method: "POST",
      url: "/llm/anthropic/v1/messages/count_tokens",
      headers: { "x-api-key": token },
      payload: { model: "x", messages: [] }
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ input_tokens: 42 });
  });

  test("charges the active turn: writes token_usage + cost_usd to messages.updateTokenUsage", async () => {
    harness = await buildHarness({
      upstreamUrl: upstream.url,
      tenantApiKey: "sk-real",
      activeTurn: {
        sessionId: "session-1",
        runtimeId: "runtime-1",
        messageId: "assistant-msg-1",
        modelName: "claude-sonnet-4-6"
      }
    });
    const token = mintToken();

    const res = await harness.app.inject({
      method: "POST",
      url: "/llm/anthropic/v1/messages",
      headers: { "x-api-key": token },
      payload: { model: "claude-sonnet-4-6", stream: true, messages: [] }
    });
    expect(res.statusCode).toBe(200);

    const row = harness.messages.rows.get("assistant-msg-1");
    expect(row).toBeDefined();
    expect(row!.modelName).toBe("claude-sonnet-4-6");
    // Stream emitted input_tokens=100 + cache_read=20 = 120, output=42
    expect(row!.tokens.inputTokens).toBe(120);
    expect(row!.tokens.cachedInputTokens).toBe(20);
    expect(row!.tokens.outputTokens).toBe(42);
    // Cost depends on the model's pricing table — just assert > 0 to
    // avoid coupling this test to the exact rate sheet.
    expect(row!.costUsd).not.toBeNull();
    expect(row!.costUsd!).toBeGreaterThan(0);
  });

  test("accumulates usage across multiple proxied calls within the same turn", async () => {
    // Tool-using turns can fire N upstream model requests before one
    // assistant message completes. The proxy must SUM the usage onto the
    // message row, not overwrite — otherwise multi-step turns silently
    // undercount usage.
    harness = await buildHarness({
      upstreamUrl: upstream.url,
      tenantApiKey: "sk-real",
      activeTurn: {
        sessionId: "session-1",
        runtimeId: "runtime-1",
        messageId: "assistant-msg-multi",
        modelName: "claude-sonnet-4-6"
      }
    });
    const token = mintToken();

    // Three upstream calls in a row, same turn.
    for (let i = 0; i < 3; i++) {
      const res = await harness.app.inject({
        method: "POST",
        url: "/llm/anthropic/v1/messages",
        headers: { "x-api-key": token },
        payload: { model: "claude-sonnet-4-6", stream: true, messages: [] }
      });
      expect(res.statusCode).toBe(200);
    }

    const row = harness.messages.rows.get("assistant-msg-multi");
    expect(row).toBeDefined();
    // Each call: input=120, output=42. After 3: 360 / 126.
    expect(row!.tokens.inputTokens).toBe(360);
    expect(row!.tokens.cachedInputTokens).toBe(60);
    expect(row!.tokens.outputTokens).toBe(126);
    // 3 addTokenUsage + 3 setCostUsd
    expect(harness.messages.calls).toHaveLength(6);
  });

  test("no active turn → no write to messages (count_tokens, idle session)", async () => {
    harness = await buildHarness({
      upstreamUrl: upstream.url,
      tenantApiKey: "sk-real"
      // no activeTurn registered
    });
    const token = mintToken();

    await harness.app.inject({
      method: "POST",
      url: "/llm/anthropic/v1/messages",
      headers: { "x-api-key": token },
      payload: { model: "x", stream: true, messages: [] }
    });

    expect(harness.messages.calls).toHaveLength(0);
  });

  test("egress IP pin: first request pins, subsequent matching request succeeds", async () => {
    harness = await buildHarness({
      upstreamUrl: upstream.url,
      tenantApiKey: "sk-real"
    });
    const token = mintToken();

    for (let i = 0; i < 2; i++) {
      const res = await harness.app.inject({
        method: "POST",
        url: "/llm/anthropic/v1/messages",
        headers: { "x-api-key": token },
        payload: { model: "x", stream: true, messages: [] }
      });
      expect(res.statusCode).toBe(200);
    }
    expect(upstream.received).toHaveLength(2);
  });

  test("egress IP pin: mismatch from a different peer returns 403 + audits egress_ip_mismatch", async () => {
    // Pre-pin the runtime to a peer that won't match the test injection's
    // 127.0.0.1 source — simulates "rt_* leaked, attacker tries from a
    // different egress IP inside the CIDR allowlist."
    const pins = new RuntimeEgressIpPinStore(60_000);
    pins.checkAndPin("runtime-1", "198.51.100.42");

    harness = await buildHarness({
      upstreamUrl: upstream.url,
      tenantApiKey: "sk-real",
      egressIpPins: pins
    });
    const token = mintToken();

    const res = await harness.app.inject({
      method: "POST",
      url: "/llm/anthropic/v1/messages",
      headers: { "x-api-key": token },
      payload: { model: "x", stream: true, messages: [] }
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "egress_ip_mismatch" });
    expect(upstream.received).toHaveLength(0);

    const rejected = harness.audit.events.find((e) => e.type === "llm.proxy.rejected");
    expect(rejected?.payload.reason).toBe("egress_ip_mismatch");
    // The expected IP must NOT be persisted in the audit row — avoids
    // storing per-runtime peer addresses in long-retention tables.
    expect(JSON.stringify(rejected?.payload)).not.toContain("198.51.100.42");
  });
});
