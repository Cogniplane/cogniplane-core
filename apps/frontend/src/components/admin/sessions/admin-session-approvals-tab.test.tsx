// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { AdminSessionDetailApproval } from "@cogniplane/shared-types";

import { PILL_BLUE, PILL_GRAY, PILL_RED } from "../../../lib/ui-tokens";
import { AdminSessionApprovalsTab } from "./admin-session-approvals-tab";

afterEach(cleanup);

function approval(overrides: Partial<AdminSessionDetailApproval>): AdminSessionDetailApproval {
  return {
    approvalId: "approval-1", turnId: "turn-1", itemId: "item-1", requestMethod: "tools/call", kind: "tool",
    title: "Run shell", summary: "", status: "pending", decision: null, requestPayload: null,
    createdAt: "2026-10-01T10:00:00.000Z", resolvedAt: null, ...overrides
  };
}

it("says when the session has no approvals", () => {
  render(<AdminSessionApprovalsTab approvals={[]} />);

  expect(screen.getByText("No approvals in this session.")).toBeTruthy();
});

// The status is the canonical signal; the lower-level decision also counts.
it.each([
  ["approved status", { status: "approved", decision: null }, "no decision", PILL_BLUE],
  ["approve decision", { status: "expired", decision: "approve" }, "approve", PILL_BLUE],
  ["rejected status", { status: "rejected", decision: null }, "no decision", PILL_RED],
  ["reject decision", { status: "expired", decision: "reject" }, "reject", PILL_RED],
  ["pending", { status: "pending", decision: null }, "no decision", PILL_GRAY]
] as const)("colors the decision pill for %s", (_case, overrides, label, pill) => {
  render(<AdminSessionApprovalsTab approvals={[approval(overrides)]} />);

  expect(screen.getByText(label).className).toBe(pill);
});

it("shows each approval's details, and the payload only when it has fields", () => {
  render(<AdminSessionApprovalsTab approvals={[
    approval({
      approvalId: "approval-1", title: "Run shell", summary: "Delete temp files", turnId: "turn-7", itemId: "item-9",
      requestPayload: { command: "rm -rf /tmp/x" }, status: "approved", decision: "approve",
      resolvedAt: "2026-10-01T10:05:00.000Z"
    }),
    approval({ approvalId: "approval-2", title: "Fetch URL", requestPayload: {} })
  ]} />);

  expect(screen.getByText("Run shell")).toBeTruthy();
  expect(screen.getByText("Fetch URL")).toBeTruthy();
  expect(screen.getByText("Delete temp files")).toBeTruthy();
  // An empty summary shows a dash.
  expect(screen.getByText("—")).toBeTruthy();
  expect(screen.getByText("turn-7")).toBeTruthy();
  expect(screen.getByText("item-9")).toBeTruthy();
  expect(screen.getByText("approval-2")).toBeTruthy();
  // Only the first approval has a non-empty payload.
  expect(screen.getAllByText("Request payload")).toHaveLength(1);
  expect(screen.getByText(/"command": "rm -rf \/tmp\/x"/)).toBeTruthy();
});
