// The provider clients retry a failed request themselves (LangChain's
// AsyncCaller). The model start callback checks the tool context only once per
// call, so the runtime checks it again after each failed request
// (checkBeforeRetry). Real provider clients against a local server that
// answers 500; the server counts the requests that reach it.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { ModelProvider } from "@cogniplane/shared-types";
import { AVAILABLE_MODELS } from "../../domain/models.js";
import { createSilentLogger } from "../../test-helpers/silent-logger.js";
import { createDeepAgentsSessionRuntime } from "./deep-agents-graph.js";

let server: Server;
let baseUrl = "";
let requests = 0;
let status = 500;

beforeAll(async () => {
  server = createServer((request, response) => {
    requests += 1;
    request.resume();
    request.on("end", () => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "upstream unavailable", type: "server_error" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A check that passes `live` times, then throws as the adapter does for a dead context. */
function contextCheck(live: number) {
  return vi.fn(async () => {
    if (contextCheck.calls++ >= live) throw new Error("Tool access ended");
  });
}
contextCheck.calls = 0;

async function turn(provider: ModelProvider, requireLiveToolContext: () => Promise<void>, metered = false, answer = 500) {
  requests = 0;
  status = answer;
  contextCheck.calls = 0;
  const modelId = AVAILABLE_MODELS.find((entry) => entry.provider === provider)!.id;
  const runtime = createDeepAgentsSessionRuntime({
    tenantId: "tenant", sessionId: `session-${provider}`, userId: "user", runtimeId: "runtime",
    resolveProviderKey: async () => "test-key",
    providerBaseUrls: { [provider]: provider === "openai" ? `${baseUrl}/v1` : baseUrl },
    systemPrompt: null, workspacePath: "/workspace", e2b: null,
    requireLiveToolContext,
    hasSpendingReservation: () => metered,
    logger: createSilentLogger()
  });
  try {
    const graph = await runtime.getAgentForModel(modelId);
    for await (const _event of graph.streamEvents({ messages: [{ role: "user", content: "Hello" }] },
      { version: "v2", configurable: { thread_id: `thread-${provider}` } })) {
      // Consume the stream so that the model call runs.
    }
  } finally { await runtime.dispose(); }
}

describe.each(["openai", "anthropic", "google"] as const)("%s client retries", (provider) => {
  it("a dead context gets no retry after a failed request", async () => {
    const check = contextCheck(0);
    await expect(turn(provider, check)).rejects.toThrow("Tool access ended");
    expect(requests).toBe(1);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("a live context gets the retry, and the check runs again after it fails", async () => {
    const check = contextCheck(1);
    await expect(turn(provider, check)).rejects.toThrow("Tool access ended");
    expect(requests).toBe(2);
    expect(check).toHaveBeenCalledTimes(2);
  }, 15_000);
});

it("an error that the client does not retry keeps that decision and needs no check", async () => {
  const check = contextCheck(1);
  await expect(turn("openai", check, false, 400)).rejects.toThrow();
  expect(requests).toBe(1);
  expect(check).not.toHaveBeenCalled();
});

it("a metered turn has no provider retry, so it needs no check there", async () => {
  const check = contextCheck(0);
  await expect(turn("openai", check, true)).rejects.toThrow();
  expect(requests).toBe(1);
  expect(check).not.toHaveBeenCalled();
});
