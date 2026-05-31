
import type { FastifyBaseLogger } from "fastify";
import { uuidv7 } from "../../lib/uuid.js";

import { getErrorMessage } from "../../lib/http-errors.js";
import type { RuntimeToolCall } from "../../runtime-contracts.js";
import type { ArtifactStorage } from "../artifacts/artifact-storage.js";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import { handleRuntimeRequest } from "./runtime-request-handler.js";
import { mapRuntimeNotification } from "./runtime-notification-mapper.js";
import { redactSecrets } from "../redact-secrets.js";
import { captureWorkspaceArtifacts } from "../artifacts/workspace-artifact-capture.js";
import type {
  JsonRpcNotification,
  JsonRpcRequest
} from "./codex-jsonrpc.js";
import type { ActiveTurnState, RuntimeState } from "./runtime-types.js";
import { CodexSessionLifecycle } from "./codex-session-lifecycle.js";
import type { ApprovalStore } from "../auth/approval-store.js";
import type { AuditEventStore } from "../audit-event-store.js";
import type { ToolEventStore } from "../tool-event-store.js";

export class CodexTurnOrchestrator {
  constructor(
    private readonly deps: {
      logger: FastifyBaseLogger;
      approvals: ApprovalStore;
      auditEvents: AuditEventStore;
      toolEvents: ToolEventStore;
      artifacts: ArtifactStore;
      storage: ArtifactStorage;
      approvalTtlMs: number;
    },
    private readonly lifecycle: CodexSessionLifecycle,
    private readonly startRuntimeFn: (
      tenantId: string,
      sessionId: string,
      userId: string
    ) => Promise<RuntimeState>
  ) {}

  bindProcessHandlers(runtime: RuntimeState): void {
    runtime.process.onExit(async (code, signal) => {
      await this.lifecycle.finalizeRuntimeClosure(runtime, {
        reason: runtime.shutdownReason ?? "runtime_exit",
        message: `Runtime exited unexpectedly (${signal ?? code ?? "unknown"}).`,
        metadata: { exitCode: code, exitSignal: signal }
      });
    });

    runtime.process.onNotification((notification) => {
      this.deps.logger.info(
        {
          sessionId: runtime.sessionId,
          runtimeId: runtime.runtimeId,
          method: notification.method,
          params: notification.params
        },
        "Codex notification"
      );
      try {
        this.handleNotification(runtime, notification);
      } catch (err) {
        // A throw inside notification mapping/dispatch must NOT escape into the
        // process event emitter — the SSE consumer is blocked in `for await`
        // and would hang forever (pinning the active-turn slot) with no terminal
        // frame. Surface it as a turn failure so the consumer unblocks.
        this.deps.logger.error(
          { err, sessionId: runtime.sessionId, method: notification.method },
          "runtime notification handler threw"
        );
        this.failActiveTurn(runtime, getErrorMessage(err, "Runtime notification handler failed"));
      }
    });

    runtime.process.onRequest((request) => {
      void this.handleRequest(runtime, request).catch((err: unknown) => {
        this.deps.logger.error(
          { err, sessionId: runtime.sessionId, method: request.method, requestId: request.id },
          "runtime request handler failed"
        );
        // The request handler is how approvals (and other runtime-initiated
        // requests) are serviced; if it fails, a turn blocked awaiting that
        // response would hang. Fail the active turn so the consumer unblocks
        // instead of waiting on a response that will never come.
        this.failActiveTurn(runtime, getErrorMessage(err, "Runtime request handler failed"));
      });
    });

    runtime.process.onClose(() => {
      runtime.lifecycleMetadata = {
        ...runtime.lifecycleMetadata,
        websocketClosedAt: new Date().toISOString()
      };

      if (!runtime.shutdownReason) {
        runtime.shutdownReason = "socket_closed";
      }

      if (runtime.process.isAlive()) {
        runtime.process.terminate();
      }
    });
  }

  async startTurn(
    runtime: RuntimeState,
    prompt: string,
    userInputs?: import("../../runtime-contracts.js").RuntimeUserInput[]
  ): Promise<void> {
    const activeTurn = runtime.activeTurn;
    if (!activeTurn) return;

    try {
      await this.executeStartTurnRequest(runtime, activeTurn, prompt, userInputs);
    } catch (error) {
      if (!runtime.process.isAlive()) {
        this.deps.logger.warn(
          { sessionId: runtime.sessionId, runtimeId: runtime.runtimeId },
          "Runtime process died during startTurn — attempting restart"
        );
        try {
          const restarted = await this.lifecycle.ensureRuntime(
            runtime.tenantId,
            runtime.sessionId,
            runtime.userId,
            this.startRuntimeFn
          );
          restarted.activeTurn = activeTurn;
          runtime.activeTurn = null;

          await this.executeStartTurnRequest(restarted, activeTurn, prompt, userInputs);
          return;
        } catch (retryError) {
          this.deps.logger.error(
            { sessionId: runtime.sessionId, error: getErrorMessage(retryError, "unknown") },
            "Runtime restart-and-retry failed"
          );
          const ownerRuntime = this.lifecycle.runtimes.get(runtime.sessionId);
          if (ownerRuntime?.activeTurn === activeTurn) {
            this.failActiveTurn(ownerRuntime, getErrorMessage(retryError, "Turn start failed after runtime restart"));
            await this.lifecycle.persistRuntime(ownerRuntime, "error");
            this.lifecycle.scheduleIdleTeardown(ownerRuntime);
          } else {
            this.failActiveTurn(runtime, getErrorMessage(error, "Turn start failed"));
            await this.lifecycle.persistRuntime(runtime, "error");
            this.lifecycle.scheduleIdleTeardown(runtime);
          }
          return;
        }
      }
      this.failActiveTurn(runtime, getErrorMessage(error, "Turn start failed"));
      await this.lifecycle.persistRuntime(runtime, "error");
      this.lifecycle.scheduleIdleTeardown(runtime);
    }
  }

  private async executeStartTurnRequest(
    runtime: RuntimeState,
    activeTurn: ActiveTurnState,
    prompt: string,
    userInputs?: import("../../runtime-contracts.js").RuntimeUserInput[]
  ): Promise<void> {
    this.lifecycle.clearIdleTimer(runtime);
    this.lifecycle.touchRuntime(runtime, "turn_start_requested");
    await this.lifecycle.persistRuntime(runtime, "active");

    const responseId = await this.startTurnRequest(
      runtime,
      prompt,
      userInputs,
      activeTurn.model ?? undefined,
      activeTurn.effort ?? undefined
    );
    activeTurn.responseId = responseId;
    activeTurn.queue.push({ type: "response.created", responseId });
  }

  private async startTurnRequest(
    runtime: RuntimeState,
    prompt: string,
    userInputs?: import("../../runtime-contracts.js").RuntimeUserInput[],
    model?: string,
    effort?: import("../../runtime-contracts.js").RuntimeReasoningEffort
  ): Promise<string> {
    const { buildTurnInputs } = await import("./runtime-turn-inputs.js");
    const turnInputs = buildTurnInputs({
      prompt,
      userInputs,
      runtimePolicy: runtime.runtimePolicy,
      toolContextId: runtime.activeTurn?.toolContextId ?? null
    });

    const result = (await runtime.process.sendRequest("turn/start", {
      threadId: runtime.threadId,
      input: turnInputs,
      cwd: runtime.workspacePath,
      approvalPolicy: runtime.runtimePolicy.approvalPolicy,
      approvalsReviewer: runtime.runtimePolicy.approvalReviewer,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {})
    })) as { turn?: { id: string } };

    return result.turn?.id ?? uuidv7();
  }

  completeActiveTurn(runtime: RuntimeState): void {
    const activeTurn = runtime.activeTurn;
    if (!activeTurn) return;

    runtime.healthStatus = "healthy";
    if (!activeTurn.outputItemDone) {
      activeTurn.outputItemDone = true;
      activeTurn.queue.push({
        type: "response.output_item.done",
        responseId: activeTurn.responseId ?? uuidv7()
      });
    }

    const responseId = activeTurn.responseId ?? uuidv7();
    activeTurn.queue.push({ type: "response.completed", responseId });
    activeTurn.queue.end();
    runtime.activeTurn = null;

    void captureWorkspaceArtifacts({
      tenantId: runtime.tenantId,
      sessionId: runtime.sessionId,
      userId: runtime.userId,
      workspacePath: runtime.workspacePath,
      artifacts: this.deps.artifacts,
      storage: this.deps.storage,
      auditEvents: this.deps.auditEvents
    }).catch((err: unknown) => {
      this.deps.logger.error({ err, sessionId: runtime.sessionId }, "workspace artifact sweep failed");
    });
  }

  // Mark the active turn as interrupted by user action. Mirrors
  // `completeActiveTurn` (synthetic output_item.done if needed, then a terminal
  // response.completed with whatever token usage the runtime has reported so
  // far) but flags the terminal event as `interrupted: true` so the writer
  // persists partial assistant text under the `interrupted` status. The
  // runtime process is left alive — the user can immediately send a follow-up
  // in the same warm session.
  interruptActiveTurn(runtime: RuntimeState): void {
    const activeTurn = runtime.activeTurn;
    if (!activeTurn) return;

    runtime.healthStatus = "healthy";
    if (!activeTurn.outputItemDone) {
      activeTurn.outputItemDone = true;
      activeTurn.queue.push({
        type: "response.output_item.done",
        responseId: activeTurn.responseId ?? uuidv7()
      });
    }

    const responseId = activeTurn.responseId ?? uuidv7();
    activeTurn.queue.push({ type: "response.completed", responseId, interrupted: true });
    activeTurn.queue.end();
    runtime.activeTurn = null;
  }

  failActiveTurn(runtime: RuntimeState, message: string): void {
    const activeTurn = runtime.activeTurn;
    if (!activeTurn) return;

    runtime.healthStatus = "error";
    runtime.lifecycleMetadata = { ...runtime.lifecycleMetadata, lastError: message };
    // Normal path: deliver a terminal `response.failed` frame, then close the
    // queue so the consumer's `for await` returns cleanly. If pushing/closing
    // itself throws (an unexpected internal error), fall back to rejecting the
    // queue via setError so a consumer blocked in `next()` is still unblocked
    // rather than hung — never leave the turn slot pinned.
    try {
      activeTurn.queue.push({
        type: "response.failed",
        responseId: activeTurn.responseId ?? uuidv7(),
        message
      });
      activeTurn.queue.end();
    } catch (err) {
      this.deps.logger.error(
        { err, sessionId: runtime.sessionId },
        "failActiveTurn could not deliver terminal frame; rejecting queue"
      );
      activeTurn.queue.setError(err instanceof Error ? err : new Error(message));
    }
    runtime.activeTurn = null;
  }

  private handleNotification(runtime: RuntimeState, notification: JsonRpcNotification): void {
    const activeTurn = runtime.activeTurn;
    if (!activeTurn) return;

    const mapping = mapRuntimeNotification(activeTurn, notification);

    if (mapping.kind === "none") return;

    if (mapping.kind === "events") {
      for (const event of mapping.events) {
        activeTurn.queue.push(event);
      }
      if (mapping.events.some((event) => event.type === "response.output_item.done")) {
        activeTurn.outputItemDone = true;
      }
      return;
    }

    if (mapping.kind === "tool") {
      for (const event of mapping.events) {
        activeTurn.queue.push(event);
      }
      void this.recordToolEvent(runtime, mapping.toolCall, mapping.phase).catch((err: unknown) => {
        this.deps.logger.error(
          { err, sessionId: runtime.sessionId, itemId: mapping.toolCall.itemId },
          "tool event persistence failed"
        );
      });
      return;
    }

    if (mapping.kind === "runtime-error") {
      activeTurn.queue.push({
        type: "framework:runtime_notice",
        responseId: activeTurn.responseId ?? uuidv7(),
        noticeId: uuidv7(),
        level: mapping.retrying ? "warning" : "error",
        title: mapping.retrying ? "Runtime reconnecting" : "Runtime error",
        message: mapping.message,
        createdAt: new Date().toISOString()
      });

      if (!mapping.retrying) {
        this.failActiveTurn(runtime, mapping.message);
        void this.lifecycle.persistRuntime(runtime, "error").catch((err: unknown) => {
          this.deps.logger.error(
            { err, sessionId: runtime.sessionId },
            "persistRuntime failed (error path)"
          );
        });
        this.lifecycle.scheduleIdleTeardown(runtime);
      }
      return;
    }

    if (mapping.kind === "mcp-server-status") {
      activeTurn.queue.push({
        type: "framework:mcp_server_status",
        serverName: mapping.serverName,
        status: mapping.status,
        error: mapping.error
      });
      return;
    }

    if (mapping.completed) {
      this.completeActiveTurn(runtime);
    } else {
      this.failActiveTurn(runtime, mapping.failureMessage);
    }

    this.lifecycle.touchRuntime(runtime, mapping.completed ? "turn_completed" : "turn_failed");
    void this.lifecycle
      .persistRuntime(runtime, mapping.completed ? "active" : "error")
      .catch((err: unknown) => {
        this.deps.logger.error(
          { err, sessionId: runtime.sessionId },
          "persistRuntime failed (turn terminal)"
        );
      });
    this.lifecycle.scheduleIdleTeardown(runtime);
  }

  private async handleRequest(runtime: RuntimeState, request: JsonRpcRequest): Promise<void> {
    await handleRuntimeRequest({
      tenantId: runtime.tenantId,
      runtime,
      request,
      approvals: this.deps.approvals,
      auditEvents: this.deps.auditEvents,
      approvalTtlMs: this.deps.approvalTtlMs,
      logger: this.deps.logger
    });
  }

  private async recordToolEvent(
    runtime: RuntimeState,
    toolCall: RuntimeToolCall,
    phase: "started" | "completed" | "failed"
  ): Promise<void> {
    const approvalId = [...runtime.pendingApprovals.values()].find(
      (approval) => approval.itemId === toolCall.itemId
    )?.approvalId;

    await this.deps.toolEvents.create({
      tenantId: runtime.tenantId,
      sessionId: runtime.sessionId,
      userId: runtime.userId,
      messageId: runtime.activeTurn?.assistantMessageId ?? null,
      runtimeId: runtime.runtimeId,
      approvalId,
      toolCallId: toolCall.itemId,
      kind: toolCall.kind,
      title: toolCall.title,
      phase,
      status: toolCall.status,
      payload: redactSecrets({
        command: toolCall.command,
        cwd: toolCall.cwd,
        server: toolCall.server,
        toolName: toolCall.toolName,
        input: toolCall.input,
        output: toolCall.output,
        exitCode: toolCall.exitCode
      }),
      durationMs: toolCall.durationMs
    });
  }
}
