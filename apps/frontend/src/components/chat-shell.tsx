"use client";

import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useSessionList } from "../hooks/use-session-list";
import { useChatWorkspace } from "../hooks/use-chat-workspace";
import { useAutoScroll } from "../hooks/use-auto-scroll";
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
  ARTIFACT_PANE_WIDTH,
  clampArtifactPaneWidth,
  contextWindowForModel,
  deriveAttentionSessionIds,
  deriveStreamingSessionIds,
  formatSessionForClipboard,
  latestContextTokens,
  planStateFromMessages,
  readStoredArtifactPaneWidth,
  sessionCostUsd,
  toAguiInitialMessages,
  toolStatusesFromMessages
} from "./chat-shell.logic";

export function ChatShell() {
  const { isLoading: authIsLoading, user } = useAuth();
  const sessionList = useSessionList({ enabled: Boolean(user) });
  const { setError: setSessionListError } = sessionList;
  const messagesRef = useRef<HTMLElement | null>(null);
  const chatMainRef = useRef<HTMLDivElement | null>(null);
  const modelsQuery = useQuery({
    queryKey: queryKeys.models.list(),
    queryFn: fetchModels,
    enabled: !authIsLoading && Boolean(user)
  });
  // Fall back to the same defaults the four useStates used before so first-paint
  // (pre-fetch) and post-fetch shapes stay identical for the downstream effects.
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

  const { messages } = chatWorkspace;

  useAutoScroll(messagesRef, [messages], sessionList.selectedSessionId);

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
    // The host remounts per session (keyed), but its mount won't push these back
    // to zero — clear the lifted live signals so a prior session's running /
    // approval state doesn't bleed into the newly selected one.
    setLiveIsRunning(false);
    setLiveApprovalCount(0);
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

  // Approvals pending on the ACTIVE session come live from the AG-UI stream
  // (liveApprovalCount); the REST snapshot (pendingApprovals) still covers other
  // sessions' approvals seen at load/refresh. OR them so the active session
  // lights up immediately on approval_required, without regressing cross-session
  // attention.
  const activeSessionApprovalCount = Math.max(
    liveApprovalCount,
    chatWorkspace.pendingApprovals.length
  );

  const attentionSessionIds = useMemo(
    () => deriveAttentionSessionIds(
      sessionList.sessions,
      sessionList.selectedSessionId,
      activeSessionApprovalCount
    ),
    [sessionList.sessions, sessionList.selectedSessionId, activeSessionApprovalCount]
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
          sessions={sessionList.sessions}
          selectedSessionId={sessionList.selectedSessionId}
          isLoadingSessions={sessionList.isLoadingSessions}
          busySessionId={sessionList.busySessionId}
          streamingSessionIds={streamingSessionIds}
          errorSessionId={sessionList.error ? sessionList.selectedSessionId : null}
          renameSessionId={sessionList.renameSessionId}
          renameDraft={sessionList.renameDraft}
          pinnedSessionIds={sessionList.pinnedSessionIds}
          attentionSessionIds={attentionSessionIds}
          onSelectSession={selectSession}
          onCreateSession={sessionList.createSession}
          onStartRename={sessionList.startRename}
          onCancelRename={sessionList.cancelRename}
          onConfirmRename={sessionList.confirmRename}
          onRenameDraftChange={sessionList.setRenameDraft}
          onDeleteSession={sessionList.deleteSession}
          onTogglePinSession={sessionList.togglePinSession}
          pendingDeleteSessionId={sessionList.pendingDeleteSessionId}
          onConfirmDelete={sessionList.confirmDelete}
          onCancelDelete={sessionList.cancelDelete}
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
          hasPendingApprovals={activeSessionApprovalCount > 0}
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
                  <p className="max-w-md text-sm text-on-surface-variant">
                    An administrator needs to add an API key and enable a runtime provider before
                    you can start a conversation.
                  </p>
                  <a
                    href="/admin/organization"
                    className="inline-flex items-center rounded-md border border-outline-variant bg-surface px-4 py-2 text-sm font-medium text-on-surface transition-colors hover:bg-surface-container"
                  >
                    Open admin settings
                  </a>
                </div>
              </section>
            ) : sessionList.selectedSessionId && chatWorkspace.isSessionDataReady ? (
              <CopilotChatHost
                // Key on session so switching sessions remounts the host with
                // that session's history seeded at construction.
                key={sessionList.selectedSessionId}
                sessionId={sessionList.selectedSessionId}
                model={model}
                effort={effort}
                models={allModels}
                showEffortSelector={showEffortSelector}
                contextTokens={contextTokens}
                contextWindow={contextWindow}
                sessionCostUsd={sessionCost}
                initialMessages={initialMessages}
                initialState={initialState}
                initialToolStatuses={initialToolStatuses}
                artifactIds={chatWorkspace.artifactState.visibleSelectedArtifactIds}
                onModelChange={setModel}
                onEffortChange={setEffort}
                onTurnSettled={() => {
                  // CopilotKit owns the live stream, so persisted state (token
                  // usage, cost) only lands via a REST reload once a turn ends.
                  if (sessionList.selectedSessionId) {
                    void chatWorkspace.refreshSessionData(sessionList.selectedSessionId);
                  }
                }}
                onRunningChange={setLiveIsRunning}
                onPendingApprovalsChange={setLiveApprovalCount}
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
                <ArtifactPanel
                  artifacts={chatWorkspace.artifacts}
                  visibleSelectedArtifactIds={chatWorkspace.artifactState.visibleSelectedArtifactIds}
                  isUploadingArtifact={chatWorkspace.artifactState.isUploadingArtifact}
                  downloadArtifactId={chatWorkspace.artifactState.downloadArtifactId}
                  previewArtifactId={chatWorkspace.artifactState.previewArtifactId}
                  isLoadingPreview={chatWorkspace.artifactState.isLoadingPreview}
                  selectedSessionId={sessionList.selectedSessionId}
                  onUpload={(file) => void chatWorkspace.artifactState.handleUploadArtifact(file)}
                  onToggleSelection={chatWorkspace.artifactState.toggleArtifactSelection}
                  onDownload={(id) => void chatWorkspace.artifactState.handleDownloadArtifact(id)}
                  onPreview={(id) => void chatWorkspace.artifactState.openPreview(id)}
                  fileSources={fileSources.sources}
                  onOpenFileSource={(sourceId) => setActiveFileSourceId(sourceId)}
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
