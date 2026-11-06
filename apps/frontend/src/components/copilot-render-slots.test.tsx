// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { afterEach, expect, it } from "vitest";

import { DeepAgentsBrowserAgent } from "../lib/agui/deep-agents-browser-agent";
import { AgentPlan, ToolCard } from "./copilot-render-slots";

afterEach(cleanup);

const blocks = () => [...document.querySelectorAll("pre")].map((element) => element.textContent);

it("shows a running call with its action and target, collapsed, then its input when opened", () => {
  render(<ToolCard name="read_file" parameters={{ file_path: "/docs/a.md" }} status="executing" result={undefined} />);

  const toggle = screen.getByRole("button", { name: /Read file/ });
  expect(toggle.textContent).toContain("/docs/a.md");
  expect(screen.getByText("running…")).toBeTruthy();
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.hasAttribute("aria-controls")).toBe(false);
  expect(screen.queryByText(/"file_path"/)).toBeNull();

  fireEvent.click(toggle);

  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  // The details name the exact tool. No result yet, so only the input shows, pretty-printed.
  expect(document.getElementById(toggle.getAttribute("aria-controls")!)?.textContent).toContain("read_file");
  expect(screen.getByText("Input")).toBeTruthy();
  expect(screen.queryByText("Result")).toBeNull();
  expect(blocks()).toEqual([JSON.stringify({ file_path: "/docs/a.md" }, null, 2)]);
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

it("shows the result of a built-in text tool without opening the card, in a box that a keyboard can scroll", () => {
  render(<ToolCard name="execute" parameters={{ command: "pnpm test" }} status="complete" result={"PASS a\nPASS b"} />);

  expect(screen.getByRole("button", { name: /Run command/ }).textContent).toContain("pnpm test");
  const result = screen.getByRole("group", { name: "Result of Run command" });
  expect(result.textContent).toBe("PASS a\nPASS b");
  expect(result.getAttribute("tabindex")).toBe("0");
  expect(result.className).toContain("overflow-auto");
  expect(screen.getByRole("button", { name: /Run command/ }).getAttribute("aria-expanded")).toBe("false");
});

it.each([["0"], ["false"], [0], [false]])("shows the result %j as a result, not as nothing", (result) => {
  render(<ToolCard name="execute" parameters={{ command: "echo" }} status="complete" result={result} />);

  expect(screen.getByRole("group", { name: "Result of Run command" }).textContent).toBe(String(result));
  expect(screen.queryByText("No output.")).toBeNull();
});

it("says so when a text tool returned nothing, and shows nothing for a call without a result", () => {
  const { unmount } = render(<ToolCard name="grep" parameters={{ pattern: "x" }} status="complete" result="  " />);
  expect(screen.getByText("No output.")).toBeTruthy();
  expect(screen.queryByRole("group")).toBeNull();
  unmount();

  render(<ToolCard name="grep" parameters={{ pattern: "x" }} status="executing" result={undefined} />);
  expect(screen.queryByText("No output.")).toBeNull();
  expect(screen.queryByRole("group")).toBeNull();
});

it("shows the first part of a long result and keeps all of it in the details", () => {
  const long = `${"line\n".repeat(600)}END`;
  render(<ToolCard name="read_file" parameters={{ file_path: "/big.log" }} status="complete" result={long} />);

  const shown = screen.getByRole("group", { name: "Result of Read file" }).textContent!;
  expect(shown.length).toBeLessThan(long.length);
  expect(shown).not.toContain("END");
  expect(screen.getByText(/Open the card to see all of it/)).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: /Read file/ }));

  // The details hold all of the result, and the preview steps aside.
  expect(screen.queryByRole("group", { name: "Result of Read file" })).toBeNull();
  expect(screen.getByRole("group", { name: "Result" }).textContent).toBe(long);
  expect(screen.getByRole("group", { name: "Input" })).toBeTruthy();
});

it("shows the message of a failed or declined call without opening the card", () => {
  const failed = render(<ToolCard name="search" parameters={{}} status="complete" result="Quota exceeded" outcome="failed" />);
  expect(screen.getByRole("group", { name: "Result of Search" }).textContent).toBe("Quota exceeded");
  failed.unmount();

  render(<ToolCard name="execute" parameters={{ command: "rm x" }} status="complete" result="User denied permission." outcome="declined" />);
  expect(screen.getByRole("group", { name: "Result of Run command" }).textContent).toBe("User denied permission.");
  expect(screen.getByText("declined")).toBeTruthy();
});

it("says when a failed call gave no message, and shows no result for an interrupted call", () => {
  const failed = render(<ToolCard name="search" parameters={{}} status="complete" result="" outcome="failed" />);
  expect(screen.getByText("The tool gave no message.")).toBeTruthy();
  failed.unmount();

  render(<ToolCard name="execute" parameters={{ command: "sleep 99" }} status="executing" result="partial" outcome="interrupted" />);
  expect(screen.queryByRole("group")).toBeNull();
  expect(screen.getByText("interrupted")).toBeTruthy();
});

it("says what an interrupted call means, and says it for no other call", () => {
  const note = "The turn stopped before this tool gave a result. The action can be done, partly done, or not started. Check before you repeat it.";
  const interrupted = render(<ToolCard name="execute" parameters={{ command: "sleep 20" }} status="executing" result={undefined} outcome="interrupted" />);
  expect(screen.getByText(note)).toBeTruthy();
  // It is not a failure: the card names no error and gives no result.
  expect(screen.queryByText("failed")).toBeNull();
  expect(screen.queryByText("The tool gave no message.")).toBeNull();
  interrupted.unmount();

  for (const outcome of ["failed", "declined", undefined] as const) {
    const other = render(<ToolCard name="execute" parameters={{ command: "x" }} status={outcome ? "complete" : "executing"} result="out" outcome={outcome} />);
    expect(screen.queryByText(note)).toBeNull();
    other.unmount();
  }
});

it("keeps the name and the raw result for a tool it does not know, and shows no result in the card", () => {
  render(<ToolCard name="jira_get_issue" parameters={{ issueIdOrKey: "ABC-1" }} status="complete" result={'{"key":"ABC-1"}'} />);

  const toggle = screen.getByRole("button", { name: /Jira get issue/ });
  expect(toggle.textContent).not.toContain("ABC-1");
  expect(screen.queryByRole("group")).toBeNull();

  fireEvent.click(toggle);

  expect(screen.getByText("jira_get_issue")).toBeTruthy();
  expect(blocks()).toEqual([JSON.stringify({ issueIdOrKey: "ABC-1" }, null, 2), '{"key":"ABC-1"}']);
});

it("shows a finished call's string result as written, and hides empty parameters", () => {
  render(<ToolCard name="search" parameters={null} status="complete" result="3 matches" />);

  expect(screen.getByText("done")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Search/ }));

  expect(blocks()).toEqual(["3 matches"]);
});

it("marks an empty result in the details", () => {
  render(<ToolCard name="search" parameters={null} status="complete" result="" />);

  fireEvent.click(screen.getByRole("button", { name: /Search/ }));

  expect(blocks()).toEqual([]);
  expect(screen.getByText("Empty.")).toBeTruthy();
});

it("falls back to String() for a result JSON cannot serialize", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  render(<ToolCard name="loop" parameters="x" status="complete" result={circular} />);

  fireEvent.click(screen.getByRole("button", { name: /Loop/ }));

  expect(blocks()).toEqual(["x", "[object Object]"]);
});

it("renders untrusted text as text: no markup, no link, no control characters in the target", () => {
  const html = '<img src=x onerror="alert(1)"><a href="https://evil.example">open</a>';
  render(<ToolCard name="execute" parameters={{ command: `echo \u202E${html}\nnext` }} status="complete" result={html} />);

  expect(document.querySelector("img")).toBeNull();
  expect(document.querySelector("a")).toBeNull();
  expect(screen.getByRole("group", { name: "Result of Run command" }).textContent).toBe(html);
  const target = screen.getByRole("button", { name: /Run command/ }).textContent!;
  expect(target).toContain("echo <img");
  expect(target).not.toContain("\u202E");
  expect(target).not.toContain("\n");
});

it("keeps a long target on one truncated line", () => {
  render(<ToolCard name="execute" parameters={{ command: "x".repeat(5_000) }} status="executing" result={undefined} />);

  const target = screen.getByRole("button", { name: /Run command/ }).querySelector(".truncate.font-mono")!;
  expect(target.textContent!.length).toBeLessThanOrEqual(120);
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
