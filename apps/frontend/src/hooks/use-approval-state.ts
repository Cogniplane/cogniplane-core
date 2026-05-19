"use client";

import { useCallback, useState } from "react";

import { resolveApproval } from "../lib/session-api";
import type { Approval } from "@cogniplane/shared-types";

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
  const [approvalDecisionId, setApprovalDecisionId] = useState<string | null>(null);

  const replacePendingApprovals = useCallback((approvals: Approval[]) => {
    setPendingApprovals(approvals);
  }, []);

  const registerPendingApproval = useCallback((approval: Approval) => {
    setPendingApprovals((current) => upsertApproval(current, approval));
  }, []);

  const handleApprovalDecision = useCallback(
    async (approvalId: string, decision: "approve" | "reject") => {
      try {
        setApprovalDecisionId(approvalId);
        await resolveApproval(approvalId, decision);
        setPendingApprovals((current) =>
          current.filter((approval) => approval.approvalId !== approvalId)
        );
      } catch (caughtError) {
        onError(caughtError instanceof Error ? caughtError.message : String(caughtError));
      } finally {
        setApprovalDecisionId(null);
      }
    },
    [onError]
  );

  return {
    pendingApprovals,
    approvalDecisionId,
    replacePendingApprovals,
    registerPendingApproval,
    handleApprovalDecision
  };
}
