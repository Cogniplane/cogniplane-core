// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  mount([rule], { busyKey: "submit" });
  fireEvent.click(screen.getByRole("button", { name: "Edit Block GitHub writes" }));
  expect((screen.getByRole("button", { name: "Delete rule" }) as HTMLButtonElement).disabled).toBe(true);
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
