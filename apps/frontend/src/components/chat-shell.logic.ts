import type { Message, Model, RuntimeProvider, Session } from "@cogniplane/shared-types";

export const ARTIFACT_PANE_WIDTH = {
  default: 380,
  min: 320,
  max: 620
} as const;

export function modelFallbackForProvider(
  provider: RuntimeProvider,
  models: Model[],
  currentModel: string
): string | null {
  const providerModels = models.filter((model) => model.provider === provider);
  if (providerModels.some((model) => model.id === currentModel)) {
    return currentModel;
  }
  return providerModels.find((model) => model.isDefault)?.id ?? providerModels[0]?.id ?? null;
}

export function sortDisplayModels(
  allModels: Model[],
  enabledProviders: RuntimeProvider[],
  defaultProvider: RuntimeProvider
): Model[] {
  const filtered = allModels.filter((m) => enabledProviders.includes(m.provider));
  return [...filtered].sort((left, right) => {
    if (left.provider === right.provider) return 0;
    if (left.provider === defaultProvider) return -1;
    if (right.provider === defaultProvider) return 1;
    return 0;
  });
}

export function deriveAttentionSessionIds(
  sessions: Session[],
  selectedSessionId: string | null,
  pendingApprovalCount: number
): Set<string> {
  const set = new Set<string>();
  for (const session of sessions) {
    if (session.hasPendingApprovals) set.add(session.sessionId);
  }
  if (selectedSessionId) {
    if (pendingApprovalCount > 0) {
      set.add(selectedSessionId);
    } else {
      set.delete(selectedSessionId);
    }
  }
  return set;
}

export function deriveStreamingSessionIds(
  sessions: Session[],
  inFlightStreamingSessionId: string | null
): Set<string> {
  const set = new Set<string>();
  for (const session of sessions) {
    if (session.isRunning) set.add(session.sessionId);
  }
  if (inFlightStreamingSessionId) {
    set.add(inFlightStreamingSessionId);
  }
  return set;
}

export function messagesContainHistory(messages: Message[]): boolean {
  return messages.some((message) => message.role !== "system" && message.content.trim().length > 0);
}

export function clampArtifactPaneWidth(rectRight: number, clientX: number): number {
  return Math.max(
    ARTIFACT_PANE_WIDTH.min,
    Math.min(ARTIFACT_PANE_WIDTH.max, rectRight - clientX)
  );
}

export function readStoredArtifactPaneWidth(value: string | null): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < ARTIFACT_PANE_WIDTH.min || parsed > ARTIFACT_PANE_WIDTH.max) return null;
  return parsed;
}

export function formatSessionForClipboard(messages: Message[]): string | undefined {
  if (!messages.length) return undefined;
  return messages
    .filter((m) => m.status === "completed" || m.status === "streaming")
    .map((m) => {
      const label = m.role === "user" ? "You" : "Agent";
      return `${label}:\n${m.content}`;
    })
    .join("\n\n---\n\n");
}
