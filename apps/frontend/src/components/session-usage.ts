import type { Message, Model } from "@cogniplane/shared-types";

// The most recent assistant turn's total token count approximates how much of
// the context window the runtime is currently carrying — that's the number the
// composer's context meter shows. 0 when no assistant turn has reported usage.
export function latestContextTokens(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const usage = messages[index]?.tokenUsage;
    if (usage) return usage.totalTokens;
  }
  return 0;
}

// The context-window size of the currently selected model. When the model
// record is unresolved we fall back to 200K — the smallest real window — so the
// meter errs toward showing context pressure rather than hiding it.
export function contextWindowForModel(model: Model | null | undefined): number {
  return model?.contextWindow ?? 200_000;
}

// Total spend across every assistant turn in the session, summed from the
// per-message costUsd the backend persists. 0 when nothing has cost yet.
export function sessionCostUsd(messages: Message[]): number {
  let total = 0;
  for (const message of messages) {
    if (message.costUsd) total += message.costUsd;
  }
  return total;
}
