// @vitest-environment jsdom

import { cleanup, render, waitFor, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { lazy, useEffect, type ComponentType, type ReactNode } from "react";
import type { Approval, Session } from "@cogniplane/shared-types";

const agents = vi.hoisted(() => ({
  instances: [] as Array<{ options: Record<string, unknown>; abortRun: ReturnType<typeof vi.fn> }>
}));
const shellState = vi.hoisted(() => ({
  selectedId: "session-1",
  messages: [{ marker: "history-1" }],
  initialApprovals: [] as Approval[]
}));
const eventSeeds = vi.hoisted(() => ({ values: [] as unknown[][] }));
const hostLifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));

vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<ComponentType>) =>
    lazy(async () => ({ default: await loader() }))
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { models: [{ id: "model-1", displayName: "Model 1", description: "", isDefault: true, provider: "openai", supportedEfforts: [], defaultEffort: null, contextWindow: 1000 }], showEffortSelector: false }, error: null })
}));
vi.mock("../lib/auth-context", () => ({ useAuth: () => ({ isLoading: false, user: { role: "admin" } }) }));
vi.mock("../hooks/use-model-preference", () => ({ useModelPreference: () => ({ model: "model-1", setModel: vi.fn() }) }));
vi.mock("../hooks/use-effort-preference", () => ({ useEffortPreference: () => ({ effort: "medium", setEffort: vi.fn() }) }));
vi.mock("../hooks/use-file-sources", () => ({ useFileSources: () => ({ sources: [] }) }));
vi.mock("../hooks/use-session-list", () => ({
  useSessionList: () => {
    const sessions: Session[] = ["session-1", "session-2"].map((id) => ({
      sessionId: id,
      userId: "user-1",
      sessionName: id,
      status: "active",
      createdAt: "2026-09-04T12:00:00.000Z",
      updatedAt: "2026-09-04T12:00:00.000Z"
    }));
    return {
      sessions,
      selectedSessionId: shellState.selectedId,
      selectedSession: sessions.find((session) => session.sessionId === shellState.selectedId),
      isLoadingSessions: false,
      busySessionId: null,
      error: null,
      renameSessionId: null,
      renameDraft: "",
      pinnedSessionIds: new Set<string>(),
      pendingDeleteSessionId: null,
      setError: vi.fn(), selectSession: vi.fn(), createSession: vi.fn(), startRename: vi.fn(),
      cancelRename: vi.fn(), confirmRename: vi.fn(), setRenameDraft: vi.fn(), deleteSession: vi.fn(),
      togglePinSession: vi.fn(), confirmDelete: vi.fn(), cancelDelete: vi.fn(), renameSessionDirect: vi.fn()
    };
  }
}));
vi.mock("../hooks/use-chat-workspace", () => ({
  useChatWorkspace: () => ({
    messages: shellState.messages,
    artifacts: [],
    initialApprovals: shellState.initialApprovals,
    hasMoreMessages: false,
    isSessionDataReady: true,
    refreshSessionData: vi.fn(),
    artifactState: {
      visibleSelectedArtifactIds: [], isUploadingArtifact: false, downloadArtifactId: null,
      previewArtifactId: null, isLoadingPreview: false, toggleArtifactSelection: vi.fn(),
      handleUploadArtifact: vi.fn(), handleDownloadArtifact: vi.fn(), openPreview: vi.fn()
    }
  })
}));
vi.mock("./agui-transcript", () => ({
  toAguiInitialMessages: (messages: unknown[]) => [{ id: (messages[0] as { marker: string }).marker }],
  planStateFromMessages: (messages: unknown[]) => ({ marker: (messages[0] as { marker: string }).marker }),
  toolStatusesFromMessages: (messages: unknown[]) => [{ rowId: (messages[0] as { marker: string }).marker }]
}));
vi.mock("./session-sidebar", () => ({ SessionSidebar: () => null }));
vi.mock("./artifact-panel", () => ({ ArtifactPanel: () => null }));
vi.mock("./artifact-preview-modal", () => ({ ArtifactPreviewModal: () => null }));
vi.mock("./file-source-picker", () => ({ FileSourcePicker: () => null }));
vi.mock("./workspace-header", () => ({
  WorkspaceHeader: ({ hasPendingApprovals }: { hasPendingApprovals: boolean }) =>
    <span data-testid="approval-attention">{hasPendingApprovals ? "pending" : "clear"}</span>
}));
vi.mock("@copilotkit/react-ui", () => ({ CopilotChat: () => null }));
vi.mock("@copilotkit/react-ui/styles.css", () => ({}));
vi.mock("@copilotkit/react-core", () => ({
  CopilotKit: ({ children }: { children: ReactNode }) => {
    useEffect(() => {
      hostLifecycle.mounts += 1;
      return () => { hostLifecycle.unmounts += 1; };
    }, []);
    return children;
  }
}));
vi.mock("./copilot-render-slots", () => ({ CopilotRenderSlots: () => null }));
vi.mock("./model-effort-selector", () => ({ ModelEffortSelector: () => null }));
vi.mock("./context-window-meter", () => ({ ContextWindowMeter: () => null }));
vi.mock("../lib/agui/use-agui-custom-events", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/agui/use-agui-custom-events")>();
  return {
    useAguiCustomEvents: (...args: Parameters<typeof original.useAguiCustomEvents>) => {
      eventSeeds.values.push(args[2] ?? []);
      return original.useAguiCustomEvents(...args);
    }
  };
});
vi.mock("../lib/session-api", () => ({ resolveApproval: vi.fn(async () => undefined) }));
vi.mock("../lib/agui/deep-agents-browser-agent", () => ({
  DeepAgentsBrowserAgent: class {
    options: Record<string, unknown>;
    abortRun = vi.fn();
    subscribe() { return { unsubscribe() {} }; }
    constructor(options: Record<string, unknown>) { this.options = options; agents.instances.push(this); }
  }
}));

import { ChatShell } from "./chat-shell";

beforeAll(async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  await import("./copilot-chat-host");
});
afterEach(() => {
  cleanup();
  agents.instances = [];
  eventSeeds.values = [];
  hostLifecycle.mounts = 0;
  hostLifecycle.unmounts = 0;
  shellState.selectedId = "session-1";
  shellState.messages = [{ marker: "history-1" }];
  shellState.initialApprovals = [];
});

describe("ChatShell session host boundary", () => {
  it("preserves the host within a session and remounts it with the next session's seeds", async () => {
    const view = render(<ChatShell />);
    await waitFor(() => expect(agents.instances).toHaveLength(1));
    const first = agents.instances[0];
    expect(first.options).toMatchObject({
      sessionId: "session-1",
      initialMessages: [{ id: "history-1" }],
      initialState: { marker: "history-1" }
    });

    shellState.messages = [{ marker: "history-1-refreshed" }];
    view.rerender(<ChatShell />);
    expect(agents.instances).toHaveLength(1);
    expect(hostLifecycle).toMatchObject({ mounts: 1, unmounts: 0 });

    shellState.selectedId = "session-2";
    shellState.messages = [{ marker: "history-2" }];
    view.rerender(<ChatShell />);
    await waitFor(() => expect(agents.instances).toHaveLength(2));
    expect(hostLifecycle).toMatchObject({ mounts: 2, unmounts: 1 });
    expect(first.abortRun).toHaveBeenCalledOnce();
    expect(agents.instances[1].options).toMatchObject({
      sessionId: "session-2",
      initialMessages: [{ id: "history-2" }],
      initialState: { marker: "history-2" }
    });
    expect(eventSeeds.values.at(-1)).toEqual([{ rowId: "history-2" }]);
  });
});


describe("ChatShell persisted approvals", () => {
  it("reopens a pending approval with decision controls and clears its attention after deciding", async () => {
    shellState.initialApprovals = [{
      approvalId: "approval-1", sessionId: "session-1", itemId: "call-1",
      kind: "mcp_tool", title: "Publish report", summary: "Publish the draft report",
      status: "pending"
    }];
    const view = render(<ChatShell />);
    const approve = await screen.findByRole("button", { name: "Approve once" });
    await waitFor(() => expect(screen.getByTestId("approval-attention").textContent).toBe("pending"));

    fireEvent.click(approve);
    await waitFor(() => expect(screen.getByTestId("approval-attention").textContent).toBe("clear"));
    expect(screen.queryByRole("button", { name: "Approve once" })).toBeNull();

    // A refresh retaining the old REST snapshot must not resurrect the card.
    shellState.initialApprovals = [...shellState.initialApprovals];
    view.rerender(<ChatShell />);
    expect(screen.queryByRole("button", { name: "Approve once" })).toBeNull();
    expect(screen.getByTestId("approval-attention").textContent).toBe("clear");
  });

  it("clears the previous session's card and attention when switching sessions", async () => {
    shellState.initialApprovals = [{
      approvalId: "approval-1", sessionId: "session-1", itemId: "call-1",
      kind: "mcp_tool", title: "Publish report", summary: "Publish the draft report",
      status: "pending"
    }];
    const view = render(<ChatShell />);
    await screen.findByRole("button", { name: "Approve once" });
    shellState.selectedId = "session-2";
    shellState.initialApprovals = [];
    view.rerender(<ChatShell />);
    await waitFor(() => expect(screen.getByTestId("approval-attention").textContent).toBe("clear"));
    expect(screen.queryByRole("button", { name: "Approve once" })).toBeNull();
  });
});
