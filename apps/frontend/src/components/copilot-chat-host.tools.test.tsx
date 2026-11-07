// @vitest-environment jsdom
//
// Tool cards in the chat host, with the real CopilotKit provider, CopilotChat
// and DeepAgentsBrowserAgent, and a fixture for the network. Saved history and
// a live turn show the same cards. A card names the call, shows its status
// from the run and tool lifecycle, and shows a result only for a tool that is
// known to return plain text. A pending approval that names its tool call
// shows its decision controls in that card; any other pending approval shows
// them in the notification list. One approval never has two sets of controls.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("./model-effort-selector", () => ({ ModelEffortSelector: () => null }));
vi.mock("./context-window-meter", () => ({ ContextWindowMeter: () => null }));

import { ev, FixtureServer, idleHistory, installBrowserLayoutStubs, savedApproval, type FixtureStream } from "../test-helpers/agui-fixture-server";
import { CopilotChatHost } from "./copilot-chat-host";
import runningToolHistory from "../../../../test-fixtures/agui/running-tool-history.json";
import pendingApprovalHistory from "../../../../test-fixtures/agui/pending-approval-history.json";

installBrowserLayoutStubs();

let server: FixtureServer;
beforeEach(() => {
  server = new FixtureServer();
  vi.stubGlobal("fetch", server.fetch);
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

type SessionOverrides = Partial<Parameters<typeof CopilotChatHost>[0]["session"]>;

function hostElement(session: SessionOverrides = {}) {
  return (
    <CopilotChatHost
      session={{ id: "s-1", initialToolStatuses: [], initialApprovals: [], canEdit: true, ...session }}
      modelSelection={{
        model: "model-1", effort: null, models: [], showEffortSelector: false,
        onModelChange: () => undefined, onEffortChange: () => undefined
      }}
      usage={{ contextTokens: 0, contextWindow: 1000, sessionCostUsd: 0 }}
      artifactIds={[]}
      events={{}}
    />
  );
}

const call = (id: string, name: string, args: unknown) => ({
  id: `m-${id}`, role: "assistant",
  toolCalls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }]
});
const result = (id: string, content: string, error?: "failed" | "declined" | "interrupted") => ({
  id: `${id}:result`, role: "tool", toolCallId: id, content, ...(error ? { error } : {})
});

const INTERRUPTED_NOTE = "The turn stopped before this tool gave a result. The action can be done, partly done, or not started. Check before you repeat it.";

/** The card whose button names the action. */
const card = (name: RegExp | string) => screen.getByRole("button", { name }).closest("article")!;
const resultOf = (article: HTMLElement) => within(article).queryByRole("group")?.textContent ?? null;

describe("saved tool calls", () => {
  it("summarizes common tools, shows text results, and keeps unknown tools to a name and raw details", async () => {
    server.connect("s-1", idleHistory([
      { id: "u1", role: "user", content: "Check the repo" },
      call("tc-read", "read_file", { file_path: "/docs/plan.md" }), result("tc-read", "# Plan\nShip it"),
      call("tc-exec", "execute", { command: "pnpm test" }), result("tc-exec", "PASS a\nPASS b"),
      call("tc-grep", "grep", { pattern: "TODO", path: "/" }), result("tc-grep", ""),
      call("tc-ui", "render_ui", { target: "chat", operations: [] }), result("tc-ui", '{"rendered":["s"],"rejected":[]}'),
      call("tc-jira", "jira_get_issue", { issueIdOrKey: "ABC-1" }), result("tc-jira", '{"key":"ABC-1"}')
    ]));
    render(hostElement());

    const read = await waitFor(() => card(/Read file/));
    expect(read.textContent).toContain("/docs/plan.md");
    expect(read.textContent).toContain("done");
    expect(resultOf(read)).toBe("# Plan\nShip it");
    expect(card(/Run command/).textContent).toContain("pnpm test");
    expect(resultOf(card(/Run command/))).toBe("PASS a\nPASS b");
    expect(within(card(/Search files/)).getByText("No output.")).toBeTruthy();
    // The SDK renders a render_ui call as generated UI, never as a tool card.
    expect(screen.queryByText(/render_ui|Show generated view/)).toBeNull();
    const jira = card(/Jira get issue/);
    expect(jira.textContent).not.toContain("ABC-1");
    expect(resultOf(jira)).toBeNull();

    // The details keep the exact call name, the input and the result, with labels.
    fireEvent.click(within(jira).getByRole("button"));
    expect(within(jira).getByText("jira_get_issue")).toBeTruthy();
    expect(within(jira).getByRole("group", { name: "Input" }).textContent).toContain('"issueIdOrKey": "ABC-1"');
    expect(within(jira).getByRole("group", { name: "Result" }).textContent).toBe('{"key":"ABC-1"}');
    // Nothing in a card starts a turn or calls the server.
    expect(server.calls).toEqual(["GET /sessions/s-1/connect"]);
  });

  it("marks failed, declined and interrupted calls from the saved outcome and shows the message of the first two", async () => {
    server.connect("s-1", idleHistory([
      call("tc-f", "execute", { command: "false" }), result("tc-f", "exit code 1", "failed"),
      call("tc-d", "write_file", { file_path: "/a.txt", content: "x" }), result("tc-d", "User denied permission.", "declined"),
      call("tc-i", "grep", { pattern: "x" }), result("tc-i", "", "interrupted"),
      call("tc-e", "read_file", { file_path: "/empty.txt" }), result("tc-e", "", "failed")
    ]));
    render(hostElement());

    const failed = await waitFor(() => card(/Run command/));
    expect(within(failed).getByText("failed")).toBeTruthy();
    expect(resultOf(failed)).toBe("exit code 1");
    expect(within(card(/Write file/)).getByText("declined")).toBeTruthy();
    expect(resultOf(card(/Write file/))).toBe("User denied permission.");
    expect(within(card(/Search files/)).getByText("interrupted")).toBeTruthy();
    expect(resultOf(card(/Search files/))).toBeNull();
    // Only the interrupted call says that the turn stopped before the tool gave a result.
    expect(screen.getAllByText(INTERRUPTED_NOTE)).toHaveLength(1);
    expect(within(card(/Search files/)).getByText(INTERRUPTED_NOTE)).toBeTruthy();
    expect(within(card(/Read file/)).getByText("The tool gave no message.")).toBeTruthy();
  });

  it("shows a call that has no result as interrupted when no turn runs, and as running while one does", async () => {
    // The backend history test checks these messages against its converter.
    const history = (activeTurn: "none" | "unavailable") => ev.history({
      messages: runningToolHistory[activeTurn], activeTurn
    });
    server.connect("s-1", (stream) => { stream.push(...history("none")); stream.finish(); });
    const idle = render(hostElement());

    await waitFor(() => expect(within(card(/Run command/)).getByText("interrupted")).toBeTruthy());
    idle.unmount();

    // The turn runs on the server without a stream in this tab.
    server.running.set("s-1", true);
    server.connect("s-1", (stream) => {
      stream.push(...history("unavailable"));
      stream.finish();
    });
    render(hostElement({ isRunning: true }));

    await waitFor(() => expect(within(card(/Run command/)).getByText("running…")).toBeTruthy());
    expect(screen.queryByText("interrupted")).toBeNull();
  });
});

describe("tool calls of a live turn", () => {
  const toolEvents = (id: string, name: string, args: unknown) => [
    { type: "TOOL_CALL_START", toolCallId: id, toolCallName: name },
    { type: "TOOL_CALL_ARGS", toolCallId: id, delta: JSON.stringify(args) },
    { type: "TOOL_CALL_END", toolCallId: id }
  ];
  const toolResult = (id: string, content: string) => ({ type: "TOOL_CALL_RESULT", messageId: `${id}:result`, toolCallId: id, content, role: "tool" });

  it("keeps an unfinished call interrupted after RUN_ERROR, when another turn starts, and after a reload", async () => {
    server.connect("s-1", idleHistory([]));
    let first!: FixtureStream;
    let second!: FixtureStream;
    server.messageReplies = [
      (stream) => { first = stream; stream.push(ev.runStarted("r-1")); },
      (stream) => { second = stream; stream.push(ev.runStarted("r-2")); }
    ];
    render(hostElement());
    const input = await screen.findByTestId("copilot-chat-textarea");
    const send = async (value: string) => {
      await act(async () => {
        fireEvent.change(input, { target: { value } });
        fireEvent.keyDown(input, { key: "Enter" });
      });
    };
    await send("First");
    await waitFor(() => expect(server.sent).toHaveLength(1));
    act(() => first.push(...toolEvents("tc-old", "read_file", { file_path: "/old" })));
    await waitFor(() => expect(within(card(/Read file/)).getByText("running…")).toBeTruthy());
    act(() => { first.push(ev.runError("Turn failed")); first.finish(); });
    await waitFor(() => expect(within(card(/Read file/)).getByText("interrupted")).toBeTruthy());
    await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(false));
    await send("Second");
    await waitFor(() => expect(server.sent).toHaveLength(2));
    act(() => second.push(...toolEvents("tc-new", "execute", { command: "pwd" })));
    await waitFor(() => expect(within(card(/Run command/)).getByText("running…")).toBeTruthy());
    expect(within(card(/Read file/)).getByText("interrupted")).toBeTruthy();
    act(() => { second.push(toolResult("tc-new", "/"), ev.runFinished("r-2")); second.finish(); });
    await waitFor(() => expect(within(card(/Run command/)).getByText("done")).toBeTruthy());
    expect(screen.queryByText("failed")).toBeNull();

    // Reload (issue #16). The transcript of the failed turn keeps the call in_progress, and history gives it
    // the `interrupted` result (turn-transcript.test.ts covers that side). The label stays the same.
    cleanup();
    server.connect("s-1", idleHistory([
      { id: "u1", role: "user", content: "First" },
      call("tc-old", "read_file", { file_path: "/old" }), result("tc-old", "", "interrupted"),
      { id: "u2", role: "user", content: "Second" },
      call("tc-new", "execute", { command: "pwd" }), result("tc-new", "/")
    ]));
    render(hostElement());
    await waitFor(() => expect(within(card(/Read file/)).getByText("interrupted")).toBeTruthy());
    expect(within(card(/Read file/)).getByText(INTERRUPTED_NOTE)).toBeTruthy();
    expect(screen.queryByText("failed")).toBeNull();
  });

  it("shows a stopped command as interrupted, never as failed, and keeps it so when the next turn starts", async () => {
    server.connect("s-1", idleHistory([]));
    let first!: FixtureStream;
    let second!: FixtureStream;
    server.messageReplies = [
      (stream) => { first = stream; stream.push(ev.runStarted("r-1")); },
      (stream) => { second = stream; stream.push(ev.runStarted("r-2")); }
    ];
    render(hostElement());
    const input = await screen.findByTestId("copilot-chat-textarea");
    const send = async (value: string) => {
      await act(async () => {
        fireEvent.change(input, { target: { value } });
        fireEvent.keyDown(input, { key: "Enter" });
      });
    };
    await send("Sleep");
    await waitFor(() => expect(server.sent).toHaveLength(1));
    act(() => first.push(...toolEvents("tc-sleep", "execute", { command: "sleep 20" })));
    await waitFor(() => expect(within(card(/Run command/)).getByText("running…")).toBeTruthy());

    // Stop: the backend ends the turn with the interrupted marker. The call has no result and no failure.
    act(() => {
      first.push({ type: "RUN_FINISHED", threadId: "s-1", runId: "r-1", result: { interrupted: true } });
      first.finish();
    });
    await waitFor(() => expect(within(card(/Run command/)).getByText("interrupted")).toBeTruthy());
    expect(within(card(/Run command/)).getByText(INTERRUPTED_NOTE)).toBeTruthy();
    expect(screen.queryByText("failed")).toBeNull();
    expect(screen.queryByText("The tool gave no message.")).toBeNull();

    await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(false));
    await send("Again");
    await waitFor(() => expect(server.sent).toHaveLength(2));
    act(() => second.push(...toolEvents("tc-pwd", "read_file", { file_path: "/a.md" })));
    await waitFor(() => expect(within(card(/Read file/)).getByText("running…")).toBeTruthy());
    expect(within(card(/Run command/)).getByText("interrupted")).toBeTruthy();
    expect(screen.queryByText("failed")).toBeNull();
    act(() => { second.push(toolResult("tc-pwd", "# A"), ev.runFinished("r-2")); second.finish(); });
  });

  it("shows a call as running until its result arrives, then as done with its text; a reported failure shows its message", async () => {
    server.connect("s-1", idleHistory([]));
    let live!: FixtureStream;
    server.messageReplies = [(stream) => { live = stream; stream.push(ev.runStarted("r-1")); }];
    render(hostElement());
    const input = await screen.findByTestId("copilot-chat-textarea");
    await act(async () => {
      fireEvent.change(input, { target: { value: "Run it" } });
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await waitFor(() => expect(server.sent).toHaveLength(1));

    act(() => live.push(...toolEvents("tc-1", "read_file", { file_path: "/a.md" })));
    await waitFor(() => expect(within(card(/Read file/)).getByText("running…")).toBeTruthy());
    expect(resultOf(card(/Read file/))).toBeNull();

    act(() => live.push(toolResult("tc-1", "# A")));
    await waitFor(() => expect(within(card(/Read file/)).getByText("done")).toBeTruthy());
    expect(resultOf(card(/Read file/))).toBe("# A");

    act(() => live.push(
      ...toolEvents("tc-2", "execute", { command: "make" }),
      toolResult("tc-2", "make: *** error"),
      ev.custom("tool_status", { toolCallId: "tc-2", toolName: "execute", status: "failed" })
    ));
    await waitFor(() => expect(within(card(/Run command/)).getByText("failed")).toBeTruthy());
    expect(resultOf(card(/Run command/))).toBe("make: *** error");
    // The run is still open, so the first card stays done, not interrupted.
    expect(within(card(/Read file/)).getByText("done")).toBeTruthy();
    expect(screen.queryByText("interrupted")).toBeNull();
  });
});

describe("pending approvals beside tool cards", () => {
  it("keeps an approval that names no call in the notification list, with its own decision controls, and posts the id of that approval", async () => {
    server.connect("s-1", idleHistory([call("tc-1", "execute", { command: "pnpm test" }), result("tc-1", "ok")]));
    server.approvals.set("s-1", [savedApproval("ap-1", "pending")]);
    render(hostElement({ initialApprovals: [savedApproval("ap-1", "pending")] as never }));

    const article = await waitFor(() => card(/Run command/));
    const list = screen.getByLabelText("Session notifications");
    expect(within(list).getByText("Run ap-1")).toBeTruthy();
    // The card has one button, the one that opens its details. No decision control is in it.
    expect(within(article).getAllByRole("button")).toHaveLength(1);
    expect(within(article).queryByText(/Approve|Decline|Allow/)).toBeNull();
    expect(article.closest("[aria-label='Session notifications']")).toBeNull();

    await act(async () => { fireEvent.click(within(list).getByRole("button", { name: "Approve once" })); });
    await waitFor(() => expect(server.calls).toContain("POST /approvals/ap-1/decision"));
    expect(server.sent).toEqual([]);
  });
});

describe("pending approvals in the card of their call", () => {
  const callEvents = (id: string, name: string, args: unknown) => [
    { type: "TOOL_CALL_START", toolCallId: id, toolCallName: name },
    { type: "TOOL_CALL_ARGS", toolCallId: id, delta: JSON.stringify(args) },
    { type: "TOOL_CALL_END", toolCallId: id }
  ];
  const callResult = (id: string, content: string) => ({ type: "TOOL_CALL_RESULT", messageId: `${id}:result`, toolCallId: id, content, role: "tool" });
  const notes = { file_path: "/notes.md", content: "x" };
  const approveButtons = () => screen.queryAllByRole("button", { name: "Approve once" });
  const list = () => screen.queryByLabelText("Session notifications");

  async function liveTurn() {
    server.connect("s-1", idleHistory([]));
    let live!: FixtureStream;
    server.messageReplies = [(stream) => { live = stream; stream.push(ev.runStarted("r-1")); }];
    render(hostElement());
    const input = await screen.findByTestId("copilot-chat-textarea");
    await act(async () => {
      fireEvent.change(input, { target: { value: "Save notes" } });
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await waitFor(() => expect(server.sent).toHaveLength(1));
    return () => live;
  }

  it("shows the controls only in the card, posts the approval ID, and gives focus back to the card", async () => {
    const live = await liveTurn();
    act(() => live().push(...callEvents("card-1", "write_file", notes), ev.approvalRequired("ap-1", "card-1")));

    await waitFor(() => expect(within(card(/Write file/)).getByText("needs approval")).toBeTruthy());
    expect(within(card(/Write file/)).getByText("Run ap-1")).toBeTruthy();
    expect(approveButtons()).toHaveLength(1);
    expect(list()).toBeNull();

    const approve = within(card(/Write file/)).getByRole("button", { name: "Approve once" });
    approve.focus();
    await act(async () => { fireEvent.click(approve); });
    await waitFor(() => expect(approveButtons()).toHaveLength(0));
    expect(server.decisions).toEqual([{ approvalId: "ap-1", body: { decision: "approve" } }]);
    expect(within(card(/Write file/)).getByText("running…")).toBeTruthy();
    // The pressed control is gone. Focus is on the card's own button, not lost.
    expect(document.activeElement).toBe(within(card(/Write file/)).getAllByRole("button")[0]);

    act(() => { live().push(callResult("card-1", "Wrote /notes.md"), ev.runFinished("r-1")); live().finish(); });
    await waitFor(() => expect(within(card(/Write file/)).getByText("done")).toBeTruthy());
    expect(server.sent).toHaveLength(1);
  });

  it("moves the controls from the list into the card when the card arrives, never showing two sets", async () => {
    const live = await liveTurn();
    act(() => live().push(ev.approvalRequired("ap-1", "card-1")));
    await waitFor(() => expect(within(list()!).getByRole("button", { name: "Approve once" })).toBeTruthy());
    expect(approveButtons()).toHaveLength(1);

    act(() => live().push(...callEvents("card-1", "write_file", notes)));
    await waitFor(() => expect(within(card(/Write file/)).getByRole("button", { name: "Approve once" })).toBeTruthy());
    expect(approveButtons()).toHaveLength(1);
    expect(list()).toBeNull();
  });

  it("shows the server's declined result after a decline from the card", async () => {
    const live = await liveTurn();
    act(() => live().push(...callEvents("card-1", "write_file", notes), ev.approvalRequired("ap-1", "card-1")));
    await waitFor(() => expect(approveButtons()).toHaveLength(1));

    await act(async () => { fireEvent.click(within(card(/Write file/)).getByRole("button", { name: "Decline" })); });
    await waitFor(() => expect(approveButtons()).toHaveLength(0));
    expect(server.decisions).toEqual([{ approvalId: "ap-1", body: { decision: "reject" } }]);
    act(() => live().push(callResult("card-1", "User denied permission."),
      ev.custom("tool_status", { toolCallId: "card-1", toolName: "write_file", status: "declined" })));
    await waitFor(() => expect(within(card(/Write file/)).getByText("declined")).toBeTruthy());
    expect(resultOf(card(/Write file/))).toBe("User denied permission.");
  });

  it("keeps the controls in the card, ready again, when the decision request fails", async () => {
    const live = await liveTurn();
    act(() => live().push(...callEvents("card-1", "write_file", notes), ev.approvalRequired("ap-1", "card-1")));
    await waitFor(() => expect(approveButtons()).toHaveLength(1));
    server.decisionReplies = [{ status: 500, body: { error: "unavailable" } }];

    await act(async () => { fireEvent.click(within(card(/Write file/)).getByRole("button", { name: "Allow for this turn" })); });
    await waitFor(() => expect(server.decisions).toHaveLength(1));
    expect(server.decisions[0]!.body).toEqual({ decision: "approve", rememberForTurn: true });
    await waitFor(() => expect((within(card(/Write file/)).getByRole("button", { name: "Approve once" }) as HTMLButtonElement).disabled).toBe(false));
    expect(within(card(/Write file/)).getByText("needs approval")).toBeTruthy();
    expect(list()).toBeNull();
  });

  it("removes the controls when the approval expires and lists the expiry notice", async () => {
    const live = await liveTurn();
    act(() => live().push(...callEvents("card-1", "write_file", notes), ev.approvalRequired("ap-1", "card-1")));
    await waitFor(() => expect(approveButtons()).toHaveLength(1));

    act(() => live().push(ev.expired("ap-1")));
    await waitFor(() => expect(approveButtons()).toHaveLength(0));
    expect(within(list()!).getByText("Approval expired")).toBeTruthy();
    expect(within(card(/Write file/)).queryByText("needs approval")).toBeNull();
  });

  it("restores the controls in the card of a saved call while the turn runs elsewhere", async () => {
    // The backend checks these messages against its converter and the real pipeline.
    const { pending } = pendingApprovalHistory;
    server.running.set("s-1", true);
    server.approvals.set("s-1", pending.approvals);
    server.connect("s-1", (stream) => {
      stream.push(...ev.history({ messages: pending.unavailable, activeTurn: "unavailable" }));
      stream.finish();
    });
    render(hostElement({ isRunning: true, initialApprovals: pending.approvals as never }));

    await waitFor(() => expect(within(card(/Write file/)).getByText("needs approval")).toBeTruthy());
    expect(within(card(/Write file/)).getByText("Approve write_file")).toBeTruthy();
    expect(approveButtons()).toHaveLength(1);
    expect(list()).toBeNull();
    await act(async () => { fireEvent.click(within(card(/Write file/)).getByRole("button", { name: "Approve once" })); });
    await waitFor(() => expect(server.decisions).toEqual([{ approvalId: "ap-1", body: { decision: "approve" } }]));
  });

  it("shows a declined call as declined with its message after a reload", async () => {
    server.connect("s-1", idleHistory(pendingApprovalHistory.declined.none));
    render(hostElement());

    await waitFor(() => expect(within(card(/Write file/)).getByText("declined")).toBeTruthy());
    expect(resultOf(card(/Write file/))).toBe("User denied permission.");
    expect(approveButtons()).toHaveLength(0);
  });

  it("lists the controls of an approval whose card already has a result", async () => {
    server.connect("s-1", idleHistory([call("card-9", "execute", { command: "make" }), result("card-9", "ok")]));
    render(hostElement({ initialApprovals: [savedApproval("ap-9", "pending", "s-1", "card-9")] as never }));

    await waitFor(() => expect(within(card(/Run command/)).getByText("done")).toBeTruthy());
    expect(within(list()!).getByRole("button", { name: "Approve once" })).toBeTruthy();
    expect(within(card(/Run command/)).queryByRole("button", { name: "Approve once" })).toBeNull();
  });
});
