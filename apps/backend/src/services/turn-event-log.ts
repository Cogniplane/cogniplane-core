import { EventType, type BaseEvent } from "@ag-ui/client";
import { redactSecrets } from "./redact-secrets.js";

const MAX_EVENTS = 1_000;
const MAX_BYTES = 1_000_000;
const MIRROR_WRITE_TIMEOUT_MS = 5_000;
// A long unbroken token must not make the tail buffer grow for the whole turn.
const MAX_TEXT_BUFFER = 16_384;
// Secrets can span several AG-UI text deltas. Keep recent words until the
// redactor sees the complete value and its delimiter.
const HELD_WORDS = 8;
// A private-key block never enters the replay log. From a BEGIN header on, all
// text is dropped up to the block's END line, also across deltas, and the log
// gets one marker instead. No END line means the rest of the message is left
// out of the live replay; the saved message keeps it. Nothing else is safe:
// valid PEM bodies can have spaces, tabs and header lines, so no rule can tell
// a quoted header followed by prose from key material.
const PEM_BEGIN = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----/;
const PEM_ANY_END_LINE = /^-----END [A-Z0-9 ]*PRIVATE KEY-----$/;
const REDACTED_PRIVATE_KEY = "[REDACTED PRIVATE KEY]";
// An END line is short. A longer line is key material and is not kept. The
// limit fits the expected END line plus this margin for spacing; a line over
// it only makes the drop continue, it can never release key bytes.
const PEM_END_LINE_MARGIN = 512;

function pemEndLineLimit(label: string | null): number {
  return (label === null ? PEM_HEADER_CANDIDATE_LIMIT : `-----END ${label}-----`.length) + PEM_END_LINE_MARGIN;
}

// Drop state of one key block: its label, when known, and the current line.
// `lineTooLong` also starts true: the rest of the BEGIN header line is never an
// END line, even when it holds an END marker.
type PemDrop = { label: string | null; line: string; lineTooLong: boolean };

// Only a complete line that is exactly the block's END line ends the block.
function isPemEndLine(line: string, label: string | null): boolean {
  const trimmed = line.trim();
  return label === null ? PEM_ANY_END_LINE.test(trimmed) : trimmed === `-----END ${label}-----`;
}

/**
 * Feeds dropped text to a key block, line by line across deltas. Returns the
 * text after the block's END line, or null while the block continues.
 */
function feedPemDrop(drop: PemDrop, text: string): string | null {
  let index = 0;
  while (index <= text.length) {
    const newline = text.indexOf("\n", index);
    const segment = text.slice(index, newline < 0 ? text.length : newline);
    if (!drop.lineTooLong) {
      drop.line += segment;
      if (drop.line.length > pemEndLineLimit(drop.label)) {
        drop.line = "";
        drop.lineTooLong = true;
      }
    }
    if (newline < 0) return null;
    if (!drop.lineTooLong && isPemEndLine(drop.line, drop.label)) return text.slice(newline + 1);
    drop.line = "";
    drop.lineTooLong = false;
    index = newline + 1;
  }
  return null;
}

// A header can arrive split across deltas, with a label longer than the word
// hold. Text from a possible, still incomplete header on is never released.
// Real labels are short; a longer candidate is treated as a header.
const PEM_HEADER_CANDIDATE_LIMIT = 256;
const PEM_BEGIN_LITERAL = "-----BEGIN";
const PEM_HEADER_PREFIX = /^-----BEGIN[ A-Z0-9]*-{0,4}$/;

// Start of a trailing text that can still become a BEGIN header, or -1.
function headerCandidateStart(text: string): number {
  const start = text.lastIndexOf(PEM_BEGIN_LITERAL);
  if (start >= 0 && PEM_HEADER_PREFIX.test(text.slice(start))) return start;
  for (let length = PEM_BEGIN_LITERAL.length - 1; length > 0; length -= 1) {
    if (text.endsWith(PEM_BEGIN_LITERAL.slice(0, length))) return text.length - length;
  }
  return -1;
}

type PemSplit = { emit: string; rest: string; drop?: PemDrop };

/**
 * Removes every private-key block from `text`, in order. `emit` is redacted
 * text before and between the blocks, `rest` is text after the last complete
 * block, and `drop` is set when the last block has no END line yet: the
 * caller then drops input until it does.
 */
function removePemBlocks(text: string): PemSplit {
  let emit = "";
  let rest = text;
  for (;;) {
    const begin = PEM_BEGIN.exec(rest);
    let start: number;
    let drop: PemDrop;
    let body: string;
    if (begin) {
      start = begin.index;
      drop = { label: begin[1]!, line: "", lineTooLong: true };
      body = rest.slice(begin.index + begin[0].length);
    } else {
      const candidate = headerCandidateStart(rest);
      if (candidate < 0 || rest.length - candidate <= PEM_HEADER_CANDIDATE_LIMIT) return { emit, rest };
      // Fail closed: drop it like a header whose key may follow. Its label is
      // unknown, so any END line ends it.
      start = candidate;
      drop = { label: null, line: "", lineTooLong: true };
      body = rest.slice(candidate);
    }
    emit += redactSecrets(rest.slice(0, start)) + REDACTED_PRIVATE_KEY;
    const after = feedPemDrop(drop, body);
    if (after === null) return { emit, rest: "", drop };
    rest = after;
  }
}

function safeTextCutoff(text: string): number {
  let words = 0;
  let inWord = false;
  let cutoff = 0;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (/\s/.test(text[index]!)) {
      if (inWord && words === HELD_WORDS) {
        cutoff = index + 1;
        break;
      }
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      words += 1;
    }
  }
  return cutoff;
}

function safeToolArgs(text: string): string {
  try {
    return JSON.stringify(redactSecrets(JSON.parse(text)));
  } catch {
    return "{}";
  }
}

// The held text at the end of a message or run. Key blocks were removed as
// they arrived; a block without an END line was being dropped.
function finalText(state: BufferedContent): string {
  if (state.overflow || state.pemDrop || !state.text) return "";
  return redactSecrets(state.text);
}

export type SequencedTurnEvent = { sequence: number; event: BaseEvent; bytes: number };
type BufferedContent = {
  text: string;
  overflow: boolean;
  messageId: string;
  contentType: EventType;
  // Set while input is dropped up to the END line of a key block.
  pemDrop?: PemDrop;
};

/** A process-local replay window for one interactive turn. */
export class TurnEventLog {
  private events: SequencedTurnEvent[] = [];
  private bytes = 0;
  private sequence = 0;
  private closed = false;
  private readonly textBuffers = new Map<string, BufferedContent>();
  private readonly toolArgs = new Map<string, { text: string; overflow: boolean }>();
  private readonly listeners = new Set<(entry: SequencedTurnEvent | null) => void>();
  private mirror?: (entry: SequencedTurnEvent) => Promise<void>;
  private mirrorQueue: SequencedTurnEvent[] = [];
  private mirrorBytes = 0;
  private mirrorTask?: Promise<void>;
  private onMirrorUnavailable?: (reason: "backlog" | "write_failed", error?: unknown) => void;

  setMirror(
    mirror: (entry: SequencedTurnEvent) => Promise<void>,
    onUnavailable?: (reason: "backlog" | "write_failed", error?: unknown) => void
  ): void {
    this.mirror = mirror;
    this.onMirrorUnavailable = onUnavailable;
  }

  append(event: BaseEvent): void {
    if (this.closed) return;
    if (event.type === EventType.TOOL_CALL_START && typeof event.toolCallId === "string") {
      this.toolArgs.set(event.toolCallId, { text: "", overflow: false });
    }
    if (event.type === EventType.TOOL_CALL_ARGS) {
      if (typeof event.toolCallId !== "string" || typeof event.delta !== "string") return;
      const state = this.toolArgs.get(event.toolCallId) ?? { text: "", overflow: false };
      this.toolArgs.set(event.toolCallId, state);
      if (!state.overflow) {
        state.text += event.delta;
        if (state.text.length > MAX_TEXT_BUFFER) {
          state.text = "";
          state.overflow = true;
        }
      }
      return;
    }
    if (event.type === EventType.TOOL_CALL_END && typeof event.toolCallId === "string") {
      const state = this.toolArgs.get(event.toolCallId);
      this.toolArgs.delete(event.toolCallId);
      if (state?.text || state?.overflow) {
        this.appendEntry({ type: EventType.TOOL_CALL_ARGS, toolCallId: event.toolCallId,
          delta: state.overflow ? "{}" : safeToolArgs(state.text) } as BaseEvent);
      }
    }
    if (event.type === EventType.TEXT_MESSAGE_START || event.type === EventType.REASONING_MESSAGE_START) {
      if (typeof event.messageId !== "string") return;
      const contentType = event.type === EventType.TEXT_MESSAGE_START
        ? EventType.TEXT_MESSAGE_CONTENT : EventType.REASONING_MESSAGE_CONTENT;
      this.textBuffers.set(`${contentType}:${event.messageId}`, {
        text: "", overflow: false, messageId: event.messageId, contentType
      });
    }
    if (event.type === EventType.TEXT_MESSAGE_CONTENT || event.type === EventType.REASONING_MESSAGE_CONTENT) {
      if (typeof event.messageId !== "string" || typeof event.delta !== "string") return;
      const key = `${event.type}:${event.messageId}`;
      const state = this.textBuffers.get(key) ?? {
        text: "", overflow: false, messageId: event.messageId, contentType: event.type
      };
      this.textBuffers.set(key, state);
      if (state.overflow) return;
      if (state.pemDrop) {
        // Inside a key block: drop input until its END line.
        const after = feedPemDrop(state.pemDrop, event.delta);
        if (after === null) return;
        state.pemDrop = undefined;
        state.text = after;
      } else {
        state.text += event.delta;
      }
      // Before the word cutoff and the size limit, so no part of a block is
      // released and a held block never fills the buffer.
      const split = removePemBlocks(state.text);
      state.text = split.rest;
      state.pemDrop = split.drop;
      if (split.emit) this.appendEntry({ ...event, delta: split.emit });
      // Release complete words first, so only text that cannot be released yet
      // (one unbroken token, or a key block being held) counts toward the limit.
      if (/\s/.test(event.delta)) {
        const candidate = headerCandidateStart(state.text);
        const words = safeTextCutoff(state.text);
        const cutoff = candidate >= 0 ? Math.min(words, candidate) : words;
        if (cutoff > 0) {
          const safe = redactSecrets(state.text.slice(0, cutoff));
          state.text = state.text.slice(cutoff);
          if (safe) this.appendEntry({ ...event, delta: safe });
        }
      }
      if (state.text.length > MAX_TEXT_BUFFER) {
        state.text = "";
        state.overflow = true;
        this.appendEntry({ ...event, delta: "[Reply text exceeds live replay limit]" });
      }
      return;
    }
    if (event.type === EventType.TEXT_MESSAGE_END || event.type === EventType.REASONING_MESSAGE_END) {
      if (typeof event.messageId !== "string") return;
      const contentType = event.type === EventType.TEXT_MESSAGE_END
        ? EventType.TEXT_MESSAGE_CONTENT : EventType.REASONING_MESSAGE_CONTENT;
      const key = `${contentType}:${event.messageId}`;
      const state = this.textBuffers.get(key);
      this.textBuffers.delete(key);
      const delta = state ? finalText(state) : "";
      if (delta) this.appendEntry({ type: contentType, messageId: event.messageId, delta } as BaseEvent);
    }
    if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) {
      this.toolArgs.clear();
      for (const state of this.textBuffers.values()) {
        const delta = finalText(state);
        if (delta) this.appendEntry({ type: state.contentType, messageId: state.messageId, delta } as BaseEvent);
      }
      this.textBuffers.clear();
    }
    this.appendEntry(event);
  }

  private appendEntry(event: BaseEvent): void {
    const safeEvent = redactSecrets(event);
    const bytes = Buffer.byteLength(JSON.stringify(safeEvent));
    const entry = { sequence: ++this.sequence, event: safeEvent, bytes };
    this.events.push(entry);
    this.bytes += bytes;
    while (this.events.length > MAX_EVENTS || this.bytes > MAX_BYTES) {
      this.bytes -= this.events.shift()!.bytes;
    }
    for (const listener of this.listeners) listener(entry);
    if (this.mirror) this.queueMirror(entry);
  }

  private queueMirror(entry: SequencedTurnEvent): void {
    if (this.mirrorQueue.length >= MAX_EVENTS || this.mirrorBytes + entry.bytes > MAX_BYTES) {
      this.stopMirror("backlog");
      return;
    }
    this.mirrorQueue.push(entry);
    this.mirrorBytes += entry.bytes;
    if (this.mirrorTask) return;
    const task = this.flushMirror();
    this.mirrorTask = task;
    void task.finally(() => {
      if (this.mirrorTask === task) this.mirrorTask = undefined;
    });
  }

  private async flushMirror(): Promise<void> {
    while (this.mirror && this.mirrorQueue.length > 0) {
      const entry = this.mirrorQueue[0]!;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.mirror(entry),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("Turn event mirror timed out")), MIRROR_WRITE_TIMEOUT_MS);
            timeout.unref?.();
          })
        ]);
      } catch (error) {
        this.stopMirror("write_failed", error);
        break;
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      if (!this.mirror) break;
      this.mirrorQueue.shift();
      this.mirrorBytes -= entry.bytes;
    }
  }

  private stopMirror(reason: "backlog" | "write_failed", error?: unknown): void {
    if (!this.mirror) return;
    this.mirror = undefined;
    this.mirrorQueue = [];
    this.mirrorBytes = 0;
    try { this.onMirrorUnavailable?.(reason, error); }
    catch { /* Logging must not stop the local turn. */ }
  }

  subscribe(after: number, listener: (entry: SequencedTurnEvent | null) => void):
    | { replay: SequencedTurnEvent[]; unsubscribe: () => void }
    | null {
    if (this.closed || after > this.sequence ||
      after < (this.events[0]?.sequence ?? this.sequence + 1) - 1) return null;
    const replay = this.events.filter((entry) => entry.sequence > after);
    this.listeners.add(listener);
    return { replay, unsubscribe: () => this.listeners.delete(listener) };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.listeners) listener(null);
    this.listeners.clear();
    this.events = [];
    this.bytes = 0;
    this.textBuffers.clear();
    this.toolArgs.clear();
  }
}
