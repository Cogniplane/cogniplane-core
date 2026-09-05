// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Approval } from "@cogniplane/shared-types";
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
  const run = {
    init: () => act(() => sub?.onRunInitialized?.()),
    finalize: () => act(() => sub?.onRunFinalized?.()),
    fail: () => act(() => sub?.onRunFailed?.())
  };
  const emit = (name: string, value?: Record<string, unknown>) =>
    act(() => {
      const result = sub?.onCustomEvent?.({ event: { name, value }, messages: runBuffer });
      if (result && result.messages !== undefined) runBuffer = result.messages;
      // processApplyEvents overwrites the published messages from the run buffer
      // after the event — this is what reverts a stray setMessages().
      published = runBuffer;
    });
  return { agent, emit, run, unsubscribe };
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

describe("useAguiCustomEvents — approvals (R19)", () => {
  const approvalEvent = (approvalId: string) => ({
    approvalId,
    itemId: `item-${approvalId}`,
    kind: "command_execution",
    title: "Approve run",
    summary: "rm -rf build"
  });

  it("drops the approval when a native expiry notice arrives", () => {
    const { agent, emit } = makeFakeAgent();
    const { result } = renderHook(() => useAguiCustomEvents(agent));

    emit("approval_required", approvalEvent("ap-1"));
    emit("approval_required", approvalEvent("ap-2"));
    emit("runtime_notice", {
      noticeId: "approval-expired:ap-1",
      level: "warning",
      title: "Approval expired",
      message: "No decision in time",
      createdAt: "2026-09-03T00:00:00.000Z"
    });

    expect(result.current.approvals.map((a) => a.approvalId)).toEqual(["ap-2"]);
    // The notice itself still renders — only the actionable card goes.
    expect(result.current.notices).toHaveLength(1);
  });

  it("drops the approval when a Policy Center expiry notice arrives", () => {
    const { agent, emit } = makeFakeAgent();
    const { result } = renderHook(() => useAguiCustomEvents(agent));

    emit("approval_required", approvalEvent("ap-9"));
    emit("runtime_notice", {
      noticeId: "policy-approval-expired:ap-9",
      level: "warning",
      title: "Approval expired",
      message: "No decision in time",
      createdAt: "2026-09-03T00:00:00.000Z"
    });

    expect(result.current.approvals).toEqual([]);
  });

  it("leaves approvals alone on an unrelated notice", () => {
    const { agent, emit } = makeFakeAgent();
    const { result } = renderHook(() => useAguiCustomEvents(agent));

    emit("approval_required", approvalEvent("ap-1"));
    emit("runtime_notice", {
      noticeId: "workspace-sync-failed",
      level: "warning",
      title: "Sync failed",
      message: "…",
      createdAt: "2026-09-03T00:00:00.000Z"
    });

    expect(result.current.approvals).toHaveLength(1);
  });

  it("clears pending approvals when the run finishes cleanly", () => {
    const { agent, emit, run } = makeFakeAgent();
    const { result } = renderHook(() => useAguiCustomEvents(agent));

    run.init();
    emit("approval_required", approvalEvent("ap-1"));
    expect(result.current.approvals).toHaveLength(1);

    run.finalize();

    // A clean run holds open until every decision lands, so anything still
    // here is stale.
    expect(result.current.approvals).toEqual([]);
    expect(result.current.isRunning).toBe(false);
  });

  it("KEEPS a pending approval when the run fails", () => {
    const { agent, emit, run } = makeFakeAgent();
    const { result } = renderHook(() => useAguiCustomEvents(agent));

    run.init();
    emit("approval_required", approvalEvent("ap-1"));

    // The stream dropped mid-interrupt. The backend row is still pending and
    // the graph is still paused until its TTL, so the card has to stay
    // actionable — the REST snapshot only feeds an attention count.
    run.fail();
    run.finalize();

    expect(result.current.approvals.map((a) => a.approvalId)).toEqual(["ap-1"]);
    expect(result.current.isRunning).toBe(false);
  });
});

describe("useAguiCustomEvents — settlement (double-settle on failure)", () => {
  it("settles once when a failed run fires both onRunFailed and onRunFinalized", () => {
    const { agent, run } = makeFakeAgent();
    const onRunSettled = vi.fn();
    renderHook(() => useAguiCustomEvents(agent, onRunSettled));

    run.init();
    // @ag-ui/client's runAgent: catchError → onRunFailed, then finalize →
    // onRunFinalized. Both reach the subscriber for the same failed run.
    run.fail();
    run.finalize();

    expect(onRunSettled).toHaveBeenCalledTimes(1);
  });

  it("settles again on the next run", () => {
    const { agent, run } = makeFakeAgent();
    const onRunSettled = vi.fn();
    renderHook(() => useAguiCustomEvents(agent, onRunSettled));

    run.init();
    run.finalize();
    run.init();
    run.finalize();

    expect(onRunSettled).toHaveBeenCalledTimes(2);
  });
});

describe("useAguiCustomEvents — mcp_server_status (R79)", () => {
  it("keeps only the latest status per server", () => {
    const { agent, emit } = makeFakeAgent();
    const { result } = renderHook(() => useAguiCustomEvents(agent));

    emit("mcp_server_status", { serverName: "github", status: "starting" });
    emit("mcp_server_status", { serverName: "notion", status: "starting" });
    emit("mcp_server_status", { serverName: "github", status: "failed", error: "handshake timeout" });

    expect(result.current.mcpStatuses).toEqual([
      {
        type: "mcp-server-status",
        rowId: "mcp:notion",
        serverName: "notion",
        status: "starting",
        error: null
      },
      {
        type: "mcp-server-status",
        rowId: "mcp:github",
        serverName: "github",
        status: "failed",
        error: "handshake timeout"
      }
    ]);
  });

  it("does not surface a healthy `ready` transition", () => {
    const { agent, emit } = makeFakeAgent();
    const { result } = renderHook(() => useAguiCustomEvents(agent));

    emit("mcp_server_status", { serverName: "github", status: "ready" });

    expect(result.current.mcpStatuses).toEqual([]);
  });

  it("drops a server back off the list only when a newer status replaces it", () => {
    const { agent, emit } = makeFakeAgent();
    const { result } = renderHook(() => useAguiCustomEvents(agent));

    emit("mcp_server_status", { serverName: "github", status: "starting" });
    // "ready" is skipped entirely, so the "starting" row survives it.
    emit("mcp_server_status", { serverName: "github", status: "ready" });

    expect(result.current.mcpStatuses.map((s) => s.status)).toEqual(["starting"]);
  });
});


describe("custom event validation", () => {
  it("ignores malformed known events before they can create broken cards", () => {
    const { agent, emit } = makeFakeAgent();
    const { result } = renderHook(() => useAguiCustomEvents(agent));
    emit("approval_required", { approvalId: "bad", title: "Missing fields" });
    emit("runtime_notice", { noticeId: "bad", title: "Missing fields" });
    emit("tool_status", { toolCallId: "bad", status: "unknown" });
    expect(result.current.approvals).toEqual([]);
    expect(result.current.notices).toEqual([]);
    expect(result.current.toolStatuses).toEqual([]);
  });

  it("ignores unknown extension events", () => {
    const { agent, emit } = makeFakeAgent();
    const { result } = renderHook(() => useAguiCustomEvents(agent));
    emit("third_party_event", { approvalId: "unrelated" });
    expect(result.current.approvals).toEqual([]);
    expect(result.current.notices).toEqual([]);
    expect(result.current.toolStatuses).toEqual([]);
    expect(result.current.mcpStatuses).toEqual([]);
  });
});

describe("persisted approval seeds", () => {
  const approval: Approval = {
    approvalId: "persisted", sessionId: "s-1", itemId: "call-1", kind: "mcp_tool",
    title: "Publish report", summary: "Publish draft", status: "pending"
  };

  it("deduplicates REST and live approvals and does not revive expired rows on refresh", () => {
    const { agent, emit } = makeFakeAgent();
    const { result, rerender } = renderHook(
      ({ seed }) => useAguiCustomEvents(agent, undefined, [], seed),
      { initialProps: { seed: [approval, approval] } }
    );
    expect(result.current.approvals).toHaveLength(1);
    emit("approval_required", approval);
    expect(result.current.approvals).toHaveLength(1);
    emit("runtime_notice", {
      noticeId: "approval-expired:persisted", level: "warning", title: "Expired",
      message: "No decision in time", createdAt: "2026-09-04T12:00:00.000Z"
    });
    expect(result.current.approvals).toEqual([]);
    rerender({ seed: [approval] });
    expect(result.current.approvals).toEqual([]);
  });

  it("takes only the new session's pending seed when the agent changes", () => {
    const first = makeFakeAgent();
    const second = makeFakeAgent();
    const { result, rerender } = renderHook(
      ({ agent, seed }) => useAguiCustomEvents(agent, undefined, [], seed),
      { initialProps: { agent: first.agent, seed: [approval] } }
    );
    rerender({ agent: second.agent, seed: [{ ...approval, approvalId: "other", status: "approved" }] });
    expect(result.current.approvals).toEqual([]);
    expect(first.unsubscribe).toHaveBeenCalledOnce();
  });
});
