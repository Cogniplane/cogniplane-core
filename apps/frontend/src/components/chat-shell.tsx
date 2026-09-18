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
import { queryKeys } from "../lib/query-keys";
import { listProjects, setProjectSession } from "../lib/project-api";

import { applyLiveTurn, latestCompletedTurn, resolveSessionStatus } from "./session-status.logic";
import type { AguiCustomEvents } from "../lib/agui/use-agui-custom-events";
import { SessionSidebar } from "./session-sidebar";
import { ArtifactPanel } from "./artifact-panel";
import { ArtifactPreviewModal } from "./artifact-preview-modal";
import { FileSourcePicker } from "./file-source-picker";
import { WorkspaceHeader } from "./workspace-header";
import { getProjectLibrary } from "../lib/project-file-api";
import type { ProjectLibrary } from "@cogniplane/shared-types";
import { Input } from "./ui/input";
import { projectFolderPath } from "./project-files.logic";

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
  planStateFromMessages,
  toAguiInitialMessages,
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

const MAX_PROJECT_FILE_SELECTIONS = 20;
const PROJECT_LIBRARY_DISABLED_QUERY_KEY = ["projects", "chat-project-library-disabled"] as const;

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
  const [turnActivity, setTurnActivity] = useState<AguiCustomEvents["turnActivity"]>(null);
  const [liveIsRunning, setLiveIsRunning] = useState(false);
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
  const projectQuery = useQuery({
    queryKey: projectId ? queryKeys.projects.library(projectId) : PROJECT_LIBRARY_DISABLED_QUERY_KEY,
    queryFn: () => getProjectLibrary(projectId!),
    enabled: Boolean(projectId)
  });
  const projectLibrary = projectQuery.data;
  const availableProjectFileIds = useMemo(
    () => new Set(projectLibrary?.files
      .filter((file) => file.trashedAt === null)
      .map((file) => file.fileId) ?? []),
    [projectLibrary]
  );
  const selectedProjectFileIds = useMemo(() => {
    const ids = selectedProjectFiles.projectId === projectId
      ? selectedProjectFiles.ids
      : [];
    return ids
      .filter((fileId) => availableProjectFileIds.has(fileId))
      .slice(0, MAX_PROJECT_FILE_SELECTIONS);
  }, [availableProjectFileIds, projectId, selectedProjectFiles]);

  useEffect(() => {
    if (!resolveDraftId || !projectId || !sessionId || !projectQuery.isSuccess) return;
    // Wait for the library query before consuming the URL intent. This keeps a
    // valid draft from being filtered out while the library is still loading.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConsumedResolveDraftId(resolveDraftId);
    if (availableProjectFileIds.has(resolveDraftId)) {
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
  }, [availableProjectFileIds, projectId, projectQuery.isSuccess, resolveDraftId, selectedProjectFiles.ids, selectedProjectFiles.projectId, sessionId]);

  useEffect(() => {
    if (!resolveDraftIntent || resolveDraftIntent.sessionId === sessionId) return;
    // A session switch remounts the host. Do not let the old session's
    // one-shot intent trigger again if the user returns to it later.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setResolveDraftIntent(null);
  }, [resolveDraftIntent, sessionId]);

  useEffect(() => {
    if (selectedProjectFiles.projectId !== projectId) return;
    const reconciledIds = selectedProjectFiles.ids
      .filter((fileId) => availableProjectFileIds.has(fileId))
      .slice(0, MAX_PROJECT_FILE_SELECTIONS);
    if (reconciledIds.length === selectedProjectFiles.ids.length &&
        reconciledIds.every((fileId, index) => fileId === selectedProjectFiles.ids[index])) return;
    // The query is the source of truth after trash/restore/promotion changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedProjectFiles({ projectId, ids: reconciledIds });
  }, [availableProjectFileIds, projectId, selectedProjectFiles]);

  const selectSession = useCallback(
    (sessionId: string) => {
      sessionList.selectSession(sessionId);
      if (window.matchMedia("(max-width: 767px)").matches) setIsSidebarOpen(false);
    },
    [sessionList]
  );

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

  // Surface model-fetch failures into the workspace error banner. React
  // Query handles the actual fetch, dedup, and refetch-on-focus; this effect
  // only mirrors the latest error onto the UX surface the rest of the shell
  // already uses.
  useEffect(() => {
    if (!modelsQuery.error) return;
    const reason =
      modelsQuery.error instanceof Error ? modelsQuery.error.message : String(modelsQuery.error);
    console.error("Failed to load model list", modelsQuery.error);
    setSessionListError(`Could not load the model list: ${reason}`);
  }, [modelsQuery.error, setSessionListError]);

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
    setLiveIsRunning(false);
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
      liveApprovalCount
    ),
    [displaySessions, sessionList.selectedSessionId, liveApprovalCount]
  );

  // Only the selected session has a live host, so it's the only one that can be
  // streaming — map the lifted boolean onto its id (the faithful replacement for
  // the retired SSE streamingSessionId).
  const streamingSessionIds = useMemo(
    () =>
      deriveStreamingSessionIds(
        displaySessions,
        liveIsRunning ? sessionList.selectedSessionId : null
      ),
    [displaySessions, liveIsRunning, sessionList.selectedSessionId]
  );

  const contextTokens = latestContextTokens(chatWorkspace.messages);
  const contextWindow = contextWindowForModel(selectedModel);
  const sessionCost = sessionCostUsd(chatWorkspace.messages);
  // Seed the CopilotChat transcript with persisted history. Recomputed on
  // message change, but CopilotChatHost only reads it at mount (agent
  // construction), so post-turn refreshes don't reconstruct the live agent.
  const initialMessages = useMemo(
    () => toAguiInitialMessages(chatWorkspace.messages),
    [chatWorkspace.messages]
  );
  // Plan pane rides agent state, not messages; seed it from persisted plan
  // markdown so reload restores it (CopilotChatHost reads both only at mount).
  const initialState = useMemo(
    () => planStateFromMessages(chatWorkspace.messages),
    [chatWorkspace.messages]
  );
  // Failed/declined tool calls the native card can't render as failures; seeded
  // into the tool-status side-channel so a reloaded session shows them. Unlike
  // initialMessages, the hook re-seeds this on session re-key.
  const initialToolStatuses = useMemo(
    () => toolStatusesFromMessages(chatWorkspace.messages),
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
            sessions: displaySessions,
            selectedId: sessionList.selectedSessionId,
            isLoading: sessionList.isLoadingSessions,
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
            hasPendingApprovals: attentionSessionIds.has(selectedDisplaySession.sessionId) || Boolean(selectedDisplaySession.hasPendingApprovals),
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

        {sessionList.error ? (
          <div role="alert" className="shrink-0 border-b border-outline-variant bg-danger-surface px-4 py-3 text-sm text-danger">
            {sessionList.error}
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
                      /admin/organization, so offering them the link is a
                      redirect loop. `noModelsAvailable` does not narrow
                      `user` for TypeScript, hence the optional chain. */}
                  {user?.role === "admin" || user?.role === "owner" ? (
                    <>
                      <p className="max-w-md text-sm text-on-surface-variant">
                        Check provider credentials and enable at least one model in Organization
                        settings to start a conversation.
                      </p>
                      <a
                        href="/admin/organization"
                        className="inline-flex items-center rounded-md border border-outline-variant bg-surface px-4 py-2 text-sm font-medium text-on-surface transition-colors hover:bg-surface-container"
                      >
                        Open admin settings
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
            ) : sessionList.selectedSessionId && chatWorkspace.isSessionDataReady ? (
              <>
              {/* The backend caps a transcript at its newest N messages. Say so
                  explicitly — a clipped history is indistinguishable from a
                  complete one, and there is no load-older flow to reach the rest. */}
              {chatWorkspace.hasMoreMessages ? (
                <div
                  role="status"
                  className="border-b border-outline-variant bg-surface-container-low px-6 py-2 text-center text-xs text-on-surface-variant"
                >
                  Older messages in this session aren&apos;t shown. The most recent history is
                  displayed below.
                </div>
              ) : null}
              <CopilotChatHost
                // Key on session so switching sessions remounts the host with
                // that session's history seeded at construction.
                key={sessionList.selectedSessionId}
                session={{
                  id: sessionList.selectedSessionId,
                  initialMessages,
                  initialState,
                  initialToolStatuses,
                  initialApprovals: chatWorkspace.initialApprovals,
                  canEdit: selectedDisplaySession?.canEdit !== false,
                  initialPrompt: resolveDraftIntent?.sessionId === sessionId && projectId
                    ? "Resolve the selected project draft conflict. First call project_get_conflict_context for the selected draft and compare the base, latest published, and proposed text. If the intended merge is clear, call project_reconcile_conflict with the merged text. If it is ambiguous, explain the alternatives and do not write a draft. Never promote, delete, or change folders."
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
                projectFileIds={selectedProjectFileIds}
                events={{
                  onInitialPromptSent: () => setResolveDraftIntent(null),
                  onTurnSettled: () => {
                    void sessionList.reload();
                    void projectQuery.refetch?.();
                    // CopilotKit owns the live stream, so persisted state (token
                    // usage, cost) only lands via a REST reload once a turn ends.
                    if (sessionList.selectedSessionId) {
                      void chatWorkspace.refreshSessionData(sessionList.selectedSessionId);
                    }
                  },
                  onTurnActivityChange: setTurnActivity,
                  onRunningChange: setLiveIsRunning,
                  onPendingApprovalsChange: setLiveApprovalCount
                }}
              />
              </>
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
                <ProjectFileSelection
                  library={projectLibrary}
                  selectedIds={selectedProjectFileIds}
                  onToggle={(fileId) => setSelectedProjectFiles((current) =>
                    {
                      const validIds = current.projectId === projectId
                        ? current.ids.filter((id) => availableProjectFileIds.has(id))
                        : [];
                      if (validIds.includes(fileId)) {
                        return { projectId, ids: validIds.filter((id) => id !== fileId) };
                      }
                      if (validIds.length >= MAX_PROJECT_FILE_SELECTIONS) return current;
                      return { projectId, ids: [...validIds, fileId] };
                    }
                  )}
                />
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

function ProjectFileSelection({
  library,
  selectedIds,
  onToggle
}: {
  library?: ProjectLibrary;
  selectedIds: string[];
  onToggle: (fileId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const files = library?.files.filter((file) => file.trashedAt === null) ?? [];
    const folders = library?.folders ?? [];
    const grouped = new Map<string, typeof files>();
    for (const file of files) {
      const folder = projectFolderPath(folders, file.folderId);
      const searchable = `${file.name} ${folder}`.toLowerCase();
      if (normalizedQuery && !searchable.includes(normalizedQuery)) continue;
      const group = grouped.get(folder) ?? [];
      group.push(file);
      grouped.set(folder, group);
    }
    return [...grouped.entries()]
      .map(([folder, entries]) => [
        folder,
        entries.sort((a, b) => a.name.localeCompare(b.name) || a.fileId.localeCompare(b.fileId))
      ] as const)
      .sort(([a], [b]) => a.localeCompare(b));
  }, [library, normalizedQuery]);
  if (!library || !library.files.some((file) => file.trashedAt === null)) return null;
  return (
    <section aria-labelledby="project-file-selection-title" className="border-b border-outline-variant p-4">
      <h2 id="project-file-selection-title" className="text-sm font-semibold">Project files</h2>
      <p className="mt-1 text-xs text-on-surface-variant">
        Prioritize up to {MAX_PROJECT_FILE_SELECTIONS} files for this turn. Other published files remain available when they are in the captured snapshot.
      </p>
      <Input
        aria-label="Search project files"
        className="mt-3"
        placeholder="Search project files"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <p className="mt-2 text-xs text-on-surface-variant">
        {selectedIds.length}/{MAX_PROJECT_FILE_SELECTIONS} prioritized
      </p>
      <div className="mt-3 max-h-[min(38vh,22rem)] space-y-4 overflow-y-auto pr-1">
        {groups.map(([folder, entries]) => (
          <section key={folder} aria-label={folder}>
            <h3 className="mb-2 text-xs font-medium text-on-surface-variant">{folder}</h3>
            <div className="space-y-2">
              {entries.map((file) => (
                <label key={file.fileId} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(file.fileId)}
                    onChange={() => onToggle(file.fileId)}
                    disabled={!selectedIds.includes(file.fileId) && selectedIds.length >= MAX_PROJECT_FILE_SELECTIONS}
                    className="mt-0.5"
                  />
                  <span className="min-w-0 break-words">
                    {file.name}{file.kind === "draft" ? " (draft)" : ""}
                  </span>
                </label>
              ))}
            </div>
          </section>
        ))}
        {groups.length === 0 ? (
          <p className="text-sm text-on-surface-variant">No project files match this search.</p>
        ) : null}
      </div>
    </section>
  );
}
