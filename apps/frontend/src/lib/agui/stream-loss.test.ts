// @vitest-environment jsdom
// Runs a real DeepAgentsBrowserAgent through @ag-ui/client against stubbed SSE
// bodies. It checks which subscriber callbacks the library calls when a stream
// drops, closes early, or ends with RUN_ERROR. A fake agent cannot prove this.
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../api-client", () => ({
  API_URL: "http://api.test",
  createApiHeaders: (init?: HeadersInit) => new Headers(init),
  refreshAccessToken: vi.fn(),
  request: vi.fn()
}));

import { DeepAgentsBrowserAgent } from "./deep-agents-browser-agent";
import { useAguiCustomEvents } from "./use-agui-custom-events";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const frame = (event: Record<string, unknown>) => `data: ${JSON.stringify(event)}\n\n`;
const RUN_STARTED = frame({ type: "RUN_STARTED", threadId: "s-1", runId: "r-1" });

// One chunk per pull, then a clean close.
function stubStream(chunks: string[]) {
  const encoder = new TextEncoder();
  let index = 0;
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]));
        else controller.close();
      }
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  )));
}

async function runTurn() {
  // @ag-ui/client logs a rethrown run error; it is expected here.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });
  const onRunSettled = vi.fn();
  const onStreamLost = vi.fn();
  renderHook(() => useAguiCustomEvents(agent, { onRunSettled, onStreamLost }));
  agent.addMessage({ id: "u-1", role: "user", content: "hi" });
  await act(async () => {
    await agent.runAgent().catch(() => undefined);
  });
  return { onRunSettled, onStreamLost };
}

describe("the end of a stream through @ag-ui/client", () => {
  it("reports a network error after RUN_STARTED as a lost stream", async () => {
    // A hand-built reader. On a real errored ReadableStream, the library's
    // teardown calls reader.cancel(), which rejects again with the same error
    // and leaves an unhandled rejection that fails the test run.
    const chunks = [new TextEncoder().encode(RUN_STARTED)];
    const reader = {
      read: async () => {
        const value = chunks.shift();
        if (value) return { done: false, value };
        throw new TypeError("network error");
      },
      cancel: async () => undefined
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "text/event-stream" }),
      body: { getReader: () => reader }
    }));
    const { onRunSettled, onStreamLost } = await runTurn();

    expect(onStreamLost).toHaveBeenCalledOnce();
    expect(onRunSettled).not.toHaveBeenCalled();
  });

  it("reports a stream that closes before a terminal event as lost", async () => {
    stubStream([RUN_STARTED]);
    const { onRunSettled, onStreamLost } = await runTurn();

    expect(onStreamLost).toHaveBeenCalledOnce();
    expect(onRunSettled).not.toHaveBeenCalled();
  });

  it("settles once on RUN_ERROR, because the backend ended the turn", async () => {
    stubStream([RUN_STARTED, frame({ type: "RUN_ERROR", message: "graph failed" })]);
    const { onRunSettled, onStreamLost } = await runTurn();

    expect(onRunSettled).toHaveBeenCalledOnce();
    expect(onStreamLost).not.toHaveBeenCalled();
  });

  it("settles once on RUN_FINISHED", async () => {
    stubStream([RUN_STARTED, frame({ type: "RUN_FINISHED", threadId: "s-1", runId: "r-1" })]);
    const { onRunSettled, onStreamLost } = await runTurn();

    expect(onRunSettled).toHaveBeenCalledOnce();
    expect(onStreamLost).not.toHaveBeenCalled();
  });
});
