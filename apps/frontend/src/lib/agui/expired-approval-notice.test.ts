import { describe, expect, test } from "vitest";

import { expiredApprovalIdFromNotice } from "./use-agui-custom-events";

// The backend emits a `runtime_notice` custom event with these noticeId prefixes
// specifically so the UI clears the pending approval prompt on expiry
// (runtime-request-handler.ts and policy-approval-coordinator.ts). An expired
// card that stays actionable errors when clicked.
describe("expiredApprovalIdFromNotice", () => {
  test("parses a native approval expiry notice", () => {
    expect(expiredApprovalIdFromNotice("approval-expired:approval-99")).toBe("approval-99");
  });

  test("parses a Policy Center approval expiry notice", () => {
    expect(expiredApprovalIdFromNotice("policy-approval-expired:ap-42")).toBe("ap-42");
  });

  test("ignores unrelated notices", () => {
    expect(expiredApprovalIdFromNotice("workspace-sync-failed")).toBeNull();
    expect(expiredApprovalIdFromNotice("some-other:approval-expired:x")).toBeNull();
  });

  test("ignores an expiry notice with no approval id", () => {
    expect(expiredApprovalIdFromNotice("approval-expired:")).toBeNull();
    expect(expiredApprovalIdFromNotice("policy-approval-expired:")).toBeNull();
  });
});
