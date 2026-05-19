import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import Fastify from "fastify";

import {
  buildLlmOpenaiRouteStores,
  registerLlmOpenaiRoutes,
  type LlmOpenaiRouteStores
} from "./llm-openai.js";
import { ActiveTurnMessageMap } from "../services/active-turn-message-map.js";
import { InMemoryAuditEventStore } from "../test-helpers/in-memory-audit-events.js";
import { generateRuntimeToken } from "../services/auth/runtime-token.js";
import type { MessageStore, TokenUsageRecord } from "../services/message-store.js";
import { RuntimeEgressIpPinStore } from "../services/runtime-egress-ip-pin.js";

const SECRET = "test-encryption-secret-must-be-at-least-32chars!";

async function createUpstream() {
  const received: Array<{
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
  }> = [];

  const app = Fastify();

  app.post("/v1/responses", async (request, reply) => {
    received.push({ headers: request.headers, body: request.body });
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache"
    });
    raw.write('event: response.created\ndata: {"type":"response.created"}\n\n');
    raw.write(
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":300,"output_tokens":120,"total_tokens":420,"input_tokens_details":{"cached_tokens":50},"output_tokens_details":{"reasoning_tokens":25}}}}\n\n'
    );
    raw.end();
  });

  app.post("/v1/chat/completions", async (request) => {
    received.push({ headers: request.headers, body: request.body });
    return { id: "chatcmpl-1", choices: [{ message: { role: "assistant", content: "hi" } }] };
  });

  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, url, received };
}

function makeFakeMessages() {
  const rows = new Map<
    string,
    { tokens: TokenUsageRecord; modelName: string | null; costUsd: number | null }
  >();
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
      const existing = rows.get(messageId);
      if (existing) existing.costUsd = costUsd;
    }
  };
  return { store: store as unknown as MessageStore, rows };
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
  const stores: LlmOpenaiRouteStores = buildLlmOpenaiRouteStores({
    upstreamBaseUrl: opts.upstreamUrl,
    runtimeTokenSecret: SECRET,
    platformOpenaiApiKey: opts.platformApiKey ?? null,
    egressCidrs: opts.egressCidrs ?? "",
    egressIpPins,
    getTenantOpenaiApiKey: async () => opts.tenantApiKey ?? null,
    auditEvents: audit as unknown as LlmOpenaiRouteStores["auditEvents"],
    messages: messages.store,
    activeTurnMessageMap
  });

  const app = Fastify();
  await registerLlmOpenaiRoutes(app, stores);
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

describe("POST /llm/openai/v1/responses", () => {
  let upstream: Awaited<ReturnType<typeof createUpstream>>;
  let harness: Awaited<ReturnType<typeof buildHarness>>;

  beforeAll(async () => {
    upstream = await createUpstream();
  });

  afterAll(async () => {
    await upstream.app.close();
  });

  afterEach(async () => {
    await harness?.app.close();
    upstream.received.length = 0;
  });

  test("accepts rt_* via Authorization: Bearer, swaps for real key, forwards stream", async () => {
    harness = await buildHarness({
      upstreamUrl: upstream.url,
      tenantApiKey: "sk-tenant-openai-real-key"
    });
    const token = mintToken();

    const res = await harness.app.inject({
      method: "POST",
      url: "/llm/openai/v1/responses",
      headers: { authorization: `Bearer ${token}` },
      payload: { model: "gpt-5.4-mini", stream: true, input: "hi" }
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("response.created");
    expect(res.body).toContain("response.completed");

    expect(upstream.received).toHaveLength(1);
    expect(upstream.received[0]!.headers.authorization).toBe("Bearer sk-tenant-openai-real-key");
    // rt_ token must never reach upstream.
    expect(upstream.received[0]!.headers.authorization).not.toContain("rt_");

    const forwarded = harness.audit.events.find((e) => e.type === "llm.proxy.forwarded");
    expect(forwarded?.payload.provider).toBe("openai");
    expect(forwarded?.payload.upstreamStatus).toBe(200);
    expect(forwarded?.payload.stream).toBe(true);
  });

  test("rejects sk-* in Authorization (defense in depth)", async () => {
    harness = await buildHarness({
      upstreamUrl: upstream.url,
      tenantApiKey: "sk-real"
    });

    const res = await harness.app.inject({
      method: "POST",
      url: "/llm/openai/v1/responses",
      headers: { authorization: "Bearer sk-leaked-real-openai-key" },
      payload: { model: "x", input: "hi" }
    });

    expect(res.statusCode).toBe(401);
    expect(upstream.received).toHaveLength(0);
  });

  test("rejects sk-proj-* and sk-svcacct-* prefixes too", async () => {
    harness = await buildHarness({
      upstreamUrl: upstream.url,
      tenantApiKey: "sk-real"
    });

    for (const leaked of ["sk-proj-abcdef", "sk-svcacct-abcdef"]) {
      const res = await harness.app.inject({
        method: "POST",
        url: "/llm/openai/v1/responses",
        headers: { authorization: `Bearer ${leaked}` },
        payload: { model: "x", input: "hi" }
      });
      expect(res.statusCode).toBe(401);
    }
    expect(upstream.received).toHaveLength(0);
  });

  test("rejects missing token with 401", async () => {
    harness = await buildHarness({ upstreamUrl: upstream.url, tenantApiKey: "sk-real" });

    const res = await harness.app.inject({
      method: "POST",
      url: "/llm/openai/v1/responses",
      payload: { model: "x", input: "hi" }
    });

    expect(res.statusCode).toBe(401);
  });

  test("rejects expired rt_* with 401", async () => {
    harness = await buildHarness({ upstreamUrl: upstream.url, tenantApiKey: "sk-real" });
    const expired = mintToken({ exp: new Date(Date.now() - 60_000).toISOString() });

    const res = await harness.app.inject({
      method: "POST",
      url: "/llm/openai/v1/responses",
      headers: { authorization: `Bearer ${expired}` },
      payload: { model: "x", input: "hi" }
    });

    expect(res.statusCode).toBe(401);
    expect(upstream.received).toHaveLength(0);
  });

  test("503 when no key configured", async () => {
    harness = await buildHarness({ upstreamUrl: upstream.url });
    const token = mintToken();

    const res = await harness.app.inject({
      method: "POST",
      url: "/llm/openai/v1/responses",
      headers: { authorization: `Bearer ${token}` },
      payload: { model: "x", input: "hi" }
    });

    expect(res.statusCode).toBe(503);
    expect(upstream.received).toHaveLength(0);
  });

  test("egress CIDR allowlist blocks unknown peer (403)", async () => {
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
      url: "/llm/openai/v1/responses",
      headers: { authorization: `Bearer ${token}` },
      payload: { model: "x", input: "hi" },
      remoteAddress: "198.51.100.42"
    });

    expect(res.statusCode).toBe(403);
    expect(upstream.received).toHaveLength(0);

    const rejected = harness.audit.events.find((e) => e.type === "llm.proxy.rejected");
    expect(rejected?.payload.reason).toBe("egress_ip_not_allowed");
    expect(rejected?.payload.provider).toBe("openai");
  });

  test("charges the active turn: writes token_usage + cost_usd to messages.updateTokenUsage", async () => {
    harness = await buildHarness({
      upstreamUrl: upstream.url,
      tenantApiKey: "sk-real",
      activeTurn: {
        sessionId: "session-1",
        runtimeId: "runtime-1",
        messageId: "assistant-msg-1",
        modelName: "gpt-5.4-mini"
      }
    });
    const token = mintToken();

    const res = await harness.app.inject({
      method: "POST",
      url: "/llm/openai/v1/responses",
      headers: { authorization: `Bearer ${token}` },
      payload: { model: "gpt-5.4-mini", stream: true, input: "hi" }
    });
    expect(res.statusCode).toBe(200);

    const row = harness.messages.rows.get("assistant-msg-1");
    expect(row).toBeDefined();
    expect(row!.modelName).toBe("gpt-5.4-mini");
    expect(row!.tokens.inputTokens).toBe(300);
    expect(row!.tokens.cachedInputTokens).toBe(50);
    expect(row!.tokens.outputTokens).toBe(120);
    expect(row!.tokens.reasoningOutputTokens).toBe(25);
    expect(row!.tokens.totalTokens).toBe(420);
  });

  test("forwards chat/completions through the wildcard route", async () => {
    harness = await buildHarness({
      upstreamUrl: upstream.url,
      tenantApiKey: "sk-real"
    });
    const token = mintToken();

    const res = await harness.app.inject({
      method: "POST",
      url: "/llm/openai/v1/chat/completions",
      headers: { authorization: `Bearer ${token}` },
      payload: { model: "x", messages: [] }
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: "chatcmpl-1",
      choices: [{ message: { role: "assistant", content: "hi" } }]
    });
  });
});
