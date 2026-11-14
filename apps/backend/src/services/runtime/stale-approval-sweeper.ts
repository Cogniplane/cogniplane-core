import type { FastifyBaseLogger } from "fastify";

import type { ApprovalStore } from "../auth/approval-store.js";

export type StaleApprovalSweeperDeps = {
  /**
   * MUST be backed by the privileged (BYPASSRLS) pool — the sweep spans all
   * tenants in a single statement, so an RLS-scoped store would only ever see
   * the tenant whose context happens to be set (i.e. none, here).
   */
  approvals: Pick<ApprovalStore, "sweepExpired">;
  logger: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
};

/**
 * Recovers approval rows that aged past their `expires_at` deadline while no
 * in-process TTL timer was alive to expire them — the classic case being a
 * crash/restart that killed the timer mid-flight, leaving rows stuck in
 * `status='pending'` forever (dead UI prompt; a late decision 404s).
 *
 * Idempotent and safe to run repeatedly: `sweepExpired` only touches rows still
 * `pending` and past deadline, using `FOR UPDATE SKIP LOCKED`, so concurrent
 * sweeps (or a sweep racing a live timer) never double-expire or block. Each
 * batch writes its `approval.expired` events in its own transaction. A failed
 * batch throws and stays `pending` for the next sweep.
 */
export async function sweepStaleApprovals(
  deps: StaleApprovalSweeperDeps,
  batchSize = 500
): Promise<number> {
  let total = 0;
  // Loop until a batch comes back short — a large backlog (e.g. after a long
  // outage) is drained without a single oversized UPDATE/audit burst.
  for (;;) {
    const expired = await deps.approvals.sweepExpired(batchSize);
    total += expired.length;
    if (expired.length < batchSize) break;
  }

  if (total > 0) {
    deps.logger.info({ expiredCount: total }, "Swept stale pending approvals");
  }
  return total;
}
