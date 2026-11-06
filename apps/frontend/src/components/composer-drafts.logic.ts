// Composer text is separate from generated-view values. sessionStorage keeps
// it through navigation and reload in this tab, until the tab closes or the
// retention bound removes it. A duplicated tab can copy the initial record;
// later changes never sync between tabs.
import { getDraftStorage, type DraftScope } from "./generative-ui-drafts.logic";
import type { WidgetDraftOrigin } from "./widget-draft";

export const COMPOSER_DRAFT_STORAGE_KEY = "cogniplane:composer-drafts:v1";
export const COMPOSER_DRAFT_MAX_CHARS = 20_000;
export const COMPOSER_DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 8;
const MAX_RECORD_CHARS = 250_000;
export type ComposerOrigin = { source: string; origin: WidgetDraftOrigin };
export type ComposerDraft = {
  text: string;
  written: ComposerOrigin | null;
  // Only an acknowledgement on the sending connection confirms this attempt.
  // After reload, a matching saved message can belong to another attempt.
  pending?: boolean;
};
type Entry = ComposerDraft & { at: number };
type RecordData = { owner: string; sessions: Record<string, Entry> };
export type ComposerPersistence = "ok" | "unavailable";
let clearEpoch = 0;
export const composerClearEpoch = () => clearEpoch;
const owner = (scope: DraftScope) => JSON.stringify([scope.tenantId, scope.userId]);

function read(storage: Storage, scope: DraftScope): RecordData {
  const empty = { owner: owner(scope), sessions: {} };
  try {
    const raw = storage.getItem(COMPOSER_DRAFT_STORAGE_KEY);
    if (!raw || raw.length > MAX_RECORD_CHARS) return empty;
    const data = JSON.parse(raw);
    if (data?.owner !== empty.owner || !data.sessions || typeof data.sessions !== "object") return empty;
    const now = Date.now();
    const sessions = Object.fromEntries(Object.entries(data.sessions).filter(([, value]) => {
      const entry = value as Entry;
      return entry && typeof entry.text === "string" && entry.text.length <= COMPOSER_DRAFT_MAX_CHARS
        && Number.isFinite(entry.at) && entry.at <= now && now - entry.at <= COMPOSER_DRAFT_MAX_AGE_MS
        && (entry.written === null || (typeof entry.written?.source === "string" && entry.written.source.length <= 1000
          && ["app-starter", "tool-view", "generated-view"].includes(entry.written.origin)))
        && (entry.pending === undefined || typeof entry.pending === "boolean");
    })) as Record<string, Entry>;
    return { owner: empty.owner, sessions };
  } catch {
    return empty;
  }
}

export function loadComposerDraft(scope: DraftScope | undefined, sessionId: string): ComposerDraft {
  const storage = getDraftStorage();
  if (!scope || !storage) return { text: "", written: null };
  const { sessions } = read(storage, scope);
  return Object.hasOwn(sessions, sessionId) ? sessions[sessionId]! : { text: "", written: null };
}

export function saveComposerDraft(scope: DraftScope | undefined, sessionId: string, draft: ComposerDraft): ComposerPersistence {
  if (!scope) return "ok";
  const storage = getDraftStorage();
  if (!storage) return draft.text ? "unavailable" : "ok";
  const data = read(storage, scope);
  // Replace the record once per edit. Failed writes remove the old copy so
  // that a sent, discarded or since-edited draft cannot return.
  delete data.sessions[sessionId];
  try {
    if (!draft.text || draft.text.length > COMPOSER_DRAFT_MAX_CHARS) {
      if (Object.keys(data.sessions).length) storage.setItem(COMPOSER_DRAFT_STORAGE_KEY, JSON.stringify(data));
      else storage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
      return draft.text ? "unavailable" : "ok";
    }
    const sessions = Object.fromEntries([
      [sessionId, { ...draft, at: Date.now() }],
      ...Object.entries(data.sessions).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_SESSIONS - 1)
    ]);
    while (JSON.stringify({ owner: data.owner, sessions }).length > MAX_RECORD_CHARS) {
      const oldest = Object.keys(sessions).at(-1);
      if (!oldest || oldest === sessionId) {
        storage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
        return "unavailable";
      }
      delete sessions[oldest];
    }
    storage.setItem(COMPOSER_DRAFT_STORAGE_KEY, JSON.stringify({ owner: data.owner, sessions }));
    return "ok";
  } catch {
    try { storage.removeItem(COMPOSER_DRAFT_STORAGE_KEY); } catch { /* Storage is blocked. Composition stays in memory. */ }
    return "unavailable";
  }
}

export function clearComposerDrafts(): void {
  clearEpoch++;
  try { getDraftStorage()?.removeItem(COMPOSER_DRAFT_STORAGE_KEY); } catch { /* Storage is blocked. */ }
}
