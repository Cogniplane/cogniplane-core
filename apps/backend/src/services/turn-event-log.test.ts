import { EventType, type BaseEvent } from "@ag-ui/client";
import { expect, test, vi } from "vitest";
import { TurnEventLog } from "./turn-event-log.js";

function textEvent(delta: string): BaseEvent {
  return { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "answer", delta } as BaseEvent;
}

test("replays events in sequence, follows live events, and closes listeners", () => {
  const log = new TurnEventLog();
  log.append({ type: EventType.RUN_STARTED, threadId: "session", runId: "turn" } as BaseEvent);
  const received = vi.fn();
  const subscription = log.subscribe(0, received);
  expect(subscription?.replay.map((entry) => entry.sequence)).toEqual([1]);
  log.append({ type: EventType.TEXT_MESSAGE_START, messageId: "answer", role: "assistant" } as BaseEvent);
  log.append(textEvent("hello"));
  log.append({ type: EventType.TEXT_MESSAGE_END, messageId: "answer" } as BaseEvent);
  expect(received.mock.calls[0]?.[0]).toMatchObject({ sequence: 2, event: { type: EventType.TEXT_MESSAGE_START } });
  expect(received.mock.calls[1]?.[0]).toMatchObject({ sequence: 3, event: { delta: "hello" } });
  log.close();
  expect(received.mock.calls.at(-1)?.[0]).toBeNull();
  expect(log.subscribe(0, received)).toBeNull();
});

test("bounds replay memory and reports a gap when old events are gone", () => {
  const log = new TurnEventLog();
  log.append({ type: EventType.CUSTOM, name: "big", value: { message: "a".repeat(600_000) } } as BaseEvent);
  log.append({ type: EventType.CUSTOM, name: "big", value: { message: "b".repeat(600_000) } } as BaseEvent);
  expect(log.subscribe(0, () => undefined)).toBeNull();
  expect(log.subscribe(1, () => undefined)?.replay.map((entry) => entry.sequence)).toEqual([2]);
});

test("redacts event content before it enters the replay log", () => {
  const log = new TurnEventLog();
  log.append({ type: EventType.TEXT_MESSAGE_START, messageId: "answer", role: "assistant" } as BaseEvent);
  log.append(textEvent("Bearer "));
  log.append(textEvent("hidden-value"));
  log.append({ type: EventType.TEXT_MESSAGE_END, messageId: "answer" } as BaseEvent);
  const replay = log.subscribe(0, () => undefined)?.replay ?? [];
  expect(replay.find((entry) => entry.event.type === EventType.TEXT_MESSAGE_CONTENT)?.event).toMatchObject({
    delta: "Bearer [REDACTED]"
  });
  expect(JSON.stringify(replay)).not.toContain("hidden-value");
});

test("mirrors only redacted entries in sequence", async () => {
  const log = new TurnEventLog();
  const mirrored: unknown[] = [];
  log.setMirror(async entry => { mirrored.push(entry); });
  log.append({ type: EventType.TEXT_MESSAGE_START, messageId: "answer", role: "assistant" } as BaseEvent);
  log.append(textEvent("Bearer "));
  log.append(textEvent("hidden-value"));
  log.append({ type: EventType.TEXT_MESSAGE_END, messageId: "answer" } as BaseEvent);
  await vi.waitFor(() => expect(mirrored).toHaveLength(3));
  expect(JSON.stringify(mirrored)).not.toContain("hidden-value");
  expect(mirrored).toMatchObject([
    { sequence: 1 }, { sequence: 2, event: { delta: "Bearer [REDACTED]" } }, { sequence: 3 }
  ]);
});

test("a failed mirror does not stop the local event stream", async () => {
  const log = new TurnEventLog();
  const unavailable = vi.fn();
  log.setMirror(async () => { throw new Error("Redis unavailable"); }, unavailable);
  log.append({ type: EventType.RUN_STARTED, threadId: "session", runId: "turn" } as BaseEvent);
  await vi.waitFor(() => expect(unavailable).toHaveBeenCalledWith("write_failed", expect.any(Error)));
  expect(log.subscribe(0, () => undefined)?.replay).toHaveLength(1);
});

test("a pending mirror does not hold local turn delivery or completion", async () => {
  const log = new TurnEventLog();
  log.setMirror(() => new Promise<void>(() => undefined));
  log.append({ type: EventType.RUN_STARTED, threadId: "session", runId: "turn" } as BaseEvent);
  log.append({ type: EventType.RUN_FINISHED, threadId: "session", runId: "turn" } as BaseEvent);
  expect(log.subscribe(0, () => undefined)?.replay.map(entry => entry.sequence)).toEqual([1, 2]);
  log.close();
});

test("a stuck mirror drops its bounded backlog without stopping local replay", () => {
  const log = new TurnEventLog();
  const unavailable = vi.fn();
  log.setMirror(() => new Promise<void>(() => undefined), unavailable);
  for (let sequence = 0; sequence <= 1_000; sequence += 1) {
    log.append({ type: EventType.CUSTOM, name: "tick", value: { sequence } } as BaseEvent);
  }
  expect(unavailable).toHaveBeenCalledWith("backlog", undefined);
  expect(log.subscribe(1, () => undefined)?.replay.at(-1)?.sequence).toBe(1_001);
});

test("a mirror write that never settles times out", async () => {
  vi.useFakeTimers();
  try {
    const log = new TurnEventLog();
    const unavailable = vi.fn();
    log.setMirror(() => new Promise<void>(() => undefined), unavailable);
    log.append({ type: EventType.RUN_STARTED, threadId: "session", runId: "turn" } as BaseEvent);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(unavailable).toHaveBeenCalledWith("write_failed", expect.any(Error));
  } finally {
    vi.useRealTimers();
  }
});

test("redacts a split secret before releasing live text", () => {
  const log = new TurnEventLog();
  log.append({ type: EventType.TEXT_MESSAGE_START, messageId: "answer", role: "assistant" } as BaseEvent);
  log.append(textEvent("Bearer "));
  log.append(textEvent("hidden-value one two three four five six seven eight nine ten "));
  const replay = log.subscribe(0, () => undefined)?.replay ?? [];
  expect(JSON.stringify(replay)).toContain("[REDACTED]");
  expect(JSON.stringify(replay)).not.toContain("hidden-value");
});

test("holds a private-key block across lines until it can be redacted", () => {
  const log = new TurnEventLog();
  log.append({ type: EventType.TEXT_MESSAGE_START, messageId: "answer", role: "assistant" } as BaseEvent);
  log.append(textEvent("-----BEGIN PRIVATE KEY-----\nprivate-bytes\n"));
  log.append(textEvent("-----END PRIVATE KEY-----"));
  log.append({ type: EventType.TEXT_MESSAGE_END, messageId: "answer" } as BaseEvent);
  const replay = JSON.stringify(log.subscribe(0, () => undefined)?.replay);
  expect(replay).toContain("[REDACTED]");
  expect(replay).not.toContain("private-bytes");
});

test("redacts split reasoning and parsed tool arguments", () => {
  const log = new TurnEventLog();
  log.append({ type: EventType.REASONING_MESSAGE_START, messageId: "reason" } as BaseEvent);
  log.append({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: "reason", delta: "Bearer " } as BaseEvent);
  log.append({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: "reason", delta: "hidden-value" } as BaseEvent);
  log.append({ type: EventType.REASONING_MESSAGE_END, messageId: "reason" } as BaseEvent);
  log.append({ type: EventType.TOOL_CALL_START, toolCallId: "tool", toolCallName: "search" } as BaseEvent);
  log.append({ type: EventType.TOOL_CALL_ARGS, toolCallId: "tool", delta: '{"apiKey":"hidden' } as BaseEvent);
  log.append({ type: EventType.TOOL_CALL_ARGS, toolCallId: "tool", delta: '-value"}' } as BaseEvent);
  log.append({ type: EventType.TOOL_CALL_END, toolCallId: "tool" } as BaseEvent);

  const replay = log.subscribe(0, () => undefined)?.replay ?? [];
  expect(replay.find((entry) => entry.event.type === EventType.REASONING_MESSAGE_CONTENT)?.event)
    .toMatchObject({ delta: "Bearer [REDACTED]" });
  expect(replay.find((entry) => entry.event.type === EventType.TOOL_CALL_ARGS)?.event)
    .toMatchObject({ delta: '{"apiKey":"[REDACTED]"}' });
  expect(JSON.stringify(replay)).not.toContain("hidden-value");
});

test("releases completed words during a long reply", () => {
  const log = new TurnEventLog();
  log.append({ type: EventType.TEXT_MESSAGE_START, messageId: "answer", role: "assistant" } as BaseEvent);
  log.append(textEvent("one two three four five six seven eight nine ten "));
  expect(log.subscribe(0, () => undefined)?.replay.some((entry) =>
    entry.event.type === EventType.TEXT_MESSAGE_CONTENT &&
    typeof entry.event.delta === "string" && entry.event.delta.includes("one two")
  )).toBe(true);
});

test("bounds a single unbroken text chunk without replaying its raw content", () => {
  const log = new TurnEventLog();
  log.append({ type: EventType.TEXT_MESSAGE_START, messageId: "answer", role: "assistant" } as BaseEvent);
  log.append(textEvent("x".repeat(16_385)));
  log.append({ type: EventType.TEXT_MESSAGE_END, messageId: "answer" } as BaseEvent);
  const content = log.subscribe(0, () => undefined)?.replay.find((entry) =>
    entry.event.type === EventType.TEXT_MESSAGE_CONTENT
  )?.event;
  expect(content).toMatchObject({ delta: "[Reply text exceeds live replay limit]" });
});
