// ─────────────────────────────────────────────────────────────────────────────
// Track B — DeepAgentsAGUIAgent (Path 2, slice 1)
//
// An @ag-ui/client `AbstractAgent` subclass that drives our EXISTING in-process
// deepagents graph loop and emits AG-UI `BaseEvent`s. It reuses the live
// pipeline wholesale:
//
//   streamEvents v2 --mapDeepAgentsEvent--> RuntimeEvent --runtimeEventToAGUI--> AG-UI
//
// The four Track-B invariants are preserved BY CONSTRUCTION because this class
// sits above the graph closure + adapter loop where they actually live:
//   1. toolContextId — set on the graph's shared ref via backend.setToolContext,
//      read by the graph's beforeToolCall at dispatch (untouched here).
//   2. tenant scope — the backend runs inside the adapter's withTenantScope;
//      this class opens no side channel.
//   3. dual approval — the native-HITL interrupt loop is reused verbatim
//      (getPendingActions / awaitDecisions / buildResumeInput, keyed per
//      interrupt id); Policy Center's gateway plane is wholly outside the graph.
//   4. STATE_DELTA — write_todos surfaces as a native state patch via the
//      translator instead of a bespoke markdown-diff event.
//
// Verified against @ag-ui/client@0.0.57: `run` returns rxjs `Observable`, and
// interrupts surface via RUN_FINISHED{outcome:interrupt} — there is no dedicated
// INTERRUPT event type, so a pending native interrupt is surfaced as a CUSTOM
// `approval_required` event (unified with the Policy Center approval UX).
// ─────────────────────────────────────────────────────────────────────────────

import { AbstractAgent, EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import { Observable } from "rxjs";

import { uuidv7 } from "../../lib/uuid.js";
import type { AGUITurnBackend } from "./deep-agents-agui-backend.js";
import {
  createDeepAgentsEventMapperState,
  mapDeepAgentsEvent
} from "./deep-agents-event-mapper.js";
import {
  createRuntimeToAGUIState,
  flushOpenMessages,
  runtimeEventToAGUI
} from "./runtime-event-to-agui.js";

export interface DeepAgentsAGUIAgentConfig {
  backend: AGUITurnBackend;
  /** Per-turn tool-context id; injected via `backend.setToolContext`. */
  toolContextId: string | null;
  agentId?: string;
  description?: string;
}

export class DeepAgentsAGUIAgent extends AbstractAgent {
  private readonly backend: AGUITurnBackend;
  private readonly toolContextId: string | null;

  constructor(config: DeepAgentsAGUIAgentConfig) {
    super({
      threadId: config.backend.threadId,
      agentId: config.agentId,
      description: config.description
    });
    this.backend = config.backend;
    this.toolContextId = config.toolContextId;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      let cancelled = false;
      const emit = (event: BaseEvent) => {
        if (!cancelled) subscriber.next(event);
      };

      void (async () => {
        const runId = input.runId ?? uuidv7();
        const mapperState = createDeepAgentsEventMapperState(runId);
        const aguiState = createRuntimeToAGUIState();
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
              for (const re of mapDeepAgentsEvent(mapperState, raw, mapperOptions)) {
                for (const ev of runtimeEventToAGUI(aguiState, re)) emit(ev);
              }
            }
            for (const ev of flushOpenMessages(aguiState)) emit(ev);

            const actions = await this.backend.getPendingActions();
            if (actions.length === 0) break;

            // The backend emits the approval prompt(s) (it owns the real
            // decision-route approvalId) and blocks until each interrupt is
            // decided — keyed per interrupt id so parallel `task` subagents
            // each get their own decision.
            const decisions = await this.backend.awaitDecisions(actions, emit);
            if (cancelled) return;
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
            for (const ev of flushOpenMessages(aguiState)) emit(ev);
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
