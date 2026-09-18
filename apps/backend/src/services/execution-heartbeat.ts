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
