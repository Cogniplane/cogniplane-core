"use client";

import { useCallback, useState } from "react";

import { resolveApproval } from "../lib/session-api";
import type { Approval } from "@cogniplane/shared-types";
import type { ApprovalDecision, InFlightApprovalDecision } from "../components/timeline.logic";

// Approval expiry has no dedicated SSE event — the backend encodes it in the
// noticeId of a `framework:runtime_notice` (native coordinator and Policy
// Center emitters respectively).
const EXPIRY_NOTICE_PREFIXES = ["approval-expired:", "policy-approval-expired:"];

export function expiredApprovalIdFromNotice(noticeId: string): string | null {
  for (const prefix of EXPIRY_NOTICE_PREFIXES) {
    if (noticeId.startsWith(prefix) && noticeId.length > prefix.length) {
      return noticeId.slice(prefix.length);
    }
  }
  return null;
}

function upsertApproval(approvals: Approval[], nextApproval: Approval): Approval[] {
  const existingIndex = approvals.findIndex(
    (approval) => approval.approvalId === nextApproval.approvalId
  );
  if (existingIndex === -1) {
    return [...approvals, nextApproval];
  }

  return approvals.map((approval, index) =>
    index === existingIndex ? nextApproval : approval
  );
}

export function useApprovalState(input: { onError: (message: string) => void }) {
  const { onError } = input;

  const [pendingApprovals, setPendingApprovals] = useState<Approval[]>([]);
  const [approvalDecision, setApprovalDecision] = useState<InFlightApprovalDecision | null>(null);

  const replacePendingApprovals = useCallback((approvals: Approval[]) => {
    setPendingApprovals(approvals);
  }, []);

  const registerPendingApproval = useCallback((approval: Approval) => {
    setPendingApprovals((current) => upsertApproval(current, approval));
  }, []);

  const removePendingApproval = useCallback((approvalId: string) => {
    setPendingApprovals((current) =>
      current.filter((approval) => approval.approvalId !== approvalId)
    );
  }, []);

  const handleApprovalDecision = useCallback(
    async (approvalId: string, decision: ApprovalDecision) => {
      try {
        setApprovalDecision({ approvalId, kind: decision.decision });
        await resolveApproval(approvalId, decision.decision, decision.rememberForTurn);
        setPendingApprovals((current) =>
          current.filter((approval) => approval.approvalId !== approvalId)
        );
      } catch (caughtError) {
        onError(caughtError instanceof Error ? caughtError.message : String(caughtError));
      } finally {
        setApprovalDecision(null);
      }
    },
    [onError]
  );

  return {
    pendingApprovals,
    approvalDecision,
    replacePendingApprovals,
    registerPendingApproval,
    removePendingApproval,
    handleApprovalDecision
  };
}
