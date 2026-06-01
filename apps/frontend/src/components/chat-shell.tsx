"use client";

import { useQuery } from "@tanstack/react-query";
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
import { McpServerErrorBanner } from "./mcp-server-error-banner";
import { MessageList } from "./message-list";
import { Composer } from "./composer";
import { WorkspaceHeader } from "./workspace-header";
import {
  ARTIFACT_PANE_WIDTH,
  clampArtifactPaneWidth,
  deriveAttentionSessionIds,
  deriveStreamingSessionIds,
  formatSessionForClipboard,
  messagesContainHistory,
  modelFallbackForProvider,
  readStoredArtifactPaneWidth,
  sortDisplayModels
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
  const enabledRuntimeProviders = modelsQuery.data?.enabledRuntimeProviders ?? ["codex"];
  const defaultRuntimeProvider = modelsQuery.data?.defaultRuntimeProvider ?? "codex";
  const showEffortSelector = modelsQuery.data?.showEffortSelector ?? false;
  const noProvidersAvailable =
    Boolean(user) && !modelsQuery.isLoading && enabledRuntimeProviders.length === 0;
  const [isArtifactPaneOpen, setIsArtifactPaneOpen] = useState(true);
  const [activeFileSourceId, setActiveFileSourceId] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [artifactPaneWidth, setArtifactPaneWidth] = useState<number>(ARTIFACT_PANE_WIDTH.default);

  const displayModels = sortDisplayModels(allModels, enabledRuntimeProviders, defaultRuntimeProvider);
  const fallbackModels = displayModels.length > 0 ? displayModels : allModels;

  const { model, setModel } = useModelPreference(fallbackModels);
  const selectedProvider = displayModels.find((entry) => entry.id === model)?.provider
    ?? fallbackModels.find((entry) => entry.id === model)?.provider
    ?? defaultRuntimeProvider;
  const selectedModel = displayModels.find((entry) => entry.id === model)
    ?? fallbackModels.find((entry) => entry.id === model)
    ?? null;
  const { effort, setEffort } = useEffortPreference(selectedModel, showEffortSelector);

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

  const onError = useCallback(
    (message: string) => setSessionListError(message),
    [setSessionListError]
  );

  const chatWorkspace = useChatWorkspace({
    selectedSessionId: sessionList.selectedSessionId,
    model,
    effort: effort ?? undefined,
    onError
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
  }, [sessionList.selectedSessionId]);

  const fileSources = useFileSources({
    selectedSessionId: sessionList.selectedSessionId,
    onError,
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
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, []);

  const attentionSessionIds = useMemo(
    () => deriveAttentionSessionIds(
      sessionList.sessions,
      sessionList.selectedSessionId,
      chatWorkspace.pendingApprovals.length
    ),
    [sessionList.sessions, sessionList.selectedSessionId, chatWorkspace.pendingApprovals]
  );

  const streamingSessionIds = useMemo(
    () => deriveStreamingSessionIds(sessionList.sessions, chatWorkspace.streamingSessionId),
    [sessionList.sessions, chatWorkspace.streamingSessionId]
  );

  const hasConversationHistory = messagesContainHistory(chatWorkspace.messages);

  const sidebarColClass = isSidebarOpen ? "grid-cols-[280px_minmax(0,1fr)]" : "grid-cols-[0_minmax(0,1fr)]";
  const showArtifactPane = Boolean(sessionList.selectedSession) && isArtifactPaneOpen;

  return (
    <div className={`grid h-screen transition-[grid-template-columns] duration-200 ${sidebarColClass}`}>
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
        onSelectSession={sessionList.selectSession}
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
          hasPendingApprovals={chatWorkspace.pendingApprovals.length > 0}
        />

        <div
          ref={chatMainRef}
          className={`grid min-h-0 min-w-0 flex-1 ${
            showArtifactPane
              ? "grid-cols-[minmax(0,1fr)_4px_var(--artifact-pane-width)]"
              : "grid-cols-[minmax(0,1fr)]"
          }`}
          style={
            showArtifactPane
              ? ({ ["--artifact-pane-width" as string]: `${artifactPaneWidth}px` } as CSSProperties)
              : undefined
          }
        >
          <div className="flex min-h-0 min-w-0 flex-col">
            <McpServerErrorBanner
              errors={chatWorkspace.mcpServerErrors}
              onDismiss={(name) => chatWorkspace.dismissMcpServerError(name)}
            />

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
            ) : (
              <>
                <MessageList
                  messages={chatWorkspace.messages}
                  pendingApprovals={chatWorkspace.pendingApprovals}
                  approvalDecisionId={chatWorkspace.approvalDecisionId}
                  mcpServerEvents={chatWorkspace.mcpServerErrors}
                  runtimeNotices={chatWorkspace.runtimeNotices}
                  onApprovalDecision={(id, decision) => void chatWorkspace.handleApprovalDecision(id, decision)}
                  onPreviewArtifact={(id) => void chatWorkspace.artifactState.openPreview(id)}
                  onRetry={chatWorkspace.retryLastMessage}
                  onSend={(text) => void chatWorkspace.sendMessage(text)}
                  ref={messagesRef}
                  selectedSessionId={sessionList.selectedSessionId}
                />

                <Composer
              selectedSessionId={sessionList.selectedSessionId}
              isSending={chatWorkspace.isSending}
              error={sessionList.error}
              onSend={(text) => void chatWorkspace.sendMessage(text)}
              onStop={() => void chatWorkspace.stopStreaming()}
              provider={selectedProvider}
              enabledProviders={enabledRuntimeProviders}
              model={model}
              effort={effort}
              models={displayModels}
              showEffortSelector={showEffortSelector}
              hasConversationHistory={hasConversationHistory}
              onProviderChange={(provider) => {
                const nextModel = modelFallbackForProvider(provider, displayModels, model);
                if (nextModel) setModel(nextModel);
              }}
              onModelChange={setModel}
              onEffortChange={setEffort}
            />
              </>
            )}
          </div>

          {showArtifactPane ? (
            <>
              <button
                aria-label="Resize context panel"
                className="group relative w-1 cursor-col-resize bg-transparent transition-colors hover:bg-outline-variant focus-visible:bg-primary-mid focus-visible:outline-none"
                onPointerDown={startArtifactPaneResize}
                type="button"
              />
              <aside className="flex min-h-0 min-w-0 flex-col bg-surface-container-low">
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
