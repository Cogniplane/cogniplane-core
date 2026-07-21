// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Approval } from "@cogniplane/shared-types";

// resolveApproval is the network side-effect; mock it so the hook's optimistic
// in-flight → settle/finally flow is testable without a backend.
const resolveApproval = vi.fn();
vi.mock("../lib/session-api", () => ({
  resolveApproval: (...args: unknown[]) => resolveApproval(...args)
}));

import { useApprovalState } from "./use-approval-state";

afterEach(() => {
  cleanup();
  resolveApproval.mockReset();
});

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    approvalId: "ap-1",
    sessionId: "s-1",
    itemId: "item-1",
    kind: "command_execution",
    title: "Approve run",
    summary: "rm -rf build",
    status: "pending",
    ...overrides
  } as Approval;
}

describe("useApprovalState", () => {
  it("upsertApproval dedupes by approvalId (replace, not append) and keeps the latest payload", () => {
    const { result } = renderHook(() => useApprovalState({ onError: vi.fn() }));

    act(() => {
      result.current.registerPendingApproval(makeApproval({ approvalId: "ap-1", title: "first" }));
    });
    act(() => {
      // Same id again with a newer payload — must replace, not add a second entry.
      result.current.registerPendingApproval(makeApproval({ approvalId: "ap-1", title: "second" }));
    });
    act(() => {
      result.current.registerPendingApproval(makeApproval({ approvalId: "ap-2", title: "other" }));
    });

    expect(result.current.pendingApprovals).toHaveLength(2);
    const ap1 = result.current.pendingApprovals.find((a) => a.approvalId === "ap-1");
    expect(ap1?.title).toBe("second");
  });

  it("handleApprovalDecision removes the approval on success and clears the in-flight state", async () => {
    resolveApproval.mockResolvedValue(undefined);
    const { result } = renderHook(() => useApprovalState({ onError: vi.fn() }));

    act(() => {
      result.current.registerPendingApproval(makeApproval({ approvalId: "ap-1" }));
    });

    await act(async () => {
      await result.current.handleApprovalDecision("ap-1", { decision: "approve" });
    });

    expect(resolveApproval).toHaveBeenCalledWith("ap-1", "approve", undefined);
    expect(result.current.pendingApprovals).toHaveLength(0);
    // The optimistic in-flight marker is cleared in the finally.
    expect(result.current.approvalDecision).toBeNull();
  });

  it("handleApprovalDecision calls onError on a rejected resolve, keeps the approval, and still clears in finally", async () => {
    resolveApproval.mockRejectedValue(new Error("network down"));
    const onError = vi.fn();
    const { result } = renderHook(() => useApprovalState({ onError }));

    act(() => {
      result.current.registerPendingApproval(makeApproval({ approvalId: "ap-1" }));
    });

    await act(async () => {
      await result.current.handleApprovalDecision("ap-1", { decision: "reject" });
    });

    expect(onError).toHaveBeenCalledWith("network down");
    // The approval was NOT removed (the decision didn't land)...
    expect(result.current.pendingApprovals).toHaveLength(1);
    // ...but the in-flight marker is always cleared in the finally.
    expect(result.current.approvalDecision).toBeNull();
  });
});
