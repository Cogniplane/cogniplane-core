import { TurnEventLog } from "./turn-event-log.js";

// Tracks which sessions have a turn streaming *right now* on this backend
// process. Reserves interactive turns and lifecycle mutations, and supplies
// activity identity and timing to the session list.
//
// This registry handles local cancellation and replay. The execution lease in
// Postgres admits turns and reports running state across replicas.

// Must exceed the longest turn the platform allows. A staleness window shorter
// than the turn ceiling stale-evicts a *live* turn from snapshot(), letting a
// concurrent request pass the busy check and start a second turn on the same
// session.
//
// Derive it from config rather than hard-coding: the ceiling moves with
// E2B_SANDBOX_TIMEOUT_MS and TOOL_CONTEXT_TTL_MS, both env-tunable, and a
// constant that merely happened to sit above today's defaults goes silently
// wrong the moment an operator raises either one. Those two are the real
// wall-clock caps on a turn — the turn watchdog is not, since it pauses for
// the duration of an approval.
//
// This window budgets for ONE approval, and the approval round loop is
// unbounded, so the window alone cannot cover a turn's real wall-clock length.
// It does not have to: staleness is measured from `lastSeenAt`, and the resume
// path calls `keepAlive` on every approval decision. The window is therefore an
// idle timeout between rounds, not a cap on total turn length, and a turn parked
// on N consecutive approvals stays live as long as each round completes inside it.
//
// If a future change stops calling `keepAlive` on the resume path, this reverts
// to a wall-clock cap that stale-evicts LIVE turns, letting the busy check pass
// and a second turn start on the same session — the exact failure it exists to
// prevent. Keep the two together.
export function deriveStaleAfterMs(config: {
  E2B_SANDBOX_TIMEOUT_MS: number;
  TOOL_CONTEXT_TTL_MS: number;
}): number {
  return Math.max(config.E2B_SANDBOX_TIMEOUT_MS, config.TOOL_CONTEXT_TTL_MS) + 5 * 60 * 1000;
}

// Fallback for constructions with no config in reach (tests, in-memory fakes):
// the derivation applied to the shipped defaults — max(30 min sandbox, 35 min
// context TTL) + 5 min margin.
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
   * Refresh a live entry's liveness without moving its start time. Called on
   * each approval decision so a turn stalled on N consecutive approvals is not
   * stale-evicted while still running — eviction would let the busy check pass
   * and a second turn start on the same session.
   *
   * No-op when the entry is already gone: this keeps a turn alive, it does not
   * resurrect one, so it can never re-reserve a session the turn has released.
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
   * Return the set of session ids currently streaming. Entries older than
   * STALE_AFTER_MS are treated as dead (defensive — the `finally` in the
   * stream writer should always clear, but a crashed process or an awaited
   * handler that never resolves would leave a sticky entry).
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
