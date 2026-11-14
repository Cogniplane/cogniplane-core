import type { RuntimeAdapter } from "../runtime-contracts.js";
import type { SessionExecution, SessionExecutionStore } from "./session-execution-store.js";

// Failed queries do not prove revocation. Retry only while the last confirmed
// lease remains valid; a stalled query must not postpone the local deadline.
export function startExecutionHeartbeat(input: {
  leaseStartedAt: number;
  /** Monotonic deadline derived from the database-issued expires_at value. */
  leaseExpiresAt?: number;
  leaseMs: number;
  intervalMs: number;
  renew: () => Promise<boolean>;
  onLost: () => Promise<void>;
  onError: (error: unknown) => void;
}): () => void {
  let deadline = input.leaseExpiresAt ?? input.leaseStartedAt + input.leaseMs;
  let stopped = false;
  let pending = false;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(expiryTimer);
  };
  const lose = () => {
    if (stopped) return;
    stop();
    void Promise.resolve().then(input.onLost).catch(input.onError);
  };
  const timer = setInterval(() => {
    if (performance.now() >= deadline) { lose(); return; }
    if (pending || stopped) return;
    pending = true;
    const startedAt = performance.now();
    void input.renew().then(current => {
      if (stopped) return;
      if (!current || performance.now() >= deadline) { lose(); return; }
      // Use request start, so query latency cannot lengthen confirmed authority.
      deadline = startedAt + input.leaseMs;
      clearTimeout(expiryTimer);
      expiryTimer = setTimeout(lose, Math.max(0, deadline - performance.now()));
      expiryTimer.unref?.();
    }).catch(input.onError).finally(() => { pending = false; });
  }, input.intervalMs);
  let expiryTimer = setTimeout(lose, Math.max(0, deadline - performance.now()));
  expiryTimer.unref?.();
  timer.unref?.();
  return stop;
}

/**
 * Stops the runtime of an execution whose lease this replica lost. The abort
 * names the execution, so it cannot stop a newer turn of the session. A lease
 * that a security change stopped ends the turn with that reason, as on the
 * replica that made the change.
 */
export async function stopLostExecution(input: {
  execution: SessionExecution;
  executions: Partial<Pick<SessionExecutionStore, "stoppedBySecurityChange">>;
  runtime: Pick<RuntimeAdapter, "abortSession">;
}): Promise<void> {
  const { execution } = input;
  const bySecurityChange = await input.executions.stoppedBySecurityChange?.(execution).catch(() => false);
  await input.runtime.abortSession({
    tenantId: execution.tenantId, sessionId: execution.sessionId, userId: execution.userId,
    executionId: execution.executionId,
    ...(bySecurityChange ? { reason: "security_change" as const } : {})
  });
}

/**
 * Waits for `work`, but not longer than `ms`. Resolves in both cases; `work`
 * handles its own errors. The caller holds a lease that ends at its expiry
 * anyway, so it waits at most one lease period before it releases.
 */
export async function waitAtMost(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<void>(resolve => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  try {
    await Promise.race([work.then(() => undefined, () => undefined), limit]);
  } finally {
    clearTimeout(timer);
  }
}
