// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AbstractAgent } from "@ag-ui/client";

import { useAguiCustomEvents } from "./use-agui-custom-events";

// vitest runs with globals:false, so RTL cannot auto-register its cleanup.
afterEach(cleanup);

// Minimal fake agent: captures the subscriber so a test can drive custom events
// the way the real AG-UI run would. Only the members the hook touches.
function makeFakeAgent(initialMessages: Array<{ id: string; role: string; content: string }> = []) {
  type FakeMessages = Array<{ id: string; role: string; content: string }>;
  let sub:
    | {
        onRunInitialized?: () => void;
        onRunFinalized?: () => void;
        onRunFailed?: () => void;
        onCustomEvent?: (arg: {
          event: { name: string; value?: Record<string, unknown> };
          messages: FakeMessages;
        }) => { messages?: FakeMessages } | void;
      }
    | null = null;
  const unsubscribe = vi.fn();
  // Two distinct buffers, mirroring @ag-ui/client:
  //  - `runBuffer` is what defaultApplyEvents/processApplyEvents own during a run;
  //    only a subscriber's RETURNED { messages } folds into it.
  //  - `agent.messages` is what processApplyEvents OVERWRITES from runBuffer on
  //    every event. A direct setMessages() writes here but is clobbered by the
  //    next event's overwrite — exactly the bug the fix addresses.
  let runBuffer = initialMessages;
  let published = initialMessages;
  const agent = {
    get messages() {
      return published;
    },
    setMessages(next: FakeMessages) {
      published = next; // NOT folded into runBuffer — reverted on the next event.
    },
    subscribe(s: NonNullable<typeof sub>) {
      sub = s;
      return { unsubscribe };
    }
  } as unknown as AbstractAgent;
  const emit = (name: string, value?: Record<string, unknown>) =>
    act(() => {
      const result = sub?.onCustomEvent?.({ event: { name, value }, messages: runBuffer });
      if (result && result.messages !== undefined) runBuffer = result.messages;
      // processApplyEvents overwrites the published messages from the run buffer
      // after the event — this is what reverts a stray setMessages().
      published = runBuffer;
    });
  return { agent, emit, unsubscribe };
}

describe("useAguiCustomEvents — tool_status side-channel (R8)", () => {
  it("surfaces a failed tool as a row, merging server from a prior tool_meta", () => {
    const { agent, emit } = makeFakeAgent();
    const { result } = renderHook(() => useAguiCustomEvents(agent));

    emit("tool_meta", { toolCallId: "c1", kind: "mcp", server: "github", command: null });
    emit("tool_status", { toolCallId: "c1", toolName: "create_issue", status: "failed", durationMs: 12 });

    expect(result.current.toolStatuses).toEqual([
      {
        type: "tool-status",
        rowId: "tool:c1",
        toolCallId: "c1",
        toolName: "create_issue",
        status: "failed",
        server: "github",
        durationMs: 12
      }
    ]);
  });

  it("surfaces a failed built-in with no tool_meta (server null)", () => {
    const { agent, emit } = makeFakeAgent();
    const { result } = renderHook(() => useAguiCustomEvents(agent));

    emit("tool_status", { toolCallId: "c2", toolName: "execute", status: "declined" });

    expect(result.current.toolStatuses).toEqual([
      {
        type: "tool-status",
        rowId: "tool:c2",
        toolCallId: "c2",
        toolName: "execute",
        status: "declined",
        server: null,
        durationMs: null
      }
    ]);
  });

  it("does NOT create a row for a successful tool (tool_meta only, no tool_status)", () => {
    const { agent, emit } = makeFakeAgent();
    const { result } = renderHook(() => useAguiCustomEvents(agent));

    emit("tool_meta", { toolCallId: "c3", kind: "command", server: null, command: "ls" });

    expect(result.current.toolStatuses).toEqual([]);
  });

  it("seeds toolStatuses from persisted history on mount (reload parity, F4)", () => {
    const { agent } = makeFakeAgent();
    const seed = [
      {
        type: "tool-status" as const,
        rowId: "tool:hist-1",
        toolCallId: "hist-1",
        toolName: "search",
        status: "failed" as const,
        server: "github",
        durationMs: 5
      }
    ];
    const { result } = renderHook(() =>
      useAguiCustomEvents(agent, undefined, seed)
    );

    expect(result.current.toolStatuses).toEqual(seed);
  });

  it("dedupes a live tool_status against a seeded row with the same toolCallId", () => {
    const { agent, emit } = makeFakeAgent();
    const seed = [
      {
        type: "tool-status" as const,
        rowId: "tool:c1",
        toolCallId: "c1",
        toolName: "search",
        status: "failed" as const,
        server: null,
        durationMs: null
      }
    ];
    const { result } = renderHook(() =>
      useAguiCustomEvents(agent, undefined, seed)
    );

    // A live re-run of the same call must replace, not duplicate, the seeded row.
    emit("tool_status", { toolCallId: "c1", toolName: "search", status: "declined", durationMs: 9 });

    expect(result.current.toolStatuses).toEqual([
      {
        type: "tool-status",
        rowId: "tool:c1",
        toolCallId: "c1",
        toolName: "search",
        status: "declined",
        server: null,
        durationMs: 9
      }
    ]);
  });
});

describe("useAguiCustomEvents — user_message_replaced (F8 — PII transform)", () => {
  const readMessages = (agent: AbstractAgent) =>
    (agent as unknown as { messages: Array<{ id: string; role: string; content: string }> }).messages;

  it("patches the last user message via a RETURNED mutation folded into the run buffer", () => {
    // The emit helper mirrors AG-UI: it folds a returned { messages } back into
    // the buffer. A direct setMessages would NOT survive the run (see handler).
    const { agent, emit } = makeFakeAgent([
      { id: "u1", role: "user", content: "first" },
      { id: "a1", role: "assistant", content: "reply" },
      { id: "u2", role: "user", content: "my card is 4111 1111 1111 1111" }
    ]);
    renderHook(() => useAguiCustomEvents(agent));

    emit("user_message_replaced", { messageId: "server-id", text: "my card is [REDACTED]" });

    // Only the LAST user message is patched; earlier messages are untouched.
    expect(readMessages(agent)).toEqual([
      { id: "u1", role: "user", content: "first" },
      { id: "a1", role: "assistant", content: "reply" },
      { id: "u2", role: "user", content: "my card is [REDACTED]" }
    ]);
  });

  it("is a no-op when the last user message already holds the transformed text", () => {
    const original = [{ id: "u1", role: "user", content: "already [REDACTED]" }];
    const { agent, emit } = makeFakeAgent(original);
    renderHook(() => useAguiCustomEvents(agent));
    const before = readMessages(agent);

    emit("user_message_replaced", { messageId: "x", text: "already [REDACTED]" });

    // Handler returned no mutation → the buffer is untouched (same reference).
    expect(readMessages(agent)).toBe(before);
  });

  it("is a no-op when there is no user message to patch", () => {
    const { agent, emit } = makeFakeAgent([{ id: "a1", role: "assistant", content: "hi" }]);
    renderHook(() => useAguiCustomEvents(agent));
    const before = readMessages(agent);

    emit("user_message_replaced", { messageId: "x", text: "whatever" });

    expect(readMessages(agent)).toBe(before);
  });
});
