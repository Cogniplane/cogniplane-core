// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { AdminSessionDetailMessageToolResult, AdminSessionDetailToolEvent } from "@cogniplane/shared-types";

import { PILL_BLUE, PILL_GRAY, PILL_RED } from "../../../lib/ui-tokens";
import { AdminSessionToolsTab } from "./admin-session-tools-tab";

afterEach(cleanup);

function toolEvent(overrides: Partial<AdminSessionDetailToolEvent>): AdminSessionDetailToolEvent {
  return {
    toolCallId: "call-1", messageId: null, approvalId: null, kind: "function", title: "web_search",
    phase: "completed", status: "ok", durationMs: 120, payload: null, createdAt: "2026-10-01T10:00:00.000Z",
    ...overrides
  };
}

function toolResult(overrides: Partial<AdminSessionDetailMessageToolResult>): AdminSessionDetailMessageToolResult {
  return {
    toolResultId: "result-1", messageId: "msg-1", kind: "command", title: "Run tests", status: "completed",
    serverName: "", toolName: "", commandText: "", inputText: "", cwd: "", outputText: "", exitCode: null,
    durationMs: 2500, createdAt: "2026-10-01T10:01:00.000Z", ...overrides
  };
}

it("says when the session called no tools", () => {
  render(<AdminSessionToolsTab toolEvents={[]} messageToolResults={[]} />);

  expect(screen.getByText("No tool invocations in this session.")).toBeTruthy();
});

it("shows a tool event's ids, and its payload only when it has content", () => {
  render(<AdminSessionToolsTab
    toolEvents={[
      toolEvent({ toolCallId: "call-1", title: "web_search", messageId: "msg-9", approvalId: "ap-1", payload: { query: "q3" } }),
      toolEvent({ toolCallId: "call-2", title: "read_file", payload: {}, createdAt: "2026-10-01T10:02:00.000Z" })
    ]}
    messageToolResults={[]}
  />);

  expect(screen.getByText("call-1")).toBeTruthy();
  expect(screen.getByText("msg-9")).toBeTruthy();
  expect(screen.getByText("ap-1")).toBeTruthy();
  expect(screen.getByText(/"query": "q3"/)).toBeTruthy();
  // The second event has an empty payload and no message or approval.
  expect(screen.getAllByText("Payload (redacted at write time)")).toHaveLength(1);
  expect(screen.getAllByText("Message ID:")).toHaveLength(1);
  expect(screen.getAllByText("Approval ID:")).toHaveLength(1);
});

it("shows a command result's details, including an exit code of 0", () => {
  render(<AdminSessionToolsTab
    toolEvents={[]}
    messageToolResults={[
      toolResult({ toolResultId: "result-1", toolName: "shell", commandText: "pnpm test", cwd: "/work", exitCode: 0, inputText: "stdin text", outputText: "all passed", serverName: "sandbox" }),
      toolResult({ toolResultId: "result-2", title: "Other", createdAt: "2026-10-01T10:03:00.000Z" })
    ]}
  />);

  expect(screen.getByText("result-1")).toBeTruthy();
  expect(screen.getByText("shell")).toBeTruthy();
  expect(screen.getByText("pnpm test").tagName).toBe("CODE");
  expect(screen.getByText("/work")).toBeTruthy();
  expect(screen.getByText("0")).toBeTruthy();
  expect(screen.getByText("stdin text")).toBeTruthy();
  expect(screen.getByText("all passed")).toBeTruthy();
  expect(screen.getByText("sandbox").className).toBe(PILL_GRAY);
  // The second result has no optional fields.
  for (const label of ["Tool name:", "Command:", "cwd:", "Exit code:"]) expect(screen.getAllByText(label)).toHaveLength(1);
  expect(screen.getAllByText(/redacted at write time/)).toHaveLength(2);
});

it("colors failed and declined calls red and completed ones blue", () => {
  render(<AdminSessionToolsTab
    toolEvents={[
      toolEvent({ title: "Event failed", phase: "failed", status: "error" }),
      toolEvent({ toolCallId: "call-2", title: "Event done", phase: "completed", status: "ok" })
    ]}
    messageToolResults={[
      toolResult({ toolResultId: "r1", title: "Declined", status: "declined" }),
      toolResult({ toolResultId: "r2", title: "Done", status: "completed" }),
      toolResult({ toolResultId: "r3", title: "Waiting", status: "pending" })
    ]}
  />);

  expect(screen.getByText("failed").className).toBe(PILL_RED);
  expect(screen.getByText("declined").className).toBe(PILL_RED);
  // One completed event and one completed result.
  expect(screen.getAllByText("completed").map((pill) => pill.className)).toEqual([PILL_BLUE, PILL_BLUE]);
  expect(screen.getByText("pending").className).toBe(PILL_GRAY);
});

it("filters calls by title", () => {
  render(<AdminSessionToolsTab
    toolEvents={[toolEvent({ title: "web_search" })]}
    messageToolResults={[toolResult({ title: "Run tests" })]}
  />);
  const filter = screen.getByLabelText("Filter by tool");

  fireEvent.change(filter, { target: { value: " WEB " } });
  expect(screen.getByText("web_search")).toBeTruthy();
  expect(screen.queryByText("Run tests")).toBeNull();

  fireEvent.change(filter, { target: { value: "deploy" } });
  expect(screen.getByText("No tools match this filter.")).toBeTruthy();
});
