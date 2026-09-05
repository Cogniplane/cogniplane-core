import type { FastifyBaseLogger } from "fastify";

import type { MessageStore } from "../message-store.js";

export type StaleMessageSweeperDeps = {
  /**
   * MUST be backed by the privileged (BYPASSRLS) pool — the sweep spans all
   * tenants in a single statement, so an RLS-scoped store would only ever see
   * the tenant whose context happens to be set (i.e. none, here).
   */
  messages: Pick<MessageStore, "sweepStaleStreaming">;
  logger: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
  /**
   * A row still `pending`/`streaming` after this long cannot belong to a live
   * turn. Callers pass the turn watchdog's ceiling (RUNTIME_TURN_TIMEOUT_MS +
   * APPROVAL_REQUEST_TTL_MS — the watchdog pauses while a human decides an
   * approval, so a turn's real wall-clock ceiling is the sum).
   */
  staleAfterMs: number;
};

/**
 * How long a `pending`/`streaming` assistant row must sit untouched before the
 * sweeper may assume no live turn owns it — `null` when no such point exists.
 *
 * The turn watchdog caps WORKING time at `RUNTIME_TURN_TIMEOUT_MS` but pauses
 * while a human decides an approval, so a turn's real elapsed time is working
 * time plus approval time. Approval rounds are unbounded (bead l2pq), so no
 * finite deadline covers every turn; the multiplier budgets for a handful of
 * rounds. `RUNTIME_TURN_TIMEOUT_MS = 0` disables the watchdog entirely, at which
 * point a turn has no ceiling at all and NO deadline can tell an abandoned row
 * from a live one — the sweeper must not run.
 */
export function resolveStaleMessageDeadline(config: {
  RUNTIME_TURN_TIMEOUT_MS: number;
  APPROVAL_REQUEST_TTL_MS: number;
}): number | null {
  if (config.RUNTIME_TURN_TIMEOUT_MS <= 0) return null;
  return config.RUNTIME_TURN_TIMEOUT_MS + config.APPROVAL_REQUEST_TTL_MS * APPROVAL_ROUND_BUDGET;
}

/** Approval rounds the deadline above budgets for. See l2pq for why this is finite. */
const APPROVAL_ROUND_BUDGET = 3;

/**
 * Recovers assistant rows abandoned mid-turn. Every in-process path closes its
 * own row out through the AG-UI writer's `finally`, terminal frame, and the
 * adapter's watchdog. None of them runs when the process is killed:
 * a SIGKILL, an OOM, or a rolling deploy leaves the row `pending`/`streaming`
 * forever, which the UI renders as a turn that never finishes and history shows
 * with no outcome at all.
 *
 * Idempotent and safe to run repeatedly: it only touches assistant rows past
 * the staleness deadline, under `FOR UPDATE SKIP LOCKED`, so concurrent sweeps
 * never contend and a live turn's own write is never blocked.
 */
export async function sweepStaleAssistantMessages(
  deps: StaleMessageSweeperDeps,
  batchSize = 500
): Promise<number> {
  let total = 0;
  // Loop until a batch comes back short — a large backlog (e.g. after a long
  // outage) is drained without a single oversized UPDATE.
  for (;;) {
    const swept = await deps.messages.sweepStaleStreaming(deps.staleAfterMs, batchSize);
    total += swept.length;
    if (swept.length < batchSize) break;
  }

  if (total > 0) {
    deps.logger.info(
      { interruptedCount: total, staleAfterMs: deps.staleAfterMs },
      "Swept assistant messages left streaming by a prior process"
    );
  }
  return total;
}
