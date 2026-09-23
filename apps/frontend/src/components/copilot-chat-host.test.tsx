// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentType, ReactNode } from "react";
import type { InputProps } from "@copilotkit/react-ui";

import { MarkdownImage } from "./markdown-image";

// Capture what the host hands CopilotChat. Rendering the real one would pull in
// the whole CopilotKit runtime; the subject here is the prop, not the chat UI.
const chatProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
type FakeAgent = {
  options: Record<string, unknown>;
  isRunning: boolean;
  abortRun: ReturnType<typeof vi.fn>;
  addMessage: ReturnType<typeof vi.fn>;
  runAgent: ReturnType<typeof vi.fn>;
  connectAgent: ReturnType<typeof vi.fn>;
  setMessages: ReturnType<typeof vi.fn>;
  setState: ReturnType<typeof vi.fn>;
};
const agents = vi.hoisted(() => ({
  instances: [] as FakeAgent[],
  runAgent: null as null | (() => Promise<unknown>),
  connectAgent: null as null | (() => Promise<unknown>)
}));
const eventState = vi.hoisted(() => ({
  approvals: [] as Array<{ rowId: string }>,
  isRunning: false,
  syncServerState: null as null | ReturnType<typeof vi.fn>,
  options: {} as { onSessionBusy?: () => void; onStreamLost?: () => void; initialNotices?: unknown[] }
}));
const selectorProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
const api = vi.hoisted(() => ({
  interruptSession: vi.fn(),
  listSessions: vi.fn(),
  listApprovals: vi.fn(),
  listMessages: vi.fn()
}));

vi.mock("@copilotkit/react-ui", () => ({
  CopilotChat: (props: Record<string, unknown>) => {
    chatProps.current = props;
    // Render the composer the host chose, so its context and controls work.
    const Input = props.Input as ComponentType<InputProps> | undefined;
    return Input ? <Input inProgress={false} onSend={vi.fn()} /> : null;
  }
}));
vi.mock("@copilotkit/react-ui/styles.css", () => ({}));
vi.mock("@copilotkit/react-core", () => ({
  CopilotKit: ({ children }: { children: ReactNode }) => children
}));
vi.mock("./copilot-render-slots", () => ({ CopilotRenderSlots: () => null }));
vi.mock("./model-effort-selector", () => ({
  ModelEffortSelector: (props: Record<string, unknown>) => {
    selectorProps.current = props;
    return null;
  }
}));
vi.mock("./context-window-meter", () => ({ ContextWindowMeter: () => null }));
vi.mock("./chat-cards/approval-row", () => ({ ApprovalRowView: () => null }));
vi.mock("../lib/agui/deep-agents-browser-agent", () => ({
  isSessionBusyError: (error: unknown) => error instanceof Error && error.message === "session_busy",
  DeepAgentsBrowserAgent: class {
    options: Record<string, unknown>;
    isRunning = false;
    abortRun = vi.fn();
    addMessage = vi.fn();
    runAgent = vi.fn(() => agents.runAgent?.() ?? Promise.resolve({ newMessages: [] }));
    connectAgent = vi.fn(() => agents.connectAgent?.() ?? Promise.resolve({ newMessages: [] }));
    setMessages = vi.fn();
    setState = vi.fn();
    constructor(options: Record<string, unknown>) {
      this.options = options;
      agents.instances.push(this);
    }
    subscribe() {
      return { unsubscribe() {} };
    }
  }
}));
vi.mock("../lib/agui/use-agui-custom-events", () => ({
  useAguiCustomEvents: (_agent: unknown, options: typeof eventState.options = {}) => {
    eventState.options = options;
    eventState.syncServerState ??= vi.fn();
    return {
      approvals: eventState.approvals,
      notices: [],
      mcpStatuses: [],
      toolStatuses: [],
      isRunning: eventState.isRunning,
      turnActivity: null,
      onApprovalDecision: vi.fn(),
      syncServerState: eventState.syncServerState,
      dismissStatusRows: vi.fn()
    };
  }
}));
vi.mock("../lib/session-api", () => ({
  interruptSession: api.interruptSession,
  listSessions: api.listSessions,
  listApprovals: api.listApprovals
}));
vi.mock("../lib/message-api", () => ({ listMessages: api.listMessages }));

import { ApiError } from "../lib/api-client";
import { CopilotChatHost } from "./copilot-chat-host";

afterEach(() => {
  cleanup();
  chatProps.current = null;
  selectorProps.current = null;
  agents.instances = [];
  agents.runAgent = null;
  agents.connectAgent = null;
  eventState.approvals = [];
  eventState.isRunning = false;
  eventState.syncServerState = null;
  eventState.options = {};
  vi.resetAllMocks();
});

const savedAssistant = {
  messageId: "m-1", sessionId: "s-1", role: "assistant", content: "Saved so far", status: "streaming",
  createdAt: "2026-09-22T00:00:00.000Z", reasoningContent: "", planContent: "1. Read files"
};

function serverReports(running: boolean) {
  api.listSessions.mockResolvedValue({ sessions: [{ sessionId: "s-1", isRunning: running }], trashRetentionDays: 30 });
  api.listMessages.mockResolvedValue({ messages: [savedAssistant], hasMore: false });
  api.listApprovals.mockResolvedValue([]);
}

const hostProps = {
  session: { id: "s-1", initialMessages: [], initialState: {}, initialToolStatuses: [], initialApprovals: [] },
  modelSelection: {
    model: "deepagents/claude-sonnet-5",
    effort: "medium" as const,
    models: [],
    showEffortSelector: false,
    onModelChange: vi.fn(),
    onEffortChange: vi.fn()
  },
  usage: { contextTokens: 0, contextWindow: 0, sessionCostUsd: 0 },
  events: {}
};

describe("CopilotChatHost markdown renderers", () => {
  it("overrides CopilotKit's <img> so an agent-authored image can't bypass the CSP-safe renderer", () => {
    render(
      <CopilotChatHost {...hostProps} artifactIds={[]} />
    );

    // CopilotKit sanitizes with rehype's default schema, which permits <img>.
    // Without this prop the default renderer emits a bare tag the CSP blocks.
    const renderers = chatProps.current?.markdownTagRenderers as Record<string, unknown>;
    expect(renderers?.img).toBe(MarkdownImage);
  });

  it("keeps one agent per session while its lazy turn inputs stay live", () => {
    const view = render(<CopilotChatHost {...hostProps} artifactIds={["a-1"]} />);
    const first = agents.instances[0];
    expect(first).toBeDefined();
    expect(first.options).toMatchObject({ sessionId: "s-1", initialMessages: [], initialState: {} });

    view.rerender(
      <CopilotChatHost
        {...hostProps}
        artifactIds={["a-2"]}
        modelSelection={{ ...hostProps.modelSelection, model: "openai/gpt-5.5", effort: "high" }}
      />
    );

    expect(agents.instances).toHaveLength(1);
    expect((first.options.getModel as () => string)()).toBe("openai/gpt-5.5");
    expect((first.options.getEffort as () => string)()).toBe("high");
    expect((first.options.getArtifactIds as () => string[])()).toEqual(["a-2"]);
  });

  it("starts an explicit project action once when the session opens", async () => {
    const prompt = "Resolve the selected project draft conflict.";
    const onInitialPromptSent = vi.fn();
    render(
      <CopilotChatHost
        {...hostProps}
        artifactIds={[]}
        session={{ ...hostProps.session, initialPrompt: prompt }}
        events={{ onInitialPromptSent }}
      />
    );
    const agent = agents.instances[0];
    expect(agent.addMessage).toHaveBeenCalledWith(expect.objectContaining({ role: "user", content: prompt }));
    expect(agent.runAgent).toHaveBeenCalledOnce();
    await waitFor(() => expect(onInitialPromptSent).toHaveBeenCalledOnce());
  });

  it("forwards current running and approval signals through live callbacks", () => {
    const onRunningChange = vi.fn();
    const onPendingApprovalsChange = vi.fn();
    const view = render(
      <CopilotChatHost
        {...hostProps}
        artifactIds={[]}
        events={{ onRunningChange, onPendingApprovalsChange }}
      />
    );
    expect(onRunningChange).toHaveBeenLastCalledWith(false);
    expect(onPendingApprovalsChange).toHaveBeenLastCalledWith(0);

    eventState.isRunning = true;
    eventState.approvals = [{ rowId: "approval-1" }];
    view.rerender(
      <CopilotChatHost
        {...hostProps}
        artifactIds={[]}
        events={{ onRunningChange, onPendingApprovalsChange }}
      />
    );
    expect(onRunningChange).toHaveBeenLastCalledWith(true);
    expect(onPendingApprovalsChange).toHaveBeenLastCalledWith(1);
  });

  it("aborts the session agent when the host unmounts", () => {
    const view = render(<CopilotChatHost {...hostProps} artifactIds={[]} />);
    const agent = agents.instances[0];
    view.unmount();
    expect(agent.abortRun).toHaveBeenCalledOnce();
  });

  it("stops a turn this tab streams through the server, not only by closing the stream", async () => {
    api.interruptSession.mockResolvedValue(undefined);
    render(<CopilotChatHost {...hostProps} artifactIds={[]} />);
    const onStopGeneration = chatProps.current?.onStopGeneration as () => void;
    await act(async () => onStopGeneration());
    expect(api.interruptSession).toHaveBeenCalledWith("s-1");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the turn as still running when the server refuses to stop it", async () => {
    api.interruptSession.mockRejectedValue(new ApiError({ status: 500, method: "POST", path: "/x", message: "Server error" }));
    serverReports(true);
    render(<CopilotChatHost {...hostProps} artifactIds={[]} />);
    await act(async () => (chatProps.current?.onStopGeneration as () => void)());
    expect(screen.getByRole("alert").textContent).toBe("The agent did not stop: Server error");
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  it("ignores a Stop that arrives after the turn ended", async () => {
    api.interruptSession.mockRejectedValue(new ApiError({ status: 409, method: "POST", path: "/x", message: "No active turn" }));
    render(<CopilotChatHost {...hostProps} artifactIds={[]} />);
    await act(async () => (chatProps.current?.onStopGeneration as () => void)());
    expect(screen.queryByRole("alert")).toBeNull();
    // This tab's own stream reports the end. Do not start remote polling.
    expect(chatProps.current?.Input).toBeUndefined();
    expect(api.listSessions).not.toHaveBeenCalled();
  });
});

describe("CopilotChatHost remote-running mode", () => {
  const runningSession = { ...hostProps.session, isRunning: true };

  it("attaches to a running turn and waits to poll until the live stream ends", async () => {
    serverReports(true);
    let endConnection!: () => void;
    agents.connectAgent = () => new Promise((resolve) => { endConnection = () => resolve({ newMessages: [] }); });
    render(<CopilotChatHost {...hostProps} artifactIds={[]} session={runningSession} />);
    const agent = agents.instances[0];

    await waitFor(() => expect(agent.connectAgent).toHaveBeenCalledOnce());
    expect(api.listSessions).not.toHaveBeenCalled();

    act(() => {
      eventState.options.onStreamLost?.();
      endConnection();
    });
    await waitFor(() => expect(api.listSessions).toHaveBeenCalledOnce());
  });

  it("attaches when another tab starts a turn while this chat stays open", async () => {
    serverReports(true);
    let endConnection!: () => void;
    agents.connectAgent = () => new Promise((resolve) => { endConnection = () => resolve({ newMessages: [] }); });
    const view = render(<CopilotChatHost {...hostProps} artifactIds={[]} />);
    const agent = agents.instances[0];
    expect(agent.connectAgent).not.toHaveBeenCalled();

    view.rerender(<CopilotChatHost {...hostProps} artifactIds={[]} session={runningSession} />);
    await waitFor(() => expect(agent.connectAgent).toHaveBeenCalledOnce());
    expect(api.listSessions).not.toHaveBeenCalled();

    view.rerender(<CopilotChatHost {...hostProps} artifactIds={[]} session={runningSession} />);
    expect(agent.connectAgent).toHaveBeenCalledOnce();
    act(() => {
      eventState.options.onStreamLost?.();
      endConnection();
    });
    await waitFor(() => expect(api.listSessions).toHaveBeenCalledOnce());
  });

  it("shows a running note with Stop, locks the model, and polls the saved turn into the transcript", async () => {
    serverReports(true);
    api.interruptSession.mockResolvedValue(undefined);
    const onRemoteRunningChange = vi.fn();
    render(
      <CopilotChatHost {...hostProps} artifactIds={[]} session={runningSession} events={{ onRemoteRunningChange }} />
    );

    expect(screen.getByRole("status").textContent).toBe(
      "The agent is still working on this chat. You can send a message when it finishes."
    );
    expect(selectorProps.current?.disabled).toBe(true);
    expect(onRemoteRunningChange).toHaveBeenLastCalledWith(true);

    const agent = agents.instances[0];
    await waitFor(() => expect(agent.setMessages).toHaveBeenCalled());
    expect(agent.setMessages).toHaveBeenLastCalledWith([{ id: "m-1", role: "assistant", content: "Saved so far" }]);
    expect(agent.setState).toHaveBeenLastCalledWith({ plan: "1. Read files" });
    expect(eventState.syncServerState).toHaveBeenLastCalledWith({ approvals: [], toolStatuses: [], notices: [] });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    });
    expect(api.interruptSession).toHaveBeenCalledWith("s-1");
  });

  it("returns to the normal composer and runs the settled refresh when the turn ends", async () => {
    serverReports(false);
    const onTurnSettled = vi.fn();
    const onRemoteRunningChange = vi.fn();
    render(
      <CopilotChatHost {...hostProps} artifactIds={[]} session={runningSession} events={{ onTurnSettled, onRemoteRunningChange }} />
    );

    await waitFor(() => expect(onRemoteRunningChange).toHaveBeenLastCalledWith(false));
    expect(onTurnSettled).toHaveBeenCalledOnce();
    expect(agents.instances[0].setMessages).toHaveBeenCalledOnce();
    expect(chatProps.current?.Input).toBeUndefined();
    expect(selectorProps.current?.disabled).toBe(false);
  });

  it("reads the server state at once when Stop finds no active turn, and unlocks a stale running state", async () => {
    serverReports(true);
    api.interruptSession.mockRejectedValue(new ApiError({ status: 409, method: "POST", path: "/x", message: "No active turn" }));
    const onTurnSettled = vi.fn();
    render(<CopilotChatHost {...hostProps} artifactIds={[]} session={runningSession} events={{ onTurnSettled }} />);
    await waitFor(() => expect(api.listSessions).toHaveBeenCalledOnce());

    // The saved list still reports the turn. The server has no running turn.
    serverReports(false);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    });

    // The next interval poll is 3 seconds away. The composer must not wait for it.
    await waitFor(() => expect(chatProps.current?.Input).toBeUndefined());
    expect(api.listSessions).toHaveBeenCalledTimes(2);
    expect(onTurnSettled).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the mode when Stop finds no active turn but the server reports a running turn", async () => {
    serverReports(true);
    api.interruptSession.mockRejectedValue(new ApiError({ status: 409, method: "POST", path: "/x", message: "No active turn" }));
    const onTurnSettled = vi.fn();
    render(<CopilotChatHost {...hostProps} artifactIds={[]} session={runningSession} events={{ onTurnSettled }} />);
    await waitFor(() => expect(api.listSessions).toHaveBeenCalledOnce());

    // Another tab started a turn after the first one ended.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    });

    await waitFor(() => expect(api.listSessions).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("status").textContent).toBe(
      "The agent is still working on this chat. You can send a message when it finishes."
    );
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(onTurnSettled).not.toHaveBeenCalled();
  });

  it("does not offer Stop to a viewer who cannot edit", () => {
    serverReports(true);
    render(<CopilotChatHost {...hostProps} artifactIds={[]} session={{ ...runningSession, canEdit: false }} />);
    expect(screen.getByRole("status").textContent).toBe(
      "The agent is working on this chat. Only project owners and editors can send messages."
    );
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("enters the mode when the backend refuses a send as busy", async () => {
    serverReports(true);
    render(<CopilotChatHost {...hostProps} artifactIds={[]} />);
    expect(chatProps.current?.Input).toBeUndefined();

    act(() => eventState.options.onSessionBusy?.());

    expect(screen.getByRole("status").textContent).toBe(
      "Your message was not sent because the agent is still working on this chat. Send it again when the agent finishes."
    );
    await waitFor(() => expect(api.listSessions).toHaveBeenCalled());
  });

  it("holds a project action until the running turn ends, then starts it", async () => {
    serverReports(false);
    const onInitialPromptSent = vi.fn();
    render(
      <CopilotChatHost
        {...hostProps}
        artifactIds={[]}
        session={{ ...runningSession, initialPrompt: "Resolve the draft." }}
        events={{ onInitialPromptSent }}
      />
    );
    const agent = agents.instances[0];
    expect(agent.runAgent).not.toHaveBeenCalled();

    await waitFor(() => expect(agent.runAgent).toHaveBeenCalledOnce());
    expect(agent.addMessage).toHaveBeenCalledWith(expect.objectContaining({ content: "Resolve the draft." }));
    await waitFor(() => expect(onInitialPromptSent).toHaveBeenCalledOnce());
  });

  it("keeps a project action refused as busy and starts it again after the other turn", async () => {
    serverReports(false);
    let refuse = true;
    agents.runAgent = () => {
      if (!refuse) return Promise.resolve({ newMessages: [] });
      refuse = false;
      // The real hook enters remote mode from onRunFailed before runAgent rejects.
      act(() => eventState.options.onSessionBusy?.());
      return Promise.reject(new Error("session_busy"));
    };
    const onInitialPromptSent = vi.fn();
    render(
      <CopilotChatHost
        {...hostProps}
        artifactIds={[]}
        session={{ ...hostProps.session, initialPrompt: "Resolve the draft." }}
        events={{ onInitialPromptSent }}
      />
    );
    const agent = agents.instances[0];

    await waitFor(() => expect(agent.runAgent).toHaveBeenCalledTimes(2));
    expect(agent.addMessage).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(onInitialPromptSent).toHaveBeenCalledOnce());
  });
});

describe("CopilotChatHost after this tab's stream drops", () => {
  it("polls at once, keeps the mode while the server runs the turn, and refreshes once at the end", async () => {
    serverReports(true);
    const onTurnSettled = vi.fn();
    const onRemoteRunningChange = vi.fn();
    const events = { onTurnSettled, onRemoteRunningChange };
    const view = render(<CopilotChatHost {...hostProps} artifactIds={[]} events={events} />);
    expect(api.listSessions).not.toHaveBeenCalled();

    act(() => eventState.options.onStreamLost?.());

    expect(screen.getByRole("status").textContent).toBe(
      "The agent is still working on this chat. You can send a message when it finishes."
    );
    await waitFor(() => expect(agents.instances[0].setMessages).toHaveBeenCalledOnce());
    expect(api.listSessions).toHaveBeenCalledOnce();
    expect(onTurnSettled).not.toHaveBeenCalled();

    // The session list shows the turn, then its end. The host polls at once
    // to confirm the end.
    view.rerender(<CopilotChatHost {...hostProps} artifactIds={[]} session={{ ...hostProps.session, isRunning: true }} events={events} />);
    serverReports(false);
    view.rerender(<CopilotChatHost {...hostProps} artifactIds={[]} session={{ ...hostProps.session, isRunning: false }} events={events} />);
    await waitFor(() => expect(onRemoteRunningChange).toHaveBeenLastCalledWith(false));
    expect(onTurnSettled).toHaveBeenCalledOnce();
    expect(chatProps.current?.Input).toBeUndefined();
  });

  it("leaves the mode after one poll when the turn already ended", async () => {
    serverReports(false);
    const onTurnSettled = vi.fn();
    render(<CopilotChatHost {...hostProps} artifactIds={[]} events={{ onTurnSettled }} />);

    act(() => eventState.options.onStreamLost?.());

    await waitFor(() => expect(onTurnSettled).toHaveBeenCalledOnce());
    expect(api.listSessions).toHaveBeenCalledOnce();
    expect(chatProps.current?.Input).toBeUndefined();
  });
});

describe("CopilotChatHost saved runtime notices", () => {
  const notice = {
    noticeId: "n-1", level: "warning", title: "Tool slow", message: "Details", createdAt: "2026-09-22T00:00:00.000Z"
  };

  it("passes the opening seed to the event hook", () => {
    const seed = [{ type: "runtime-notice", rowId: "notice:n-1", ...notice }];
    render(<CopilotChatHost {...hostProps} artifactIds={[]} session={{ ...hostProps.session, initialNotices: seed as never }} />);
    expect(eventState.options.initialNotices).toBe(seed);
  });

  it("sends valid notices from polled messages with each snapshot", async () => {
    serverReports(true);
    api.listMessages.mockResolvedValue({
      messages: [{ ...savedAssistant, detail: { runtimeNotices: [notice, { ...notice, noticeId: "" }] } }],
      hasMore: false
    });
    render(<CopilotChatHost {...hostProps} artifactIds={[]} session={{ ...hostProps.session, isRunning: true }} />);

    await waitFor(() => expect(eventState.syncServerState).toHaveBeenCalled());
    expect(eventState.syncServerState).toHaveBeenLastCalledWith(expect.objectContaining({
      notices: [{ type: "runtime-notice", rowId: "notice:n-1", ...notice }]
    }));
  });
});
