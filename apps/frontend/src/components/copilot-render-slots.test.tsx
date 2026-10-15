// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { afterEach, expect, it } from "vitest";

import { DeepAgentsBrowserAgent } from "../lib/agui/deep-agents-browser-agent";
import { AgentPlan, ToolCard } from "./copilot-render-slots";

afterEach(cleanup);

it("shows a running tool call collapsed, then its parameters when opened", () => {
  render(<ToolCard name="read_file" parameters={{ path: "a.md" }} status="executing" result={undefined} />);

  const toggle = screen.getByRole("button", { name: /read_file/ });
  expect(screen.getByText("running…")).toBeTruthy();
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText(/"path"/)).toBeNull();

  fireEvent.click(toggle);

  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  // No result yet, so only the parameters block shows, pretty-printed.
  const blocks = [...document.querySelectorAll("pre")].map((element) => element.textContent);
  expect(blocks).toEqual([JSON.stringify({ path: "a.md" }, null, 2)]);
});

it.each([
  ["inProgress", "running…"],
  ["executing", "running…"],
  ["complete", "done"]
] as const)("labels a %s call as %s", (status, label) => {
  render(<ToolCard name="read_file" parameters={{}} status={status} result={undefined} />);

  expect(screen.getByText(label)).toBeTruthy();
});

it.each(["failed", "declined", "interrupted"] as const)("labels a %s call by its outcome, also while its status is not complete", (outcome) => {
  render(<ToolCard name="search" parameters={{}} status="executing" result={undefined} outcome={outcome} />);

  expect(screen.getByText(outcome)).toBeTruthy();
  expect(screen.queryByText("running…")).toBeNull();
});

it("shows a finished call's string result as written, and hides empty parameters", () => {
  render(<ToolCard name="search" parameters={null} status="complete" result="3 matches" />);

  expect(screen.getByText("done")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /search/ }));

  const blocks = [...document.querySelectorAll("pre")].map((element) => element.textContent);
  expect(blocks).toEqual(["3 matches"]);
});

it("falls back to String() for a result JSON cannot serialize", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  render(<ToolCard name="loop" parameters="x" status="complete" result={circular} />);

  fireEvent.click(screen.getByRole("button", { name: /loop/ }));

  const blocks = [...document.querySelectorAll("pre")].map((element) => element.textContent);
  expect(blocks).toEqual(["x", "[object Object]"]);
});

it("renders the agent's plan from its state, only when it has text, and follows changes", async () => {
  const agent = new DeepAgentsBrowserAgent({ sessionId: "s-1" });
  agent.setState({ plan: "   " });
  render(
    <CopilotKitProvider agents__unsafe_dev_only={{ planAgent: agent }} enableInspector={false}>
      <div data-testid="plan-slot"><AgentPlan agentId="planAgent" /></div>
    </CopilotKitProvider>
  );
  expect(screen.getByTestId("plan-slot").textContent).toBe("");

  act(() => agent.setState({ plan: "  1. Read the file  " }));

  // SafeMarkdown loads its renderer lazily.
  expect(await screen.findByText("Read the file", {}, { timeout: 3_000 })).toBeTruthy();
});
