/**
 * Wall-clock stage timer for session-startup latency instrumentation
 * (Phase 0 of the runtime-architecture evaluation). Collects named stage
 * durations so callers can emit ONE structured summary log line per session
 * start — see the `session_startup_timing` line in
 * deep-agents-runtime-adapter.ts, and the
 * `turn_latency_timing` line in sse-stream-writer-agui.ts. Extraction/aggregation:
 * scripts/analyze-startup-latency.mjs.
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
