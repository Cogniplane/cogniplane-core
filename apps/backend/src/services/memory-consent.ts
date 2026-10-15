// Consent rules for saving a long-term memory (tool `memory_save`).
//
// A memory reaches model input on every later turn, so a poisoned write outlives
// the session that made it. The tool therefore never saves on the model's word
// alone. The user approves the exact text first, in every tenant and whatever the
// approval policy says. This module holds the pieces that the runtime adapter
// (the approval card), the MCP gateway (the check) and the tool share, so the
// text the user approves is the text that gets saved.

import { MEMORY_NAME_PATTERN, showNonPrintingCharacters } from "@cogniplane/shared-types";

import { MAX_MEMORY_CONTENT_LENGTH, memoryContentSha256, type MemoryStore } from "./memory-store.js";
import { redactSecrets } from "./redact-secrets.js";

// Shown by the approval card and the memory data message, and by the settings view.
export { showNonPrintingCharacters };

export const MEMORY_SAVE_TOOL = "memory_save";
/** Model-supplied metadata is shown in the approval too, so it stays small. */
export const MAX_MEMORY_METADATA_LENGTH = 2_000;

export type MemorySaveArguments = {
  name: string;
  content: string;
  metadata: Record<string, unknown> | undefined;
};

export type MemorySaveParse =
  | { ok: true; value: MemorySaveArguments }
  | { ok: false; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the arguments of a `memory_save` call the way the tool stores them.
 * The approval card and the write both use this result, so they cannot differ.
 */
export function parseMemorySaveArguments(args: Record<string, unknown>): MemorySaveParse {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) return { ok: false, reason: "name is required." };
  if (!MEMORY_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      reason: "name must be lowercase letters, digits, dashes or underscores, and at most 128 characters."
    };
  }
  const content = typeof args.content === "string" ? args.content : "";
  if (!content.trim()) return { ok: false, reason: "content must not be empty." };
  if (content.length > MAX_MEMORY_CONTENT_LENGTH) {
    return { ok: false, reason: `content must be at most ${MAX_MEMORY_CONTENT_LENGTH} characters.` };
  }
  // A value that is not an object is ignored, as before.
  const metadata = isPlainObject(args.metadata) ? args.metadata : undefined;
  if (metadata && JSON.stringify(metadata).length > MAX_MEMORY_METADATA_LENGTH) {
    return { ok: false, reason: `metadata must be at most ${MAX_MEMORY_METADATA_LENGTH} characters as JSON.` };
  }
  // Credentials do not belong in memory. Memory text is shown in the approval and read
  // by the model on later turns, and the gateway redacts credentials from every tool
  // result, so the agent could not use a saved one anyway.
  if (redactSecrets(content) !== content || (metadata && JSON.stringify(redactSecrets(metadata)) !== JSON.stringify(metadata))) {
    return { ok: false, reason: "the text looks like it holds a credential. Credentials are not saved to memory." };
  }
  return { ok: true, value: { name, content, metadata } };
}

/** What the server records beside the approval, so the write can check it later. */
export type MemorySaveBound = {
  /** Hash of the saved text that the approval showed as replaced, or null when none existed. */
  previousContentSha256: string | null;
};

export function readMemorySaveBound(bound: unknown): MemorySaveBound | null {
  if (!isPlainObject(bound) || !Object.hasOwn(bound, "previousContentSha256")) return null;
  const hash = bound.previousContentSha256;
  if (hash === null) return { previousContentSha256: null };
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash) ? { previousContentSha256: hash } : null;
}

function characters(text: string): string {
  const count = Array.from(text).length;
  return `${count} character${count === 1 ? "" : "s"}`;
}

export type DurableWriteApproval = {
  title: string;
  summary: string;
  bound: MemorySaveBound;
};

/**
 * Builds the approval card for one `memory_save` call: the exact text, the text
 * it replaces, and the hash of that earlier text. Returns the reason when the
 * call is invalid, so the user is not asked about a save that would fail.
 */
export async function prepareMemorySaveApproval(input: {
  memories: Pick<MemoryStore, "get">;
  tenantId: string;
  userId: string;
  args: Record<string, unknown>;
}): Promise<{ ok: true; approval: DurableWriteApproval } | { ok: false; reason: string }> {
  const parsed = parseMemorySaveArguments(input.args);
  if (!parsed.ok) return parsed;
  const { name, content, metadata } = parsed.value;
  const previous = await input.memories.get(input.tenantId, input.userId, name);

  const lines = [
    `Text to save (${characters(content)}):`,
    showNonPrintingCharacters(content)
  ];
  if (previous) {
    lines.push(
      "",
      `This replaces the saved text (${characters(previous.content)}):`,
      // A memory saved before credentials were refused may hold one. It is only replaced, never stored again.
      showNonPrintingCharacters(redactSecrets(previous.content))
    );
  }
  if (metadata && Object.keys(metadata).length > 0) {
    lines.push("", `Extra data from the agent: ${showNonPrintingCharacters(JSON.stringify(metadata))}`);
  }
  lines.push(
    "",
    "The agent can read saved memories in your later chats. You can edit or delete them in Settings, under Memories."
  );
  return {
    ok: true,
    approval: {
      title: `${previous ? "Replace" : "Save"} memory ${JSON.stringify(name)}`,
      summary: lines.join("\n"),
      bound: { previousContentSha256: previous ? memoryContentSha256(previous.content) : null }
    }
  };
}
