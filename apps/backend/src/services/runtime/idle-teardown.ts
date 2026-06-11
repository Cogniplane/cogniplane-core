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
 * (Re-)arm the RUNTIME_IDLE_TIMEOUT_MS teardown timer shared by both runtime
 * providers: cleared at turn start, re-armed at turn end and at session
 * creation, so an idle sandbox doesn't bill until the E2B hard timeout.
 * Skipped while the session is busy or already torn down — onIdle must never
 * fire mid-turn.
 */
export function scheduleIdleTeardown(
  host: IdleTimerHost,
  opts: {
    timeoutMs: number;
    /** Busy or already-closed sessions must not arm the timer. */
    isBusy: () => boolean;
    /** Teardown action (Codex: requestRuntimeShutdown; Claude: abortSession). */
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
