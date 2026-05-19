import type { RuntimeProvider } from "@cogniplane/shared-types";

export function providerLabel(provider: RuntimeProvider): string {
  return provider === "claude-code" ? "Claude" : "Codex";
}

export function canSubmitDraft(
  selectedSessionId: string | null,
  draft: string
): boolean {
  return Boolean(selectedSessionId) && draft.trim().length > 0;
}

export function canSubmitDraftViaKeyboard(
  selectedSessionId: string | null,
  isSending: boolean,
  draft: string
): boolean {
  return canSubmitDraft(selectedSessionId, draft) && !isSending;
}

export function shouldConfirmProviderChange(
  currentProvider: RuntimeProvider,
  nextProvider: RuntimeProvider,
  selectedSessionId: string | null,
  hasConversationHistory: boolean
): boolean {
  if (nextProvider === currentProvider) return false;
  return Boolean(selectedSessionId) && hasConversationHistory;
}
