"use client";

import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
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

import { SessionSidebar } from "./session-sidebar";
import { ArtifactPanel } from "./artifact-panel";
import { ArtifactPreviewModal } from "./artifact-preview-modal";
import { FileSourcePicker } from "./file-source-picker";
import { WorkspaceHeader } from "./workspace-header";

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

export function ChatShell() {
  const { isLoading: authIsLoading, user } = useAuth();
  const sessionList = useSessionList({ enabled: Boolean(user) });
  const { setError: setSessionListError } = sessionList;
  const chatMainRef = useRef<HTMLDivElement | null>(null);
  const modelsQuery = useQuery({
    queryKey: queryKeys.models.list(),
    queryFn: fetchModels,
    enabled: !authIsLoading && Boolean(user)
  });
  const allModels = modelsQuery.data?.models ?? [];
  const showEffortSelector = modelsQuery.data?.showEffortSelector ?? false;
  // An empty models list after a successful fetch means no provider key is
  // configured — render the "configure a model provider key" empty state.
  const noProvidersAvailable =
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
  const [liveIsRunning, setLiveIsRunning] = useState(false);
  const [liveApprovalCount, setLiveApprovalCount] = useState(0);
  const [signalSessionId, setSignalSessionId] = useState(sessionList.selectedSessionId);

  const selectSession = useCallback(
    (sessionId: string) => {
      sessionList.selectSession(sessionId);
      if (window.matchMedia("(max-width: 767px)").matches) setIsSidebarOpen(false);
    },
    [sessionList]
  );

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

  // Surface model-fetch failures into the session-list error banner. React
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

  const attentionSessionIds = useMemo(
    () => deriveAttentionSessionIds(
      sessionList.sessions,
      sessionList.selectedSessionId,
      liveApprovalCount
    ),
    [sessionList.sessions, sessionList.selectedSessionId, liveApprovalCount]
  );

  // Only the selected session has a live host, so it's the only one that can be
  // streaming — map the lifted boolean onto its id (the faithful replacement for
  // the retired SSE streamingSessionId).
  const streamingSessionIds = useMemo(
    () =>
      deriveStreamingSessionIds(
        sessionList.sessions,
        liveIsRunning ? sessionList.selectedSessionId : null
      ),
    [sessionList.sessions, liveIsRunning, sessionList.selectedSessionId]
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
          list={{
            sessions: sessionList.sessions,
            selectedId: sessionList.selectedSessionId,
            isLoading: sessionList.isLoadingSessions,
            streamingIds: streamingSessionIds,
            errorId: sessionList.error ? sessionList.selectedSessionId : null,
            attentionIds: attentionSessionIds,
            onSelect: selectSession,
            onCreate: sessionList.createSession
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
          menuLinks={[
            { href: "/artifacts", label: "Artifacts", description: "Browse files across all sessions" },
            { href: "/settings", label: "Settings", description: "User preferences and jobs" },
            { href: "/admin", label: "Admin", description: "Platform controls and rollout" }
          ]}
          statusLabel={sessionList.selectedSession ? "Runtime ready" : undefined}
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
            {noProvidersAvailable ? (
              <section className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-surface px-6 py-4">
                <div className="mx-auto flex w-[min(640px,100%)] flex-col items-center gap-4 rounded-xl border border-outline-variant bg-surface-container-lowest px-8 py-12 text-center shadow-sm">
                  <h2 className="text-xl font-semibold text-on-surface">
                    No model provider is available
                  </h2>
                  {/* AuthGuard sends a member straight back here from
                      /admin/organization, so offering them the link is a
                      redirect loop. `noProvidersAvailable` does not narrow
                      `user` for TypeScript, hence the optional chain. */}
                  {user?.role === "admin" || user?.role === "owner" ? (
                    <>
                      <p className="max-w-md text-sm text-on-surface-variant">
                        Add an API key and enable a runtime provider before you can start a
                        conversation.
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
                      An administrator needs to add an API key and enable a runtime provider before
                      you can start a conversation.
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
                  initialApprovals: chatWorkspace.initialApprovals
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
                events={{
                  onTurnSettled: () => {
                    // CopilotKit owns the live stream, so persisted state (token
                    // usage, cost) only lands via a REST reload once a turn ends.
                    if (sessionList.selectedSessionId) {
                      void chatWorkspace.refreshSessionData(sessionList.selectedSessionId);
                    }
                  },
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
