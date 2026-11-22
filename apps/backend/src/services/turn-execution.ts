import type { PolicyTurnContext } from "@cogniplane/shared-types";

import type { RuntimeAdapter, RuntimeSessionRef } from "../runtime-contracts.js";
import type { ToolExecutionContext, ToolExecutionContextStore } from "./auth/tool-execution-context-store.js";
import { startExecutionHeartbeat, stopLostExecution } from "./execution-heartbeat.js";
import {
  type ExecutionActor,
  type ExecutionTurnContext,
  type SessionExecution,
  SessionExecutionError,
  type SessionExecutionStore
} from "./session-execution-store.js";

// What an interactive turn (routes/messages.ts) and a scheduled turn
// (services/scheduler-worker.ts) do the same way: take the session's execution
// lease, renew it, release it once, and bind the turn's tool context. Each
// entry point keeps its own order around these steps: its checks, its limits,
// what it does when the lease is lost, and when it releases.

export type TurnLeaseStore = Pick<SessionExecutionStore, "acquire" | "heartbeat" | "release"> &
  Partial<Pick<SessionExecutionStore, "stoppedBySecurityChange">>;

export type TurnLeaseSettings = {
  /** SESSION_EXECUTION_LEASE_MS */
  leaseMs: number;
  /** SESSION_EXECUTION_HEARTBEAT_MS */
  heartbeatMs: number;
  /** MAX_RUNNING_TURNS_PER_USER and MAX_RUNNING_TURNS_PER_TENANT */
  caps: { perUser: number; perTenant: number };
};

/**
 * The execution lease of one turn. One session runs one turn on all replicas,
 * and each lease counts toward the running-turn caps.
 */
export class TurnExecutionLease {
  #stopHeartbeat: (() => void) | undefined;
  #released: Promise<void> | undefined;
  #lost = false;

  private constructor(
    readonly execution: SessionExecution,
    private readonly input: {
      executions: TurnLeaseStore;
      settings: TurnLeaseSettings;
      onReleaseError: (error: unknown) => void;
    },
    private readonly leaseStartedAt: number
  ) {}

  /**
   * Takes the lease. No heartbeat runs yet: the caller can still give the
   * lease up (`release`) before a runtime session uses it. Throws
   * SessionExecutionError when the session is busy or a cap is reached.
   */
  static async acquire(input: {
    executions: TurnLeaseStore;
    actor: ExecutionActor;
    settings: TurnLeaseSettings;
    /** Default: interactive. */
    turnContext?: ExecutionTurnContext;
    /** A failed release is not passed on: the lease ends at its expiry. */
    onReleaseError: (error: unknown) => void;
  }): Promise<TurnExecutionLease> {
    const leaseStartedAt = performance.now();
    const { leaseMs, caps } = input.settings;
    const execution = await input.executions.acquire(
      input.actor, leaseMs, caps, ...(input.turnContext ? [input.turnContext] as const : [])
    );
    return new TurnExecutionLease(execution, input, leaseStartedAt);
  }

  /**
   * Renews the lease until `release` or `stopHeartbeat`. When this replica
   * loses the lease (a stop, a security change, an expiry), `lost` becomes
   * true and `onLost` runs once. `onLost` decides what happens to the runtime
   * (`stopRuntime`) and to the lease. Its rejection goes to `onError`, as a
   * failed renewal does.
   */
  startHeartbeat(handlers: { onLost: () => Promise<void>; onError: (error: unknown) => void }): void {
    if (this.#released || this.#stopHeartbeat) return;
    const { executions, settings } = this.input;
    const { execution } = this;
    this.#stopHeartbeat = startExecutionHeartbeat({
      leaseStartedAt: this.leaseStartedAt,
      // A monotonic deadline from the expiry that the database issued.
      leaseExpiresAt: performance.now() + Math.max(0, new Date(execution.expiresAt).getTime() - Date.now()),
      leaseMs: settings.leaseMs,
      intervalMs: settings.heartbeatMs,
      renew: () => executions.heartbeat(execution, settings.leaseMs),
      onError: handlers.onError,
      onLost: () => {
        this.#lost = true;
        return handlers.onLost();
      }
    });
  }

  /** This replica lost the lease. */
  get lost(): boolean {
    return this.#lost;
  }

  /** Throws when the lease is lost, so that turn setup stops at its next step. */
  assertHeld(): void {
    if (this.#lost) throw new SessionExecutionError("execution_stopped", 403);
  }

  /**
   * Asks the runtime to stop the turn of this execution, after the lease is
   * lost (`stopLostExecution`). It cannot stop a newer turn of the session.
   */
  stopRuntime(runtime: Pick<RuntimeAdapter, "abortSession">): Promise<void> {
    return stopLostExecution({ execution: this.execution, executions: this.input.executions, runtime });
  }

  /** Stops the renewal and keeps the lease: it ends at its expiry. */
  stopHeartbeat(): void {
    this.#stopHeartbeat?.();
  }

  /** Stops the heartbeat and releases the lease. Runs once; it does not reject. */
  release(): Promise<void> {
    return this.#released ??= (async () => {
      this.stopHeartbeat();
      try {
        await this.input.executions.release(this.execution);
      } catch (error) {
        this.input.onReleaseError(error);
      }
    })();
  }
}

/**
 * Creates the tool execution context of a turn: the record that the MCP
 * gateway reads for each tool call of the turn. It binds the turn to its
 * runtime session and policy snapshot, to its execution, and to the owner's
 * security version that admitted the turn, so the gateway refuses the turn's
 * tool calls after a security change (services/auth/security-change.ts).
 */
export async function bindTurnToolContext(
  toolContexts: Pick<ToolExecutionContextStore, "create">,
  input: {
    tenantId: string;
    sessionId: string;
    userId: string;
    /** The runtime session of the turn. Its policy snapshot is what the gateway enforces. */
    runtimeSession: Pick<RuntimeSessionRef, "runtimeId" | "runtimePolicy" | "mcpServerSources" | "integrationAccounts">;
    /** The assistant message of the turn. */
    messageId: string;
    execution?: Pick<SessionExecution, "executionId">;
    /** Policy Center reads it, so a rule can gate unattended turns more strictly. */
    turnContext?: PolicyTurnContext;
    /** Null for a WorkOS owner. */
    ownerSecurityVersion: number | null;
    ttlMs: number;
    /** What only one kind of turn has, for example the selected artifacts. */
    metadata?: Record<string, unknown>;
  }
): Promise<ToolExecutionContext> {
  const { runtimeSession } = input;
  return toolContexts.create({
    tenantId: input.tenantId,
    sessionId: input.sessionId,
    userId: input.userId,
    runtimeId: runtimeSession.runtimeId,
    runtimePolicyId: runtimeSession.runtimePolicy.id,
    messageId: input.messageId,
    metadata: {
      // First, so that it cannot replace a bound field below.
      ...input.metadata,
      ...(input.execution ? { executionId: input.execution.executionId } : {}),
      runtimePolicy: runtimeSession.runtimePolicy,
      ...(runtimeSession.mcpServerSources ? { mcpServerSources: runtimeSession.mcpServerSources } : {}),
      ...(runtimeSession.integrationAccounts ? { integrationAccounts: runtimeSession.integrationAccounts } : {}),
      ...(input.turnContext ? { turnContext: input.turnContext } : {})
    },
    ownerSecurityVersion: input.ownerSecurityVersion,
    ttlMs: input.ttlMs
  });
}
