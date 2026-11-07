/**
 * Wall-clock stage timer for session-startup latency instrumentation. It collects
 * named stage durations, so the caller can log them in one structured line per
 * session start (the `session_startup_timing` line in deep-agents-runtime-adapter.ts).
 */
export type StartupStageTimings = Record<string, number>;

export type StageTimer = {
  /** Mutable stage-name → duration-ms map. Safe to merge into log payloads. */
  timings: StartupStageTimings;
  /** Times an async stage; records the duration even when `fn` throws. */
  time<T>(stage: string, fn: () => Promise<T>): Promise<T>;
  /** Records an externally measured duration. */
  set(stage: string, ms: number): void;
  /** Elapsed ms since the timer was created. */
  totalMs(): number;
};

export function createStageTimer(): StageTimer {
  const timings: StartupStageTimings = {};
  const startedAt = performance.now();
  return {
    timings,
    async time<T>(stage: string, fn: () => Promise<T>): Promise<T> {
      const t0 = performance.now();
      try {
        return await fn();
      } finally {
        timings[stage] = Math.round(performance.now() - t0);
      }
    },
    set(stage: string, ms: number): void {
      timings[stage] = Math.round(ms);
    },
    totalMs(): number {
      return Math.round(performance.now() - startedAt);
    }
  };
}
