import { EventType, type BaseEvent } from "@ag-ui/client";
import { expect, test, vi } from "vitest";
import { redactSecrets } from "./redact-secrets.js";
import { TurnEventLog, type SequencedTurnEvent } from "./turn-event-log.js";

function textEvent(delta: string): BaseEvent {
  return { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "answer", delta } as BaseEvent;
}

function mirroredLog(): { log: TurnEventLog; mirrored: SequencedTurnEvent[] } {
  const log = new TurnEventLog();
  const mirrored: SequencedTurnEvent[] = [];
  log.setMirror(async (entry) => { mirrored.push(entry); });
  return { log, mirrored };
}

function replayedText(entries: SequencedTurnEvent[], type = EventType.TEXT_MESSAGE_CONTENT): string {
  return entries.filter((entry) => entry.event.type === type)
    .map((entry) => (entry.event as { delta?: string }).delta ?? "").join("");
}

// Cuts `text` into deltas whose lengths repeat `sizes`, in UTF-16 code units.
function chunks(text: string, sizes: number[]): string[] {
  const deltas: string[] = [];
  for (let index = 0, step = 0; index < text.length; step += 1) {
    const size = sizes[step % sizes.length]!;
    deltas.push(text.slice(index, index + size));
    index += size;
  }
  return deltas;
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
  expect(replay).toContain("[REDACTED PRIVATE KEY]");
  expect(replay).not.toContain("private-bytes");
});

test("an unclosed key header drops the rest of its message, not the next message", () => {
  const log = new TurnEventLog();
  log.append({ type: EventType.TEXT_MESSAGE_START, messageId: "answer", role: "assistant" } as BaseEvent);
  log.append(textEvent("Look for -----BEGIN RSA PRIVATE KEY----- in your files. "));
  for (let index = 0; index < 300; index += 1) log.append(textEvent("plenty of ordinary words here ok "));
  log.append({ type: EventType.TEXT_MESSAGE_END, messageId: "answer" } as BaseEvent);
  log.append({ type: EventType.TEXT_MESSAGE_START, messageId: "next", role: "assistant" } as BaseEvent);
  log.append({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "next", delta: "Next message streams. " } as BaseEvent);
  log.append({ type: EventType.TEXT_MESSAGE_END, messageId: "next" } as BaseEvent);
  const replay = JSON.stringify(log.subscribe(0, () => undefined)?.replay);
  expect(replay).toContain("Look for [REDACTED PRIVATE KEY]");
  expect(replay).not.toContain("BEGIN RSA PRIVATE KEY");
  // The held text is dropped, not buffered until the size limit.
  expect(replay).not.toContain("exceeds live replay limit");
  expect(replay).toContain("Next message streams.");
});

const KEY_LINE = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj\n";

function keyReplay(build: (log: TurnEventLog) => void, contentType = EventType.TEXT_MESSAGE_START): string {
  const log = new TurnEventLog();
  log.append({ type: contentType, messageId: "answer", role: "assistant" } as BaseEvent);
  build(log);
  return JSON.stringify(log.subscribe(0, () => undefined)?.replay);
}

test("discards an oversized key block up to its END line, also when END is split", () => {
  const replay = keyReplay((log) => {
    log.append(textEvent("Here it is:\n-----BEGIN PRIVATE KEY-----\n"));
    for (let index = 0; index < 200; index += 1) log.append(textEvent(KEY_LINE));
    log.append(textEvent("-----END PRIV"));
    log.append(textEvent("ATE KEY-----\nThat was the key, store it safely please. "));
    log.append({ type: EventType.TEXT_MESSAGE_END, messageId: "answer" } as BaseEvent);
  });
  expect(replay).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw");
  expect(replay).toContain("[REDACTED PRIVATE KEY]");
  expect(replay).toContain("That was the key");
});

test("drops a key block in reasoning text and never flushes it", () => {
  const replay = keyReplay((log) => {
    log.append({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: "answer",
      delta: "Thinking. -----BEGIN RSA PRIVATE KEY-----\n" } as BaseEvent);
    for (let index = 0; index < 200; index += 1) {
      log.append({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: "answer", delta: KEY_LINE } as BaseEvent);
    }
    log.append({ type: EventType.REASONING_MESSAGE_END, messageId: "answer" } as BaseEvent);
    log.append({ type: EventType.RUN_FINISHED, threadId: "s", runId: "r" } as BaseEvent);
  }, EventType.REASONING_MESSAGE_START);
  expect(replay).toContain("Thinking. [REDACTED PRIVATE KEY]");
  expect(replay).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw");
});

test.each([
  ["two complete keys in one delta",
    `-----BEGIN PRIVATE KEY-----\n${KEY_LINE}-----END PRIVATE KEY-----\nand -----BEGIN EC PRIVATE KEY-----\n${KEY_LINE}-----END EC PRIVATE KEY-----\nDone now. `],
  ["a complete key and an unclosed key",
    `-----BEGIN PRIVATE KEY-----\n${KEY_LINE}-----END PRIVATE KEY-----\nalso -----BEGIN RSA PRIVATE KEY-----\n${KEY_LINE}`],
  ["an encrypted key with tab headers and spaced body lines",
    `-----BEGIN RSA PRIVATE KEY-----\nProc-Type:\t4,ENCRYPTED\nDEK-Info: AES-128-CBC,0011\n\nMIIEvQIBADANBgkq hkiG9w0BAQEFAASCBKcw\n${KEY_LINE}`]
])("never releases key bytes for %s", (_name, text) => {
  const replay = keyReplay((log) => {
    log.append(textEvent(text));
    log.append({ type: EventType.TEXT_MESSAGE_END, messageId: "answer" } as BaseEvent);
  });
  expect(replay).not.toContain("MIIEvQIBADANBgkq");
  expect(replay).not.toContain("hkiG9w0BAQEFAASCBKcw");
  expect(replay).toContain("[REDACTED PRIVATE KEY]");
});

test.each([
  ["the message ends", (log: TurnEventLog) => log.append({ type: EventType.TEXT_MESSAGE_END, messageId: "answer" } as BaseEvent)],
  ["the run ends", (log: TurnEventLog) => log.append({ type: EventType.RUN_FINISHED, threadId: "s", runId: "r" } as BaseEvent)]
])("never flushes an unfinished key block when %s", (_name, end) => {
  const replay = keyReplay((log) => {
    log.append(textEvent("-----BEGIN PRIVATE KEY-----\n"));
    log.append(textEvent(KEY_LINE));
    end(log);
  });
  expect(replay).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw");
  expect(replay).toContain("[REDACTED PRIVATE KEY]");
});

test.each([
  ["text", EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT, EventType.TEXT_MESSAGE_END],
  ["reasoning", EventType.REASONING_MESSAGE_START, EventType.REASONING_MESSAGE_CONTENT, EventType.REASONING_MESSAGE_END]
])("holds a long BEGIN header split across %s deltas", async (_name, start, content, end) => {
  const log = new TurnEventLog();
  const mirrored: string[] = [];
  log.setMirror(async (entry) => { mirrored.push(JSON.stringify(entry.event)); });
  log.append({ type: start, messageId: "answer", role: "assistant" } as BaseEvent);
  const delta = (text: string) => log.append({ type: content, messageId: "answer", delta: text } as BaseEvent);
  // The label is longer than the eight words that the tail hold keeps.
  delta("Key: -----BEGIN ONE TWO THREE FOUR FIVE SIX SEVEN EIGHT NINE PRIVATE KEY");
  delta(`-----\n${KEY_LINE}-----END ONE TWO THREE FOUR FIVE SIX SEVEN EIGHT NINE PRIVATE KEY-----\nAfter the key. `);
  log.append({ type: end, messageId: "answer" } as BaseEvent);
  const replay = log.subscribe(0, () => undefined)!.replay.map((entry) => JSON.stringify(entry.event));
  await vi.waitFor(() => expect(mirrored).toEqual(replay), { interval: 1 });
  for (const output of [replay.join(""), mirrored.join("")]) {
    expect(output).not.toContain("MIIEvQIBADANBgkq");
    expect(output).not.toContain("BEGIN ONE TWO");
    expect(output).toContain("[REDACTED PRIVATE KEY]");
    expect(output).toContain("After the key.");
  }
});

test.each([
  ["an END line of another label", "-----END EC PRIVATE KEY-----\n"],
  ["an END marker inside another line", "Comment: -----END RSA PRIVATE KEY-----\n"],
  ["an END marker followed by text on its line", "-----END RSA PRIVATE KEY----- trailing\n"]
])("keeps dropping after %s", (_name, fakeEnd) => {
  const replay = keyReplay((log) => {
    log.append(textEvent("-----BEGIN RSA PRIVATE KEY-----\n"));
    log.append(textEvent(KEY_LINE));
    log.append(textEvent(fakeEnd));
    log.append(textEvent("c2Vjb25kLWhhbGYtb2YtdGhlLWtleQ==\n"));
    log.append({ type: EventType.TEXT_MESSAGE_END, messageId: "answer" } as BaseEvent);
  });
  expect(replay).not.toContain("c2Vjb25kLWhhbGYtb2YtdGhlLWtleQ");
  expect(replay).not.toContain("MIIEvQIBADANBgkq");
});

test.each([
  ["one delta", ["-----BEGIN PRIVATE KEY----------END PRIVATE KEY-----\nc2VjcmV0LWtleS1ieXRlcw==\n"]],
  ["split deltas", ["-----BEGIN PRIVATE KEY-----", "-----END PRIVATE KEY-----\nc2VjcmV0LWtleS1ieXRlcw==\n"]]
])("an END marker on the BEGIN line does not end the block (%s)", (_name, deltas) => {
  for (const end of [EventType.TEXT_MESSAGE_END, EventType.RUN_ERROR]) {
    const replay = keyReplay((log) => {
      for (const delta of deltas) log.append(textEvent(delta));
      log.append(end === EventType.RUN_ERROR
        ? { type: EventType.RUN_ERROR, message: "failed" } as BaseEvent
        : { type: EventType.TEXT_MESSAGE_END, messageId: "answer" } as BaseEvent);
    });
    expect(replay).not.toContain("c2VjcmV0LWtleS1ieXRlcw");
  }
});

test("resumes after an END line with a very long label", () => {
  const label = `${"WORD ".repeat(100)}PRIVATE KEY`;
  const replay = keyReplay((log) => {
    log.append(textEvent(`-----BEGIN ${label}-----\n${KEY_LINE}-----END ${label}-----\nSafe after a long label. `));
    log.append({ type: EventType.TEXT_MESSAGE_END, messageId: "answer" } as BaseEvent);
  });
  expect(replay).not.toContain("MIIEvQIBADANBgkq");
  expect(replay).toContain("Safe after a long label.");
});

test("resumes after a long END line split across deltas", () => {
  const label = `${"WORD ".repeat(50)}PRIVATE KEY`;
  const endLine = `-----END ${label}-----\n`;
  const replay = keyReplay((log) => {
    log.append(textEvent(`-----BEGIN ${label}-----\n${KEY_LINE}`));
    log.append(textEvent(endLine.slice(0, 200)));
    log.append(textEvent(`${endLine.slice(200)}Safe text after the key. `));
    log.append({ type: EventType.TEXT_MESSAGE_END, messageId: "answer" } as BaseEvent);
  });
  expect(replay).not.toContain("MIIEvQIBADANBgkq");
  expect(replay).toContain("Safe text after the key.");
});

test("treats an overlong header candidate as a key header", () => {
  const replay = keyReplay((log) => {
    log.append(textEvent(`-----BEGIN ${"WORD ".repeat(80)}`));
    log.append(textEvent(`${KEY_LINE}`));
    log.append({ type: EventType.TEXT_MESSAGE_END, messageId: "answer" } as BaseEvent);
  });
  expect(replay).not.toContain("MIIEvQIBADANBgkq");
  expect(replay).toContain("[REDACTED PRIVATE KEY]");
});

test("a large delta after a key header neither leaks nor overflows", () => {
  const replay = keyReplay((log) => {
    log.append(textEvent("-----BEGIN PRIVATE KEY-----\n"));
    log.append(textEvent(`${KEY_LINE.repeat(400)}`));
    log.append({ type: EventType.TEXT_MESSAGE_END, messageId: "answer" } as BaseEvent);
  });
  expect(replay).not.toContain("exceeds live replay limit");
  expect(replay).not.toContain("MIIEvQIBADANBgkq");
  expect(replay).toContain("[REDACTED PRIVATE KEY]");
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

// Chinese, Japanese and Thai with no whitespace, Latin words with no spaces
// around them, and emoji: surrogate pairs, a ZWJ sequence and a flag. Delta
// cuts and release cuts fall next to and inside them.
const NO_SPACE_TEXT =
  "日本語の回答は単語の間に空白がありません。中文回答的词语之间没有空格。我们用Python和TypeScript写代码。ภาษาไทยไม่มีช่องว่าง😀👨‍👩‍👧🇯🇵"
    .repeat(250);
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test.each([
  ["reply text in small deltas", EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT,
    { type: EventType.TEXT_MESSAGE_END, messageId: "answer" }, [1, 2, 3, 5, 8, 13]],
  ["reasoning text in small deltas", EventType.REASONING_MESSAGE_START, EventType.REASONING_MESSAGE_CONTENT,
    { type: EventType.REASONING_MESSAGE_END, messageId: "answer" }, [1, 2, 3, 5, 8, 13]],
  ["reply text in one delta, ended by the run", EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT,
    { type: EventType.RUN_FINISHED, threadId: "s", runId: "r" }, [NO_SPACE_TEXT.length]]
])("streams %s without whitespace and rebuilds it exactly", async (_name, start, content, end, sizes) => {
  expect(NO_SPACE_TEXT.length).toBeGreaterThan(16_384);
  const { log, mirrored } = mirroredLog();
  log.append({ type: start, messageId: "answer", role: "assistant" } as BaseEvent);
  for (const delta of chunks(NO_SPACE_TEXT, sizes)) {
    log.append({ type: content, messageId: "answer", delta } as BaseEvent);
  }
  // Before the end, all but a short tail is in the replay.
  const live = replayedText(log.subscribe(0, () => undefined)!.replay, content);
  expect(NO_SPACE_TEXT.startsWith(live)).toBe(true);
  expect(NO_SPACE_TEXT.length - live.length).toBeLessThan(1_000);

  log.append(end as BaseEvent);
  const replay = log.subscribe(0, () => undefined)!.replay;
  expect(replay[0]?.sequence).toBe(1);
  expect(replayedText(replay, content)).toBe(NO_SPACE_TEXT);
  for (const { event } of replay) expect((event as { delta?: string }).delta ?? "").not.toMatch(LONE_SURROGATE);
  await vi.waitFor(() => expect(mirrored).toEqual(replay), { interval: 1 });
});

test("streams text without whitespace again after it held a long secret", () => {
  const log = new TurnEventLog();
  log.append({ type: EventType.TEXT_MESSAGE_START, messageId: "answer", role: "assistant" } as BaseEvent);
  // The query value is held until `#`, longer than one split search.
  for (const delta of chunks(`?token=${"秘".repeat(600)}#${NO_SPACE_TEXT}`, [3])) log.append(textEvent(delta));
  const expected = `?token=REDACTED#${NO_SPACE_TEXT}`;
  const live = replayedText(log.subscribe(0, () => undefined)!.replay);
  expect(expected.startsWith(live)).toBe(true);
  expect(expected.length - live.length).toBeLessThan(1_000);
  log.append({ type: EventType.TEXT_MESSAGE_END, messageId: "answer" } as BaseEvent);
  expect(replayedText(log.subscribe(0, () => undefined)!.replay)).toBe(expected);
});

const BEFORE_TEXT = "前文没有空格".repeat(100);
const AFTER_TEXT = "后文也没有空格".repeat(100);
const SECRET_BODY = "Q7xK9mP2vL4nR8tW3yZ6bC1dF5gH0jA";

// Each piece of `secret` that has `length` code units.
function pieces(secret: string, length: number): string[] {
  return Array.from({ length: secret.length - length + 1 }, (_, index) => secret.slice(index, index + length));
}

// Deltas for `text` that cut `part` at each of its boundaries, then small deltas.
function splitsAround(text: string, part: string): string[][] {
  const offset = text.indexOf(part);
  const splits = Array.from({ length: part.length + 1 }, (_, index) =>
    [text.slice(0, offset + index), text.slice(offset + index)]);
  return [...splits, chunks(text, [1]), chunks(text, [1, 2, 3, 5, 8, 13])];
}

test.each([
  ["an Anthropic key", `密钥sk-ant-api03-${SECRET_BODY}。`, SECRET_BODY],
  ["a GitHub token", `令牌ghp_${SECRET_BODY}。`, SECRET_BODY],
  ["an AWS key", "密钥AKIAQ7XK9MP2VL4NR8TW。", "Q7XK9MP2VL4NR8TW"],
  ["a JWT", `令牌eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.${SECRET_BODY}。`, SECRET_BODY],
  ["a Bearer token", `请求头Bearer ${SECRET_BODY}。`, SECRET_BODY],
  // Ideographic spaces are whitespace. `#` ends a query parameter, not a Bearer
  // value; `,` ends a Bearer value, not a query parameter.
  ["a Bearer value in Chinese", "请求头Bearer\u3000\u3000秘密#令牌值。", "秘密#令牌值"],
  ["a URL token", `链接https://example.com/a?token=${SECRET_BODY}#片段。`, SECRET_BODY],
  ["a URL key in Chinese", "链接https://example.com/a?b=1&api_key=秘密,令牌值。", "秘密,令牌值"],
  ["a URL credential name in Chinese", `链接https://example.com/a?中文token中文=${SECRET_BODY}#片段。`, SECRET_BODY]
])("never replays part of %s in text without whitespace", async (_name, secretText, secret) => {
  const text = `${BEFORE_TEXT}${secretText}${AFTER_TEXT}`;
  // The replay must be what redaction of the complete text gives.
  const expected = redactSecrets(text);
  for (const piece of pieces(secret, 3)) expect(expected).not.toContain(piece);
  for (const deltas of splitsAround(text, secretText)) {
    const { log, mirrored } = mirroredLog();
    log.append({ type: EventType.TEXT_MESSAGE_START, messageId: "answer", role: "assistant" } as BaseEvent);
    for (const delta of deltas) log.append(textEvent(delta));
    log.append({ type: EventType.TEXT_MESSAGE_END, messageId: "answer" } as BaseEvent);
    expect(replayedText(log.subscribe(0, () => undefined)!.replay)).toBe(expected);
    await vi.waitFor(() => expect(replayedText(mirrored)).toBe(expected), { interval: 1 });
  }
});

test("drops a key block in text without whitespace at each header and body split", async () => {
  const header = "-----BEGIN PRIVATE KEY-----\n";
  const text = `${BEFORE_TEXT}密钥如下：${header}${KEY_LINE.repeat(3)}-----END PRIVATE KEY-----\n${AFTER_TEXT}`;
  const expected = `${BEFORE_TEXT}密钥如下：[REDACTED PRIVATE KEY]${AFTER_TEXT}`;
  for (const deltas of splitsAround(text, `${header}${KEY_LINE}`)) {
    const { log, mirrored } = mirroredLog();
    log.append({ type: EventType.TEXT_MESSAGE_START, messageId: "answer", role: "assistant" } as BaseEvent);
    for (const delta of deltas) log.append(textEvent(delta));
    log.append({ type: EventType.TEXT_MESSAGE_END, messageId: "answer" } as BaseEvent);
    expect(replayedText(log.subscribe(0, () => undefined)!.replay)).toBe(expected);
    await vi.waitFor(() => expect(replayedText(mirrored)).toBe(expected), { interval: 1 });
  }
});

test("never cuts an unbroken ASCII run, also inside text without whitespace", () => {
  const log = new TurnEventLog();
  log.append({ type: EventType.TEXT_MESSAGE_START, messageId: "answer", role: "assistant" } as BaseEvent);
  for (const delta of chunks(`${BEFORE_TEXT}${"x".repeat(16_385)}`, [7])) log.append(textEvent(delta));
  log.append({ type: EventType.TEXT_MESSAGE_END, messageId: "answer" } as BaseEvent);
  const replay = replayedText(log.subscribe(0, () => undefined)!.replay);
  // The run can be an unknown credential: it is dropped, not cut and released.
  expect(replay).toContain(BEFORE_TEXT.slice(0, -1));
  expect(replay).not.toContain("xxxx");
  expect(replay).toContain("[Reply text exceeds live replay limit]");
});
