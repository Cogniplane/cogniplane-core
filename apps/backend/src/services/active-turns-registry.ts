// Tracks which sessions have a turn streaming *right now* on this backend
// process. Used only to decorate the sidebar with a "busy" dot.
//
// Single-process scope by design: if we ever scale horizontally, swap this
// for a DB-backed flag (a `sessions.current_turn_started_at` column works).

const STALE_AFTER_MS = 15 * 60 * 1000;

type Entry = {
  startedAt: number;
};

export class ActiveTurnsRegistry {
  private readonly entries = new Map<string, Entry>();

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
      if (now - entry.startedAt > STALE_AFTER_MS) {
        this.entries.delete(sessionId);
        continue;
      }
      live.add(sessionId);
    }
    return live;
  }
}
