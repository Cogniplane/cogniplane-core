// Maps (sessionId, runtimeId) → currently-streaming assistantMessageId.
//
// The LLM proxy needs to know which message to charge token usage to when
// upstream completes. The rt_* runtime token carries sid + rid claims but
// not a turn id (Codex caches its model_provider config at process start
// and can't be told the current turn per-request). This in-memory map
// closes the gap: /messages registers the active turn before the runtime
// call, and clears it in finally; the proxy looks up by sid+rid on each
// upstream request and stamps usage onto the right message.
//
// Single-process scope by design — same caveat as ActiveTurnsRegistry.
// If we scale horizontally, swap for a DB-backed flag.

const STALE_AFTER_MS = 15 * 60 * 1000;

type Entry = {
  assistantMessageId: string;
  modelName: string | null;
  startedAt: number;
};

function key(sessionId: string, runtimeId: string): string {
  return `${sessionId}::${runtimeId}`;
}

export class ActiveTurnMessageMap {
  private readonly entries = new Map<string, Entry>();

  set(sessionId: string, runtimeId: string, assistantMessageId: string, modelName: string | null): void {
    this.entries.set(key(sessionId, runtimeId), {
      assistantMessageId,
      modelName,
      startedAt: Date.now()
    });
  }

  /**
   * Returns the active message attribution for an rt_* request, or null if
   * no turn is in flight. Stale entries (>15 min, indicating a missed
   * `clear` from a crashed turn) are evicted on read.
   */
  get(sessionId: string, runtimeId: string): { assistantMessageId: string; modelName: string | null } | null {
    const k = key(sessionId, runtimeId);
    const entry = this.entries.get(k);
    if (!entry) return null;
    if (Date.now() - entry.startedAt > STALE_AFTER_MS) {
      this.entries.delete(k);
      return null;
    }
    return { assistantMessageId: entry.assistantMessageId, modelName: entry.modelName };
  }

  clear(sessionId: string, runtimeId: string): void {
    this.entries.delete(key(sessionId, runtimeId));
  }
}
