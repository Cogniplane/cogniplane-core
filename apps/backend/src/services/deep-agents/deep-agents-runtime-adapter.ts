// Sole runtime provider (bead im5e.1, then quap.4): the agent loop runs IN
// the Fastify backend via deepagentsjs instead of inside an E2B sandbox
// harness. This adapter drives the loop and exposes two turn shapes off the
// same graph run: the legacy RuntimeEvent stream (runMessage, consumed by
// sse-stream-writer / scheduler-worker) and the native AG-UI stream
// (runMessageAGUI, consumed by sse-stream-writer-agui). The strategic
// direction is convergence toward the AG-UI wire; the RuntimeEvent shape
// remains for the paths not yet migrated.

import path from "node:path";

import type { FastifyBaseLogger } from "fastify";

import { uuidv7 } from "../../lib/uuid.js";
import { AsyncQueue } from "../../lib/async-queue.js";
import {
  SessionBusyError,
  type PolicyApprovalDisposition,
  type PolicyApprovalRouteInput,
  type RuntimeAdapter,
  type RuntimeApprovalDecision,
  type RuntimeApprovalKind,
  type RuntimeEvent,
  type RuntimeReasoningEffort,
  type RuntimeSessionRef,
  type RuntimeUserInput
} from "../../runtime-contracts.js";
import type { ModelProvider } from "@cogniplane/shared-types";
import { MODEL_PROVIDERS } from "@cogniplane/shared-types";

import { AVAILABLE_MODELS } from "../../domain/models.js";
import type { RuntimeManifest } from "../../domain/runtime-manifest.js";
import type { AppConfig } from "../../config.js";
import type { ProviderCredentials } from "../runtime/provider-credentials.js";
import type { ApprovalStore } from "../auth/approval-store.js";
import type { AuditEventStore } from "../audit-event-store.js";
import type { DynamicConfigService } from "../dynamic-config-service.js";
import type { MemoryStore } from "../memory-store.js";
import type { MessageStore, TokenUsageRecord } from "../message-store.js";
import { calculateCostUsd } from "../token-cost-calculator.js";
import type { PolicyService } from "../policy/policy-service.js";
import type { RuntimeSessionStore } from "../runtime/runtime-session-store.js";
import { generateRuntimeToken, runtimeTokenExpiry } from "../auth/runtime-token.js";
import type { ManagedToolCatalog } from "../managed-tools/catalog.js";
import { redactSecrets } from "../redact-secrets.js";
import { cancelPendingApprovals, expireApprovalById } from "../runtime/approval-cleanup.js";
import {
  clearIdleTimer,
  scheduleIdleTeardown
} from "../runtime/idle-teardown.js";
import type { PolicyApprovalCoordinator } from "../runtime/policy-approval-coordinator.js";
import { createRuntimePolicyApprovals } from "../runtime/policy-approval-factory.js";
import { createStageTimer } from "../runtime/startup-timing.js";
import {
  buildMemorySectionLines,
  loadWorkspaceMemories
} from "../memory-workspace-section.js";
import type { SkillBundleStorage } from "../skills/skill-bundle-storage.js";
import { EventType, type BaseEvent } from "@ag-ui/client";

import {
  createDeepAgentsEventMapperState,
  mapDeepAgentsEvent
} from "./deep-agents-event-mapper.js";
import { DeepAgentsAGUIAgent } from "./deep-agents-agui-agent.js";
import { createSessionAGUITurnBackend, type AGUITurnBackend } from "./deep-agents-agui-backend.js";
import {
  AGUI_INTERRUPTED_RESULT,
  createRuntimeToAGUIState,
  runtimeEventToAGUI
} from "./runtime-event-to-agui.js";
import { createDeepAgentsSessionRuntime, resolveModelConstruction } from "./deep-agents-graph.js";
import { buildSkillsLibraryFiles } from "./deep-agents-skills-library.js";
import type {
  DeepAgentsCheckpointSaver,
  DeepAgentsPendingAction,
  DeepAgentsRuntimeFactory,
  DeepAgentsSessionState
} from "./deep-agents-types.js";
import { E2B_WORKSPACE_BASE } from "../runtime/e2b-sandbox.js";

const PROVIDER_ID = "deep-agents";

/**
 * A native HITL approval awaiting a human decision. The interrupt itself is
 * checkpointed inside LangGraph; this entry only bridges the decision route
 * to the in-process turn loop that will resume the graph.
 */
type PendingDeepAgentsApproval = {
  sessionId: string;
  kind: RuntimeApprovalKind;
  /**
   * The "remember for this turn" key for this action. Equals `kind` except for
   * MCP tools, where it is scoped to the tool name so remembering one MCP tool
   * does not auto-approve every other MCP tool this turn (see
   * autoApprovedKindsForTurn / rememberKeyFor).
   */
  rememberKey: string;
  /** Settles the turn loop's decision promise. Idempotent. */
  settle: (decision: RuntimeApprovalDecision) => void;
  /** The originating turn's remember-set instance (see autoApprovedKindsForTurn). */
  autoApprovedKinds: Set<string>;
};

export class DeepAgentsRuntimeAdapter implements RuntimeAdapter {
  readonly id = PROVIDER_ID;

  private readonly sessions = new Map<string, DeepAgentsSessionState>();
  private readonly activeTurns = new Set<string>();
  private readonly pendingApprovals = new Map<string, PendingDeepAgentsApproval>();
  /**
   * In-flight createSession promises, keyed by sessionId. createSession awaits
   * several times (config compile, credential probe, memory/skills load) before
   * it registers the new state, so two concurrent calls for the same session
   * would each build a runtime and the loser would silently overwrite the
   * winner un-disposed with its idle timer armed. Memoizing the in-flight
   * promise collapses concurrent calls onto one build.
   */
  private readonly pendingSessionCreations = new Map<string, Promise<RuntimeSessionRef>>();
  private readonly policyApprovals: PolicyApprovalCoordinator;

  constructor(
    private readonly config: AppConfig,
    private readonly dynamicConfig: DynamicConfigService,
    private readonly log: FastifyBaseLogger,
    private readonly stores: {
      approvals: ApprovalStore;
      auditEvents: AuditEventStore;
      runtimeSessions?: RuntimeSessionStore;
      memories?: MemoryStore;
      policyService?: Pick<PolicyService, "evaluate">;
      /**
       * Shared durable checkpointer (PostgresSaver). The adapter owns its
       * lifecycle: threads it into every session runtime, deletes threads on
       * session deletion (purgeSessionData), and ends the pool on close().
       * Optional so unit tests fall back to in-memory checkpointing.
       */
      checkpointer?: DeepAgentsCheckpointSaver;
      /**
       * Token-usage + cost persistence onto the assistant message. The
       * in-process loop captures usage_metadata from the model stream and
       * writes through the same store
       * methods. Optional so unit tests can opt out.
       */
      messages?: Pick<MessageStore, "addTokenUsage" | "setCostUsd">;
      /**
       * Skill bundle storage for materializing companion files into the
       * /skills/ library at session start. Optional: without it, bundle-backed
       * skills degrade to SKILL.md-only (unit tests, minimal wiring).
       */
      skillBundles?: Pick<SkillBundleStorage, "materializeBundle">;
    },
    private readonly providerCredentials?: ProviderCredentials,
    private readonly runtimeFactory: DeepAgentsRuntimeFactory = createDeepAgentsSessionRuntime,
    /** Read-only tool classification for autoApproveReadOnlyTools. Optional in unit tests. */
    private readonly managedToolCatalog?: Pick<ManagedToolCatalog, "listReadOnlyIds">
  ) {
    this.policyApprovals = createRuntimePolicyApprovals({
      config,
      approvals: stores.approvals,
      auditEvents: stores.auditEvents,
      logger: log,
      pushFrameworkEvent: (sessionId, event) => {
        const push = this.sessions.get(sessionId)?.activeTurnPush.current;
        if (!push) return false;
        push(event);
        return true;
      }
    });
  }

  hasActiveTurn(sessionId: string): boolean {
    return this.activeTurns.has(sessionId);
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  hasRuntime(sessionId: string, runtimeId: string): boolean {
    const state = this.sessions.get(sessionId);
    return Boolean(state && state.runtimeId === runtimeId && !state.abortController.signal.aborted);
  }

  async createSession(input: {
    tenantId: string;
    sessionId: string;
    userId: string;
  }): Promise<RuntimeSessionRef> {
    const { sessionId } = input;

    // Idempotency: reuse a live session so conversation state (the session
    // runtime's checkpointer thread) carries across turns.
    const existing = this.sessions.get(sessionId);
    if (existing && !existing.abortController.signal.aborted) {
      return {
        sessionId,
        runtimeId: existing.runtimeId,
        runtimePolicy: existing.configBundle.runtimePolicy
      };
    }

    // Collapse concurrent creations for the same session onto one build (see
    // pendingSessionCreations) — the whole build below runs past several awaits
    // before it registers the state, so without this two callers would each
    // create a runtime.
    const inFlight = this.pendingSessionCreations.get(sessionId);
    if (inFlight) return inFlight;

    const creation = this.buildSession(input).finally(() => {
      this.pendingSessionCreations.delete(sessionId);
    });
    this.pendingSessionCreations.set(sessionId, creation);
    return creation;
  }

  private async buildSession(input: {
    tenantId: string;
    sessionId: string;
    userId: string;
  }): Promise<RuntimeSessionRef> {
    const { tenantId, sessionId, userId } = input;
    const runtimeId = `deepagents-${uuidv7()}`;
    const startupTimer = createStageTimer();

    const configBundle = await startupTimer.time("compileConfigMs", () =>
      this.dynamicConfig.compileRuntimeConfig(tenantId, true, sessionId)
    );
    const { runtimePolicy } = configBundle;

    // Provider credentials are resolved LAZILY per turn (the model — hence the
    // provider — is only known at getAgentForModel time). Build a tenant-scoped
    // resolver the factory calls then. Guard here that AT LEAST ONE provider is
    // configured so a zero-key tenant fails fast at session creation with the
    // same UX as before (rather than only failing on the first turn).
    const credentials = this.providerCredentials;
    const configuredProviders = credentials
      ? await Promise.all(
          MODEL_PROVIDERS.map(async (provider) =>
            (await credentials.hasKey(tenantId, provider)) ? provider : null
          )
        ).then((list) => list.filter((p): p is ModelProvider => p !== null))
      : [];
    if (credentials && configuredProviders.length === 0) {
      // 400 (statusCode) so clientSafeTurnFailureMessage passes this through as
      // user-actionable ("configure a key") instead of collapsing it to the
      // generic internal-failure message this guard exists to avoid.
      throw Object.assign(
        new Error(
          "Deep Agents runtime requires at least one model-provider API key " +
            "(configure a provider key in organization settings or set a platform-level key)."
        ),
        { statusCode: 400 }
      );
    }
    const resolveProviderKey = (provider: ModelProvider): Promise<string | null> =>
      credentials ? credentials.resolveKey(tenantId, provider) : Promise.resolve(null);

    const runtimeToken = generateRuntimeToken(
      {
        sid: sessionId,
        tid: tenantId,
        uid: userId,
        rid: runtimeId,
        exp: runtimeTokenExpiry(this.config.RUNTIME_TOKEN_TTL_MS)
      },
      this.config.DATA_ENCRYPTION_SECRET
    );

    // Phase 1 parity: recent long-term memories are injected into the system
    // prompt at session start, gated on memory_search enablement and (in
    // enforce mode) a side-effect-free Policy Center evaluation — the same
    // guard the other adapters apply so prompt injection can't bypass policy.
    const memories = await startupTimer.time("memoryLoadMs", () =>
      loadWorkspaceMemories(
        this.stores.memories,
        {
          tenantId,
          userId,
          enabledToolIds: runtimePolicy.enabledToolIds,
          readPolicy: this.stores.policyService
            ? {
                policy: this.stores.policyService,
                enforcementMode: runtimePolicy.policyEnforcementMode
              }
            : undefined
        },
        this.log
      )
    );
    const memoryLines = buildMemorySectionLines(memories, runtimePolicy.enabledToolIds);
    // Enabled skills (bead kpit): served as a read-only /skills/ file library
    // through the native deepagents skills middleware (progressive
    // disclosure) instead of the retired "## Skill:" system-prompt inlining.
    // Bundle companion files are materialized into the library; a bundle
    // failure degrades that skill to SKILL.md-only. Note: the middleware
    // checkpoints the skill LISTING into thread state, so an existing
    // session's prompt listing only refreshes on a new thread — the file
    // contents themselves are always served fresh from this build.
    const skillsLibraryFiles = await startupTimer.time("skillsBuildMs", () =>
      buildSkillsLibraryFiles({
        skills: configBundle.skills,
        bundles: this.stores.skillBundles ?? null,
        logger: this.log
      })
    );
    const systemPromptParts = [
      runtimePolicy.developerInstructions?.trim() || null,
      memoryLines.length > 0 ? memoryLines.join("\n") : null
    ].filter((part): part is string => Boolean(part));
    const systemPrompt = systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : null;

    // Per-session workspace layout (unchanged from the retired runtimes).
    // Files only materialize when the lazy sandbox is first touched.
    const workspacePath = path.posix.join(E2B_WORKSPACE_BASE, sessionId);
    // MCP gateway servers (compiled to the enabled set) with the session's
    // Bearer rt_* token — header auth only, never `?token=`. The token is
    // session-scoped; only toolContextId rotates per turn (via the ref).
    const gatewayBase = this.config.RUNTIME_GATEWAY_BASE_URL.replace(/\/$/, "");
    const mcpServers = configBundle.mcpServers.map((server) => ({
      id: server.id,
      url: new URL(server.routePath, gatewayBase + "/").toString(),
      authorization: `Bearer ${runtimeToken}`
    }));
    const toolContextRef: { current: string | null } = { current: null };
    const runtime = this.runtimeFactory({
      tenantId,
      sessionId,
      userId,
      runtimeId,
      // Deferred, provider-aware key resolution. The in-process loop calls
      // each provider's API directly with the real key; usage/cost is captured
      // in-process — see the usage accumulation in runTurn.
      resolveProviderKey,
      providerBaseUrls: null,
      systemPrompt,
      skillsLibraryFiles,
      workspacePath,
      mcpServers,
      toolContextRef,
      approvals: {
        // approvalPolicy "never" bypasses native approvals entirely — same
        // meaning as the Claude turn frame's `bypass`.
        gate: runtimePolicy.approvalPolicy !== "never",
        autoApproveReadOnly: runtimePolicy.autoApproveReadOnlyTools,
        readOnlyToolNames: this.managedToolCatalog?.listReadOnlyIds() ?? []
      },
      // `allowCommandExecution` is owner-controlled security posture: when
      // false, NO sandbox is attached at all — deepagents then never exposes
      // the `execute` tool (its fs middleware only does so for sandbox
      // backends) and file tools fall back to the checkpointed StateBackend.
      // Artifact byte-sync degrades to the turn-input builder's inline
      // excerpts, which is exactly the "no shell" contract. Gating via
      // interruptOn alone would NOT be enough: approvalPolicy "never" would
      // silently re-enable ungated shell.
      e2b:
        this.config.E2B_API_KEY && runtimePolicy.allowCommandExecution
          ? {
              apiKey: this.config.E2B_API_KEY,
              templateId: this.config.E2B_TEMPLATE_ID,
              sandboxTimeoutMs: this.config.E2B_SANDBOX_TIMEOUT_MS,
              executeTimeoutMs: this.config.DEEP_AGENTS_EXECUTE_TIMEOUT_MS
            }
          : null,
      checkpointer: this.stores.checkpointer,
      logger: this.log
    });

    const state: DeepAgentsSessionState = {
      sessionId,
      tenantId,
      userId,
      runtimeId,
      lastActiveAt: new Date().toISOString(),
      configBundle,
      abortController: new AbortController(),
      threadId: sessionId,
      runtime,
      idleTimer: null,
      activeTurnInterrupt: { current: null },
      activeTurnPush: { current: null },
      activeTurnWatchdog: { current: null },
      toolContextRef,
      autoApprovedKindsForTurn: new Set()
    };
    this.sessions.set(sessionId, state);

    if (this.stores.runtimeSessions) {
      const now = new Date().toISOString();
      try {
        await this.stores.runtimeSessions.upsert({
          tenantId,
          sessionId,
          userId,
          runtimeId,
          runtimeProvider: PROVIDER_ID,
          workspacePath,
          runtimeVersion: "deepagentsjs",
          runtimeSchemaVersion: "1",
          manifestPath: "",
          manifestMetadata: buildDeepAgentsRuntimeManifest(configBundle, sessionId, userId),
          healthStatus: "healthy",
          lastActiveAt: now,
          startedAt: now,
          terminatedAt: null,
          lifecycleMetadata: { provider: PROVIDER_ID, mode: "in-process" },
          status: "active"
        });
      } catch (err) {
        this.log.warn({ err, sessionId }, "Failed to persist Deep Agents runtime session");
      }
    }

    // Extraction target for scripts/analyze-startup-latency.mjs — records how
    // cheap in-process session startup is (no sandbox stages here; the sandbox
    // is created lazily on first tool use).
    this.log.info(
      {
        sessionId,
        runtimeId,
        provider: PROVIDER_ID,
        ...startupTimer.timings,
        totalMs: startupTimer.totalMs()
      },
      "session_startup_timing"
    );

    this.scheduleIdleTeardown(state);

    return {
      sessionId,
      runtimeId,
      runtimePolicy: configBundle.runtimePolicy
    };
  }

  async *runMessage(
    session: RuntimeSessionRef,
    input: {
      prompt: string;
      userInputs?: RuntimeUserInput[];
      runtimePolicyId: string;
      toolContextId: string | null;
      assistantMessageId?: string | null;
      model?: string;
      effort?: RuntimeReasoningEffort;
      onBeforeTurn?: () => Promise<void>;
    }
  ): AsyncIterable<RuntimeEvent> {
    const state = this.sessions.get(session.sessionId);
    if (!state) {
      throw new Error(`No Deep Agents session found for ${session.sessionId}`);
    }

    // Reserve the turn slot synchronously (no await between check and add) so
    // a concurrent runMessage can't slip past during onBeforeTurn.
    if (this.activeTurns.has(session.sessionId)) {
      throw new SessionBusyError(session.sessionId);
    }
    this.activeTurns.add(session.sessionId);
    state.lastActiveAt = new Date().toISOString();
    this.clearIdleTimer(state);

    if (input.onBeforeTurn) {
      try {
        await input.onBeforeTurn();
      } catch (error) {
        this.activeTurns.delete(session.sessionId);
        this.scheduleIdleTeardown(state);
        throw error;
      }
    }

    const responseId = input.assistantMessageId ?? uuidv7();
    const eventQueue = new AsyncQueue<RuntimeEvent>();
    state.activeTurnPush.current = (event) => eventQueue.push(event);

    const runTask = this.runTurn(state, eventQueue, responseId, input).finally(() => {
      this.activeTurns.delete(session.sessionId);
      state.activeTurnInterrupt.current = null;
      state.activeTurnPush.current = null;
      this.scheduleIdleTeardown(state);
      eventQueue.end();
    });

    yield* eventQueue;
    await runTask;
  }

  /**
   * Track B spike (boundary b): drive one turn through `DeepAgentsAGUIAgent`
   * and yield AG-UI `BaseEvent`s instead of `RuntimeEvent`s. Reuses the same
   * session runtime, tenant scope, toolContextId ref, and native-approval plane
   * as {@link runMessage} — only the emitted vocabulary differs. The driver
   * owns the streamEvents + interrupt/resume loop; this method owns the turn
   * slot, abort/interrupt wiring, and the `awaitDecisions` bridge into the
   * shared approval plane (`collectApprovalDecisions`, re-emitted through the
   * translator so the AG-UI approval prompt carries the real `approvalId`).
   *
   * Token usage + cumulative cost ARE persisted (see the streamTurn wrapper +
   * persistTurnUsage in the finally), keyed on the writer-supplied
   * assistantMessageId. The RUNTIME_TURN_TIMEOUT_MS watchdog is armed here too
   * (disarmed while an approval prompt is pending), so a wedged turn releases
   * the session slot instead of pinning it — parity with `runTurn`.
   */
  async *runMessageAGUI(
    session: RuntimeSessionRef,
    input: {
      prompt: string;
      userInputs?: RuntimeUserInput[];
      toolContextId: string | null;
      assistantMessageId?: string | null;
      model?: string;
      effort?: RuntimeReasoningEffort;
      onBeforeTurn?: () => Promise<void>;
    }
  ): AsyncIterable<BaseEvent> {
    const state = this.sessions.get(session.sessionId);
    if (!state) {
      throw new Error(`No Deep Agents session found for ${session.sessionId}`);
    }
    if (this.activeTurns.has(session.sessionId)) {
      throw new SessionBusyError(session.sessionId);
    }
    this.activeTurns.add(session.sessionId);
    state.lastActiveAt = new Date().toISOString();
    this.clearIdleTimer(state);

    // Artifact workspace sync + turn-input building runs here (after the slot is
    // reserved, so the sandbox is alive), mirroring runMessage's onBeforeTurn.
    if (input.onBeforeTurn) {
      try {
        await input.onBeforeTurn();
      } catch (error) {
        this.activeTurns.delete(session.sessionId);
        this.scheduleIdleTeardown(state);
        throw error;
      }
    }

    // Artifact-scoped turns arrive with `userInputs` REPLACING the raw prompt
    // (the artifact-context block embeds the prompt at its end); mirror runTurn.
    const textInputs = (input.userInputs ?? []).filter(
      (entry): entry is Extract<RuntimeUserInput, { type: "text" }> => entry.type === "text"
    );
    const promptText =
      textInputs.length > 0 ? textInputs.map((entry) => entry.text).join("\n\n") : input.prompt;

    const responseId = input.assistantMessageId ?? uuidv7();
    const queue = new AsyncQueue<BaseEvent>();
    // One translator state shared by the approval bridge and the Policy Center
    // push hook — both only carry approval/notice events (no open text/reasoning
    // messages), so they never contend over message ids.
    const auxState = createRuntimeToAGUIState();

    const turnAbort = new AbortController();
    const onSessionAbort = () => turnAbort.abort();
    state.abortController.signal.addEventListener("abort", onSessionAbort, { once: true });
    // Stop button / client disconnect aborts THIS turn (interruptTurn reads this).
    state.activeTurnInterrupt.current = async () => {
      turnAbort.abort();
    };

    const { arm: armWatchdog, disarm: disarmWatchdog, timedOut } = this.createTurnWatchdog(
      state,
      turnAbort
    );
    // Policy Center gateway approvals push RuntimeEvents onto the active turn;
    // translate them so they surface in the AG-UI stream too.
    state.activeTurnPush.current = (event) => {
      for (const ev of runtimeEventToAGUI(auxState, event)) queue.push(ev);
    };

    state.toolContextRef.current = input.toolContextId ?? null;
    state.autoApprovedKindsForTurn = new Set();

    // Images (e.g. rendered PDF pages from buildArtifactTurnInputs) are dropped —
    // only text inputs feed promptText above. Surface the same notice runTurn
    // emits so the user isn't misled by an artifact block that claims attached
    // page images the runtime never received.
    const hasImageInput = (input.userInputs ?? []).some(
      (entry) => entry.type === "image" || entry.type === "localImage"
    );
    if (hasImageInput) {
      for (const ev of runtimeEventToAGUI(auxState, {
        type: "framework:runtime_notice",
        responseId,
        noticeId: `deepagents-image-unsupported:${responseId}`,
        level: "warning",
        title: "Images not supported",
        message:
          "The Deep Agents runtime does not support image attachments yet; the message text was sent without them.",
        createdAt: new Date().toISOString()
      })) {
        queue.push(ev);
      }
    }

    const modelId = input.model ?? defaultDeepAgentsModelId();
    const effort = input.effort ?? defaultEffortForModel(modelId);

    // Per-turn token accounting — mirrors runTurn so the AG-UI path records the
    // same usage/cost onto the assistant row (keyed on responseId). The raw
    // streamEvents envelopes flow through the backend's streamTurn, so wrap it
    // to accumulate usage in-band without the driver needing to know.
    const usageTotals = createEmptyUsage();
    const usageModelName = resolveModelConstruction(modelId).vendorModel;

    const rawBackend = createSessionAGUITurnBackend({
      threadId: state.threadId,
      runtime: state.runtime,
      toolContextRef: state.toolContextRef,
      modelId,
      effort,
      promptText,
      signal: turnAbort.signal,
      awaitDecisions: async (actions, emit) => {
        if (turnAbort.signal.aborted) {
          return actions.map(() => ({ type: "reject" as const, message: "Turn aborted." }));
        }
        const sink = {
          push: (event: RuntimeEvent) => {
            for (const ev of runtimeEventToAGUI(auxState, event)) emit(ev);
          }
        };
        // Human approval latency is bounded by APPROVAL_REQUEST_TTL_MS, not the
        // turn watchdog — disarm while the prompt is pending, re-arm after
        // (mirrors runTurn).
        disarmWatchdog();
        try {
          return await this.collectApprovalDecisions({
            state,
            eventQueue: sink,
            responseId,
            actions,
            turnAbort
          });
        } finally {
          if (!turnAbort.signal.aborted) armWatchdog();
        }
      }
    });

    const backend: AGUITurnBackend = {
      ...rawBackend,
      async *streamTurn(streamInput) {
        for await (const rawEvent of rawBackend.streamTurn(streamInput)) {
          accumulateUsageFromStreamEvent(usageTotals, rawEvent);
          yield rawEvent;
        }
      }
    };

    const agent = new DeepAgentsAGUIAgent({
      backend,
      toolContextId: input.toolContextId ?? null
    });

    armWatchdog();
    const subscription = agent
      .run({ threadId: state.threadId, runId: responseId, state: {}, messages: [] } as never)
      .subscribe({
        next: (event) => queue.push(event),
        error: (err: unknown) => {
          // Watchdog expiry is a terminal FAILURE, not a user interrupt: emit
          // RUN_ERROR so the client surfaces it as an error/retry (mirrors
          // runTurn's response.failed on timeout). Checked before the abort
          // branch because the watchdog fires via turnAbort.abort().
          if (timedOut()) {
            this.log.error(
              { err, sessionId: state.sessionId, timeoutMs: this.config.RUNTIME_TURN_TIMEOUT_MS },
              "Deep Agents AG-UI turn exceeded RUNTIME_TURN_TIMEOUT_MS and was aborted"
            );
            queue.push({
              type: EventType.RUN_ERROR,
              message: "The turn exceeded the platform time limit and was stopped."
            } as BaseEvent);
            queue.end();
            return;
          }
          // A turn-abort (Stop button / client disconnect / session teardown)
          // surfaces here as the graph stream's AbortError. That is a graceful
          // stop, NOT a failure — mirror runTurn, which emits an interrupted
          // completion rather than response.failed. Emitting RUN_ERROR would make
          // an intentional Stop render as an error/retry in AG-UI clients.
          //
          // This is a clean terminal RUN_FINISHED (a successful-but-early
          // finish), carrying only the private `interrupted` status marker — NOT
          // an `outcome:{type:"interrupt"}`, which AG-UI/CopilotKit would treat
          // as a resumable pause. See AGUI_INTERRUPTED_RESULT for the full why.
          if (turnAbort.signal.aborted) {
            queue.push({
              type: EventType.RUN_FINISHED,
              threadId: state.threadId,
              runId: responseId,
              result: AGUI_INTERRUPTED_RESULT
            } as BaseEvent);
            queue.end();
            return;
          }
          this.log.error({ err, sessionId: state.sessionId }, "Deep Agents AG-UI turn failed");
          queue.push({
            type: EventType.RUN_ERROR,
            message: clientSafeTurnFailureMessage(err)
          } as BaseEvent);
          queue.end();
        },
        complete: () => queue.end()
      });

    try {
      yield* queue;
    } finally {
      disarmWatchdog();
      subscription.unsubscribe();
      const wasAborted = turnAbort.signal.aborted;
      turnAbort.abort();
      state.abortController.signal.removeEventListener("abort", onSessionAbort);
      state.activeTurnInterrupt.current = null;
      state.activeTurnPush.current = null;
      state.activeTurnWatchdog.current = null;
      // A stopped/failed turn must not leave stale approval prompts behind; a
      // clean completion has none pending, so skip the DB round-trip.
      if (wasAborted) this.cancelSessionApprovals(state, "turn_interrupted");
      // Record token usage + cumulative cost onto the assistant row (no-ops when
      // the turn consumed nothing or the writer created no backing row).
      await this.persistTurnUsage(state, responseId, usageTotals, usageModelName);
      this.activeTurns.delete(session.sessionId);
      this.scheduleIdleTeardown(state);
    }
  }

  private async runTurn(
    state: DeepAgentsSessionState,
    eventQueue: AsyncQueue<RuntimeEvent>,
    responseId: string,
    input: {
      prompt: string;
      userInputs?: RuntimeUserInput[];
      toolContextId?: string | null;
      model?: string;
      effort?: RuntimeReasoningEffort;
    }
  ): Promise<void> {
    // Stop button aborts THIS turn only; the session abort cascades too.
    const turnAbort = new AbortController();
    const onSessionAbort = () => turnAbort.abort();
    // An `abort` listener added to an already-aborted signal never fires, so a
    // turn started on a session that was aborted between reservation and here
    // would otherwise run unguarded — mirror the abort eagerly.
    if (state.abortController.signal.aborted) {
      turnAbort.abort();
    } else {
      state.abortController.signal.addEventListener("abort", onSessionAbort, { once: true });
    }
    // Per-turn token accounting, persisted in the finally below so partial
    // (failed/interrupted) turns still record what they consumed.
    const usageTotals = createEmptyUsage();
    let usageModelName: string | null = null;
    let interrupted = false;
    state.activeTurnInterrupt.current = async () => {
      interrupted = true;
      turnAbort.abort();
    };

    const { arm: armWatchdog, disarm: disarmWatchdog, timedOut } = this.createTurnWatchdog(
      state,
      turnAbort
    );
    armWatchdog();

    try {
      eventQueue.push({ type: "response.created", responseId });

      const hasImageInput = (input.userInputs ?? []).some(
        (entry) => entry.type === "image" || entry.type === "localImage"
      );
      if (hasImageInput) {
        eventQueue.push({
          type: "framework:runtime_notice",
          responseId,
          noticeId: `deepagents-image-unsupported:${responseId}`,
          level: "warning",
          title: "Images not supported",
          message:
            "The Deep Agents runtime does not support image attachments yet; the message text was sent without them.",
          createdAt: new Date().toISOString()
        });
      }

      const modelId = input.model ?? defaultDeepAgentsModelId();
      // The pricing table + messages.model_name use the bare VENDOR model id
      // (e.g. "claude-sonnet-5", "gpt-5.4", "meta-llama/llama-4-70b-instruct").
      // Strip only the FIRST namespace segment so OpenRouter ids keep their own
      // slash. calculateCostUsd returns null for models without a pricing row
      // (unlisted / `:free` routes) — tokens are still recorded, cost is null.
      usageModelName = resolveModelConstruction(modelId).vendorModel;
      // Fall back to the catalog's defaultEffort when the turn omits an explicit
      // effort (scheduled jobs, API callers, or UI tenants with the effort
      // selector hidden all send none). Without this, the advertised default —
      // e.g. gpt-5.5 → "medium" — would apply only when the frontend dropdown
      // explicitly sends it. defaultEffort is a member of the model's
      // supportedEfforts (or null) by construction, so no re-validation is
      // needed; an explicit effort was already validated upstream by the resolver.
      const effort = input.effort ?? defaultEffortForModel(modelId);
      const agent = await state.runtime.getAgentForModel(modelId, effort);
      const mapperState = createDeepAgentsEventMapperState(responseId);
      const mapperOptions = {
        mcpToolNames: state.runtime.getMcpToolNames?.() ?? new Set<string>(),
        mcpToolServers: state.runtime.getMcpToolServers?.() ?? new Map<string, string>()
      };

      // Per-turn context for MCP tool-call enrichment and remembered kinds.
      state.toolContextRef.current = input.toolContextId ?? null;
      state.autoApprovedKindsForTurn = new Set();

      // Artifact-scoped turns arrive with `userInputs` REPLACING the raw
      // prompt (the artifact-context block embeds the prompt at its end).
      // Dropping them would hide the selected artifacts' metadata, synced
      // paths, and inline excerpts from the model. Images stay unsupported
      // (the notice above covers them).
      const textInputs = (input.userInputs ?? []).filter(
        (entry): entry is Extract<RuntimeUserInput, { type: "text" }> => entry.type === "text"
      );
      const promptText =
        textInputs.length > 0 ? textInputs.map((entry) => entry.text).join("\n\n") : input.prompt;

      // Interrupt loop: a HITL interrupt pauses the graph BEFORE tool
      // execution and checkpoints, ending the stream. We collect human
      // decisions through the shared approval plane, resume with a Command,
      // and keep pumping — repeatedly, since one turn can hit several
      // approval rounds. No pending interrupt → the turn is done.
      let streamInput: unknown = { messages: [{ role: "user", content: promptText }] };
      for (;;) {
        const stream = agent.streamEvents(streamInput, {
          version: "v2",
          configurable: { thread_id: state.threadId },
          signal: turnAbort.signal
        });

        for await (const rawEvent of stream) {
          // Every model completion (root AND subagent namespaces — subagent
          // tokens cost real money too) contributes to the turn's usage.
          accumulateUsageFromStreamEvent(usageTotals, rawEvent);
          for (const event of mapDeepAgentsEvent(mapperState, rawEvent, mapperOptions)) {
            eventQueue.push(event);
          }
        }

        const actions = (await state.runtime.getPendingActions?.(state.threadId)) ?? [];
        if (actions.length === 0 || !state.runtime.buildResumeInput) break;

        // The watchdog (or an abort) may have fired between the stream ending
        // and pending-interrupt detection — never start an approval round for
        // a turn that is already dead.
        if (turnAbort.signal.aborted) {
          throw new Error("Turn aborted before approval collection.");
        }
        disarmWatchdog();
        const decisions = await this.collectApprovalDecisions({
          state,
          eventQueue,
          responseId,
          actions,
          turnAbort
        });
        if (turnAbort.signal.aborted) {
          throw new Error("Turn aborted while awaiting approval.");
        }
        armWatchdog();
        streamInput = state.runtime.buildResumeInput(actions, decisions);
      }

      eventQueue.push({ type: "response.output_item.done", responseId });
      eventQueue.push({ type: "response.completed", responseId });
    } catch (err: unknown) {
      if (timedOut()) {
        // Watchdog expiry is a terminal failure, not a user interrupt.
        this.log.error(
          { err, sessionId: state.sessionId, timeoutMs: this.config.RUNTIME_TURN_TIMEOUT_MS },
          "Deep Agents turn exceeded RUNTIME_TURN_TIMEOUT_MS and was aborted"
        );
        this.cancelSessionApprovals(state, "turn_interrupted");
        eventQueue.push({
          type: "response.failed",
          responseId,
          message: "The turn exceeded the platform time limit and was stopped."
        });
      } else if (interrupted || turnAbort.signal.aborted) {
        // Stop button / session teardown: the partial text already streamed
        // persists with status "interrupted" — same contract as the other
        // adapters.
        eventQueue.push({ type: "response.output_item.done", responseId });
        eventQueue.push({ type: "response.completed", responseId, interrupted: true });
        // A stopped turn must not leave stale approval prompts behind.
        this.cancelSessionApprovals(state, "turn_interrupted");
      } else {
        // Raw error text can carry internals (pg hosts/DDL from checkpoint
        // writes, provider request detail) — those persist to the transcript
        // via response.failed, so only classified, client-safe messages go
        // out. Full detail stays in the log line.
        this.log.error({ err, sessionId: state.sessionId }, "Deep Agents turn failed");
        eventQueue.push({
          type: "response.failed",
          responseId,
          message: clientSafeTurnFailureMessage(err)
        });
      }
    } finally {
      disarmWatchdog();
      state.activeTurnWatchdog.current = null;
      state.abortController.signal.removeEventListener("abort", onSessionAbort);
      await this.persistTurnUsage(state, responseId, usageTotals, usageModelName);
    }
  }

  /**
   * Writes the turn's accumulated token usage + recomputed cumulative cost
   * onto the assistant message through the MessageStore, so downstream billing
   * and eval tooling read one consistent surface. A responseId with no
   * backing message row (synthetic turns) makes addTokenUsage return null
   * and the write is skipped. Best-effort: accounting failures never fail
   * the turn.
   */
  private async persistTurnUsage(
    state: DeepAgentsSessionState,
    responseId: string,
    usage: TokenUsageRecord,
    modelName: string | null
  ): Promise<void> {
    if (!this.stores.messages || usage.totalTokens === 0) return;
    try {
      const cumulative = await this.stores.messages.addTokenUsage(
        state.tenantId,
        responseId,
        state.userId,
        usage,
        modelName
      );
      if (cumulative && modelName) {
        await this.stores.messages.setCostUsd(
          state.tenantId,
          responseId,
          state.userId,
          calculateCostUsd(modelName, cumulative)
        );
      }
    } catch (err) {
      this.log.warn(
        { err, sessionId: state.sessionId, responseId },
        "Failed to persist Deep Agents token usage"
      );
    }
  }

  // Workspace file ops for write_artifact + per-turn artifact sync. Delegates
  // to the session runtime's sandbox backend; paths are confined to the
  // session workspace by the backend's traversal guard. First use lazily
  // creates the sandbox.
  async readRuntimeFile(sessionId: string, filePath: string): Promise<Uint8Array> {
    const runtime = this.requireSessionState(sessionId).runtime;
    if (!runtime.readFileBytes) {
      throw new Error("The Deep Agents runtime has no sandbox backend for file reads.");
    }
    return runtime.readFileBytes(filePath);
  }

  async statRuntimeFile(sessionId: string, filePath: string): Promise<{ sizeBytes: number }> {
    const runtime = this.requireSessionState(sessionId).runtime;
    if (!runtime.statFile) {
      throw new Error("The Deep Agents runtime has no sandbox backend for file stats.");
    }
    return runtime.statFile(filePath);
  }

  async writeRuntimeFile(
    sessionId: string,
    filePath: string,
    data: Uint8Array | ArrayBuffer | string
  ): Promise<string> {
    const runtime = this.requireSessionState(sessionId).runtime;
    if (!runtime.writeFileBytes) {
      throw new Error("The Deep Agents runtime has no sandbox backend for file writes.");
    }
    return runtime.writeFileBytes(filePath, data);
  }

  async interruptTurn(input: {
    tenantId: string;
    sessionId: string;
    userId: string;
  }): Promise<"interrupted" | "no_active_turn"> {
    const state = this.sessions.get(input.sessionId);
    if (!state || !this.activeTurns.has(input.sessionId)) {
      return "no_active_turn";
    }
    const interrupt = state.activeTurnInterrupt.current;
    if (!interrupt) {
      return "no_active_turn";
    }
    await interrupt();
    return "interrupted";
  }

  async abortSession(input: {
    tenantId: string;
    sessionId: string;
    userId: string;
  }): Promise<void> {
    const state = this.sessions.get(input.sessionId);
    if (!state) return;

    this.clearIdleTimer(state);
    state.abortController.abort();

    this.cancelSessionApprovals(state, "runtime_terminated");

    await state.runtime.dispose().catch((err: unknown) => {
      this.log.warn({ err, sessionId: input.sessionId }, "Failed to dispose Deep Agents session runtime");
    });

    if (this.stores.runtimeSessions) {
      try {
        await this.stores.runtimeSessions.setStatus(
          input.tenantId,
          input.sessionId,
          input.userId,
          "terminated",
          state.runtimeId
        );
      } catch (err) {
        this.log.warn(
          { err, sessionId: input.sessionId },
          "Failed to update Deep Agents runtime session status"
        );
      }
    }

    // Guard against deleting a replacement session created during the awaits.
    if (this.sessions.get(input.sessionId) === state) {
      this.sessions.delete(input.sessionId);
    }
  }

  /**
   * Delete the session's checkpointer thread. Called from the session
   * DELETE route only — abortSession (idle teardown, invalidation) must keep
   * the thread so the conversation survives a warm-session recycle.
   * thread_id === sessionId by construction.
   */
  async purgeSessionData(input: {
    tenantId: string;
    sessionId: string;
    userId: string;
  }): Promise<void> {
    await this.stores.checkpointer?.deleteThread(input.sessionId);
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()].map((state) =>
        this.abortSession({
          tenantId: state.tenantId,
          sessionId: state.sessionId,
          userId: state.userId
        })
      )
    );
    try {
      await this.stores.checkpointer?.end?.();
    } catch (err) {
      this.log.warn({ err }, "Failed to close Deep Agents checkpointer pool");
    }
  }

  /** Aggregate counts for the unauthenticated /health endpoint. */
  getHealthSnapshot(): { activeRuntimeCount: number; activeTurnCount: number } {
    return {
      activeRuntimeCount: this.sessions.size,
      activeTurnCount: this.activeTurns.size
    };
  }

  /**
   * Live in-memory session-runtime detail for /admin/runtime-health,
   * tenant-scoped.
   */
  getRuntimeHealthDetail(tenantId: string): Array<{
    sessionId: string;
    runtimeId: string;
    healthStatus: "healthy";
    lastActiveAt: string;
    hasActiveTurn: boolean;
  }> {
    return [...this.sessions.values()]
      .filter((state) => state.tenantId === tenantId)
      .map((state) => ({
        sessionId: state.sessionId,
        runtimeId: state.runtimeId,
        healthStatus: "healthy" as const,
        lastActiveAt: state.lastActiveAt,
        hasActiveTurn: this.activeTurns.has(state.sessionId)
      }));
  }

  /**
   * Tears down the tenant's in-memory session runtimes so the next turn
   * rebuilds them against fresh config. `idleOnly` skips sessions with an
   * active turn — the admin rollout actions are labeled "idle" and must
   * never interrupt a running conversation; config/integration invalidation
   * keeps the abort-everything default (a stale credential mid-turn is
   * worse than an interrupted turn).
   */
  async invalidateTenantRuntimes(
    tenantId: string,
    opts?: { idleOnly?: boolean }
  ): Promise<string[]> {
    const targets = [...this.sessions.values()].filter(
      (state) =>
        state.tenantId === tenantId &&
        (!opts?.idleOnly || !this.activeTurns.has(state.sessionId))
    );
    await Promise.all(
      targets.map((state) =>
        this.abortSession({
          tenantId: state.tenantId,
          sessionId: state.sessionId,
          userId: state.userId
        })
      )
    );
    return targets.map((state) => state.sessionId);
  }

  async invalidateRuntimesForIntegration(
    tenantId: string,
    userId: string,
    _integrationId: string
  ): Promise<string[]> {
    const targets = [...this.sessions.values()].filter(
      (state) => state.tenantId === tenantId && state.userId === userId
    );
    await Promise.all(
      targets.map((state) =>
        this.abortSession({
          tenantId: state.tenantId,
          sessionId: state.sessionId,
          userId: state.userId
        })
      )
    );
    return targets.map((state) => state.sessionId);
  }

  async resolveApproval(input: {
    tenantId: string;
    approvalId: string;
    userId: string;
    decision: RuntimeApprovalDecision;
    rememberForTurn?: boolean;
  }): Promise<"resolved" | "missing"> {
    const { tenantId, approvalId, userId, decision, rememberForTurn } = input;

    // Policy Center gateway-routed approvals are held by the coordinator.
    if (this.policyApprovals.has(approvalId)) {
      return this.policyApprovals.resolve({ tenantId, approvalId, userId, decision });
    }

    // Native HITL approval: settle the turn loop's promise first (in-process,
    // so unlike the Claude sandbox path there is no delivery failure mode),
    // then flip the DB row + audit. Ownership check mirrors Claude: only the
    // initiating tenant/user may decide.
    const entry = this.pendingApprovals.get(approvalId);
    if (!entry) return "missing";
    const state = this.sessions.get(entry.sessionId);
    if (!state || state.tenantId !== tenantId || state.userId !== userId) {
      return "missing";
    }

    if (rememberForTurn && decision === "approve") {
      entry.autoApprovedKinds.add(entry.rememberKey);
    }
    entry.settle(decision);

    // Atomic once-only guard: a double-click or a row already settled by the
    // TTL sweep returns null — the decision already reached the turn loop, so
    // still report resolved but skip a duplicate audit row.
    const approval = await this.stores.approvals.resolve(
      tenantId,
      approvalId,
      userId,
      decision === "approve" ? "approve" : "reject"
    );
    if (approval) {
      try {
        await this.stores.auditEvents.create({
          tenantId,
          sessionId: approval.sessionId,
          userId: approval.userId,
          approvalId: approval.approvalId,
          type: decision === "approve" ? "approval.approved" : "approval.rejected",
          payload: { itemId: approval.itemId, kind: approval.kind }
        });
      } catch (err) {
        this.log.warn(
          { err, approvalId },
          "failed to write approval decision audit event (decision already delivered)"
        );
      }
    }
    return "resolved";
  }

  async requestPolicyApproval(input: PolicyApprovalRouteInput): Promise<PolicyApprovalDisposition> {
    // A Policy Center approval is held at the MCP gateway — the graph turn is
    // meanwhile suspended awaiting that tool's HTTP response, so it never reaches
    // the native `awaitDecisions` path that disarms the turn watchdog. Pause the
    // watchdog for the owning session's active turn while the human decides
    // (bounded instead by APPROVAL_REQUEST_TTL_MS, which config pins below the
    // turn timeout); otherwise a long turn can time out mid-approval. Ref-counted
    // inside the watchdog handle, so overlapping approvals resume only once.
    const watchdog = this.sessions.get(input.sessionId)?.activeTurnWatchdog.current ?? null;
    watchdog?.pause();
    try {
      return await this.policyApprovals.request(input);
    } finally {
      watchdog?.resume();
    }
  }

  private cancelSessionApprovals(
    state: DeepAgentsSessionState,
    reason: "turn_interrupted" | "runtime_terminated"
  ): void {
    void cancelPendingApprovals({
      tenantId: state.tenantId,
      sessionId: state.sessionId,
      userId: state.userId,
      reason,
      approvals: this.stores.approvals,
      auditEvents: this.stores.auditEvents,
      logger: this.log,
      onCancelLocal: (approvalId) => {
        // Release a policy-held tool call and settle any native HITL wait so
        // neither the gateway response nor the turn loop hangs.
        this.policyApprovals.cancel(approvalId);
        this.pendingApprovals.get(approvalId)?.settle("reject");
        return undefined;
      }
    });
  }

  /**
   * RUNTIME_TURN_TIMEOUT_MS watchdog for one turn: a wedged model/tool call must
   * not pin the session forever — activeTurns holds the slot (→ SessionBusyError
   * for every new message) and idle teardown is disarmed during a turn, so an
   * upstream that stalls without erroring would otherwise wedge the session until
   * the process restarts. Firing aborts `turnAbort`, which LangGraph honors
   * end-to-end to tear the graph run down; the caller reads `timedOut()` to
   * distinguish that from a user interrupt.
   *
   * Installs the `state.activeTurnWatchdog.current` pause/resume handle so a
   * Policy Center approval held at the MCP gateway (outside the native
   * awaitDecisions loop) can stop the timer while a human decides. Pauses are
   * ref-counted for concurrent approvals from parallel subagents; while paused,
   * `arm` is a no-op so a re-arm from the native-approval path can't restart the
   * timer under a held policy approval. The caller must `disarm()` and clear
   * `state.activeTurnWatchdog.current` at turn cleanup.
   */
  private createTurnWatchdog(
    state: DeepAgentsSessionState,
    turnAbort: AbortController
  ): { arm: () => void; disarm: () => void; timedOut: () => boolean } {
    let timedOut = false;
    let watchdogTimer: NodeJS.Timeout | null = null;
    let watchdogPauses = 0;
    const disarm = () => {
      if (watchdogTimer) clearTimeout(watchdogTimer);
      watchdogTimer = null;
    };
    const arm = () => {
      disarm();
      if (this.config.RUNTIME_TURN_TIMEOUT_MS <= 0) return;
      if (watchdogPauses > 0) return;
      watchdogTimer = setTimeout(() => {
        timedOut = true;
        turnAbort.abort();
      }, this.config.RUNTIME_TURN_TIMEOUT_MS);
      watchdogTimer.unref?.();
    };
    state.activeTurnWatchdog.current = {
      pause: () => {
        watchdogPauses += 1;
        disarm();
      },
      resume: () => {
        watchdogPauses = Math.max(0, watchdogPauses - 1);
        if (watchdogPauses === 0 && !turnAbort.signal.aborted) arm();
      }
    };
    return { arm, disarm, timedOut: () => timedOut };
  }

  /**
   * One approval round-trip per pending HITL action. Auto-approves kinds the
   * user already remembered this turn (audited); everything else gets a DB
   * approval row + `framework:approval_required` on the live stream, settled
   * by `POST /approvals/:id/decision` → {@link resolveApproval}, a TTL sweep
   * (reject + `approval.expired` audit + runtime notice), or turn abort
   * (reject). Decision order matches `actions` order — the HITL resume
   * contract.
   */
  private async collectApprovalDecisions(input: {
    state: DeepAgentsSessionState;
    eventQueue: { push: (event: RuntimeEvent) => void };
    responseId: string;
    actions: DeepAgentsPendingAction[];
    turnAbort: AbortController;
  }): Promise<Array<{ type: "approve" } | { type: "reject"; message?: string }>> {
    const { state, eventQueue, responseId, actions, turnAbort } = input;
    const decisions = await Promise.all(
      actions.map((action) =>
        this.requestNativeApproval({ state, eventQueue, responseId, action, turnAbort })
      )
    );
    return decisions.map((decision) =>
      decision === "approve"
        ? { type: "approve" as const }
        : { type: "reject" as const, message: "User denied permission." }
    );
  }

  private classifyApprovalKind(
    state: DeepAgentsSessionState,
    toolName: string
  ): RuntimeApprovalKind {
    if (state.runtime.getMcpToolNames?.().has(toolName)) return "mcp_tool";
    if (toolName === "execute") return "command_execution";
    if (toolName === "write_file" || toolName === "edit_file") return "file_change";
    return "permissions";
  }

  /**
   * "Remember for this turn" key. For every kind except `mcp_tool` the kind
   * alone is the right granularity (there is one built-in tool per kind). MCP
   * tools all share the `mcp_tool` kind, so keying the remember-set by kind
   * would let approving a read-only Notion search auto-approve a destructive
   * GitHub write later in the same turn — scope those to the tool name instead.
   */
  private rememberKeyFor(kind: RuntimeApprovalKind, toolName: string): string {
    return kind === "mcp_tool" ? `mcp_tool:${toolName}` : kind;
  }

  private async requestNativeApproval(input: {
    state: DeepAgentsSessionState;
    eventQueue: { push: (event: RuntimeEvent) => void };
    responseId: string;
    action: DeepAgentsPendingAction;
    turnAbort: AbortController;
  }): Promise<RuntimeApprovalDecision> {
    const { state, eventQueue, responseId, action, turnAbort } = input;
    // Belt-and-braces vs the pre-collection abort check in the turn loop: an
    // already-aborted turn gets an immediate reject — the abort listener
    // below only fires on FUTURE aborts, so without this the wait would hang
    // until the approval TTL.
    if (turnAbort.signal.aborted) return "reject";
    const kind = this.classifyApprovalKind(state, action.name);
    const rememberKey = this.rememberKeyFor(kind, action.name);

    // "Remember for this turn": answer without a DB row or prompt, but leave
    // an audit trail.
    if (state.autoApprovedKindsForTurn.has(rememberKey)) {
      try {
        await this.stores.auditEvents.create({
          tenantId: state.tenantId,
          sessionId: state.sessionId,
          userId: state.userId,
          approvalId: null,
          type: "approval.auto_approved",
          payload: { toolName: action.name, kind }
        });
      } catch (err) {
        this.log.warn({ err, toolName: action.name }, "Failed to write auto-approval audit event");
      }
      return "approve";
    }

    const approvalId = `daapr_${uuidv7()}`;
    const redactedArgs = redactSecrets(action.args);
    try {
      await this.stores.approvals.create({
        tenantId: state.tenantId,
        approvalId,
        sessionId: state.sessionId,
        userId: state.userId,
        runtimeId: state.runtimeId,
        turnId: responseId,
        itemId: approvalId,
        requestMethod: `deepagents/${action.name}`,
        requestId: approvalId,
        kind,
        title: `Approve ${action.name}`,
        summary: JSON.stringify(redactedArgs),
        status: "pending",
        decision: null,
        requestPayload: redactedArgs,
        // DB-level deadline mirroring the in-process TTL below, so a process
        // death still lets the startup sweep recover this row.
        expiresAt: new Date(Date.now() + this.config.APPROVAL_REQUEST_TTL_MS).toISOString()
      });
    } catch (err) {
      this.log.warn({ err, approvalId }, "Failed to persist Deep Agents approval to store");
    }

    eventQueue.push({
      type: "framework:approval_required",
      responseId,
      approvalId,
      itemId: approvalId,
      kind,
      title: `Approve ${action.name}`,
      summary: JSON.stringify(redactedArgs),
      availableDecisions: ["approve", "reject"],
      command: action.name === "execute" && typeof action.args.command === "string"
        ? action.args.command
        : action.name,
      cwd: null
    });

    return new Promise<RuntimeApprovalDecision>((resolve) => {
      let settled = false;
      const settle = (decision: RuntimeApprovalDecision) => {
        if (settled) return;
        settled = true;
        clearTimeout(ttlTimer);
        turnAbort.signal.removeEventListener("abort", onAbort);
        this.pendingApprovals.delete(approvalId);
        resolve(decision);
      };
      const onAbort = () => settle("reject");
      const ttlTimer = setTimeout(() => {
        // TTL expiry: DB row moves to expired + audit + user-facing notice;
        // the reject unblocks the paused graph.
        void expireApprovalById({
          tenantId: state.tenantId,
          sessionId: state.sessionId,
          userId: state.userId,
          approvalId,
          reason: "ttl_expired",
          approvals: this.stores.approvals,
          auditEvents: this.stores.auditEvents,
          logger: this.log,
          onCancelLocal: () => undefined
        });
        eventQueue.push({
          type: "framework:runtime_notice",
          responseId,
          noticeId: `approval-expired:${approvalId}`,
          level: "warning",
          title: "Approval expired",
          message: `The approval request for ${action.name} expired and was rejected.`,
          createdAt: new Date().toISOString()
        });
        settle("reject");
      }, this.config.APPROVAL_REQUEST_TTL_MS);
      ttlTimer.unref?.();
      turnAbort.signal.addEventListener("abort", onAbort, { once: true });
      this.pendingApprovals.set(approvalId, {
        sessionId: state.sessionId,
        kind,
        rememberKey,
        settle,
        // Capture THIS turn's remember-set so a late decision can't pollute
        // the next turn's set.
        autoApprovedKinds: state.autoApprovedKindsForTurn
      });
    });
  }

  private requireSessionState(sessionId: string): DeepAgentsSessionState {
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw new Error(`No Deep Agents session found for ${sessionId}`);
    }
    return state;
  }

  private clearIdleTimer(state: DeepAgentsSessionState): void {
    clearIdleTimer(state);
  }

  private scheduleIdleTeardown(state: DeepAgentsSessionState): void {
    scheduleIdleTeardown(state, {
      timeoutMs: this.config.RUNTIME_IDLE_TIMEOUT_MS,
      isBusy: () =>
        state.abortController.signal.aborted || this.activeTurns.has(state.sessionId),
      onIdle: () => {
        this.log.info(
          { sessionId: state.sessionId, runtimeId: state.runtimeId },
          "Deep Agents session idle timeout; tearing down"
        );
        return this.abortSession({
          tenantId: state.tenantId,
          sessionId: state.sessionId,
          userId: state.userId
        });
      },
      logger: this.log,
      logContext: { sessionId: state.sessionId }
    });
  }
}

function buildDeepAgentsRuntimeManifest(
  configBundle: DeepAgentsSessionState["configBundle"],
  sessionId: string,
  userId: string
): RuntimeManifest {
  const { runtimePolicy, skills, mcpServers, sources } = configBundle;
  return {
    manifestVersion: "1",
    manifestHash: configBundle.hash,
    configBundleHash: configBundle.hash,
    sessionId,
    userId,
    generatedAt: new Date().toISOString(),
    // In-process runtime: no rendered workspace on the backend host disk. The
    // agent's workspace lives inside the E2B sandbox (/home/user/workspace/
    // <sessionId>/), so this host-side manifest field stays empty.
    workspacePath: "",
    runtimePolicy: {
      id: runtimePolicy.id,
      version: runtimePolicy.version,
      hash: runtimePolicy.hash,
      approvalPolicy:
        typeof runtimePolicy.approvalPolicy === "string"
          ? runtimePolicy.approvalPolicy
          : "on-request",
      sandboxMode: runtimePolicy.sandboxMode,
      networkMode: runtimePolicy.networkMode,
      allowCommandExecution: runtimePolicy.allowCommandExecution,
      allowUserTokenForwarding: runtimePolicy.allowUserTokenForwarding,
      autoApproveReadOnlyTools: runtimePolicy.autoApproveReadOnlyTools,
      webSearchMode: runtimePolicy.webSearchMode,
      enabledToolIds: runtimePolicy.enabledToolIds
    },
    skills: skills.map((s) => ({
      id: s.id,
      name: s.name,
      version: s.version,
      hash: s.hash,
      revisionId: s.revisionId,
      bundleHash: s.bundleHash ?? "",
      path: "",
      sourceType: s.sourceType
    })),
    mcpServers: mcpServers.map((s) => ({
      id: s.id,
      version: s.version,
      hash: s.hash,
      mode: s.mode,
      url: s.routePath
    })),
    configSources: sources,
    config: {
      skillsPath: "n/a",
      customSkillsEnabled: skills.length > 0,
      customMcpServersEnabled: mcpServers.length > 0
    }
  };
}

/**
 * Client-facing text for a failed turn (persisted to the transcript). Mirrors
 * sse-stream-writer's clientSafeFailureMessage: 4xx provider errors (invalid
 * key, overloaded model, bad request) are user-actionable and pass through;
 * everything else — pg/checkpointer failures, network errors — collapses to a
 * generic message so internals never reach the client. GraphRecursionError is
 * classified by name to keep this module free of LangChain imports.
 */
function clientSafeTurnFailureMessage(err: unknown): string {
  if (err instanceof Error && err.name === "GraphRecursionError") {
    return "The agent hit its step limit before finishing. Try splitting the request into smaller steps.";
  }
  // Anthropic/OpenAI SDK errors (and LangChain's re-throws) carry `.status`;
  // some app-thrown errors use `.statusCode`. Accept either as the 4xx signal.
  const raw = err as { statusCode?: unknown; status?: unknown } | null | undefined;
  const status = typeof raw?.statusCode === "number" ? raw.statusCode : raw?.status;
  if (typeof status === "number" && status >= 400 && status < 500 && err instanceof Error) {
    return err.message;
  }
  return "The assistant run failed.";
}

function createEmptyUsage(): TokenUsageRecord {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  };
}

/**
 * Adds a stream event's model-completion usage to the turn totals. LangChain
 * puts `usage_metadata` on the AIMessage in `on_chat_model_end` envelopes
 * (`{ input_tokens, output_tokens, total_tokens, input_token_details?,
 * output_token_details? }`).
 */
function accumulateUsageFromStreamEvent(
  totals: TokenUsageRecord,
  rawEvent: Record<string, unknown>
): void {
  if (rawEvent.event !== "on_chat_model_end") return;
  const data = rawEvent.data as Record<string, unknown> | undefined;
  const output = data?.output as Record<string, unknown> | undefined;
  const usage = output?.usage_metadata as Record<string, unknown> | undefined;
  if (!usage) return;

  const input = numberOrZero(usage.input_tokens);
  const outputTokens = numberOrZero(usage.output_tokens);
  const inputDetails = usage.input_token_details as Record<string, unknown> | undefined;
  const outputDetails = usage.output_token_details as Record<string, unknown> | undefined;

  totals.inputTokens += input;
  totals.outputTokens += outputTokens;
  totals.cachedInputTokens += numberOrZero(inputDetails?.cache_read);
  totals.reasoningOutputTokens += numberOrZero(outputDetails?.reasoning);
  totals.totalTokens += numberOrZero(usage.total_tokens) || input + outputTokens;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function defaultDeepAgentsModelId(): string {
  const model = AVAILABLE_MODELS.find((m) => m.isDefault) ?? AVAILABLE_MODELS[0];
  if (!model) {
    throw new Error("No Deep Agents model is registered in AVAILABLE_MODELS.");
  }
  return model.id;
}

/**
 * The catalog's default reasoning effort for `modelId`, or null when the model
 * is unknown or advertises no default. Used to honor the advertised default on
 * turns that omit an explicit effort (scheduled/API/no-selector paths).
 */
function defaultEffortForModel(modelId: string): RuntimeReasoningEffort | null {
  return AVAILABLE_MODELS.find((m) => m.id === modelId)?.defaultEffort ?? null;
}
