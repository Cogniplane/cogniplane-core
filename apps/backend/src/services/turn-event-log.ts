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
  const pemStart = text.search(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/);
  if (pemStart >= 0) {
    const remainder = text.slice(pemStart);
    const end = /-----END [A-Z0-9 ]*PRIVATE KEY-----/.exec(remainder);
    if (!end || cutoff < pemStart + end.index + end[0].length) {
      cutoff = Math.min(cutoff, pemStart);
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

export type SequencedTurnEvent = { sequence: number; event: BaseEvent; bytes: number };
type BufferedContent = { text: string; overflow: boolean; messageId: string; contentType: EventType };

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
    if (event.type === EventType.CUSTOM && event.name === "text_retracted") {
      this.textBuffers.clear();
    }
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
      state.text += event.delta;
      if (state.text.length > MAX_TEXT_BUFFER) {
        state.text = "";
        state.overflow = true;
        this.appendEntry({ ...event, delta: "[Reply text exceeds live replay limit]" });
        return;
      }
      if (!/\s/.test(event.delta)) return;
      const cutoff = safeTextCutoff(state.text);
      if (cutoff > 0) {
        const safe = redactSecrets(state.text.slice(0, cutoff));
        state.text = state.text.slice(cutoff);
        if (safe) this.appendEntry({ ...event, delta: safe });
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
      if (state && !state.overflow && state.text) {
        this.appendEntry({ type: contentType, messageId: event.messageId,
          delta: redactSecrets(state.text) } as BaseEvent);
      }
    }
    if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) {
      this.toolArgs.clear();
      for (const state of this.textBuffers.values()) {
        if (!state.overflow && state.text) {
          this.appendEntry({ type: state.contentType, messageId: state.messageId,
            delta: redactSecrets(state.text) } as BaseEvent);
        }
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
