// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PolicyMonitorSummaryResponse, PolicyRule, PolicySimulateResponse } from "@cogniplane/shared-types";
import { AdminPolicyRulesCard } from "./admin-policy-rules-card";
import { AdminPolicySimulator } from "./admin-policy-simulator";

afterEach(cleanup);

const rule = {
  ruleId: "pol_writes", tenantId: "t", name: "Block GitHub writes", description: null, priority: 1, enabled: true, effect: "block",
  conditions: { toolNames: ["github_write_file"] }, reason: null, createdBy: null, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z"
} as PolicyRule;

const evidence = {
  windowStart: "2026-09-20T12:00:00.000Z", windowEnd: "2026-09-27T12:00:00.000Z",
  totals: { block: 3, approvalInteractive: 0, approvalScheduled: 0, approvalUnknownContext: 0, total: 3 },
  rules: [{ ruleId: "pol_writes", currentRule: { name: "Block GitHub writes", enabled: true, effect: "block" }, counts: { block: 3, approvalInteractive: 0, approvalScheduled: 0, approvalUnknownContext: 0, total: 3 }, lastRecordedAt: "2026-09-26T10:00:00.000Z" }],
  excluded: { resourceChecks: 0, unrecognized: 0 }
} as PolicyMonitorSummaryResponse;

function mount(rules: PolicyRule[], extra: { evidence?: PolicyMonitorSummaryResponse; busyKey?: string } = {}) {
  const onDelete = vi.fn();
  render(<AdminPolicyRulesCard rules={rules} lintWarnings={[]} busyKey={extra.busyKey ?? null} onSave={async () => true} onDelete={onDelete} onReorder={() => {}} evidence={extra.evidence} />);
  return { onDelete };
}

it("says that no rules means every tool call is allowed", () => {
  mount([]);
  expect(screen.getByText("No rules. Every tool call is allowed.")).toBeTruthy();
});

it("shows each rule's Monitor matches with a link to them", () => {
  mount([rule], { evidence });
  const link = screen.getByRole("link", { name: "3 would-be blocks in 7 days for Block GitHub writes" });
  expect(link.getAttribute("href")).toContain("rule=pol_writes");
  expect(screen.getByText(/Block: tools: github_write_file\./)).toBeTruthy();
});

const second = { ...rule, ruleId: "pol_reads", name: "Allow reads", effect: "allow", priority: 2 } as PolicyRule;

it("edits a rule under its row and deletes it from the editor", () => {
  const { onDelete } = mount([rule, second]);
  const edit = screen.getByRole("button", { name: "Edit Block GitHub writes" });
  expect(screen.queryByRole("button", { name: "Delete rule" })).toBeNull();
  fireEvent.click(edit);
  expect(edit.getAttribute("aria-expanded")).toBe("true");
  const name = screen.getByLabelText("Name") as HTMLInputElement;
  expect(name.value).toBe("Block GitHub writes");
  expect(edit.closest("li")?.contains(name)).toBe(true);
  // Each checkbox group has a name that screen readers announce.
  expect(within(screen.getByRole("group", { name: "Severities" })).getAllByRole("checkbox").length).toBeGreaterThan(0);
  expect(within(screen.getByRole("group", { name: "Turn context" })).getAllByRole("checkbox").length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "Delete rule" }));
  expect(onDelete).toHaveBeenCalledWith("pol_writes");
});

it("keeps one editor open and never replaces unsaved edits", () => {
  mount([rule, second]);
  fireEvent.click(screen.getByRole("button", { name: "Edit Block GitHub writes" }));
  expect((screen.getByRole("button", { name: "Edit Allow reads" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole("button", { name: "New rule" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel", expanded: false }));
  expect(screen.queryByLabelText("Name")).toBeNull();
});

it("does not delete while a save is pending", () => {
  const props = { rules: [rule], lintWarnings: [], onSave: async () => true, onDelete: vi.fn(), onReorder: vi.fn() };
  const { rerender } = render(<AdminPolicyRulesCard {...props} busyKey={null} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit Block GitHub writes" }));
  rerender(<AdminPolicyRulesCard {...props} busyKey="submit" />);
  fireEvent.click(screen.getByRole("button", { name: "Delete rule" }));
  expect(props.onDelete).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Name").closest("fieldset")?.disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement).disabled).toBe(false);
});

it("reports a test result in one line without claiming the current mode", () => {
  const result: PolicySimulateResponse = { outcome: "block", matchedRuleId: "pol_writes", matchedRuleName: "Block GitHub writes", enforced: true, explanation: null };
  render(<AdminPolicySimulator result={result} simulating={false} onSimulate={() => {}} />);
  expect(screen.getByRole("status").textContent).toBe('Block. Matched "Block GitHub writes". In Enforce, the call is blocked. In Monitor, it is only recorded.');
});

it("says a scheduled run denies an approval rule", () => {
  const result: PolicySimulateResponse = { outcome: "require_approval", matchedRuleId: "pol_ask", matchedRuleName: "Ask first", enforced: true, explanation: null };
  const { rerender } = render(<AdminPolicySimulator result={null} simulating={false} onSimulate={() => {}} />);
  fireEvent.change(screen.getByLabelText("Tool name"), { target: { value: "github_write_file" } });
  fireEvent.click(screen.getByRole("button", { name: "Run test", hidden: true }));
  rerender(<AdminPolicySimulator result={result} simulating={false} onSimulate={() => {}} />);
  expect(screen.getByRole("status").textContent).toContain("a chat asks the user to approve it and a scheduled run denies it");
});

it("creates a rule, and closes the editor only when the save succeeds", async () => {
  const outcomes = [false, true];
  const onSave = vi.fn(async () => outcomes.shift()!);
  render(<AdminPolicyRulesCard rules={[rule, second]} lintWarnings={[]} busyKey={null} onSave={onSave} onDelete={() => {}} onReorder={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "New rule" }));
  // A rule needs a name before it can be created.
  expect((screen.getByRole("button", { name: "Create rule" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  Ask before deploys  " } });

  fireEvent.click(screen.getByRole("button", { name: "Create rule" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  expect(onSave).toHaveBeenCalledWith(null, expect.objectContaining({ name: "Ask before deploys", effect: "require_approval" }));
  // A failed save keeps the draft open for another try.
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("  Ask before deploys  ");

  fireEvent.click(screen.getByRole("button", { name: "Create rule" }));
  await waitFor(() => expect(screen.queryByLabelText("Name")).toBeNull());
  expect(onSave).toHaveBeenCalledTimes(2);
});

it("saves an edited rule under its own id", async () => {
  const onSave = vi.fn(async () => true);
  render(<AdminPolicyRulesCard rules={[rule, second]} lintWarnings={[]} busyKey={null} onSave={onSave} onDelete={() => {}} onReorder={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit Allow reads" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Allow all reads" } });

  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

  await waitFor(() => expect(screen.queryByLabelText("Name")).toBeNull());
  expect(onSave).toHaveBeenCalledWith("pol_reads", expect.objectContaining({ name: "Allow all reads", effect: "allow" }));
});

it("returns focus to the opener once the refresh after a save enables it again", async () => {
  let finish!: (ok: boolean) => void;
  const props = { lintWarnings: [], busyKey: null, onSave: () => new Promise<boolean>(resolve => { finish = resolve; }), onDelete: () => {}, onReorder: () => {} };
  const view = render(<AdminPolicyRulesCard rules={[rule, second]} {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit Allow reads" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  // The save invalidates the rules, so the card refreshes while the save settles.
  view.rerender(<AdminPolicyRulesCard rules={[rule, second]} {...props} refreshing />);
  await act(async () => finish(true));
  const opener = screen.getByRole("button", { name: "Edit Allow reads" }) as HTMLButtonElement;
  expect(opener.disabled).toBe(true);
  // Let the close frame run while the opener is still disabled.
  await act(() => new Promise(resolve => requestAnimationFrame(() => resolve(undefined))));
  expect(document.activeElement).not.toBe(opener);
  view.rerender(<AdminPolicyRulesCard rules={[rule, second]} {...props} />);
  await waitFor(() => expect(document.activeElement).toBe(opener));
});

it.each(["loading", "unavailable", "stale"] as const)("does not claim an empty policy is allowed during %s", (rulesState) => {
  render(<AdminPolicyRulesCard rules={[]} rulesState={rulesState} rulesError={rulesState === "loading" ? null : "Read failed"} lintWarnings={[]} busyKey={null} onSave={async () => true} onDelete={() => {}} onReorder={() => {}} />);
  expect(screen.queryByText("No rules. Every tool call is allowed.")).toBeNull();
  expect((screen.getByRole("button", { name: "New rule" }) as HTMLButtonElement).disabled).toBe(true);
});

it("keeps the retry button mounted and focused while a rule read recovers", () => {
  const props = { rules: [], lintWarnings: [], busyKey: null, onSave: async () => true, onDelete: () => {}, onReorder: () => {}, onRetryRules: vi.fn() };
  const { rerender } = render(<AdminPolicyRulesCard {...props} rulesState="unavailable" rulesError="Read failed" />);
  const retry = screen.getByRole("button", { name: "Retry rules" });
  retry.focus();
  fireEvent.click(retry);
  rerender(<AdminPolicyRulesCard {...props} rulesState="unavailable" rulesError="Read failed" refreshing />);
  expect(screen.getByRole("button", { name: "Retry rules" })).toBe(retry);
  expect(document.activeElement).toBe(retry);
  rerender(<AdminPolicyRulesCard {...props} rulesState="current" />);
  expect(screen.getByRole("button", { name: "Refresh rules" })).toBe(retry);
  expect(document.activeElement).toBe(retry);
});

it("keeps a failed delete draft and guards repeated clicks before props update", async () => {
  let finish!: (ok: boolean) => void;
  const onDelete = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  render(<AdminPolicyRulesCard rules={[rule]} lintWarnings={[]} busyKey={null} onSave={async () => true} onDelete={onDelete} onReorder={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit Block GitHub writes" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Retain this draft" } });
  const button = screen.getByRole("button", { name: "Delete rule" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(onDelete).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Deleting…" })).toBe(button);
  expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy();
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Retain this draft");
  finish(false);
  await waitFor(() => expect(screen.getByLabelText("Name").closest("fieldset")?.disabled).toBe(false));
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Retain this draft");
});

it("keeps warning retry focused and preserves the editor while warnings recover", () => {
  const props = { rules: [rule], lintWarnings: [], busyKey: null, onSave: async () => true, onDelete: vi.fn(), onReorder: vi.fn(), onRetryLint: vi.fn() };
  const { rerender } = render(<AdminPolicyRulesCard {...props} lintState="unavailable" lintError="Warnings offline" />);
  fireEvent.click(screen.getByRole("button", { name: "Edit Block GitHub writes" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Keep these edits" } });
  const retry = screen.getByRole("button", { name: "Retry warnings" });
  retry.focus();
  fireEvent.click(retry);
  rerender(<AdminPolicyRulesCard {...props} lintState="checking" />);
  expect(document.activeElement).toBe(retry);
  expect(screen.queryByText("No rule warnings found.")).toBeNull();
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Keep these edits");
  rerender(<AdminPolicyRulesCard {...props} lintState="current" />);
  expect(document.activeElement).toBe(retry);
  expect(screen.getByText("No rule warnings found.")).toBeTruthy();
});

it.each(["save", "delete"] as const)("keeps the %s owner focusable and places its failure beside the decisions", async operation => {
  let finish!: (ok: boolean) => void;
  const request = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  const props = { rules: [rule], lintWarnings: [], busyKey: null, onSave: request, onDelete: request, onReorder: vi.fn() };
  const { rerender } = render(<AdminPolicyRulesCard {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit Block GitHub writes" }));
  const owner = screen.getByRole("button", { name: operation === "save" ? "Save changes" : "Delete rule" });
  owner.focus();
  fireEvent.click(owner);
  fireEvent.click(owner);
  expect(request).toHaveBeenCalledTimes(1);
  expect((owner as HTMLButtonElement).disabled).toBe(false);
  expect(document.activeElement).toBe(owner);
  finish(false);
  await waitFor(() => expect(owner.getAttribute("aria-disabled")).toBe("false"));
  const scroll = vi.fn();
  const previous = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = scroll;
  try {
    rerender(<AdminPolicyRulesCard {...props} actionError="Rule action failed" />);
    const alert = screen.getByRole("alert");
    expect(owner.getAttribute("aria-describedby")).toBe(alert.id);
    expect(owner.parentElement?.parentElement?.contains(alert)).toBe(true);
    expect(scroll).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(owner);
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    scroll.mockClear();
    rerender(<AdminPolicyRulesCard {...props} actionError="Another failure" />);
    expect(scroll).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  } finally { Element.prototype.scrollIntoView = previous; }
});
