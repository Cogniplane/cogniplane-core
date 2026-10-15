import { MCP_APP_MESSAGE_MAX_CHARS } from "@cogniplane/shared-types";

export type AppMessageCheck =
  | { ok: true; text: string }
  | { ok: false; reason: "unavailable" | "unsupported" }
  | { ok: false; reason: "too-long"; length: number };

/** Checks a `ui/message` request from a tool view. An accepted message is one
 *  user text block. It goes to the message box as a draft, never to the agent. */
export function checkAppUserMessage(
  role: unknown,
  content: unknown,
  canEdit: boolean,
  busy: boolean
): AppMessageCheck {
  if (!canEdit || busy) return { ok: false, reason: "unavailable" };
  if (role !== "user" || !Array.isArray(content) || content.length !== 1) return { ok: false, reason: "unsupported" };
  const block = content[0];
  if (!block || block.type !== "text" || typeof block.text !== "string" || !block.text.trim()) {
    return { ok: false, reason: "unsupported" };
  }
  if (block.text.length > MCP_APP_MESSAGE_MAX_CHARS) return { ok: false, reason: "too-long", length: block.text.length };
  return { ok: true, text: block.text };
}

/** The visible error for a message that the chat refused. Only a message that
 *  is too long needs one. Another refusal means a read-only or busy chat, or a
 *  message that is not plain text. */
export function refusedMessageText(check: AppMessageCheck): string | null {
  if (check.ok || check.reason !== "too-long") return null;
  return `A tool view tried to send a message of ${check.length.toLocaleString("en-US")} characters. ` +
    `The limit is ${MCP_APP_MESSAGE_MAX_CHARS.toLocaleString("en-US")} characters, so the chat did not accept it.`;
}
