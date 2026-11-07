// What a finished turn saves for a tool call that never returned. Every turn
// keeps it `in_progress`, however the turn ended, and history shows it as
// interrupted, as the live card does once the turn settles (issue #16). Only a
// failure that the tool reported is saved as `failed`. The interactive writer
// and the scheduler both finish a turn through `finalize`, with the outcome from
// the events or an override, so both are covered here.

import { EventType, type BaseEvent } from "@ag-ui/client";
import { describe, expect, it } from "vitest";

import { toAguiMessages, type HistoryMessage } from "./agui-history.js";
import { interruptedResult } from "./deep-agents/agui-events.js";
import { TurnTranscript, type TurnOutcome, type TurnTranscriptMessages } from "./turn-transcript.js";

const started = (id: string): BaseEvent[] => [
  { type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: "execute" } as BaseEvent,
  { type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: '{"command":"sleep 20"}' } as BaseEvent,
  { type: EventType.TOOL_CALL_END, toolCallId: id } as BaseEvent
];
const returned = (id: string, content: string): BaseEvent => ({ type: EventType.TOOL_CALL_RESULT, messageId: `m-${id}`, toolCallId: id, content, role: "tool" } as BaseEvent);
const finish = (result?: unknown): BaseEvent => ({ type: EventType.RUN_FINISHED, threadId: "t", runId: "r", ...(result ? { result } : {}) } as BaseEvent);

async function finalizeTurn(events: BaseEvent[], override?: TurnOutcome) {
  const rows = new Map<string, { status: string; output: string }>();
  const statuses: string[] = [];
  const messages = {
    updateContent: async (_t: string, _m: string, _u: string, status: string) => { statuses.push(status); return {} as never; },
    updateStreamingContent: async () => undefined,
    setRuntimeNotices: async () => undefined,
    upsertToolResult: async (row: { toolResultId: string; status: string; output: string }) => { rows.set(row.toolResultId, row); return row as never; }
  } as unknown as TurnTranscriptMessages;
  const transcript = new TurnTranscript({ messages, tenantId: "t", sessionId: "s", userId: "u", messageId: "a1" });
  for (const event of events) transcript.apply(event, { saveProgress: true });
  await transcript.settleProgress();
  const finalized = await transcript.finalize(override);
  return { rows, statuses, finalized };
}

const historyOf = (rows: Map<string, { status: string; output: string }>, status: HistoryMessage["status"]) =>
  toAguiMessages([{ messageId: "a1", role: "assistant", status, content: "",
    toolResults: [...rows].map(([toolResultId, row]) => ({ toolResultId, toolName: "execute", title: "execute", input: "{}", ...row })) } as HistoryMessage])
    .filter((message) => message.role === "tool");

describe("TurnTranscript tool calls that never returned", () => {
  it("keeps an unfinished call in_progress when the turn stopped, and history shows it as interrupted", async () => {
    const { rows, statuses, finalized } = await finalizeTurn([...started("c1"), finish(interruptedResult())]);

    expect(finalized.outcome).toEqual({ status: "interrupted" });
    expect(statuses).toEqual(["interrupted"]);
    expect(rows.get("c1")?.status).toBe("in_progress");
    expect(historyOf(rows, "interrupted")).toEqual([expect.objectContaining({ toolCallId: "c1", error: "interrupted" })]);
  });

  it("keeps it in_progress for a stop with a backend reason", async () => {
    const { rows, finalized } = await finalizeTurn([...started("c1"), finish(interruptedResult("security_change"))]);

    expect(finalized.outcome).toEqual({ status: "interrupted", reason: "security_change" });
    expect(rows.get("c1")?.status).toBe("in_progress");
  });

  it("keeps it in_progress when the caller reports a stop, as for a thrown turn that was cancelled", async () => {
    const { rows } = await finalizeTurn(started("c1"), { status: "interrupted" });

    expect(rows.get("c1")?.status).toBe("in_progress");
  });

  it("keeps a call that showed and never started, as an approval card of a stopped turn", async () => {
    const { rows } = await finalizeTurn([...started("c1").slice(0, 1), finish(interruptedResult())]);

    expect(rows.get("c1")?.status).toBe("in_progress");
  });

  it("changes only the calls that never returned: a call that returned before the stop keeps its result", async () => {
    const { rows } = await finalizeTurn([...started("done"), returned("done", "ok"), ...started("open"), finish(interruptedResult())]);

    expect(rows.get("done")).toMatchObject({ status: "completed", output: "ok" });
    expect(rows.get("open")?.status).toBe("in_progress");
  });

  it.each<[string, BaseEvent[], TurnOutcome | undefined]>([
    ["a run error event", [...started("c1"), { type: EventType.RUN_ERROR, message: "provider down" } as BaseEvent], undefined],
    ["a thrown turn", started("c1"), { status: "error", message: "The assistant run failed." }],
    ["a completed turn", [...started("c1"), finish()], undefined]
  ])("does not report a failure for an unfinished call after %s: history shows it as interrupted", async (_name, events, override) => {
    const { rows, finalized } = await finalizeTurn(events, override);

    expect(finalized.outcome.status).not.toBe("interrupted");
    expect(rows.get("c1")?.status).toBe("in_progress");
    const status = finalized.outcome.status === "completed" ? "completed" : "error";
    expect(historyOf(rows, status)).toEqual([expect.objectContaining({ toolCallId: "c1", error: "interrupted" })]);
  });

  it("keeps a failure that the tool reported distinct from a call that never returned, after a run error", async () => {
    const failedCall: BaseEvent[] = [...started("reported"), returned("reported", "exit 1"),
      { type: EventType.CUSTOM, name: "tool_status", value: { toolCallId: "reported", toolName: "execute", status: "failed" } } as BaseEvent];
    const { rows } = await finalizeTurn([...failedCall, ...started("open"), { type: EventType.RUN_ERROR, message: "provider down" } as BaseEvent]);

    expect(rows.get("reported")?.status).toBe("failed");
    expect(rows.get("open")?.status).toBe("in_progress");
    expect(historyOf(rows, "error")).toEqual([
      expect.objectContaining({ toolCallId: "reported", error: "failed" }),
      expect.objectContaining({ toolCallId: "open", error: "interrupted" })
    ]);
  });
});
