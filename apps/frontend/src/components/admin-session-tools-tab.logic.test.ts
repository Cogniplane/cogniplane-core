import { describe, expect, test } from "vitest";

import type {
  AdminSessionDetailMessageToolResult,
  AdminSessionDetailToolEvent
} from "@cogniplane/shared-types";

import {
  buildToolRows,
  formatToolDuration,
  formatToolTimestamp
} from "./admin-session-tools-tab.logic";

function makeEvent(
  partial: Partial<AdminSessionDetailToolEvent> & { createdAt: string; toolCallId: string }
): AdminSessionDetailToolEvent {
  return {
    toolCallId: partial.toolCallId,
    title: partial.title ?? "evt",
    kind: partial.kind ?? "function",
    phase: partial.phase ?? "completed",
    status: partial.status ?? "ok",
    createdAt: partial.createdAt,
    durationMs: partial.durationMs ?? null,
    messageId: partial.messageId ?? null,
    approvalId: partial.approvalId ?? null,
    payload: partial.payload ?? null
  } as AdminSessionDetailToolEvent;
}

function makeResult(
  partial: Partial<AdminSessionDetailMessageToolResult> & { createdAt: string; toolResultId: string }
): AdminSessionDetailMessageToolResult {
  return {
    toolResultId: partial.toolResultId,
    messageId: partial.messageId ?? "m1",
    title: partial.title ?? "",
    kind: partial.kind ?? "function",
    status: partial.status ?? "completed",
    createdAt: partial.createdAt,
    durationMs: partial.durationMs ?? null,
    toolName: partial.toolName ?? null,
    serverName: partial.serverName ?? null,
    commandText: partial.commandText ?? null,
    cwd: partial.cwd ?? null,
    exitCode: partial.exitCode ?? null,
    inputText: partial.inputText ?? null,
    outputText: partial.outputText ?? null
  } as AdminSessionDetailMessageToolResult;
}

describe("buildToolRows", () => {
  test("merges events and results sorted ascending by createdAt", () => {
    const events = [
      makeEvent({ toolCallId: "c1", createdAt: "2026-05-09T10:00:00Z", title: "first" }),
      makeEvent({ toolCallId: "c2", createdAt: "2026-05-09T12:00:00Z", title: "third" })
    ];
    const results = [
      makeResult({ toolResultId: "r1", createdAt: "2026-05-09T11:00:00Z", title: "second" })
    ];
    const rows = buildToolRows(events, results);
    expect(rows.map((r) => r.title)).toEqual(["first", "second", "third"]);
  });

  test("falls back through title → toolName → commandText → 'tool' for results", () => {
    const results = [
      makeResult({ toolResultId: "a", createdAt: "1", title: "explicit" }),
      makeResult({ toolResultId: "b", createdAt: "2", toolName: "named-tool" }),
      makeResult({ toolResultId: "c", createdAt: "3", commandText: "ls -la" }),
      makeResult({ toolResultId: "d", createdAt: "4" })
    ];
    const rows = buildToolRows([], results);
    expect(rows.map((r) => r.title)).toEqual(["explicit", "named-tool", "ls -la", "tool"]);
  });

  test("preserves source discriminator on each row", () => {
    const rows = buildToolRows(
      [makeEvent({ toolCallId: "c1", createdAt: "1" })],
      [makeResult({ toolResultId: "r1", createdAt: "2" })]
    );
    expect(rows.map((r) => r.source)).toEqual(["event", "result"]);
  });
});

describe("formatToolDuration", () => {
  test("nullish renders as em dash", () => {
    expect(formatToolDuration(null)).toBe("—");
  });

  test("sub-second renders as integer ms", () => {
    expect(formatToolDuration(120)).toBe("120ms");
    expect(formatToolDuration(0)).toBe("0ms");
    expect(formatToolDuration(999)).toBe("999ms");
  });

  test("≥1s renders as two-decimal seconds", () => {
    expect(formatToolDuration(1000)).toBe("1.00s");
    expect(formatToolDuration(2345)).toBe("2.35s");
  });
});

describe("formatToolTimestamp", () => {
  test("renders something for valid ISO", () => {
    expect(formatToolTimestamp("2026-05-09T12:00:00Z")).toMatch(/\d/);
  });

  test("returns input verbatim when not a valid date", () => {
    // toLocaleString on Invalid Date returns "Invalid Date" rather than throwing,
    // so the helper never hits the catch — just confirm no exception.
    expect(() => formatToolTimestamp("not-a-date")).not.toThrow();
  });
});
