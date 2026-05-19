import type { Message } from "@cogniplane/shared-types";

export const STATUS_LABELS: Record<Message["status"], string> = {
  pending: "Pending",
  streaming: "Streaming",
  completed: "Completed",
  error: "Failed",
  interrupted: "Stopped"
};

export function formatMessageTimestamp(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(iso));
}

export function formatTokenCount(n: number): string {
  if (n < 1_000) return `${Math.round(n)}`;
  if (n < 10_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

export function formatCostUsd(costUsd: number): string {
  if (costUsd < 0.0001) return "<$0.0001";
  if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`;
  return `$${costUsd.toFixed(3)}`;
}

export function shouldShowRetry(messages: Message[], hasOnRetry: boolean): boolean {
  if (!hasOnRetry) return false;
  const last = messages.at(-1);
  return last?.role === "assistant" && last.status === "error";
}

export const PROMPT_SUGGESTIONS: ReadonlyArray<{ tag: string; prompt: string }> = [
  { tag: "Analyze", prompt: "Summarise the files in this session and identify what each one does" },
  { tag: "Test", prompt: "Run the test suite and report any failures with their stack traces" },
  { tag: "Review", prompt: "Review recent changes and write a short summary of what was modified and why" },
  { tag: "Research", prompt: "Gather background on the approach used and point out any risks" }
];
