import type { FastifyBaseLogger } from "fastify";

/** Any session/runtime state object that carries the idle-teardown timer. */
export type IdleTimerHost = { idleTimer: NodeJS.Timeout | null };

export function clearIdleTimer(host: IdleTimerHost): void {
  if (host.idleTimer) {
    clearTimeout(host.idleTimer);
    host.idleTimer = null;
  }
}

/**
 * (Re-)arm the RUNTIME_IDLE_TIMEOUT_MS teardown timer for a runtime session:
 * cleared at turn start, re-armed at turn end and at session creation, so an
 * idle runtime does not hold memory and its MCP connections.
 * The teardown kills only a sandbox with no saved record (a project chat). The
 * saved sandbox of a normal chat stays on purpose: the next turn, on any
 * replica, reconnects to it with its files. It runs until E2B expires it
 * (E2B_SANDBOX_TIMEOUT_MS after the last turn start), or until archive,
 * delete, purge or a security change of the account kills it.
 * Skipped while the session is busy or already torn down — onIdle must never
 * fire mid-turn.
 */
export function scheduleIdleTeardown(
  host: IdleTimerHost,
  opts: {
    timeoutMs: number;
    /** Busy or already-closed sessions must not arm the timer. */
    isBusy: () => boolean;
    /** Teardown action (deep-agents: abortSession). */
    onIdle: () => Promise<void>;
    logger: Pick<FastifyBaseLogger, "error">;
    logContext: Record<string, unknown>;
  }
): void {
  clearIdleTimer(host);
  if (opts.isBusy()) return;
  host.idleTimer = setTimeout(() => {
    host.idleTimer = null;
    void opts.onIdle().catch((err: unknown) => {
      opts.logger.error({ err, ...opts.logContext }, "idle teardown failed");
    });
  }, opts.timeoutMs);
  host.idleTimer.unref?.();
}
