import type { FastifyBaseLogger } from "fastify";

import {
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
  /** Loader injection point for tests. Defaults to the real E2B SDK. */
  loadSandboxClass?: E2bStdioHarnessInput["loadSandboxClass"];
};

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

  private constructor(
    sandbox: E2bSandboxLike,
    processPid: number,
    logger: FastifyBaseLogger,
    readonly sandboxId: string
  ) {
    this.sandbox = sandbox;
    this.processPid = processPid;
    this.logger = logger;
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
      onExit: (result) => {
        if (!proc || !proc.alive) return;
        proc.alive = false;
        if (proc.currentTurn) {
          proc.currentTurn.listeners.onFail(
            `sandbox-agent exited with code ${result.exitCode}${result.error ? `: ${result.error}` : ""}`
          );
          proc.currentTurn = null;
        }
      }
    });

    proc = new E2bClaudeRuntimeProcess(
      harness.sandbox,
      harness.processPid,
      input.logger,
      harness.sandbox.sandboxId
    );
    return proc;
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

      this.sendFrame(frame).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.currentTurn = null;
        listeners.onFail(message);
        reject(err);
      });
    });
  }

  /** Forwards the user's approve/reject decision to the in-sandbox harness. */
  async sendApprovalResponse(approvalId: string, decision: "approve" | "reject"): Promise<void> {
    await this.sendFrame({ type: "approval_response", approvalId, decision });
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
        this.currentTurn = null;
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
        this.currentTurn = null;
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
