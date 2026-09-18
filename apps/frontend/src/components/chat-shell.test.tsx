// @vitest-environment jsdom

import { act, cleanup, render, waitFor, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { lazy, useEffect, type ComponentType, type ReactNode } from "react";
import type { Approval, ProjectLibrary, Session } from "@cogniplane/shared-types";

const agents = vi.hoisted(() => ({
  instances: [] as Array<{
    options: Record<string, unknown>;
    abortRun: ReturnType<typeof vi.fn>;
    addMessage: ReturnType<typeof vi.fn>;
    runAgent: ReturnType<typeof vi.fn>;
    subscriber?: { onRunInitialized?: () => void; onRunFailed?: () => void }
  }>
}));
const shellState = vi.hoisted(() => ({
  selectedId: "session-1",
  busyId: null as string | null,
  hasModels: true,
  error: null as string | null,
  role: "admin",
  projectId: null as string | null,
  projectFiles: null as ProjectLibrary | null,
  messages: [{ marker: "history-1" }] as Array<{ marker: string } & Partial<import("@cogniplane/shared-types").Message>>,
  initialApprovals: [] as Approval[],
  serverActivity: {} as Partial<Session>
}));
const eventSeeds = vi.hoisted(() => ({ values: [] as unknown[][] }));
const hostLifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));
const navigationState = vi.hoisted(() => ({ resolveDraftId: null as string | null }));
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
    get: (key: string) => key === "resolveDraft" ? navigationState.resolveDraftId : null
  })
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: ({ queryKey, queryFn }: { queryKey?: unknown[]; queryFn?: () => unknown }) => {
    if (queryKey?.[2] === "library" || queryKey?.[1] === "chat-project-library-disabled") {
      return {
        data: shellState.projectFiles ?? undefined,
        isSuccess: shellState.projectFiles !== null,
        error: null,
        refetch: vi.fn()
      };
    }
    if (queryKey?.[0] === "projects" && queryKey?.[1] === "list") {
      void queryFn?.();
      return { data: [], error: null, refetch: vi.fn() };
    }
    return { data: { models: shellState.hasModels ? [{ id: "model-1", displayName: "Model 1", description: "", isDefault: true, provider: "openai", supportedEfforts: [], defaultEffort: null, contextWindow: 1000 }] : [], showEffortSelector: false }, error: null };
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
      ...(id === "session-1" ? shellState.serverActivity : {}),
      ...(id === "session-1" && shellState.projectId ? { projectId: shellState.projectId } : {})
    }));
    return {
      sessions,
      selectedSessionId: shellState.selectedId,
      selectedSession: sessions.find((session) => session.sessionId === shellState.selectedId),
      isLoadingSessions: false,
      busySessionId: shellState.busyId,
      error: shellState.error,
      renameSessionId: null,
      renameDraft: "",
      pinnedSessionIds: new Set<string>(),
      pendingDeleteSessionId: null,
      reload: vi.fn(), setError: vi.fn(), selectSession: vi.fn(), createSession: vi.fn(), startRename: vi.fn(),
      cancelRename: vi.fn(), confirmRename: vi.fn(), setRenameDraft: vi.fn(), deleteSession: vi.fn(),
      archiveSession: vi.fn(), togglePinSession: vi.fn(), confirmDelete: vi.fn(), cancelDelete: vi.fn(), renameSessionDirect: vi.fn()
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
  WorkspaceHeader: ({ hasPendingApprovals, sessionStatus, sessionActions, completedTurn }: {
    hasPendingApprovals: boolean;
    completedTurn?: { durationMs: number };
    sessionStatus: string;
    sessionActions?: Omit<SessionActionMenuProps, "onRename">;
  }) => <>
    <span data-testid="completed-duration">{completedTurn?.durationMs}</span>
    <span data-testid="approval-attention" data-session-status={sessionStatus}>{hasPendingApprovals ? "pending" : "clear"}</span>
    {sessionActions ? <SessionActionMenu {...sessionActions} onRename={() => {}} /> : null}
  </>
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
vi.mock("../lib/project-api", () => projectApi);
vi.mock("../lib/agui/deep-agents-browser-agent", () => ({
  DeepAgentsBrowserAgent: class {
    options: Record<string, unknown>;
    abortRun = vi.fn();
    addMessage = vi.fn();
    runAgent = vi.fn(async () => undefined);
    subscriber?: { onRunInitialized?: () => void; onRunFailed?: () => void };
    subscribe(subscriber: NonNullable<typeof this.subscriber>) { this.subscriber = subscriber; return { unsubscribe() {} }; }
    constructor(options: Record<string, unknown>) { this.options = options; agents.instances.push(this); }
  }
}));

import { SessionActionMenu, type SessionActionMenuProps } from "./session-action-menu";

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
  shellState.hasModels = true;
  shellState.projectId = null;
  shellState.projectFiles = null;
  shellState.error = null;
  shellState.role = "admin";
  shellState.messages = [{ marker: "history-1" }];
  shellState.initialApprovals = [];
  shellState.serverActivity = {};
  shellState.busyId = null;
  navigationState.resolveDraftId = null;
  projectApi.listProjects.mockClear();
  vi.restoreAllMocks();
});

describe("ChatShell session host boundary", () => {
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

  it("waits for the project library before consuming a resolve-draft handoff", async () => {
    shellState.projectId = "project-1";
    navigationState.resolveDraftId = "draft-1";
    const view = render(<ChatShell />);
    await waitFor(() => expect(agents.instances).toHaveLength(1));
    const agent = agents.instances[0];
    const getProjectFileIds = agent.options.getProjectFileIds as () => string[];

    expect(getProjectFileIds()).toEqual([]);
    expect(agent.runAgent).not.toHaveBeenCalled();

    shellState.projectFiles = {
      files: [{
        fileId: "draft-1",
        folderId: null,
        name: "README.md",
        kind: "draft",
        targetFileId: "published-1",
        baseVersionId: "published-1-v1",
        createdByType: "agent",
        trashedAt: null,
        updatedAt: "2026-09-15T12:00:00.000Z",
        version: {
          versionId: "draft-1-v1",
          fileId: "draft-1",
          versionNumber: 1,
          mimeType: "text/markdown",
          fileSizeBytes: 1,
          checksumSha256: "hash",
          createdBy: "agent-1",
          createdAt: "2026-09-15T12:00:00.000Z",
          restoredFromVersionId: null
        }
      }],
      folders: []
    };
    view.rerender(<ChatShell />);

    await waitFor(() => expect(getProjectFileIds()).toEqual(["draft-1"]));
    await waitFor(() => expect(agent.runAgent).toHaveBeenCalledOnce());

    shellState.selectedId = "session-2";
    view.rerender(<ChatShell />);
    await waitFor(() => expect(agents.instances).toHaveLength(2));
    shellState.selectedId = "session-1";
    view.rerender(<ChatShell />);
    await waitFor(() => expect(agents.instances).toHaveLength(3));
    expect(agents.instances[2].runAgent).not.toHaveBeenCalled();
  });
});

it("caps project-file selection at twenty files", async () => {
  shellState.projectId = "project-1";
  shellState.projectFiles = {
    files: Array.from({ length: 21 }, (_, index) => ({
      fileId: `file-${index}`,
      folderId: null,
      name: `File ${index}.txt`,
      kind: "published" as const,
      targetFileId: null,
      baseVersionId: null,
      createdByType: "user" as const,
      trashedAt: null,
      updatedAt: "2026-09-15T12:00:00.000Z",
      version: {
        versionId: `version-${index}`,
        fileId: `file-${index}`,
        versionNumber: 1,
        mimeType: "text/plain",
        fileSizeBytes: 1,
        checksumSha256: "hash",
        createdBy: "user-1",
        createdAt: "2026-09-15T12:00:00.000Z",
        restoredFromVersionId: null
      }
    })),
    folders: []
  };
  render(<ChatShell />);
  const checkboxes = await screen.findAllByRole("checkbox");
  for (const checkbox of checkboxes.slice(0, 20)) fireEvent.click(checkbox);
  expect((checkboxes[19] as HTMLInputElement).checked).toBe(true);
  expect((checkboxes[20] as HTMLInputElement).disabled).toBe(true);
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

describe("ChatShell empty model catalog", () => {
  it("directs admins to check credentials and model enablement", () => {
    shellState.hasModels = false;
    render(<ChatShell />);
    expect(screen.getByRole("heading", { name: "No models are available" })).toBeTruthy();
    expect(screen.getByText(/Check provider credentials and enable at least one model/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open admin settings" }).getAttribute("href")).toBe("/admin/organization");
  });

  it("gives members an actionable explanation without an inaccessible admin link", () => {
    shellState.hasModels = false;
    shellState.role = "member";
    render(<ChatShell />);
    expect(screen.getByText(/Ask an administrator to check provider credentials and enable a model/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open admin settings" })).toBeNull();
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
  act(() => agents.instances[0].subscriber?.onRunInitialized?.());
  act(() => agents.instances[0].subscriber?.onRunFailed?.());
  expect(screen.getByTestId("approval-attention").getAttribute("data-session-status")).toBe("failed");
  shellState.serverActivity = { isRunning: true, latestTurnId: "new-turn", latestTurnSequence: 42, activeTurnStartedAt: new Date(Date.now() - 60_000).toISOString() };
  view.rerender(<ChatShell />);
  expect(screen.getByTestId("approval-attention").getAttribute("data-session-status")).toBe("running");
  shellState.serverActivity = { isRunning: false };
  view.rerender(<ChatShell />);
  expect(screen.getByTestId("approval-attention").getAttribute("data-session-status")).toBe("ready");
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
