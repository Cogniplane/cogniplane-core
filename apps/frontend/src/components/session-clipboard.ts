import type { Message } from "@cogniplane/shared-types";

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
