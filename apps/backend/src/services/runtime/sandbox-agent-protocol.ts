import type { RuntimeReasoningEffort } from "../../runtime-contracts.js";

/**
 * Stdio protocol between the backend and the in-sandbox Claude harness.
 *
 * Both sides exchange newline-delimited JSON frames. The harness lives at
 * `docker/sandbox-agent/sandbox-agent.mjs` and runs inside the E2B sandbox;
 * it drives `@anthropic-ai/claude-agent-sdk` and streams SDKMessage payloads
 * back. HITL approvals round-trip through `approval_request` / `approval_response`.
 *
 * Design note: the harness does NOT invoke the `claude` CLI. We learned during
 * the spike that headless `claude -p` has no stdio approval hook, which forced
 * `--dangerously-skip-permissions` and broke HITL. Running the SDK in-sandbox
 * preserves the `canUseTool` callback so HITL approvals work over these frames.
 */

// ---------------------------------------------------------------------------
// Backend → harness frames
// ---------------------------------------------------------------------------

export type SandboxTurnFrame = {
  type: "turn";
  turnId: string;
  /** Plain-text user prompt (images/files are already resolved to content blocks in `contentBlocks` below). */
  prompt: string;
  /**
   * Pre-resolved content blocks matching the Claude SDK shape. The backend
   * converts file artifacts to base64 image blocks and URLs to text notes
   * before sending so the harness never needs filesystem access to the
   * caller's artifacts dir.
   */
  contentBlocks: Array<Record<string, unknown>>;
  /** Threaded into every MCP tool call via the approval bridge. */
  toolContextId: string | null;
  /** Previous Claude session id to resume. `null` for the first turn. */
  resumeSessionId: string | null;
  /** Claude model to use for this turn. */
  model: string;
  /** Optional effort override for models that support adaptive thinking. */
  effort: RuntimeReasoningEffort | null;
  /**
   * Appended after the built-in `claude_code` preset — equivalent to the
   * SDK Options.systemPrompt.append field. Null means preset only.
   */
  developerInstructions: string | null;
  /** MCP servers the SDK should register for this query. */
  mcpServers: Array<{ id: string; url: string; authorization: string }>;
  /** Enabled tool IDs passed through for diagnostic logging. */
  enabledToolIds: string[];
  /** When true, auto-approve every tool call (approvalPolicy=never). */
  bypass: boolean;
  /** When true, auto-approve read-only tools (autoApproveReadOnlyTools=true). */
  autoApproveReadOnly: boolean;
  /** Catalog names of managed MCP tools known to be read-only. */
  readOnlyManagedToolNames: string[];
  /**
   * Wall-clock TTL (ms) for the harness's in-sandbox `canUseTool` deny-by-default
   * timer. Sourced from `APPROVAL_REQUEST_TTL_MS` so the harness deny matches the
   * backend's DB-expiry sweep. Optional/defensive: the harness falls back to its
   * own 10-minute default when absent.
   */
  approvalTtlMs?: number;
};

export type SandboxApprovalResponseFrame = {
  type: "approval_response";
  approvalId: string;
  decision: "approve" | "reject";
};

export type SandboxShutdownFrame = {
  type: "shutdown";
};

/**
 * Stop button — asks the harness to invoke `iterator.interrupt()` on the
 * SDK query for the named turn. The SDK then emits a final `result` message
 * with subtype="interrupt" that the harness forwards via the usual
 * `sdk_message` path; the backend's event mapper translates it into a
 * terminal `response.completed { interrupted: true }`.
 */
export type SandboxInterruptFrame = {
  type: "interrupt";
  turnId: string;
};

/**
 * Sent once by the backend immediately after the harness emits `ready`.
 * The harness calls `sdk.startup()` with these options so the CLI subprocess
 * is already warm when the first `turn` frame arrives.
 */
export type SandboxWarmupFrame = {
  type: "warmup";
  model: string;
  developerInstructions: string | null;
  mcpServers: Array<{ id: string; url: string; authorization: string }>;
};

export type SandboxInboundFrame =
  | SandboxTurnFrame
  | SandboxApprovalResponseFrame
  | SandboxShutdownFrame
  | SandboxWarmupFrame
  | SandboxInterruptFrame;

// ---------------------------------------------------------------------------
// Harness → backend frames
// ---------------------------------------------------------------------------

export type SandboxReadyFrame = {
  type: "ready";
  /** Version of `@anthropic-ai/claude-agent-sdk` imported inside the sandbox. */
  sdkVersion: string;
  /** Node.js process.version. */
  nodeVersion: string;
};

export type SandboxSdkMessageFrame = {
  type: "sdk_message";
  turnId: string;
  /** Raw SDKMessage, forwarded as-is through `mapClaudeEvent`. */
  payload: Record<string, unknown>;
};

export type SandboxApprovalRequestFrame = {
  type: "approval_request";
  approvalId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  /** `file_change` for Write/Edit/MultiEdit/NotebookEdit, `command_execution` otherwise. */
  kind: "file_change" | "command_execution";
};

export type SandboxTurnCompleteFrame = {
  type: "turn_complete";
  turnId: string;
  /** Captured from the SDK's system/init message; used as `resume` on the next turn. */
  claudeSessionId: string | null;
};

export type SandboxTurnFailedFrame = {
  type: "turn_failed";
  turnId: string;
  error: string;
};

export type SandboxLogFrame = {
  type: "log";
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fields?: Record<string, unknown>;
};

export type SandboxOutboundFrame =
  | SandboxReadyFrame
  | SandboxSdkMessageFrame
  | SandboxApprovalRequestFrame
  | SandboxTurnCompleteFrame
  | SandboxTurnFailedFrame
  | SandboxLogFrame;

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parses a single line of harness output into a typed frame. Returns null for
 * unrecognized or malformed shapes so the bridge can skip them cleanly (we
 * log but do not throw — the harness may emit stray `console.log` noise from
 * dependencies that we do not control).
 */
export function parseOutboundFrame(line: string): SandboxOutboundFrame | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== "{") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const t = (parsed as { type?: unknown }).type;
  if (
    t === "ready" ||
    t === "sdk_message" ||
    t === "approval_request" ||
    t === "turn_complete" ||
    t === "turn_failed" ||
    t === "log"
  ) {
    return parsed as SandboxOutboundFrame;
  }
  return null;
}

export function encodeInboundFrame(frame: SandboxInboundFrame): string {
  return JSON.stringify(frame) + "\n";
}
