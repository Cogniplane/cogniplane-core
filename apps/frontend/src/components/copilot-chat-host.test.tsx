// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { MarkdownImage } from "./markdown-image";

// Capture what the host hands CopilotChat. Rendering the real one would pull in
// the whole CopilotKit runtime; the subject here is the prop, not the chat UI.
const chatProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
const agents = vi.hoisted(() => ({
  instances: [] as Array<{ options: Record<string, unknown>; abortRun: ReturnType<typeof vi.fn>; addMessage: ReturnType<typeof vi.fn>; runAgent: ReturnType<typeof vi.fn> }>
}));
const eventState = vi.hoisted(() => ({
  approvals: [] as Array<{ rowId: string }>,
  isRunning: false
}));

vi.mock("@copilotkit/react-ui", () => ({
  CopilotChat: (props: Record<string, unknown>) => {
    chatProps.current = props;
    return null;
  }
}));
vi.mock("@copilotkit/react-ui/styles.css", () => ({}));
vi.mock("@copilotkit/react-core", () => ({
  CopilotKit: ({ children }: { children: ReactNode }) => children
}));
vi.mock("./copilot-render-slots", () => ({ CopilotRenderSlots: () => null }));
vi.mock("./model-effort-selector", () => ({ ModelEffortSelector: () => null }));
vi.mock("./context-window-meter", () => ({ ContextWindowMeter: () => null }));
vi.mock("./chat-cards/approval-row", () => ({ ApprovalRowView: () => null }));
vi.mock("../lib/agui/deep-agents-browser-agent", () => ({
  DeepAgentsBrowserAgent: class {
    options: Record<string, unknown>;
    abortRun = vi.fn();
    addMessage = vi.fn();
    runAgent = vi.fn();
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
  useAguiCustomEvents: () => ({
    approvals: eventState.approvals,
    notices: [],
    mcpStatuses: [],
    toolStatuses: [],
    isRunning: eventState.isRunning,
    onApprovalDecision: vi.fn()
  })
}));

import { CopilotChatHost } from "./copilot-chat-host";

afterEach(() => {
  cleanup();
  chatProps.current = null;
  agents.instances = [];
  eventState.approvals = [];
  eventState.isRunning = false;
});

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

  it("starts an explicit project action once when the session opens", () => {
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
    expect(onInitialPromptSent).toHaveBeenCalledOnce();
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
});
