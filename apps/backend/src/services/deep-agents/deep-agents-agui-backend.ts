// ─────────────────────────────────────────────────────────────────────────────
// Track B — real AGUITurnBackend over DeepAgentsSessionRuntime (Path 2, slice 1)
//
// The seam the AG-UI driver consumes, implemented against the SAME session
// runtime the live adapter uses (`state.runtime` + `state.threadId` +
// `state.toolContextRef`). Everything deterministic (graph resolution, the
// streamEvents pass, pending-interrupt detection, resume-input construction, MCP
// attribution) lives here; the one genuinely adapter-coupled piece — awaiting a
// human decision on the shared approval plane — is injected as `awaitDecisions`
// so this backend stays unit-testable without the approval/HTTP machinery.
//
// This module does NOT touch the adapter's runMessage path — it is dormant until
// a future slice wires the AG-UI agent into the live SSE route (behind a flag at
// that point). Reuses the graph's toolContextRef injection and runs inside the
// adapter's withTenantScope, so tenant isolation + toolContextId survive
// unchanged (proven by the driver test).
// ─────────────────────────────────────────────────────────────────────────────

import type { BaseEvent } from "@ag-ui/client";

import type { RuntimeReasoningEffort } from "../../runtime-contracts.js";
import type {
  DeepAgentsGraph,
  DeepAgentsPendingAction,
  DeepAgentsSessionRuntime
} from "./deep-agents-types.js";

/** Resume decision, matching `DeepAgentsSessionRuntime.buildResumeInput`. */
export type AGUIApprovalDecision = { type: "approve" } | { type: "reject"; message?: string };

/**
 * The turn-driving seam consumed by `DeepAgentsAGUIAgent`. Named so the driver
 * needs nothing from the adapter beyond this interface.
 */
export interface AGUITurnBackend {
  readonly threadId: string;
  readonly mcpToolNames: ReadonlySet<string>;
  readonly mcpToolServers: ReadonlyMap<string, string>;
  /** Sets the per-turn toolContextId onto the shared ref the graph's
   *  `beforeToolCall` reads at tool-dispatch time. Called once, pre-stream. */
  setToolContext(toolContextId: string | null): void;
  /** The initial `streamEvents` input for this turn (the user message). */
  buildInitialInput(): unknown;
  /** One `streamEvents(input, {version:"v2"})` pass over the in-process graph. */
  streamTurn(input: unknown): AsyncIterable<Record<string, unknown>>;
  /** Native HITL interrupts pending after the last stream pass (empty ⇒ done). */
  getPendingActions(): Promise<DeepAgentsPendingAction[]>;
  /**
   * Emits the AG-UI approval prompt(s) and blocks on the shared approval plane
   * until every open interrupt is decided. The backend — not the driver — owns
   * emission because only it mints the decision-route `approvalId` (the driver
   * has just the LangGraph `interruptId`); `emit` is the driver's subscriber.
   */
  awaitDecisions(
    actions: DeepAgentsPendingAction[],
    emit: (event: BaseEvent) => void
  ): Promise<AGUIApprovalDecision[]>;
  /** Builds the opaque resume `Command` input for the next stream pass. */
  buildResumeInput(
    actions: DeepAgentsPendingAction[],
    decisions: AGUIApprovalDecision[]
  ): unknown;
}

export interface SessionAGUITurnBackendParams {
  threadId: string;
  runtime: DeepAgentsSessionRuntime;
  /** The graph's shared tool-context ref (the same object beforeToolCall reads). */
  toolContextRef: { current: string | null };
  modelId: string;
  effort?: RuntimeReasoningEffort | null;
  /** Prompt text for the initial turn input. */
  promptText: string;
  signal?: AbortSignal;
  /** Bridges to the shared approval plane (adapter-supplied in production). */
  awaitDecisions: (
    actions: DeepAgentsPendingAction[],
    emit: (event: BaseEvent) => void
  ) => Promise<AGUIApprovalDecision[]>;
}

/**
 * Builds a real `AGUITurnBackend` from a live `DeepAgentsSessionRuntime`. The
 * compiled graph is resolved once (same model/effort across resume passes) and
 * memoised.
 */
export function createSessionAGUITurnBackend(
  params: SessionAGUITurnBackendParams
): AGUITurnBackend {
  const { threadId, runtime, toolContextRef, modelId, effort, promptText, signal } = params;
  let graph: DeepAgentsGraph | null = null;

  const resolveGraph = async (): Promise<DeepAgentsGraph> => {
    if (graph === null) graph = await runtime.getAgentForModel(modelId, effort ?? null);
    return graph;
  };

  return {
    threadId,
    mcpToolNames: runtime.getMcpToolNames?.() ?? new Set<string>(),
    mcpToolServers: runtime.getMcpToolServers?.() ?? new Map<string, string>(),

    setToolContext(toolContextId) {
      toolContextRef.current = toolContextId;
    },

    buildInitialInput() {
      return { messages: [{ role: "user", content: promptText }] };
    },

    async *streamTurn(input) {
      const g = await resolveGraph();
      yield* g.streamEvents(input, {
        version: "v2",
        configurable: { thread_id: threadId },
        signal
      });
    },

    async getPendingActions() {
      return (await runtime.getPendingActions?.(threadId)) ?? [];
    },

    awaitDecisions: params.awaitDecisions,

    buildResumeInput(actions, decisions) {
      if (!runtime.buildResumeInput) {
        throw new Error("Session runtime does not support resume (no buildResumeInput).");
      }
      return runtime.buildResumeInput(actions, decisions);
    }
  };
}
