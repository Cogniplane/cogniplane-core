// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Approval, McpAppCall } from "@cogniplane/shared-types";
import type { AbstractAgent } from "@ag-ui/client";

import * as sessionApi from "../session-api";
import type { RuntimeNoticeRow } from "../../components/chat-cards/chat-cards.types";
import { useAguiCustomEvents } from "./use-agui-custom-events";

// vitest runs with globals:false, so RTL cannot auto-register its cleanup.
afterEach(cleanup);

// Minimal fake agent: captures the subscriber so a test can drive custom events
// the way the real AG-UI run would. Only the members the hook touches. The
// real library runs in copilot-chat-host.test.tsx.
function makeFakeAgent() {
  type RunInput = { runId: string; forwardedProps: Record<string, unknown>; messages: [] };
  let sub:
    | {
        onRunInitialized?: (arg: { input: RunInput }) => void;
        onCustomEvent?: (arg: { event: { name: string; value?: Record<string, unknown> }; input: RunInput }) => void;
      }
    | null = null;
  const unsubscribe = vi.fn();
  let runs = 0;
  let input: RunInput = { runId: "run-0", forwardedProps: {}, messages: [] };
  const agent = {
    threadId: "s-1",
    subscribe(s: NonNullable<typeof sub>) {
      sub = s;
      return { unsubscribe };
    }
  } as unknown as AbstractAgent;
  const run = {
    // A sent message, or a session connection.
    init: (reconnect = false) => act(() => {
      runs += 1;
      input = { runId: `run-${runs}`, forwardedProps: reconnect ? { cogniplaneReconnect: true } : {}, messages: [] };
      sub?.onRunInitialized?.({ input });
    })
  };
  const emit = (name: string, value?: Record<string, unknown>) =>
    act(() => sub?.onCustomEvent?.({ event: { name, value }, input }));
  return { agent, emit, run, unsubscribe };
}

describe("useAguiCustomEvents — tool_status side-channel (R8)", () => {
  it("dismisses accumulated failures without dismissing pending approvals", () => {
    const { agent, emit } = makeFakeAgent();
    const { result } = renderHook(() => useAguiCustomEvents(agent));
    emit("approval_required", { approvalId: "pending", itemId: "item", kind: "command_execution", title: "Approve", summary: "Run command" });
    for (let i = 0; i < 20; i++) {
      emit("tool_status", { toolCallId: `failed-${i}`, toolName: "tool", status: "failed" });
    }
    expect(result.current.toolStatuses).toHaveLength(20);
    act(() => result.current.dismissStatusRows());
    expect(result.current.toolStatuses).toEqual([]);
    expect(result.current.approvals).toHaveLength(1);
    emit("tool_status", { toolCallId: "new", toolName: "tool", status: "failed" });
    expect(result.current.toolStatuses).toHaveLength(1);
  });
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
      useAguiCustomEvents(agent, { initialToolStatuses: seed })
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
      useAguiCustomEvents(agent, { initialToolStatuses: seed })
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

  it("clears pending approvals when the connection reports a clean end of the turn", () => {
    const { agent, emit, run } = makeFakeAgent();
    const { result } = renderHook(() => useAguiCustomEvents(agent));

    run.init();
    emit("approval_required", approvalEvent("ap-1"));
    expect(result.current.approvals).toHaveLength(1);

    // A clean run holds open until every decision lands, so anything still
    // here is stale.
    act(() => result.current.clearApprovals());
    expect(result.current.approvals).toEqual([]);
  });

  it("keeps a pending approval when a new run starts", () => {
    const { agent, emit, run } = makeFakeAgent();
    const { result } = renderHook(() => useAguiCustomEvents(agent));

    run.init();
    emit("approval_required", approvalEvent("ap-1"));
    // The stream dropped mid-interrupt and the connection started again. The
    // backend row is still pending until its TTL, so the card stays.
    run.init(true);

    expect(result.current.approvals.map((a) => a.approvalId)).toEqual(["ap-1"]);
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
    // Retired backend event; an older backend or replay can still send it.
    emit("tool_ui_resources", { toolCallId: "call-1", uiResources: [{ uri: "ui://card", mimeType: "text/html" }] });
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
      ({ seed }) => useAguiCustomEvents(agent, { initialApprovals: seed }),
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
});

// Saved rows as `GET /sessions/:id/messages` returns them.
function savedReply(fields: Record<string, unknown>) {
  return {
    messageId: "a-1", sessionId: "s-1", role: "assistant", status: "completed", content: "Reply",
    createdAt: "2026-09-22T00:00:00.000Z", updatedAt: "2026-09-22T00:00:00.000Z", ...fields
  } as never;
}
function savedTool(toolResultId: string, status: "completed" | "failed", mcpApp?: McpAppCall) {
  return {
    toolResultId, kind: "mcp", title: "search", toolName: "search", status, command: null, cwd: null,
    server: null, input: "{}", output: "", exitCode: null, durationMs: null, textOffset: 0,
    ...(mcpApp ? { mcpApp } : {})
  };
}

describe("useAguiCustomEvents — server snapshot for a remote turn", () => {
  const pending = (approvalId: string) => ({
    approvalId, sessionId: "s-1", itemId: `item-${approvalId}`, kind: "command_execution",
    title: "Run command", summary: "ls", status: "pending", createdAt: "2026-09-22T00:00:00.000Z"
  }) as unknown as Approval;

  it("removes an approval already answered before replay reaches its request event", async () => {
    const list = vi.spyOn(sessionApi, "listApprovals").mockResolvedValue([]);
    const { agent, run, emit } = makeFakeAgent();
    const { result } = renderHook(() => useAguiCustomEvents(agent, { initialApprovals: [pending("ap-1")] }));

    run.init(true);
    emit("approval_required", {
      approvalId: "ap-1", itemId: "item-ap-1", kind: "command_execution", title: "Run command", summary: "ls"
    });

    await waitFor(() => expect(result.current.approvals).toEqual([]));
    expect(list).toHaveBeenCalledWith("s-1", expect.any(AbortSignal));
    list.mockRestore();
  });

  it("keeps a settled snapshot when an older approval read returns late", async () => {
    let finishRead!: (approvals: Approval[]) => void;
    const list = vi.spyOn(sessionApi, "listApprovals").mockImplementation(
      () => new Promise<Approval[]>((resolve) => { finishRead = resolve; })
    );
    const { agent, run, emit } = makeFakeAgent();
    const { result } = renderHook(() => useAguiCustomEvents(agent));

    run.init(true);
    emit("approval_required", {
      approvalId: "ap-1", itemId: "item-ap-1", kind: "command_execution", title: "Run command", summary: "ls"
    });
    act(() => result.current.syncServerState({ messages: [], approvals: [] }));
    await act(async () => finishRead([pending("ap-1")]));

    expect(result.current.approvals).toEqual([]);
    list.mockRestore();
  });

  it("replaces approvals and tool failures, and keeps a decision in flight", async () => {
    let resolveDecision: () => void = () => undefined;
    const decision = vi.spyOn(sessionApi, "resolveApproval").mockImplementation(
      () => new Promise<void>((resolve) => { resolveDecision = resolve; })
    );
    const { agent } = makeFakeAgent();
    const { result } = renderHook(() => useAguiCustomEvents(agent, { initialApprovals: [pending("ap-1")] }));

    act(() => result.current.onApprovalDecision("ap-1", { decision: "approve" }));
    act(() => result.current.syncServerState({
      messages: [savedReply({ toolResults: [savedTool("t-1", "failed")] })],
      approvals: [pending("ap-1"), pending("ap-2")]
    }));

    expect(result.current.approvals.map((row) => [row.approvalId, row.decisionState])).toEqual([
      ["ap-1", "approving"],
      ["ap-2", "pending"]
    ]);
    expect(result.current.toolStatuses.map((row) => row.toolCallId)).toEqual(["t-1"]);

    act(() => result.current.syncServerState({ messages: [], approvals: [] }));
    expect(result.current.approvals).toEqual([]);
    await act(async () => resolveDecision());
    decision.mockRestore();
  });
});

// A connection replays approval B and reads the pending approvals. Approval A
// expires or gets a decision while that read runs. The backend publishes an
// expiry notice before its database update commits, so a read can still list
// A as pending.
describe("useAguiCustomEvents — approval reads during other approval changes", () => {
  const pending = (approvalId: string) => ({
    approvalId, sessionId: "s-1", itemId: `item-${approvalId}`, kind: "command_execution",
    title: `Run ${approvalId}`, summary: "ls", status: "pending", createdAt: "2026-10-12T00:00:00.000Z"
  }) as unknown as Approval;
  const request = (approvalId: string) => ({
    approvalId, itemId: `item-${approvalId}`, kind: "command_execution", title: `Run ${approvalId}`, summary: "ls"
  });
  const expiry = (noticeId: string) => ({
    noticeId, level: "warning", title: "Approval expired", message: "No decision in time", createdAt: "2026-10-12T00:00:00.000Z"
  });

  /** Each read waits until the test answers it. */
  function heldReads() {
    const answers: Array<(approvals: Approval[]) => void> = [];
    const list = vi.spyOn(sessionApi, "listApprovals").mockImplementation(
      () => new Promise<Approval[]>((resolve) => { answers.push(resolve); })
    );
    const answer = (index: number, approvals: Approval[]) => act(async () => answers[index]!(approvals));
    return { list, answer };
  }

  afterEach(() => vi.restoreAllMocks());

  it.each(["approval-expired:", "policy-approval-expired:"])(
    "keeps B from a read when A expires (%s) during it",
    async (prefix) => {
      const { answer } = heldReads();
      const { agent, run, emit } = makeFakeAgent();
      const { result } = renderHook(() => useAguiCustomEvents(agent));

      run.init(true);
      emit("approval_required", request("B"));
      emit("runtime_notice", expiry(`${prefix}A`));
      await answer(0, [pending("B")]);

      expect(result.current.approvals.map((row) => row.approvalId)).toEqual(["B"]);
    }
  );

  it("does not bring back A when a read during or after its expiry still lists it", async () => {
    const { answer } = heldReads();
    const { agent, run, emit } = makeFakeAgent();
    const { result } = renderHook(() => useAguiCustomEvents(agent, { initialApprovals: [pending("A")] }));

    run.init(true);
    emit("approval_required", request("B"));
    emit("runtime_notice", expiry("approval-expired:A"));
    await answer(0, [pending("A"), pending("B")]);
    expect(result.current.approvals.map((row) => row.approvalId)).toEqual(["B"]);

    // A read that starts after the notice can also run before the update.
    emit("approval_required", request("C"));
    await answer(1, [pending("A"), pending("B"), pending("C")]);
    expect(result.current.approvals.map((row) => row.approvalId)).toEqual(["B", "C"]);
  });

  it("keeps B and drops A when A gets a decision during the read", async () => {
    const { answer } = heldReads();
    const decision = vi.spyOn(sessionApi, "resolveApproval").mockResolvedValue(undefined);
    const { agent, run, emit } = makeFakeAgent();
    const { result } = renderHook(() => useAguiCustomEvents(agent, { initialApprovals: [pending("A")] }));

    run.init(true);
    emit("approval_required", request("B"));
    await act(async () => result.current.onApprovalDecision("A", { decision: "approve" }));
    expect(decision).toHaveBeenCalledWith("A", "approve", undefined);
    await answer(0, [pending("A"), pending("B")]);

    expect(result.current.approvals.map((row) => [row.approvalId, row.decisionState])).toEqual([["B", "pending"]]);
  });

  it.each([
    ["a clean end of the turn", (current: ReturnType<typeof useAguiCustomEvents>) => current.clearApprovals()],
    ["a newer snapshot", (current: ReturnType<typeof useAguiCustomEvents>) =>
      current.syncServerState({ messages: [], approvals: [pending("C")] })]
  ])("lets %s outrank an older read", async (_, replace) => {
    const { answer } = heldReads();
    const { agent, run, emit } = makeFakeAgent();
    const { result } = renderHook(() => useAguiCustomEvents(agent));

    run.init(true);
    emit("approval_required", request("B"));
    act(() => replace(result.current));
    const after = result.current.approvals.map((row) => row.approvalId);
    await answer(0, [pending("B")]);

    expect(result.current.approvals.map((row) => row.approvalId)).toEqual(after);
    expect(after).not.toContain("B");
  });

  it("ignores a read of an earlier run", async () => {
    const { answer } = heldReads();
    const { agent, run, emit } = makeFakeAgent();
    const { result } = renderHook(() => useAguiCustomEvents(agent));

    run.init(true);
    emit("approval_required", request("B"));
    run.init(true);
    await answer(0, [pending("B")]);

    expect(result.current.approvals).toEqual([]);
  });

  it("ignores a read that returns after a session switch", async () => {
    const { answer } = heldReads();
    const first = makeFakeAgent();
    const second = makeFakeAgent();
    const { result, rerender } = renderHook(({ agent }) => useAguiCustomEvents(agent), { initialProps: { agent: first.agent } });

    first.run.init(true);
    first.emit("approval_required", request("B"));
    rerender({ agent: second.agent });
    await answer(0, [pending("B")]);

    expect(result.current.approvals).toEqual([]);
  });
});

describe("useAguiCustomEvents — saved runtime notices", () => {
  const notice = (noticeId: string, title = "Notice"): RuntimeNoticeRow => ({
    type: "runtime-notice", rowId: `notice:${noticeId}`, noticeId, level: "warning",
    title, message: "Details", createdAt: "2026-09-22T00:00:00.000Z"
  });
  const liveNotice = (noticeId: string) => ({
    noticeId, level: "warning", title: "Live", message: "Details", createdAt: "2026-09-22T00:00:00.000Z"
  });

  it("shows saved notices and does not add a live notice with the same id", () => {
    const { agent, emit } = makeFakeAgent();
    const { result } = renderHook(() => useAguiCustomEvents(agent, { initialNotices: [notice("n-1", "Saved")] }));

    emit("runtime_notice", liveNotice("n-1"));
    emit("runtime_notice", liveNotice("n-2"));

    expect(result.current.notices.map((row) => [row.noticeId, row.title])).toEqual([
      ["n-1", "Saved"],
      ["n-2", "Live"]
    ]);
  });

  it("adds polled notices once, keeps live ones, and does not bring back dismissed ones", () => {
    const { agent, emit } = makeFakeAgent();
    const { result } = renderHook(() => useAguiCustomEvents(agent));
    const snapshot = (notices: RuntimeNoticeRow[]) => ({
      messages: [savedReply({ detail: { runtimeNotices: notices.map(({ noticeId, level, title, message, createdAt }) => ({ noticeId, level, title, message, createdAt })) } })],
      approvals: []
    });

    emit("runtime_notice", liveNotice("n-1"));
    act(() => result.current.syncServerState(snapshot([notice("n-1", "Saved"), notice("n-2")])));
    act(() => result.current.syncServerState(snapshot([notice("n-1", "Saved"), notice("n-2")])));
    expect(result.current.notices.map((row) => [row.noticeId, row.title])).toEqual([
      ["n-1", "Live"],
      ["n-2", "Notice"]
    ]);

    act(() => result.current.dismissStatusRows());
    act(() => result.current.syncServerState(snapshot([notice("n-1"), notice("n-2"), notice("n-3")])));
    emit("runtime_notice", liveNotice("n-2"));
    expect(result.current.notices.map((row) => row.noticeId)).toEqual(["n-3"]);
  });
});

describe("useAguiCustomEvents — MCP apps", () => {
  const app = (uri: string) => ({ resourceUri: uri, result: { content: [] } }) as unknown as McpAppCall;

  it("keeps saved apps and adds live and polled ones", () => {
    const { agent, emit } = makeFakeAgent();
    const { result } = renderHook(() => useAguiCustomEvents(agent, { initialMcpApps: { "tc-1": app("ui://saved") } }));

    emit("tool_mcp_app", { toolCallId: "tc-2", app: app("ui://live") });
    act(() => result.current.syncServerState({
      messages: [savedReply({ toolResults: [savedTool("tc-3", "completed", app("ui://polled"))] })],
      approvals: []
    }));
    expect(Object.keys(result.current.mcpApps)).toEqual(["tc-1", "tc-2", "tc-3"]);
  });
});

describe("useAguiCustomEvents — refused sends", () => {
  const refusal: RuntimeNoticeRow = {
    type: "runtime-notice", rowId: "notice:send-refused:1", noticeId: "send-refused:1", level: "error",
    title: "Your message was not sent", message: "Limit", createdAt: "2026-09-22T00:00:00.000Z"
  };

  it("shows a refusal until the next send, and keeps it while a connection loads", () => {
    const { agent, run } = makeFakeAgent();
    const { result } = renderHook(() => useAguiCustomEvents(agent));

    act(() => result.current.addNotice(refusal));
    run.init(true);
    expect(result.current.notices.map((row) => row.noticeId)).toEqual(["send-refused:1"]);

    run.init();
    expect(result.current.notices).toEqual([]);
  });
});
