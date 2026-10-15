// Turn transcript: the transport-independent end of one assistant turn.
//
// Interactive SSE turns and scheduled turns feed the same runtime AG-UI events
// to a `TurnTranscript` and call `finalize` once. It classifies the terminal
// outcome and writes the assistant row:
//
// 1. Text and status (required). A failed write, or a write that updates no
//    row, is reported as `persisted: false` and never as a completed outcome.
// 2. Reasoning, plan, runtime notices, and tool results (best effort, only
//    after step 1 succeeded). Tool offsets and reasoning offsets are remapped
//    to the redacted text that the store saves.
// 3. A `lateFailure` from the caller, such as a job timeout, that started
//    during steps 1 and 2. It replaces the status written in step 1.
//
// `finalize` never throws, so a failed write cannot stop the caller's cleanup.
// It returns the same result when it is called again. After it resolves, the
// outcome does not change.
//
// Callers keep their own work. The SSE writer owns wire output, checkpoints,
// MCP App publication, and whether and when to await progress writes. This
// object selects, orders, and saves them. The scheduler owns the job ledger, timeout,
// usage read, and session cleanup. This object does not retry runtime or tool
// actions, and it does not recover a turn after a process stops.

import { EventType, type BaseEvent } from "@ag-ui/client";

import { AguiTurnAccumulator, type AccumulatedToolResult } from "./agui-turn-accumulator.js";
import { isAGUIInterruptedFinish } from "./deep-agents/agui-events.js";
import type { MessageStore } from "./message-store.js";
import { redactSecrets } from "./redact-secrets.js";

export const GENERIC_TURN_FAILURE = "The assistant run failed.";

const MAX_RUNTIME_NOTICES = 50;

export type TurnOutcome =
  | { status: "completed" }
  | { status: "interrupted" }
  | { status: "error"; message: string };

export type FinalizedTurn = {
  outcome: TurnOutcome;
  /** Raw assistant text, before storage redaction. */
  text: string;
  /** False when the text/status write failed. The outcome is then not "completed". */
  persisted: boolean;
};

export type TurnTranscriptMessages = Pick<
  MessageStore,
  "updateContent" | "updateStreamingContent" | "upsertToolResult" | "setRuntimeNotices"
>;

type TurnTranscriptLogger = {
  warn(payload: unknown, message: string): void;
  error(payload: unknown, message: string): void;
};

const PROGRESS_TOOL_EVENTS = new Set(["tool_meta", "tool_status", "tool_mcp_app"]);

// A thrown error does not pass through the global error handler: the SSE
// reply is hijacked, and a scheduled turn has no reply. Error instances with
// a 4xx status/statusCode pass through their message. That status alone does
// not prove the text is safe; review classification and redaction separately.
function clientSafeFailureMessage(error: unknown): string {
  const raw = error as { statusCode?: unknown; status?: unknown } | null | undefined;
  const status = typeof raw?.statusCode === "number" ? raw.statusCode : raw?.status;
  if (typeof status === "number" && status >= 400 && status < 500 && error instanceof Error) {
    return error.message;
  }
  return GENERIC_TURN_FAILURE;
}

/** Outcome for a failed turn, with 4xx message passthrough or a generic message. */
export function classifyTurnFailure(error: unknown, cancelled: boolean): TurnOutcome {
  return cancelled
    ? { status: "interrupted" }
    : { status: "error", message: clientSafeFailureMessage(error) };
}

// Tool `textOffset` and reasoning-segment `offset` point into the raw assistant
// text. The store saves `redactSecrets(assistantText)`, which is shorter when
// the model quotes a secret. Without a remap, reload puts cards and reasoning
// at the wrong points. The new offset is the length of the redacted prefix.
// A secret that crosses the offset does not match in the prefix, but that
// offset is inside the secret and the frontend clamps it into `[REDACTED]`.
// When redaction changes nothing (the usual case), offsets pass through.
function makeOffsetRemap(rawText: string): (offset: number) => number {
  if (redactSecrets(rawText).length === rawText.length) {
    return (offset) => offset;
  }
  const cache = new Map<number, number>();
  return (offset) => {
    const cached = cache.get(offset);
    if (cached !== undefined) return cached;
    const remapped = redactSecrets(rawText.slice(0, offset)).length;
    cache.set(offset, remapped);
    return remapped;
  };
}

function contentFor(outcome: TurnOutcome, text: string): string {
  return outcome.status === "error" ? text || outcome.message : text;
}

export class TurnTranscript {
  private readonly turn = new AguiTurnAccumulator();
  private eventOutcome: TurnOutcome = { status: "completed" };
  private readonly savedTools = new Map<string, string>();
  private readonly savedAppCalls = new Set<string>();
  private savedPlan = "";
  private notices: unknown[] = [];
  private noticeVersion = 0;
  private savedNoticeVersion = 0;
  private progress: Promise<void> = Promise.resolve();
  private finalized: Promise<FinalizedTurn> | null = null;

  constructor(
    private readonly input: {
      messages: TurnTranscriptMessages;
      tenantId: string;
      sessionId: string;
      userId: string;
      messageId: string;
      logger?: TurnTranscriptLogger;
      /**
       * A caller-level failure that can start while `finalize` runs, such as
       * a scheduled-job timeout. It is read before the text/status write and
       * again after the rich writes. It wins over every other outcome.
       */
      lateFailure?: () => TurnOutcome | undefined;
    }
  ) {}

  get messageId(): string {
    return this.input.messageId;
  }

  get assistantText(): string {
    return this.turn.assistantText;
  }

  /**
   * Records one runtime event. The last RUN_ERROR or interrupt marker sets the
   * outcome. With `saveProgress`, it also queues the mid-turn write that the
   * event causes, if any. A caller that writes the row only at the end omits it.
   */
  apply(event: BaseEvent, options: { saveProgress?: boolean } = {}): void {
    this.turn.apply(event);
    if (isAGUIInterruptedFinish(event)) {
      // Turn-abort marker carried on RUN_FINISHED.result. See
      // AGUI_INTERRUPTED_RESULT for why it is not the AG-UI interrupt outcome.
      this.eventOutcome = { status: "interrupted" };
    } else if (event.type === EventType.RUN_ERROR) {
      // Provider and graph failures arrive as an event, not a throw.
      const message = (event as { message?: unknown }).message;
      this.eventOutcome = {
        status: "error",
        message: typeof message === "string" ? message : GENERIC_TURN_FAILURE
      };
    } else if (event.type === EventType.CUSTOM) {
      const custom = event as { name?: string; value?: unknown };
      if (custom.name === "runtime_notice" && custom.value) {
        this.notices.push(custom.value);
        if (this.notices.length > MAX_RUNTIME_NOTICES) this.notices.shift();
        this.noticeVersion += 1;
      }
    }
    if (options.saveProgress) this.queueProgress(event);
  }

  // Queues the mid-turn write for an event already recorded: plan, runtime
  // notices, or the affected tool result. Other events queue nothing. Writes run in order and are best effort.
  private queueProgress(event: BaseEvent): void {
    const plan = event.type === EventType.STATE_DELTA ? this.turn.planMarkdown : undefined;
    let toolId: string | undefined;
    let notices: { snapshot: unknown[]; version: number } | undefined;
    if (event.type === EventType.TOOL_CALL_START || event.type === EventType.TOOL_CALL_END ||
      event.type === EventType.TOOL_CALL_RESULT) {
      toolId = (event as { toolCallId?: string }).toolCallId;
    }
    if (event.type === EventType.CUSTOM) {
      const custom = event as { name?: string; value?: Record<string, unknown> };
      if (PROGRESS_TOOL_EVENTS.has(custom.name ?? "")) {
        toolId = typeof custom.value?.toolCallId === "string" ? custom.value.toolCallId : undefined;
      }
      if (custom.name === "runtime_notice" && custom.value) {
        notices = { snapshot: this.notices.slice(), version: this.noticeVersion };
      }
    }
    const tool = toolId ? this.turn.toolResults().find((item) => item.toolResultId === toolId) : undefined;
    if (plan === undefined && !notices && !tool) return;
    const assistantText = this.turn.assistantText;
    const { messages, tenantId, messageId, userId } = this.input;
    this.progress = this.progress.then(async () => {
      try {
        if (plan !== undefined && plan !== this.savedPlan) {
          await messages.updateStreamingContent(tenantId, messageId, userId, { planContent: plan });
          this.savedPlan = plan;
        }
        if (notices) {
          await messages.setRuntimeNotices(tenantId, messageId, userId, notices.snapshot);
          this.savedNoticeVersion = notices.version;
        }
        if (tool) await this.persistTool(tool, assistantText);
      } catch (err) {
        this.input.logger?.warn({ err, sessionId: this.input.sessionId }, "failed to save AG-UI turn progress");
      }
    });
  }

  /** Resolves when every queued progress write has settled. */
  settleProgress(): Promise<void> {
    return this.progress;
  }

  /** True when the tool result that carries this MCP App call is saved. */
  hasSavedAppCall(toolCallId: string): boolean {
    return this.savedAppCalls.has(toolCallId);
  }

  /**
   * Writes the terminal row. Without `override`, the outcome comes from the
   * events. Callers pass an override for a thrown turn or a caller-level
   * failure such as a scheduled-job timeout.
   */
  finalize(override?: TurnOutcome, durationMs?: number): Promise<FinalizedTurn> {
    this.finalized ??= this.writeFinal(override ?? this.eventOutcome, durationMs);
    return this.finalized;
  }

  private async writeFinal(requested: TurnOutcome, durationMs: number | undefined): Promise<FinalizedTurn> {
    await this.progress;
    const text = this.turn.assistantText;
    const early = this.input.lateFailure?.();
    const outcome = early ?? requested;
    if (!(await this.writeStatus(outcome, text, durationMs))) {
      return this.writeFailureStatus(outcome, text, durationMs);
    }

    // Rich parts are best effort: a failure here must not change the saved
    // text/status, which the context meter and job ledger depend on.
    try {
      await this.writeRichTranscript();
    } catch (err) {
      this.input.logger?.warn({ err, sessionId: this.input.sessionId, tenantId: this.input.tenantId },
        "failed to persist AG-UI turn transcript (reasoning/plan/tool results)");
    }

    const late = early ? undefined : this.input.lateFailure?.();
    if (late) {
      if (!(await this.writeStatus(late, text, durationMs))) {
        return this.writeFailureStatus(late, text, durationMs);
      }
      return { outcome: late, text, persisted: true };
    }
    return { outcome, text, persisted: true };
  }

  // Returns false when the write threw or updated no row.
  private async writeStatus(outcome: TurnOutcome, text: string, durationMs: number | undefined): Promise<boolean> {
    const { messages, tenantId, messageId, userId, sessionId, logger } = this.input;
    try {
      const row = await messages.updateContent(
        tenantId, messageId, userId, outcome.status, contentFor(outcome, text), durationMs);
      if (row) return true;
      logger?.error({ sessionId, tenantId, messageId }, "the assistant turn outcome updated no message row");
    } catch (err) {
      logger?.error({ err, sessionId, tenantId }, "failed to save the assistant turn outcome");
    }
    return false;
  }

  // After a failed text/status write, try once more so a transient failure
  // does not leave the row pending until the stale-message sweep. This write
  // never saves "completed", and the result is never persisted.
  private async writeFailureStatus(
    failed: TurnOutcome,
    text: string,
    durationMs: number | undefined
  ): Promise<FinalizedTurn> {
    const outcome: TurnOutcome = this.input.lateFailure?.() ??
      (failed.status === "completed" ? { status: "error", message: GENERIC_TURN_FAILURE } : failed);
    await this.writeStatus(outcome, text, durationMs);
    return { outcome, text, persisted: false };
  }

  // Writes only what the turn produced and what progress writes did not save.
  // A chat-only turn touches nothing here.
  private async writeRichTranscript(): Promise<void> {
    const { messages, tenantId, messageId, userId } = this.input;
    const remapOffset = makeOffsetRemap(this.turn.assistantText);

    const reasoningContent = this.turn.reasoningText.trim();
    const reasoningSegments = this.turn
      .reasoningSegments()
      .map((segment) => ({ ...segment, offset: remapOffset(segment.offset) }));
    const planContent = this.turn.planMarkdown.trim();
    if (reasoningContent || reasoningSegments.length > 0 || planContent !== this.savedPlan) {
      await messages.updateStreamingContent(tenantId, messageId, userId, {
        // reasoning_content is the flat copy that the admin replay shows.
        // Chat history reads reasoning_segments.
        ...(reasoningContent ? { reasoningContent } : {}),
        ...(reasoningSegments.length > 0 ? { reasoningSegments } : {}),
        ...(planContent !== this.savedPlan ? { planContent } : {})
      });
    }

    if (this.noticeVersion !== this.savedNoticeVersion) {
      await messages.setRuntimeNotices(tenantId, messageId, userId, this.notices.slice());
      this.savedNoticeVersion = this.noticeVersion;
    }

    for (const result of this.turn.toolResults()) {
      await this.persistTool(result.status === "in_progress" ? { ...result, status: "failed" } : result);
    }
  }

  private async persistTool(result: AccumulatedToolResult, assistantText = this.turn.assistantText): Promise<void> {
    const stored = {
      ...result,
      textOffset: makeOffsetRemap(assistantText)(result.textOffset)
    };
    const fingerprint = JSON.stringify(stored);
    if (this.savedTools.get(result.toolResultId) === fingerprint) return;
    const saved = await this.input.messages.upsertToolResult({
      tenantId: this.input.tenantId,
      messageId: this.input.messageId,
      sessionId: this.input.sessionId,
      userId: this.input.userId,
      ...stored
    });
    if (result.mcpApp) {
      if (saved.mcpApp) this.savedAppCalls.add(result.toolResultId);
      else this.input.logger?.warn({ toolCallId: result.toolResultId, sessionId: this.input.sessionId },
        "MCP App result was not saved; suppressing the live app");
    }
    this.savedTools.set(result.toolResultId, fingerprint);
  }
}
