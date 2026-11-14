// Time limits of the graceful shutdown, shared by app-bootstrap.ts (the
// stages) and server.ts (the hard deadline). Each stage stops waiting at its
// limit, so the sum of the limits is the longest time a graceful close takes.

/** The shutdown stages, in the order that they run. */
export const SHUTDOWN_STAGE_MS = {
  /** Running interactive turns finish on their own. */
  turnWait: 5_000,
  /** The turns that still run get an interrupt, then time to end. */
  turnInterrupt: 5_000,
  /** The turns that did not end are saved as interrupted. */
  markInterrupted: 2_000,
  /** Open SSE responses end. A response that does not flush is destroyed. */
  streamClose: 1_000,
  /** Scheduled jobs finish on their own. */
  schedulerDrain: 5_000,
  /** The runtimes close and abort their turns. */
  runtimeClose: 5_000,
  /** Aborted scheduled jobs flush usage and write their outcome. */
  schedulerSettle: 15_000,
  /**
   * Answered forgot-password requests finish their lookup and put their email
   * in the outbox (routes/auth-local.ts).
   */
  passwordResets: 5_000,
  /** The mail outbox pass in progress finishes. */
  mailDrain: 5_000,
  /** In-flight HTTP requests finish. Then the server closes their connections. */
  httpClose: 3_000,
  /** Redis subscriptions, the Redis client and the database pools close. */
  cleanup: 3_000
} as const;

export type ShutdownStage = keyof typeof SHUTDOWN_STAGE_MS;
export type ShutdownStageMs = Record<ShutdownStage, number>;

/** Time for the work between the stages and for the last log lines. */
export const SHUTDOWN_MARGIN_MS = 3_000;

export function shutdownStageSumMs(stages: ShutdownStageMs = SHUTDOWN_STAGE_MS): number {
  return Object.values(stages).reduce((sum, ms) => sum + ms, 0);
}

/**
 * After this time, server.ts ends a shutdown that has not finished with exit
 * code 1. Container stop timeouts must be longer (compose.yaml:
 * stop_grace_period, docs/operations.md).
 */
export const SHUTDOWN_DEADLINE_MS = shutdownStageSumMs() + SHUTDOWN_MARGIN_MS;

/**
 * Waits for `task` up to `budgetMs`. Returns false at the limit; the task then
 * continues without a waiter, and a later failure of it is ignored. A failure
 * before the limit rejects, as the task does.
 */
export async function waitWithinBudget(task: Promise<unknown>, budgetMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    return await Promise.race([
      task.then(() => true, (error: unknown) => {
        if (timedOut) return false;
        throw error;
      }),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve(false);
        }, Math.max(0, budgetMs));
        timer.unref?.();
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
