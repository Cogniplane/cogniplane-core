// Tracks which sessions have a turn streaming *right now* on this backend
// process. Used only to decorate the sidebar with a "busy" dot.
//
// Single-process scope by design: if we ever scale horizontally, swap this
// for a DB-backed flag (a `sessions.current_turn_started_at` column works).

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
// KNOWN RESIDUAL LIMIT (bead l2pq): this budgets for ONE approval. The approval
// round loop is unbounded, so a turn stalling on two or more consecutive
// approvals outlives this window and is stale-evicted while still LIVE — the
// busy check then passes and a second turn starts on the same session, which is
// the exact failure the window exists to prevent. Fixing the tool-context TTL
// to refresh per approval round fixes this too, PROVIDED the derivation here is
// revisited with it; extending only the context TTL would leave this in place.
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

type Entry = {
  startedAt: number;
};

export class ActiveTurnsRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly staleAfterMs: number;

  constructor(staleAfterMs: number = DEFAULT_STALE_AFTER_MS) {
    this.staleAfterMs = staleAfterMs;
  }

  mark(sessionId: string): void {
    this.entries.set(sessionId, { startedAt: Date.now() });
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
      if (now - entry.startedAt > this.staleAfterMs) {
        this.entries.delete(sessionId);
        continue;
      }
      live.add(sessionId);
    }
    return live;
  }
}
