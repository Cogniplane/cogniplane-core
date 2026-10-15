"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useSessionList } from "../hooks/use-session-list";
import { useChatWorkspace } from "../hooks/use-chat-workspace";
import { useEffortPreference } from "../hooks/use-effort-preference";
import { useFileSources } from "../hooks/use-file-sources";
import { useModelPreference } from "../hooks/use-model-preference";
import { useAuth } from "../lib/auth-context";
import { fetchModels } from "../lib/api-client";
import { SHORTCUTS, useShortcut } from "../lib/keyboard-shortcuts";
import { queryKeys } from "../lib/query-keys";
import { listProjects, setProjectSession } from "../lib/project-api";

import { applyLiveTurn, latestCompletedTurn, resolveSessionStatus, type LiveTurnActivity } from "./session-status.logic";
import { SessionSidebar } from "./session-sidebar";
import { ArtifactPanel } from "./artifact-panel";
import { ArtifactPreviewModal } from "./artifact-preview-modal";
import { FileSourcePicker } from "./file-source-picker";
import { TranscriptFormatNotice } from "./transcript-format-notice";
import { WorkspaceHeader } from "./workspace-header";
import { useProjectFileSelection } from "../hooks/use-project-library";
import { MAX_PROJECT_FILE_SELECTIONS, ProjectFileSelection } from "./project-file-selection";

// CopilotKit + @ag-ui/client are large and browser-only (the chat host drives a
// live HttpAgent in the browser — it never needs to server-render). Loading it
// statically pulls the entire CopilotKit tree into the OpenNext server bundle,
// which blew past Cloudflare's Worker size limit. `ssr: false` keeps it in the
// client chunks (served as CF assets, not counted against the Worker size).
const CopilotChatHost = dynamic(
  () => import("./copilot-chat-host").then((m) => m.CopilotChatHost),
  { ssr: false }
);
import {
  mcpAppsFromMessages,
  runtimeNoticesFromMessages,
  toolStatusesFromMessages
} from "./agui-transcript";
import {
  ARTIFACT_PANE_WIDTH,
  clampArtifactPaneWidth,
  readStoredArtifactPaneWidth
} from "./artifact-pane-geometry";
import { formatSessionForClipboard } from "./session-clipboard";
import {
  deriveAttentionSessionIds,
  deriveStreamingSessionIds
} from "./session-list-derivations";
import { contextWindowForModel, latestContextTokens, sessionCostUsd } from "./session-usage";

export function ChatShell() {
  const { isLoading: authIsLoading, user } = useAuth();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const sessionList = useSessionList({ enabled: Boolean(user), syncUrl: true });
  const { setError: setSessionListError } = sessionList;
  const chatMainRef = useRef<HTMLDivElement | null>(null);
  const modelsQuery = useQuery({
    queryKey: queryKeys.models.list(),
    queryFn: fetchModels,
    enabled: !authIsLoading && Boolean(user)
  });
  const allModels = modelsQuery.data?.models ?? [];
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.list(),
    queryFn: () => listProjects(),
    enabled: !authIsLoading && Boolean(user)
  });
  const projects = projectsQuery.data ?? [];
  const showEffortSelector = modelsQuery.data?.showEffortSelector ?? false;
  // /models applies both credential availability and the tenant's model policy.
  const noModelsAvailable =
    Boolean(user) && modelsQuery.data !== undefined && allModels.length === 0;
  const [isArtifactPaneOpen, setIsArtifactPaneOpen] = useState(true);
  const [activeFileSourceId, setActiveFileSourceId] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [artifactPaneWidth, setArtifactPaneWidth] = useState<number>(ARTIFACT_PANE_WIDTH.default);
  // Grid-column transitions ease the pane open/closed, but the same transition
  // would rubber-band live drag-resizing — suppress it while a drag is active.
  const [isResizingPane, setIsResizingPane] = useState(false);
  // Live signals lifted from CopilotChatHost (the AG-UI stream) for the active
  // session — the shell renders the sidebar/header but the running/approval
  // state lives inside the host's agent subscription.
  const [turnActivity, setTurnActivity] = useState<LiveTurnActivity | null>(null);
  const [turnRunning, setTurnRunning] = useState(false);
  // True from the end of a turn until the session list reloads. In that time
  // the saved approval flag can still show an approval that was answered.
  const [isReloadingAfterTurn, setIsReloadingAfterTurn] = useState(false);
  const [liveApprovalCount, setLiveApprovalCount] = useState(0);
  const [signalSessionId, setSignalSessionId] = useState(sessionList.selectedSessionId);
  const [selectedProjectFiles, setSelectedProjectFiles] = useState<{
    projectId: string | null;
    ids: string[];
  }>({ projectId: null, ids: [] });
  const projectId = sessionList.selectedSession?.projectId ?? null;
  const sessionId = sessionList.selectedSessionId;
  const resolveDraftIdFromUrl = searchParams?.get("resolveDraft") ?? null;
  const [consumedResolveDraftId, setConsumedResolveDraftId] = useState<string | null>(null);
  const resolveDraftId = resolveDraftIdFromUrl !== consumedResolveDraftId
    ? resolveDraftIdFromUrl
    : null;
  const [resolveDraftIntent, setResolveDraftIntent] = useState<{
    sessionId: string;
    draftId: string;
  } | null>(null);
  const [unavailableSelections, setUnavailableSelections] = useState<{
    projectId: string | null;
    count: number;
  }>({ projectId: null, count: 0 });
  const selectedProjectFileIds = useMemo(
    () => (selectedProjectFiles.projectId === projectId ? selectedProjectFiles.ids : [])
      .slice(0, MAX_PROJECT_FILE_SELECTIONS),
    [projectId, selectedProjectFiles]
  );
  // Loads exactly the selected files, so selections outlive picker searches
  // and pages, and deleted or inaccessible files can be detected.
  const selectionQuery = useProjectFileSelection(projectId, selectedProjectFileIds);
  const resolveDraftQuery = useProjectFileSelection(
    projectId,
    resolveDraftId && sessionId ? [resolveDraftId] : []
  );

  useEffect(() => {
    if (!resolveDraftId || !projectId || !sessionId || resolveDraftQuery.isPlaceholderData) return;
    // Wait for the draft lookup before consuming the URL intent. This keeps a
    // valid draft from being dropped while the lookup is still loading.
    if (!resolveDraftQuery.isSuccess && !resolveDraftQuery.isError) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConsumedResolveDraftId(resolveDraftId);
    if (resolveDraftQuery.data?.items.some((file) => file.fileId === resolveDraftId)) {
      setResolveDraftIntent({ sessionId, draftId: resolveDraftId });
      const currentIds = selectedProjectFiles.projectId === projectId
        ? selectedProjectFiles.ids
        : [];
      if (!currentIds.includes(resolveDraftId)) {
        setSelectedProjectFiles({
          projectId,
          ids: [resolveDraftId, ...currentIds].slice(0, MAX_PROJECT_FILE_SELECTIONS)
        });
      }
    }
    const url = new URL(window.location.href);
    url.searchParams.delete("resolveDraft");
    window.history.replaceState(window.history.state, "", url);
  }, [projectId, resolveDraftId, resolveDraftQuery.data, resolveDraftQuery.isError, resolveDraftQuery.isPlaceholderData, resolveDraftQuery.isSuccess, selectedProjectFiles.ids, selectedProjectFiles.projectId, sessionId]);

  useEffect(() => {
    if (!resolveDraftIntent || resolveDraftIntent.sessionId === sessionId) return;
    // A session switch remounts the host. Do not let the old session's
    // one-shot intent trigger again if the user returns to it later.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setResolveDraftIntent(null);
  }, [resolveDraftIntent, sessionId]);

  useEffect(() => {
    if (!projectId || selectedProjectFiles.projectId !== projectId) return;
    // Placeholder data belongs to the previous ID list. Only a response for the
    // current list proves that a missing ID is deleted or inaccessible.
    if (!selectionQuery.isSuccess || selectionQuery.isPlaceholderData) return;
    const available = new Set(selectionQuery.data.items.map((file) => file.fileId));
    const reconciledIds = selectedProjectFileIds.filter((fileId) => available.has(fileId));
    if (reconciledIds.length === selectedProjectFiles.ids.length) return;
    // The query is the source of truth after trash/restore/promotion changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedProjectFiles({ projectId, ids: reconciledIds });
    setUnavailableSelections({
      projectId,
      count: selectedProjectFiles.ids.length - reconciledIds.length
    });
  }, [projectId, selectedProjectFileIds, selectedProjectFiles, selectionQuery.data, selectionQuery.isPlaceholderData, selectionQuery.isSuccess]);

  // A turn gets the selected IDs that a lookup confirmed. Placeholder data is
  // the result for the previous ID list. It still confirms the IDs that stay
  // selected, so a checkbox toggle does not drop them while the new lookup
  // runs. The server filters the IDs again when it captures the snapshot.
  const confirmedProjectFileIds = useMemo(() => {
    const confirmed = new Set(selectionQuery.data?.items.map((file) => file.fileId) ?? []);
    // The resolve-draft lookup confirmed its draft. Keep it for the handoff
    // turn while the lookup for the full list is still loading.
    if (resolveDraftIntent?.sessionId === sessionId) confirmed.add(resolveDraftIntent.draftId);
    return selectedProjectFileIds.filter((fileId) => confirmed.has(fileId));
  }, [resolveDraftIntent, selectedProjectFileIds, selectionQuery.data, sessionId]);
  // Newly added IDs wait for the lookup. The picker tells the user that a turn
  // sent now does not include them.
  const checkingProjectFileCount = !selectionQuery.isError &&
    (!selectionQuery.isSuccess || selectionQuery.isPlaceholderData)
    ? selectedProjectFileIds.length - confirmedProjectFileIds.length
    : 0;

  const selectSession = useCallback(
    (sessionId: string) => {
      sessionList.selectSession(sessionId);
      if (window.matchMedia("(max-width: 767px)").matches) setIsSidebarOpen(false);
    },
    [sessionList]
  );

  // Quick jump opens a session with a link to "/?session=<id>". On this page the link
  // changes only the URL, so select the session when the link changes.
  const linkedSessionId = searchParams?.get("session") ?? null;
  const previousLinkedSessionId = useRef(linkedSessionId);
  useEffect(() => {
    if (linkedSessionId === previousLinkedSessionId.current) return;
    previousLinkedSessionId.current = linkedSessionId;
    // The URL is the external source. Selecting also writes storage and history, so it cannot run during render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (linkedSessionId && linkedSessionId !== sessionList.selectedSessionId) selectSession(linkedSessionId);
  }, [linkedSessionId, selectSession, sessionList.selectedSessionId]);

  const addSessionToProject = useCallback(async (sessionId: string, projectId: string) => {
    await setProjectSession(projectId, sessionId);
    // The session list drives project counts and grouping in the sidebar. The
    // assignment also updates the project's activity timestamp, so refresh
    // both sidebar lists without invalidating session detail or file queries.
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions.list() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list() })
    ]);
  }, [queryClient]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const applyMobileLayout = (isMobile: boolean) => {
      if (isMobile) {
        setIsSidebarOpen(false);
        setIsArtifactPaneOpen(false);
      }
    };
    applyMobileLayout(media.matches);
    const onChange = (event: MediaQueryListEvent) => applyMobileLayout(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!isSidebarOpen && !isArtifactPaneOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (window.matchMedia("(max-width: 767px)").matches) {
        setIsSidebarOpen(false);
        setIsArtifactPaneOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isArtifactPaneOpen, isSidebarOpen]);
  useShortcut(SHORTCUTS.toggleSidebar, () => setIsSidebarOpen((open) => !open));
  useShortcut(SHORTCUTS.toggleArtifacts, () => setIsArtifactPaneOpen((open) => !open), Boolean(sessionList.selectedSession));

  const { model, setModel } = useModelPreference(allModels);
  const selectedModel = allModels.find((entry) => entry.id === model) ?? null;
  const { effort, setEffort } = useEffortPreference(
    selectedModel,
    showEffortSelector,
    modelsQuery.data !== undefined
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = readStoredArtifactPaneWidth(window.localStorage.getItem("artifact-pane-width"));
    // SSR-safe localStorage hydration: lazy init would cause hydration mismatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (stored != null) setArtifactPaneWidth(stored);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("artifact-pane-width", String(artifactPaneWidth));
  }, [artifactPaneWidth]);

  const modelError = modelsQuery.error
    ? `Could not load the model list: ${modelsQuery.error instanceof Error ? modelsQuery.error.message : String(modelsQuery.error)}`
    : null;

  const chatWorkspace = useChatWorkspace({
    selectedSessionId: sessionList.selectedSessionId,
    onError: setSessionListError
  });

  if (signalSessionId !== sessionList.selectedSessionId) {
    // Seed from the persisted response so the attention indicator remains set
    // during the remount, before the host publishes its live count. The host
    // is gated on isSessionDataReady below, so this transient shell state is
    // safe while the new session data loads.
    setSignalSessionId(sessionList.selectedSessionId);
    setTurnRunning(false);
    setIsReloadingAfterTurn(false);
    // Reset activity with its session identity so it cannot describe the next selection.
    setTurnActivity(null);
    setLiveApprovalCount(chatWorkspace.initialApprovals.length);
  }

  const { messages } = chatWorkspace;

  const formatSessionForClipboardCallback = useCallback(
    (): string | undefined => formatSessionForClipboard(messages),
    [messages]
  );

  useEffect(() => {
    if (!sessionList.selectedSessionId) {
      // Clear stale file-source selection when the active session goes away.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveFileSourceId(null);
    }
  }, [sessionList.selectedSessionId]);

  const fileSources = useFileSources({
    selectedSessionId: sessionList.selectedSessionId,
    onError: setSessionListError,
    onRefreshArtifacts: async () => {
      if (!sessionList.selectedSessionId) return;
      await chatWorkspace.refreshSessionData(sessionList.selectedSessionId);
    },
    onImportedArtifact: chatWorkspace.artifactState.selectArtifact
  });

  const startArtifactPaneResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const container = chatMainRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();

    const handlePointerMove = (moveEvent: PointerEvent) => {
      setArtifactPaneWidth(clampArtifactPaneWidth(rect.right, moveEvent.clientX));
    };

    const handlePointerUp = () => {
      setIsResizingPane(false);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };

    setIsResizingPane(true);
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, []);

  // Once a newer server turn is observed, forget the old live activity even
  // after that server turn ends and its timestamp disappears from the list.
  const selectedRawSession = sessionList.selectedSession;
  const liveResolution = selectedRawSession && turnActivity
    ? applyLiveTurn(selectedRawSession, turnActivity)
    : null;
  if (liveResolution && !liveResolution.applied) setTurnActivity(null);
  const selectedDisplaySession = liveResolution?.session ?? selectedRawSession;
  const displaySessions = sessionList.sessions.map((session) =>
    session.sessionId === selectedDisplaySession?.sessionId ? selectedDisplaySession : session
  );
  const hasTurnFailed = selectedDisplaySession?.hasTurnFailed === true;

  const attentionSessionIds = useMemo(
    () => deriveAttentionSessionIds(
      displaySessions,
      sessionList.selectedSessionId,
      liveApprovalCount,
      turnRunning || isReloadingAfterTurn
    ),
    [displaySessions, sessionList.selectedSessionId, liveApprovalCount, turnRunning, isReloadingAfterTurn]
  );

  // Only the selected session has a host, so it is the only one that can
  // stream. Map the lifted running state onto its id. A turn that the host
  // polls counts too.
  const streamingSessionIds = useMemo(
    () =>
      deriveStreamingSessionIds(
        displaySessions,
        turnRunning ? sessionList.selectedSessionId : null
      ),
    [displaySessions, turnRunning, sessionList.selectedSessionId]
  );

  const contextTokens = latestContextTokens(chatWorkspace.messages);
  const contextWindow = contextWindowForModel(selectedModel);
  const sessionCost = sessionCostUsd(chatWorkspace.messages);
  // CopilotChat loads the transcript and plan through the session connection.
  // The saved messages here only seed the side state: failed or declined tool
  // calls, MCP apps, and runtime notices. The hook re-seeds them when the
  // session changes.
  const selectedIsServerRunning = sessionList.selectedSession?.isRunning === true;
  const initialToolStatuses = useMemo(
    () => toolStatusesFromMessages(chatWorkspace.messages),
    [chatWorkspace.messages]
  );
  const initialMcpApps = useMemo(
    () => mcpAppsFromMessages(chatWorkspace.messages),
    [chatWorkspace.messages]
  );
  // Saved runtime notices, re-seeded on session re-key like the tool failures.
  const initialNotices = useMemo(
    () => runtimeNoticesFromMessages(chatWorkspace.messages),
    [chatWorkspace.messages]
  );

  const sidebarColClass = isSidebarOpen
    ? "md:grid-cols-[280px_minmax(0,1fr)]"
    : "md:grid-cols-[0_minmax(0,1fr)]";
  const hasSession = Boolean(sessionList.selectedSession);
  const showArtifactPane = hasSession && isArtifactPaneOpen;
  // The resizer + pane stay mounted (at zero-width tracks) while a session is
  // selected so toggling the pane animates instead of unmounting abruptly.
  const chatColClass = !hasSession
    ? "md:grid-cols-[minmax(0,1fr)]"
    : showArtifactPane
      ? "md:grid-cols-[minmax(0,1fr)_4px_var(--artifact-pane-width)]"
      : "md:grid-cols-[minmax(0,1fr)_0px_0px]";

  return (
    <div className={`relative grid h-dvh grid-cols-1 overflow-hidden transition-[grid-template-columns] duration-200 ease-[var(--ease-standard)] motion-reduce:transition-none ${sidebarColClass}`}>
      {isSidebarOpen ? (
        <button
          type="button"
          aria-label="Close session sidebar"
          className="fixed inset-0 z-[var(--z-modal-backdrop)] bg-primary/25 backdrop-blur-[2px] md:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      ) : null}
      <div
        className={`fixed inset-y-0 left-0 z-[var(--z-modal)] w-[min(86vw,280px)] overflow-hidden shadow-lg transition-transform duration-200 ease-[var(--ease-standard)] motion-reduce:transition-none md:static md:z-auto md:w-auto md:shadow-none ${
          isSidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        }`}
      >
        <SessionSidebar
          archive={{ onArchive: sessionList.archiveSession, busyId: sessionList.busySessionId }}
          projects={projects}
          onAddToProject={addSessionToProject}
          list={{
            sessions: sessionList.search?.trim()
              ? displaySessions.filter((session) => sessionList.sidebarSessions.some((row) => row.sessionId === session.sessionId))
              : displaySessions,
            search: sessionList.search,
            onSearch: sessionList.setSearch,
            hasMore: sessionList.hasMore,
            isLoadingMore: sessionList.isLoadingMore,
            onLoadMore: sessionList.loadMore,
            error: sessionList.listError,
            onRetry: sessionList.retry,
            selectedId: sessionList.selectedSessionId,
            isLoading: sessionList.isLoadingSessions || sessionList.isSearching,
            streamingIds: streamingSessionIds,
            errorId: hasTurnFailed ? sessionList.selectedSessionId : null,
            attentionIds: attentionSessionIds,
            onSelect: selectSession,
            onCreate: sessionList.createSession,
            isCreating: sessionList.isCreatingSession
          }}
          rename={{
            busyId: sessionList.busySessionId,
            sessionId: sessionList.renameSessionId,
            renameDraft: sessionList.renameDraft,
            onStartRename: sessionList.startRename,
            onCancelRename: sessionList.cancelRename,
            onConfirmRename: sessionList.confirmRename,
            onRenameDraftChange: sessionList.setRenameDraft
          }}
          deletion={{
            busyId: sessionList.busySessionId,
            pendingId: sessionList.pendingDeleteSessionId,
            trashRetentionDays: sessionList.trashRetentionDays,
            onRequest: sessionList.deleteSession,
            onConfirmDelete: sessionList.confirmDelete,
            onCancelDelete: sessionList.cancelDelete
          }}
          pinning={{
            busyId: sessionList.busySessionId,
            ids: sessionList.pinnedSessionIds,
            onToggle: sessionList.togglePinSession
          }}
        />
      </div>

      <main className="flex min-h-0 min-w-0 flex-col">
        <WorkspaceHeader
          projectId={selectedDisplaySession?.projectId}
          sessionActions={selectedDisplaySession ? {
            sessionId: selectedDisplaySession.sessionId,
            sessionName: selectedDisplaySession.sessionName,
            isPinned: sessionList.pinnedSessionIds.has(selectedDisplaySession.sessionId),
            busy: sessionList.busySessionId === selectedDisplaySession.sessionId,
            isRunning: streamingSessionIds.has(selectedDisplaySession.sessionId) || Boolean(selectedDisplaySession.isRunning),
            hasPendingApprovals: attentionSessionIds.has(selectedDisplaySession.sessionId),
            onTogglePin: () => sessionList.togglePinSession(selectedDisplaySession.sessionId),
            onRename: selectedDisplaySession.canEdit === false ? undefined : () => sessionList.renameSessionDirect(selectedDisplaySession.sessionId, selectedDisplaySession.sessionName),
            onArchive: selectedDisplaySession.canEdit === false ? undefined : () => sessionList.archiveSession(selectedDisplaySession.sessionId),
            onDelete: selectedDisplaySession.canEdit === false ? undefined : () => sessionList.deleteSession(selectedDisplaySession.sessionId)
          } : undefined}
          menuLinks={[
            { href: "/artifacts", label: "Artifacts", description: "Browse files across all sessions" },
            { href: "/settings", label: "Settings", description: "User preferences and jobs" },
            { href: "/admin", label: "Admin", description: "Platform controls and rollout" }
          ]}
          sessionStatus={selectedDisplaySession ? resolveSessionStatus({
            pendingApproval: attentionSessionIds.has(selectedDisplaySession.sessionId),
            failed: hasTurnFailed,
            running: streamingSessionIds.has(selectedDisplaySession.sessionId)
          }) : undefined}
          activeTurnStartedAt={selectedDisplaySession?.activeTurnStartedAt}
          completedTurn={latestCompletedTurn(messages, selectedDisplaySession, liveResolution?.applied ? turnActivity : null)}
          title={sessionList.selectedSession?.sessionName ?? "Select a session"}
          isArtifactPaneOpen={isArtifactPaneOpen}
          onToggleArtifactPane={sessionList.selectedSession ? () => setIsArtifactPaneOpen((v) => !v) : undefined}
          isSidebarOpen={isSidebarOpen}
          onToggleSidebar={() => setIsSidebarOpen((v) => !v)}
          onCopySession={sessionList.selectedSession ? formatSessionForClipboardCallback : undefined}
          onRenameSession={
            sessionList.selectedSession
              ? (next) => sessionList.renameSessionDirect(sessionList.selectedSession!.sessionId, next)
              : undefined
          }
          hasPendingApprovals={liveApprovalCount > 0}
        />

        {sessionList.error || modelError || chatWorkspace.loadError ? (
          <div role="alert" className="shrink-0 border-b border-outline-variant bg-danger-surface px-4 py-3 text-sm text-danger">
            {sessionList.error ?? modelError ?? chatWorkspace.loadError}
          </div>
        ) : null}

        <div
          ref={chatMainRef}
          className={`grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)] ${
            isResizingPane
              ? ""
              : "transition-[grid-template-columns] duration-200 ease-[var(--ease-standard)] motion-reduce:transition-none"
          } ${chatColClass}`}
          style={
            hasSession
              ? ({ ["--artifact-pane-width" as string]: `${artifactPaneWidth}px` } as CSSProperties)
              : undefined
          }
        >
          <div className="flex min-h-0 min-w-0 flex-col">
            {noModelsAvailable ? (
              <section className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-surface px-6 py-4">
                <div className="mx-auto flex w-[min(640px,100%)] flex-col items-center gap-4 rounded-xl border border-outline-variant bg-surface-container-lowest px-8 py-12 text-center shadow-sm">
                  <h2 className="text-xl font-semibold text-on-surface">
                    No models are available
                  </h2>
                  {/* AuthGuard sends a member straight back here from
                      /admin/models, so offering them the link is a
                      redirect loop. `noModelsAvailable` does not narrow
                      `user` for TypeScript, hence the optional chain. */}
                  {user?.role === "admin" || user?.role === "owner" ? (
                    <>
                      <p className="max-w-md text-sm text-on-surface-variant">
                        Set up provider credentials and enable at least one model in Models
                        to start a conversation.
                      </p>
                      <a
                        href="/admin/models"
                        className="inline-flex items-center rounded-md border border-outline-variant bg-surface px-4 py-2 text-sm font-medium text-on-surface transition-colors hover:bg-surface-container"
                      >
                        Open Models
                      </a>
                    </>
                  ) : (
                    <p className="max-w-md text-sm text-on-surface-variant">
                      Ask an administrator to check provider credentials and enable a model for
                      your organization.
                    </p>
                  )}
                </div>
              </section>
            ) : selectedRawSession && selectedRawSession.transcriptFormat !== "current" ? (
              // The chat reopens only sessions in the current history format.
              <TranscriptFormatNotice
                format={selectedRawSession.transcriptFormat}
                isCreating={sessionList.isCreatingSession}
                onNewSession={() => {
                  void sessionList.createSession(selectedRawSession.canEdit === false ? null : projectId).catch(() => {});
                }}
              />
            ) : sessionList.selectedSessionId && chatWorkspace.isSessionDataReady ? (
              <CopilotChatHost
                // Key on session so switching sessions remounts the host. The
                // new host connects and loads that session's history.
                key={sessionList.selectedSessionId}
                session={{
                  id: sessionList.selectedSessionId,
                  initialToolStatuses,
                  initialMcpApps,
                  initialApprovals: chatWorkspace.initialApprovals,
                  initialNotices,
                  isRunning: selectedIsServerRunning,
                  canEdit: selectedDisplaySession?.canEdit !== false,
                  initialPrompt: resolveDraftIntent?.sessionId === sessionId && projectId
                    ? `Resolve the selected project draft conflict. The selected draft ID is ${resolveDraftIntent.draftId}. First call project_get_conflict_context with that draft ID and compare the base, latest published, and proposed text. If the intended merge is clear, call project_reconcile_conflict with the same draft ID and the merged text. If it is ambiguous, explain the alternatives and do not write a draft. Never promote, delete, or change folders.`
                    : undefined
                }}
                modelSelection={{
                  model,
                  effort,
                  models: allModels,
                  showEffortSelector,
                  onModelChange: setModel,
                  onEffortChange: setEffort
                }}
                usage={{ contextTokens, contextWindow, sessionCostUsd: sessionCost }}
                artifactIds={chatWorkspace.artifactState.visibleSelectedArtifactIds}
                projectFileIds={confirmedProjectFileIds}
                events={{
                  onInitialPromptSent: () => setResolveDraftIntent(null),
                  onTurnSettled: () => {
                    setIsReloadingAfterTurn(true);
                    void sessionList.reload().finally(() => setIsReloadingAfterTurn(false));
                    if (projectId) void queryClient.invalidateQueries({ queryKey: queryKeys.projects.library(projectId) });
                    // CopilotKit owns the live stream, so persisted state (token
                    // usage, cost) only lands via a REST reload once a turn ends.
                    if (sessionList.selectedSessionId) {
                      void chatWorkspace.refreshSessionData(sessionList.selectedSessionId).catch(() => {
                        // The session query exposes this failure in the workspace banner.
                      });
                    }
                  },
                  onTurnActivityChange: setTurnActivity,
                  onTurnRunningChange: setTurnRunning,
                  onPendingApprovalsChange: setLiveApprovalCount
                }}
              />
            ) : null}
          </div>

          {hasSession ? (
            <>
              {showArtifactPane ? (
                <button
                  type="button"
                  aria-label="Close artifacts panel"
                  className="fixed inset-0 z-[var(--z-modal-backdrop)] bg-primary/25 backdrop-blur-[2px] md:hidden"
                  onClick={() => setIsArtifactPaneOpen(false)}
                />
              ) : null}
              <button
                aria-label="Resize context panel"
                aria-hidden={!showArtifactPane}
                tabIndex={showArtifactPane ? undefined : -1}
                className="group relative hidden w-full cursor-col-resize bg-transparent transition-colors hover:bg-outline-variant focus-visible:bg-primary-mid focus-visible:outline-none md:block"
                onPointerDown={startArtifactPaneResize}
                type="button"
              />
              <aside
                // inert removes the collapsed pane from tab order + a11y tree
                // while it stays mounted for the width animation.
                inert={!showArtifactPane}
                className={`fixed inset-y-0 right-0 z-[var(--z-modal)] flex w-[min(92vw,420px)] min-w-0 flex-col overflow-hidden bg-surface-container-low shadow-lg transition-transform duration-200 ease-[var(--ease-standard)] motion-reduce:transition-none md:static md:z-auto md:w-auto md:shadow-none ${
                  showArtifactPane ? "translate-x-0" : "translate-x-full md:translate-x-0"
                }`}
              >
                {projectId ? (
                  <ProjectFileSelection
                    key={projectId}
                    projectId={projectId}
                    selectedIds={selectedProjectFileIds}
                    selectedEntries={selectionQuery.data?.items ?? []}
                    unavailableCount={unavailableSelections.projectId === projectId ? unavailableSelections.count : 0}
                    checkingCount={checkingProjectFileCount}
                    lookupFailed={selectionQuery.isError}
                    // A failed refetch keeps the last result, and a turn still sends those files.
                    lookupKeptLastCheck={selectionQuery.data !== undefined}
                    onRetryLookup={() => void selectionQuery.refetch()}
                    onToggle={(fileId) => {
                      setUnavailableSelections({ projectId: null, count: 0 });
                      setSelectedProjectFiles((current) => {
                        const ids = current.projectId === projectId ? current.ids : [];
                        if (ids.includes(fileId)) {
                          return { projectId, ids: ids.filter((id) => id !== fileId) };
                        }
                        if (ids.length >= MAX_PROJECT_FILE_SELECTIONS) return current;
                        return { projectId, ids: [...ids, fileId] };
                      });
                    }}
                  />
                ) : null}
                <ArtifactPanel
                  inventory={{
                    artifacts: chatWorkspace.artifacts
                  }}
                  selection={{
                    visibleSelectedArtifactIds: chatWorkspace.artifactState.visibleSelectedArtifactIds,
                    onToggle: chatWorkspace.artifactState.toggleArtifactSelection
                  }}
                  transfers={{
                    isUploading: chatWorkspace.artifactState.isUploadingArtifact,
                    downloadingId: chatWorkspace.artifactState.downloadArtifactId,
                    onUpload: (file) => void chatWorkspace.artifactState.handleUploadArtifact(file),
                    onDownload: (id) => void chatWorkspace.artifactState.handleDownloadArtifact(id)
                  }}
                  preview={{
                    artifactId: chatWorkspace.artifactState.previewArtifactId,
                    isLoading: chatWorkspace.artifactState.isLoadingPreview,
                    onOpen: (id) => void chatWorkspace.artifactState.openPreview(id)
                  }}
                  sources={{
                    sessionId: sessionList.selectedSessionId,
                    items: fileSources.sources,
                    onOpen: (sourceId) => setActiveFileSourceId(sourceId)
                  }}
                />
              </aside>
            </>
          ) : null}
        </div>
      </main>

      <FileSourcePicker
        activeSourceId={activeFileSourceId}
        isOpen={activeFileSourceId !== null}
        onClose={() => setActiveFileSourceId(null)}
        onSelectSource={(sourceId) => setActiveFileSourceId(sourceId)}
        selectedSessionId={sessionList.selectedSessionId}
        sources={fileSources.sources}
      />

      {chatWorkspace.artifactState.previewArtifactId && (
        <ArtifactPreviewModal
          artifactName={chatWorkspace.artifactState.previewName}
          mimeType={chatWorkspace.artifactState.previewMimeType}
          content={chatWorkspace.artifactState.previewContent}
          imageUrl={chatWorkspace.artifactState.previewImageUrl}
          error={chatWorkspace.artifactState.previewError}
          onClose={chatWorkspace.artifactState.closePreview}
        />
      )}
    </div>
  );
}
