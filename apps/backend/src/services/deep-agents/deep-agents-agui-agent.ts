// Drives the session graph through AG-UI events. Tool context is injected before
// streaming; the backend owns approval persistence and keyed interrupt resumes.
// The mapper emits tool attribution and native todo state updates.

import { AbstractAgent, EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import { Observable } from "rxjs";

import { uuidv7 } from "../../lib/uuid.js";
import type { AGUITurnBackend } from "./deep-agents-agui-backend.js";
import {
  createStreamEventsToAGUIState,
  flushOpenAGUIMessages,
  streamEventsToAGUI
} from "./stream-events-to-agui.js";

export interface DeepAgentsAGUIAgentConfig {
  backend: AGUITurnBackend;
  /** Per-turn tool-context id; injected via `backend.setToolContext`. */
  toolContextId: string | null;
  /**
   * Called after every approval decision, before the turn resumes.
   * The approval round loop below is unbounded, so a turn's wall-clock length
   * is `working budget + N x APPROVAL_REQUEST_TTL_MS`. Both the tool-context
   * TTL and the active-turn staleness window budget for one approval, so
   * without this a turn parked on several approvals loses its MCP tool access
   * and gets stale-evicted while still running. Each call pushes both out.
   *
   * Failures are logged and swallowed by the caller: a missed keepalive must
   * not abort a turn the user is actively approving.
   */
  onApprovalRound?: (signal?: AbortSignal) => Promise<void>;
  /** Aborts the current turn when Stop or the watchdog fires. */
  approvalAbortSignal?: AbortSignal;
  agentId?: string;
  description?: string;
}

export class DeepAgentsAGUIAgent extends AbstractAgent {
  private readonly backend: AGUITurnBackend;
  private readonly toolContextId: string | null;
  private readonly onApprovalRound?: (signal?: AbortSignal) => Promise<void>;
  private readonly approvalAbortSignal?: AbortSignal;

  constructor(config: DeepAgentsAGUIAgentConfig) {
    super({
      threadId: config.backend.threadId,
      agentId: config.agentId,
      description: config.description
    });
    this.backend = config.backend;
    this.toolContextId = config.toolContextId;
    this.onApprovalRound = config.onApprovalRound;
    this.approvalAbortSignal = config.approvalAbortSignal;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      let cancelled = false;
      const emit = (event: BaseEvent) => {
        if (!cancelled) subscriber.next(event);
      };

      void (async () => {
        const runId = input.runId ?? uuidv7();
        const mapperState = createStreamEventsToAGUIState();
        const mapperOptions = {
          mcpToolNames: this.backend.mcpToolNames,
          mcpToolServers: this.backend.mcpToolServers
        };

        try {
          // Inject toolContextId onto the shared ref BEFORE the first stream
          // pass — exactly as the live adapter does.
          this.backend.setToolContext(this.toolContextId);
          emit({ type: EventType.RUN_STARTED, threadId: this.backend.threadId, runId } as BaseEvent);

          // The native-HITL interrupt/resume loop, reused verbatim; only the
          // emitted vocabulary is AG-UI now.
          let streamInput: unknown = this.backend.buildInitialInput();
          for (;;) {
            for await (const raw of this.backend.streamTurn(streamInput)) {
              if (cancelled) return;
              for (const event of streamEventsToAGUI(mapperState, raw, mapperOptions)) emit(event);
            }
            for (const event of flushOpenAGUIMessages(mapperState)) emit(event);

            const actions = await this.backend.getPendingActions();
            if (actions.length === 0) break;

            // The backend emits the approval prompt(s) (it owns the real
            // decision-route approvalId) and blocks until each interrupt is
            // decided — keyed per interrupt id so parallel `task` subagents
            // each get their own decision.
            const decisions = await this.backend.awaitDecisions(actions, emit);
            if (cancelled) return;
            // Push the tool-context TTL and the active-turn staleness window
            // out before resuming: this round consumed wall-clock time that
            // neither budget accounts for.
            // An abort still needs to reach the next stream pass so the live
            // adapter can emit its normal interrupted terminal event. Skip the
            // keepalive, though: a stopped turn must not renew its authority.
            if (!this.approvalAbortSignal?.aborted) {
              await this.onApprovalRound?.(this.approvalAbortSignal);
            }
            streamInput = this.backend.buildResumeInput(actions, decisions);
          }

          emit({ type: EventType.RUN_FINISHED, threadId: this.backend.threadId, runId } as BaseEvent);
          if (!cancelled) subscriber.complete();
        } catch (err) {
          if (!cancelled) {
            // A mid-text abort (Stop/disconnect) throws out of `streamTurn`
            // before the flush at the end of the loop runs, leaving a
            // TEXT_MESSAGE/REASONING message open. Close them before the driver
            // surfaces the terminal so nothing dangles. Note: `verifyEvents`
            // (@ag-ui/client) only tracks OPEN TEXT messages and tool calls for
            // its RUN_FINISHED guard — an unclosed REASONING message slips past
            // it — but an unclosed message of either kind leaves the UI card
            // stuck open, so flush both regardless of what the verifier checks.
            for (const event of flushOpenAGUIMessages(mapperState)) emit(event);
            subscriber.error(err);
          }
        }
      })();

      return () => {
        cancelled = true;
      };
    });
  }
}
