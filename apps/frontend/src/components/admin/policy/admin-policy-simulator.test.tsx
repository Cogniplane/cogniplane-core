// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PolicySimulateResponse } from "@cogniplane/shared-types";
import { AdminPolicySimulator } from "./admin-policy-simulator";

afterEach(cleanup);
const result: PolicySimulateResponse = { outcome: "block", matchedRuleId: "sample", matchedRuleName: "Sample block", enforced: false, explanation: "Old explanation" };

it("hides an old result and its explanation as soon as any input changes", () => {
  const onInputChange = vi.fn();
  render(<AdminPolicySimulator result={result} simulating={false} onSimulate={() => {}} onInputChange={onInputChange} />);
  fireEvent.change(screen.getByLabelText("Category / server"), { target: { value: "sample-category" } });
  expect(screen.getByRole("status").textContent).toBe("Inputs changed. Run a test for this tool call.");
  expect(screen.queryByText("Old explanation")).toBeNull();
  expect(onInputChange).toHaveBeenCalledTimes(1);
});

it("shows the failure beside the submitted input and retries the exact request", async () => {
  const onSimulate = vi.fn(async () => {});
  const { rerender } = render(<AdminPolicySimulator result={null} simulating={false} onSimulate={onSimulate} />);
  fireEvent.change(screen.getByLabelText("Tool name"), { target: { value: "  sample_write  " } });
  fireEvent.change(screen.getByLabelText("Category / server"), { target: { value: " sample-documents " } });
  fireEvent.click(screen.getByRole("button", { name: "Run test", hidden: true }));
  await Promise.resolve();
  const request = { toolName: "sample_write", category: "sample-documents", serverId: "sample-documents", severity: undefined, turnContext: null };
  expect(onSimulate).toHaveBeenCalledWith(request);
  rerender(<AdminPolicySimulator result={result} error="Sample evaluation failed" simulating={false} onSimulate={onSimulate} />);
  expect(screen.getByRole("alert", { hidden: true }).textContent).toBe("Sample evaluation failed");
  expect(screen.getByText(/Tested input: sample_write/)).toBeTruthy();
  expect(screen.queryByText("Old explanation")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry test", hidden: true }));
  expect(onSimulate).toHaveBeenLastCalledWith(request);
});

it("keeps the pending test owner focused and guards repeated activation", async () => {
  let finish!: () => void;
  const onSimulate = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const { rerender } = render(<AdminPolicySimulator result={null} simulating={false} onSimulate={onSimulate} />);
  fireEvent.click(screen.getByRole("button", { name: "Test a tool call" }));
  fireEvent.change(screen.getByLabelText("Tool name"), { target: { value: "sample_write" } });
  const owner = screen.getByRole("button", { name: "Run test" });
  owner.focus();
  fireEvent.click(owner);
  rerender(<AdminPolicySimulator result={null} simulating onSimulate={onSimulate} />);
  fireEvent.click(owner);
  expect(onSimulate).toHaveBeenCalledTimes(1);
  expect((owner as HTMLButtonElement).disabled).toBe(false);
  expect(document.activeElement).toBe(owner);
  await act(async () => finish());
  rerender(<AdminPolicySimulator result={null} simulating={false} error="Test failed" onSimulate={onSimulate} />);
  expect(screen.getByRole("button", { name: "Retry test" })).toBe(owner);
  expect(document.activeElement).toBe(owner);
});

it.each([
  { outcome: "allow", matchedRuleId: null, matchedRuleName: null, expected: "No Policy Center rule matched these inputs." },
  { outcome: "allow", matchedRuleId: "allow", matchedRuleName: "Allow reads", expected: 'Allow. Matched "Allow reads".' }
] as const)("limits an allow result to policy rules for $matchedRuleName", ({ expected, ...evaluation }) => {
  render(<AdminPolicySimulator result={{ ...evaluation, enforced: false, explanation: null }} simulating={false} onSimulate={vi.fn()} />);
  expect(screen.getByRole("status").textContent).toBe(expected);
  expect(screen.getByText(/This test checks Policy Center rules only\. Other approval settings still apply\./)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Review approval settings in Agent behavior" }).getAttribute("href")).toBe("/admin/capabilities");
  expect(screen.queryByText("Allowed. No rule matched.")).toBeNull();
});

it("rejects empty and whitespace-only native form submissions", () => {
  const onSimulate = vi.fn();
  render(<AdminPolicySimulator result={null} simulating={false} onSimulate={onSimulate} />);
  fireEvent.click(screen.getByRole("button", { name: "Test a tool call" }));
  const form = screen.getByRole("form", { name: "Test a tool call" });
  expect(fireEvent.submit(form)).toBe(false);
  fireEvent.change(screen.getByLabelText("Tool name"), { target: { value: "   " } });
  fireEvent.submit(form);
  expect((screen.getByRole("button", { name: "Run test" }) as HTMLButtonElement).disabled).toBe(true);
  expect(onSimulate).not.toHaveBeenCalled();
});

it.each(["category", "severity", "turn context"])("describes a missing %s without implying a wildcard test", async missing => {
  const previousScroll = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = vi.fn();
  try {
    const onSimulate = vi.fn(async () => {});
    const { rerender } = render(<AdminPolicySimulator result={null} simulating={false} onSimulate={onSimulate} />);
    fireEvent.click(screen.getByRole("button", { name: "Test a tool call" }));
    fireEvent.change(screen.getByLabelText("Tool name"), { target: { value: "github_write_file" } });
    if (missing !== "category") fireEvent.change(screen.getByLabelText("Category / server"), { target: { value: "github" } });
    if (missing !== "severity") {
      fireEvent.keyDown(screen.getByRole("combobox", { name: "Severity" }), { key: "Enter" });
      fireEvent.click(screen.getByRole("option", { name: "File change" }));
    }
    if (missing !== "turn context") {
      fireEvent.keyDown(screen.getByRole("combobox", { name: "Turn context" }), { key: "Enter" });
      fireEvent.click(screen.getByRole("option", { name: "Interactive" }));
    }
    fireEvent.submit(screen.getByRole("form", { name: "Test a tool call" }));
    await act(async () => {});
    expect(onSimulate).toHaveBeenCalledExactlyOnceWith({
      toolName: "github_write_file",
      category: missing === "category" ? null : "github",
      serverId: missing === "category" ? null : "github",
      severity: missing === "severity" ? undefined : "file_change",
      turnContext: missing === "turn context" ? null : "interactive"
    });
    expect(screen.getByText(/Tested input:/).textContent).toContain(`no ${missing}`);
    expect(screen.getByText(/Tested input:/).textContent).not.toContain("any");
    rerender(<AdminPolicySimulator result={{ outcome: "allow", matchedRuleId: null, matchedRuleName: null, enforced: false, explanation: null }} simulating={false} onSimulate={onSimulate} />);
    expect(screen.getByRole("status").textContent).toBe("No Policy Center rule matched these inputs.");
    expect(screen.getByText(/Rules that need a missing category, severity, or turn context are skipped/)).toBeTruthy();
  } finally { Element.prototype.scrollIntoView = previousScroll; }
});

it.each(["Tool name", "Category / server"])("submits from the form containing %s and locks repeated submissions before props update", async label => {
  let finish!: () => void;
  const onSimulate = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  render(<AdminPolicySimulator result={null} simulating={false} onSimulate={onSimulate} />);
  fireEvent.click(screen.getByRole("button", { name: "Test a tool call" }));
  fireEvent.change(screen.getByLabelText("Tool name"), { target: { value: " sample_write " } });
  const input = screen.getByLabelText(label) as HTMLInputElement;
  input.focus();
  const form = input.form!;
  expect(form).toBe(screen.getByRole("form", { name: "Test a tool call" }));
  expect(screen.getByRole("button", { name: "Run test" }).getAttribute("type")).toBe("submit");
  // jsdom does not perform Enter's implicit submission. Dispatch its submit event.
  fireEvent.submit(form);
  fireEvent.submit(form);
  fireEvent.click(screen.getByRole("button", { name: "Run test" }));
  expect(onSimulate).toHaveBeenCalledTimes(1);
  expect(onSimulate).toHaveBeenCalledWith({ toolName: "sample_write", category: null, serverId: null, severity: undefined, turnContext: null });
  expect(document.activeElement).toBe(input);
  await act(async () => finish());
});

it("invalidates an edited pending request and keeps its completion from unlocking the next run", async () => {
  const finish: Array<() => void> = [];
  const onSimulate = vi.fn(() => new Promise<void>(resolve => { finish.push(resolve); }));
  const onInputChange = vi.fn();
  const props = { result: null, simulating: false, onSimulate, onInputChange };
  const { rerender } = render(<AdminPolicySimulator {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Test a tool call" }));
  const tool = screen.getByLabelText("Tool name");
  const form = screen.getByRole("form", { name: "Test a tool call" });
  fireEvent.change(tool, { target: { value: "old_write" } });
  fireEvent.submit(form);
  rerender(<AdminPolicySimulator {...props} simulating />);
  expect(screen.getByRole("status").textContent).toBe("Testing the submitted tool call...");
  expect(screen.getByText(/Tested input: old_write/)).toBeTruthy();
  fireEvent.change(tool, { target: { value: "new_read" } });
  expect(onInputChange).toHaveBeenCalledTimes(2);
  rerender(<AdminPolicySimulator {...props} result={result} />);
  expect(screen.getByRole("status").textContent).toBe("Inputs changed. Run a test for this tool call.");
  expect(screen.queryByText("Old explanation")).toBeNull();
  expect(screen.queryByText(/Tested input:/)).toBeNull();
  rerender(<AdminPolicySimulator {...props} />);
  fireEvent.submit(form);
  expect(onSimulate).toHaveBeenCalledTimes(2);
  await act(async () => finish[0]!());
  fireEvent.submit(form);
  expect(onSimulate).toHaveBeenCalledTimes(2);
  expect(screen.getByText(/Tested input: new_read/)).toBeTruthy();
  await act(async () => finish[1]!());
});

it("focuses Tool name only when opening and keeps the draft when reopened", () => {
  const onSimulate = vi.fn();
  const { rerender } = render(<AdminPolicySimulator result={null} simulating={false} onSimulate={onSimulate} />);
  const trigger = screen.getByRole("button", { name: "Test a tool call" });
  expect(document.activeElement).toBe(document.body);
  trigger.focus();
  fireEvent.click(trigger);
  const tool = screen.getByLabelText("Tool name") as HTMLInputElement;
  expect(document.activeElement).toBe(tool);
  fireEvent.change(tool, { target: { value: "sample_write" } });
  const category = screen.getByLabelText("Category / server");
  category.focus();
  rerender(<AdminPolicySimulator result={result} simulating={false} onSimulate={onSimulate} />);
  expect(document.activeElement).toBe(category);
  fireEvent.click(trigger);
  expect(document.activeElement).toBe(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(trigger);
  expect(document.activeElement).toBe(tool);
  expect(tool.value).toBe("sample_write");
});

it("does not take focus from another control while opening or closing", () => {
  render(<><button>Other action</button><AdminPolicySimulator result={null} simulating={false} onSimulate={vi.fn()} /></>);
  const outside = screen.getByRole("button", { name: "Other action" });
  const trigger = screen.getByRole("button", { name: "Test a tool call" });
  outside.focus();
  fireEvent.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(outside);
  fireEvent.click(trigger);
  expect(document.activeElement).toBe(outside);
});

it("leaves focus on navigation and does not restore it after unmount", async () => {
  let finish!: () => void;
  const onSimulate = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const { unmount } = render(<AdminPolicySimulator result={null} simulating={false} onSimulate={onSimulate} />);
  fireEvent.click(screen.getByRole("button", { name: "Test a tool call" }));
  fireEvent.change(screen.getByLabelText("Tool name"), { target: { value: "sample_write" } });
  fireEvent.submit(screen.getByRole("form", { name: "Test a tool call" }));
  const navigation = screen.getByRole("link", { name: "Review approval settings in Agent behavior" });
  navigation.focus();
  expect(document.activeElement).toBe(navigation);
  unmount();
  const destination = document.createElement("button");
  document.body.append(destination);
  try {
    destination.focus();
    await act(async () => finish());
    expect(document.activeElement).toBe(destination);
  } finally { destination.remove(); }
});

it.each([
  { context: "interactive", label: "Interactive", expected: "In Enforce, the user must approve the call." },
  { context: "scheduled", label: "Scheduled / unattended", expected: "In Enforce, the call is denied, because nobody can approve a scheduled run." }
])("keeps the submitted $context approval context and invalidates later context edits", async ({ context, label, expected }) => {
  const previousScroll = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = vi.fn();
  try {
    const onSimulate = vi.fn(async () => {});
    const approval: PolicySimulateResponse = { ...result, outcome: "require_approval", matchedRuleName: "Ask first", explanation: null };
    const { rerender } = render(<AdminPolicySimulator result={null} simulating={false} onSimulate={onSimulate} />);
    fireEvent.click(screen.getByRole("button", { name: "Test a tool call" }));
    fireEvent.change(screen.getByLabelText("Tool name"), { target: { value: "sample_write" } });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Turn context" }), { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: label }));
    fireEvent.submit(screen.getByRole("form", { name: "Test a tool call" }));
    await act(async () => {});
    expect(onSimulate).toHaveBeenCalledWith(expect.objectContaining({ turnContext: context }));
    rerender(<AdminPolicySimulator result={approval} simulating={false} onSimulate={onSimulate} />);
    expect(screen.getByRole("status").textContent).toContain(expected);
    expect(screen.getByRole("status").textContent).toContain("In Monitor, it is only recorded.");
    expect(screen.getByText(new RegExp(`Tested input: .*${context} turn`))).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Turn context" }), { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: "Not supplied" }));
    expect(screen.getByRole("status").textContent).toBe("Inputs changed. Run a test for this tool call.");
    expect(screen.queryByText(/Tested input:/)).toBeNull();
  } finally { Element.prototype.scrollIntoView = previousScroll; }
});
