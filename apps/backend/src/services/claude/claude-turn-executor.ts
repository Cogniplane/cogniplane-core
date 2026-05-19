import type { FastifyBaseLogger } from "fastify";
import { uuidv7 } from "../../lib/uuid.js";

import { AsyncQueue } from "../../lib/async-queue.js";
import type {
  RuntimeApprovalKind,
  RuntimeEvent,
  RuntimeReasoningEffort,
  RuntimeSessionRef,
  RuntimeUserInput
} from "../../runtime-contracts.js";
import {
  createClaudeEventMapperState,
  mapClaudeEvent,
  type ClaudeMessageInput
} from "./claude-code-event-mapper.js";
import type { AppConfig } from "../../config.js";
import type { ManagedToolCatalog } from "../managed-tools/catalog.js";
import type { SandboxTurnFrame } from "../runtime/sandbox-agent-protocol.js";
import type { ClaudeSessionState } from "./claude-types.js";
import {
  buildClaudeContentBlocks,
  buildClaudePromptStream,
  buildClaudeSdkEnv,
  buildClaudeSdkOptions,
  isInitMessage
} from "./claude-sdk-helpers.js";
import type { ApprovalStore } from "../auth/approval-store.js";

type TurnInput = {
  prompt: string;
  userInputs?: RuntimeUserInput[];
  runtimePolicyId: string;
  toolContextId: string | null;
  assistantMessageId?: string | null;
  model?: string;
  effort?: RuntimeReasoningEffort;
  onBeforeTurn?: () => Promise<void>;
};

export type ClaudeTurnContext = {
  state: ClaudeSessionState;
  activeTurns: Set<string>;
  e2bPendingApprovals: Map<string, string>;
  stores: { approvals?: ApprovalStore } | undefined;
  config: Pick<AppConfig, "CLAUDE_CODE_MODEL">;
  log: FastifyBaseLogger;
  managedToolCatalog: ManagedToolCatalog;
};

export async function* executeClaudeTurn(
  session: RuntimeSessionRef,
  input: TurnInput,
  ctx: ClaudeTurnContext
): AsyncIterable<RuntimeEvent> {
  const { state, activeTurns, e2bPendingApprovals, stores, config, log } = ctx;

  if (input.onBeforeTurn) {
    await input.onBeforeTurn();
  }
  activeTurns.add(session.sessionId);
  const eventQueue = new AsyncQueue<RuntimeEvent>();
  const responseId = input.assistantMessageId ?? uuidv7();
  const mapperState = createClaudeEventMapperState(responseId);

  const dispatchApprovalEvent = async (event: {
    approvalId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    kind: RuntimeApprovalKind;
  }) => {
    if (stores?.approvals) {
      try {
        await stores.approvals.create({
          tenantId: state.tenantId,
          approvalId: event.approvalId,
          sessionId: state.sessionId,
          userId: state.userId,
          runtimeId: state.runtimeId,
          turnId: responseId,
          itemId: event.approvalId,
          requestMethod: `claude/${event.toolName}`,
          requestId: event.approvalId,
          kind: event.kind,
          title: `Approve ${event.toolName}`,
          summary: JSON.stringify(event.toolInput),
          status: "pending",
          decision: null,
          requestPayload: event.toolInput
        });
      } catch (err) {
        log.warn({ err, approvalId: event.approvalId }, "Failed to persist Claude approval to store");
      }
    }
    eventQueue.push({
      type: "framework:approval_required",
      responseId,
      approvalId: event.approvalId,
      itemId: event.approvalId,
      kind: event.kind,
      title: `Approve ${event.toolName}`,
      summary: JSON.stringify(event.toolInput),
      availableDecisions: ["approve", "reject"],
      command: event.toolName,
      cwd: state.workspacePath
    });
  };

  // Local-mode approval routing must be wired before the background task
  // starts — onApprovalRequired fires synchronously inside canUseTool.
  if (state.mode === "local") {
    state.approvalHandler.clearAutoApprovedKindsForTurn();
    state.approvalHandler.onApprovalRequired(dispatchApprovalEvent);
    state.approvalHandler.setToolContextId(input.toolContextId ?? null);
  }

  const runTask = (async () => {
    try {
      if (state.mode === "e2b" && state.e2bProcess) {
        await runE2bTurn({
          state,
          eventQueue,
          responseId,
          mapperState,
          turnId: responseId,
          turn: input,
          dispatchApprovalEvent,
          e2bPendingApprovals,
          config,
          log,
          session,
          managedToolCatalog: ctx.managedToolCatalog
        });
      } else {
        await runLocalTurn({
          state,
          eventQueue,
          responseId,
          mapperState,
          turn: input,
          config,
          log,
          session
        });
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const aborted = state.abortController.signal.aborted;
      if (aborted) {
        log.info({ sessionId: session.sessionId }, "Claude session aborted");
      } else {
        log.error({ err, sessionId: session.sessionId, mode: state.mode }, "Claude turn failed");
      }
      eventQueue.push({
        type: "response.failed",
        responseId,
        message: aborted ? "Session aborted" : errorMessage
      });
    } finally {
      activeTurns.delete(session.sessionId);
      // Clear the interrupt hook so a delayed Stop click after the turn ended
      // can't reach into the next turn's iterator. The runtime adapter checks
      // activeTurns first, but this is the per-state defense in depth.
      state.activeTurnInterrupt.current = null;
      eventQueue.end();
    }
  })();

  yield* eventQueue;
  await runTask;
}

async function runLocalTurn(ctx: {
  state: ClaudeSessionState;
  eventQueue: AsyncQueue<RuntimeEvent>;
  responseId: string;
  mapperState: ReturnType<typeof createClaudeEventMapperState>;
  turn: TurnInput;
  config: Pick<AppConfig, "CLAUDE_CODE_MODEL">;
  log: FastifyBaseLogger;
  session: RuntimeSessionRef;
}): Promise<void> {
  const { state, eventQueue, responseId, mapperState, turn, config, log, session } = ctx;
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const { runtimePolicy } = state.configBundle;

  // approvalPolicy "never" means auto-allow all, but we still route every call
  // through canUseTool so toolContextId can be injected into MCP requests.
  state.approvalHandler.setBypass(runtimePolicy.approvalPolicy === "never");

  const env = buildClaudeSdkEnv(state.anthropicApiKey, {
    runtimeToken: state.runtimeToken,
    baseUrl: state.proxyBaseUrl
  });
  const mcpServersConfig: Record<
    string,
    { type: "http"; url: string; headers: Record<string, string> }
  > = {};
  for (const server of state.mcpServerEntries) {
    mcpServersConfig[server.id] = {
      type: "http",
      url: server.url,
      headers: { Authorization: `Bearer ${state.runtimeToken}` }
    };
  }

  const model = turn.model ?? config.CLAUDE_CODE_MODEL;
  const hasEffort = Boolean(turn.effort);

  // Wire the per-turn canUseTool handler into the delegating ref so the
  // pre-warmed subprocess (if any) routes tool calls correctly.
  state.warmCanUseToolRef.current = (toolName, toolInput, toolOpts) =>
    state.approvalHandler.canUseTool(toolName, toolInput, toolOpts);

  // Consume the pre-warmed subprocess on the first turn when it matches.
  const warmResult = state.warmState ? await state.warmState : null;
  state.warmState = null;

  const useWarm =
    warmResult !== null &&
    !state.claudeSessionId && // only first turn — warm subprocess has no session to resume
    model === warmResult.model &&
    !hasEffort; // effort changes the subprocess config; fall back if specified

  if (!useWarm && warmResult) {
    warmResult.query.close();
  }

  const options = buildClaudeSdkOptions({
    model,
    effort: turn.effort,
    developerInstructions: runtimePolicy.developerInstructions,
    mcpServersConfig,
    workspacePath: state.workspacePath,
    env,
    // allowedTools is intentionally NOT set: it's an auto-approve allowlist in
    // the SDK, not an availability filter. All tool calls must land in canUseTool
    // so toolContextId can be injected before the MCP gateway sees them.
    canUseTool: (toolName, toolInput, toolOpts) =>
      state.approvalHandler.canUseTool(toolName, toolInput, toolOpts)
  });

  const promptStream = buildClaudePromptStream({
    prompt: turn.prompt,
    userInputs: turn.userInputs,
    runtimePolicy,
    toolContextId: turn.toolContextId,
    // Prefer the provider-native session id when available; fall back to our
    // internal id for the first turn. The SDK uses this to resume conversation memory.
    sessionId: state.claudeSessionId ?? session.sessionId
  });

  // `resume` and `continue` are mutually exclusive in the SDK — always use
  // the explicit session id when we have one; `continue: true` picks up
  // whatever was last used in cwd, which isn't meaningful here.
  const iterator = useWarm
    ? warmResult!.query.query(promptStream)
    : sdk.query({
        prompt: promptStream,
        options: state.claudeSessionId ? { ...options, resume: state.claudeSessionId } : options
      });

  // Expose the SDK iterator's interrupt() so the runtime adapter's interruptTurn
  // (Stop button) can short-circuit the in-flight model call without tearing
  // down the warm session. Cleared in the surrounding finally so a stale ref
  // can't fire on a later turn.
  state.activeTurnInterrupt.current = () => iterator.interrupt();

  void iterator.mcpServerStatus
    ?.()
    .then((mcpStatus) => {
      log.info(
        {
          sessionId: session.sessionId,
          runtimeId: state.runtimeId,
          expectedMcpServerIds: Object.keys(mcpServersConfig),
          mcpServerStatus: mcpStatus
        },
        "Claude SDK mcpServerStatus"
      );
    })
    .catch((err) => {
      log.warn({ err, sessionId: session.sessionId }, "Claude SDK mcpServerStatus failed");
    });

  // Terminal events are deferred until the iterator finishes without throwing —
  // an SDK throw always takes precedence over a prior success event.
  let deferredTerminal: RuntimeEvent | null = null;

  for await (const message of iterator) {
    if (isInitMessage(message)) {
      log.info(
        {
          sessionId: session.sessionId,
          runtimeId: state.runtimeId,
          model: message.model,
          permissionMode: message.permissionMode,
          toolCount: message.tools.length,
          tools: message.tools,
          mcpToolNames: message.tools.filter((name) => name.startsWith("mcp__")),
          mcpServers: message.mcp_servers,
          slashCommands: message.slash_commands,
          skills: message.skills,
          cwd: message.cwd,
          claudeCodeVersion: message.claude_code_version
        },
        "Claude SDK system/init tool surface"
      );
    }

    const events = mapClaudeEvent(mapperState, message as ClaudeMessageInput);
    for (const evt of events) {
      if (evt.type === "response.completed" || evt.type === "response.failed") {
        deferredTerminal = evt;
      } else {
        eventQueue.push(evt);
      }
    }

    if (message.session_id && !state.claudeSessionId) {
      state.claudeSessionId = message.session_id;
    }
  }

  eventQueue.push(deferredTerminal ?? { type: "response.completed", responseId });
}

async function runE2bTurn(ctx: {
  state: ClaudeSessionState;
  eventQueue: AsyncQueue<RuntimeEvent>;
  responseId: string;
  mapperState: ReturnType<typeof createClaudeEventMapperState>;
  turnId: string;
  turn: TurnInput;
  dispatchApprovalEvent: (event: {
    approvalId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    kind: RuntimeApprovalKind;
  }) => Promise<void>;
  e2bPendingApprovals: Map<string, string>;
  config: Pick<AppConfig, "CLAUDE_CODE_MODEL">;
  log: FastifyBaseLogger;
  session: RuntimeSessionRef;
  managedToolCatalog: ManagedToolCatalog;
}): Promise<void> {
  const { state, eventQueue, responseId, mapperState, turnId, turn, e2bPendingApprovals, config, log } =
    ctx;
  if (!state.e2bProcess) {
    throw new Error("runE2bTurn called without an active E2B process.");
  }
  const { runtimePolicy } = state.configBundle;

  const contentBlocks = await buildClaudeContentBlocks({
    prompt: turn.prompt,
    userInputs: turn.userInputs,
    runtimePolicy,
    toolContextId: turn.toolContextId
  });

  const turnFrame: SandboxTurnFrame = {
    type: "turn",
    turnId,
    prompt: turn.prompt,
    contentBlocks,
    toolContextId: turn.toolContextId ?? null,
    resumeSessionId: state.claudeSessionId,
    model: turn.model ?? config.CLAUDE_CODE_MODEL,
    effort: turn.effort ?? null,
    developerInstructions: runtimePolicy.developerInstructions,
    mcpServers: state.mcpServerEntries.map((e) => ({
      id: e.id,
      url: e.url,
      authorization: `Bearer ${state.runtimeToken}`
    })),
    enabledToolIds: runtimePolicy.enabledToolIds,
    bypass: runtimePolicy.approvalPolicy === "never",
    autoApproveReadOnly: runtimePolicy.autoApproveReadOnlyTools,
    readOnlyManagedToolNames: ctx.managedToolCatalog.listReadOnlyIds()
  };

  // Terminal events are deferred until onComplete fires — same reasoning as
  // the local path: an SDK throw must take precedence over a success event.
  let deferredTerminal: RuntimeEvent | null = null;

  // Stop button: route to the in-sandbox harness which calls iterator.interrupt()
  // inside the SDK. The harness then emits a result(subtype="interrupt"); the
  // shared mapClaudeEvent path translates it into response.completed{interrupted}.
  state.activeTurnInterrupt.current = async () => {
    if (state.e2bProcess) {
      await state.e2bProcess.interruptCurrentTurn(turnId);
    }
  };

  await state.e2bProcess.runTurn(turnFrame, {
    onSdkMessage: (payload) => {
      if (isInitMessage(payload)) {
        log.info(
          {
            sessionId: state.sessionId,
            runtimeId: state.runtimeId,
            source: "e2b",
            model: payload.model,
            permissionMode: payload.permissionMode,
            toolCount: payload.tools.length,
            mcpToolNames: payload.tools.filter((name) => name.startsWith("mcp__")),
            mcpServers: payload.mcp_servers,
            cwd: payload.cwd,
            claudeCodeVersion: payload.claude_code_version
          },
          "Claude SDK system/init tool surface (E2B)"
        );
      }

      const events = mapClaudeEvent(mapperState, payload as ClaudeMessageInput);
      for (const evt of events) {
        if (evt.type === "response.completed" || evt.type === "response.failed") {
          deferredTerminal = evt;
        } else {
          eventQueue.push(evt);
        }
      }

      const sid = (payload as { session_id?: string }).session_id;
      if (sid && !state.claudeSessionId) {
        state.claudeSessionId = sid;
      }
    },
    onApprovalRequest: (frame) => {
      e2bPendingApprovals.set(frame.approvalId, state.sessionId);
      void ctx.dispatchApprovalEvent({
        approvalId: frame.approvalId,
        toolName: frame.toolName,
        toolInput: frame.toolInput,
        kind: frame.kind
      }).catch((err) => {
        log.warn({ err, approvalId: frame.approvalId }, "Failed to dispatch E2B approval event");
      });
    },
    onComplete: () => {
      eventQueue.push(deferredTerminal ?? { type: "response.completed", responseId });
    },
    onFail: (error) => {
      eventQueue.push({ type: "response.failed", responseId, message: error });
    }
  });
}
