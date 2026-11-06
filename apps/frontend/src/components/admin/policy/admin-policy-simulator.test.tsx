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
