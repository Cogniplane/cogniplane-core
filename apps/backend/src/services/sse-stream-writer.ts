import type { FastifyBaseLogger } from "fastify";
import type { FastifyReply } from "fastify";
import type { RuntimeEvent, RuntimeReasoningEffort, RuntimeSessionRef, RuntimeUserInput } from "../runtime-contracts.js";
import { extractToolResultPayload, runtimeEventToSSEFrame, sseFrame } from "../runtime-contracts.js";

import type { ActiveTurnMessageMap } from "./active-turn-message-map.js";
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
  runtimeManager: {
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
   * Required for the LLM proxy to attribute upstream token usage to the
   * right assistant message. The writer registers
   * (sessionId, runtimeId) → assistantMessageId at turn start and clears
   * it in `finally`. The proxy reads from the same map on each upstream
   * request keyed off the rt_*'s sid+rid claims.
   */
  activeTurnMessageMap: ActiveTurnMessageMap;
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
  reply: FastifyReply;
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
};

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
  ctx.reply.raw.write(
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
  // Token usage + cost are persisted by the LLM proxy (single source of
  // truth — sandboxes can't under-report). The frontend reads cost_usd
  // from the messages row on the next fetch. Live SSE no longer carries
  // tokenUsage / costUsd in response.completed.
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
  ctx.reply.raw.write(sseFrame(frame.event, frame.data));
  return shouldBreak;
}

// ---------------------------------------------------------------------------
// Runtime session orchestration
// ---------------------------------------------------------------------------

async function runRuntimeTurn(
  input: StreamAssistantReplyInput,
  ctx: TurnContext
): Promise<void> {
  const runtimeSession = await input.runtimeManager.createSession({
    tenantId: input.tenantId,
    sessionId: input.sessionId,
    userId: input.userId
  });

  const toolContext = await input.toolContexts.create({
    tenantId: input.tenantId,
    sessionId: input.sessionId,
    userId: input.userId,
    runtimeId: runtimeSession.runtimeId,
    runtimePolicyId: runtimeSession.runtimePolicy.id,
    messageId: ctx.assistantMessageId,
    metadata: {
      selectedArtifactIds: input.selectedArtifactIds ?? [],
      runtimePolicy: runtimeSession.runtimePolicy
    },
    ttlMs: 15 * 60 * 1000
  });

  // Mutable state populated by onBeforeTurn (runs after any transparent
  // runtime restart, guaranteeing the sandbox is alive and fresh).
  const scopedArtifacts = input.scopedArtifacts ?? [];
  const turnState: { userInputs?: RuntimeUserInput[]; cleanup: Array<() => Promise<void>> } = {
    userInputs: undefined,
    cleanup: []
  };

  const onBeforeTurn = scopedArtifacts.length && input.artifactProcessor && input.storage && input.runtimeManager.writeRuntimeFile
    ? async () => {
        let syncedArtifacts: Awaited<ReturnType<typeof syncArtifactsToWorkspace>> | undefined;
        try {
          syncedArtifacts = await syncArtifactsToWorkspace({
            sessionId: input.sessionId,
            scopedArtifacts,
            storage: input.storage!,
            writeRuntimeFile: (sid, fp, data) => input.runtimeManager.writeRuntimeFile!(sid, fp, data)
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

  // Register the active turn so the LLM proxy can charge upstream token
  // usage to this assistant message. The proxy looks up by sid+rid from
  // the rt_*'s claims; this is the single producer of that mapping.
  input.activeTurnMessageMap.set(
    input.sessionId,
    runtimeSession.runtimeId,
    ctx.assistantMessageId,
    input.modelName
  );
  try {
    for await (const event of input.runtimeManager.runMessage(runtimeSession, {
      prompt: input.prompt,
      runtimePolicyId: runtimeSession.runtimePolicy.id,
      toolContextId: toolContext.toolContextId,
      assistantMessageId: ctx.assistantMessageId,
      model: ctx.modelName,
      effort: input.effort,
      onBeforeTurn,
      get userInputs() { return turnState.userInputs; }
    })) {
      const shouldBreak = await handleStreamEvent(ctx, event);
      if (shouldBreak) {
        break;
      }
    }
  } finally {
    input.activeTurnMessageMap.clear(input.sessionId, runtimeSession.runtimeId);
    if (turnState.cleanup.length) {
      await Promise.allSettled(turnState.cleanup.map((fn) => fn()));
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function streamAssistantReply(input: StreamAssistantReplyInput): Promise<void> {
  if (input.userMessageReplacement) {
    input.reply.raw.write(
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

  const ctx: TurnContext = {
    tenantId: input.tenantId,
    sessionId: input.sessionId,
    userId: input.userId,
    modelName: input.modelName,
    assistantMessageId: assistant.messageId,
    reply: input.reply,
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
    }
  };

  input.activeTurns?.mark(input.sessionId);
  try {
    await runRuntimeTurn(input, ctx);
  } catch (error) {
    ctx.completed = true;
    const message = error instanceof Error ? error.message : "Runtime request failed";
    input.logger?.error(
      { err: error, sessionId: input.sessionId, tenantId: input.tenantId, userId: input.userId },
      "runtime turn failed"
    );
    await ctx.persistAssistantStatus("error", ctx.streamingContent.assistant || message);
    await persistStreamingAuxContent(ctx);
    input.reply.raw.write(
      sseFrame("response.failed", {
        type: "response.failed",
        response: { id: ctx.latestResponseId, status: "failed" },
        error: { message }
      })
    );
  } finally {
    if (!ctx.completed) {
      input.reply.raw.write(
        sseFrame("response.completed", {
          type: "response.completed",
          response: { id: ctx.latestResponseId, status: "failed" }
        })
      );
    }
    input.reply.raw.end();
    input.activeTurns?.clear(input.sessionId);
  }
}
