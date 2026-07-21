import type { ModelProvider } from "@cogniplane/shared-types";

import type { RuntimeConfigBundle } from "../admin-config-records.js";
import type { RuntimeEvent, RuntimeReasoningEffort } from "../../runtime-contracts.js";
import type { SkillsLibraryFiles } from "./deep-agents-skills-library.js";

/**
 * One pending HITL action extracted from a LangGraph interrupt: the tool the
 * agent wants to run, awaiting a human decision.
 */
export type DeepAgentsPendingAction = {
  /**
   * Id of the LangGraph interrupt this action belongs to. Distinct concurrent
   * interrupts (parallel subagents each hitting a gated tool) must have their
   * decisions routed per interrupt on resume. Null only for sources that
   * don't surface an id (legacy fakes) — resume then falls back to the
   * un-keyed single-interrupt shape.
   */
  interruptId: string | null;
  name: string;
  args: Record<string, unknown>;
  description?: string;
};

/**
 * Minimal streaming surface the adapter needs from a compiled Deep Agents
 * graph. Matches the LangGraph `streamEvents` contract (v2 event envelopes)
 * without importing LangChain types, so unit tests can drive the adapter with
 * hand-built async iterables. `input` is either the user-message payload or a
 * resume Command (opaque to the adapter — built by the graph module).
 */
export type DeepAgentsGraph = {
  streamEvents(
    input: unknown,
    config: {
      version: "v2";
      configurable: { thread_id: string };
      signal?: AbortSignal;
    }
  ): AsyncIterable<Record<string, unknown>>;
};

/**
 * Session-scoped handle over the deepagentsjs graph. Owns the checkpointer for
 * the session's thread and rebuilds the compiled agent when the model changes
 * (per-turn model switching keeps the same checkpointer/thread_id, so the
 * conversation survives the rebuild).
 */
export type DeepAgentsSessionRuntime = {
  /**
   * Returns the compiled agent for `modelId` (an AVAILABLE_MODELS id, e.g.
   * "deepagents/claude-sonnet-5") at reasoning `effort`, building or rebuilding
   * as needed. Reasoning effort is baked into the chat model at construction
   * (Anthropic thinking / OpenAI reasoning.effort / Gemini thinking budget), so
   * a change to EITHER the model or the effort rebuilds the compiled agent.
   */
  getAgentForModel(modelId: string, effort?: RuntimeReasoningEffort | null): Promise<DeepAgentsGraph>;
  /**
   * Pending HITL interrupts on the thread after a stream ended (empty when
   * the turn ran to completion). Order matters: resume decisions must be
   * returned in the same order via {@link buildResumeInput}.
   */
  getPendingActions?(threadId: string): Promise<DeepAgentsPendingAction[]>;
  /**
   * Builds the opaque resume payload for `streamEvents` after decisions.
   * `actions` is the same array `getPendingActions` returned (decision at
   * index i answers actions[i]); the implementation groups decisions per
   * interrupt id so concurrent interrupts each receive their own decisions.
   */
  buildResumeInput?(
    actions: DeepAgentsPendingAction[],
    decisions: Array<{ type: "approve" } | { type: "reject"; message?: string }>
  ): unknown;
  /**
   * Names of the tools that came from the MCP gateway — used by the event
   * mapper to render MCP cards and by approval-kind classification. Empty
   * until the first agent compile loads them.
   */
  getMcpToolNames?(): ReadonlySet<string>;
  /**
   * Tool name → gateway server id for MCP tools, recorded at load time (the
   * adapter library carries no server attribution on the tool or in stream
   * metadata). Used by the event mapper to label MCP cards.
   */
  getMcpToolServers?(): ReadonlyMap<string, string>;
  /**
   * Workspace file ops backing the adapter's readRuntimeFile /
   * statRuntimeFile / writeRuntimeFile (write_artifact + per-turn artifact
   * sync). Present when the runtime has a sandbox backend; absent for
   * state-only runtimes (unit-test fakes). First use lazily creates the
   * sandbox — artifact sync therefore only pays the sandbox cost on turns
   * that actually carry artifacts.
   */
  readFileBytes?(filePath: string): Promise<Uint8Array>;
  statFile?(filePath: string): Promise<{ sizeBytes: number }>;
  writeFileBytes?(filePath: string, data: Uint8Array | ArrayBuffer | string): Promise<string>;
  /** Releases any resources held for the session (checkpointer, sandbox, …). */
  dispose(): Promise<void>;
};

/**
 * Structural view of the shared LangGraph checkpointer (PostgresSaver in
 * production, MemorySaver-compatible fakes in tests). Kept structural so this
 * module and the adapter stay import-free of LangChain packages.
 */
export type DeepAgentsCheckpointSaver = {
  deleteThread(threadId: string): Promise<void>;
  end?(): Promise<void>;
};

export type DeepAgentsE2bOptions = {
  apiKey: string;
  /** Slim code-execution template id (from E2B_TEMPLATE_ID). */
  templateId: string;
  sandboxTimeoutMs: number;
  /** Per-execute() wall-clock budget enforced at our layer. */
  executeTimeoutMs: number;
};

export type DeepAgentsRuntimeFactory = (init: {
  tenantId: string;
  sessionId: string;
  userId: string;
  runtimeId: string;
  /**
   * Resolves the API key for a model provider, DEFERRED to model-selection
   * time. The session's provider is only known once a turn's model is chosen
   * (createSession carries no model), so the graph calls this inside
   * getAgentForModel(modelId) after mapping the model to its provider. Returns
   * null when no tenant/platform key is configured for that provider — the
   * graph then throws a clear, client-safe error for that turn.
   *
   * The in-process loop calls each provider's API DIRECTLY (api.anthropic.com,
   * api.openai.com, generativelanguage.googleapis.com, openrouter.ai).
   * Usage/cost is captured in-process from stream usage_metadata.
   */
  resolveProviderKey: (provider: ModelProvider) => Promise<string | null>;
  /**
   * Optional per-provider base URL override (tests / a future backend-allowed
   * proxy). Keyed by public provider id. Absent → each provider's default
   * endpoint (plus MODEL_PROVIDER_META.baseUrl for OpenRouter).
   */
  providerBaseUrls?: Partial<Record<ModelProvider, string>> | null;
  /** System prompt compiled from developerInstructions + memory section. */
  systemPrompt: string | null;
  /**
   * Enabled skills as a prebuilt read-only file map (path → FileData), served
   * to the agent at /skills/ via a CompositeBackend route and surfaced by the
   * native deepagents skills middleware (progressive disclosure — skills are
   * NOT inlined into the system prompt). Built by buildSkillsLibraryFiles;
   * null/empty disables the skills middleware.
   */
  skillsLibraryFiles?: SkillsLibraryFiles | null;
  /** Sandbox workspace root (e.g. /home/user/workspace/<sessionId>). */
  workspacePath: string;
  /** E2B wiring for the lazy code-execution sandbox; null disables execute. */
  e2b: DeepAgentsE2bOptions | null;
  /**
   * Shared durable checkpointer (PostgresSaver). When absent, the factory
   * falls back to a per-session in-memory saver — conversation state then
   * dies with the process (unit tests, degraded dev).
   */
  checkpointer?: DeepAgentsCheckpointSaver;
  /**
   * MCP gateway servers for this session (compiled config). The graph module
   * connects a MultiServerMCPClient with the Bearer runtime token and exposes
   * the tools to the agent.
   */
  mcpServers?: Array<{ id: string; url: string; authorization: string }>;
  /**
   * Per-turn tool-context id, read at tool-call time and injected into
   * managed MCP tool inputs (the gateway resolves it against
   * ToolExecutionContextStore). The adapter updates `current` at turn start.
   */
  toolContextRef?: { current: string | null };
  /**
   * Native approval gating derived from tenant settings. `gate` false =
   * approvalPolicy "never" (no interrupts at all). Read-only tool names are
   * exempted when autoApproveReadOnly is set.
   */
  approvals?: {
    gate: boolean;
    autoApproveReadOnly: boolean;
    readOnlyToolNames: string[];
  };
  logger: import("fastify").FastifyBaseLogger;
}) => DeepAgentsSessionRuntime;

export type DeepAgentsSessionState = {
  sessionId: string;
  tenantId: string;
  userId: string;
  runtimeId: string;
  /** Wall-clock of the last turn start (or session creation) — surfaced by
   *  the admin runtime-health view. */
  lastActiveAt: string;
  configBundle: RuntimeConfigBundle;
  abortController: AbortController;
  /** LangGraph thread id — derived from the session id (see im5e.3 for the
   *  tenant-ownership rationale: every entry point resolves the session
   *  through tenant-scoped auth before touching the checkpointer). */
  threadId: string;
  runtime: DeepAgentsSessionRuntime;
  /** Idle teardown timer — same RUNTIME_IDLE_TIMEOUT_MS semantics as the
   *  other adapters: armed at creation and turn end, cleared at turn start. */
  idleTimer: NodeJS.Timeout | null;
  /** Aborts the in-flight turn only (Stop button). Set at turn start. */
  activeTurnInterrupt: { current: (() => Promise<void>) | null };
  /** Push hook for out-of-band framework events (Policy Center approvals). */
  activeTurnPush: { current: ((event: RuntimeEvent) => void) | null };
  /**
   * Lets a Policy Center approval (held at the MCP gateway, outside the graph's
   * native-approval loop) pause the active turn's RUNTIME_TURN_TIMEOUT_MS
   * watchdog while a human decides — mirroring how the native `awaitDecisions`
   * path disarms it. Ref-counted so concurrent approvals (parallel subagents)
   * only re-arm once the last one settles. Set by the active turn; null when no
   * turn is running (then policy approvals just don't touch a watchdog).
   */
  activeTurnWatchdog: { current: { pause: () => void; resume: () => void } | null };
  /** Per-turn toolContextId, read by MCP tool wrappers at call time. */
  toolContextRef: { current: string | null };
  /**
   * Remember-keys the user approved with "remember for this turn". A key is the
   * approval kind for built-in kinds, but is scoped to the individual tool name
   * for MCP tools (kind `mcp_tool`) — otherwise remembering one read-only MCP
   * tool would silently auto-approve every other MCP tool (incl. destructive
   * writes) for the rest of the turn. REPLACED with a fresh Set at turn start
   * (pending approvals capture their turn's instance, so a late decision
   * mutates an orphaned set instead of leaking into the next turn).
   */
  autoApprovedKindsForTurn: Set<string>;
};
