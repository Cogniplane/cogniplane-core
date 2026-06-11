import type { FastifyBaseLogger } from "fastify";

import {
  MAX_STDOUT_LINE_BYTES,
  startE2bStdioHarness,
  type E2bSandboxLike,
  type E2bStdioHarnessInput
} from "./e2b-runtime-process.js";
import {
  encodeInboundFrame,
  parseOutboundFrame,
  type SandboxApprovalRequestFrame,
  type SandboxOutboundFrame,
  type SandboxTurnFrame,
  type SandboxWarmupFrame
} from "./sandbox-agent-protocol.js";

export const SANDBOX_AGENT_PATH = "/opt/cogniplane/sandbox-agent.mjs";

export type E2bClaudeProcessStartInput = {
  e2bApiKey: string;
  e2bTemplateId: string;
  e2bSandboxTimeoutMs: number;
  /** Path inside the E2B sandbox (e.g. /home/user/workspace/session-1). */
  workspacePath: string;
  /** Local staging directory whose contents are uploaded into the sandbox. */
  localWorkspacePath: string;
  env?: Record<string, string>;
  logger: FastifyBaseLogger;
  sessionId: string;
  runtimeId: string;
  /**
   * Wall-clock TTL for a pending approval. On expiry the bridge forwards a
   * synthetic `reject` to the in-sandbox harness (unblocking the SDK turn) and
   * fires `onApprovalExpired` so the caller can expire the DB row + emit the
   * `approval.expired` audit event. Mirrors Codex `scheduleApprovalExpiry`.
   * The harness enforces the same TTL independently; this backend-side timer
   * is what drives the DB/audit side-effects. Defaults to 10 minutes.
   */
  approvalRequestTtlMs?: number;
  /**
   * Called once when a pending approval is swept by the backend TTL. The
   * caller is responsible for the DB row (`approvals.expire`) and the
   * `approval.expired` audit event — the process only owns the in-sandbox
   * reject. Best-effort: throws are swallowed by the caller's own logging.
   */
  onApprovalExpired?: (approvalId: string) => void;
  /**
   * Called once when the in-sandbox harness exits unexpectedly (crash, OOM,
   * E2B eviction) — including BETWEEN turns, where nothing else observes the
   * death. The adapter finalizes from here: terminal runtime_sessions status,
   * staging-dir cleanup, IP-pin release, stale session-map removal. The
   * process kills the sandbox itself before invoking this. Also fired after a
   * turn-watchdog recycle (see turnTimeoutMs).
   */
  onHarnessExit?: () => void;
  /**
   * Watchdog on a single turn's wall-clock duration (RUNTIME_TURN_TIMEOUT_MS).
   * runTurn otherwise settles only on a terminal frame or harness exit — a
   * wedged in-sandbox SDK pins the session busy until the E2B hard timeout.
   * On expiry the turn fails, the sandbox is killed, and `onHarnessExit` runs
   * so the adapter finalizes; the next message bootstraps a fresh sandbox.
   * 0 / undefined disables the watchdog.
   */
  turnTimeoutMs?: number;
  /** Loader injection point for tests. Defaults to the real E2B SDK. */
  loadSandboxClass?: E2bStdioHarnessInput["loadSandboxClass"];
};

const DEFAULT_APPROVAL_REQUEST_TTL_MS = 10 * 60 * 1000;

type PendingTurnListeners = {
  onSdkMessage: (payload: Record<string, unknown>) => void;
  onApprovalRequest: (frame: SandboxApprovalRequestFrame) => void;
  onComplete: (claudeSessionId: string | null) => void;
  onFail: (error: string) => void;
};

/**
 * Long-lived stdio bridge to the sandbox-agent harness running inside an E2B
 * sandbox. One instance per Cogniplane session; reused across turns to keep
 * the Claude Agent SDK's in-sandbox state warm.
 *
 * Message flow:
 *   - backend (this class) → stdin → harness: `turn`, `approval_response`,
 *     `shutdown` frames.
 *   - harness → stdout → backend (this class): `ready`, `sdk_message`,
 *     `approval_request`, `turn_complete`, `turn_failed`, `log` frames.
 *
 * Sandbox creation, workspace upload, line-buffered stdout dispatch, and the
 * exit watcher are shared with `E2bRuntimeProcess` (Codex) via
 * `startE2bStdioHarness`. This class owns only the frame-level semantics:
 * `runTurn` sends a single frame and pumps typed listeners until the harness
 * emits `turn_complete` (or `turn_failed`).
 */
export class E2bClaudeRuntimeProcess {
  private readonly sandbox: E2bSandboxLike;
  private readonly processPid: number;
  private alive = true;
  private readonly logger: FastifyBaseLogger;
  private currentTurn: { turnId: string; listeners: PendingTurnListeners } | null = null;
  private readonly approvalRequestTtlMs: number;
  private readonly onApprovalExpired?: (approvalId: string) => void;
  private readonly onHarnessExit?: () => void;
  private readonly turnTimeoutMs: number;
  private turnWatchdog: NodeJS.Timeout | null = null;
  /** approvalId → deny-by-default timer for the matching DB row. */
  private readonly approvalExpiryTimers = new Map<string, NodeJS.Timeout>();

  private constructor(
    sandbox: E2bSandboxLike,
    processPid: number,
    logger: FastifyBaseLogger,
    readonly sandboxId: string,
    approvalRequestTtlMs: number,
    onApprovalExpired?: (approvalId: string) => void,
    onHarnessExit?: () => void,
    turnTimeoutMs?: number
  ) {
    this.sandbox = sandbox;
    this.processPid = processPid;
    this.logger = logger;
    this.approvalRequestTtlMs = approvalRequestTtlMs;
    this.onApprovalExpired = onApprovalExpired;
    this.onHarnessExit = onHarnessExit;
    this.turnTimeoutMs = turnTimeoutMs && turnTimeoutMs > 0 ? turnTimeoutMs : 0;
  }

  static async start(input: E2bClaudeProcessStartInput): Promise<E2bClaudeRuntimeProcess> {
    // Late-bound closure: the harness registers onStdoutLine/onExit
    // synchronously, but they only fire after the background process spawns
    // (strictly after this `await` resolves), by which point `proc` is set.
    let proc: E2bClaudeRuntimeProcess | null = null;

    const harness = await startE2bStdioHarness({
      logger: input.logger,
      sessionId: input.sessionId,
      runtimeId: input.runtimeId,
      e2bApiKey: input.e2bApiKey,
      e2bTemplateId: input.e2bTemplateId,
      e2bSandboxTimeoutMs: input.e2bSandboxTimeoutMs,
      env: input.env,
      metadata: {
        runtimeId: input.runtimeId,
        sessionId: input.sessionId,
        provider: "claude-code"
      },
      localWorkspacePath: input.localWorkspacePath,
      sandboxWorkspacePath: input.workspacePath,
      command: `node ${SANDBOX_AGENT_PATH}`,
      stderrLogLabel: "sandbox-agent stderr",
      loadSandboxClass: input.loadSandboxClass,
      onStdoutLine: (line) => proc?.dispatchLine(line),
      onExit: (result) => proc?.handleHarnessExit(result)
    });

    proc = new E2bClaudeRuntimeProcess(
      harness.sandbox,
      harness.processPid,
      input.logger,
      harness.sandbox.sandboxId,
      input.approvalRequestTtlMs && input.approvalRequestTtlMs > 0
        ? input.approvalRequestTtlMs
        : DEFAULT_APPROVAL_REQUEST_TTL_MS,
      input.onApprovalExpired,
      input.onHarnessExit,
      input.turnTimeoutMs
    );
    return proc;
  }

  /**
   * Unexpected-exit hook fired by the shared harness exit watcher. Idempotent
   * — terminate() flips `alive` first, so a watcher firing during an explicit
   * teardown is a no-op.
   */
  private handleHarnessExit(result: { exitCode?: number; stderr?: string; error?: string }): void {
    if (!this.alive) return;
    this.alive = false;
    this.clearTurnWatchdog();
    this.clearAllApprovalExpiry();
    if (this.currentTurn) {
      // currentTurn is cleared on turn_complete/turn_failed, so reaching
      // here means the harness died mid-turn with no terminal frame: a
      // crash, OOM, sandbox kill, or — since Claude Agent SDK 0.3.142 — a
      // permanent auth/transport close (e.g. a 401/403 on the rt_* proxy
      // token), which now exits non-zero with a stderr diagnostic instead
      // of a silent clean exit. Fail the turn so it never hangs, and append
      // the stderr tail so the diagnostic reaches the SSE stream, not just
      // the backend logs.
      const stderrTail = result.stderr?.trim().slice(-500);
      this.currentTurn.listeners.onFail(
        `sandbox-agent exited with code ${result.exitCode}` +
          (result.error ? `: ${result.error}` : "") +
          (stderrTail ? `\n${stderrTail}` : "")
      );
      this.currentTurn = null;
    }
    // The harness process died but the sandbox itself may still be running
    // (and billing) — kill it rather than waiting for the E2B hard timeout.
    void this.sandbox.kill().catch((err: unknown) => {
      this.logger.warn(
        { err, sandboxId: this.sandboxId },
        "E2B Claude sandbox kill failed after harness exit"
      );
    });
    // Adapter-side finalization (terminal DB status, staging cleanup, stale
    // session-map removal) — between turns nothing else observes this death.
    this.onHarnessExit?.();
  }

  isAlive(): boolean {
    return this.alive;
  }

  /**
   * Sends a turn frame and returns a promise that resolves when the harness
   * emits `turn_complete`. SDK messages and approval requests are delivered
   * to the provided listeners while the promise is pending.
   */
  async runTurn(frame: SandboxTurnFrame, listeners: PendingTurnListeners): Promise<void> {
    if (!this.alive) {
      throw new Error("E2B Claude sandbox is not available");
    }
    if (this.currentTurn) {
      throw new Error("A turn is already running in this sandbox");
    }

    return new Promise<void>((resolve, reject) => {
      this.currentTurn = {
        turnId: frame.turnId,
        listeners: {
          ...listeners,
          onComplete: (claudeSessionId) => {
            listeners.onComplete(claudeSessionId);
            resolve();
          },
          onFail: (error) => {
            listeners.onFail(error);
            reject(new Error(error));
          }
        }
      };
      this.armTurnWatchdog(frame.turnId);

      this.sendFrame(frame).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.clearTurnWatchdog();
        this.currentTurn = null;
        listeners.onFail(message);
        reject(err);
      });
    });
  }

  // Turn-duration watchdog: the promise above settles only on a terminal frame
  // or harness exit, so a wedged in-sandbox SDK would pin the session busy
  // until the E2B hard timeout. On expiry: fail the turn (unblocks runTurn and
  // the SSE consumer), kill the wedged sandbox, and fire onHarnessExit so the
  // adapter finalizes — the next message bootstraps a fresh sandbox.
  private armTurnWatchdog(turnId: string): void {
    if (this.turnTimeoutMs <= 0) return;
    this.clearTurnWatchdog();
    this.turnWatchdog = setTimeout(() => {
      this.turnWatchdog = null;
      const turn = this.currentTurn;
      if (!turn || turn.turnId !== turnId) return;
      this.logger.error(
        { sandboxId: this.sandboxId, turnId, timeoutMs: this.turnTimeoutMs },
        "Claude turn watchdog expired — failing turn and recycling sandbox"
      );
      this.currentTurn = null;
      turn.listeners.onFail(`Turn exceeded the ${this.turnTimeoutMs}ms limit and was aborted.`);
      void this.terminate().catch((err: unknown) => {
        this.logger.error(
          { err, sandboxId: this.sandboxId },
          "failed to terminate sandbox after turn timeout"
        );
      });
      this.onHarnessExit?.();
    }, this.turnTimeoutMs);
    this.turnWatchdog.unref?.();
  }

  private clearTurnWatchdog(): void {
    if (this.turnWatchdog) {
      clearTimeout(this.turnWatchdog);
      this.turnWatchdog = null;
    }
  }

  /** Forwards the user's approve/reject decision to the in-sandbox harness. */
  async sendApprovalResponse(approvalId: string, decision: "approve" | "reject"): Promise<void> {
    this.clearApprovalExpiry(approvalId);
    await this.sendFrame({ type: "approval_response", approvalId, decision });
  }

  /** Arm a deny-by-default timer for a freshly dispatched approval request. */
  private armApprovalExpiry(approvalId: string): void {
    if (this.approvalExpiryTimers.has(approvalId)) return;
    const timer = setTimeout(() => {
      this.approvalExpiryTimers.delete(approvalId);
      // Unblock the in-sandbox SDK turn by forwarding a synthetic reject. The
      // harness also self-denies on its own TTL, so this is idempotent.
      void this.sendApprovalResponse(approvalId, "reject").catch((err) => {
        this.logger.warn(
          { err, sandboxId: this.sandboxId, approvalId },
          "failed to forward expiry reject to sandbox-agent"
        );
      });
      try {
        this.onApprovalExpired?.(approvalId);
      } catch (err) {
        this.logger.error(
          { err, sandboxId: this.sandboxId, approvalId },
          "onApprovalExpired threw during approval sweep"
        );
      }
    }, this.approvalRequestTtlMs);
    this.approvalExpiryTimers.set(approvalId, timer);
  }

  private clearApprovalExpiry(approvalId: string): void {
    const timer = this.approvalExpiryTimers.get(approvalId);
    if (timer) {
      clearTimeout(timer);
      this.approvalExpiryTimers.delete(approvalId);
    }
  }

  private clearAllApprovalExpiry(): void {
    for (const timer of this.approvalExpiryTimers.values()) clearTimeout(timer);
    this.approvalExpiryTimers.clear();
  }

  /**
   * Called when a turn ends. Any approval whose deny-by-default timer is STILL
   * armed was never resolved by the user — the harness self-denied it on its own
   * TTL and proceeded to `turn_complete` before our backend timer fired. If we
   * merely cleared those timers the DB row would stay `pending` forever (stale
   * prompt / late decision). Instead, fire `onApprovalExpired` for each so the
   * row is moved to `expired` and audited, then drop the timers. Resolved
   * approvals already had their timer cleared in `sendApprovalResponse`, so they
   * are not in the map and are not double-expired here.
   */
  private reconcilePendingApprovalsOnTurnEnd(): void {
    if (this.approvalExpiryTimers.size === 0) return;
    const approvalIds = [...this.approvalExpiryTimers.keys()];
    for (const timer of this.approvalExpiryTimers.values()) clearTimeout(timer);
    this.approvalExpiryTimers.clear();
    for (const approvalId of approvalIds) {
      try {
        this.onApprovalExpired?.(approvalId);
      } catch (err) {
        this.logger.error(
          { err, sandboxId: this.sandboxId, approvalId },
          "onApprovalExpired threw during turn-end approval reconciliation"
        );
      }
    }
  }

  /**
   * Stop button — asks the in-sandbox harness to call `iterator.interrupt()`
   * on the active SDK query. Returns true if a turn was actively running.
   * The terminal `response.completed { interrupted: true }` arrives through
   * the normal sdk_message → mapClaudeEvent path; callers do NOT need to
   * synthesize a frame on top.
   */
  async interruptCurrentTurn(turnId: string): Promise<boolean> {
    if (!this.currentTurn || this.currentTurn.turnId !== turnId) return false;
    await this.sendFrame({ type: "interrupt", turnId });
    return true;
  }

  /**
   * Sends a warmup frame so the harness can pre-warm the Claude SDK subprocess
   * before the first turn arrives. Fire-and-forget: callers should swallow errors.
   */
  async sendWarmup(frame: SandboxWarmupFrame): Promise<void> {
    await this.sendFrame(frame);
  }

  /** Reads a file from the sandbox filesystem. */
  async readFile(sandboxPath: string): Promise<Uint8Array> {
    return this.sandbox.files.read(sandboxPath, { format: "bytes" });
  }

  /** File metadata (size) without reading the content into memory. */
  async statFile(sandboxPath: string): Promise<{ sizeBytes: number }> {
    const info = await this.sandbox.files.getInfo(sandboxPath);
    return { sizeBytes: info.size };
  }

  /** Writes a file to the sandbox filesystem. */
  async writeFile(sandboxPath: string, data: string | Uint8Array | ArrayBuffer): Promise<void> {
    // E2B's files.write expects string | ArrayBuffer; normalize Uint8Array
    // the same way E2bRuntimeProcess.writeFile does to avoid pooled-buffer
    // corruption when passing a Buffer view.
    let payload: string | ArrayBuffer;
    if (typeof data === "string") {
      payload = data;
    } else if (data instanceof Uint8Array) {
      payload = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    } else {
      payload = data;
    }
    await this.sandbox.files.write([{ path: sandboxPath, data: payload }]);
  }

  async terminate(): Promise<void> {
    if (!this.alive) return;
    this.alive = false;
    this.clearTurnWatchdog();
    this.clearAllApprovalExpiry();
    try {
      await this.sendFrame({ type: "shutdown" });
    } catch {
      // Best-effort — the sandbox may already be dead.
    }
    await this.sandbox.kill().catch((err: unknown) => {
      this.logger.warn(
        { err, sandboxId: this.sandboxId },
        "E2B Claude sandbox kill failed during terminate"
      );
    });
    if (this.currentTurn) {
      this.currentTurn.listeners.onFail("Sandbox terminated.");
      this.currentTurn = null;
    }
  }

  private async sendFrame(frame: Parameters<typeof encodeInboundFrame>[0]): Promise<void> {
    await this.sandbox.commands.sendStdin(this.processPid, encodeInboundFrame(frame));
  }

  /** Called by the shared harness for each complete newline-delimited stdout line. */
  private dispatchLine(line: string): void {
    // Guard against a runaway / newline-less frame ballooning backend memory:
    // the shared line buffer keeps accumulating until it sees a "\n", so a
    // pathological harness (or a corrupted SDK message) could grow without
    // bound. Drop oversized lines with a single warning instead of parsing.
    if (line.length > MAX_STDOUT_LINE_BYTES) {
      this.logger.error(
        { sandboxId: this.sandboxId, lineLength: line.length, max: MAX_STDOUT_LINE_BYTES },
        "sandbox-agent: dropping oversized stdout line"
      );
      return;
    }
    const frame = parseOutboundFrame(line);
    if (!frame) {
      this.logger.debug(
        { sandboxId: this.sandboxId, preview: line.slice(0, 200) },
        "sandbox-agent: skipping non-frame stdout line"
      );
      return;
    }
    this.dispatchFrame(frame);
  }

  private dispatchFrame(frame: SandboxOutboundFrame): void {
    switch (frame.type) {
      case "ready":
        this.logger.info(
          {
            sandboxId: this.sandboxId,
            sdkVersion: frame.sdkVersion,
            nodeVersion: frame.nodeVersion
          },
          "sandbox-agent ready"
        );
        break;
      case "sdk_message": {
        const turn = this.currentTurn;
        if (!turn || turn.turnId !== frame.turnId) {
          this.logger.warn(
            { sandboxId: this.sandboxId, turnId: frame.turnId },
            "sdk_message for unknown/closed turn"
          );
          return;
        }
        turn.listeners.onSdkMessage(frame.payload);
        break;
      }
      case "approval_request": {
        const turn = this.currentTurn;
        if (!turn) {
          this.logger.warn(
            { sandboxId: this.sandboxId, approvalId: frame.approvalId },
            "approval_request with no active turn; auto-denying"
          );
          // Rescue deadlock: the harness is waiting for a response.
          void this.sendApprovalResponse(frame.approvalId, "reject").catch((err) => {
            this.logger.error(
              { err, sandboxId: this.sandboxId, approvalId: frame.approvalId },
              "failed to deliver auto-deny to sandbox-agent; terminating sandbox"
            );
            void this.terminate().catch((termErr) => {
              this.logger.error(
                { err: termErr, sandboxId: this.sandboxId },
                "failed to terminate sandbox after stuck approval"
              );
            });
          });
          return;
        }
        this.armApprovalExpiry(frame.approvalId);
        turn.listeners.onApprovalRequest(frame);
        break;
      }
      case "turn_complete": {
        const turn = this.currentTurn;
        if (!turn || turn.turnId !== frame.turnId) {
          this.logger.warn(
            { sandboxId: this.sandboxId, turnId: frame.turnId },
            "turn_complete for unknown turn"
          );
          return;
        }
        this.clearTurnWatchdog();
        this.currentTurn = null;
        this.reconcilePendingApprovalsOnTurnEnd();
        turn.listeners.onComplete(frame.claudeSessionId);
        break;
      }
      case "turn_failed": {
        const turn = this.currentTurn;
        if (!turn || turn.turnId !== frame.turnId) {
          this.logger.warn(
            { sandboxId: this.sandboxId, turnId: frame.turnId },
            "turn_failed for unknown turn"
          );
          return;
        }
        this.clearTurnWatchdog();
        this.currentTurn = null;
        this.reconcilePendingApprovalsOnTurnEnd();
        turn.listeners.onFail(frame.error);
        break;
      }
      case "log":
        this.logger[frame.level](
          { sandboxId: this.sandboxId, ...(frame.fields ?? {}) },
          `sandbox-agent: ${frame.message}`
        );
        break;
    }
  }
}
