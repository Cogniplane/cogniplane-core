// @vitest-environment jsdom
//
// Where the controls of a pending approval show. The transcript's virtual list
// mounts and unmounts cards as the user scrolls; the controls follow the card,
// and one approval never shows two sets.

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApprovalRow } from "./chat-cards.types";
import {
  approvalsByCall,
  MountedToolCards,
  ToolApprovalContext,
  useCardApproval,
  useListedApprovals,
  type ToolApprovals
} from "./tool-approvals";

afterEach(cleanup);

const row = (approvalId: string, toolCallId?: string): ApprovalRow => ({
  type: "approval", rowId: `approval:${approvalId}`, approvalId, itemId: approvalId, kind: "file_change",
  title: approvalId, summary: "", status: "pending", decisionState: "pending", allowForTurn: true, ...(toolCallId ? { toolCallId } : {})
});

function Card({ toolCallId, label, canDecide = true }: { toolCallId: string; label: string; canDecide?: boolean }) {
  const approval = useCardApproval(toolCallId, canDecide);
  return <div data-testid={label}>{approval ? `controls:${approval.row.approvalId}` : "none"}</div>;
}

function List({ rows, approvals }: { rows: ApprovalRow[]; approvals: ToolApprovals }) {
  return <div data-testid="list">{useListedApprovals(rows, approvals).map((entry) => entry.approvalId).join(",")}</div>;
}

function Chat({ rows, cards, approvals }: { rows: ApprovalRow[]; cards: Array<{ id: string; label: string; canDecide?: boolean }>; approvals: ToolApprovals }) {
  return (
    <ToolApprovalContext.Provider value={approvals}>
      <List rows={rows} approvals={approvals} />
      {cards.map((card) => <Card key={card.label} toolCallId={card.id} label={card.label} canDecide={card.canDecide} />)}
    </ToolApprovalContext.Provider>
  );
}

const text = (testId: string) => screen.getByTestId(testId).textContent;

describe("approval controls", () => {
  it("follow the card of their call as it mounts and unmounts", () => {
    const rows = [row("ap-1", "card-1"), row("ap-2")];
    const approvals = { cards: new MountedToolCards(), byCall: approvalsByCall(rows), onDecision: vi.fn() };
    const view = render(<Chat rows={rows} approvals={approvals} cards={[{ id: "card-1", label: "a" }]} />);
    expect(text("a")).toBe("controls:ap-1");
    // An approval that names no call always stays in the list.
    expect(text("list")).toBe("ap-2");

    // Scrolled away: the virtual list unmounts the card.
    view.rerender(<Chat rows={rows} approvals={approvals} cards={[]} />);
    expect(text("list")).toBe("ap-1,ap-2");

    view.rerender(<Chat rows={rows} approvals={approvals} cards={[{ id: "card-1", label: "a" }]} />);
    expect(text("a")).toBe("controls:ap-1");
    expect(text("list")).toBe("ap-2");
  });

  it("show in one card of a call, and pass to another card of it when the first unmounts", () => {
    const rows = [row("ap-1", "card-1")];
    const approvals = { cards: new MountedToolCards(), byCall: approvalsByCall(rows), onDecision: vi.fn() };
    const view = render(<Chat rows={rows} approvals={approvals} cards={[{ id: "card-1", label: "a" }, { id: "card-1", label: "b" }]} />);
    expect([text("a"), text("b"), text("list")]).toEqual(["controls:ap-1", "none", ""]);

    view.rerender(<Chat rows={rows} approvals={approvals} cards={[{ id: "card-1", label: "b" }]} />);
    expect([text("b"), text("list")]).toEqual(["controls:ap-1", ""]);
  });

  it("stay in the list when the card cannot take a decision, or a second approval names the same call", () => {
    const rows = [row("ap-1", "card-1"), row("ap-3", "card-1")];
    const approvals = { cards: new MountedToolCards(), byCall: approvalsByCall(rows), onDecision: vi.fn() };
    const view = render(<Chat rows={rows} approvals={approvals} cards={[{ id: "card-1", label: "a" }]} />);
    expect([text("a"), text("list")]).toEqual(["controls:ap-1", "ap-3"]);

    act(() => view.rerender(<Chat rows={rows} approvals={approvals} cards={[{ id: "card-1", label: "a", canDecide: false }]} />));
    expect([text("a"), text("list")]).toEqual(["none", "ap-1,ap-3"]);
  });
});
