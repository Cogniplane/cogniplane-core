import type { ProjectApprovalMode, ProjectInstructionsSnapshot } from "@cogniplane/shared-types";
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
// turn runs, and asks for plan, tool, and notice progress. `TurnTranscript`
// (shared with the scheduler) orders and saves that progress, classifies the
// outcome, and writes the final text, status, reasoning, plan, and tool
// results. The writer decides when those writes run against the wire. It also
// hands the row id to `runMessageAGUI` so the adapter can attribute token
// usage and cost to it. `SseWriter` handles
// backpressure and disconnects. A disconnect closes only this stream.
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
import type { ProjectRuntimeFileSnapshot } from "./project-file-store.js";
import { buildArtifactTurnInputs } from "./turn-input-builder.js";
import { syncArtifactsToWorkspace } from "./artifacts/artifact-workspace-sync.js";
import { SseWriter, type RawSseResponse } from "./sse-writer.js";
import { AGUI_INTERRUPTED_RESULT } from "./deep-agents/agui-events.js";
import type { TurnEventLog } from "./turn-event-log.js";
import { TurnTranscript, classifyTurnFailure, type TurnOutcome } from "./turn-transcript.js";

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

export type StreamAssistantReplyAGUIInput = {
  eventLog?: TurnEventLog;
  /** Saved user row for a tab that attaches before the row reaches its initial history read. */
  persistedUserMessage?: { messageId: string; text: string };
  execution?: import("./session-execution-store.js").SessionExecution;
  logger?: FastifyBaseLogger;
  /** Server turn reservation time, including setup and approval waits. */
  startedAt?: number;
  onTurnCreated?: (turn: { messageId: string; sequence: number }) => void;
  /**
   * Release admission after graph/persistence finish and before terminal
   * output. Called at most once. A rejection is logged and does not change
   * the turn outcome or the terminal event.
   */
  onTurnSettled?: () => Promise<void>;
  /** Aborted by Stop or shutdown, including while the request prepares the turn. */
  cancelSignal?: AbortSignal;
  reply: FastifyReply;
  messages: Pick<MessageStore, "create" | "updateContent" | "updateStreamingContent" | "upsertToolResult" | "setRuntimeNotices">;
  toolContexts: Pick<ToolExecutionContextStore, "create">;
  runtimeAdapter: {
    createSession(input: {
      tenantId: string;
      sessionId: string;
      userId: string;
      execution?: import("./session-execution-store.js").SessionExecution;
    }): Promise<RuntimeSessionRef>;
    runMessageAGUI(
      session: RuntimeSessionRef,
      input: {
        prompt: string;
        projectInstructions?: ProjectInstructionsSnapshot | null;
        userInputs?: RuntimeUserInput[];
        toolContextId: string | null;
        projectApprovalMode?: ProjectApprovalMode;
        turnContext?: PolicyTurnContext;
        assistantMessageId?: string | null;
        model?: string;
        effort?: RuntimeReasoningEffort;
        cancelSignal?: AbortSignal;
        onBeforeTurn?: (signal: AbortSignal) => Promise<void>;
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
  projectInstructions?: ProjectInstructionsSnapshot | null;
  /** Approval mode captured when the project turn was admitted. */
  projectApprovalMode?: ProjectApprovalMode;
  projectId?: string | null;
  projectAgentFileMode?: "read-only" | "create-only" | "read-write";
  projectFileSnapshot?: ProjectRuntimeFileSnapshot | null;
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

// Terminal event for an outcome the writer reports itself: a thrown turn, or a
// final text/status write that failed after the runtime finished.
function terminalEventFor(outcome: TurnOutcome, threadId: string, runId: string): BaseEvent {
  if (outcome.status === "error") return { type: EventType.RUN_ERROR, message: outcome.message } as BaseEvent;
  return {
    type: EventType.RUN_FINISHED,
    threadId,
    runId,
    ...(outcome.status === "interrupted" ? { result: AGUI_INTERRUPTED_RESULT } : {})
  } as BaseEvent;
}

export async function streamAssistantReplyAGUI(input: StreamAssistantReplyAGUIInput): Promise<void> {
  const startedAt = input.startedAt ?? Date.now();
  let durationMs: number | undefined;
  const finishTiming = () => { durationMs ??= Math.max(0, Date.now() - startedAt); };
  let terminalEvent: BaseEvent | undefined;
  const writer = new SseWriter(input.reply.raw as unknown as RawSseResponse);
  const writeEvent = async (event: BaseEvent): Promise<void> => {
    input.eventLog?.append(event);
    if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) {
      input.eventLog?.close();
    }
    await writer.write(aguiFrame(event));
  };
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
  // Created with the assistant row. It captures text, reasoning, plan, tool
  // calls/results, and notices off the event stream and writes the final row.
  let transcript: TurnTranscript | null = null;
  // AG-UI permits RUN_ERROR as the first event, but no event may follow it. Keep
  // the pending custom events at function scope so setup failures can emit
  // turn identity and any PII replacement before the terminal error.
  let runStartedWritten = false;
  let turnStartedEvent: BaseEvent | undefined;
  let userMessageEvent = input.persistedUserMessage
    ? customEvent("user_message_persisted", input.persistedUserMessage)
    : undefined;
  let userMessageReplacementEvent = input.userMessageReplacement
    ? customEvent("user_message_replaced", {
          messageId: input.userMessageReplacement.messageId,
          text: input.userMessageReplacement.text,
          scanRunId: input.userMessageReplacement.scanRunId ?? null
      })
    : undefined;
  // Settlement is cleanup, not part of the turn: its failure must not replace
  // a saved outcome, and it must not stop the terminal event.
  let settleStarted = false;
  const settleTurn = async (): Promise<void> => {
    if (settleStarted) return;
    settleStarted = true;
    try {
      await input.onTurnSettled?.();
    } catch (err) {
      input.logger?.error(
        { err, sessionId: input.sessionId, tenantId: input.tenantId },
        "failed to settle the AG-UI turn"
      );
    }
  };
  const writePendingTurnEvents = async (): Promise<void> => {
    if (!userMessageEvent && !userMessageReplacementEvent && !turnStartedEvent) return;
    if (!runStartedWritten) {
      await writeEvent(
        {
          type: EventType.RUN_STARTED,
          threadId: input.sessionId,
          runId: assistantMessageId ?? uuidv7()
        } as BaseEvent
      );
      runStartedWritten = true;
    }
    if (turnStartedEvent) {
      await writeEvent(turnStartedEvent);
      turnStartedEvent = undefined;
    }
    if (userMessageEvent) {
      await writeEvent(userMessageEvent);
      userMessageEvent = undefined;
    }
    if (userMessageReplacementEvent) {
      await writeEvent(userMessageReplacementEvent);
      userMessageReplacementEvent = undefined;
    }
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
      content: "",
      detail: { projectInstructions: input.projectInstructions ?? null }
    });
    assistantMessageId = assistant.messageId;
    const turn = new TurnTranscript({
      messages: input.messages,
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      userId: input.userId,
      messageId: assistant.messageId,
      logger: input.logger
    });
    transcript = turn;
    const identity = { messageId: assistant.messageId, sequence: assistant.id };
    input.onTurnCreated?.(identity);
    turnStartedEvent = customEvent("turn_started", identity);
    if (input.cancelSignal?.aborted) throw new Error("Turn stopped during setup");

    const session = await input.runtimeAdapter.createSession({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      userId: input.userId,
      execution: input.execution
    });

    const toolContext = await input.toolContexts.create({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      userId: input.userId,
      runtimeId: session.runtimeId,
      runtimePolicyId: session.runtimePolicy.id,
      messageId: assistantMessageId,
      metadata: {
        ...(input.execution ? { executionId: input.execution.executionId } : {}),
        selectedArtifactIds: input.selectedArtifactIds ?? [],
        ...(input.projectId && input.projectFileSnapshot ? {
          projectContext: {
            projectId: input.projectId,
            agentFileMode: input.projectAgentFileMode ?? "read-only",
            snapshot: input.projectFileSnapshot
          }
        } : {}),
        runtimePolicy: session.runtimePolicy,
        ...(session.mcpServerSources ? { mcpServerSources: session.mcpServerSources } : {}),
        ...(session.integrationAccounts ? { integrationAccounts: session.integrationAccounts } : {}),
        ...(input.turnContext ? { turnContext: input.turnContext } : {})
      },
      ttlMs: input.toolContextTtlMs ?? 15 * 60 * 1000
    });
    if (input.cancelSignal?.aborted) throw new Error("Turn stopped during setup");

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
        ? async (signal: AbortSignal) => {
            if (signal.aborted) return;
            let syncedArtifacts: Awaited<ReturnType<typeof syncArtifactsToWorkspace>> | undefined;
            try {
              syncedArtifacts = await syncArtifactsToWorkspace({
                sessionId: input.sessionId,
                scopedArtifacts,
                storage: input.storage!,
                signal,
                writeRuntimeFile: (sid, fp, data) =>
                  input.runtimeAdapter.writeRuntimeFile!(sid, fp, data)
              });
            } catch (err) {
              input.logger?.warn(
                { err, sessionId: input.sessionId },
                "AG-UI artifact workspace sync failed"
              );
            }
            if (signal.aborted) return;
            const prepared = await buildArtifactTurnInputs({
              prompt: input.prompt,
              scopedArtifacts,
              artifactProcessor: input.artifactProcessor!,
              storage: input.storage!,
              syncedArtifacts,
              signal
            });
            if (signal.aborted) return;
            turnState.userInputs = prepared.userInputs;
          }
        : undefined;

    // The turn continues after the client closes its connection. The adapter
    // reports a graph failure with RUN_ERROR; `turn` reads the final status from
    // the events.

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
    checkpointTimer = setInterval(
      checkpointStreamingText,
      input.streamingPersistIntervalMs ?? STREAMING_PERSIST_INTERVAL_MS
    );
    checkpointTimer.unref?.();
    try {
      for await (const event of input.runtimeAdapter.runMessageAGUI(session, {
        prompt: input.prompt,
        projectInstructions: input.projectInstructions,
        projectApprovalMode: input.projectApprovalMode,
        toolContextId: toolContext.toolContextId,
        turnContext: input.turnContext ?? "interactive",
        assistantMessageId,
        model: input.modelName,
        effort: input.effort,
        cancelSignal: input.cancelSignal,
        onBeforeTurn,
        get userInputs() {
          return turnState.userInputs;
        }
      })) {
        // Capture every event for end-of-turn persistence and outcome
        // classification, and queue the mid-turn progress write that the
        // event causes.
        turn.apply(event, { saveProgress: true });
        // RUN_ERROR is terminal in AG-UI. If the adapter failed before its
        // RUN_STARTED event, emit a synthetic start and pending custom events
        // first so the client receives the turn identity and any PII correction.
        if (event.type === EventType.RUN_ERROR) {
          await writePendingTurnEvents();
        }
        if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) {
          finishTiming();
          terminalEvent = event;
          continue;
        }
        if (event.type === EventType.CUSTOM && (event as { name?: string }).name === "tool_mcp_app") {
          await turn.settleProgress();
          const toolCallId = (event as { value?: { toolCallId?: string } }).value?.toolCallId;
          if (!toolCallId || !turn.hasSavedAppCall(toolCallId)) continue;
        }
        await writeEvent(event);
        if (event.type === EventType.RUN_STARTED) {
          runStartedWritten = true;
          await writePendingTurnEvents();
        }
      }
    } finally {
      finishTiming();
      await settleCheckpoints();
    }

    finishTiming();

    // Final text + status, then the rich transcript. Token usage + cost are
    // written separately by the adapter (keyed on assistantMessageId).
    const finalized = await turn.finalize(undefined, durationMs);
    // The client refreshes history on termination, so commit the row first.
    await settleTurn();
    if (finalized.persisted) {
      if (terminalEvent) await writeEvent(terminalEvent);
    } else {
      // The saved row does not show this outcome; do not report success.
      await writePendingTurnEvents();
      await writeEvent(terminalEventFor(finalized.outcome, input.sessionId, assistantMessageId));
    }
  } catch (error) {
    finishTiming();
    await settleCheckpoints();
    const cancelled = input.cancelSignal?.aborted === true;
    if (!cancelled) {
      input.logger?.error(
        { err: error, sessionId: input.sessionId, tenantId: input.tenantId, userId: input.userId },
        "AG-UI runtime turn failed"
      );
    }
    // A throw here is usually pre-stream (session/tool-context setup, or the
    // onBeforeTurn artifact machinery) — the graph's own failures surface as a
    // RUN_ERROR event, not a throw. Pass through deliberately-4xx messages
    // (client-safe by convention); collapse internals to a generic message so
    // connection strings / stack detail never reach the client or the row.
    const failure = classifyTurnFailure(error, cancelled);
    // A setup failure can happen before the runtime yields RUN_STARTED. Flush
    // the pending custom events inside a synthetic run before terminating
    // it with RUN_ERROR. AG-UI rejects CUSTOM after a terminal error.
    await writePendingTurnEvents();
    // Save the failure with any partial text, reasoning, plan, and tools. This
    // never throws, and it keeps an earlier final write when one already ran.
    await transcript?.finalize(failure, durationMs);
    await settleTurn();
    await writeEvent(terminalEventFor(failure, input.sessionId, assistantMessageId ?? uuidv7()));
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
