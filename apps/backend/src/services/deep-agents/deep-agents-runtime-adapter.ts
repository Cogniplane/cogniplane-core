import type { ModelSpendingStore } from "../model-spending-store.js";
import { ModelSpendingCallback } from "./model-spending-callback.js";
import type { ProjectInstructionsSnapshot } from "@cogniplane/shared-types";
import { SessionExecutionError, type SessionExecution, type SessionExecutionStore } from "../session-execution-store.js";
// Sole runtime provider (bead im5e.1, then quap.4): the agent loop runs IN
// the Fastify backend via deepagentsjs instead of inside an E2B sandbox
// harness. This adapter drives the loop and emits the AG-UI stream consumed by
// both interactive requests and scheduled jobs.

import type { ActivationTracker } from "../activation-tracker.js";
import path from "node:path";

import type { FastifyBaseLogger } from "fastify";

import { uuidv7 } from "../../lib/uuid.js";
import { AsyncQueue } from "../../lib/async-queue.js";
import { runtimeTokenSecret } from "../../lib/derived-secrets.js";
import {
  SessionBusyError,
  resolveTurnApprovalSettings,
  type RuntimeAdapter,
  type RuntimeApprovalDecision,
  type RuntimeApprovalKind,
  type RuntimeReasoningEffort,
  type RuntimeSessionRef,
  type RuntimeUserInput
} from "../../runtime-contracts.js";
import type { ModelProvider, PolicyTurnContext, ProjectApprovalMode } from "@cogniplane/shared-types";
import { MODEL_PROVIDERS } from "@cogniplane/shared-types";

import { AVAILABLE_MODELS } from "../../domain/models.js";
import type { RuntimeManifest } from "../../domain/runtime-manifest.js";
import type { AppConfig } from "../../config.js";
import type { ProviderCredentials } from "../runtime/provider-credentials.js";
import type { ApprovalStore } from "../auth/approval-store.js";
import type { ToolExecutionContextStore } from "../auth/tool-execution-context-store.js";
import type { ActiveTurnsRegistry } from "../active-turns-registry.js";
import type { AuditEventStore } from "../audit-event-store.js";
import type { DynamicConfigService } from "../dynamic-config-service.js";
import type { MemoryStore } from "../memory-store.js";
import type { MessageStore, TokenUsageRecord } from "../message-store.js";
import { calculateCostUsd } from "../token-cost-calculator.js";
import type { PolicyService } from "../policy/policy-service.js";
import type { RuntimeSessionStore } from "../runtime/runtime-session-store.js";
import type { TenantMemberStore } from "../tenant-member-store.js";
import { generateRuntimeToken, runtimeTokenExpiry } from "../auth/runtime-token.js";
import type { ManagedToolCatalog } from "../managed-tools/catalog.js";
import {
  ApprovalCoordinator,
  type ApprovalPublish,
  type ApprovalRequest,
  type ApprovalTurn
} from "../runtime/approval-coordinator.js";
import {
  clearIdleTimer,
  scheduleIdleTeardown
} from "../runtime/idle-teardown.js";
import { createStageTimer } from "../runtime/startup-timing.js";
import { MEMORY_SAVE_TOOL, prepareMemorySaveApproval, type DurableWriteApproval } from "../memory-consent.js";
import {
  buildMemoryDataContext,
  buildMemorySectionLines,
  loadWorkspaceMemories
} from "../memory-workspace-section.js";
import type { SkillBundleStorage } from "../skills/skill-bundle-storage.js";
import { EventType, type BaseEvent } from "@ag-ui/client";

import { DeepAgentsAGUIAgent } from "./deep-agents-agui-agent.js";
import { createSessionAGUITurnBackend, type AGUITurnBackend } from "./deep-agents-agui-backend.js";
import {
  AGUI_INTERRUPTED_RESULT,
  approvalRequiredEvent,
  runtimeNoticeEvent
} from "./agui-events.js";
import { createDeepAgentsSessionRuntime, resolveModelConstruction } from "./deep-agents-graph.js";
import { buildSkillsLibraryFiles } from "./deep-agents-skills-library.js";
import type {
  DeepAgentsCheckpointSaver,
  DeepAgentsPendingAction,
  DeepAgentsRuntimeFactory,
  DeepAgentsSessionState
} from "./deep-agents-types.js";
import { E2B_WORKSPACE_BASE } from "../runtime/e2b-sandbox.js";
import { resolveSandboxNetworkPolicy } from "../runtime/sandbox-network-policy.js";

const PROVIDER_ID = "deep-agents";

function sessionOwnershipMismatch(): Error & { statusCode: number } {
  return Object.assign(new Error("Session ownership mismatch"), { statusCode: 403 });
}

/**
 * How long a terminal event will wait for the turn's usage write.
 *
 * Usage is flushed BEFORE the terminal event so a refetch cannot beat it (the
 * frontend refetches the message as soon as it sees `RUN_FINISHED`). That
 * ordering must not become a dependency: the write has no
 * cancellation of its own, so a stalled pool acquisition would otherwise hold
 * the terminal event — and, behind it, the turn slot — for as long as the
 * database took, with the turn watchdog powerless because it can only abort the
 * graph. Past this budget the turn ends and the write finishes on its own; the
 * refetch race comes back, which is a far smaller failure than a wedged session.
 */
export const USAGE_FLUSH_DEADLINE_MS = 5_000;
export const WORKSPACE_RESET_NOTICE_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * Awaits `flush` for at most {@link USAGE_FLUSH_DEADLINE_MS}. The flush itself
 * never rejects (persistTurnUsage swallows its own errors), so the race only
 * ever bounds the wait.
 */
function withUsageFlushDeadline(flush: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, USAGE_FLUSH_DEADLINE_MS);
    timer.unref?.();
  });
  // Cleared on BOTH outcomes. `flushUsage` is called more than once per turn (a
  // terminal branch, then the finally backstop), so a timer left pending on the
  // common path — the flush winning — would accumulate one live handle per call
  // per turn for the full deadline.
  return Promise.race([flush, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export class DeepAgentsRuntimeAdapter implements RuntimeAdapter {
  readonly id = PROVIDER_ID;

  private readonly spending = new Map<string, ModelSpendingCallback>();
  private readonly sessions = new Map<string, DeepAgentsSessionState>();
  private readonly activeTurns = new Set<string>();
  private readonly pendingIntegrationInvalidations = new Set<string>();
  private readonly approvalCoordinator: ApprovalCoordinator;
  private readonly pendingWorkspaceResetNotices = new Map<
    string,
    { noticeId: string; message: string; expiryTimer: NodeJS.Timeout }
  >();
  /**
   * In-flight createSession promises, keyed by sessionId. createSession awaits
   * several times (config compile, credential probe, memory/skills load) before
   * it registers the new state, so two concurrent calls for the same session
   * would each build a runtime and the loser would silently overwrite the
   * winner un-disposed with its idle timer armed. Memoizing the in-flight
   * promise collapses concurrent calls from the same tenant and user onto one
   * build. Other callers must not inherit that participant's runtime policy.
   */
  private readonly pendingSessionCreations = new Map<string, {
    tenantId: string;
    userId: string;
    executionId?: string;
    promise: Promise<RuntimeSessionRef>;
  }>();

  constructor(
    private readonly config: AppConfig,
    private readonly dynamicConfig: Pick<DynamicConfigService, "compileRuntimeConfig" | "getRuntimePolicy">,
    private readonly log: FastifyBaseLogger,
    private readonly stores: {
      approvals: ApprovalStore;
      executions: Pick<SessionExecutionStore, "isCurrent" | "bindRuntime"> &
        Partial<Pick<SessionExecutionStore, "sandboxBinding" | "bindSandboxId">>;
      conversationMessages?: Pick<MessageStore, "listBySession">;
      sessions: Pick<import("../session-store.js").SessionStore, "getReadable">;
      auditEvents: AuditEventStore;
      activationTracker?: Pick<ActivationTracker, "recordMaterialization">;
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
      messages?: Pick<MessageStore, "addTokenUsage">;
      modelSpending?: ModelSpendingStore;
      /**
       * Skill bundle storage for materializing companion files into the
       * /skills/ library at session start. Optional: without it, bundle-backed
       * skills degrade to SKILL.md-only (unit tests, minimal wiring).
       */
      skillBundles?: Pick<SkillBundleStorage, "materializeBundle">;
      tenantMembers: Pick<TenantMemberStore, "isUserBetaTester"> &
        Partial<Pick<TenantMemberStore, "getRole">>;
      /**
       * Pushes a live tool context's expiry out on each approval round (bead
       * Optional: without it the TTL stays wall-clock and a turn parked on
       * several approvals loses managed MCP tool access mid-turn.
       */
      toolContexts?: Pick<ToolExecutionContextStore, "extend">;
      /**
       * Refreshes the active-turn entry's liveness on each approval round
       * Optional: without it a turn parked on several approvals is stale-evicted
       * while still live, letting a second turn start on the same session.
       */
      activeTurns?: Pick<ActiveTurnsRegistry, "keepAlive" | "snapshot">;
    },
    private readonly providerCredentials?: ProviderCredentials,
    private readonly runtimeFactory: DeepAgentsRuntimeFactory = createDeepAgentsSessionRuntime,
    /** Read-only tool classification for autoApproveReadOnlyTools. Optional in unit tests. */
    private readonly managedToolCatalog?: Pick<ManagedToolCatalog, "listIds" | "listReadOnlyIds" | "get">
  ) {
    this.approvalCoordinator = new ApprovalCoordinator({
      approvals: stores.approvals, auditEvents: stores.auditEvents, logger: log,
      ttlMs: config.APPROVAL_REQUEST_TTL_MS
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
    execution?: SessionExecution;
  }): Promise<RuntimeSessionRef> {
    const inFlight = this.pendingSessionCreations.get(input.sessionId);
    if (inFlight) {
      if (inFlight.tenantId !== input.tenantId || inFlight.userId !== input.userId ||
          inFlight.executionId !== input.execution?.executionId) {
        throw sessionOwnershipMismatch();
      }
      return inFlight.promise;
    }
    // Return the finally-chain promise so cleanup precedes caller continuation.
    const creation = this.createOrRefreshSession(input).finally(() => {
      this.pendingSessionCreations.delete(input.sessionId);
    });
    this.pendingSessionCreations.set(input.sessionId, {
      tenantId: input.tenantId,
      userId: input.userId,
      executionId: input.execution?.executionId,
      promise: creation
    });
    return creation;
  }

  private async createOrRefreshSession(input: {
    tenantId: string; sessionId: string; userId: string; execution?: SessionExecution;
  }): Promise<RuntimeSessionRef> {
    const { sessionId } = input;
    await this.requireRuntimeSessionAccess(input);
    if (input.execution) {
      if (input.execution.tenantId !== input.tenantId || input.execution.userId !== input.userId ||
          input.execution.sessionId !== sessionId || !this.stores.executions ||
          !await this.stores.executions.isCurrent(input.execution)) throw new SessionExecutionError("execution_stopped", 403);
      if (this.activeTurns.has(sessionId)) throw new SessionBusyError(sessionId);
      const previous = this.sessions.get(sessionId);
      if (previous && previous.tenantId !== input.tenantId) throw sessionOwnershipMismatch();
      if (previous?.execution?.executionId === input.execution.executionId && !previous.abortController.signal.aborted) {
        return { sessionId, runtimeId: previous.runtimeId, runtimePolicy: previous.configBundle.runtimePolicy,
          mcpServerSources: previous.configBundle.sources.mcpServers,
          integrationAccounts: previous.configBundle.sources.integrationAccounts ?? {} };
      }
      if (input.execution.projectId) {
        // Shared project turns rebuild the graph from the saved transcript.
        if (previous) await this.abortSession({ tenantId: previous.tenantId, sessionId, userId: previous.userId });
        return this.buildSession(input);
      }
      if (previous && (!previous.execution || previous.execution.projectId)) {
        await this.abortSession({ tenantId: previous.tenantId, sessionId, userId: previous.userId });
        return this.buildSession(input);
      }
      if (previous && !previous.abortController.signal.aborted) {
        if (previous.userId !== input.userId) throw sessionOwnershipMismatch();
        await this.stores.executions.bindRuntime(input.execution, previous.runtimeId);
        previous.execution = input.execution;
      }
    }

    // Idempotency: reuse a live session so conversation state (the session
    // runtime's checkpointer thread) carries across turns.
    const existing = this.sessions.get(sessionId);
    if (existing && !existing.abortController.signal.aborted) {
      if (existing.tenantId !== input.tenantId || existing.userId !== input.userId) {
        throw sessionOwnershipMismatch();
      }
      if (this.activeTurns.has(sessionId)) throw new SessionBusyError(sessionId);
      const beta = await this.stores.tenantMembers.isUserBetaTester(input.tenantId, input.userId);
      const bundle = await this.dynamicConfig.compileRuntimeConfig(input.tenantId, beta, { sessionId, userId: input.userId });
      if (bundle.hash !== existing.configBundle.hash) {
        const skillsLibraryFiles = await buildSkillsLibraryFiles({
          skills: bundle.skills, bundles: this.stores.skillBundles ?? null, logger: this.log
        });
        const token = generateRuntimeToken({
          sid: sessionId, tid: input.tenantId, uid: input.userId, rid: existing.runtimeId,
          exp: runtimeTokenExpiry(this.config.RUNTIME_TOKEN_TTL_MS)
        }, runtimeTokenSecret(this.config.DATA_ENCRYPTION_SECRET));
        const gatewayBase = this.config.RUNTIME_GATEWAY_BASE_URL.replace(/\/$/, "");
        const memoryLines = buildMemorySectionLines(bundle.runtimePolicy.enabledToolIds);
        await existing.runtime.refreshCapabilities({
          skillsLibraryFiles,
          allowCommandExecution: bundle.runtimePolicy.allowCommandExecution && Boolean(this.config.E2B_API_KEY),
          e2b: this.config.E2B_API_KEY ? {
            apiKey: this.config.E2B_API_KEY, templateId: this.config.E2B_TEMPLATE_ID,
            sandboxTimeoutMs: this.config.E2B_SANDBOX_TIMEOUT_MS,
            executeTimeoutMs: this.config.DEEP_AGENTS_EXECUTE_TIMEOUT_MS,
            resolveNetworkPolicy: () => this.resolveSandboxPolicy(input.tenantId, sessionId),
            networkConfirmTimeoutMs: this.config.E2B_NETWORK_CONFIRM_TIMEOUT_MS,
            networkRequestTimeoutMs: this.config.E2B_NETWORK_REQUEST_TIMEOUT_MS
          } : null,
          approvals: {
            ...resolveTurnApprovalSettings(bundle.runtimePolicy),
            readOnlyToolNames: this.managedToolCatalog?.listReadOnlyIds() ?? []
          },
          systemPrompt: [bundle.runtimePolicy.developerInstructions?.trim(), memoryLines.join("\n")].filter(Boolean).join("\n\n") || null,
          mcpServers: bundle.mcpServers.map((server) => ({
            id: server.id, mode: server.mode,
            url: new URL(server.routePath, gatewayBase + "/").toString(), authorization: `Bearer ${token}`
          }))
        });
        existing.configBundle = bundle;
      }
      return {
        sessionId,
        runtimeId: existing.runtimeId,
        runtimePolicy: existing.configBundle.runtimePolicy,
        mcpServerSources: existing.configBundle.sources.mcpServers,
        integrationAccounts: existing.configBundle.sources.integrationAccounts ?? {}
      };
    }

    return this.buildSession(input);
  }

  /**
   * The network policy that a sandbox of this session must have, read from the
   * tenant settings now. The sandbox asks every time it creates a sandbox and
   * at the start of every turn, so a change of the approved hosts applies at the
   * next turn without a refresh of the runtime. Hosts that fail the host check
   * are dropped, which approves less; the drop is logged.
   */
  private async resolveSandboxPolicy(tenantId: string, sessionId: string) {
    const policy = await this.dynamicConfig.getRuntimePolicy(tenantId);
    return sandboxNetworkPolicyFor(policy.sandboxEgressDomains, this.log, sessionId);
  }

  private async buildSession(input: {
    tenantId: string;
    sessionId: string;
    userId: string;
    execution?: SessionExecution;
  }): Promise<RuntimeSessionRef> {
    const { tenantId, sessionId, userId } = input;
    const runtimeId = `deepagents-${uuidv7()}`;
    const startupTimer = createStageTimer();
    const isBetaTester = await this.stores.tenantMembers.isUserBetaTester(tenantId, userId);

    const configBundle = await startupTimer.time("compileConfigMs", () =>
      this.dynamicConfig.compileRuntimeConfig(tenantId, isBetaTester, { sessionId, userId })
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
      runtimeTokenSecret(this.config.DATA_ENCRYPTION_SECRET)
    );

    // The system prompt names the memory tools and states the rule that memory
    // is user data. The memories themselves are read at the start of each turn
    // and sent as a data message (see loadMemoryContext).
    const memoryLines = buildMemorySectionLines(runtimePolicy.enabledToolIds);
    // Enabled skills (bead kpit): served as a read-only /skills/ file library
    // through the native deepagents skills middleware (progressive
    // disclosure) instead of the retired "## Skill:" system-prompt inlining.
    // Bundle companion files are materialized into the library; a bundle
    // failure degrades that skill to SKILL.md-only. Each new turn replaces
    // the checkpointed listing with the currently selected skills.
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
      mode: server.mode,
      url: new URL(server.routePath, gatewayBase + "/").toString(),
      authorization: `Bearer ${runtimeToken}`
    }));
    const toolContextRef: { current: string | null } = { current: null };
    const policyContextRef: DeepAgentsSessionState["policyContextRef"] = { current: null };
    const managedToolFacts = Object.fromEntries(
      (this.managedToolCatalog?.listIds() ?? []).map((toolName) => {
        const entry = this.managedToolCatalog?.get(toolName);
        return [toolName, {
          readOnly: entry?.readOnly ?? false, category: entry?.category ?? null,
          requiresUserApproval: entry?.requiresUserApproval ?? false
        }];
      })
    );
    // Member removal can race the asynchronous setup above. Re-check after
    // the last await and before constructing or publishing the runtime, so a
    // claimed scheduled job cannot start under a removed identity.
    await this.requireRuntimeSessionAccess(input);

    const runtime = this.runtimeFactory({
      ...(this.stores.modelSpending ? {
        requireSpendingAllowance: () => this.spending.get(runtimeId)?.assertAllowance(),
        hasSpendingReservation: () => this.spending.has(runtimeId)
      } : {}),
      ...(input.execution ? { requireExecution: async () => {
        const current = this.sessions.get(sessionId);
        if (!current || current.runtimeId !== runtimeId || !current.execution)
          throw new SessionExecutionError("execution_stopped", 403);
        await this.requireRuntimeSessionAccess(current);
        if (!await this.stores.executions!.isCurrent(current.execution, runtimeId))
          throw new SessionExecutionError("execution_stopped", 403);
      } } : {}),
      tenantId,
      sessionId,
      userId,
      runtimeId,
      // Deferred, provider-aware key resolution. The in-process loop calls
      // each provider's API directly with the real key; usage/cost is captured
      // by runMessageAGUI.
      resolveProviderKey,
      providerBaseUrls: null,
      systemPrompt,
      skillsLibraryFiles,
      workspacePath,
      mcpServers,
      toolContextRef,
      policyContextRef,
      policyService: this.stores.policyService,
      managedToolFacts,
      approvals: {
        ...resolveTurnApprovalSettings(runtimePolicy),
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
              executeTimeoutMs: this.config.DEEP_AGENTS_EXECUTE_TIMEOUT_MS,
              resolveNetworkPolicy: () => this.resolveSandboxPolicy(tenantId, sessionId),
              networkConfirmTimeoutMs: this.config.E2B_NETWORK_CONFIRM_TIMEOUT_MS,
              networkRequestTimeoutMs: this.config.E2B_NETWORK_REQUEST_TIMEOUT_MS
            }
          : null,
      ...(input.execution && !input.execution.projectId &&
        this.stores.executions.sandboxBinding && this.stores.executions.bindSandboxId
        ? { sandboxBinding: {
            load: async () => {
              const current = this.sessions.get(sessionId)?.execution;
              if (!current) throw new SessionExecutionError("execution_stopped", 403);
              return this.stores.executions.sandboxBinding!(current);
            },
            save: async (previousId: string | null, sandboxId: string, networkPolicyHash: string) => {
              const current = this.sessions.get(sessionId)?.execution;
              if (!current) throw new SessionExecutionError("execution_stopped", 403);
              await this.stores.executions.bindSandboxId!(current, previousId, sandboxId, networkPolicyHash);
            }
          } } : {}),
      // Surface a transparently replaced sandbox: at that moment every file
      // the agent wrote and every artifact synced into the workspace is gone,
      // and without a notice the model just meets file_not_found on its own
      // work. Best-effort — no active turn means nowhere to show it.
      onSandboxRecreated: ({ previousSandboxId, reason }) => {
        const sessionState = this.sessions.get(sessionId);
        if (!sessionState) return;
        const responseId = sessionState.activeTurnResponseId.current;
        // No responseId means no turn has been claimed — nothing to address.
        if (!responseId) return;
        // The push hook may not exist yet: onBeforeTurn (artifact sync) runs
        // before it is installed and is the likeliest caller to hit an expired
        // sandbox. Buffer for the drain instead of dropping the notice.
        const push =
          sessionState.activeTurnPush.current ??
          ((event: BaseEvent) => sessionState.pendingTurnEvents.push(event));
        push(runtimeNoticeEvent({
          // Keyed on the sandbox that was LOST, not the session: the frontend
          // dedupes notices by noticeId, so a session-wide key would show only
          // the first loss and silently swallow every later one. Each
          // replacement is a distinct event the user has to see. Falls back to
          // the responseId when the id is unknown (lost before creation
          // completed), which still separates it per turn.
          noticeId: `sandbox-recreated:${previousSandboxId ?? responseId}`,
          level: "warning",
          title: "Workspace reset",
          message:
            (reason === "network_policy"
              ? "The execution sandbox did not match the current network policy and was replaced. "
              : "The execution sandbox expired and was replaced. ") +
            "Files written earlier in this session, " +
            "and artifacts synced into the workspace, are no longer on disk and need to be recreated.",
          createdAt: new Date().toISOString()
        }));
      },
      checkpointer: input.execution?.projectId ? undefined : this.stores.checkpointer,
      logger: this.log
    });

    const state: DeepAgentsSessionState = {
      execution: input.execution,
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
      activeTurnResponseId: { current: null },
      pendingTurnEvents: [],
      toolContextRef,
      policyContextRef
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

    if (input.execution) {
      try { await this.stores.executions!.bindRuntime(input.execution, runtimeId); }
      catch (error) {
        await this.abortSession(input);
        throw error;
      }
    }
    this.scheduleIdleTeardown(state);

    return {
      sessionId,
      runtimeId,
      runtimePolicy: configBundle.runtimePolicy,
      mcpServerSources: configBundle.sources.mcpServers,
      integrationAccounts: configBundle.sources.integrationAccounts ?? {}
    };
  }

  async *runMessageAGUI(
    session: RuntimeSessionRef,
    input: {
      prompt: string;
      projectInstructions?: ProjectInstructionsSnapshot | null;
      userInputs?: RuntimeUserInput[];
      toolContextId: string | null;
      projectApprovalMode?: ProjectApprovalMode;
      turnContext?: PolicyTurnContext;
      assistantMessageId?: string | null;
      model?: string;
      effort?: RuntimeReasoningEffort;
      cancelSignal?: AbortSignal;
      onBeforeTurn?: (signal: AbortSignal) => Promise<void>;
    }
  ): AsyncIterable<BaseEvent> {
    const state = this.sessions.get(session.sessionId);
    if (!state) {
      throw new Error(`No Deep Agents session found for ${session.sessionId}`);
    }
    // A reference retained across teardown must never select its replacement's
    // credentials, workspace or checkpoint execution by session ID alone.
    if (state.runtimeId !== session.runtimeId || state.abortController.signal.aborted) {
      throw Object.assign(new Error("Runtime session is no longer current. Start a new turn."), {
        statusCode: 409
      });
    }
    const projectId = await this.requireRuntimeSessionAccess(state);
    if (state.execution && !await this.stores.executions!.isCurrent(state.execution, state.runtimeId)) {
      throw new SessionExecutionError("execution_stopped", 403);
    }
    if (this.sessions.get(session.sessionId) !== state || state.abortController.signal.aborted)
      throw new SessionExecutionError("execution_stopped", 403);
    if (input.cancelSignal?.aborted) throw new Error("Turn stopped during setup");
    // Refresh awaits configuration and mutates capabilities. Reserve admission
    // against it before any sandbox, context or graph work can begin.
    if (this.pendingSessionCreations.has(session.sessionId) || this.activeTurns.has(session.sessionId)) {
      throw new SessionBusyError(session.sessionId);
    }
    this.activeTurns.add(session.sessionId);
    state.lastActiveAt = new Date().toISOString();
    this.clearIdleTimer(state);

    // Install cancellation and the watchdog as soon as the slot is reserved.
    // Sandbox renewal, approval reconfiguration, artifact sync, and the graph
    // all consume the same bounded working-time budget.
    const turnAbort = new AbortController();
    const onSessionAbort = () => turnAbort.abort();
    const onAdmissionAbort = () => turnAbort.abort();
    if (state.abortController.signal.aborted) {
      turnAbort.abort();
    } else {
      state.abortController.signal.addEventListener("abort", onSessionAbort, { once: true });
    }
    if (input.cancelSignal?.aborted) turnAbort.abort();
    else input.cancelSignal?.addEventListener("abort", onAdmissionAbort, { once: true });
    state.activeTurnInterrupt.current = async () => {
      turnAbort.abort();
    };
    const { arm: armWatchdog, disarm: disarmWatchdog, timedOut } = this.createTurnWatchdog(
      turnAbort
    );
    const responseId = input.assistantMessageId ?? uuidv7();
    const modelId = input.model ?? defaultDeepAgentsModelId();
    let spending: ModelSpendingCallback | undefined;
    const finishSpending = async () => {
      try { await spending?.finish(); }
      catch (err) { this.log.error({ err, responseId }, "Failed to settle model spending; reservation retained"); }
    };
    // The closed callback must not stay in the map after its turn.
    const forgetSpending = () => {
      if (spending && this.spending.get(state.runtimeId) === spending) this.spending.delete(state.runtimeId);
    };
    // Ends the turn in the sandbox. It is set when the turn begins there, and every exit below calls it.
    let endSandboxTurn: () => void = () => {};
    const releaseTurnSlot = async () => {
      endSandboxTurn();
      await finishSpending();
      forgetSpending();
      disarmWatchdog();
      state.abortController.signal.removeEventListener("abort", onSessionAbort);
      input.cancelSignal?.removeEventListener("abort", onAdmissionAbort);
      this.activeTurns.delete(session.sessionId);
      state.activeTurnInterrupt.current = null;
      state.activeTurnResponseId.current = null;
      state.pendingTurnEvents = [];
      await this.finishIntegrationInvalidation(state);
    };
    armWatchdog();
    try {
      const vendorModel = resolveModelConstruction(modelId).vendorModel;
      const reservation = await this.stores.modelSpending?.reserve({
        tenantId: state.tenantId, userId: state.userId, sessionId: state.sessionId,
        reservationId: responseId, turnContext: input.turnContext ?? "interactive", modelName: vendorModel
      });
      this.spending.delete(state.runtimeId);
      if (reservation && this.stores.modelSpending) {
        spending = new ModelSpendingCallback(this.stores.modelSpending, reservation,
          vendorModel, turnAbort.signal);
        this.spending.set(state.runtimeId, spending);
      }
    } catch (error) {
      await releaseTurnSlot();
      throw error;
    }

    // A turn starts in the sandbox here, for an interactive turn and for a
    // scheduled job alike. The admin may have changed the approved hosts since
    // the last turn, and the network of a sandbox is fixed when it is created.
    // What was confirmed in an earlier turn must not carry over, so the first
    // operation of this turn reads the live network of the sandbox once and
    // replaces it if it does not match the policy as it is now. It is
    // synchronous and must not throw. If it does, the turn fails rather than run
    // on a confirmation that may be stale. The sandbox ends the turn when the
    // turn is cancelled, and every exit of this method ends it too, so that
    // nothing the turn asked of the sandbox runs after it.
    try {
      endSandboxTurn = state.runtime.beginSandboxTurn?.(turnAbort.signal) ?? endSandboxTurn;
    } catch (error) {
      await releaseTurnSlot();
      throw error;
    }

    // Claim the response id before the sandbox renewal and artifact sync. Both
    // can replace the sandbox, and the notice of a replacement needs the id
    // before the push hook exists.
    state.activeTurnResponseId.current = responseId;
    state.pendingTurnEvents = [];

    // Push the sandbox lifetime back out before anything touches it (artifact
    // sync in onBeforeTurn does). The E2B cap otherwise runs from the session's
    // FIRST tool use and is never renewed, so an active session eventually
    // crosses it mid-turn and silently loses its whole workspace. Extending at
    // each turn start makes the cap idle-based instead. No-op (and no sandbox
    // creation) when the session has never used one. The E2B sandbox checks its
    // network against the current policy first, and replaces nothing itself: a
    // sandbox that does not match is killed instead of kept alive.
    //
    // Guarded rather than trusted: the slot is already reserved here, so an
    // implementation that rejects would leak the session busy forever. The
    // production sandbox swallows its own failures (an unextendable sandbox is
    // recovered by withSandbox on the next op), but the interface does not
    // promise that, and a failed extension must never cost a turn.
    try {
      await this.waitForTurnSetup(
        Promise.resolve(state.runtime.extendSandboxTimeout?.()),
        turnAbort.signal
      );
    } catch (err) {
      this.log.warn(
        { err, sessionId: session.sessionId },
        "Failed to extend the sandbox lifetime at turn start; continuing"
      );
    }

    // Project approval mode is read before dispatch and belongs to this turn,
    // not to the warm session. Reconfigure the graph before artifact sync or
    // model work so a later setting change cannot affect an active turn.
    try {
      await this.waitForTurnSetup(
        Promise.resolve(
          state.runtime.setApprovalSettings({
            ...resolveTurnApprovalSettings(state.configBundle.runtimePolicy, input.projectApprovalMode),
            readOnlyToolNames: this.managedToolCatalog?.listReadOnlyIds() ?? []
          })
        ),
        turnAbort.signal
      );
    } catch (error) {
      await releaseTurnSlot();
      throw error;
    }

    // Artifact workspace sync and turn-input building run after slot reservation.
    if (input.onBeforeTurn) {
      try {
        await this.waitForTurnSetup(input.onBeforeTurn(turnAbort.signal), turnAbort.signal);
      } catch (error) {
        await releaseTurnSlot();
        throw error;
      }
    }

    let conversationMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
    if (!turnAbort.signal.aborted && state.execution?.projectId && this.stores.conversationMessages) {
      try {
        // Project sessions do not use the LangGraph checkpointer for transcript
        // state. Read the complete durable transcript so a long-lived shared
        // conversation does not silently lose its oldest turns at the normal
        // UI list cap.
        const history = await this.stores.conversationMessages.listBySession(
          state.tenantId,
          state.sessionId,
          state.userId,
          { limit: null },
        );
        const preceding = history.messages.filter((message) => message.messageId !== input.assistantMessageId);
        // The current user message is already represented by promptText below.
        let lastUser = preceding.length - 1;
        while (lastUser >= 0 && preceding[lastUser]!.role !== "user") lastUser--;
        conversationMessages = preceding.slice(0, lastUser < 0 ? preceding.length : lastUser)
          .filter((message): message is typeof message & { role: "user" | "assistant" } =>
            (message.role === "user" || message.role === "assistant") && Boolean(message.content))
          .map(({ role, content }) => ({ role, content }));
        if (!await this.stores.executions!.isCurrent(state.execution, state.runtimeId))
          throw new SessionExecutionError("execution_stopped", 403);
      } catch (error) {
        await releaseTurnSlot();
        throw error;
      }
    }

    // Recent memories enter model input as a labelled data message. They are read
    // for every turn, so an edit or a delete in settings applies at once.
    let memoryContext: string | null = null;
    await this.waitForTurnSetup(
      this.loadMemoryContext(state, session.runtimePolicy).then((text) => { memoryContext = text; }),
      turnAbort.signal
    );

    // An abort raised during onBeforeTurn (client disconnect, session teardown)
    // is NOT short-circuited here: the run is still started so the stream leads
    // with RUN_STARTED and then terminates through the subscription's abort
    // branch with the interrupted RUN_FINISHED the writer needs to mark the row.
    // `turnAbort.signal` is threaded into the backend, so the graph stream
    // rejects immediately rather than doing any model work.

    // Artifact-scoped turns arrive with `userInputs` REPLACING the raw prompt
    // because the artifact-context block embeds the prompt at its end.
    const textInputs = input.userInputs ?? [];
    const promptText =
      textInputs.length > 0 ? textInputs.map((entry) => entry.text).join("\n\n") : input.prompt;

    const queue = new AsyncQueue<BaseEvent>();
    // Events raised BEFORE the agent run starts cannot go onto the queue:
    // @ag-ui/client's verifier rejects any stream whose first event is not
    // RUN_STARTED ("First event must be 'RUN_STARTED'"), and the agent emits
    // that only once subscribed, ~100 lines below. So everything raised until
    // then is held here and flushed right after the run's first event.
    //
    // The gate is on the SINK, not on individual call sites. Today nothing can
    // actually reach the push hook in this window — the path from here to the
    // subscription below contains no await, so no other task interleaves — and
    // gating each known call site would be equivalent. It is written this way
    // because that property is an accident of the current control flow: adding
    // one await above the subscription would silently reopen the ordering bug,
    // and a sink-level switch cannot be defeated that way.
    const preRunEvents: BaseEvent[] = [];
    const pendingWorkspaceReset = this.pendingWorkspaceResetNotices.get(session.sessionId);
    if (pendingWorkspaceReset) {
      preRunEvents.push(
        runtimeNoticeEvent({
          noticeId: pendingWorkspaceReset.noticeId,
          level: "warning",
          title: "Workspace reset",
          message: pendingWorkspaceReset.message,
          createdAt: new Date().toISOString()
        })
      );
    }
    let runStarted = false;
    const emitAGUI = (ev: BaseEvent) => {
      if (runStarted) queue.push(ev);
      else preRunEvents.push(ev);
    };
    // Out-of-band runtime notices use the active turn's AG-UI sink.
    state.activeTurnPush.current = emitAGUI;
    // Notices raised during onBeforeTurn, before the hook above existed.
    for (const buffered of state.pendingTurnEvents.splice(0)) emitAGUI(buffered);

    state.toolContextRef.current = input.toolContextId ?? null;
    state.policyContextRef.current = input.toolContextId
      ? {
          toolContextId: input.toolContextId,
          turnContext: input.turnContext ?? "interactive",
          enforcementMode: session.runtimePolicy.policyEnforcementMode
        }
      : null;
    const approvalTurn = this.approvalCoordinator.openTurn({
      identity: { tenantId: state.tenantId, userId: state.userId, sessionId: state.sessionId,
        runtimeId: state.runtimeId, turnId: responseId },
      projectId, durableNative: Boolean(state.execution), signal: turnAbort.signal,
      hasLocalActor: (actor) => {
        const current = this.sessions.get(state.sessionId);
        return current?.tenantId === actor.tenantId && current.userId === actor.userId;
      },
      validateLocalDecision: async (actor) => {
        const current = this.sessions.get(state.sessionId);
        if (!current || current.tenantId !== actor.tenantId || current.userId !== actor.userId)
          throw sessionOwnershipMismatch();
        await this.requireCurrentExecution(current);
      }
    });

    const effort = input.effort ?? defaultEffortForModel(modelId);

    // Record per-turn usage and cost on the assistant row keyed by responseId. The raw
    // streamEvents envelopes flow through the backend's streamTurn, so wrap it
    // to accumulate usage in-band without the driver needing to know.
    const usageTotals = createEmptyUsage();
    const usageModelName = resolveModelConstruction(modelId).vendorModel;
    // Priced per call: a long-context tier applies to one call's input, not to
    // the sum of the turn. Null when any call has no price.
    const usageCost: { usd: number | null } = { usd: 0 };

    const rawBackend = createSessionAGUITurnBackend({
      callbacks: spending ? [spending] : undefined,
      threadId: state.threadId,
      runtime: state.runtime,
      toolContextRef: state.toolContextRef,
      modelId,
      effort,
      promptText,
      conversationMessages,
      projectInstructions: input.projectInstructions,
      memoryContext,
      signal: turnAbort.signal,
      onGraphReady: async () => {
        // Availability is recorded once per turn, after MCP loading succeeds.
        // Empty-instruction skills are excluded by the library builder too.
        const resources = [
          ...state.configBundle.skills
            .filter((skill) => skill.instructions.trim())
            .map((skill) => ({
              resourceType: "skill" as const,
              resourceId: skill.id,
              metadata: { associatedToolIds: skill.associatedToolIds ?? [] }
            })),
          ...[...new Set(state.runtime.getMcpToolServers().values())].map((serverId) => ({
            resourceType: "mcp_server" as const,
            resourceId: serverId
          }))
        ];
        await this.stores.activationTracker?.recordMaterialization(
          { tenantId: state.tenantId, sessionId: state.sessionId, messageId: responseId },
          resources
        );
      },
      awaitDecisions: async (actions, emit) => {
        if (turnAbort.signal.aborted) {
          return actions.map(() => ({ type: "reject" as const, message: "Turn aborted." }));
        }
        // A scheduled turn has nobody to answer a prompt. Reject at once, so
        // the job does not hold its slot until the watchdog fails it.
        if (input.turnContext === "scheduled") {
          this.log.info(
            { sessionId: state.sessionId, toolNames: actions.map((action) => action.name) },
            "Rejected approval-gated tool calls in a scheduled turn"
          );
          return actions.map(() => ({
            type: "reject" as const,
            message: "This action needs approval. A scheduled job cannot ask for approval, so the action was not run."
          }));
        }
        // Human approval latency is bounded by APPROVAL_REQUEST_TTL_MS, not the
        // turn watchdog. Disarm while the prompt is pending, re-arm after.
        disarmWatchdog();
        try {
          return await this.collectApprovalDecisions({
            state,
            approvalTurn,
            actions,
            emit
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
          spending?.observeEvent(rawEvent);
          const callUsage = usageFromStreamEvent(rawEvent);
          if (callUsage) {
            addUsage(usageTotals, callUsage);
            const callCost = calculateCostUsd(usageModelName, callUsage);
            usageCost.usd = usageCost.usd === null || callCost === null ? null : usageCost.usd + callCost;
          }
          yield rawEvent;
        }
      }
    };

    const agent = new DeepAgentsAGUIAgent({
      backend,
      toolContextId: input.toolContextId ?? null,
      approvalAbortSignal: turnAbort.signal,
      // The approval round loop is unbounded, but both the
      // tool-context TTL and the active-turn staleness window budget for a
      // single approval. Extend both after each decision so a turn parked on
      // several approvals keeps its MCP tool access and is not stale-evicted
      // while still running. Failures are logged, never thrown: a missed
      // keepalive degrades the turn, an exception here would kill it.
      onApprovalRound: async (signal) => {
        if (signal?.aborted) return;
        this.stores.activeTurns?.keepAlive(state.sessionId);
        if (!input.toolContextId || !this.stores.toolContexts) return;
        if (signal?.aborted) return;
        try {
          const extended = await this.stores.toolContexts.extend(
            state.tenantId,
            input.toolContextId,
            this.config.TOOL_CONTEXT_TTL_MS
          );
          if (!extended) {
            this.log.warn(
              { sessionId: state.sessionId, toolContextId: input.toolContextId },
              "Tool context was already expired at the approval round; managed MCP tools will fail for the rest of this turn"
            );
          }
        } catch (err) {
          this.log.error(
            { err, sessionId: state.sessionId, toolContextId: input.toolContextId },
            "Failed to extend the tool context across an approval round"
          );
        }
      }
    });

    const subscription = agent
      .run({ threadId: state.threadId, runId: responseId, state: {}, messages: [] } as never)
      .subscribe({
        next: (event) => {
          queue.push(event);
          // The run's first event has now led the stream (RUN_STARTED, or
          // RUN_ERROR which the verifier also accepts), so held events are
          // legal from here. Flip the sink BEFORE draining so anything pushed
          // concurrently during the drain goes straight to the queue and cannot
          // be appended to a buffer nobody will read again.
          if (!runStarted) {
            runStarted = true;
            for (const pending of preRunEvents.splice(0)) queue.push(pending);
            if (
              pendingWorkspaceReset &&
              this.pendingWorkspaceResetNotices.get(session.sessionId)?.noticeId ===
                pendingWorkspaceReset.noticeId
            ) {
              this.clearPendingWorkspaceResetNotice(
                session.sessionId,
                pendingWorkspaceReset.noticeId
              );
            }
          }
        },
        error: (err: unknown) => {
          // Any error path means the run never emitted a first event, so the
          // `next` handler never flushed pre-run notices. They cannot be
          // emitted from here: a CUSTOM ahead of the terminal event would break
          // the verifier's RUN_STARTED-first rule that this buffering exists to
          // satisfy. Logged rather than dropped silently, and done BEFORE the
          // branch returns below so a watchdog timeout or a Stop is covered too.
          if (preRunEvents.length > 0) {
            this.log.warn(
              { sessionId: state.sessionId, dropped: preRunEvents.length },
              "Deep Agents AG-UI turn ended before its run started; pre-run notices were not delivered"
            );
            preRunEvents.length = 0;
          }
          // Watchdog expiry is a terminal FAILURE, not a user interrupt: emit
          // RUN_ERROR so the client surfaces it as an error/retry. Checked before the abort
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
          // stop, not a failure. Emitting RUN_ERROR would make
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

    // Token usage + cost must land on the row BEFORE the terminal frame reaches
    // the client: RUN_FINISHED / RUN_ERROR is what makes the frontend stop
    // streaming and refetch the message, so a flush in the `finally` below —
    // which only runs once the consumer has already written that frame to the
    // socket — races the refetch and can serve null tokens and null cost.
    // Memoized, so the `finally` stays a backstop for turns that ended without
    // a terminal event (an abandoned generator) rather than writing twice.
    let usageFlush: Promise<void> | null = null;
    const flushUsage = (): Promise<void> => {
      // Share the write and its deadline across terminal-event and final cleanup.
      usageFlush ??= withUsageFlushDeadline(
        Promise.all([finishSpending(), this.persistTurnUsage(state, responseId, usageTotals, usageModelName, usageCost.usd)]).then(() => undefined)
      );
      return usageFlush;
    };

    try {
      for await (const event of queue) {
        if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) {
          await flushUsage();
        }
        yield event;
      }
    } finally {
      endSandboxTurn();
      disarmWatchdog();
      subscription.unsubscribe();
      const wasAborted = turnAbort.signal.aborted;
      turnAbort.abort();
      if (wasAborted) approvalTurn.cancelAndExpire("turn_interrupted");
      else approvalTurn.cancelLocal();
      state.abortController.signal.removeEventListener("abort", onSessionAbort);
      input.cancelSignal?.removeEventListener("abort", onAdmissionAbort);
      state.activeTurnInterrupt.current = null;
      state.activeTurnPush.current = null;
      state.activeTurnResponseId.current = null;
      state.pendingTurnEvents = [];
      state.policyContextRef.current = null;
      // Record token usage + cumulative cost onto the assistant row (no-ops when
      // the turn consumed nothing or the writer created no backing row).
      await flushUsage();
      forgetSpending();
      this.activeTurns.delete(session.sessionId);
      await this.finishIntegrationInvalidation(state);
    }
  }

  private async persistTurnUsage(
    state: DeepAgentsSessionState,
    responseId: string,
    usage: TokenUsageRecord,
    modelName: string | null,
    costUsd: number | null
  ): Promise<void> {
    if (!this.stores.messages || usage.totalTokens === 0) return;
    try {
      // A resumed turn writes to the same message, so the cost is added too.
      await this.stores.messages.addTokenUsage(
        state.tenantId,
        responseId,
        state.userId,
        usage,
        modelName,
        costUsd
      );
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
    const state = this.requireSessionState(sessionId);
    await this.requireCurrentExecution(state);
    const runtime = state.runtime;
    if (!runtime.readFileBytes) {
      throw new Error("The Deep Agents runtime has no sandbox backend for file reads.");
    }
    return runtime.readFileBytes(filePath);
  }

  async statRuntimeFile(sessionId: string, filePath: string): Promise<{ sizeBytes: number }> {
    const state = this.requireSessionState(sessionId);
    await this.requireCurrentExecution(state);
    const runtime = state.runtime;
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
    const state = this.requireSessionState(sessionId);
    await this.requireCurrentExecution(state);
    const runtime = state.runtime;
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
    executionId?: string;
  }): Promise<void> {
    const state = this.sessions.get(input.sessionId);
    if (!state) return;
    if (input.executionId && state.execution?.executionId !== input.executionId) return;
    if (state.tenantId !== input.tenantId) throw sessionOwnershipMismatch();
    this.pendingIntegrationInvalidations.delete(input.sessionId);

    this.clearIdleTimer(state);
    state.abortController.abort();

    void this.approvalCoordinator.cancelPending({
      tenantId: state.tenantId, sessionId: state.sessionId, userId: state.userId, runtimeId: state.runtimeId
    }, "runtime_terminated");

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
      this.spending.delete(state.runtimeId);
    }
  }

  /**
   * Delete the session's checkpointer thread. Called after session or project
   * deletion. abortSession (idle teardown, invalidation) must keep the thread
   * so the conversation survives a warm-session recycle.
   * thread_id === sessionId by construction.
   */
  async purgeSessionData(input: {
    tenantId: string;
    sessionId: string;
    userId: string;
  }): Promise<void> {
    try {
      await this.stores.checkpointer?.deleteThread(input.sessionId);
    } finally {
      this.clearPendingWorkspaceResetNotice(input.sessionId);
    }
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
    this.approvalCoordinator.close();
    for (const sessionId of this.pendingWorkspaceResetNotices.keys()) {
      this.clearPendingWorkspaceResetNotice(sessionId);
    }
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
   * never interrupt a running conversation. Explicit integration/security
   * security invalidation keeps the abort-everything default. Tenant-setting changes use
   * the in-place next-turn capability refresh instead.
   */
  async invalidateTenantRuntimes(
    tenantId: string,
    opts?: { idleOnly?: boolean; workspaceResetReason?: string }
  ): Promise<string[]> {
    const targets = [...this.sessions.values()].filter(
      (state) =>
        state.tenantId === tenantId &&
        (!opts?.idleOnly || !this.activeTurns.has(state.sessionId))
    );
    await Promise.all(
      targets.map(async (state) => {
        await this.abortSession({
          tenantId: state.tenantId,
          sessionId: state.sessionId,
          userId: state.userId
        });
        if (opts?.workspaceResetReason) {
          this.queuePendingWorkspaceResetNotice(state.sessionId, opts.workspaceResetReason);
        }
      })
    );
    return targets.map((state) => state.sessionId);
  }

  async invalidateRuntimesForUser(tenantId: string, userId: string): Promise<string[]> {
    const targets = [...this.sessions.values()].filter(
      (state) => state.tenantId === tenantId && state.userId === userId
    );
    await Promise.all(
      targets.map(async (state) => {
        await this.abortSession({
          tenantId: state.tenantId,
          sessionId: state.sessionId,
          userId: state.userId
        });
        this.clearPendingWorkspaceResetNotice(state.sessionId);
      })
    );
    return targets.map((state) => state.sessionId);
  }

  private queuePendingWorkspaceResetNotice(sessionId: string, message: string): void {
    this.clearPendingWorkspaceResetNotice(sessionId);
    const noticeId = `workspace-reset:config:${uuidv7()}`;
    const expiryTimer = setTimeout(() => {
      this.clearPendingWorkspaceResetNotice(sessionId, noticeId);
    }, WORKSPACE_RESET_NOTICE_TTL_MS);
    expiryTimer.unref?.();
    this.pendingWorkspaceResetNotices.set(sessionId, { noticeId, message, expiryTimer });
  }

  private clearPendingWorkspaceResetNotice(sessionId: string, noticeId?: string): void {
    const pending = this.pendingWorkspaceResetNotices.get(sessionId);
    if (!pending || (noticeId !== undefined && pending.noticeId !== noticeId)) return;
    clearTimeout(pending.expiryTimer);
    this.pendingWorkspaceResetNotices.delete(sessionId);
  }

  async invalidateRuntimesForIntegration(
    tenantId: string,
    userId: string,
    _integrationId: string
  ): Promise<string[]> {
    const owned = [...this.sessions.values()].filter(
      (state) => state.tenantId === tenantId && state.userId === userId
    );
    const admittedTurns = this.stores.activeTurns?.snapshot();
    for (const state of owned) {
      if (this.activeTurns.has(state.sessionId) || admittedTurns?.has(state.sessionId)) {
        this.pendingIntegrationInvalidations.add(state.sessionId);
      }
    }
    const targets = owned.filter((state) => !this.pendingIntegrationInvalidations.has(state.sessionId));
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

  async finishTurnAdmission(input: { tenantId: string; sessionId: string; userId: string }): Promise<void> {
    const state = this.sessions.get(input.sessionId);
    if (!state) {
      this.pendingIntegrationInvalidations.delete(input.sessionId);
      return;
    }
    if (state.tenantId !== input.tenantId || state.userId !== input.userId) throw sessionOwnershipMismatch();
    if (!this.activeTurns.has(input.sessionId) && this.pendingIntegrationInvalidations.has(input.sessionId)) {
      await this.finishIntegrationInvalidation(state);
    }
  }

  private async finishIntegrationInvalidation(state: DeepAgentsSessionState): Promise<void> {
    if (this.pendingIntegrationInvalidations.delete(state.sessionId)) {
      await this.abortSession({
        tenantId: state.tenantId,
        sessionId: state.sessionId,
        userId: state.userId
      });
    } else {
      this.scheduleIdleTeardown(state);
    }
  }

  async resolveApproval(input: {
    tenantId: string;
    approvalId: string;
    userId: string;
    decision: RuntimeApprovalDecision;
    rememberForTurn?: boolean;
  }): Promise<"resolved" | "missing"> {
    return this.approvalCoordinator.decide(input);
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
   * The native checkpointed approval loop disarms this timer while a human
   * decides, then re-arms it with the remaining work budget.
   */
  private createTurnWatchdog(
    turnAbort: AbortController
  ): { arm: () => void; disarm: () => void; timedOut: () => boolean } {
    let timedOut = false;
    let watchdogTimer: NodeJS.Timeout | null = null;
    // Budget REMAINING, not elapsed. The watchdog measures time the turn spent
    // working, excluding time a human spent on approvals — but that budget must
    // be consumed, not refunded. Re-arming for the full duration after every
    // pause made the turn's wall-clock ceiling unbounded across repeated
    // approval rounds, which is what config's
    // TOOL_CONTEXT_TTL_MS > RUNTIME_TURN_TIMEOUT_MS + APPROVAL_REQUEST_TTL_MS
    // invariant assumes cannot happen. Tracking the remainder makes the total
    // working time a turn can accumulate exactly RUNTIME_TURN_TIMEOUT_MS,
    // however many times it pauses.
    let remainingMs = this.config.RUNTIME_TURN_TIMEOUT_MS;
    let armedAt: number | null = null;
    const disarm = () => {
      if (watchdogTimer) {
        clearTimeout(watchdogTimer);
        // Debit the time this arming actually ran for.
        if (armedAt !== null) remainingMs -= Date.now() - armedAt;
      }
      watchdogTimer = null;
      armedAt = null;
    };
    const arm = () => {
      disarm();
      if (this.config.RUNTIME_TURN_TIMEOUT_MS <= 0) return;
      const fire = () => {
        timedOut = true;
        turnAbort.abort();
      };
      // Budget already spent while paused-and-resumed repeatedly: fire now
      // rather than arming a zero/negative timer.
      if (remainingMs <= 0) {
        fire();
        return;
      }
      armedAt = Date.now();
      watchdogTimer = setTimeout(fire, remainingMs);
      watchdogTimer.unref?.();
    };
    return { arm, disarm, timedOut: () => timedOut };
  }

  /**
   * Stop awaiting setup as soon as the turn is cancelled. The callback still
   * receives the signal and should stop its own I/O, but this race is the hard
   * safety boundary for third-party callbacks that ignore cancellation. Its
   * rejection handler remains attached after abort, so a late failure cannot
   * become an unhandled rejection.
   */
  private waitForTurnSetup(setup: Promise<void>, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      void setup.catch(() => undefined);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      setup.then(
        () => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      );
    });
  }

  /**
   * One approval round-trip per pending HITL action. Auto-approves kinds the
   * user already remembered this turn (audited); everything else gets a DB
   * approval row plus an AG-UI `CUSTOM` event named `approval_required`, settled
   * by `POST /approvals/:id/decision` → {@link resolveApproval}, a TTL sweep
   * (reject + `approval.expired` audit + runtime notice), or turn abort
   * (reject). Decision order matches `actions` order — the HITL resume
   * contract.
   */
  private async collectApprovalDecisions(input: {
    state: DeepAgentsSessionState;
    approvalTurn: ApprovalTurn;
    actions: DeepAgentsPendingAction[];
    emit: (event: BaseEvent) => void;
  }): Promise<Array<{ type: "approve" } | { type: "reject"; message?: string }>> {
    const { state, approvalTurn, actions, emit } = input;
    const publish: ApprovalPublish = (notice) => emit(notice.name === "approval_required"
      ? approvalRequiredEvent(notice.value) : runtimeNoticeEvent(notice.value));
    // A tool that saves durable data is never asked about blind. Its card shows the
    // exact value, or the call is refused here with the reason and nobody is asked.
    const refusals = new Map<number, string>();
    const decisions = await Promise.all(
      actions.map(async (action, index) => {
        const serverId = state.runtime.getMcpToolServers().get(action.name);
        const server = state.configBundle.mcpServers.find((candidate) => candidate.id === serverId);
        const request: ApprovalRequest = { ...action, kind: this.classifyApprovalKind(state, action.name),
          server: server ? { id: server.id, mode: server.mode } : undefined };
        const durable = await this.prepareDurableWrite(state, request);
        if (durable.refusal !== undefined) {
          refusals.set(index, durable.refusal);
          return "reject" as const;
        }
        return approvalTurn.request(
          durable.durableWrite ? { ...request, durableWrite: durable.durableWrite } : request, publish);
      })
    );
    return decisions.map((decision, index) => {
      const refusal = refusals.get(index);
      if (refusal !== undefined) return { type: "reject" as const, message: refusal };
      if (decision === "approve") return { type: "approve" as const };
      // The message goes to the MODEL as the tool result. A denial nobody made
      // must not read as one: told "User denied permission" for an approval that
      // was never recorded, the model apologises for a refusal that did not
      // happen and reasons about a preference the user never expressed.
      return {
        type: "reject" as const,
        message:
          decision === "unavailable"
            ? "This action was blocked: its approval request could not be recorded."
            : decision === "expired"
              ? "This action was blocked because the approval request expired without an answer."
            : "User denied permission."
      };
    });
  }

  /**
   * Recalled memories for one turn as a labelled data message, or null. Memory is
   * a convenience: a failed read shows none and never fails the turn.
   */
  private async loadMemoryContext(
    state: DeepAgentsSessionState,
    runtimePolicy: RuntimeSessionRef["runtimePolicy"]
  ): Promise<string | null> {
    const memories = await loadWorkspaceMemories(this.stores.memories, {
      tenantId: state.tenantId,
      userId: state.userId,
      enabledToolIds: runtimePolicy.enabledToolIds,
      readPolicy: this.stores.policyService
        ? { policy: this.stores.policyService, enforcementMode: runtimePolicy.policyEnforcementMode }
        : undefined
    }, this.log);
    return buildMemoryDataContext(memories, runtimePolicy.enabledToolIds);
  }

  /**
   * For a managed tool that saves durable data (catalog flag `requiresUserApproval`),
   * builds the approval card with the exact value, or the reason to refuse the call.
   * Other tools pass through. Only a proof from the graph binds an approval to the
   * exact arguments. Without one, for example after a restart, the gateway would
   * refuse the call after the user approved it, so the user is not asked.
   */
  private async prepareDurableWrite(
    state: DeepAgentsSessionState,
    request: ApprovalRequest
  ): Promise<{ durableWrite?: DurableWriteApproval; refusal?: string }> {
    if (request.server?.mode !== "managed" || !this.managedToolCatalog?.get(request.name)?.requiresUserApproval) {
      return {};
    }
    if (!request.policyApproval) {
      return { refusal: "Nothing was saved: the approval could not be tied to this exact call. Ask again." };
    }
    if (request.name !== MEMORY_SAVE_TOOL || !this.stores.memories) {
      return { refusal: "Nothing was saved: this tool cannot show its exact value for approval." };
    }
    try {
      const prepared = await prepareMemorySaveApproval({
        memories: this.stores.memories, tenantId: state.tenantId, userId: state.userId, args: request.args
      });
      return prepared.ok
        ? { durableWrite: prepared.approval }
        : { refusal: `Nothing was saved: ${prepared.reason}` };
    } catch (err) {
      this.log.warn({ err, sessionId: state.sessionId, toolName: request.name },
        "Could not prepare the approval for a durable write; refusing it");
      return { refusal: "Nothing was saved: the approval request could not be prepared." };
    }
  }

  private classifyApprovalKind(
    state: DeepAgentsSessionState,
    toolName: string
  ): RuntimeApprovalKind {
    if (state.runtime.getMcpToolNames().has(toolName)) return "mcp_tool";
    if (toolName === "execute") return "command_execution";
    if (toolName === "write_file" || toolName === "edit_file" || toolName === "delete") return "file_change";
    return "permissions";
  }

  private async requireRuntimeSessionAccess(input: {
    tenantId: string; sessionId: string; userId: string; execution?: SessionExecution;
  }): Promise<string | null> {
    const [session, membershipRole] = await Promise.all([
      this.stores.sessions.getReadable(input.tenantId, input.sessionId, input.userId),
      this.stores.tenantMembers.getRole?.(input.tenantId, input.userId) ?? Promise.resolve("member")
    ]);
    if (!membershipRole || !session || session.status !== "active" || session.purpose === "project_reference" ||
        (session.projectId ? input.execution?.projectId !== session.projectId : Boolean(input.execution?.projectId))) {
      throw new SessionExecutionError("session_unavailable", 403);
    }
    return session.projectId;
  }

  private async requireCurrentExecution(state: DeepAgentsSessionState): Promise<void> {
    await this.requireRuntimeSessionAccess(state);
    if (!state.execution) return;
    if (!await this.stores.executions!.isCurrent(state.execution, state.runtimeId) ||
        this.sessions.get(state.sessionId) !== state || state.abortController.signal.aborted)
      throw new SessionExecutionError("execution_stopped", 403);
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

/**
 * The sandbox network policy for a tenant's approved hosts. Entries that fail
 * the host check are dropped, which approves less; the drop is logged.
 */
function sandboxNetworkPolicyFor(
  domains: readonly string[],
  log: FastifyBaseLogger,
  sessionId: string
) {
  return resolveSandboxNetworkPolicy(domains, (rejected) =>
    log.warn({ sessionId, rejected }, "Dropped approved sandbox hosts that fail the host check"));
}

function buildDeepAgentsRuntimeManifest(
  configBundle: DeepAgentsSessionState["configBundle"],
  sessionId: string,
  userId: string
): RuntimeManifest {
  const { runtimePolicy, skills, mcpServers, sources } = configBundle;
  const sandboxNetworkPolicy = resolveSandboxNetworkPolicy(runtimePolicy.sandboxEgressDomains);
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
      // What the provider is asked to enforce for this tenant's sandboxes, from
      // the same resolver that builds the sandbox options. The hash is the one
      // that is saved next to each sandbox id.
      networkMode: sandboxNetworkPolicy.mode,
      networkPolicyHash: sandboxNetworkPolicy.hash,
      allowCommandExecution: runtimePolicy.allowCommandExecution,
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
 * turn-transcript's classifyTurnFailure: Error instances with a 4xx status
 * pass through their message; other failures use a generic message. Review
 * classification and redaction separately: status alone does not prove that
 * the text is safe. GraphRecursionError has a fixed translation, selected by
 * name to keep this module free of LangChain imports.
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
 * Returns the usage of one model call from a stream event, or null. LangChain
 * puts `usage_metadata` on the AIMessage in `on_chat_model_end` envelopes
 * (`{ input_tokens, output_tokens, total_tokens, input_token_details?,
 * output_token_details? }`).
 */
function usageFromStreamEvent(rawEvent: Record<string, unknown>): TokenUsageRecord | null {
  if (rawEvent.event !== "on_chat_model_end") return null;
  const data = rawEvent.data as Record<string, unknown> | undefined;
  const output = data?.output as Record<string, unknown> | undefined;
  const usage = output?.usage_metadata as Record<string, unknown> | undefined;
  if (!usage) return null;

  const input = numberOrZero(usage.input_tokens);
  const outputTokens = numberOrZero(usage.output_tokens);
  const inputDetails = usage.input_token_details as Record<string, unknown> | undefined;
  const outputDetails = usage.output_token_details as Record<string, unknown> | undefined;

  return {
    inputTokens: input,
    outputTokens,
    cachedInputTokens: numberOrZero(inputDetails?.cache_read),
    reasoningOutputTokens: numberOrZero(outputDetails?.reasoning),
    totalTokens: numberOrZero(usage.total_tokens) || input + outputTokens
  };
}

function addUsage(totals: TokenUsageRecord, call: TokenUsageRecord): void {
  totals.inputTokens += call.inputTokens;
  totals.outputTokens += call.outputTokens;
  totals.cachedInputTokens += call.cachedInputTokens;
  totals.reasoningOutputTokens += call.reasoningOutputTokens;
  totals.totalTokens += call.totalTokens;
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
