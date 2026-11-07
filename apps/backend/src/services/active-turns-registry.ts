import { TurnEventLog } from "./turn-event-log.js";

// Tracks which sessions have a turn streaming *right now* on this backend
// process. Reserves interactive turns and lifecycle mutations, and supplies
// activity identity and timing to the session list.
//
// This registry handles local cancellation and replay. The execution lease in
// Postgres admits turns and reports running state across replicas.

// The staleness window must exceed the longest turn the platform allows. A
// shorter window lets snapshot() evict a live turn, so a second turn can start
// on the same session.
//
// Derive the window from config. Do not hard-code it. A constant that fits
// today's defaults breaks silently when an operator raises either value.
// E2B_SANDBOX_TIMEOUT_MS and TOOL_CONTEXT_TTL_MS are the real wall-clock caps
// on a turn. The turn watchdog is not, because it pauses during an approval.
//
// The window is long enough for one approval round. The approval round loop has
// no limit, so the window alone cannot cover a whole turn, and it does not need
// to. The registry measures staleness from `lastSeenAt`. The resume path calls
// `keepAlive` on each approval decision. The window is therefore an idle timeout
// between rounds. A turn with N approvals stays live while each round finishes
// in time.
//
// If the resume path stops calling `keepAlive`, the window becomes a wall-clock
// cap again. Keep the two together.
export function deriveStaleAfterMs(config: {
  E2B_SANDBOX_TIMEOUT_MS: number;
  TOOL_CONTEXT_TTL_MS: number;
}): number {
  return Math.max(config.E2B_SANDBOX_TIMEOUT_MS, config.TOOL_CONTEXT_TTL_MS) + 5 * 60 * 1000;
}

// Fallback for tests and in-memory fakes, which have no config. It is the
// derivation with the shipped defaults: max(30 min sandbox, 35 min context
// TTL) + 5 min margin.
const DEFAULT_STALE_AFTER_MS = 40 * 60 * 1000;

export type TurnIdentity = { messageId: string; sequence: number };

type Entry = {
  tenantId?: string;
  userId?: string;
  executionId?: string;
  turn?: TurnIdentity;
  cancel: AbortController;
  /** Turn start. Drives the user-visible elapsed timer; never moves. */
  startedAt: number;
  /**
   * Last proof of life. Staleness is measured from this, not `startedAt`, so a
   * turn parked on consecutive approvals stays live without the UI timer
   * jumping backwards.
   */
  lastSeenAt: number;
};

export class ActiveTurnsRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly mutations = new Map<string, symbol>();
  private readonly eventLogs = new Map<string, TurnEventLog>();
  private readonly staleAfterMs: number;
  private draining = false;

  constructor(staleAfterMs: number = DEFAULT_STALE_AFTER_MS) {
    this.staleAfterMs = staleAfterMs;
  }

  beginDrain(): void { this.draining = true; }

  isDraining(): boolean { return this.draining; }

  mark(sessionId: string, owner?: { tenantId: string; userId: string }): TurnEventLog {
    const now = Date.now();
    // A previous turn can still publish its terminal event after releasing
    // admission. Its request owns that log and closes it in its finally block.
    if (this.entries.has(sessionId)) this.closeEventLog(sessionId);
    this.entries.set(sessionId, { ...owner, cancel: new AbortController(), startedAt: now, lastSeenAt: now });
    const log = new TurnEventLog();
    this.eventLogs.set(sessionId, log);
    return log;
  }

  eventLog(sessionId: string, tenantId: string): TurnEventLog | undefined {
    if (this.entries.get(sessionId)?.tenantId !== tenantId) return undefined;
    return this.eventLogs.get(sessionId);
  }

  closeEventLog(sessionId: string, log = this.eventLogs.get(sessionId)): void {
    log?.close();
    if (this.eventLogs.get(sessionId) === log) this.eventLogs.delete(sessionId);
  }

  /** Stop can arrive while the request still prepares the runtime. */
  requestCancel(sessionId: string, tenantId: string): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.tenantId !== tenantId) return false;
    entry.cancel.abort();
    return true;
  }

  setExecution(sessionId: string, executionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry) entry.executionId = executionId;
  }

  requestCancelExecution(sessionId: string, tenantId: string, executionId: string): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.tenantId !== tenantId || entry.executionId !== executionId) return false;
    entry.cancel.abort();
    return true;
  }

  requestCancelUnadmitted(sessionId: string, tenantId: string): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.tenantId !== tenantId || entry.executionId) return false;
    entry.cancel.abort();
    return true;
  }

  cancelSignal(sessionId: string): AbortSignal | undefined {
    return this.entries.get(sessionId)?.cancel.signal;
  }

  countRunning(owner: { tenantId: string; userId?: string }): number {
    const live = this.snapshot();
    let count = 0;
    for (const sessionId of live) {
      const entry = this.entries.get(sessionId);
      if (entry?.tenantId === owner.tenantId &&
        (owner.userId === undefined || entry.userId === owner.userId)) count += 1;
    }
    return count;
  }

  runningOwners(): Array<{ sessionId: string; tenantId: string; userId: string }> {
    return [...this.snapshot()].flatMap((sessionId) => {
      const entry = this.entries.get(sessionId);
      return entry?.tenantId && entry.userId
        ? [{ sessionId, tenantId: entry.tenantId, userId: entry.userId }]
        : [];
    });
  }

  /**
   * Refreshes the liveness of a live entry. The start time does not change.
   * The resume path calls this on each approval decision, so the registry does
   * not evict a turn that waits on many approvals while it runs.
   *
   * No-op when the entry is gone. This keeps a turn alive. It does not revive
   * a turn, so it cannot re-reserve a session that the turn released.
   */
  keepAlive(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry) entry.lastSeenAt = Date.now();
  }

  isBusy(sessionId: string): boolean {
    return this.mutations.has(sessionId) || this.snapshot().has(sessionId);
  }

  /** Reserve a mutation without advertising a streaming turn or start time. */
  reserveMutation(sessionId: string): (() => void) | null {
    if (this.isBusy(sessionId)) return null;
    const token = Symbol(sessionId);
    this.mutations.set(sessionId, token);
    return () => {
      if (this.mutations.get(sessionId) === token) this.mutations.delete(sessionId);
    };
  }

  identify(sessionId: string, turn: TurnIdentity): void {
    const entry = this.entries.get(sessionId);
    if (entry) entry.turn = turn;
  }

  identity(sessionId: string): TurnIdentity | undefined {
    return this.entries.get(sessionId)?.turn;
  }

  startedAt(sessionId: string): number | undefined {
    return this.entries.get(sessionId)?.startedAt;
  }

  clear(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  /**
   * An entry not seen for `staleAfterMs` counts as dead. The stream
   * writer's `finally` should clear each entry. A crashed process or a handler
   * that never resolves can still leave a sticky entry.
   */
  snapshot(): Set<string> {
    const now = Date.now();
    const live = new Set<string>();
    for (const [sessionId, entry] of this.entries) {
      if (now - entry.lastSeenAt > this.staleAfterMs) {
        this.entries.delete(sessionId);
        this.closeEventLog(sessionId);
        continue;
      }
      live.add(sessionId);
    }
    return live;
  }
}
