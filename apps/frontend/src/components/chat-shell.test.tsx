// @vitest-environment jsdom

import { act, cleanup, render, waitFor, screen, fireEvent, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { lazy, useEffect, type ComponentType, type ReactNode } from "react";
import type { Approval, Artifact, ProjectFilePickerEntry, Session } from "@cogniplane/shared-types";

// @ag-ui/client always passes the error and the run input to onRunFailed. A
// status on the error means the backend refused the request.
const runStart = { input: { runId: "run-1", forwardedProps: {}, messages: [] } };
const runFailure = {
  error: Object.assign(new Error("HTTP 500"), { status: 500 }) as Error,
  messages: [],
  input: runStart.input
};
type FakeSubscriber = {
  onToolCallResultEvent?: (params: { event: { toolCallId: string }; messages: unknown[] }) => void;
  onRunInitialized?: (params: { input: object }) => void;
  onRunFailed?: (params: typeof runFailure) => void;
  onRunFinishedEvent?: (params: { event: object; input: object }) => void;
  onRunFinalized?: (params: { input: object }) => void;
  onCustomEvent?: (params: { event: { name: string; value: unknown }; messages: unknown[]; input: object }) => void;
};
const agents = vi.hoisted(() => ({
  instances: [] as Array<{
    options: Record<string, unknown>;
    abortRun: ReturnType<typeof vi.fn>;
    addMessage: ReturnType<typeof vi.fn>;
    runAgent: ReturnType<typeof vi.fn>;
    subscriber?: FakeSubscriber
  }>
}));
// CopilotChat's connection, as the event hook sees it: the history run and
// its status. The real connection runs in copilot-chat-host.test.tsx.
function restoreHistory(agent: (typeof agents.instances)[number], activeTurn: "none" | "attached" | "unavailable" = "none") {
  const input = { runId: "connect-1", forwardedProps: { cogniplaneReconnect: true }, messages: [] };
  act(() => {
    agent.subscriber?.onRunInitialized?.({ input });
    agent.subscriber?.onCustomEvent?.({ event: { name: "session_connection", value: { activeTurn, hasMoreHistory: false } }, messages: [], input });
    agent.subscriber?.onRunFinishedEvent?.({ event: { type: "RUN_FINISHED" }, input });
    agent.subscriber?.onRunFinalized?.({ input });
  });
}
const shellState = vi.hoisted(() => ({
  selectedId: "session-1",
  busyId: null as string | null,
  hasModels: true,
  error: null as string | null,
  modelError: null as Error | null,
  role: "admin",
  projectId: null as string | null,
  // Live project files the picker and selection endpoints return. Null while they load.
  projectFiles: null as ProjectFilePickerEntry[] | null,
  // State of the exact selection lookup. "placeholder" returns the files of
  // the last confirmed ID list, as keepPreviousData does. "error" has no data.
  // "refetch-error" is a failed refetch of the same key: it keeps the last data.
  selectionLookup: "confirmed" as "confirmed" | "pending" | "placeholder" | "error" | "refetch-error",
  lastConfirmedSelection: [] as string[],
  messages: [{ marker: "history-1" }] as Array<{ marker: string } & Partial<import("@cogniplane/shared-types").Message>>,
  initialApprovals: [] as Approval[],
  serverActivity: {} as Partial<Session>,
  artifacts: [] as Artifact[],
  // The session query: loaded, first load running, first load failed with
  // nothing cached, or a failed refetch that kept the cached data.
  sessionData: "ready" as "ready" | "loading" | "error" | "cached-error",
  isLoadingSessions: false,
  // The artifacts panel stand-in renders a nested Radix dialog.
  nestedDialog: false,
  pendingDeleteId: null as string | null
}));
const artifactPanelProps = vi.hoisted(() => ({ values: [] as Array<{ inventory: { status?: string; onRetry?: () => void; retrying?: boolean } }> }));
const workspaceActions = vi.hoisted(() => ({ openPreview: vi.fn() }));
// What the chat host gives the ArtifactCards. The cards render in the real host test.
const cardProviders = vi.hoisted(() => ({ props: [] as Array<{ sessionId: string; inventory?: { artifacts: readonly unknown[]; onOpenPreview: (artifactId: string) => void } }> }));
const eventSeeds = vi.hoisted(() => ({ values: [] as unknown[][] }));
const sessionListActions = vi.hoisted(() => ({ reload: vi.fn(async () => undefined), select: vi.fn(), create: vi.fn(async () => undefined), confirmDelete: vi.fn(), cancelDelete: vi.fn() }));
const queryActions = vi.hoisted(() => ({ invalidate: vi.fn(), projectRefetch: vi.fn(), refresh: vi.fn(async () => {}) }));
const hostLifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));
const copilotkitCore = vi.hoisted(() => ({ runAgent: vi.fn(({ agent }: { agent: { runAgent: () => Promise<unknown> } }) => agent.runAgent()), connectAgent: vi.fn(async () => undefined), getContextForAgent: vi.fn(() => []) }));
const navigationState = vi.hoisted(() => ({ resolveDraftId: null as string | null, sessionId: null as string | null }));
const projectApi = vi.hoisted(() => ({
  listProjects: vi.fn(async () => []),
  setProjectSession: vi.fn()
}));

vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<ComponentType>) =>
    lazy(async () => ({ default: await loader() }))
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => ({
    get: (key: string) => key === "resolveDraft" ? navigationState.resolveDraftId : key === "session" ? navigationState.sessionId : null
  })
}));
vi.mock("@tanstack/react-query", () => ({
  keepPreviousData: <T,>(previous: T) => previous,
  useQueryClient: () => ({ invalidateQueries: queryActions.invalidate }),
  useInfiniteQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    const q = String((queryKey[4] as { q?: string } | undefined)?.q ?? "").toLowerCase();
    const items = shellState.projectFiles?.filter((file) => file.name.toLowerCase().includes(q));
    return {
      data: items ? { pages: [{ items, nextCursor: null }] } : undefined,
      isPending: !items,
      isSuccess: Boolean(items),
      isError: false,
      hasNextPage: false
    };
  },
  useQuery: ({ queryKey, queryFn }: { queryKey?: unknown[]; queryFn?: () => unknown }) => {
    if (queryKey?.[1] === "library-disabled") {
      return { data: undefined, isSuccess: false, isError: false, isPlaceholderData: false };
    }
    if (queryKey?.[2] === "library" && queryKey[3] === "selection") {
      const lookup = shellState.selectionLookup;
      const ids = lookup === "placeholder" ? shellState.lastConfirmedSelection : queryKey[4] as string[];
      const loaded = shellState.projectFiles !== null && (lookup === "confirmed" || lookup === "placeholder");
      if (loaded && lookup === "confirmed") shellState.lastConfirmedSelection = ids;
      const kept = lookup === "refetch-error" && shellState.projectFiles !== null;
      return {
        data: loaded || kept
          ? { items: shellState.projectFiles!.filter((file) => ids.includes(file.fileId)) }
          : undefined,
        isSuccess: loaded,
        isError: lookup === "error" || lookup === "refetch-error",
        isPlaceholderData: lookup === "placeholder",
        refetch: queryActions.projectRefetch
      };
    }
    if (queryKey?.[0] === "projects" && queryKey?.[1] === "list") {
      void queryFn?.();
      return { data: [], error: null, refetch: vi.fn() };
    }
    return { data: { models: shellState.hasModels ? [{ id: "model-1", displayName: "Model 1", description: "", isDefault: true, provider: "openai", supportedEfforts: [], defaultEffort: null, contextWindow: 1000 }] : [], showEffortSelector: false }, error: shellState.modelError };
  }
}));
vi.mock("../lib/auth-context", () => ({ useAuth: () => ({ isLoading: false, user: { role: shellState.role } }) }));
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
      updatedAt: "2026-09-04T12:00:00.000Z",
      transcriptFormat: "current",
      ...(id === "session-1" ? shellState.serverActivity : {}),
      ...(id === "session-1" && shellState.projectId ? { projectId: shellState.projectId } : {})
    }));
    return {
      sessions,
      selectedSessionId: shellState.selectedId,
      selectedSession: sessions.find((session) => session.sessionId === shellState.selectedId),
      isLoadingSessions: shellState.isLoadingSessions,
      isCreatingSession: false,
      busySessionId: shellState.busyId,
      error: shellState.error,
      renameSessionId: null,
      renameDraft: "",
      pinnedSessionIds: new Set<string>(),
      pendingDeleteSessionId: shellState.pendingDeleteId,
      reload: sessionListActions.reload, setError: vi.fn(), selectSession: sessionListActions.select, createSession: sessionListActions.create, startRename: vi.fn(),
      cancelRename: vi.fn(), confirmRename: vi.fn(), setRenameDraft: vi.fn(), deleteSession: vi.fn(),
      archiveSession: vi.fn(), togglePinSession: vi.fn(), confirmDelete: sessionListActions.confirmDelete, cancelDelete: sessionListActions.cancelDelete, renameSessionDirect: vi.fn()
    };
  }
}));
vi.mock("../hooks/use-chat-workspace", () => ({
  useChatWorkspace: () => ({
    messages: shellState.messages,
    artifacts: shellState.artifacts,
    initialApprovals: shellState.initialApprovals,
    isSessionDataReady: shellState.sessionData === "ready" || shellState.sessionData === "cached-error",
    hasSessionData: shellState.sessionData === "ready" || shellState.sessionData === "cached-error",
    loadError: shellState.sessionData === "error" || shellState.sessionData === "cached-error" ? "HTTP 503" : null,
    refreshSessionData: queryActions.refresh,
    artifactState: {
      visibleSelectedArtifactIds: [], isUploadingArtifact: false, downloadArtifactId: null,
      previewArtifactId: null, isLoadingPreview: false, toggleArtifactSelection: vi.fn(),
      handleUploadArtifact: vi.fn(), handleDownloadArtifact: vi.fn(), openPreview: workspaceActions.openPreview
    }
  })
}));
vi.mock("./agui-transcript", async (importOriginal) => ({
  toolStatusesFromMessages: (messages: unknown[]) => [{ rowId: (messages[0] as { marker: string }).marker }],
  mcpAppsFromMessages: (await importOriginal<typeof import("./agui-transcript")>()).mcpAppsFromMessages,
  runtimeNoticesFromMessages: (await importOriginal<typeof import("./agui-transcript")>()).runtimeNoticesFromMessages,
  turnStoppedNotice: (await importOriginal<typeof import("./agui-transcript")>()).turnStoppedNotice,
  turnStopReasonOfResult: (await importOriginal<typeof import("./agui-transcript")>()).turnStopReasonOfResult
}));
vi.mock("./artifact-card", async (importOriginal) => ({
  ...await importOriginal<typeof import("./artifact-card")>(),
  ArtifactCardProvider: (props: (typeof cardProviders.props)[number] & { children: ReactNode }) => {
    cardProviders.props.push(props);
    return props.children;
  }
}));
vi.mock("./session-sidebar", () => ({ SessionSidebar: () => null }));
vi.mock("./artifact-panel", async () => {
  const { useState } = await import("react");
  const { Dialog, DialogContent, DialogTitle } = await import("./ui/dialog");
  function NestedDialog() {
    const [open, setOpen] = useState(true);
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent aria-describedby={undefined}><DialogTitle>Nested preview</DialogTitle></DialogContent>
      </Dialog>
    );
  }
  return {
    ArtifactPanel: (props: (typeof artifactPanelProps.values)[number]) => {
      artifactPanelProps.values.push(props);
      return shellState.nestedDialog ? <NestedDialog /> : null;
    }
  };
});
vi.mock("./artifact-preview-modal", () => ({ ArtifactPreviewModal: () => null }));
vi.mock("./file-source-picker", () => ({ FileSourcePicker: () => null }));
vi.mock("./workspace-header", () => ({
  WorkspaceHeader: ({ hasPendingApprovals, sessionStatus, sessionActions, completedTurn, isSidebarOpen, isArtifactPaneOpen, onCopySession, artifactToggleRef, onToggleArtifactPane }: {
    artifactToggleRef?: import("react").Ref<HTMLButtonElement>;
    onToggleArtifactPane?: () => void;
    hasPendingApprovals: boolean;
    onCopySession?: () => string | undefined;
    isSidebarOpen: boolean;
    isArtifactPaneOpen: boolean;
    completedTurn?: { durationMs: number };
    sessionStatus: string;
    sessionActions?: Omit<SessionActionMenuProps, "onRename">;
  }) => <>
    <button ref={artifactToggleRef} onClick={onToggleArtifactPane} aria-label={isArtifactPaneOpen ? "Hide artifacts panel" : "Show artifacts panel"} />
    <span data-testid="panes">{`sidebar:${isSidebarOpen} artifacts:${isArtifactPaneOpen}`}</span>
    <span data-testid="completed-duration">{completedTurn?.durationMs}</span>
    <span data-testid="approval-attention" data-session-status={sessionStatus}>{hasPendingApprovals ? "pending" : "clear"}</span>
    {sessionActions ? <SessionActionMenu {...sessionActions} onRename={() => {}} /> : null}
    {onCopySession ? <span data-testid="copy-session" /> : null}
  </>
}));
vi.mock("@copilotkit/react-core/v2", () => {
  const Stub = () => null;
  return {
    CopilotKitProvider: ({ children }: { children: ReactNode }) => {
      useEffect(() => {
        hostLifecycle.mounts += 1;
        return () => { hostLifecycle.unmounts += 1; };
      }, []);
      return children;
    },
    CopilotChat: Stub,
    CopilotChatAssistantMessage: Stub,
    CopilotChatMessageView: Stub,
    CopilotChatInput: Object.assign(Stub, { SendButton: Stub }),
    useCopilotKit: () => ({ copilotkit: copilotkitCore })
  };
});
vi.mock("./copilot-render-slots", async () => ({
  CopilotRenderSlots: () => null,
  AgentPlan: () => null,
  ToolOutcomeContext: (await import("react")).createContext(new Map())
}));
vi.mock("./model-effort-selector", () => ({ ModelEffortSelector: () => null }));
vi.mock("./context-window-meter", () => ({ ContextWindowMeter: () => null }));
// The provider above is a stand-in without a generative UI runtime. The host
// test covers the side panel with the real provider.
vi.mock("./generative-ui-side-panel", () => ({
  GenerativeUiSidePanel: () => null,
  SidePanelToggle: () => null,
  SidePanelNotice: () => null,
  transcriptRows: (messages: unknown[]) => messages,
  useSidePanel: () => ({
    state: { hasView: false, streaming: false, incomplete: false, failed: false, views: [], selected: undefined, browsing: false },
    open: false, waiting: false, announcement: "", narrow: false, focusRequest: 0,
    toggle: () => undefined, show: () => undefined, close: () => undefined,
    select: () => undefined, showLatest: () => undefined
  })
}));
vi.mock("../lib/agui/use-agui-custom-events", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/agui/use-agui-custom-events")>();
  return {
    useAguiCustomEvents: (...args: Parameters<typeof original.useAguiCustomEvents>) => {
      eventSeeds.values.push(args[1]?.initialToolStatuses ?? []);
      return original.useAguiCustomEvents(...args);
    }
  };
});
vi.mock("../lib/session-api", () => ({
  resolveApproval: vi.fn(async () => undefined),
  interruptSession: vi.fn(async () => undefined),
  listApprovals: vi.fn(async () => []),
  // The host polls this while a turn runs without its stream.
  listSessions: vi.fn(async () => ({
    sessions: [{ sessionId: shellState.selectedId, isRunning: shellState.serverActivity.isRunning === true }],
    trashRetentionDays: 30
  }))
}));
vi.mock("../lib/message-api", () => ({ listMessages: vi.fn(async () => ({ messages: shellState.messages, hasMore: false })) }));
vi.mock("../lib/project-api", () => projectApi);
// Only the agent class is fake. The error and run readers stay real.
vi.mock("../lib/agui/deep-agents-browser-agent", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/agui/deep-agents-browser-agent")>(),
  DeepAgentsBrowserAgent: class {
    options: Record<string, unknown>;
    isRunning = false;
    abortRun = vi.fn();
    addMessage = vi.fn();
    runAgent = vi.fn(async () => undefined);
    connectAgent = vi.fn(async () => undefined);
    setMessages = vi.fn();
    setState = vi.fn();
    isClosedByClient = () => false;
    subscribers: FakeSubscriber[] = [];
    // Calls every subscriber in order, as @ag-ui/client does.
    get subscriber(): FakeSubscriber {
      const call = (key: keyof FakeSubscriber) => (params: unknown) => {
        for (const subscriber of this.subscribers) (subscriber[key] as ((value: unknown) => void) | undefined)?.(params);
      };
      return {
        onRunInitialized: call("onRunInitialized"), onRunFailed: call("onRunFailed"),
        onToolCallResultEvent: call("onToolCallResultEvent"), onRunFinishedEvent: call("onRunFinishedEvent"), onRunFinalized: call("onRunFinalized"), onCustomEvent: call("onCustomEvent")
      };
    }
    subscribe(subscriber: FakeSubscriber) {
      this.subscribers.push(subscriber);
      return { unsubscribe: () => { this.subscribers = this.subscribers.filter((current) => current !== subscriber); } };
    }
    constructor(options: Record<string, unknown>) { this.options = options; agents.instances.push(this); }
  }
}));

import { SessionActionMenu, type SessionActionMenuProps } from "./session-action-menu";
import { otherOverlayOpen } from "../lib/keyboard-shortcuts";

import { ChatShell } from "./chat-shell";

function pickerEntry(fileId: string, name: string, kind: "published" | "draft" = "published"): ProjectFilePickerEntry {
  return { fileId, name, kind, folderId: null, folderPath: "Files", versionId: `${fileId}-v1`, versionNumber: 1 };
}

beforeAll(async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  await import("./copilot-chat-host");
});
beforeEach(() => {
  // Notification overflow is measured in the real host. jsdom has no layout;
  // frame geometry tests below install their own observer and measurements.
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});
afterEach(() => {
  cleanup();
  agents.instances = [];
  eventSeeds.values = [];
  hostLifecycle.mounts = 0;
  hostLifecycle.unmounts = 0;
  shellState.selectedId = "session-1";
  shellState.hasModels = true;
  shellState.projectId = null;
  shellState.projectFiles = null;
  shellState.selectionLookup = "confirmed";
  shellState.lastConfirmedSelection = [];
  shellState.error = null;
  shellState.modelError = null;
  shellState.role = "admin";
  shellState.messages = [{ marker: "history-1" }];
  shellState.initialApprovals = [];
  shellState.serverActivity = {};
  shellState.artifacts = [];
  shellState.sessionData = "ready";
  shellState.isLoadingSessions = false;
  shellState.nestedDialog = false;
  shellState.pendingDeleteId = null;
  artifactPanelProps.values = [];
  window.localStorage.clear();
  workspaceActions.openPreview.mockReset();
  cardProviders.props = [];
  shellState.busyId = null;
  navigationState.resolveDraftId = null;
  navigationState.sessionId = null;
  sessionListActions.select.mockClear();
  sessionListActions.create.mockClear();
  sessionListActions.confirmDelete.mockClear();
  sessionListActions.cancelDelete.mockClear();
  projectApi.listProjects.mockClear();
  queryActions.invalidate.mockClear();
  queryActions.projectRefetch.mockClear();
  queryActions.refresh.mockReset();
  queryActions.refresh.mockResolvedValue(undefined);
  sessionListActions.reload.mockReset();
  sessionListActions.reload.mockResolvedValue(undefined);
  vi.restoreAllMocks();
});

describe("ChatShell session host boundary", () => {
  it("clears the model query error after recovery without clearing mutation errors", async () => {
    shellState.modelError = new Error("offline");
    const view = render(<ChatShell />);
    // The first render waits for the lazy chat host, which can take longer when
    // this file shares workers with the full repository suite.
    expect((await screen.findByRole("alert", {}, { timeout: 10_000 })).textContent).toContain("Could not load the model list: offline");
    shellState.modelError = null;
    view.rerender(<ChatShell />);
    expect(screen.queryByRole("alert")).toBeNull();
    shellState.error = "Could not rename session";
    view.rerender(<ChatShell />);
    expect(screen.getByRole("alert").textContent).toBe("Could not rename session");
    await waitFor(() => expect(agents.instances).toHaveLength(1));
  });
  it("settles a personal turn without refetching the disabled project query or leaking refresh rejection", async () => {
    queryActions.refresh.mockRejectedValueOnce(new Error("messages unavailable"));
    render(<ChatShell />);
    await waitFor(() => expect(agents.instances).toHaveLength(1));
    act(() => agents.instances[0].subscriber?.onRunInitialized?.(runStart));
    await act(async () => agents.instances[0].subscriber?.onRunFailed?.(runFailure));
    expect(queryActions.refresh).toHaveBeenCalledWith("session-1");
    expect(queryActions.projectRefetch).not.toHaveBeenCalled();
    expect(queryActions.invalidate).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: expect.arrayContaining(["library"]) }));
  });
  it("loads active projects only for the main screen", async () => {
    render(<ChatShell />);
    await waitFor(() => expect(projectApi.listProjects).toHaveBeenCalled());
    expect(projectApi.listProjects).toHaveBeenCalledWith();
    expect(projectApi.listProjects).not.toHaveBeenCalledWith({ archived: true });
  });

  it("preserves the host within a session and remounts it with the next session's seeds", async () => {
    const view = render(<ChatShell />);
    await waitFor(() => expect(agents.instances).toHaveLength(1));
    const first = agents.instances[0];
    // CopilotChat loads the transcript through its connection. The agent gets no history.
    expect(Object.keys(first.options).sort()).toEqual(["getArtifactIds", "getEffort", "getModel", "getProjectFileIds", "sessionId"]);
    expect(first.options.sessionId).toBe("session-1");
    expect(eventSeeds.values.at(-1)).toEqual([{ rowId: "history-1" }]);

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
    expect(agents.instances[1].options.sessionId).toBe("session-2");
    expect(eventSeeds.values.at(-1)).toEqual([{ rowId: "history-2" }]);
  });

  it("gives the chat's ArtifactCards the session's artifacts and the shared preview, and keeps the agent when the list refreshes", async () => {
    const artifact = (status: Artifact["status"]) => ({ artifactId: "a-1", sessionId: "session-1", status } as Artifact);
    shellState.artifacts = [artifact("pending")];
    const view = render(<ChatShell />);
    await waitFor(() => expect(agents.instances).toHaveLength(1));
    act(() => agents.instances[0].subscriber?.onToolCallResultEvent?.({
      event: { toolCallId: "write-1" },
      messages: [{ role: "assistant", toolCalls: [{ id: "write-1", function: { name: "write_artifact" } }] }]
    }));
    await waitFor(() => expect(queryActions.refresh).toHaveBeenCalledWith("session-1"));
    const first = cardProviders.props.at(-1)!;
    expect(first.sessionId).toBe("session-1");
    expect(first.inventory?.artifacts).toBe(shellState.artifacts);
    // The agent reads no inventory.
    expect(Object.keys(agents.instances[0].options)).not.toContain("artifacts");

    shellState.artifacts = [artifact("ready")];
    view.rerender(<ChatShell />);

    const refreshed = cardProviders.props.at(-1)!;
    expect(refreshed.inventory?.artifacts).toBe(shellState.artifacts);
    expect(agents.instances).toHaveLength(1);
    expect(hostLifecycle).toMatchObject({ mounts: 1, unmounts: 0 });
    expect(workspaceActions.openPreview).not.toHaveBeenCalled();
    refreshed.inventory?.onOpenPreview("a-1");
    expect(workspaceActions.openPreview).toHaveBeenCalledExactlyOnceWith("a-1");
  });

  it("waits for the project library before consuming a resolve-draft handoff", async () => {
    shellState.projectId = "project-1";
    navigationState.resolveDraftId = "draft-1";
    const view = render(<ChatShell />);
    await waitFor(() => expect(agents.instances).toHaveLength(1));
    const agent = agents.instances[0];
    const getProjectFileIds = agent.options.getProjectFileIds as () => string[];

    expect(getProjectFileIds()).toEqual([]);
    expect(agent.runAgent).not.toHaveBeenCalled();

    shellState.projectFiles = [pickerEntry("draft-1", "README.md", "draft")];
    view.rerender(<ChatShell />);
    // The action waits for the history.
    await waitFor(() => expect(getProjectFileIds()).toEqual(["draft-1"]));
    expect(agent.runAgent).not.toHaveBeenCalled();
    restoreHistory(agent);

    await waitFor(() => expect(getProjectFileIds()).toEqual(["draft-1"]));
    await waitFor(() => expect(agent.runAgent).toHaveBeenCalledOnce());
    expect(agent.addMessage).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("selected draft ID is draft-1")
    }));

    shellState.selectedId = "session-2";
    view.rerender(<ChatShell />);
    await waitFor(() => expect(agents.instances).toHaveLength(2));
    shellState.selectedId = "session-1";
    view.rerender(<ChatShell />);
    await waitFor(() => expect(agents.instances).toHaveLength(3));
    restoreHistory(agents.instances[2]);
    expect(agents.instances[2].runAgent).not.toHaveBeenCalled();
  });
});

it("toggles the sidebar and the artifacts panel from the keyboard", () => {
  render(<ChatShell />);
  expect(screen.getByTestId("panes").textContent).toBe("sidebar:true artifacts:true");
  fireEvent.keyDown(window, { key: "S", ctrlKey: true, shiftKey: true });
  fireEvent.keyDown(window, { key: ".", ctrlKey: true });
  expect(screen.getByTestId("panes").textContent).toBe("sidebar:false artifacts:false");
});

it("selects the session that a changed link names, but not on first render", () => {
  navigationState.sessionId = "session-1";
  const view = render(<ChatShell />);
  expect(sessionListActions.select).not.toHaveBeenCalled();
  navigationState.sessionId = "session-2";
  view.rerender(<ChatShell />);
  expect(sessionListActions.select).toHaveBeenCalledWith("session-2");
});

it("caps project-file selection at twenty files", async () => {
  shellState.projectId = "project-1";
  shellState.projectFiles = Array.from({ length: 21 }, (_, index) =>
    pickerEntry(`file-${index}`, `File ${index}.txt`));
  render(<ChatShell />);
  const checkboxes = await screen.findAllByRole("checkbox");
  for (const checkbox of checkboxes.slice(0, 20)) fireEvent.click(checkbox);
  expect((checkboxes[19] as HTMLInputElement).checked).toBe(true);
  expect((checkboxes[20] as HTMLInputElement).disabled).toBe(true);
});

it("keeps selected project files through searches and drops files that are no longer available", async () => {
  shellState.projectId = "project-1";
  shellState.projectFiles = [
    pickerEntry("file-a", "Agenda.txt"),
    pickerEntry("file-b", "Budget.txt"),
    pickerEntry("file-c", "Contract.txt", "draft")
  ];
  const view = render(<ChatShell />);
  await waitFor(() => expect(agents.instances).toHaveLength(1));
  const getProjectFileIds = agents.instances[0].options.getProjectFileIds as () => string[];
  fireEvent.click(await screen.findByRole("checkbox", { name: "Agenda.txt" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Contract.txt (draft)" }));
  await waitFor(() => expect(getProjectFileIds()).toEqual(["file-a", "file-c"]));

  fireEvent.change(screen.getByLabelText("Search project files"), { target: { value: "budget" } });
  const others = await screen.findByRole("region", { name: "Other selected files" });
  expect((screen.getByRole("checkbox", { name: "Agenda.txt" }) as HTMLInputElement).checked).toBe(true);
  expect(others.textContent).toContain("Contract.txt (draft)");
  expect((screen.getByRole("checkbox", { name: "Budget.txt" }) as HTMLInputElement).checked).toBe(false);
  expect(getProjectFileIds()).toEqual(["file-a", "file-c"]);

  shellState.projectFiles = shellState.projectFiles.filter((file) => file.fileId !== "file-c");
  view.rerender(<ChatShell />);
  await waitFor(() => expect(getProjectFileIds()).toEqual(["file-a"]));
  expect(screen.getByText("1 selected file is no longer available. It was removed from your selection.").getAttribute("role")).toBe("status");
  expect(screen.queryByRole("checkbox", { name: "Contract.txt (draft)" })).toBeNull();
});

it("keeps confirmed project files in the turn while a toggle refetches and shows unconfirmed files", async () => {
  shellState.projectId = "project-1";
  shellState.projectFiles = [pickerEntry("file-a", "Agenda.txt"), pickerEntry("file-b", "Budget.txt")];
  shellState.selectionLookup = "pending";
  const view = render(<ChatShell />);
  await waitFor(() => expect(agents.instances).toHaveLength(1));
  const getProjectFileIds = agents.instances[0].options.getProjectFileIds as () => string[];
  const agenda = await screen.findByRole("checkbox", { name: "Agenda.txt" }) as HTMLInputElement;
  fireEvent.click(agenda);
  // The picker shows the pending selection, but the host does not get it yet.
  expect(agenda.checked).toBe(true);
  expect(getProjectFileIds()).toEqual([]);
  expect(screen.getByRole("status").textContent).toContain("Checking 1 selected file");

  shellState.selectionLookup = "confirmed";
  view.rerender(<ChatShell />);
  await waitFor(() => expect(getProjectFileIds()).toEqual(["file-a"]));
  expect(screen.queryByRole("status")).toBeNull();

  // A second toggle changes the key. The previous result is placeholder data
  // and still confirms file-a. The new file-b waits for its lookup.
  shellState.selectionLookup = "placeholder";
  fireEvent.click(screen.getByRole("checkbox", { name: "Budget.txt" }));
  expect(getProjectFileIds()).toEqual(["file-a"]);
  expect(screen.getByRole("status").textContent).toContain("Checking 1 selected file");

  shellState.selectionLookup = "error";
  view.rerender(<ChatShell />);
  expect(getProjectFileIds()).toEqual([]);
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("Could not check the selected files. A turn sent now does not include them.");
  fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
  expect(queryActions.projectRefetch).toHaveBeenCalledOnce();
  expect((screen.getByRole("checkbox", { name: "Budget.txt" }) as HTMLInputElement).checked).toBe(true);

  shellState.selectionLookup = "confirmed";
  view.rerender(<ChatShell />);
  await waitFor(() => expect(getProjectFileIds()).toEqual(["file-a", "file-b"]));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("says the last checked files are still sent when a selection refetch fails", async () => {
  shellState.projectId = "project-1";
  shellState.projectFiles = [pickerEntry("file-a", "Agenda.txt"), pickerEntry("file-b", "Budget.txt")];
  shellState.selectionLookup = "confirmed";
  const view = render(<ChatShell />);
  await waitFor(() => expect(agents.instances).toHaveLength(1));
  const getProjectFileIds = agents.instances[0].options.getProjectFileIds as () => string[];
  fireEvent.click(await screen.findByRole("checkbox", { name: "Agenda.txt" }));
  await waitFor(() => expect(getProjectFileIds()).toEqual(["file-a"]));

  // A refetch after a turn fails. The query keeps its last data.
  shellState.selectionLookup = "refetch-error";
  view.rerender(<ChatShell />);
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("A turn sent now includes the files from the last check.");
  expect(alert.textContent).not.toContain("does not include them");
  expect(getProjectFileIds()).toEqual(["file-a"]);
});

describe("ChatShell history format", () => {
  it.each([
    ["an earlier", "legacy", "This chat uses an earlier history format"],
    ["an unknown", "unsupported", "This chat uses an unsupported history format"],
    ["no", undefined, "This chat uses an unsupported history format"]
  ] as const)("shows %s history format instead of the chat, and offers a new session", async (_, transcriptFormat, title) => {
    shellState.serverActivity = { transcriptFormat };
    render(<ChatShell />);

    const heading = await screen.findByRole("heading", { name: title });
    const notice = heading.closest("section")!.textContent!;
    // Only a legacy record is known to be older. The notice does not guess the
    // age of another format, and it points to the clipboard copy, which stays.
    if (transcriptFormat !== "legacy") expect(notice).not.toMatch(/earlier|newer|latest/i);
    expect(notice).toContain("Copy session to clipboard");
    expect(screen.getByTestId("copy-session")).toBeTruthy();
    // No chat host, so no connection to the old checkpoint and no composer.
    expect(agents.instances).toEqual([]);
    expect(hostLifecycle.mounts).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    expect(sessionListActions.create).toHaveBeenCalledWith(null);
  });

  it("starts the new session in the project of an earlier project chat", async () => {
    shellState.projectId = "project-1";
    shellState.serverActivity = { transcriptFormat: "legacy", canEdit: true };
    render(<ChatShell />);

    fireEvent.click(await screen.findByRole("button", { name: "New session" }));
    expect(sessionListActions.create).toHaveBeenCalledWith("project-1");
  });

  it("mounts the chat when the user moves to a current session", async () => {
    shellState.serverActivity = { transcriptFormat: "legacy" };
    const view = render(<ChatShell />);
    await screen.findByRole("heading", { name: "This chat uses an earlier history format" });

    shellState.selectedId = "session-2";
    view.rerender(<ChatShell />);

    await waitFor(() => expect(agents.instances).toHaveLength(1));
    expect(screen.queryByRole("heading", { name: "This chat uses an earlier history format" })).toBeNull();
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

  const pendingApproval: Approval = {
    approvalId: "approval-1", sessionId: "session-1", itemId: "call-1",
    kind: "mcp_tool", title: "Publish report", summary: "Publish the draft report",
    status: "pending"
  };
  const status = () => screen.getByTestId("approval-attention").getAttribute("data-session-status");

  it("clears the selected chat's saved approval dot when the remote poll shows the approval answered", async () => {
    // The saved list still shows the approval. Another tab answered it.
    shellState.serverActivity = { isRunning: true, hasPendingApprovals: true };
    shellState.initialApprovals = [pendingApproval];
    render(<ChatShell />);
    await screen.findByRole("button", { name: "Approve once" });
    expect(status()).toBe("approval");
    // The connection cannot replay the turn, so the host polls the saved state.
    restoreHistory(agents.instances[0], "unavailable");

    await waitFor(() => expect(status()).toBe("running"));
    expect(screen.queryByRole("button", { name: "Approve once" })).toBeNull();
  });

  it("keeps the dot clear after the remote turn ends, until the list reload lands", async () => {
    shellState.serverActivity = { isRunning: true, hasPendingApprovals: true };
    shellState.initialApprovals = [pendingApproval];
    let finishReload = () => {};
    sessionListActions.reload.mockImplementation(() => new Promise<undefined>((resolve) => {
      finishReload = () => resolve(undefined);
    }));
    const { listSessions } = await import("../lib/session-api");
    // The poll reports the end of the turn. The saved list is not reloaded yet.
    vi.mocked(listSessions).mockResolvedValueOnce({ sessions: [{ sessionId: "session-1", isRunning: false }] as Session[], trashRetentionDays: 30 });
    const view = render(<ChatShell />);
    await screen.findByRole("button", { name: "Approve once" });
    restoreHistory(agents.instances[0], "unavailable");

    await waitFor(() => expect(sessionListActions.reload).toHaveBeenCalledOnce());
    // The saved row still shows the turn and the approval. The settled poll is newer.
    await waitFor(() => expect(status()).toBe("running"));
    expect(screen.queryByRole("button", { name: "Approve once" })).toBeNull();

    shellState.serverActivity = { isRunning: false, hasPendingApprovals: false };
    await act(async () => finishReload());
    view.rerender(<ChatShell />);
    expect(status()).toBe("ready");
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

describe("ChatShell empty model catalog", () => {
  it("directs admins to check credentials and model enablement", () => {
    shellState.hasModels = false;
    render(<ChatShell />);
    expect(screen.getByRole("heading", { name: "No models are available" })).toBeTruthy();
    expect(screen.getByText(/Set up provider credentials and enable at least one model/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Models" }).getAttribute("href")).toBe("/admin/models");
  });

  it("gives members an actionable explanation without an inaccessible admin link", () => {
    shellState.hasModels = false;
    shellState.role = "member";
    render(<ChatShell />);
    expect(screen.getByText(/Ask an administrator to check provider credentials and enable a model/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open Models" })).toBeNull();
  });
});

it.each(["Rename rejected", "Could not load the model list", "Failed to load sessions"])(
  "renders shell errors separately from turn status: %s", async (error) => {
    shellState.error = error;
    const view = render(<ChatShell />);
    expect(screen.getByRole("alert").textContent).toBe(error);
    expect(screen.getByTestId("approval-attention").getAttribute("data-session-status")).toBe("ready");
    shellState.error = null;
    view.rerender(<ChatShell />);
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(agents.instances).toHaveLength(1));
  }
);

it("forgets a failed live turn after observing a newer server turn, including after it finishes", async () => {
  const view = render(<ChatShell />);
  await waitFor(() => expect(agents.instances).toHaveLength(1));
  act(() => agents.instances[0].subscriber?.onRunInitialized?.(runStart));
  act(() => agents.instances[0].subscriber?.onRunFailed?.(runFailure));
  expect(screen.getByTestId("approval-attention").getAttribute("data-session-status")).toBe("failed");
  shellState.serverActivity = { isRunning: true, latestTurnId: "new-turn", latestTurnSequence: 42, activeTurnStartedAt: new Date(Date.now() - 60_000).toISOString() };
  view.rerender(<ChatShell />);
  expect(screen.getByTestId("approval-attention").getAttribute("data-session-status")).toBe("running");
  shellState.serverActivity = { isRunning: false };
  view.rerender(<ChatShell />);
  // The server turn ran without this tab's stream, so the host polls it and
  // confirms the end before the status changes.
  await waitFor(() => expect(screen.getByTestId("approval-attention").getAttribute("data-session-status")).toBe("ready"));
});


it("retains persisted failure after switching away, returning, and remounting", async () => {
  shellState.serverActivity = { latestTurnId: "failed-turn", latestTurnSequence: 42, hasTurnFailed: true, isRunning: false };
  const status = () => screen.getByTestId("approval-attention").getAttribute("data-session-status");
  const view = render(<ChatShell />);
  await waitFor(() => expect(agents.instances).toHaveLength(1));
  expect(status()).toBe("failed");
  shellState.selectedId = "session-2";
  view.rerender(<ChatShell />);
  expect(status()).toBe("ready");
  shellState.selectedId = "session-1";
  view.rerender(<ChatShell />);
  expect(status()).toBe("failed");
  view.unmount();
  const reloaded = render(<ChatShell />);
  expect(status()).toBe("failed");
  shellState.serverActivity = { latestTurnId: "success-turn", latestTurnSequence: 43, hasTurnFailed: false, isRunning: false };
  reloaded.rerender(<ChatShell />);
  expect(status()).toBe("ready");
});

it("confirms a header-menu delete on a phone while the session drawer is closed", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  try {
    shellState.pendingDeleteId = "session-1";
    render(<ChatShell />);
    const confirm = await screen.findByRole("alertdialog", { name: "Move this session to Trash?" });
    expect(screen.queryByRole("dialog", { name: "Sessions" })).toBeNull();
    expect(confirm.textContent).toContain('"session-1"');
    fireEvent.click(within(confirm).getByRole("button", { name: "Move to Trash" }));
    expect(sessionListActions.confirmDelete).toHaveBeenCalledOnce();
    // The action also closes the dialog; the hook reads the pending id before that.
    sessionListActions.confirmDelete.mockClear();
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(sessionListActions.cancelDelete).toHaveBeenCalled();
    expect(sessionListActions.confirmDelete).not.toHaveBeenCalled();
  } finally {
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  }
});

it("opens New session from a text field and starts each opening fresh", async () => {
  sessionListActions.create.mockRejectedValueOnce(new Error("Session service unavailable"));
  render(<ChatShell />);
  const field = document.body.appendChild(document.createElement("input"));
  try {
    fireEvent.keyDown(field, { key: "O", ctrlKey: true, shiftKey: true });
    let dialog = await screen.findByRole("dialog", { name: "New session" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create session" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Session service unavailable");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New session" })).toBeNull());
    fireEvent.keyDown(field, { key: "O", ctrlKey: true, shiftKey: true });
    dialog = await screen.findByRole("dialog", { name: "New session" });
    expect(within(dialog).queryByRole("alert")).toBeNull();
  } finally {
    field.remove();
  }
});

it("keeps the session shortcuts on a phone while the session drawer is closed or open", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  const press = (key: string) => fireEvent.keyDown(window, { key, ctrlKey: true, shiftKey: true });
  try {
    render(<ChatShell />);
    await waitFor(() => expect(screen.getByTestId("panes").textContent).toContain("sidebar:false"));
    press("O");
    const create = await screen.findByRole("dialog", { name: "New session" });
    fireEvent.click(within(create).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New session" })).toBeNull());

    press("S");
    await screen.findByRole("dialog", { name: "Sessions" });
    press("O");
    expect(await screen.findByRole("dialog", { name: "New session" })).toBeTruthy();
    // Over the New session dialog, the drawer shortcut does nothing.
    press("S");
    expect(screen.getByTestId("panes").textContent).toContain("sidebar:true");
    fireEvent.click(within(screen.getByRole("dialog", { name: "New session" })).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New session" })).toBeNull());
    press("S");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sessions" })).toBeNull());
  } finally {
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  }
});

it("wires selected-session busy and approval state into the header menu", async () => {
  shellState.busyId = "session-1";
  const view = render(<ChatShell />);
  fireEvent.keyDown(screen.getByRole("button", { name: "Session actions for session-1" }), { key: "Enter" });
  const rename = await screen.findByRole("menuitem", { name: "Rename session" });
  expect(rename.getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByRole("menuitem", { name: "Archive session" }).getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByText("Wait for the current session change to finish")).toBeTruthy();
  shellState.busyId = "session-2";
  shellState.serverActivity = { hasPendingApprovals: true };
  view.rerender(<ChatShell />);
  expect(screen.getByRole("menuitem", { name: "Rename session" }).getAttribute("aria-disabled")).toBeNull();
  expect(screen.getByRole("menuitem", { name: "Archive session" }).getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByText("Resolve pending approvals before archiving")).toBeTruthy();
});

it("passes refreshed final timing to the header and hides it while another turn runs", async () => {
  shellState.serverActivity = { latestTurnId: "turn-1", latestTurnSequence: 1 };
  shellState.messages = [{ marker: "history", sessionId: "session-1", messageId: "turn-1", role: "assistant", status: "completed", durationMs: 84000 }];
  const view = render(<ChatShell />);
  await waitFor(() => expect(screen.getByTestId("completed-duration").textContent).toBe("84000"));
  shellState.serverActivity = { latestTurnId: "turn-2", latestTurnSequence: 2, isRunning: true };
  view.rerender(<ChatShell />);
  expect(screen.getByTestId("completed-duration").textContent).toBe("");
  shellState.serverActivity.isRunning = false;
  view.rerender(<ChatShell />);
  expect(screen.getByTestId("completed-duration").textContent).toBe("");
  shellState.messages = [{ ...shellState.messages[0], messageId: "turn-2", durationMs: 12000 }];
  view.rerender(<ChatShell />);
  expect(screen.getByTestId("completed-duration").textContent).toBe("12000");
  shellState.selectedId = "session-2";
  view.rerender(<ChatShell />);
  expect(screen.getByTestId("completed-duration").textContent).toBe("");
});

it("polls after a dropped stream and refreshes once when the server reports the turn done", async () => {
  render(<ChatShell />);
  await waitFor(() => expect(agents.instances).toHaveLength(1));
  const listSessions = vi.mocked((await import("../lib/session-api")).listSessions);
  listSessions.mockClear();

  act(() => agents.instances[0].subscriber?.onRunInitialized?.(runStart));
  act(() => agents.instances[0].subscriber?.onRunFailed?.({ ...runFailure, error: new TypeError("network error") }));

  await waitFor(() => expect(queryActions.refresh).toHaveBeenCalledWith("session-1"));
  expect(listSessions).toHaveBeenCalledOnce();
  expect(queryActions.refresh).toHaveBeenCalledOnce();
  expect(screen.getByTestId("approval-attention").getAttribute("data-session-status")).toBe("ready");
});

it("shows valid runtime notices saved on the assistant rows", async () => {
  const notice = { level: "warning", message: "Details", createdAt: "2026-09-22T00:00:00.000Z" };
  shellState.messages = [{
    marker: "history-1",
    role: "assistant",
    detail: {
      runtimeNotices: [
        { ...notice, noticeId: "n-1", title: "Saved notice" },
        { ...notice, noticeId: "n-2", title: "Bad level", level: "debug" }
      ]
    }
  } as (typeof shellState.messages)[number]];
  render(<ChatShell />);

  expect(await screen.findByText("Saved notice", {}, { timeout: 10_000 })).toBeTruthy();
  expect(screen.queryByText("Bad level")).toBeNull();
});

// The shell measures the frame beside the session sidebar (the grid in main).
// jsdom has no layout, so these tests give that grid a width and report a
// change through the ResizeObserver, as a browser does.
const frame = vi.hoisted(() => ({ width: 1000, callbacks: new Map<ResizeObserverCallback, Element>() }));
const isFrame = (element: Element) => element.parentElement?.tagName === "MAIN" && element.classList.contains("grid");
function measureFrame(width: number) {
  frame.width = width;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) { if (isFrame(target)) frame.callbacks.set(this.callback, target); }
    unobserve() {}
    disconnect() { frame.callbacks.delete(this.callback); }
  };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const width = isFrame(this) ? frame.width : 0;
    return { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: width, width, height: 0, toJSON: () => ({}) } as DOMRect;
  });
}
function resizeFrame(width: number) {
  frame.width = width;
  act(() => {
    for (const [callback, target] of frame.callbacks) {
      callback([{ target, contentRect: { width } } as unknown as ResizeObserverEntry], {} as ResizeObserver);
    }
  });
}
const panes = () => screen.getByTestId("panes").textContent;
const frameGrid = () => document.querySelector("main > div.grid") as HTMLElement;
const paneWidth = () => frameGrid().style.getPropertyValue("--artifact-pane-width");
const toggleArtifacts = (target: Element | Window = window) => fireEvent.keyDown(target, { key: ".", ctrlKey: true });

describe("ChatShell workspace frame", () => {
  afterEach(() => {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    frame.callbacks.clear();
  });

  it("opens the artifacts panel at first only where it fits beside a readable chat", () => {
    // 1280px with the sidebar open leaves a 1000px frame.
    measureFrame(1000);
    const view = render(<ChatShell />);
    expect(panes()).toBe("sidebar:true artifacts:true");
    expect(paneWidth()).toBe("380px");
    expect(screen.getByRole("complementary", { name: "Context and artifacts" })).toBeTruthy();
    view.unmount();

    // 1024px with the sidebar open leaves 744px: the chat would get 360px.
    measureFrame(744);
    render(<ChatShell />);
    expect(panes()).toBe("sidebar:true artifacts:false");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelectorAll("[inert]")).toHaveLength(1);
  });

  it("clamps a stored 620px width to the space, and keeps the stored preference", () => {
    window.localStorage.setItem("artifact-pane-width", "620");
    measureFrame(1000);
    render(<ChatShell />);
    // 1000 - 4px handle - 480px chat leaves 516px.
    expect(paneWidth()).toBe("516px");
    expect(window.localStorage.getItem("artifact-pane-width")).toBe("620");
    const handle = screen.getByRole("separator", { name: "Resize artifacts panel" });
    fireEvent.keyDown(handle, { key: "End" });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(window.localStorage.getItem("artifact-pane-width")).toBe("620");
    resizeFrame(1280);
    expect(paneWidth()).toBe("620px");
  });

  it("opens the panel at the default width and still resizes it when the browser blocks storage", () => {
    const blocked = vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("Access is denied for this document.", "SecurityError");
    });
    try {
      measureFrame(1000);
      render(<ChatShell />);
      expect(paneWidth()).toBe("380px");
      fireEvent.keyDown(screen.getByRole("separator", { name: "Resize artifacts panel" }), { key: "ArrowLeft" });
      expect(paneWidth()).toBe("396px");
    } finally {
      // The shared afterEach clears storage before it restores the spies.
      blocked.mockRestore();
    }
  });

  it("keeps one chat host while the panel moves between beside the chat and over it", async () => {
    measureFrame(1280);
    render(<ChatShell />);
    await waitFor(() => expect(agents.instances).toHaveLength(1));
    expect(panes()).toBe("sidebar:true artifacts:true");

    // The space shrinks: the panel closes instead of covering the chat.
    resizeFrame(744);
    expect(panes()).toBe("sidebar:true artifacts:false");
    expect(screen.queryByRole("dialog")).toBeNull();

    toggleArtifacts();
    expect(screen.getByRole("dialog", { name: "Context and artifacts" })).toBeTruthy();
    resizeFrame(1280);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(panes()).toBe("sidebar:true artifacts:true");

    expect(agents.instances).toHaveLength(1);
    expect(hostLifecycle).toMatchObject({ mounts: 1, unmounts: 0 });
  });

  it("does not move page focus when a resize closes an unfocused inline panel", () => {
    measureFrame(1000);
    render(<ChatShell />);
    expect(document.activeElement).toBe(document.body);
    resizeFrame(744);
    expect(panes()).toBe("sidebar:true artifacts:false");
    expect(document.activeElement).toBe(document.body);
  });

  it("makes the overlay panel a modal: named, focused, Tab inside, background inert, Escape consumed, focus returned", async () => {
    measureFrame(744);
    render(<><button type="button">Opener</button><ChatShell /></>);
    await waitFor(() => expect(agents.instances).toHaveLength(1));
    const opener = screen.getByRole("button", { name: "Opener" });
    opener.focus();
    toggleArtifacts(opener);

    const dialog = screen.getByRole("dialog", { name: "Context and artifacts" });
    expect(dialog.tagName).toBe("ASIDE");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const close = within(dialog).getByRole("button", { name: "Close artifacts panel" });
    expect(document.activeElement).toBe(close);
    expect(opener.closest("[inert]")).not.toBeNull();
    expect(dialog.closest("[inert]")).toBeNull();
    // The chat column behind the drawer is inert, and stays mounted.
    expect(frameGrid().firstElementChild!.closest("[inert]")).not.toBeNull();
    // The shortcut guard sees the open dialog, so Stop stands aside.
    expect(otherOverlayOpen()).toBe(true);

    // Close is the only control here, so Tab wraps to it in both directions.
    expect(fireEvent.keyDown(close, { key: "Tab" })).toBe(false);
    expect(fireEvent.keyDown(close, { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(close);

    expect(fireEvent.keyDown(close, { key: "Escape" })).toBe(false);
    expect(panes()).toBe("sidebar:true artifacts:false");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelectorAll("[inert]")).toHaveLength(1);
    expect(dialog.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(opener);
    expect(hostLifecycle).toMatchObject({ mounts: 1, unmounts: 0 });
  });

  it("closes the overlay with its Close button and its backdrop", () => {
    measureFrame(744);
    render(<ChatShell />);
    toggleArtifacts();
    fireEvent.click(screen.getByRole("button", { name: "Close artifacts panel" }));
    expect(panes()).toBe("sidebar:true artifacts:false");
    toggleArtifacts();
    fireEvent.click(document.querySelector("button[aria-hidden='true'][tabindex='-1']")!);
    expect(panes()).toBe("sidebar:true artifacts:false");
  });

  it("toggles the drawer closed with its shortcut and returns a shortcut-only open to the header", () => {
    measureFrame(744);
    render(<ChatShell />);
    toggleArtifacts();
    const close = screen.getByRole("button", { name: "Close artifacts panel" });
    toggleArtifacts(close);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show artifacts panel" }));
  });

  it("keeps focus in the workspace when the focused modal Close becomes inline", () => {
    measureFrame(744);
    render(<ChatShell />);
    toggleArtifacts();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close artifacts panel" }));
    resizeFrame(1280);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Hide artifacts panel" }));
  });

  it("leaves Escape to a nested dialog first, then closes the overlay", async () => {
    measureFrame(744);
    const view = render(<ChatShell />);
    toggleArtifacts();
    // A preview or menu opens from inside the drawer.
    shellState.nestedDialog = true;
    view.rerender(<ChatShell />);
    const nested = await screen.findByRole("dialog", { name: "Nested preview" });
    expect(fireEvent.keyDown(nested, { key: "Escape" })).toBe(false);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Nested preview" })).toBeNull());
    expect(screen.getByRole("dialog", { name: "Context and artifacts" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Context and artifacts" })).toBeNull();
  });

  it("keeps an inline panel nonmodal, where Escape is left to Stop", () => {
    measureFrame(1000);
    render(<ChatShell />);
    const pane = screen.getByRole("complementary", { name: "Context and artifacts" });
    expect(pane.getAttribute("aria-modal")).toBeNull();
    expect(pane.hasAttribute("data-state")).toBe(false);
    expect(fireEvent.keyDown(window, { key: "Escape" })).toBe(true);
    expect(panes()).toBe("sidebar:true artifacts:true");
  });

  it("resizes the inline panel from the keyboard within the same limits as a drag", () => {
    measureFrame(1000);
    render(<ChatShell />);
    const handle = screen.getByRole("separator", { name: "Resize artifacts panel" });
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-controls")).toBe(screen.getByRole("complementary", { name: "Context and artifacts" }).id);
    expect([handle.getAttribute("aria-valuemin"), handle.getAttribute("aria-valuenow"), handle.getAttribute("aria-valuemax")])
      .toEqual(["320", "380", "516"]);
    expect(handle.tabIndex).toBe(0);

    expect(fireEvent.keyDown(handle, { key: "ArrowLeft" })).toBe(false);
    expect(handle.getAttribute("aria-valuenow")).toBe("396");
    fireEvent.keyDown(handle, { key: "End" });
    expect(paneWidth()).toBe("516px");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(handle.getAttribute("aria-valuenow")).toBe("516");
    fireEvent.keyDown(handle, { key: "Home" });
    expect(handle.getAttribute("aria-valuenow")).toBe("320");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle.getAttribute("aria-valuenow")).toBe("320");
    expect(window.localStorage.getItem("artifact-pane-width")).toBe("320");
    expect(fireEvent.keyDown(handle, { key: "Enter" })).toBe(true);
  });

  it("drags the inline panel no wider than the space allows", () => {
    measureFrame(1000);
    render(<ChatShell />);
    const handle = screen.getByRole("separator", { name: "Resize artifacts panel" });
    fireEvent.pointerDown(handle, { pointerId: 1 });
    // The frame's right edge is at 1000. A pointer at x=100 asks for 900px.
    fireEvent.pointerMove(window, { clientX: 100 });
    fireEvent.pointerUp(window);
    expect(paneWidth()).toBe("516px");
  });
});

describe("ChatShell chat area without a chat", () => {
  it("offers New session and the session list when no session is selected", () => {
    shellState.selectedId = null as unknown as string;
    render(<ChatShell />);
    expect(screen.getByRole("heading", { name: "No session selected" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    expect(sessionListActions.create).toHaveBeenCalledOnce();
    // The sidebar is open, so the list is already there.
    expect(screen.queryByRole("button", { name: "Open sessions" })).toBeNull();
    fireEvent.keyDown(window, { key: "S", ctrlKey: true, shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Open sessions" }));
    expect(panes()).toContain("sidebar:true");
    expect(hostLifecycle.mounts).toBe(0);
  });

  it("says that the session list loads before a session is selected", () => {
    shellState.selectedId = null as unknown as string;
    shellState.isLoadingSessions = true;
    render(<ChatShell />);
    expect(screen.getByRole("status").textContent).toBe("Loading sessions…");
  });

  it("says that the session loads, and the artifacts panel does not claim an empty session", () => {
    shellState.sessionData = "loading";
    render(<ChatShell />);
    expect(screen.getByRole("status").textContent).toBe("Loading session…");
    expect(hostLifecycle.mounts).toBe(0);
    expect(artifactPanelProps.values.at(-1)?.inventory.status).toBe("loading");
  });

  it("explains a failed first load once, and retries through the session refresh", async () => {
    shellState.sessionData = "error";
    let fail!: (error: Error) => void;
    queryActions.refresh.mockImplementationOnce(() => new Promise<void>((_, reject) => { fail = reject; }));
    render(<ChatShell />);
    const alert = screen.getByRole("alert");
    expect(within(alert).getByRole("heading", { name: "This session did not load" })).toBeTruthy();
    expect(screen.getAllByText(/HTTP 503/)).toHaveLength(1);
    expect(artifactPanelProps.values.at(-1)?.inventory.status).toBe("unavailable");

    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(queryActions.refresh).toHaveBeenCalledWith("session-1");
    expect(within(alert).getByRole("button", { name: "Retrying…" }).getAttribute("aria-disabled")).toBe("true");
    // A failed retry is caught. The error stays on the query and the card stays.
    await act(async () => { fail(new Error("HTTP 503")); });
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(hostLifecycle.mounts).toBe(0);
  });

  it("keeps the cached chat after a failed refetch, with the error in the banner", async () => {
    shellState.sessionData = "cached-error";
    render(<ChatShell />);
    await waitFor(() => expect(agents.instances).toHaveLength(1));
    expect(screen.getByRole("alert").textContent).toBe("HTTP 503");
    expect(screen.queryByRole("heading", { name: "This session did not load" })).toBeNull();
    expect(artifactPanelProps.values.at(-1)?.inventory.status).toBe("ready");
  });

  it("keeps the focused recovery button while a real uncached query clears its error during Retry", async () => {
    const { QueryClient } = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = ["retry-focus"];
    await client.fetchQuery({ queryKey: key, queryFn: () => Promise.reject(new Error("HTTP 503")) }).catch(() => {});
    shellState.sessionData = "error";
    const view = render(<ChatShell />);
    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    let rejectRetry!: (error: Error) => void;
    queryActions.refresh.mockImplementationOnce(() => {
      const pending = client.fetchQuery({ queryKey: key, queryFn: () => new Promise<never>((_, reject) => { rejectRetry = reject; }) });
      expect(client.getQueryState(key)?.error).toBeNull();
      shellState.sessionData = "loading";
      return pending;
    });
    fireEvent.click(retry);
    view.rerender(<ChatShell />);
    expect(screen.getByRole("button", { name: "Retrying…" })).toBe(retry);
    expect(document.activeElement).toBe(retry);
    fireEvent.click(retry);
    expect(queryActions.refresh).toHaveBeenCalledOnce();
    await act(async () => {
      rejectRetry(new Error("HTTP 503"));
      await Promise.resolve();
      shellState.sessionData = "error";
    });
    view.rerender(<ChatShell />);
    expect(screen.getByRole("button", { name: "Retry" })).toBe(retry);
    expect(document.activeElement).toBe(retry);
    client.clear();
  });

  it("keeps the no-model notice in front of the load states", () => {
    shellState.hasModels = false;
    shellState.sessionData = "error";
    render(<ChatShell />);
    expect(screen.getByRole("heading", { name: "No models are available" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "This session did not load" })).toBeNull();
    // The error is not lost: the banner shows it.
    expect(screen.getByRole("alert").textContent).toBe("HTTP 503");
  });

  it("keeps panel recovery available through the no-model gate after a failed load", async () => {
    shellState.hasModels = false;
    shellState.sessionData = "error";
    let fail!: (error: Error) => void;
    queryActions.refresh.mockImplementationOnce(() => new Promise<void>((_, reject) => { fail = reject; }));
    render(<ChatShell />);
    expect(artifactPanelProps.values.at(-1)?.inventory.status).toBe("unavailable");
    act(() => artifactPanelProps.values.at(-1)?.inventory.onRetry?.());
    expect(queryActions.refresh).toHaveBeenCalledWith("session-1");
    expect(artifactPanelProps.values.at(-1)?.inventory.retrying).toBe(true);
    act(() => artifactPanelProps.values.at(-1)?.inventory.onRetry?.());
    expect(queryActions.refresh).toHaveBeenCalledOnce();
    expect(screen.getByRole("heading", { name: "No models are available" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    await act(async () => { fail(new Error("HTTP 503")); });
    expect(artifactPanelProps.values.at(-1)?.inventory.retrying).toBe(false);
    expect(hostLifecycle.mounts).toBe(0);
  });
});
