import type { ProjectInstructionsSnapshot } from "@cogniplane/shared-types";
import type { BaseEvent } from "@ag-ui/client";

import type { EffortLevel, PolicyTurnContext, ProjectApprovalMode, TurnStopReason } from "@cogniplane/shared-types";
import type { ResolvedRuntimePolicy } from "./services/admin-config-records.js";
import type { SessionExecution } from "./services/session-execution-store.js";
import type { ReleasedSandbox, SandboxDisposalOutcome } from "./services/runtime/e2b-sandbox-disposal.js";

export type RuntimeSessionRef = {
  sessionId: string;
  runtimeId: string;
  runtimePolicy: ResolvedRuntimePolicy;
  mcpServerSources?: Array<{ id: string; hash: string; credentialVersion?: number | null }>;
  // Connected upstream account per integration, recorded at turn start.
  integrationAccounts?: Record<string, string>;
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

export function resolveTurnApprovalSettings(
  runtimePolicy: ResolvedRuntimePolicy,
  projectApprovalMode?: ProjectApprovalMode
): { gate: boolean; autoApproveReadOnly: boolean } {
  if (!projectApprovalMode || projectApprovalMode === "organization_default") {
    return {
      gate: runtimePolicy.approvalPolicy !== "never",
      autoApproveReadOnly: runtimePolicy.autoApproveReadOnlyTools
    };
  }
  if (projectApprovalMode === "manual") {
    return { gate: true, autoApproveReadOnly: false };
  }
  // Automatic mode cannot weaken the tenant's native approval policy. The
  // current runtime exposes the native policy as one gate, so every policy
  // other than "never" remains gated. Policy Center is separate: enforced
  // block and require_approval rules still run for MCP tools in the graph and
  // gateway.
  return {
    gate: runtimePolicy.approvalPolicy !== "never",
    autoApproveReadOnly: runtimePolicy.autoApproveReadOnlyTools
  };
}
export type RuntimeUserInput = { type: "text"; text: string };

// Deep Agents is the only runtime adapter. Every method below is therefore required.
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
  /** Clears work deferred while a request owned the session's admission slot. */
  finishTurnAdmission?(input: { tenantId: string; sessionId: string; userId: string }): Promise<void>;
  createSession(input: { tenantId: string; sessionId: string; userId: string; execution?: SessionExecution }): Promise<RuntimeSessionRef>;
  /** Drives one turn and yields AG-UI BaseEvents for clients and scheduled jobs. */
  runMessageAGUI(
    session: RuntimeSessionRef,
    input: {
      prompt: string;
      projectInstructions?: ProjectInstructionsSnapshot | null;
      generativeUiContext?: string | null;
      generativeUiTransport?: "tool";
      userInputs?: RuntimeUserInput[];
      toolContextId: string | null;
      /** Project approval mode captured when this turn was admitted. */
      projectApprovalMode?: ProjectApprovalMode;
      turnContext?: PolicyTurnContext;
      assistantMessageId?: string | null;
      model?: string;
      effort?: RuntimeReasoningEffort;
      cancelSignal?: AbortSignal;
      onBeforeTurn?: (signal: AbortSignal) => Promise<void>;
    }
  ): AsyncIterable<BaseEvent>;
  abortSession(input: {
    tenantId: string; sessionId: string; userId: string; executionId?: string;
    /** Why the backend stops the session; its running turn reports it. */
    reason?: TurnStopReason;
  }): Promise<void>;
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
    /**
     * The execution that a stop fenced. A turn of another execution is not
     * interrupted, so a late stop signal cannot stop a newer turn.
     */
    executionId?: string;
  }): Promise<"interrupted" | "no_active_turn">;
  readRuntimeFile(sessionId: string, filePath: string): Promise<Uint8Array>;
  /**
   * Size of a workspace file without reading it. Used to reject oversized
   * `write_artifact` filePath inputs before buffering the bytes.
   */
  statRuntimeFile(sessionId: string, filePath: string): Promise<{ sizeBytes: number }>;
  writeRuntimeFile(sessionId: string, filePath: string, data: Uint8Array | ArrayBuffer | string): Promise<string>;
  /**
   * Saves an approval decision and resumes the turn that waits on it. Returns
   * `"resolved"` when the caller decided the approval now, or when the caller
   * already saved an equivalent decision (a retry, with no new effect).
   * Returns `"conflict"` when the caller already saved a different decision.
   * Returns `"missing"` when the caller cannot decide or read the approval.
   */
  resolveApproval(input: {
    tenantId: string;
    approvalId: string;
    userId: string;
    decision: RuntimeApprovalDecision;
    rememberForTurn?: boolean;
  }): Promise<"resolved" | "missing" | "conflict">;
  /**
   * Delete durable per-session runtime data (e.g. checkpointer threads) after
   * the session row itself is deleted. Unlike {@link abortSession} — which
   * also fires on idle teardown and config invalidation and must NOT destroy
   * conversation state — this is called after session or project deletion.
   * Idempotent.
   */
  purgeSessionData(input: {
    tenantId: string;
    sessionId: string;
    userId: string;
  }): Promise<void>;
  /**
   * Kill the sandbox that archive, delete, purge or a security change of the owner's
   * account took from a session. The store read the id under the session row lock and
   * cleared it in the transaction that changed the status or the security version,
   * and that transaction stopped the session lease, so no runtime can adopt the
   * sandbox now (services/auth/security-change.ts). Idle teardown, invalidation and
   * shutdown never call this: the next turn reconnects to a saved sandbox. It does not
   * throw for a provider failure; the outcome says what happened.
   */
  destroySandbox(input: ReleasedSandbox): Promise<SandboxDisposalOutcome>;
  /**
   * Tear down every active runtime for `tenantId` after tenant settings that
   * are snapshotted into runtime config change (also covers admin integration
   * toggles). The next turn rebuilds with the new policy/tool settings. Returns
   * the invalidated session ids.
   */
  invalidateTenantRuntimes(
    tenantId: string,
    options?: { idleOnly?: boolean; workspaceResetReason?: string }
  ): Promise<string[]>;
  /**
   * Tear down every active runtime owned by one tenant member. A security
   * change of the member's account (services/auth/security-change.ts) uses
   * this to stop both interactive and scheduled turns under that identity.
   * `reason` goes on the interrupted RUN_FINISHED of a running turn, so the
   * user sees why it stopped. Returns the invalidated session ids.
   */
  invalidateRuntimesForUser(tenantId: string, userId: string, options?: { reason?: TurnStopReason }): Promise<string[]>;
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
