// @vitest-environment jsdom
//
// The chat area when the chat host throws: during render, or in an effect.
// The session sidebar and the header must stay usable, and a session switch
// or a new session must show a healthy chat. The host here is a stand-in that
// throws for chosen sessions; the real host runs in copilot-chat-host tests.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { lazy, useEffect, type ComponentType } from "react";
import type { Session } from "@cogniplane/shared-types";

const SECRET = "secret tool output: sk-test-123";

const hostState = vi.hoisted(() => ({
  // Sessions whose chat throws during render, or in an effect after mount.
  renderFails: new Set<string>(),
  effectFails: new Set<string>(),
  // A host that reports a running turn and live approvals after it mounts.
  reportsLiveTurn: new Set<string>(),
  renders: new Map<string, number>()
}));

const listState = vi.hoisted(() => ({
  initialIds: ["session-bad", "session-good"],
  initialSelected: "session-bad" as string | null,
  newSessionRequested: false,
  createCalls: [] as Array<string | null>,
  sessionProjects: {} as Record<string, string>
}));

vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<ComponentType>) => lazy(async () => ({ default: await loader() }))
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => ({ get: () => null }) }));
vi.mock("@tanstack/react-query", () => ({
  keepPreviousData: <T,>(previous: T) => previous,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: ({ queryKey }: { queryKey?: unknown[] }) => queryKey?.[0] === "projects"
    ? { data: [], error: null }
    : {
      data: { models: [{ id: "model-1", displayName: "Model 1", description: "", isDefault: true, provider: "openai", supportedEfforts: [], defaultEffort: null, contextWindow: 1000 }], showEffortSelector: false },
      error: null
    }
}));
vi.mock("../lib/auth-context", () => ({ useAuth: () => ({ isLoading: false, user: { role: "member", userId: "user-1", tenantId: "tenant-1" } }) }));
vi.mock("../lib/project-api", () => ({ listProjects: vi.fn(async () => []), setProjectSession: vi.fn() }));
vi.mock("../hooks/use-model-preference", () => ({ useModelPreference: () => ({ model: "model-1", setModel: vi.fn() }) }));
vi.mock("../hooks/use-effort-preference", () => ({ useEffortPreference: () => ({ effort: null, setEffort: vi.fn() }) }));
vi.mock("../hooks/use-file-sources", () => ({ useFileSources: () => ({ sources: [] }) }));
vi.mock("../hooks/use-project-library", () => ({
  useProjectFileSelection: () => ({ data: undefined, isSuccess: false, isError: false, isPlaceholderData: false, refetch: vi.fn() })
}));
vi.mock("./project-file-selection", async (importOriginal) => ({
  ...await importOriginal<typeof import("./project-file-selection")>(),
  ProjectFileSelection: () => null
}));
vi.mock("../hooks/use-chat-workspace", () => ({
  useChatWorkspace: () => ({
    messages: [],
    artifacts: [],
    initialApprovals: [],
    isSessionDataReady: true,
    hasSessionData: true,
    loadError: null,
    refreshSessionData: vi.fn(async () => undefined),
    artifactState: {
      visibleSelectedArtifactIds: [], isUploadingArtifact: false, downloadArtifactId: null,
      previewArtifactId: null, isLoadingPreview: false, toggleArtifactSelection: vi.fn(),
      handleUploadArtifact: vi.fn(), handleDownloadArtifact: vi.fn(), openPreview: vi.fn(), selectArtifact: vi.fn()
    }
  })
}));
// A session list with real selection state, so that a switch and a create
// change what the shell renders.
vi.mock("../hooks/use-session-list", async () => {
  const { useState } = await import("react");
  const toSession = (sessionId: string): Session => ({
    sessionId,
    userId: "user-1",
    sessionName: sessionId,
    status: "active",
    createdAt: "2026-11-10T12:00:00.000Z",
    updatedAt: "2026-11-10T12:00:00.000Z",
    transcriptFormat: "current",
    ...(listState.sessionProjects[sessionId] ? { projectId: listState.sessionProjects[sessionId] } : {})
  } as Session);
  return {
    useSessionList: () => {
      const [ids, setIds] = useState(listState.initialIds);
      const [selectedId, setSelectedId] = useState(listState.initialSelected);
      const sessions = ids.map(toSession);
      return {
        sessions,
        sidebarSessions: sessions,
        selectedSessionId: selectedId,
        selectedSession: sessions.find((session) => session.sessionId === selectedId) ?? null,
        newSessionRequested: listState.newSessionRequested,
        isLoadingSessions: false,
        isCreatingSession: false,
        busySessionId: null,
        error: null,
        listError: null,
        renameSessionId: null,
        renameDraft: "",
        pinnedSessionIds: new Set<string>(),
        pendingDeleteSessionId: null,
        trashRetentionDays: 30,
        search: "",
        setSearch: vi.fn(),
        reload: vi.fn(async () => undefined),
        setError: vi.fn(),
        selectSession: (sessionId: string) => setSelectedId(sessionId),
        createSession: async (projectId: string | null = null) => {
          listState.createCalls.push(projectId);
          setIds((current) => ["session-new", ...current]);
          setSelectedId("session-new");
        },
        startRename: vi.fn(), cancelRename: vi.fn(), confirmRename: vi.fn(), setRenameDraft: vi.fn(),
        renameSessionDirect: vi.fn(), deleteSession: vi.fn(), archiveSession: vi.fn(), togglePinSession: vi.fn(),
        confirmDelete: vi.fn(), cancelDelete: vi.fn()
      };
    }
  };
});
vi.mock("./session-sidebar", () => ({
  SessionSidebar: ({ list }: { list: { sessions: Session[]; selectedId: string | null; streamingIds: Set<string>; onSelect: (id: string) => void } }) => (
    <nav aria-label="Sessions">
      {list.sessions.map((session) => (
        <button key={session.sessionId} type="button" aria-current={session.sessionId === list.selectedId || undefined}
          data-streaming={list.streamingIds.has(session.sessionId) || undefined}
          onClick={() => list.onSelect(session.sessionId)}>
          {session.sessionName}
        </button>
      ))}
    </nav>
  )
}));
vi.mock("./workspace-header", () => ({
  WorkspaceHeader: ({ sessionStatus, hasPendingApprovals }: { sessionStatus?: string; hasPendingApprovals: boolean }) => (
    <header data-testid="header" data-status={sessionStatus} data-approvals={String(hasPendingApprovals)} />
  )
}));
vi.mock("./artifact-panel", () => ({ ArtifactPanel: () => null }));
vi.mock("./artifact-preview-modal", () => ({ ArtifactPreviewModal: () => null }));
vi.mock("./file-source-picker", () => ({ FileSourcePicker: () => null }));
vi.mock("./copilot-chat-host", () => ({
  CopilotChatHost: ({ session, events }: {
    session: { id: string };
    events: { onTurnRunningChange?: (running: boolean) => void; onPendingApprovalsChange?: (count: number) => void };
  }) => {
    const renders = (hostState.renders.get(session.id) ?? 0) + 1;
    hostState.renders.set(session.id, renders);
    if (hostState.renderFails.has(session.id)) throw new Error(SECRET);
    // The effect closes over the props of this render, as the real host's do.
    useEffect(() => {
      if (hostState.effectFails.has(session.id)) throw new Error(SECRET);
      if (hostState.reportsLiveTurn.has(session.id)) {
        events.onTurnRunningChange?.(true);
        events.onPendingApprovalsChange?.(2);
      }
    }, [events, session.id]);
    return <div data-testid="chat-host">{`Chat of ${session.id}`}</div>;
  }
}));

import { ChatShell } from "./chat-shell";

beforeAll(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  // React reports a caught render error with console.error. Keep the output clean.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  hostState.renderFails.clear();
  hostState.effectFails.clear();
  hostState.reportsLiveTurn.clear();
  hostState.renders.clear();
  listState.initialIds = ["session-bad", "session-good"];
  listState.initialSelected = "session-bad";
  listState.newSessionRequested = false;
  listState.createCalls = [];
  listState.sessionProjects = {};
});

const sidebar = () => screen.getByRole("navigation", { name: "Sessions" });
const chatFailure = () => screen.findByRole("alert", {}, { timeout: 10_000 });

describe("ChatShell when the chat fails to render", () => {
  it("keeps the sidebar usable, recovers on a switch, and fails again on the broken session", async () => {
    hostState.renderFails.add("session-bad");
    render(<ChatShell />);

    const failure = await chatFailure();
    expect(within(failure).getByRole("heading", { name: "This session could not be shown" })).toBeTruthy();
    expect(document.body.textContent).not.toContain(SECRET);
    expect(screen.queryByTestId("chat-host")).toBeNull();

    fireEvent.click(within(sidebar()).getByRole("button", { name: "session-good" }));
    expect((await screen.findByTestId("chat-host")).textContent).toBe("Chat of session-good");
    expect(screen.queryByRole("alert")).toBeNull();

    // The boundary belongs to one session: the broken one fails again, the
    // healthy one keeps no error state from it.
    fireEvent.click(within(sidebar()).getByRole("button", { name: "session-bad" }));
    expect(await chatFailure()).toBeTruthy();
    fireEvent.click(within(sidebar()).getByRole("button", { name: "session-good" }));
    expect((await screen.findByTestId("chat-host")).textContent).toBe("Chat of session-good");
  });

  it("tries the same session again once per click, and New session leaves it", async () => {
    hostState.renderFails.add("session-bad");
    listState.sessionProjects = { "session-bad": "project-1" };
    render(<ChatShell />);
    const failure = await chatFailure();
    const rendersBefore = hostState.renders.get("session-bad") ?? 0;

    fireEvent.click(within(failure).getByRole("button", { name: "Try again" }));
    // The saved content still fails. The click renders it again; nothing
    // retries it after that.
    const again = await chatFailure();
    const rendersAfterRetry = hostState.renders.get("session-bad")!;
    expect(rendersAfterRetry).toBeGreaterThan(rendersBefore);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(hostState.renders.get("session-bad")).toBe(rendersAfterRetry);

    fireEvent.click(within(again).getByRole("button", { name: "New session" }));
    // The new session goes in the project of the failed one, as the transcript notice does.
    await waitFor(() => expect(listState.createCalls).toEqual(["project-1"]));
    expect((await screen.findByTestId("chat-host")).textContent).toBe("Chat of session-new");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("catches an error that the chat throws in an effect", async () => {
    hostState.effectFails.add("session-bad");
    render(<ChatShell />);

    expect(await chatFailure()).toBeTruthy();
    expect(document.body.textContent).not.toContain(SECRET);
    fireEvent.click(within(sidebar()).getByRole("button", { name: "session-good" }));
    expect((await screen.findByTestId("chat-host")).textContent).toBe("Chat of session-good");
  });

  it("clears the live turn state that the failed chat reported", async () => {
    hostState.reportsLiveTurn.add("session-bad");
    const view = render(<ChatShell />);
    await screen.findByTestId("chat-host", {}, { timeout: 10_000 });
    await waitFor(() => expect(screen.getByTestId("header").dataset.status).toBe("approval"));
    expect(within(sidebar()).getByRole("button", { name: "session-bad" }).dataset.streaming).toBe("true");

    // The next render of the same chat throws.
    hostState.renderFails.add("session-bad");
    view.rerender(<ChatShell />);
    await chatFailure();
    // The stream of the failed chat is gone. Its running turn and live
    // approvals no longer describe the session.
    await waitFor(() => expect(screen.getByTestId("header").dataset.status).toBe("ready"));
    expect(screen.getByTestId("header").dataset.approvals).toBe("false");
    expect(within(sidebar()).getByRole("button", { name: "session-bad" }).dataset.streaming).toBeUndefined();
  });

  it("opens New session, with no session selected, when the page opens from a New session link", async () => {
    listState.initialSelected = null;
    listState.newSessionRequested = true;
    render(<ChatShell />);

    const dialog = await screen.findByRole("dialog", { name: "New session" });
    expect(dialog).toBeTruthy();
    expect(screen.queryByTestId("chat-host")).toBeNull();
    act(() => { fireEvent.keyDown(dialog, { key: "Escape" }); });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New session" })).toBeNull());
    expect(screen.getByRole("heading", { name: "No session selected" })).toBeTruthy();
  });
});
