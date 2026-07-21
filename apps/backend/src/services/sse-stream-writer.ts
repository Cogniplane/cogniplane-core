import type { FastifyBaseLogger } from "fastify";
import type { FastifyReply } from "fastify";
import type { PolicyTurnContext } from "@cogniplane/shared-types";
import type { RuntimeEvent, RuntimeReasoningEffort, RuntimeSessionRef, RuntimeUserInput } from "../runtime-contracts.js";
import { extractToolResultPayload, runtimeEventToSSEFrame, sseFrame } from "../runtime-contracts.js";

import type { ActiveTurnsRegistry } from "./active-turns-registry.js";
import type { ArtifactRecord } from "./artifacts/artifact-store.js";
import type { ArtifactStorage } from "./artifacts/artifact-storage.js";
import type { ArtifactProcessor } from "./artifacts/artifact-processor.js";
import type { MessageStore } from "./message-store.js";
import type { ToolExecutionContextStore } from "./auth/tool-execution-context-store.js";
import { buildArtifactTurnInputs } from "./turn-input-builder.js";
import { syncArtifactsToWorkspace } from "./artifacts/artifact-workspace-sync.js";
import { redactSecrets } from "./redact-secrets.js";

type ToolResultPersistPayload = ReturnType<typeof extractToolResultPayload>;

// The SSE reply is hijacked, so a runtime failure never passes through the
// global `handleAppError` that opaques internal 5xx messages. Apply the same
// policy here: only surface `error.message` for errors that deliberately set a
// 4xx status (client-safe by the app's convention); everything else (DB,
// E2B/runtime, unset status) gets a generic message so connection strings,
// internal hostnames, or stack detail can't reach the client — or get
// persisted as the assistant row's content. The full error is always logged
// server-side at the call site.
export function clientSafeFailureMessage(error: unknown): string {
  // Anthropic/OpenAI SDK errors (and LangChain's re-throws) carry `.status`;
  // some app-thrown errors use `.statusCode`. Accept either as the 4xx signal.
  const raw = error as { statusCode?: unknown; status?: unknown } | null | undefined;
  const status = typeof raw?.statusCode === "number" ? raw.statusCode : raw?.status;
  if (typeof status === "number" && status >= 400 && status < 500 && error instanceof Error) {
    return error.message;
  }
  return "The assistant run failed.";
}

// Tool result `input` and `output` strings can contain secrets echoed by an
// upstream MCP server (Bearer headers, GitHub PATs, etc.). They are persisted
// to message_tool_results and later replayed back to the model — sanitize at
// the persistence boundary so secrets never reach the audit trail or the
// next turn's prompt context.
function redactToolResultPayload(payload: ToolResultPersistPayload): ToolResultPersistPayload {
  return {
    ...payload,
    input: redactSecrets(payload.input),
    output: redactSecrets(payload.output)
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StreamAssistantReplyInput = {
  logger?: FastifyBaseLogger;
  reply: FastifyReply;
  messages: MessageStore;
  toolContexts: ToolExecutionContextStore;
  runtimeAdapter: {
    createSession(input: { tenantId: string; sessionId: string; userId: string }): Promise<RuntimeSessionRef>;
    runMessage(
      session: RuntimeSessionRef,
      input: {
        prompt: string;
        userInputs?: RuntimeUserInput[];
        runtimePolicyId: string;
        toolContextId: string | null;
        assistantMessageId?: string | null;
        effort?: RuntimeReasoningEffort;
        [key: string]: unknown;
      }
    ): AsyncIterable<RuntimeEvent>;
    writeRuntimeFile?: (sessionId: string, filePath: string, data: Uint8Array | ArrayBuffer | string) => Promise<string>;
    /**
     * Cancel the in-flight runtime turn for this session while keeping the
     * session warm. Called when the SSE client disconnects mid-stream so the
     * runtime stops generating (avoids billable tokens + DB writes for output
     * nobody will see). Optional: adapters without a turn-interrupt path omit it.
     */
    interruptTurn?: (input: {
      tenantId: string;
      sessionId: string;
      userId: string;
    }) => Promise<"interrupted" | "no_active_turn">;
  };
  tenantId: string;
  sessionId: string;
  userId: string;
  modelName: string;
  effort?: RuntimeReasoningEffort;
  prompt: string;
  scopedArtifacts?: ArtifactRecord[];
  artifactProcessor?: ArtifactProcessor;
  storage?: ArtifactStorage;
  selectedArtifactIds?: string[];
  sourceArtifactNames?: string[];
  /**
   * When the prompt-path PII policy transformed the user text, the route
   * passes the persisted user message id and the transformed text. The
   * stream writer emits a `runtime.user_message_replaced` SSE event as the
   * very first frame of the turn so the frontend can patch its optimistic
   * user message before any assistant output arrives.
   */
  userMessageReplacement?: {
    messageId: string;
    text: string;
    scanRunId?: string;
  };
  /**
   * When provided, the session id is marked active for the lifetime of this
   * turn so the sidebar can show a "busy" dot on non-selected sessions in the
   * same backend process.
   */
  activeTurns?: ActiveTurnsRegistry;
  /**
   * Whether this is an interactive or scheduled (unattended) turn. Snapshotted
   * into the tool-execution context so the Policy Center `turnContexts` condition
   * dimension can be matched at the MCP gateway without a hot-path DB lookup.
   * Omitted → recorded as unknown (the dimension acts as "no constraint").
   */
  turnContext?: PolicyTurnContext;
  /**
   * Lifetime of the per-turn tool-execution context (ms). MUST outlive the
   * longest turn the platform allows, otherwise a long-running turn loses all
   * managed MCP tool access mid-flight (the gateway filters expired contexts).
   * Threaded from `TOOL_CONTEXT_TTL_MS`, which config validation pins above
   * `RUNTIME_TURN_TIMEOUT_MS`. Defaults conservatively if omitted (test harness).
   */
  toolContextTtlMs?: number;
};

/**
 * Mutable context threaded through event handlers for a single turn.
 *
 * Fields fall into three groups:
 * - **Identity** (`tenantId`, `sessionId`, `userId`, `modelName`,
 *   `assistantMessageId`, `reply`, `messages`, `sourceArtifactNames`):
 *   set once at turn start, never mutated.
 * - **Streaming buffers** (`streamingContent.assistant`, `.reasoning`, `.plan`):
 *   appended to on every `*.delta` event and read at terminal events
 *   (`response.completed`, `response.failed`, output-item-done, and the
 *   top-level catch/finally) to persist final content and compose the
 *   artifact-provenance footer.
 * - **State flags + ids** (`provenanceAppended`, `completed`,
 *   `latestResponseId`): `latestResponseId` tracks the most recent frame so
 *   synthetic terminal frames can reference it; `provenanceAppended` is
 *   idempotency for the source-footer; `completed` is the turn's terminal
 *   state machine — *set* by `persistResponseCompleted`,
 *   `persistResponseFailed`, and the top-level `catch`; *read* only by the
 *   `finally` guard in `streamAssistantReply` that emits a synthetic
 *   `response.completed{status:failed}` when no terminal frame arrived.
 */
type ToolResultPayload = ReturnType<typeof extractToolResultPayload>;

type TurnContext = {
  tenantId: string;
  sessionId: string;
  userId: string;
  modelName: string;
  assistantMessageId: string;
  writer: SseWriter;
  messages: StreamAssistantReplyInput["messages"];
  sourceArtifactNames: string[] | undefined;
  streamingContent: {
    assistant: string;
    reasoning: string;
    plan: string;
  };
  provenanceAppended: boolean;
  completed: boolean;
  latestResponseId: string;
  /** Bundles the identity tuple (tenantId, assistantMessageId, userId) into a single call. */
  persistAssistantStatus: (
    status: "streaming" | "completed" | "error" | "interrupted",
    content: string
  ) => Promise<void>;
  /** Bundles identity + sessionId for tool-result upserts. */
  persistToolResult: (payload: ToolResultPayload) => Promise<void>;
  /** Bundles identity for tool-output deltas. */
  appendToolResultOutput: (toolResultId: string, delta: string) => Promise<void>;
  /** Bundles identity for retraction deletes (refusal fallback). */
  deleteToolResults: (toolResultIds: string[]) => Promise<void>;
};

// ---------------------------------------------------------------------------
// SSE writer with backpressure + disconnect handling
// ---------------------------------------------------------------------------

// Minimal slice of `http.ServerResponse` we rely on. Declared structurally so
// the test fake doesn't have to satisfy the full Node typing.
export type RawSseResponse = {
  write(chunk: string): boolean;
  end(): void;
  once?(event: "drain", listener: () => void): unknown;
  on?(event: "close", listener: () => void): unknown;
  writableEnded?: boolean;
  destroyed?: boolean;
};

/**
 * Wraps `reply.raw` to (a) respect TCP backpressure — when `write()` returns
 * `false` the socket buffer is full, so we await `drain` before queueing more
 * frames instead of growing an unbounded in-memory buffer — and (b) stop
 * writing entirely once the client disconnects. `closed` flips on the socket
 * `close` event; callers check it (via `isClosed`) to short-circuit further
 * work and to cancel the runtime turn.
 */
export class SseWriter {
  private closed = false;
  private readonly onCloseCallbacks = new Set<() => void>();

  constructor(private readonly raw: RawSseResponse) {
    raw.on?.("close", () => {
      if (this.closed) return;
      this.closed = true;
      for (const cb of this.onCloseCallbacks) {
        cb();
      }
    });
  }

  get isClosed(): boolean {
    return this.closed || this.raw.writableEnded === true || this.raw.destroyed === true;
  }

  onClose(cb: () => void): void {
    if (this.closed) {
      cb();
      return;
    }
    this.onCloseCallbacks.add(cb);
  }

  // Fire-and-forget write that still honours backpressure. Returns a promise
  // that resolves once the frame is buffered and (if the socket was full) the
  // drain has occurred. Resolves immediately when the client is gone so the
  // turn loop can unwind instead of hanging on a drain that will never fire.
  async write(frame: string): Promise<void> {
    if (this.isClosed) return;
    const ok = this.raw.write(frame);
    if (ok || !this.raw.once) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        // Deregister so a long-lived stream with many backpressured writes
        // doesn't accumulate one dead callback per drain.
        this.onCloseCallbacks.delete(finish);
        resolve();
      };
      this.raw.once!("drain", finish);
      // The socket may close while we're parked waiting for drain — unblock so
      // the loop can observe `isClosed` and stop.
      this.onClose(finish);
    });
  }

  end(): void {
    if (this.raw.writableEnded === true) return;
    this.raw.end();
  }
}

// ---------------------------------------------------------------------------
// Artifact provenance
// ---------------------------------------------------------------------------

// Persist reasoning/plan content accumulated during a turn. Called at the
// terminal event of each turn so the frontend sees these fields after a
// refresh or session switch (where only the API's listMessages is consulted).
async function persistStreamingAuxContent(ctx: TurnContext): Promise<void> {
  if (!ctx.streamingContent.reasoning && !ctx.streamingContent.plan) return;
  await ctx.messages.updateStreamingContent(
    ctx.tenantId,
    ctx.assistantMessageId,
    ctx.userId,
    {
      ...(ctx.streamingContent.reasoning ? { reasoningContent: ctx.streamingContent.reasoning } : {}),
      ...(ctx.streamingContent.plan ? { planContent: ctx.streamingContent.plan } : {})
    }
  );
}

async function appendArtifactProvenance(ctx: TurnContext, responseId: string): Promise<void> {
  if (ctx.provenanceAppended || !ctx.streamingContent.assistant.trim() || !ctx.sourceArtifactNames?.length) {
    return;
  }

  const provenanceDelta = `\n\nSources: ${ctx.sourceArtifactNames.join(", ")}`;
  ctx.streamingContent.assistant += provenanceDelta;
  ctx.provenanceAppended = true;

  await ctx.persistAssistantStatus("streaming", ctx.streamingContent.assistant);
  await ctx.writer.write(
    sseFrame("response.output_text.delta", {
      type: "response.output_text.delta",
      response_id: responseId,
      item_id: ctx.assistantMessageId,
      delta: provenanceDelta
    })
  );
}

// ---------------------------------------------------------------------------
// Per-event persistence + SSE writes
// ---------------------------------------------------------------------------

type PersistResult = {
  break: boolean;
};

// `output_item.done` means "this output item finished," not "the turn
// finished." Claude can emit it many times per turn (assistant text →
// tool_use → tool_result → assistant → …). Flipping the message status
// to "completed" here shows a premature completion pill in the UI on
// the very first assistant block. Status is owned by
// `response.completed` / `response.failed`; here we only persist the
// current content so the in-progress row stays current.
async function persistOutputItemDone(
  ctx: TurnContext,
  event: Extract<RuntimeEvent, { type: "response.output_item.done" }>
): Promise<void> {
  await appendArtifactProvenance(ctx, event.responseId);
  await ctx.persistAssistantStatus("streaming", ctx.streamingContent.assistant);
  await persistStreamingAuxContent(ctx);
}

async function persistToolStarted(
  ctx: TurnContext,
  event: Extract<RuntimeEvent, { type: "response.tool.started" }>
): Promise<void> {
  await ctx.persistToolResult(
    redactToolResultPayload(
      extractToolResultPayload(event.toolCall, {
        output: "",
        exitCode: null,
        durationMs: null
      })
    )
  );
}

async function persistToolOutputDelta(
  ctx: TurnContext,
  event: Extract<RuntimeEvent, { type: "response.tool.output.delta" }>
): Promise<void> {
  await ctx.appendToolResultOutput(event.itemId, redactSecrets(event.delta));
}

async function persistToolCompleted(
  ctx: TurnContext,
  event: Extract<RuntimeEvent, { type: "response.tool.completed" }>
): Promise<void> {
  await ctx.persistToolResult(redactToolResultPayload(extractToolResultPayload(event.toolCall)));
}

async function persistResponseCompleted(
  ctx: TurnContext,
  event: Extract<RuntimeEvent, { type: "response.completed" }>
): Promise<PersistResult> {
  ctx.completed = true;
  await appendArtifactProvenance(ctx, event.responseId);
  // Stop button: persist whatever assistant text has streamed so far under
  // the "interrupted" status so the bubble renders a "Stopped" badge instead
  // of a green check.
  const finalStatus = event.interrupted ? "interrupted" : "completed";
  await ctx.persistAssistantStatus(finalStatus, ctx.streamingContent.assistant);
  await persistStreamingAuxContent(ctx);
  // Token usage + cost are persisted by the in-process runtime adapter from
  // the model stream's usage_metadata (the sandbox is never on the model-call
  // path, so it can't under-report). The frontend reads cost_usd from the
  // messages row on the next fetch. Live SSE no longer carries tokenUsage /
  // costUsd in response.completed.
  return { break: true };
}

async function persistResponseFailed(
  ctx: TurnContext,
  event: Extract<RuntimeEvent, { type: "response.failed" }>
): Promise<void> {
  ctx.completed = true;
  await ctx.persistAssistantStatus(
    "error",
    ctx.streamingContent.assistant || event.message
  );
  await persistStreamingAuxContent(ctx);
}

// Apply side effects (DB writes, accumulator updates) for a single event.
// Returns {break, extras} — extras carry data the wire format needs but
// only the writer can compute (cost calc against tenant's model).
async function persistEvent(
  ctx: TurnContext,
  event: RuntimeEvent
): Promise<PersistResult> {
  switch (event.type) {
    case "framework:mcp_server_status":
      return { break: false };

    case "response.created":
    case "framework:approval_required":
    case "framework:runtime_notice":
      ctx.latestResponseId = event.responseId;
      return { break: false };

    case "response.output_text.delta":
      ctx.latestResponseId = event.responseId;
      ctx.streamingContent.assistant += event.delta;
      return { break: false };

    // Retraction: the runtime evicted already-streamed content (e.g. a Claude
    // refusal fallback) — overwrite the accumulated buffer and the persisted
    // row so the refused partial doesn't survive in the transcript.
    case "response.output_text.replace":
      ctx.latestResponseId = event.responseId;
      ctx.streamingContent.assistant = event.text;
      // The replacement text never carries the writer-appended Sources footer
      // — re-arm provenance so the corrected response gets it again.
      ctx.provenanceAppended = false;
      await ctx.persistAssistantStatus("streaming", ctx.streamingContent.assistant);
      return { break: false };

    case "framework:reasoning_summary.replace":
      ctx.latestResponseId = event.responseId;
      ctx.streamingContent.reasoning = event.text;
      // Persist directly (not via persistStreamingAuxContent, which skips
      // empty strings) so a replace-to-empty clears the stored reasoning too.
      await ctx.messages.updateStreamingContent(ctx.tenantId, ctx.assistantMessageId, ctx.userId, {
        reasoningContent: ctx.streamingContent.reasoning
      });
      return { break: false };

    case "framework:reasoning_text.delta":
    case "framework:reasoning_summary.delta":
      ctx.latestResponseId = event.responseId;
      ctx.streamingContent.reasoning += event.delta;
      return { break: false };

    case "framework:plan.delta":
      ctx.latestResponseId = event.responseId;
      ctx.streamingContent.plan += event.delta;
      return { break: false };

    case "response.output_item.done":
      ctx.latestResponseId = event.responseId;
      await persistOutputItemDone(ctx, event);
      return { break: false };

    case "response.tool.started":
      ctx.latestResponseId = event.responseId;
      await persistToolStarted(ctx, event);
      return { break: false };

    case "response.tool.output.delta":
      ctx.latestResponseId = event.responseId;
      await persistToolOutputDelta(ctx, event);
      return { break: false };

    case "response.tool.completed":
      ctx.latestResponseId = event.responseId;
      await persistToolCompleted(ctx, event);
      return { break: false };

    // Retraction: tool events from a since-retracted message (refusal
    // fallback) — drop the persisted rows so the superseded activity doesn't
    // survive in the transcript.
    case "response.tool.retracted":
      ctx.latestResponseId = event.responseId;
      await ctx.deleteToolResults(event.itemIds);
      return { break: false };

    case "response.completed":
      ctx.latestResponseId = event.responseId;
      return persistResponseCompleted(ctx, event);

    case "response.failed":
      ctx.latestResponseId = event.responseId;
      await persistResponseFailed(ctx, event);
      return { break: true };
  }
}

// Returns true if the turn loop should break after this event.
async function handleStreamEvent(ctx: TurnContext, event: RuntimeEvent): Promise<boolean> {
  const { break: shouldBreak } = await persistEvent(ctx, event);
  const frame = runtimeEventToSSEFrame(event, ctx.assistantMessageId);
  await ctx.writer.write(sseFrame(frame.event, frame.data));
  return shouldBreak;
}

// ---------------------------------------------------------------------------
// Runtime session orchestration
// ---------------------------------------------------------------------------

async function runRuntimeTurn(
  input: StreamAssistantReplyInput,
  ctx: TurnContext
): Promise<void> {
  // Turn-latency instrumentation (Phase 0 startup-latency evaluation).
  // `sessionEnsureMs` covers createSession — the full sandbox bootstrap on a
  // cold start, ~0 on a warm reuse. First-event / first-text-delta offsets are
  // measured from when the runtime turn starts streaming. One
  // `turn_latency_timing` log line per turn; aggregated by
  // scripts/analyze-startup-latency.mjs.
  const turnStartedAtMs = performance.now();
  const runtimeSession = await input.runtimeAdapter.createSession({
    tenantId: input.tenantId,
    sessionId: input.sessionId,
    userId: input.userId
  });
  const sessionEnsureMs = Math.round(performance.now() - turnStartedAtMs);

  const toolContext = await input.toolContexts.create({
    tenantId: input.tenantId,
    sessionId: input.sessionId,
    userId: input.userId,
    runtimeId: runtimeSession.runtimeId,
    runtimePolicyId: runtimeSession.runtimePolicy.id,
    messageId: ctx.assistantMessageId,
    metadata: {
      selectedArtifactIds: input.selectedArtifactIds ?? [],
      runtimePolicy: runtimeSession.runtimePolicy,
      // Policy Center turn-context snapshot (read at the MCP gateway).
      ...(input.turnContext ? { turnContext: input.turnContext } : {})
    },
    // Must outlive the whole turn — a shorter TTL silently revokes managed MCP
    // tool access mid-turn. Config pins TOOL_CONTEXT_TTL_MS above the turn
    // watchdog; the fallback matches the previous default for the test harness.
    ttlMs: input.toolContextTtlMs ?? 15 * 60 * 1000
  });

  // Mutable state populated by onBeforeTurn (runs after any transparent
  // runtime restart, guaranteeing the sandbox is alive and fresh).
  const scopedArtifacts = input.scopedArtifacts ?? [];
  const turnState: { userInputs?: RuntimeUserInput[]; cleanup: Array<() => Promise<void>> } = {
    userInputs: undefined,
    cleanup: []
  };

  const onBeforeTurn = scopedArtifacts.length && input.artifactProcessor && input.storage && input.runtimeAdapter.writeRuntimeFile
    ? async () => {
        let syncedArtifacts: Awaited<ReturnType<typeof syncArtifactsToWorkspace>> | undefined;
        try {
          syncedArtifacts = await syncArtifactsToWorkspace({
            sessionId: input.sessionId,
            scopedArtifacts,
            storage: input.storage!,
            writeRuntimeFile: (sid, fp, data) => input.runtimeAdapter.writeRuntimeFile!(sid, fp, data)
          });
        } catch (err) {
          input.logger?.warn({ err, sessionId: input.sessionId }, "artifact workspace sync failed");
        }

        const prepared = await buildArtifactTurnInputs({
          prompt: input.prompt,
          scopedArtifacts,
          artifactProcessor: input.artifactProcessor!,
          storage: input.storage!,
          syncedArtifacts
        });
        turnState.userInputs = prepared.userInputs;
        turnState.cleanup.push(...prepared.cleanup);
      }
    : undefined;

  // Client disconnect mid-stream: cancel the runtime turn so it stops
  // generating (no more billable tokens, no more DB writes for output nobody
  // will ever see). The runtime stays warm — `interruptTurn` only stops the
  // turn, not the session. Fire-and-forget; the for-await loop below also
  // observes `writer.isClosed` and unwinds.
  let interruptedByDisconnect = false;
  // Set once the turn reaches a terminal state. A normal completion calls
  // `writer.end()`, which also makes Node emit `close` — without this guard the
  // close handler would fire `interruptTurn` (session-scoped!) and could cancel
  // a follow-up turn the user already started on the same session. Only a close
  // that arrives WHILE the turn is still streaming is a real client disconnect.
  let turnSettled = false;
  ctx.writer.onClose(() => {
    if (interruptedByDisconnect || turnSettled) return;
    interruptedByDisconnect = true;
    void Promise.resolve(
      input.runtimeAdapter.interruptTurn?.({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        userId: input.userId
      })
    ).catch((err) => {
      input.logger?.warn(
        { err, sessionId: input.sessionId },
        "failed to cancel runtime turn after client disconnect"
      );
    });
  });

  try {
    let abandoned = false;
    // Early-disconnect guard: the client can drop during session / tool-context
    // setup above, i.e. before any runtime turn exists for `onClose` to
    // interrupt (its `interruptTurn` would no-op). Don't start billable
    // generation for a connection that is already gone — fall straight through
    // to the abandoned-turn handling below.
    if (ctx.writer.isClosed) {
      abandoned = true;
    } else {
    const generateStartMs = performance.now();
    let firstEventMs: number | null = null;
    let firstTextDeltaMs: number | null = null;
    for await (const event of input.runtimeAdapter.runMessage(runtimeSession, {
      prompt: input.prompt,
      runtimePolicyId: runtimeSession.runtimePolicy.id,
      toolContextId: toolContext.toolContextId,
      assistantMessageId: ctx.assistantMessageId,
      model: ctx.modelName,
      effort: input.effort,
      onBeforeTurn,
      get userInputs() { return turnState.userInputs; }
    })) {
      if (firstEventMs === null) {
        firstEventMs = Math.round(performance.now() - generateStartMs);
      }
      if (firstTextDeltaMs === null && event.type === "response.output_text.delta") {
        firstTextDeltaMs = Math.round(performance.now() - generateStartMs);
      }
      // Stop draining the runtime once the browser is gone — the interrupt
      // fired above will land a terminal frame on the runtime side; here we
      // just stop persisting/writing for a connection no one is reading.
      if (ctx.writer.isClosed) {
        abandoned = true;
        break;
      }
      let shouldBreak: boolean;
      try {
        shouldBreak = await handleStreamEvent(ctx, event);
      } catch (err) {
        // Per-event persistence (or frame write) threw — e.g. a transient DB
        // failure. The exception is about to unwind to the outer catch, which
        // emits the terminal frame, but the in-process runtime turn is still
        // live and would keep generating into an unbounded queue nobody drains,
        // burning tokens for output that will never be persisted. Cancel it on
        // the way out, mirroring the client-disconnect path.
        if (!interruptedByDisconnect) {
          interruptedByDisconnect = true;
          void Promise.resolve(
            input.runtimeAdapter.interruptTurn?.({
              tenantId: input.tenantId,
              sessionId: input.sessionId,
              userId: input.userId
            })
          ).catch((interruptErr) => {
            input.logger?.warn(
              { err: interruptErr, sessionId: input.sessionId },
              "failed to cancel runtime turn after per-event persistence failure"
            );
          });
        }
        throw err;
      }
      if (shouldBreak) {
        break;
      }
    }
    input.logger?.info(
      {
        sessionId: input.sessionId,
        runtimeId: runtimeSession.runtimeId,
        sessionEnsureMs,
        firstEventMs,
        firstTextDeltaMs,
        // Full request→token latency: turn start (incl. session bootstrap and
        // tool-context setup) through the first assistant text delta.
        requestToFirstTextDeltaMs:
          firstTextDeltaMs === null
            ? null
            : Math.round(generateStartMs - turnStartedAtMs) + firstTextDeltaMs
      },
      "turn_latency_timing"
    );
    }
    if (abandoned && !ctx.completed) {
      // Client disconnected mid-turn. Persist whatever streamed so far under
      // "interrupted" so the row doesn't linger in "streaming" forever, and
      // mark the turn terminal so the outer `finally` doesn't try to emit a
      // (dropped) synthetic frame to the dead socket.
      ctx.completed = true;
      await ctx.persistAssistantStatus("interrupted", ctx.streamingContent.assistant);
      await persistStreamingAuxContent(ctx);
    }
  } finally {
    // The turn has reached a terminal state: any subsequent `close` (e.g. from
    // our own `writer.end()`) must NOT be treated as a client disconnect.
    turnSettled = true;
    if (turnState.cleanup.length) {
      // Cleanup callbacks are best-effort (temp-file removal etc.) and log
      // their own failures where it matters; a rejection here must never mask
      // the turn's real outcome, so rejections are intentionally not surfaced.
      await Promise.allSettled(turnState.cleanup.map((fn) => fn()));
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

// Below typical proxy/ALB idle timeouts (60s) so a long quiet stretch — a slow
// tool call or a long model think with no deltas — can't be closed by an
// intermediary as idle.
const SSE_HEARTBEAT_INTERVAL_MS = 20_000;

export async function streamAssistantReply(input: StreamAssistantReplyInput): Promise<void> {
  const writer = new SseWriter(input.reply.raw as unknown as RawSseResponse);

  // Idle keep-alive. An SSE comment frame (`: ...`) is ignored by EventSource
  // but keeps the socket warm. write() already no-ops once the client is gone
  // and respects backpressure, so this is fire-and-forget.
  const heartbeat = setInterval(() => {
    void writer.write(": keep-alive\n\n");
  }, SSE_HEARTBEAT_INTERVAL_MS);
  // Don't let the heartbeat timer keep the process alive on its own.
  heartbeat.unref?.();

  // The reply is already hijacked by the route (openSseResponse): from here on
  // Fastify can never turn a throw into an HTTP error response. The try below
  // must therefore cover EVERY await — including the replacement frame write
  // and the assistant-row insert — so a failure anywhere still delivers a
  // terminal frame and `writer.end()` always closes the socket.
  let ctx: TurnContext | undefined;
  try {
    if (input.userMessageReplacement) {
      await writer.write(
        sseFrame("runtime.user_message_replaced", {
          type: "runtime.user_message_replaced",
          message_id: input.userMessageReplacement.messageId,
          text: input.userMessageReplacement.text,
          scan_run_id: input.userMessageReplacement.scanRunId ?? null
        })
      );
    }

    const assistant = await input.messages.create({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      userId: input.userId,
      role: "assistant",
      status: "pending",
      content: ""
    });

    ctx = {
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      userId: input.userId,
      modelName: input.modelName,
      assistantMessageId: assistant.messageId,
      writer,
      messages: input.messages,
      sourceArtifactNames: input.sourceArtifactNames,
      streamingContent: {
        assistant: "",
        reasoning: "",
        plan: ""
      },
      provenanceAppended: false,
      completed: false,
      latestResponseId: assistant.messageId,
      async persistAssistantStatus(status, content) {
        await input.messages.updateContent(
          input.tenantId,
          assistant.messageId,
          input.userId,
          status,
          content
        );
      },
      async persistToolResult(payload) {
        await input.messages.upsertToolResult({
          tenantId: input.tenantId,
          messageId: assistant.messageId,
          sessionId: input.sessionId,
          userId: input.userId,
          ...payload
        });
      },
      async appendToolResultOutput(toolResultId, delta) {
        await input.messages.appendToolResultOutput(
          input.tenantId,
          toolResultId,
          input.userId,
          delta
        );
      },
      async deleteToolResults(toolResultIds) {
        await input.messages.deleteToolResults(input.tenantId, toolResultIds, input.userId);
      }
    };

    input.activeTurns?.mark(input.sessionId);
    await runRuntimeTurn(input, ctx);
  } catch (error) {
    if (ctx) ctx.completed = true;
    // Client-facing message is sanitized; the full error is logged below.
    const message = clientSafeFailureMessage(error);
    input.logger?.error(
      { err: error, sessionId: input.sessionId, tenantId: input.tenantId, userId: input.userId },
      "runtime turn failed"
    );
    // Emit the terminal failure frame BEFORE persistence. If
    // `persistAssistantStatus` throws (e.g. the DB is unreachable, which is a
    // plausible cause of the runtime failure in the first place), the client
    // must still receive a terminal frame instead of hanging on an open stream
    // forever. The frame is independent of the DB write.
    await writer.write(
      sseFrame("response.failed", {
        type: "response.failed",
        response: { id: ctx?.latestResponseId ?? null, status: "failed" },
        error: { message }
      })
    );
    // No assistant row exists when the insert itself failed — nothing to persist.
    // The sanitized message is also what gets persisted as the assistant row's
    // fallback content, so the raw error can't leak via listMessages either.
    if (ctx) {
      await persistTurnFailureBestEffort(input, ctx, message);
    }
  } finally {
    clearInterval(heartbeat);
    // ctx undefined means the catch above already emitted response.failed.
    if (ctx && !ctx.completed) {
      await writer.write(
        sseFrame("response.completed", {
          type: "response.completed",
          response: { id: ctx.latestResponseId, status: "failed" }
        })
      );
    }
    writer.end();
    input.activeTurns?.clear(input.sessionId);
  }
}

// Best-effort persistence of a failed turn. The terminal failure frame has
// already been written by the caller; a persistence failure here (e.g. the DB
// is unreachable — a plausible cause of the runtime failure in the first
// place) must not propagate and disrupt the socket-closing path.
async function persistTurnFailureBestEffort(
  input: StreamAssistantReplyInput,
  ctx: TurnContext,
  message: string
): Promise<void> {
  try {
    await ctx.persistAssistantStatus("error", ctx.streamingContent.assistant || message);
    await persistStreamingAuxContent(ctx);
  } catch (persistError) {
    input.logger?.error(
      { err: persistError, sessionId: input.sessionId, tenantId: input.tenantId, userId: input.userId },
      "failed to persist runtime turn failure"
    );
  }
}
