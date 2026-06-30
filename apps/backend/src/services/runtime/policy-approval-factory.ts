import type { FastifyBaseLogger } from "fastify";

import type { AppConfig } from "../../config.js";
import type { ApprovalStore } from "../auth/approval-store.js";
import type { AuditEventStore } from "../audit-event-store.js";
import { PolicyApprovalCoordinator, type PushFrameworkEvent } from "./policy-approval-coordinator.js";

// Both runtime adapters wire their PolicyApprovalCoordinator identically apart
// from the `pushFrameworkEvent` closure (which depends on each adapter's
// active-turn state shape). Centralising the construction makes the documented
// "both adapters host policy approvals identically" invariant structural
// rather than a coincidence the two constructors must keep in sync.
export function createRuntimePolicyApprovals(input: {
  config: Pick<AppConfig, "APPROVAL_REQUEST_TTL_MS" | "POLICY_APPROVAL_REMINDER_FRACTION">;
  approvals: ApprovalStore;
  auditEvents: AuditEventStore;
  logger: FastifyBaseLogger;
  pushFrameworkEvent: PushFrameworkEvent;
}): PolicyApprovalCoordinator {
  return new PolicyApprovalCoordinator({
    approvals: input.approvals,
    auditEvents: input.auditEvents,
    logger: input.logger,
    ttlMs: input.config.APPROVAL_REQUEST_TTL_MS,
    reminderFraction: input.config.POLICY_APPROVAL_REMINDER_FRACTION,
    pushFrameworkEvent: input.pushFrameworkEvent
  });
}
