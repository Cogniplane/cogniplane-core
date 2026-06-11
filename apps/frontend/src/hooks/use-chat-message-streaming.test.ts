// @vitest-environment jsdom
import { act, renderHook, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vitest runs with globals:false, so RTL cannot auto-register its cleanup.
afterEach(cleanup);

import { useChatMessageStreaming } from "./use-chat-message-streaming";

type StreamCall = {
  input: { sessionId: string; signal?: AbortSignal };
  resolve: () => void;
  reject: (err: unknown) => void;
};

const streamState = vi.hoisted(() => ({
  calls: [] as Array<{
    input: { sessionId: string; signal?: AbortSignal };
    resolve: () => void;
    reject: (err: unknown) => void;
  }>
}));

vi.mock("../lib/streaming-api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/streaming-api")>();
  return {
    ...original,
    streamMessage: vi.fn(
      (input: { sessionId: string; signal?: AbortSignal }) =>
        new Promise<void>((resolve, reject) => {
          streamState.calls.push({ input, resolve, reject });
        })
    )
  };
});

function makeInput() {
  return {
    selectedSessionId: "s-1",
    visibleSelectedArtifactIds: [] as string[],
    onError: vi.fn(),
    setMessages: vi.fn(),
    registerPendingApproval: vi.fn(),
    removePendingApproval: vi.fn(),
    refreshSessionData: vi.fn(async () => {}),
    invalidateInFlightSessionRefreshes: vi.fn(),
    model: "test-model"
  };
}

describe("useChatMessageStreaming: superseded sends", () => {
  beforeEach(() => {
    streamState.calls.length = 0;
  });

  it("a superseded send's cleanup does not clobber the replacing send's state", async () => {
    const { result } = renderHook(() => useChatMessageStreaming(makeInput()));

    await act(async () => {
      void result.current.sendMessage("first");
    });
    expect(result.current.isSending).toBe(true);
    expect(result.current.streamingSessionId).toBe("s-1");
    expect(streamState.calls.length).toBe(1);
    const first: StreamCall = streamState.calls[0];

    // The second send aborts the first one's controller and takes over.
    await act(async () => {
      void result.current.sendMessage("second");
    });
    expect(streamState.calls.length).toBe(2);
    expect(first.input.signal?.aborted).toBe(true);

    // The aborted fetch rejects; the superseded call's finally must leave the
    // replacing send's isSending/streamingSessionId untouched.
    await act(async () => {
      first.reject(new DOMException("aborted", "AbortError"));
    });
    expect(result.current.isSending).toBe(true);
    expect(result.current.streamingSessionId).toBe("s-1");

    // Only the owning call resets the shared state.
    await act(async () => {
      streamState.calls[1].resolve();
    });
    expect(result.current.isSending).toBe(false);
    expect(result.current.streamingSessionId).toBeNull();
  });

  it("a normally-completed send still resets isSending and streamingSessionId", async () => {
    const { result } = renderHook(() => useChatMessageStreaming(makeInput()));

    await act(async () => {
      void result.current.sendMessage("only");
    });
    expect(result.current.isSending).toBe(true);

    await act(async () => {
      streamState.calls[0].resolve();
    });
    expect(result.current.isSending).toBe(false);
    expect(result.current.streamingSessionId).toBeNull();
  });
});
