import { describe, it, vi, expect } from "vitest";

import { setAccessToken, setTokenRefresher } from "./api-client";
import { streamMessage } from "./streaming-api";

function createSseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();

  return {
    ok: true,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(frame));
        }
        controller.close();
      }
    })
  } as Response;
}

const RESPONSE_ID = "resp-1";

const createdFrame = `event: response.created\ndata: ${JSON.stringify({
  type: "response.created",
  response: { id: RESPONSE_ID, status: "in_progress" }
})}\n\n`;

const textDeltaFrame = (delta: string) =>
  `event: response.output_text.delta\ndata: ${JSON.stringify({
    type: "response.output_text.delta",
    response_id: RESPONSE_ID,
    item_id: "msg-1",
    delta
  })}\n\n`;

const itemDoneFrame = `event: response.output_item.done\ndata: ${JSON.stringify({
  type: "response.output_item.done",
  response_id: RESPONSE_ID,
  item_id: "msg-1"
})}\n\n`;

const completedFrame = `event: response.completed\ndata: ${JSON.stringify({
  type: "response.completed",
  response: { id: RESPONSE_ID, status: "completed" }
})}\n\n`;

describe("streamMessage", () => {
  it("does not mark the message completed on response.output_item.done", async () => {
    const fakeFetch = vi.fn(async () =>
      createSseResponse([createdFrame, textDeltaFrame("Hello"), itemDoneFrame, completedFrame])
    );

    (global as unknown as { fetch: typeof fetch }).fetch = fakeFetch;

    const statuses: string[] = [];
    const completions: string[] = [];
    const deltas: string[] = [];

    await streamMessage({
      sessionId: "session-1",
      text: "hi",
      onStatusChange: (status) => {
        statuses.push(status);
      },
      onDelta: (delta) => {
        deltas.push(delta);
      },
      onComplete: (status) => {
        completions.push(status);
      }
    });

    expect(deltas).toEqual(["Hello"]);
    expect(statuses).toEqual(["pending", "streaming", "streaming"]);
    expect(completions).toEqual(["completed"]);
  });

  it("exits without firing the onComplete error path when aborted mid-stream", async () => {
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const response = {
      ok: true,
      body: new ReadableStream<Uint8Array>({
        start(ctl) {
          streamController = ctl;
          ctl.enqueue(encoder.encode(createdFrame));
        }
      })
    } as Response;

    (global as unknown as { fetch: typeof fetch }).fetch = vi.fn(async () => response);

    const abortController = new AbortController();
    const completions: string[] = [];

    const pending = streamMessage({
      sessionId: "session-1",
      text: "hi",
      signal: abortController.signal,
      onDelta: () => {},
      onComplete: (status) => {
        completions.push(status);
      }
    });

    // Let the first frame flow, then abort before the server sends a terminal event.
    // reader.cancel() (triggered by abort) closes the stream; no manual close needed.
    await new Promise((resolve) => setTimeout(resolve, 5));
    abortController.abort();

    try {
      await pending;
    } catch (err) {
      // reader.cancel() can surface as an AbortError — that's expected.
      expect(err instanceof Error).toBeTruthy();
    }

    expect(completions).toEqual([]);
    void streamController;
  });

  it("resolves after a terminal event even if the underlying stream never closes", async () => {
    const encoder = new TextEncoder();
    const response = {
      ok: true,
      body: new ReadableStream<Uint8Array>({
        start(ctl) {
          ctl.enqueue(encoder.encode(createdFrame));
          ctl.enqueue(encoder.encode(textDeltaFrame("Hi")));
          ctl.enqueue(encoder.encode(completedFrame));
          // Intentionally do NOT call ctl.close() — simulates Node's chunked
          // terminator lagging the last data chunk in the browser fetch reader.
        }
      })
    } as Response;

    (global as unknown as { fetch: typeof fetch }).fetch = vi.fn(async () => response);

    const completions: string[] = [];

    await streamMessage({
      sessionId: "session-1",
      text: "hi",
      onDelta: () => {},
      onComplete: (status) => {
        completions.push(status);
      }
    });

    expect(completions).toEqual(["completed"]);
  });

  it("refreshes the access token and retries once on a 401", async () => {
    setAccessToken("stale-token");
    setTokenRefresher(async () => {
      setAccessToken("fresh-token");
      return "fresh-token";
    });

    const authHeaders: Array<string | null> = [];
    const fakeFetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      authHeaders.push(new Headers(init?.headers).get("Authorization"));
      if (fakeFetch.mock.calls.length === 1) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      }
      return createSseResponse([createdFrame, textDeltaFrame("Hello"), completedFrame]);
    });

    (global as unknown as { fetch: typeof fetch }).fetch = fakeFetch;

    const deltas: string[] = [];
    const completions: string[] = [];

    try {
      await streamMessage({
        sessionId: "session-1",
        text: "hi",
        onDelta: (delta) => {
          deltas.push(delta);
        },
        onComplete: (status) => {
          completions.push(status);
        }
      });
    } finally {
      setAccessToken(null);
      setTokenRefresher(async () => null);
    }

    expect(authHeaders).toEqual(["Bearer stale-token", "Bearer fresh-token"]);
    expect(deltas).toEqual(["Hello"]);
    expect(completions).toEqual(["completed"]);
  });

  it("surfaces the 401 error when the refresher cannot produce a token", async () => {
    setAccessToken("stale-token");
    setTokenRefresher(async () => null);

    const fakeFetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
    );

    (global as unknown as { fetch: typeof fetch }).fetch = fakeFetch;

    try {
      await expect(
        streamMessage({
          sessionId: "session-1",
          text: "hi",
          onDelta: () => {},
          onComplete: () => {}
        })
      ).rejects.toThrow("unauthorized");
    } finally {
      setAccessToken(null);
    }

    expect(fakeFetch.mock.calls.length).toBe(1);
  });

  it("fires onFailed with a reason when the stream closes without a terminal event", async () => {
    const fakeFetch = vi.fn(async () =>
      createSseResponse([
        createdFrame,
        textDeltaFrame("Hello")
        // stream ends here — no response.completed frame
      ])
    );

    (global as unknown as { fetch: typeof fetch }).fetch = fakeFetch;

    const failures: string[] = [];
    const completions: string[] = [];

    await streamMessage({
      sessionId: "session-1",
      text: "hi",
      onDelta: () => {},
      onFailed: (message) => {
        failures.push(message);
      },
      onComplete: (status) => {
        completions.push(status);
      }
    });

    expect(failures).toEqual(["Connection closed unexpectedly"]);
    expect(completions).toEqual(["error"]);
  });

  it("fails loud when an SSE frame doesn't match its shared schema", async () => {
    // `response.completed` requires `response: { id, status }`. Sending a
    // string in `id`'s place is exactly the kind of drift the bead is meant
    // to surface — the schema fails fast instead of letting the corrupted
    // payload pass through to onComplete.
    const malformedCompleted = `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: { id: 123, status: "completed" }
    })}\n\n`;

    const fakeFetch = vi.fn(async () =>
      createSseResponse([createdFrame, textDeltaFrame("Hi"), malformedCompleted])
    );

    (global as unknown as { fetch: typeof fetch }).fetch = fakeFetch;

    const failures: string[] = [];
    const completions: Array<[string, unknown, unknown, unknown]> = [];
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await streamMessage({
      sessionId: "session-1",
      text: "hi",
      onDelta: () => {},
      onFailed: (message) => {
        failures.push(message);
      },
      onComplete: (status, tokenUsage, costUsd, modelName) => {
        completions.push([status, tokenUsage, costUsd, modelName]);
      }
    });

    expect(completions).toEqual([["error", undefined, undefined, undefined]]);
    expect(failures.length).toBe(1);
    expect(failures[0]).toMatch(/response\.id|expected string|invalid_type/i);

    consoleSpy.mockRestore();
  });

  it("rejects a non-terminal frame missing required fields and surfaces error", async () => {
    // `response.tool.started` requires a full `tool_result`. An empty object
    // means the schema rejects, the read loop converts the throw into the
    // error completion path. (Pre-validation, the cast would have fed an
    // undefined ToolResult to onToolStarted, breaking the UI silently.)
    const malformedToolStart = `event: response.tool.started\ndata: ${JSON.stringify({
      type: "response.tool.started",
      response_id: RESPONSE_ID,
      item_id: "tool-1",
      tool_result: {}
    })}\n\n`;

    const fakeFetch = vi.fn(async () =>
      createSseResponse([createdFrame, malformedToolStart, completedFrame])
    );

    (global as unknown as { fetch: typeof fetch }).fetch = fakeFetch;

    const toolStarts: unknown[] = [];
    const completions: string[] = [];
    const failures: string[] = [];
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await streamMessage({
      sessionId: "session-1",
      text: "hi",
      onDelta: () => {},
      onToolStarted: (tr) => {
        toolStarts.push(tr);
      },
      onFailed: (message) => {
        failures.push(message);
      },
      onComplete: (status) => {
        completions.push(status);
      }
    });

    expect(toolStarts).toEqual([]);
    expect(completions).toEqual(["error"]);
    expect(failures.length).toBe(1);

    consoleSpy.mockRestore();
  });
});
