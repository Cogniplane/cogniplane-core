// Adapts a session graph to the AG-UI driver. Graph resolution and MCP metadata
// stay session-scoped; the runtime adapter supplies the approval decision loop.

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
  /** Records availability after the graph and its tools have loaded. */
  onGraphReady?: () => Promise<void>;
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
    if (graph === null) {
      graph = await runtime.getAgentForModel(modelId, effort ?? null);
      await params.onGraphReady?.();
    }
    return graph;
  };

  return {
    threadId,
    mcpToolNames: runtime.getMcpToolNames(),
    mcpToolServers: runtime.getMcpToolServers(),

    setToolContext(toolContextId) {
      toolContextRef.current = toolContextId;
    },

    buildInitialInput() {
      return { messages: [{ role: "user", content: promptText }] };
    },

    async *streamTurn(input) {
      // An already-aborted turn (a client that dropped during the pre-turn
      // artifact sync) must not build a graph or resolve a provider key first —
      // reject on the signal the same way an in-flight stream would.
      signal?.throwIfAborted();
      const g = await resolveGraph();
      yield* g.streamEvents(input, {
        version: "v2",
        configurable: { thread_id: threadId },
        signal
      });
    },

    async getPendingActions() {
      return runtime.getPendingActions(threadId);
    },

    awaitDecisions: params.awaitDecisions,

    buildResumeInput(actions, decisions) {
      return runtime.buildResumeInput(actions, decisions);
    }
  };
}
