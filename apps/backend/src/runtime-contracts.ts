import type { BaseEvent } from "@ag-ui/client";

import type { EffortLevel, PolicyTurnContext } from "@cogniplane/shared-types";
import type { ResolvedRuntimePolicy } from "./services/admin-config-records.js";

export type RuntimeSessionRef = {
  sessionId: string;
  runtimeId: string;
  runtimePolicy: ResolvedRuntimePolicy;
};

// Thrown by an adapter's turn runner when the session already has a turn in
// flight. It lives here because the route and scheduler share this contract,
// while the slot must be reserved synchronously inside the adapter.
export class SessionBusyError extends Error {
  constructor(sessionId: string) {
    super(`A turn is already running for session ${sessionId}.`);
  }
}

export type RuntimeApprovalKind = "command_execution" | "file_change" | "permissions" | "mcp_tool";
export type RuntimeApprovalDecision = "approve" | "reject";
export type RuntimeReasoningEffort = EffortLevel;
export type RuntimeUserInput = { type: "text"; text: string };

// Deep Agents is the sole runtime adapter (the Codex/Claude-Code adapters and
// their registry were retired in 2026-06/07). The methods below are therefore
// all required — the optional `?.`-guarded surface that once let the framework
// fan actions across multiple providers is gone.
export interface RuntimeAdapter {
  readonly id: string;
  hasActiveTurn(sessionId: string): boolean;
  /**
   * True when this adapter holds live in-memory state for the session. Used to
   * route file-op managed tools only to a runtime that owns the active turn's
   * workspace (see resolveOwningFileAdapter).
   */
  hasSession(sessionId: string): boolean;
  /**
   * True when this adapter owns the specific runtime instance for the session —
   * stricter than `hasSession`, used to disambiguate a stale workspace from the
   * live one.
   */
  hasRuntime(sessionId: string, runtimeId: string): boolean;
  createSession(input: { tenantId: string; sessionId: string; userId: string }): Promise<RuntimeSessionRef>;
  /** Drives one turn and yields AG-UI BaseEvents for clients and scheduled jobs. */
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
  abortSession(input: { tenantId: string; sessionId: string; userId: string }): Promise<void>;
  /**
   * Stop the in-flight turn for `sessionId` while keeping the session warm.
   * Returns `"interrupted"` when an active turn was signalled, `"no_active_turn"`
   * when there was nothing to stop. Implementations must:
   *   - emit a terminal AG-UI `RUN_FINISHED` event with the interrupted marker
   *     so any partial assistant text is persisted with status `"interrupted"`,
   *   - leave the runtime/session itself alive (do NOT shut the process down) so
   *     the user can immediately send a follow-up message in the same context.
   */
  interruptTurn(input: {
    tenantId: string;
    sessionId: string;
    userId: string;
  }): Promise<"interrupted" | "no_active_turn">;
  readRuntimeFile(sessionId: string, filePath: string): Promise<Uint8Array>;
  /**
   * Size of a workspace file without reading it. Used to reject oversized
   * `write_artifact` filePath inputs before buffering the bytes.
   */
  statRuntimeFile(sessionId: string, filePath: string): Promise<{ sizeBytes: number }>;
  writeRuntimeFile(sessionId: string, filePath: string, data: Uint8Array | ArrayBuffer | string): Promise<string>;
  /**
   * Forward an approval decision to the in-flight turn waiting on it. Returns
   * `"resolved"` when the approval was owned, `"missing"` when no matching
   * pending approval exists.
   */
  resolveApproval(input: {
    tenantId: string;
    approvalId: string;
    userId: string;
    decision: RuntimeApprovalDecision;
    rememberForTurn?: boolean;
  }): Promise<"resolved" | "missing">;
  /**
   * Delete durable per-session runtime data (e.g. checkpointer threads) after
   * the session row itself is deleted. Unlike {@link abortSession} — which
   * also fires on idle teardown and config invalidation and must NOT destroy
   * conversation state — this is called only from session deletion. Idempotent.
   */
  purgeSessionData(input: {
    tenantId: string;
    sessionId: string;
    userId: string;
  }): Promise<void>;
  /**
   * Tear down every active runtime for `tenantId` after tenant settings that
   * are snapshotted into runtime config change (also covers admin integration
   * toggles). The next turn rebuilds with the new policy/tool settings. Returns
   * the invalidated session ids.
   */
  invalidateTenantRuntimes(tenantId: string): Promise<string[]>;
  /**
   * Tear down every active runtime for a specific user after they (re)connect
   * or disconnect an integration (the credentials in their live sandbox are now
   * stale). User-scoped counterpart to {@link invalidateTenantRuntimes}.
   */
  invalidateRuntimesForIntegration(
    tenantId: string,
    userId: string,
    integrationId: string
  ): Promise<string[]>;
  close(): Promise<void>;
}
