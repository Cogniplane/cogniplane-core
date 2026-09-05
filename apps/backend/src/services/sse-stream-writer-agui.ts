import { customEvent } from "./deep-agents/agui-events.js";
// AG-UI SSE writer.
//
// Drives one turn through the adapter's `runMessageAGUI` method and streams AG-UI
// `BaseEvent`s as SSE `data:` frames — the format `@ag-ui/client`'s HttpAgent /
// CopilotKit consumes directly.
//
// The live turn renders in CopilotKit from the wire. This writer also persists the
// turn's transcript so a reload renders the same as live: it creates the
// assistant row, checkpoints the accumulated text at a coarse interval while the
// turn runs, and at turn end records assistant text + status, reasoning, the plan
// pane, and every tool call/result — captured off the same event stream via
// `AguiTurnAccumulator`. It also hands the row id to `runMessageAGUI` so the
// adapter can attribute token usage and cost to it. `SseWriter` handles
// backpressure and disconnects. A disconnect cancels the runtime turn.
//
// The mid-turn checkpoints exist for the case no `finally` can cover: a SIGKILL
// or a rolling deploy drops the process mid-turn, so nothing runs to close the
// row out. Without them the row stays `pending` and empty forever. The
// checkpoint bounds the loss to one interval, and `sweepStaleAssistantMessages`
// (run at boot) flips whatever the crash left behind to `interrupted`.

import type { FastifyBaseLogger, FastifyReply } from "fastify";
import { EventType, type BaseEvent } from "@ag-ui/client";
import type { PolicyTurnContext } from "@cogniplane/shared-types";

import type { RuntimeReasoningEffort, RuntimeSessionRef, RuntimeUserInput } from "../runtime-contracts.js";
import { uuidv7 } from "../lib/uuid.js";
import type { ArtifactRecord } from "./artifacts/artifact-store.js";
import type { ArtifactStorage } from "./artifacts/artifact-storage.js";
import type { ArtifactProcessor } from "./artifacts/artifact-processor.js";
import type { MessageStore } from "./message-store.js";
import type { ToolExecutionContextStore } from "./auth/tool-execution-context-store.js";
import { buildArtifactTurnInputs } from "./turn-input-builder.js";
import { syncArtifactsToWorkspace } from "./artifacts/artifact-workspace-sync.js";
import { SseWriter, clientSafeFailureMessage, type RawSseResponse } from "./sse-writer.js";
import { AguiTurnAccumulator } from "./agui-turn-accumulator.js";
import { isAGUIInterruptedFinish } from "./deep-agents/agui-events.js";
import { redactSecrets } from "./redact-secrets.js";

const SSE_HEARTBEAT_INTERVAL_MS = 20_000;

// How often the in-progress assistant text is checkpointed to the row. Coarse on
// purpose: this is crash insurance, not the render path (the client renders from
// the wire), so one write every few seconds bounds the loss without putting a DB
// round-trip on the token-delta path.
const STREAMING_PERSIST_INTERVAL_MS = 3_000;

// How long the turn will wait for an in-flight checkpoint before finishing
// without it. The drain exists so a checkpoint cannot settle "streaming" after
// the terminal status — but the checkpoint is a database write with no
// cancellation, so an unbounded wait would trade one stuck row for a stuck
// REQUEST: no terminal update, no writer.end(), and the route's turn slot held
// until the pool gave up. Past this budget the turn finishes; the late
// checkpoint may then land last, which is the failure the drain was avoiding —
// but only when the database is already broken, and a stuck row is recoverable
// by sweepStaleAssistantMessages while a wedged session is not.
const CHECKPOINT_DRAIN_DEADLINE_MS = 2_000;

// Tool `textOffset` and reasoning-segment `offset` index into the RAW assistant
// text, but the persisted content is `redactSecrets(assistantText)` — which can
// SHORTEN the string when the model's own narration quotes a secret. Left
// uncorrected, reload slices the redacted (shorter) content at pre-redaction
// offsets, attaching cards/reasoning at the wrong points. Remap each offset to
// its position in the redacted text: the redacted prefix length. `redactSecrets`
// is a whole-string op, so a secret straddling the boundary can't match in the
// sliced prefix — but such an offset lands mid-secret, and the frontend clamps,
// so the result stays within `[REDACTED]`. Returns a pass-through remap when
// redaction changed nothing (the common case: no secret in the narration).
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

export type StreamAssistantReplyAGUIInput = {
  logger?: FastifyBaseLogger;
  reply: FastifyReply;
  messages: Pick<MessageStore, "create" | "updateContent" | "updateStreamingContent" | "upsertToolResult">;
  toolContexts: Pick<ToolExecutionContextStore, "create">;
  runtimeAdapter: {
    createSession(input: {
      tenantId: string;
      sessionId: string;
      userId: string;
    }): Promise<RuntimeSessionRef>;
    runMessageAGUI(
      session: RuntimeSessionRef,
      input: {
        prompt: string;
        userInputs?: RuntimeUserInput[];
        toolContextId: string | null;
        turnContext?: PolicyTurnContext;
        assistantMessageId?: string | null;
        model?: string;
        effort?: RuntimeReasoningEffort;
        onBeforeTurn?: () => Promise<void>;
      }
    ): AsyncIterable<BaseEvent>;
    writeRuntimeFile?: (
      sessionId: string,
      filePath: string,
      data: Uint8Array | ArrayBuffer | string
    ) => Promise<string>;
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
  // Artifacts the user checkboxed for this turn. When present, the writer syncs
  // them into the sandbox workspace and builds an artifact-context prompt block
  // (the AG-UI counterpart to the SSE path's scoping) so the turn can reference
  // them instead of silently dropping the selection.
  scopedArtifacts?: ArtifactRecord[];
  artifactProcessor?: Pick<ArtifactProcessor, "extractArtifactText">;
  storage?: ArtifactStorage;
  selectedArtifactIds?: string[];
  // When the PII detector rewrote the user's message in transform mode, the
  // backend persisted+sent the transformed text but the client's optimistic
  // bubble still shows the original. Emitted as a `user_message_replaced` CUSTOM
  // event at turn start so the frontend can patch that bubble live (reload
  // already self-heals — toAguiInitialMessages reads the transformed DB text).
  userMessageReplacement?: { messageId: string; text: string; scanRunId?: string };
  turnContext?: PolicyTurnContext;
  toolContextTtlMs?: number;
  /** Overrides STREAMING_PERSIST_INTERVAL_MS. Tests only — production omits it. */
  streamingPersistIntervalMs?: number;
  /** Overrides CHECKPOINT_DRAIN_DEADLINE_MS. Tests only — production omits it. */
  checkpointDrainDeadlineMs?: number;
};

// AG-UI's own EventEncoder emits `data: <json>\n\n` per event; match it.
function aguiFrame(event: BaseEvent | { type: string; message: string }): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function streamAssistantReplyAGUI(input: StreamAssistantReplyAGUIInput): Promise<void> {
  const writer = new SseWriter(input.reply.raw as unknown as RawSseResponse);
  const heartbeat = setInterval(() => {
    void writer.write(": keep-alive\n\n");
  }, SSE_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  // Populated once the assistant row is created; the catch/finally reference it
  // to persist the final status even when the turn fails partway.
  let assistantMessageId: string | null = null;
  // Declared at function scope so the outer `finally` can always stop it, even
  // when the turn threw before the streaming block installed it.
  let checkpointTimer: ReturnType<typeof setInterval> | null = null;
  let checkpointInFlight: Promise<void> | null = null;
  /**
   * Stops checkpointing and waits for any write already awaiting the DB. Must
   * run before every terminal `updateContent`: a checkpoint that settles after
   * the final status would write `"streaming"` over it and pin the row mid-turn
   * — the exact state this whole mechanism exists to prevent.
   */
  const settleCheckpoints = async (): Promise<void> => {
    if (checkpointTimer) clearInterval(checkpointTimer);
    checkpointTimer = null;
    if (!checkpointInFlight) return;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(
        resolve,
        input.checkpointDrainDeadlineMs ?? CHECKPOINT_DRAIN_DEADLINE_MS
      );
      timer.unref?.();
    });
    try {
      await Promise.race([checkpointInFlight, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  // Captures assistant text + reasoning + plan + tool calls/results off the event
  // stream for end-of-turn persistence (reload parity). `assistantText` remains a
  // convenience alias read in the catch/failure paths.
  const turn = new AguiTurnAccumulator();
  // AG-UI permits RUN_ERROR as the first event, but no event may follow it. Keep
  // the replacement at function scope so a setup failure can emit a short,
  // valid lifecycle: RUN_STARTED, replacement, RUN_ERROR.
  let runStartedWritten = false;
  let userMessageReplacementEvent = input.userMessageReplacement
    ? customEvent("user_message_replaced", {
          messageId: input.userMessageReplacement.messageId,
          text: input.userMessageReplacement.text,
          scanRunId: input.userMessageReplacement.scanRunId ?? null
      })
    : undefined;
  const writePendingUserMessageReplacement = async (): Promise<void> => {
    if (!userMessageReplacementEvent) return;
    if (!runStartedWritten) {
      await writer.write(
        aguiFrame({
          type: EventType.RUN_STARTED,
          threadId: input.sessionId,
          runId: assistantMessageId ?? uuidv7()
        } as BaseEvent)
      );
      runStartedWritten = true;
    }
    await writer.write(aguiFrame(userMessageReplacementEvent));
    userMessageReplacementEvent = undefined;
  };

  try {
    // Create the assistant row up front so `runMessageAGUI` has an id to
    // attribute token usage + cost onto, and so a refresh sees this turn.
    const assistant = await input.messages.create({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      userId: input.userId,
      role: "assistant",
      status: "pending",
      content: ""
    });
    assistantMessageId = assistant.messageId;

    const session = await input.runtimeAdapter.createSession({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      userId: input.userId
    });

    const toolContext = await input.toolContexts.create({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      userId: input.userId,
      runtimeId: session.runtimeId,
      runtimePolicyId: session.runtimePolicy.id,
      messageId: assistantMessageId,
      metadata: {
        selectedArtifactIds: input.selectedArtifactIds ?? [],
        runtimePolicy: session.runtimePolicy,
        ...(input.turnContext ? { turnContext: input.turnContext } : {})
      },
      ttlMs: input.toolContextTtlMs ?? 15 * 60 * 1000
    });

    // Artifact scoping: downloads
    // checkboxed artifacts into the sandbox workspace and builds the prompt
    // context block. Runs inside runMessageAGUI's onBeforeTurn so the sandbox is
    // guaranteed alive. `userInputs` (when built) REPLACE the raw prompt.
    const scopedArtifacts = input.scopedArtifacts ?? [];
    const turnState: { userInputs?: RuntimeUserInput[] } = {
      userInputs: undefined
    };
    const onBeforeTurn =
      scopedArtifacts.length &&
      input.artifactProcessor &&
      input.storage &&
      input.runtimeAdapter.writeRuntimeFile
        ? async () => {
            let syncedArtifacts: Awaited<ReturnType<typeof syncArtifactsToWorkspace>> | undefined;
            try {
              syncedArtifacts = await syncArtifactsToWorkspace({
                sessionId: input.sessionId,
                scopedArtifacts,
                storage: input.storage!,
                writeRuntimeFile: (sid, fp, data) =>
                  input.runtimeAdapter.writeRuntimeFile!(sid, fp, data)
              });
            } catch (err) {
              input.logger?.warn(
                { err, sessionId: input.sessionId },
                "AG-UI artifact workspace sync failed"
              );
            }
            const prepared = await buildArtifactTurnInputs({
              prompt: input.prompt,
              scopedArtifacts,
              artifactProcessor: input.artifactProcessor!,
              storage: input.storage!,
              syncedArtifacts
            });
            turnState.userInputs = prepared.userInputs;
          }
        : undefined;

    // Client disconnect mid-stream: cancel the runtime turn so it stops
    // generating (no billable tokens for output nobody reads). Guarded by
    // `turnSettled` so our own `writer.end()` close doesn't re-fire it.
    let turnSettled = false;
    writer.onClose(() => {
      if (turnSettled) return;
      void Promise.resolve(
        input.runtimeAdapter.interruptTurn?.({
          tenantId: input.tenantId,
          sessionId: input.sessionId,
          userId: input.userId
        })
      ).catch((err) => {
        input.logger?.warn(
          { err, sessionId: input.sessionId },
          "failed to cancel AG-UI runtime turn after client disconnect"
        );
      });
    });

    // A disconnect before the turn starts leaves the row in "pending"; mark it
    // interrupted rather than looping. Otherwise stream, accumulating the final
    // assistant text and the turn's terminal state. A mid-turn failure does NOT
    // throw — the adapter catches it and yields a RUN_ERROR event, then ends the
    // stream — so the status must be derived from the events, not just the catch.
    let finalStatus: "completed" | "interrupted" | "error" = "completed";
    let errorMessage = "The assistant run failed.";

    // Mid-turn checkpoint of the accumulated text. Driven by a TIMER, not by the
    // event loop, and that is the point: it must keep running through a stretch
    // where the turn emits nothing at all — most obviously a human sitting on an
    // approval prompt, which can last APPROVAL_REQUEST_TTL_MS. An event-driven
    // checkpoint would go silent for exactly the periods where the row most
    // needs to look alive, and the stale-message sweeper reads `updated_at` to
    // decide whether a row belongs to a live turn.
    //
    // Best-effort by design: this is insurance against a process death, so a
    // transient DB failure must not end a turn the client is still reading. The
    // write is unconditional (`updated_at` is the point even when the text has
    // not moved) but rate-limited to one per interval.
    const rowId = assistantMessageId;
    const writeCheckpoint = async (): Promise<void> => {
      try {
        await input.messages.updateContent(
          input.tenantId,
          rowId,
          input.userId,
          "streaming",
          turn.assistantText
        );
      } catch (err) {
        input.logger?.warn(
          { err, sessionId: input.sessionId, tenantId: input.tenantId },
          "failed to checkpoint AG-UI assistant text mid-turn"
        );
      }
    };
    const checkpointStreamingText = (): void => {
      // A write slower than the interval must not stack up behind the timer.
      if (checkpointInFlight) return;
      checkpointInFlight = writeCheckpoint().finally(() => {
        checkpointInFlight = null;
      });
    };
    if (writer.isClosed) {
      finalStatus = "interrupted";
    } else {
      // Started only on the branch that actually streams. On the already-closed
      // branch there is no turn to checkpoint, and a live timer there would race
      // the terminal write below with nothing to drain it.
      checkpointTimer = setInterval(
        checkpointStreamingText,
        input.streamingPersistIntervalMs ?? STREAMING_PERSIST_INTERVAL_MS
      );
      checkpointTimer.unref?.();
      try {
        for await (const event of input.runtimeAdapter.runMessageAGUI(session, {
          prompt: input.prompt,
          toolContextId: toolContext.toolContextId,
          turnContext: input.turnContext ?? "interactive",
          assistantMessageId,
          model: input.modelName,
          effort: input.effort,
          onBeforeTurn,
          get userInputs() {
            return turnState.userInputs;
          }
        })) {
          // Capture every event for end-of-turn persistence (text, reasoning,
          // plan, tool calls/results, and text/tool retractions are all handled
          // inside the accumulator). Lifecycle/error events below only affect the
          // row's terminal status.
          turn.apply(event);
          if (isAGUIInterruptedFinish(event)) {
            // Turn-abort marker carried on RUN_FINISHED.result — see
            // AGUI_INTERRUPTED_RESULT for why this is a private field and not
            // the AG-UI-native `outcome:{type:"interrupt"}`.
            finalStatus = "interrupted";
          } else if (event.type === EventType.RUN_ERROR) {
            // Provider/tool failure surfaced as an event (not a throw); mark the
            // row failed so refreshed history reflects it.
            finalStatus = "error";
            errorMessage = (event as { message?: string }).message ?? errorMessage;
          }
          // A client disconnect ends the turn early, but must not downgrade a
          // status the stream already resolved to (error / interrupted).
          if (writer.isClosed) {
            if (finalStatus === "completed") finalStatus = "interrupted";
            break;
          }
          // RUN_ERROR is terminal in AG-UI. If the adapter failed before its
          // RUN_STARTED event, emit a synthetic start and the buffered PII
          // replacement first so the client receives both a valid stream and
          // the persisted user-text correction.
          if (event.type === EventType.RUN_ERROR) {
            await writePendingUserMessageReplacement();
          }
          await writer.write(aguiFrame(event));
          if (event.type === EventType.RUN_STARTED) {
            runStartedWritten = true;
            await writePendingUserMessageReplacement();
          }
        }
      } finally {
        turnSettled = true;
        await settleCheckpoints();
      }
    }

    // Persist the final assistant text + status. Token usage + cost are written
    // separately by the adapter (keyed on assistantMessageId) — different
    // columns, so write order doesn't matter. On error, fall back to the failure
    // message when no partial text streamed.
    await input.messages.updateContent(
      input.tenantId,
      assistantMessageId,
      input.userId,
      finalStatus,
      finalStatus === "error" ? turn.assistantText || errorMessage : turn.assistantText
    );

    // Persist the rich transcript parts so a reload renders like the live turn.
    // Best-effort: a failure here must not fail the request or mask the text/
    // status write above (which is what the context meter depends on).
    try {
      await persistTurnTranscript(input, assistantMessageId, turn);
    } catch (persistError) {
      input.logger?.warn(
        { err: persistError, sessionId: input.sessionId, tenantId: input.tenantId },
        "failed to persist AG-UI turn transcript (reasoning/plan/tool results)"
      );
    }
  } catch (error) {
    input.logger?.error(
      { err: error, sessionId: input.sessionId, tenantId: input.tenantId, userId: input.userId },
      "AG-UI runtime turn failed"
    );
    // A throw here is pre-stream (session/tool-context setup, or the new
    // onBeforeTurn artifact machinery) — the graph's own failures surface as a
    // RUN_ERROR event, not a throw. Pass through deliberately-4xx messages
    // (client-safe by convention); collapse internals to a generic message so
    // connection strings / stack detail never reach the client or the row.
    const failureMessage = clientSafeFailureMessage(error);
    // A setup failure can happen before the runtime yields RUN_STARTED. Flush
    // the buffered PII replacement inside a synthetic run before terminating
    // it with RUN_ERROR. AG-UI rejects CUSTOM after a terminal error.
    await writePendingUserMessageReplacement();
    // Terminal AG-UI error frame so the client stops waiting on an open stream.
    await writer.write(aguiFrame({ type: EventType.RUN_ERROR, message: failureMessage }));
    // Best-effort: mark the row failed so it doesn't linger as "pending". A
    // persistence failure here must not mask the socket-closing path.
    if (assistantMessageId) {
      try {
        await input.messages.updateContent(
          input.tenantId,
          assistantMessageId,
          input.userId,
          "error",
          turn.assistantText || failureMessage
        );
      } catch (persistError) {
        input.logger?.error(
          { err: persistError, sessionId: input.sessionId, tenantId: input.tenantId },
          "failed to persist AG-UI turn failure"
        );
      }
    }
  } finally {
    clearInterval(heartbeat);
    // Backstop for every path that did not reach the streaming block's own drain
    // — a throw during setup, or one out of the terminal persistence below. No
    // test pins it: the timer only exists inside that block, so by construction
    // there is nothing left in flight by the time control gets here. Kept
    // because that is a property of where the timer happens to be armed, and a
    // drain at the last exit cannot be defeated by moving it.
    await settleCheckpoints();
    writer.end();
  }
}

// Persist the turn's reasoning, plan markdown, and tool results onto the
// assistant row so a reload can rehydrate the full transcript (the frontend's
// toAguiInitialMessages / planStateFromMessages read exactly these fields). Only
// writes what the turn actually produced — a chat-only turn touches nothing here.
async function persistTurnTranscript(
  input: StreamAssistantReplyAGUIInput,
  assistantMessageId: string,
  turn: AguiTurnAccumulator
): Promise<void> {
  // updateContent persists redactSecrets(assistantText); remap the raw-text
  // offsets to their redacted positions so reload interleaves against the same
  // string that was stored. No-op when the narration held no secret.
  const remapOffset = makeOffsetRemap(turn.assistantText);

  const reasoningContent = turn.reasoningText.trim();
  const reasoningSegments = turn
    .reasoningSegments()
    .map((segment) => ({ ...segment, offset: remapOffset(segment.offset) }));
  const planContent = turn.planMarkdown.trim();
  if (reasoningContent || reasoningSegments.length > 0 || planContent) {
    await input.messages.updateStreamingContent(input.tenantId, assistantMessageId, input.userId, {
      // reasoning_content is the single-block fallback; reasoning_segments carries
      // the positioned bursts for interleaved reload. Persist both so a client
      // that ignores segments still shows the reasoning.
      ...(reasoningContent ? { reasoningContent } : {}),
      ...(reasoningSegments.length > 0 ? { reasoningSegments } : {}),
      ...(planContent ? { planContent } : {})
    });
  }

  for (const result of turn.toolResults()) {
    await input.messages.upsertToolResult({
      tenantId: input.tenantId,
      messageId: assistantMessageId,
      sessionId: input.sessionId,
      userId: input.userId,
      ...result,
      textOffset: remapOffset(result.textOffset)
    });
  }
}
