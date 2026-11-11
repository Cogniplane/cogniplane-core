// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect, useState, type ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { PolicyMonitorSummaryResponse, PolicyRule, PolicySimulateResponse } from "@cogniplane/shared-types";
import type { PolicyRuleSave, PolicyRuleSaveResult } from "./admin-policy-form.logic";
import { AdminPolicyRulesCard } from "./admin-policy-rules-card";
import { AdminPolicySimulator } from "./admin-policy-simulator";

afterEach(cleanup);

const rule = {
  ruleId: "pol_writes", tenantId: "t", name: "Block GitHub writes", description: null, priority: 1, enabled: true, effect: "block",
  conditions: { toolNames: ["github_write_file"] }, reason: null, createdBy: null, revision: 1, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z"
} as PolicyRule;

const saved = async (): Promise<PolicyRuleSaveResult> => "saved";

const evidence = {
  windowStart: "2026-09-20T12:00:00.000Z", windowEnd: "2026-09-27T12:00:00.000Z",
  totals: { block: 3, approvalInteractive: 0, approvalScheduled: 0, approvalUnknownContext: 0, total: 3 },
  rules: [{ ruleId: "pol_writes", currentRule: { name: "Block GitHub writes", enabled: true, effect: "block" }, counts: { block: 3, approvalInteractive: 0, approvalScheduled: 0, approvalUnknownContext: 0, total: 3 }, lastRecordedAt: "2026-09-26T10:00:00.000Z" }],
  excluded: { resourceChecks: 0, unrecognized: 0 }
} as PolicyMonitorSummaryResponse;

function mount(rules: PolicyRule[], extra: { evidence?: PolicyMonitorSummaryResponse; busyKey?: string } = {}) {
  const onDelete = vi.fn();
  render(<AdminPolicyRulesCard rules={rules} lintWarnings={[]} busyKey={extra.busyKey ?? null} onSave={saved} onDelete={onDelete} onReorder={() => {}} evidence={extra.evidence} />);
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
  const props = { rules: [rule], lintWarnings: [], onSave: saved, onDelete: vi.fn(), onReorder: vi.fn() };
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
  const outcomes: PolicyRuleSaveResult[] = ["failed", "saved"];
  const onSave = vi.fn(async (_save: PolicyRuleSave) => outcomes.shift()!);
  render(<AdminPolicyRulesCard rules={[rule, second]} lintWarnings={[]} busyKey={null} onSave={onSave} onDelete={() => {}} onReorder={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "New rule" }));
  // A rule needs a name before it can be created.
  expect((screen.getByRole("button", { name: "Create rule" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  Ask before deploys  " } });

  fireEvent.click(screen.getByRole("button", { name: "Create rule" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  expect(onSave).toHaveBeenCalledWith({ ruleId: null, input: expect.objectContaining({ name: "Ask before deploys", effect: "require_approval" }) });
  // A new rule has no revision to check.
  expect(onSave.mock.calls[0]![0]).not.toHaveProperty("input.expectedRevision");
  // A failed save keeps the draft open for another try.
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("  Ask before deploys  ");

  fireEvent.click(screen.getByRole("button", { name: "Create rule" }));
  await waitFor(() => expect(screen.queryByLabelText("Name")).toBeNull());
  expect(onSave).toHaveBeenCalledTimes(2);
});

it("saves an edited rule under its own id, with the revision that the editor opened", async () => {
  const onSave = vi.fn(saved);
  render(<AdminPolicyRulesCard rules={[rule, second]} lintWarnings={[]} busyKey={null} onSave={onSave} onDelete={() => {}} onReorder={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit Allow reads" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Allow all reads" } });

  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

  await waitFor(() => expect(screen.queryByLabelText("Name")).toBeNull());
  expect(onSave).toHaveBeenCalledWith({ ruleId: "pol_reads", patch: expect.objectContaining({ name: "Allow all reads", effect: "allow", expectedRevision: 1 }) });
});

it("returns focus to the opener once the refresh after a save enables it again", async () => {
  let finish!: (ok: boolean) => void;
  const props = { lintWarnings: [], busyKey: null, onSave: () => new Promise<PolicyRuleSaveResult>(resolve => { finish = (ok) => resolve(ok ? "saved" : "failed"); }), onDelete: () => {}, onReorder: () => {} };
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
  render(<AdminPolicyRulesCard rules={[]} rulesState={rulesState} rulesError={rulesState === "loading" ? null : "Read failed"} lintWarnings={[]} busyKey={null} onSave={saved} onDelete={() => {}} onReorder={() => {}} />);
  expect(screen.queryByText("No rules. Every tool call is allowed.")).toBeNull();
  expect((screen.getByRole("button", { name: "New rule" }) as HTMLButtonElement).disabled).toBe(true);
});

it("keeps the retry button mounted and focused while a rule read recovers", () => {
  const props = { rules: [], lintWarnings: [], busyKey: null, onSave: saved, onDelete: () => {}, onReorder: () => {}, onRetryRules: vi.fn() };
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
  render(<AdminPolicyRulesCard rules={[rule]} lintWarnings={[]} busyKey={null} onSave={saved} onDelete={onDelete} onReorder={() => {}} />);
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
  const props = { rules: [rule], lintWarnings: [], busyKey: null, onSave: saved, onDelete: vi.fn(), onReorder: vi.fn(), onRetryLint: vi.fn() };
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
  const props = { rules: [rule], lintWarnings: [], busyKey: null, onSave: async () => (await request()) ? "saved" as const : "failed" as const,
    onDelete: request, onReorder: vi.fn() };
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

// ── Stale edits ──────────────────────────────────────────────────────────────
// Admin A opens an allow rule that is off. Admin B turns it on as a block rule
// (revision 2). A's save names revision 1, so the server refuses it.

type CardProps = ComponentProps<typeof AdminPolicyRulesCard>;
type ListState = Pick<CardProps, "rules" | "rulesState" | "rulesError" | "refreshing">;

const allowOff = {
  ...rule, ruleId: "pol_exports", name: "Allow exports", effect: "allow", enabled: false, priority: 10,
  conditions: { toolNames: ["export_customers"] }, revision: 1
} as PolicyRule;
const blockOn = { ...allowOff, effect: "block", enabled: true, revision: 2, updatedAt: "2026-09-02T00:00:00Z" } as PolicyRule;

/** The card with the rule list that the hook would give it. `setList` stands in for a read of the rules. */
let setList!: (next: Partial<ListState>) => void;
function Harness(props: Omit<CardProps, keyof ListState> & { initial: PolicyRule[] }) {
  const { initial, ...card } = props;
  const [list, setState] = useState<ListState>({ rules: initial, rulesState: "current", rulesError: null, refreshing: false });
  useEffect(() => {
    setList = (next) => setState((current) => ({ ...current, ...next }));
  }, []);
  return <AdminPolicyRulesCard {...card} {...list} />;
}

function mountEditor(onSave: CardProps["onSave"], extra: Partial<CardProps> = {}) {
  render(<Harness initial={[allowOff]} lintWarnings={[]} busyKey={null} onSave={onSave} onDelete={() => {}} onReorder={() => {}} {...extra} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit Allow exports" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Allow customer exports" } });
}

const nameValue = () => (screen.getByLabelText("Name") as HTMLInputElement).value;
const saveButton = () => screen.getByRole("button", { name: "Save changes" });
const comparison = () => screen.queryByRole("table", { name: "Saved rule and your draft" });
function comparisonRows(): string[][] {
  return within(comparison()!).getAllByRole("row").slice(1)
    .map((row) => Array.from(row.querySelectorAll("th, td"), (cell) => cell.textContent ?? ""));
}
async function click(name: string) {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name })); });
}

it("keeps the draft after a refused save, shows the saved rule next to it, and saves only after a choice", async () => {
  let finish!: (result: PolicyRuleSaveResult) => void;
  const onSave = vi.fn((_save: PolicyRuleSave) => new Promise<PolicyRuleSaveResult>((resolve) => { finish = resolve; }));
  mountEditor(onSave);

  fireEvent.click(saveButton());
  expect(onSave).toHaveBeenLastCalledWith({ ruleId: "pol_exports", patch: {
    name: "Allow customer exports", enabled: false, effect: "allow", conditions: { toolNames: ["export_customers"] }, reason: null,
    expectedRevision: 1
  } });
  // The hook reads the rules again before it answers. Nothing is compared while the save is pending.
  act(() => setList({ rules: [blockOn] }));
  expect(comparison()).toBeNull();
  await act(async () => finish("conflict"));

  expect(nameValue()).toBe("Allow customer exports");
  expect(screen.getByRole("alert").textContent).toContain("Someone changed this rule after you opened it.");
  expect(comparisonRows()).toEqual([
    ["NameChanged by you", "Allow exports", "Allow customer exports"],
    ["EffectChanged by someone else", "Block", "Allow"],
    ["EnabledChanged by someone else", "On", "Off"]
  ]);
  // Save waits for a choice.
  expect(saveButton().getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(saveButton());
  expect(onSave).toHaveBeenCalledTimes(1);

  // An edit made during the review stays.
  fireEvent.change(screen.getByLabelText("Explanation shown to the user (optional)"), { target: { value: "Exports go to the CRM." } });
  await click("Keep my changes");
  expect(comparison()).toBeNull();
  expect(nameValue()).toBe("Allow customer exports");
  expect((screen.getByLabelText("Enabled") as HTMLInputElement).checked).toBe(true);
  expect(document.activeElement).toBe(saveButton());

  onSave.mockResolvedValueOnce("saved");
  await click("Save changes");
  expect(onSave).toHaveBeenLastCalledWith({ ruleId: "pol_exports", patch: {
    name: "Allow customer exports", enabled: true, effect: "block", conditions: { toolNames: ["export_customers"] },
    reason: "Exports go to the CRM.", expectedRevision: 2
  } });
  await waitFor(() => expect(screen.queryByLabelText("Name")).toBeNull());
});

it("never takes a newer revision from a list refresh on its own", async () => {
  const onSave = vi.fn(saved);
  mountEditor(onSave);

  // A background read of the rules has B's change.
  act(() => setList({ rules: [blockOn] }));
  expect(comparisonRows()).toHaveLength(3);
  expect(saveButton().getAttribute("aria-disabled")).toBe("true");
  await click("Save changes");
  expect(onSave).not.toHaveBeenCalled();

  await click("Use the saved rule");
  expect(nameValue()).toBe("Allow exports");
  expect((screen.getByLabelText("Enabled") as HTMLInputElement).checked).toBe(true);
  await click("Save changes");
  expect(onSave).toHaveBeenCalledWith({ ruleId: "pol_exports", patch: {
    name: "Allow exports", enabled: true, effect: "block", conditions: { toolNames: ["export_customers"] }, reason: null, expectedRevision: 2
  } });
});

it("compares again when the rule changed again before the next save", async () => {
  const third = { ...blockOn, name: "Block all exports", revision: 3 } as PolicyRule;
  const onSave = vi.fn(async (_save: PolicyRuleSave): Promise<PolicyRuleSaveResult> => "conflict")
    .mockImplementationOnce(async () => { setList({ rules: [blockOn] }); return "conflict"; })
    .mockImplementationOnce(async () => { setList({ rules: [third] }); return "conflict"; })
    .mockImplementationOnce(saved);
  mountEditor(onSave);

  await click("Save changes");
  await click("Keep my changes");
  await click("Save changes");
  expect(onSave.mock.calls[1]![0]).toMatchObject({ patch: { expectedRevision: 2 } });
  // The second refusal shows revision 3 against the draft that started from revision 2.
  expect(comparisonRows()).toEqual([["NameChanged by you and someone else", "Block all exports", "Allow customer exports"]]);
  expect(saveButton().getAttribute("aria-disabled")).toBe("true");

  await click("Keep my changes");
  await click("Save changes");
  expect(onSave).toHaveBeenCalledTimes(3);
  expect(onSave.mock.calls[2]![0]).toMatchObject({ patch: { name: "Allow customer exports", effect: "block", enabled: true, expectedRevision: 3 } });
});

it("keeps the draft and blocks the save while the saved rule cannot be loaded", async () => {
  const onRetryRules = vi.fn();
  const onSave = vi.fn(async (): Promise<PolicyRuleSaveResult> => {
    setList({ rulesState: "stale", rulesError: "Network error." });
    return "conflict";
  });
  mountEditor(onSave, { onRetryRules });

  await click("Save changes");
  expect(nameValue()).toBe("Allow customer exports");
  expect(screen.getByText("Could not load the saved rule.")).toBeTruthy();
  expect(comparison()).toBeNull();
  expect(saveButton().getAttribute("aria-disabled")).toBe("true");
  await click("Load the saved rule");
  expect(onRetryRules).toHaveBeenCalledTimes(1);

  act(() => setList({ refreshing: true }));
  expect(screen.getByText("Loading the saved rule...")).toBeTruthy();
  act(() => setList({ rules: [blockOn], rulesState: "current", rulesError: null, refreshing: false }));
  expect(comparisonRows()).toHaveLength(3);
  expect(nameValue()).toBe("Allow customer exports");
});

it("keeps the draft of a rule that was deleted, blocks its save, and can create it as a new rule", async () => {
  const onSave = vi.fn(async (_save: PolicyRuleSave): Promise<PolicyRuleSaveResult> => {
    setList({ rules: [] });
    return "missing";
  });
  mountEditor(onSave);

  await click("Save changes");
  expect(nameValue()).toBe("Allow customer exports");
  expect(screen.getByRole("alert").textContent).toContain("Someone deleted this rule after you opened it.");
  expect(saveButton().getAttribute("aria-disabled")).toBe("true");
  await click("Save changes");
  expect(onSave).toHaveBeenCalledTimes(1);

  await click("Create it as a new rule");
  onSave.mockResolvedValueOnce("saved");
  await click("Create rule");
  expect(onSave).toHaveBeenLastCalledWith({ ruleId: null, input: {
    name: "Allow customer exports", enabled: false, effect: "allow", conditions: { toolNames: ["export_customers"] }, reason: null
  } });
  await waitFor(() => expect(screen.queryByLabelText("Name")).toBeNull());
});

it("keeps an open editor when a list refresh no longer has its rule", () => {
  mountEditor(vi.fn(saved));
  act(() => setList({ rules: [] }));
  expect(nameValue()).toBe("Allow customer exports");
  expect(screen.getByRole("alert").textContent).toContain("Someone deleted this rule after you opened it.");
  fireEvent.click(screen.getByRole("button", { name: "Cancel", expanded: false }));
  expect(screen.queryByLabelText("Name")).toBeNull();
  expect(screen.getByText("No rules. Every tool call is allowed.")).toBeTruthy();
});

it("does not compare its own save that the list shows before the save answers", async () => {
  let finish!: (result: PolicyRuleSaveResult) => void;
  mountEditor(vi.fn(() => new Promise<PolicyRuleSaveResult>((resolve) => { finish = resolve; })));
  fireEvent.click(saveButton());
  act(() => setList({ rules: [{ ...allowOff, name: "Allow customer exports", revision: 2 } as PolicyRule] }));
  expect(screen.queryByRole("alert")).toBeNull();
  await act(async () => finish("saved"));
  await waitFor(() => expect(screen.queryByLabelText("Name")).toBeNull());
  expect(screen.queryByRole("alert")).toBeNull();
});
