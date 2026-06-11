import type { FastifyBaseLogger } from "fastify";
import { uuidv7 } from "../../lib/uuid.js";

import { AsyncQueue } from "../../lib/async-queue.js";
import {
  SessionBusyError,
  type RuntimeApprovalKind,
  type RuntimeEvent,
  type RuntimeReasoningEffort,
  type RuntimeSessionRef,
  type RuntimeUserInput
} from "../../runtime-contracts.js";
import {
  createClaudeEventMapperState,
  mapClaudeEvent,
  type ClaudeMessageInput
} from "./claude-code-event-mapper.js";
import type { AppConfig } from "../../config.js";
import type { ManagedToolCatalog } from "../managed-tools/catalog.js";
import type { SandboxTurnFrame } from "../runtime/sandbox-agent-protocol.js";
import type { ClaudeSessionState, PendingE2bApproval } from "./claude-types.js";
import { buildClaudeContentBlocks, isInitMessage } from "./claude-sdk-helpers.js";
import type { ApprovalStore } from "../auth/approval-store.js";

type TurnInput = {
  prompt: string;
  userInputs?: RuntimeUserInput[];
  runtimePolicyId: string;
  toolContextId: string | null;
  assistantMessageId?: string | null;
  model?: string;
  effort?: RuntimeReasoningEffort;
  onBeforeTurn?: () => Promise<void>;
};

export type ClaudeTurnContext = {
  state: ClaudeSessionState;
  activeTurns: Set<string>;
  e2bPendingApprovals: Map<string, PendingE2bApproval>;
  stores: { approvals?: ApprovalStore } | undefined;
  config: Pick<AppConfig, "CLAUDE_CODE_MODEL" | "APPROVAL_REQUEST_TTL_MS">;
  log: FastifyBaseLogger;
  managedToolCatalog: ManagedToolCatalog;
  /** Fired when the turn slot is reserved — the adapter clears the idle timer. */
  onTurnStart?: () => void;
  /** Fired when the turn settles (any path) — the adapter re-arms idle teardown. */
  onTurnEnd?: () => void;
};

export async function* executeClaudeTurn(
  session: RuntimeSessionRef,
  input: TurnInput,
  ctx: ClaudeTurnContext
): AsyncIterable<RuntimeEvent> {
  const { state, activeTurns, e2bPendingApprovals, stores, config, log } = ctx;

  // Reserve the turn slot SYNCHRONOUSLY — check-and-add with no await in
  // between — so a concurrent runMessage for the same session can't slip past
  // during onBeforeTurn (multi-second artifact sync). Without this, the
  // second turn's failure path would clobber the first turn's activeTurns
  // flag and interrupt/push hooks.
  if (activeTurns.has(session.sessionId)) {
    throw new SessionBusyError(session.sessionId);
  }
  activeTurns.add(session.sessionId);
  ctx.onTurnStart?.();
  // "Remember for this turn" decisions are scoped to a single turn. REPLACE the
  // set (don't clear it): pending approvals capture their turn's instance, so a
  // decision still in flight from the previous turn mutates the orphaned set
  // instead of leaking an auto-approval into this one.
  state.autoApprovedKindsForTurn = new Set();

  if (input.onBeforeTurn) {
    try {
      await input.onBeforeTurn();
    } catch (error) {
      // The turn never started — release the reservation and surface the error.
      activeTurns.delete(session.sessionId);
      ctx.onTurnEnd?.();
      throw error;
    }
  }
  const eventQueue = new AsyncQueue<RuntimeEvent>();
  const responseId = input.assistantMessageId ?? uuidv7();
  const mapperState = createClaudeEventMapperState(responseId);

  // Expose a push hook so out-of-band events (Policy Center gateway-held
  // approvals + reminders) can be surfaced on this turn's SSE stream while it's
  // live. Cleared in the finally below so a late push can't reach a dead queue.
  state.activeTurnPush.current = (event) => eventQueue.push(event);

  const dispatchApprovalEvent = async (event: {
    approvalId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    kind: RuntimeApprovalKind;
  }) => {
    if (stores?.approvals) {
      try {
        await stores.approvals.create({
          tenantId: state.tenantId,
          approvalId: event.approvalId,
          sessionId: state.sessionId,
          userId: state.userId,
          runtimeId: state.runtimeId,
          turnId: responseId,
          itemId: event.approvalId,
          requestMethod: `claude/${event.toolName}`,
          requestId: event.approvalId,
          kind: event.kind,
          title: `Approve ${event.toolName}`,
          summary: JSON.stringify(event.toolInput),
          status: "pending",
          decision: null,
          requestPayload: event.toolInput,
          // DB-level deadline mirroring the in-process TTL on canUseTool, so a
          // sandbox/process death before that timer fires still lets the startup
          // sweep recover this row instead of leaving it pending forever.
          expiresAt: new Date(Date.now() + config.APPROVAL_REQUEST_TTL_MS).toISOString()
        });
      } catch (err) {
        log.warn({ err, approvalId: event.approvalId }, "Failed to persist Claude approval to store");
      }
    }
    eventQueue.push({
      type: "framework:approval_required",
      responseId,
      approvalId: event.approvalId,
      itemId: event.approvalId,
      kind: event.kind,
      title: `Approve ${event.toolName}`,
      summary: JSON.stringify(event.toolInput),
      availableDecisions: ["approve", "reject"],
      command: event.toolName,
      cwd: state.workspacePath
    });
  };

  const runTask = (async () => {
    try {
      await runE2bTurn({
        state,
        eventQueue,
        responseId,
        mapperState,
        turnId: responseId,
        turn: input,
        dispatchApprovalEvent,
        e2bPendingApprovals,
        config,
        log,
        session,
        managedToolCatalog: ctx.managedToolCatalog
      });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const aborted = state.abortController.signal.aborted;
      if (aborted) {
        log.info({ sessionId: session.sessionId }, "Claude session aborted");
      } else {
        log.error({ err, sessionId: session.sessionId }, "Claude turn failed");
      }
      eventQueue.push({
        type: "response.failed",
        responseId,
        message: aborted ? "Session aborted" : errorMessage
      });
    } finally {
      activeTurns.delete(session.sessionId);
      // Clear the interrupt hook so a delayed Stop click after the turn ended
      // can't reach into the next turn's iterator. The runtime adapter checks
      // activeTurns first, but this is the per-state defense in depth.
      state.activeTurnInterrupt.current = null;
      // Same for the push hook — a late policy-approval push must not land on a
      // queue that's about to be ended.
      state.activeTurnPush.current = null;
      ctx.onTurnEnd?.();
      eventQueue.end();
    }
  })();

  yield* eventQueue;
  await runTask;
}

async function runE2bTurn(ctx: {
  state: ClaudeSessionState;
  eventQueue: AsyncQueue<RuntimeEvent>;
  responseId: string;
  mapperState: ReturnType<typeof createClaudeEventMapperState>;
  turnId: string;
  turn: TurnInput;
  dispatchApprovalEvent: (event: {
    approvalId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    kind: RuntimeApprovalKind;
  }) => Promise<void>;
  e2bPendingApprovals: Map<string, PendingE2bApproval>;
  config: Pick<AppConfig, "CLAUDE_CODE_MODEL" | "APPROVAL_REQUEST_TTL_MS">;
  log: FastifyBaseLogger;
  session: RuntimeSessionRef;
  managedToolCatalog: ManagedToolCatalog;
}): Promise<void> {
  const { state, eventQueue, responseId, mapperState, turnId, turn, e2bPendingApprovals, config, log } =
    ctx;
  if (!state.e2bProcess) {
    throw new Error("runE2bTurn called without an active E2B process.");
  }
  const { runtimePolicy } = state.configBundle;

  const contentBlocks = await buildClaudeContentBlocks({
    prompt: turn.prompt,
    userInputs: turn.userInputs,
    runtimePolicy,
    toolContextId: turn.toolContextId
  });

  const turnFrame: SandboxTurnFrame = {
    type: "turn",
    turnId,
    prompt: turn.prompt,
    contentBlocks,
    toolContextId: turn.toolContextId ?? null,
    resumeSessionId: state.claudeSessionId,
    model: turn.model ?? config.CLAUDE_CODE_MODEL,
    effort: turn.effort ?? null,
    developerInstructions: runtimePolicy.developerInstructions,
    mcpServers: state.mcpServerEntries.map((e) => ({
      id: e.id,
      url: e.url,
      authorization: `Bearer ${state.runtimeToken}`
    })),
    enabledToolIds: runtimePolicy.enabledToolIds,
    bypass: runtimePolicy.approvalPolicy === "never",
    autoApproveReadOnly: runtimePolicy.autoApproveReadOnlyTools,
    readOnlyManagedToolNames: ctx.managedToolCatalog.listReadOnlyIds(),
    // Keep the harness deny-by-default timer in lockstep with the backend's
    // DB-expiry sweep so a closed tab can't hang the in-sandbox SDK turn.
    approvalTtlMs: config.APPROVAL_REQUEST_TTL_MS
  };

  // Terminal events are deferred until onComplete fires — same reasoning as
  // the local path: an SDK throw must take precedence over a success event.
  let deferredTerminal: RuntimeEvent | null = null;

  // Stop button: route to the in-sandbox harness which calls iterator.interrupt()
  // inside the SDK. The harness then emits a result(subtype="interrupt"); the
  // shared mapClaudeEvent path translates it into response.completed{interrupted}.
  state.activeTurnInterrupt.current = async () => {
    if (state.e2bProcess) {
      await state.e2bProcess.interruptCurrentTurn(turnId);
    }
  };

  await state.e2bProcess.runTurn(turnFrame, {
    onSdkMessage: (payload) => {
      if (isInitMessage(payload)) {
        log.info(
          {
            sessionId: state.sessionId,
            runtimeId: state.runtimeId,
            source: "e2b",
            model: payload.model,
            permissionMode: payload.permissionMode,
            toolCount: payload.tools.length,
            mcpToolNames: payload.tools.filter((name) => name.startsWith("mcp__")),
            mcpServers: payload.mcp_servers,
            cwd: payload.cwd,
            claudeCodeVersion: payload.claude_code_version
          },
          "Claude SDK system/init tool surface (E2B)"
        );
      }

      const events = mapClaudeEvent(mapperState, payload as ClaudeMessageInput);
      for (const evt of events) {
        if (evt.type === "response.completed" || evt.type === "response.failed") {
          deferredTerminal = evt;
        } else {
          eventQueue.push(evt);
        }
      }

      const sid = (payload as { session_id?: string }).session_id;
      if (sid && !state.claudeSessionId) {
        state.claudeSessionId = sid;
      }
    },
    onApprovalRequest: (frame) => {
      // If the user already approved this kind for the current turn
      // (rememberForTurn), answer the harness immediately — no DB row, no
      // prompt. Codex equivalent: autoApprovedKinds check in
      // runtime-request-handler.ts — keep both in sync.
      if (state.autoApprovedKindsForTurn.has(frame.kind)) {
        void state.e2bProcess.sendApprovalResponse(frame.approvalId, "approve").catch((err) => {
          log.warn(
            { err, approvalId: frame.approvalId },
            "Failed to forward remembered auto-approval to E2B sandbox"
          );
        });
        return;
      }
      e2bPendingApprovals.set(frame.approvalId, {
        sessionId: state.sessionId,
        kind: frame.kind,
        // Capture THIS turn's remember-set so a decision landing after the
        // turn ends can't pollute the next turn's set.
        autoApprovedKinds: state.autoApprovedKindsForTurn
      });
      void ctx.dispatchApprovalEvent({
        approvalId: frame.approvalId,
        toolName: frame.toolName,
        toolInput: frame.toolInput,
        kind: frame.kind
      }).catch((err) => {
        log.warn({ err, approvalId: frame.approvalId }, "Failed to dispatch E2B approval event");
      });
    },
    onComplete: () => {
      eventQueue.push(deferredTerminal ?? { type: "response.completed", responseId });
    },
    onFail: (error) => {
      eventQueue.push({ type: "response.failed", responseId, message: error });
    }
  });
}
