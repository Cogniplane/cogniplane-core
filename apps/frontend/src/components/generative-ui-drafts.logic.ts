// Browser-tab drafts of the values that a user types into generated UI. The
// storage rules live here, free of React and of the SDK, so tests can drive
// them directly. generative-ui-drafts.ts connects them to the surface manager.
//
// What is stored. One sessionStorage entry holds, for each chat session, the
// user-owned values of each generated surface, by JSON pointer, with the
// target and a digest of the operations that the surface had when the values
// were saved. The digest is how a later load tells that the surface is the
// same view. sessionStorage ends with the tab, so a value never outlives it.
// The entry names its owner by a hash of the user and tenant ids, so a
// different person never reads it, and no account id sits in storage as text.
//
// Bounds. 8 sessions, 24 surfaces per session, 64 values per surface, 20,000
// characters per text, and 250,000 characters for the whole entry. A value
// over a bound is left out, never cut: half a text is a wrong text.

import { GENERATIVE_UI_PANEL_TARGET } from "@cogniplane/shared-types";

export const DRAFT_STORAGE_KEY = "cogniplane:generative-ui-drafts:v1";

export const MAX_SESSIONS = 8;
export const MAX_SURFACES_PER_SESSION = 24;
export const MAX_VALUES_PER_SURFACE = 64;
export const MAX_TEXT_CHARS = 20_000;
export const MAX_RECORD_CHARS = 250_000;
const MAX_DEPTH = 4;
const MAX_ITEMS = 200;
const MAX_PATH_CHARS = 200;
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
/** The targets that the host mounts. A draft of another target is not kept. */
const DRAFT_TARGETS: ReadonlySet<string> = new Set(["chat", GENERATIVE_UI_PANEL_TARGET]);

export type DraftScope = { userId: string; tenantId: string };
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type SurfaceDraft = {
  target: string;
  /** How many operations the surface had when the values were saved. */
  count: number;
  /** Digest of those operations. */
  digest: string;
  /** The user-owned values, by JSON pointer. */
  values: Record<string, JsonValue>;
};
export type SessionDrafts = { at: number; surfaces: Record<string, SurfaceDraft> };
type DraftRecord = { v: 1; owner: string; sessions: Record<string, SessionDrafts> };

/** How well the tab keeps the edits. */
export type DraftPersistence = "ok" | "unavailable" | "full";

// Every call of clearDrafts ends the sync loops that began before it, so a
// loop that flushes on page unload cannot write the cleared values back.
let clearEpoch = 0;
export const currentClearEpoch = () => clearEpoch;

/** 53-bit string hash (cyrb53). It tells records apart. It is not a secret. */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function ownerKey(scope: DraftScope): string {
  return hashText(`${scope.userId}\u0000${scope.tenantId}`);
}

/** Digest of the first `count` operations of a surface. */
export function digestOperations(operations: readonly unknown[], count: number): string {
  return hashText(JSON.stringify(operations.slice(0, count)));
}

const INVALID = Symbol("invalid");

function cleanValue(value: unknown, depth = 0): JsonValue | typeof INVALID {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : INVALID;
  if (typeof value === "string") return value.length <= MAX_TEXT_CHARS ? value : INVALID;
  if (depth >= MAX_DEPTH) return INVALID;
  if (Array.isArray(value)) {
    if (value.length > MAX_ITEMS) return INVALID;
    const items: JsonValue[] = [];
    for (const item of value) {
      const cleaned = cleanValue(item, depth + 1);
      if (cleaned === INVALID) return INVALID;
      items.push(cleaned);
    }
    return items;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value);
    if (entries.length > MAX_ITEMS) return INVALID;
    const record: { [key: string]: JsonValue } = {};
    for (const [key, item] of entries) {
      if (FORBIDDEN_SEGMENTS.has(key)) return INVALID;
      const cleaned = cleanValue(item, depth + 1);
      if (cleaned === INVALID) return INVALID;
      record[key] = cleaned;
    }
    return record;
  }
  return INVALID;
}

/** An absolute JSON pointer with no segment that could reach a prototype. */
function isSafePath(path: string): boolean {
  return path.startsWith("/") && path.length <= MAX_PATH_CHARS
    && !path.split("/").some((segment) => FORBIDDEN_SEGMENTS.has(segment));
}

/** The values that can be stored: JSON, within the bounds, and at a safe path.
 *  False, 0 and "" stay. `dropped` is true when a bound removed a value. */
export function cleanValues(values: Record<string, unknown>): { values: Record<string, JsonValue>; dropped: boolean } {
  const kept: Record<string, JsonValue> = {};
  let dropped = false;
  for (const [path, value] of Object.entries(values)) {
    const cleaned = isSafePath(path) ? cleanValue(value) : INVALID;
    if (cleaned === INVALID || Object.keys(kept).length >= MAX_VALUES_PER_SURFACE) {
      dropped = true;
      continue;
    }
    kept[path] = cleaned;
  }
  return { values: kept, dropped };
}

export function getDraftStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    // Some browsers throw on access when storage is blocked.
    return null;
  }
}

function isRecordOf(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSurfaceDraft(value: unknown): SurfaceDraft | null {
  if (!isRecordOf(value) || typeof value.target !== "string" || !DRAFT_TARGETS.has(value.target)
    || typeof value.digest !== "string" || typeof value.count !== "number"
    || !Number.isInteger(value.count) || value.count < 1 || !isRecordOf(value.values)) return null;
  const { values } = cleanValues(value.values);
  return Object.keys(values).length === 0 ? null : { target: value.target, count: value.count, digest: value.digest, values };
}

function readSession(value: unknown): SessionDrafts | null {
  if (!isRecordOf(value) || typeof value.at !== "number" || !isRecordOf(value.surfaces)) return null;
  const surfaces: Record<string, SurfaceDraft> = {};
  for (const [surfaceId, draft] of Object.entries(value.surfaces).slice(-MAX_SURFACES_PER_SESSION)) {
    const read = readSurfaceDraft(draft);
    if (read) surfaces[surfaceId] = read;
  }
  return Object.keys(surfaces).length === 0 ? null : { at: value.at, surfaces };
}

/** The stored record of `scope`. A record of another owner, a corrupt one and
 *  one of another format are removed and read as empty. */
function readRecord(storage: Storage, scope: DraftScope): DraftRecord {
  const owner = ownerKey(scope);
  const empty: DraftRecord = { v: 1, owner, sessions: {} };
  let raw: string | null;
  try {
    raw = storage.getItem(DRAFT_STORAGE_KEY);
  } catch {
    return empty;
  }
  if (raw === null) return empty;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecordOf(parsed) && parsed.v === 1 && parsed.owner === owner && isRecordOf(parsed.sessions)) {
      const sessions: Record<string, SessionDrafts> = {};
      for (const [sessionId, session] of Object.entries(parsed.sessions)) {
        const read = readSession(session);
        if (read) sessions[sessionId] = read;
      }
      return { v: 1, owner, sessions };
    }
  } catch {
    // Corrupt JSON falls through to the removal below.
  }
  try {
    storage.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    // Nothing more to do: the next write replaces the record.
  }
  return empty;
}

/** The saved drafts of one session. */
export function loadSessionDrafts(storage: Storage | null, scope: DraftScope, sessionId: string): Record<string, SurfaceDraft> {
  if (!storage) return {};
  const { sessions } = readRecord(storage, scope);
  return Object.hasOwn(sessions, sessionId) ? sessions[sessionId]!.surfaces : {};
}

function trim(record: DraftRecord, keep: string): void {
  const others = Object.entries(record.sessions).filter(([id]) => id !== keep).sort((a, b) => b[1].at - a[1].at);
  for (const [id] of others.slice(MAX_SESSIONS - 1)) delete record.sessions[id];
}

function evictOldest(record: DraftRecord, keep: string): boolean {
  const oldest = Object.entries(record.sessions).filter(([id]) => id !== keep).sort((a, b) => a[1].at - b[1].at)[0];
  if (!oldest) return false;
  delete record.sessions[oldest[0]];
  return true;
}

/**
 * Stores the drafts of one session, and keeps every other session of the
 * owner. An empty set removes the session. When the entry cannot be written
 * (blocked storage, a full quota, or a size over the bound), the session is
 * removed instead: an older copy would bring back values that the user has
 * since changed.
 */
export function saveSessionDrafts(
  storage: Storage | null,
  scope: DraftScope,
  sessionId: string,
  surfaces: Record<string, SurfaceDraft>,
  now: number
): DraftPersistence {
  const has = Object.keys(surfaces).length > 0;
  if (!storage) return has ? "unavailable" : "ok";
  const record = readRecord(storage, scope);
  const entries = Object.entries(surfaces);
  const omitted = entries.length > MAX_SURFACES_PER_SESSION;
  if (has) record.sessions[sessionId] = { at: now, surfaces: Object.fromEntries(entries.slice(-MAX_SURFACES_PER_SESSION)) };
  else delete record.sessions[sessionId];
  trim(record, sessionId);

  const write = (): boolean => {
    try {
      if (Object.keys(record.sessions).length === 0) storage.removeItem(DRAFT_STORAGE_KEY);
      else storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(record));
      return true;
    } catch {
      return false;
    }
  };
  while (has && JSON.stringify(record).length > MAX_RECORD_CHARS) {
    if (!evictOldest(record, sessionId)) return failClosed(storage, scope, sessionId);
  }
  if (write()) return omitted ? "full" : "ok";
  while (evictOldest(record, sessionId)) if (write()) return omitted ? "full" : "ok";
  return failClosed(storage, scope, sessionId);
}

function failClosed(storage: Storage, scope: DraftScope, sessionId: string): DraftPersistence {
  const record = readRecord(storage, scope);
  delete record.sessions[sessionId];
  try {
    if (Object.keys(record.sessions).length === 0) storage.removeItem(DRAFT_STORAGE_KEY);
    else storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Storage that fails to write may fail to remove too. The reader checks
    // the owner and the digest of every draft, so a stale record is not applied.
  }
  return "full";
}

/** Removes every draft of every session, and stops the sync loops that began
 *  earlier. Call it at sign-out and when the person changes. */
export function clearGenerativeUiDrafts(): void {
  clearEpoch++;
  try {
    getDraftStorage()?.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    // Blocked storage holds nothing to clear.
  }
}
