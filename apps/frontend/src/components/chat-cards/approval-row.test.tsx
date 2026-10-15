// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ApprovalRowView } from "./approval-row";
import type { ApprovalRow } from "./chat-cards.types";

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each(["<img src=x>.md", `${"W".repeat(116)}.txt`])(
  "renders filename %s literally, allows wrapping and keeps all three decision choices", (name) => {
    const row: ApprovalRow = { type: "approval", rowId: "approval:1", approvalId: "approval-1", itemId: "item-1",
      kind: "mcp_tool", status: "pending", decisionState: "pending", title: `Save "${name}" to Artifacts`,
      summary: "The agent wants to save 6 bytes of inline text as a file in this chat. " +
        "If saved, you can open or download it from the Artifacts panel. Reason: Review this write." };
    const onDecision = vi.fn();
    const view = render(<ApprovalRowView row={row} onDecision={onDecision} />);
    const title = screen.getByText(row.title);
    expect(title.textContent).toBe(row.title);
    expect(title.classList.contains("[overflow-wrap:anywhere]")).toBe(true);
    expect(screen.getByText(row.summary)).toBeTruthy();
    expect(view.container.querySelector("img")).toBeNull();
    const summary = screen.getByRole("button", { name: row.summary });
    fireEvent.click(summary);
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Approve once" }));
    fireEvent.click(screen.getByRole("button", { name: "Allow for this turn" }));
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(onDecision.mock.calls).toEqual([
      [row.approvalId, { decision: "approve" }],
      [row.approvalId, { decision: "approve", rememberForTurn: true }],
      [row.approvalId, { decision: "reject" }]
    ]);
  }
);

it("opens a multi-line summary in full, so the exact text of a save is visible before the user decides", () => {
  const summary = "Text to save (26 characters):\nUser prefers metric units.\n\nThis replaces the saved text (28 characters):\nUser prefers imperial units.";
  const row: ApprovalRow = { type: "approval", rowId: "approval:2", approvalId: "approval-2", itemId: "item-2",
    kind: "mcp_tool", status: "pending", decisionState: "pending", title: 'Replace memory "units"', summary };
  render(<ApprovalRowView row={row} onDecision={vi.fn()} />);

  const toggle = screen.getByRole("button", { name: /Text to save/ });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(toggle.textContent).toContain("User prefers metric units.");
  expect(toggle.textContent).toContain("User prefers imperial units.");
  expect(toggle.querySelector(".whitespace-pre-wrap")).not.toBeNull();
  expect(toggle.querySelector(".truncate")).toBeNull();
});

it("keeps a long one-line summary collapsed behind its toggle", () => {
  const row: ApprovalRow = { type: "approval", rowId: "approval:3", approvalId: "approval-3", itemId: "item-3",
    kind: "mcp_tool", status: "pending", decisionState: "pending", title: "Approve create_issue",
    summary: JSON.stringify({ title: "A".repeat(120) }) };
  render(<ApprovalRowView row={row} onDecision={vi.fn()} />);

  expect(screen.getByRole("button", { name: row.summary }).getAttribute("aria-expanded")).toBe("false");
});
