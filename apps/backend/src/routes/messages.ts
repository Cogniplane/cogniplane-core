import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { MessagePostRequestSchema } from "@cogniplane/shared-types";
import type { ModelProvider } from "@cogniplane/shared-types";

import type { AppDependencies } from "../app-dependencies.js";
import type { RuntimeAdapter } from "../runtime-contracts.js";
import { apiError, notFoundError, requestError } from "../lib/http-errors.js";
import { parseRequestInput } from "../lib/route-validation.js";
import { STATIC_SECURITY_HEADERS } from "../lib/security-headers.js";
import { EventType, type BaseEvent } from "@ag-ui/client";
import { uuidv7 } from "../lib/uuid.js";
import type { ArtifactRecord } from "../services/artifacts/artifact-store.js";
import { toAvailableModel } from "../services/custom-model-store.js";
import type { PiiDecision } from "../services/pii/pii-protection-service.js";
import { PiiProtectionServiceError } from "../services/pii/pii-protection-service.js";
import { resolveRuntimeModel } from "../services/runtime/runtime-model-resolver.js";
import { streamAssistantReplyAGUI } from "../services/sse-stream-writer-agui.js";
import { generateSessionTitle } from "../services/session-titler.js";
import { UtilityLlmClient } from "../services/utility-llm-client.js";
import { calculateCostUsd } from "../services/token-cost-calculator.js";
import { isCorsOriginAllowed } from "../lib/cors.js";
import { handlePiiDecision, type PiiHandlerOutcome, type PiiHandlerStores } from "./messages-pii-handler.js";
import { AVAILABLE_MODELS } from "../domain/models.js";

function openSseResponse(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply): void {
  // Fastify must be explicitly bypassed when we manage the raw SSE socket.
  reply.hijack();
  // @fastify/cors cannot intercept hijacked replies, so CORS headers are set
  // manually using the same isCorsOriginAllowed check as the plugin.
  const requestOrigin = request.headers.origin;
  if (requestOrigin && isCorsOriginAllowed(requestOrigin, app.config.API_ORIGIN)) {
    reply.raw.setHeader("Access-Control-Allow-Origin", requestOrigin);
    reply.raw.setHeader("Access-Control-Allow-Credentials", "true");
    reply.raw.setHeader("Vary", "Origin");
  }
  reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  // reply.hijack() bypasses the onSend security-headers hook, so set the same
  // static headers here to keep parity (otherwise CSP/HSTS/X-Frame are absent
  // on the SSE stream).
  for (const [name, value] of STATIC_SECURITY_HEADERS) {
    reply.raw.setHeader(name, value);
  }
  reply.raw.setHeader("X-Request-Id", request.id);
  reply.raw.setHeader("Cache-Control", "no-store, no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.flushHeaders();
}

// Wire shape lives in `@cogniplane/shared-types`. `model` is a bounded string
// here, NOT a static enum: the catalog is tenant-dependent (built-ins plus
// admin-added custom models), so membership is validated per-tenant by
// resolveRuntimeModel, which 400s unknown or disabled ids.
const sendMessageSchema = MessagePostRequestSchema.extend({
  model: z.string().trim().min(1).max(200).optional()
});

export function buildMessageRouteStores(
  deps: AppDependencies,
  extras: {
    hasProviderKey: (tenantId: string, provider: ModelProvider) => Promise<boolean>;
  }
) {
  return {
    sessions: deps.sessions,
    artifacts: deps.artifacts,
    artifactProcessor: deps.artifactProcessor,
    storage: deps.artifactStorage,
    limits: deps.limits,
    messages: deps.messages,
    toolContexts: deps.toolContexts,
    dynamicConfig: deps.dynamicConfig,
    customModels: deps.customModels,
    runtimeAdapter: deps.runtimeAdapter,
    hasProviderKey: extras.hasProviderKey,
    getTenantAnthropicApiKey: deps.getTenantAnthropicApiKey,
    piiProtection: deps.piiProtection,
    piiScanRuns: deps.piiScanRuns,
    auditEvents: deps.auditEvents,
    activeTurns: deps.activeTurns
  };
}

export type MessageRouteStores = {
  sessions: Pick<AppDependencies["sessions"], "getOwned" | "renameIfCurrent">;
  artifacts: Pick<AppDependencies["artifacts"], "listBySession">;
  artifactProcessor: Pick<AppDependencies["artifactProcessor"], "extractArtifactText">;
  storage: AppDependencies["artifactStorage"];
  limits: AppDependencies["limits"];
  messages: Pick<AppDependencies["messages"], "create" | "addTokenUsage" | "setCostUsd" | "updateContent" | "updateStreamingContent" | "upsertToolResult">;
  toolContexts: Pick<AppDependencies["toolContexts"], "create">;
  dynamicConfig: Pick<AppDependencies["dynamicConfig"], "getOrCreateTenantSettings">;
  customModels: Pick<AppDependencies["customModels"], "list">;
  runtimeAdapter: RuntimeAdapter;
  hasProviderKey: (tenantId: string, provider: ModelProvider) => Promise<boolean>;
  getTenantAnthropicApiKey: AppDependencies["getTenantAnthropicApiKey"];
  piiProtection: Pick<NonNullable<AppDependencies["piiProtection"]>, "evaluateText"> | undefined;
  piiScanRuns: PiiHandlerStores["piiScanRuns"];
  auditEvents: Pick<AppDependencies["auditEvents"], "create">;
  activeTurns: AppDependencies["activeTurns"];
};

const DEFAULT_MODEL_ID =
  AVAILABLE_MODELS.find((m) => m.isDefault)?.id ?? AVAILABLE_MODELS[0]!.id;

const DEFAULT_SESSION_NAME = "New session";
const AUTO_NAMED_SESSION_PATTERN = /^Session \d+$/;

function isUntitledSessionName(name: string): boolean {
  return name === DEFAULT_SESSION_NAME || AUTO_NAMED_SESSION_PATTERN.test(name);
}

export async function registerMessageRoutes(
  app: FastifyInstance,
  stores: MessageRouteStores
): Promise<void> {
  app.post("/messages", async (request, reply) => {
    const inputResult = parseRequestInput(reply, sendMessageSchema, request.body);
    if (!inputResult.ok) {
      return inputResult.response;
    }

    const { userId, tenantId } = request.auth;
    const input = inputResult.value;

    const session = await stores.sessions.getOwned(tenantId, input.sessionId, userId);

    if (!session || session.status !== "active") {
      reply.code(404);
      return notFoundError("session_not_found");
    }

    const resolution = await resolveRuntimeModel({
      tenantId,
      requestedModel: input.model,
      requestedEffort: input.effort,
      runtimeAdapter: stores.runtimeAdapter,
      stores: {
        hasProviderKey: stores.hasProviderKey,
        // Admin-controlled provider/model enablement + default-effort
        // overrides (tenant_settings). Gates disabled models even on direct
        // API calls that bypass the /models-filtered picker.
        getModelAvailability: (tenantId) =>
          stores.dynamicConfig.getOrCreateTenantSettings(tenantId),
        // Built-ins + this tenant's admin-added custom models.
        listModels: async (tenantId) => [
          ...AVAILABLE_MODELS,
          ...(stores.customModels
            ? (await stores.customModels.list(tenantId)).map(toAvailableModel)
            : [])
        ]
      }
    });

    if (resolution.kind === "error") {
      reply.code(resolution.statusCode);
      return resolution.body;
    }

    const { runtimeAdapter, selectedModel, selectedEffort } = resolution;

    // Atomic turn-slot reservation. The adapter only flips `hasActiveTurn` deep
    // inside `runMessageAGUI`, after several awaits that persist the user message and burn
    // rate-limit/quota. Two requests racing on the same session would BOTH pass
    // an `hasActiveTurn`-only check and BOTH do those side effects before one
    // loses. `activeTurns` is the single-process, synchronous registry the stream
    // writer already marks for the turn's lifetime; check-and-mark it here with
    // NO `await` in between so the event loop cannot interleave a second request.
    // The loser returns 429 before persisting anything or consuming quota.
    //
    // We release the slot on every path below. `activeTurns`
    // is optional only in the in-memory test harness; when absent we fall back
    // to the adapter check alone (single-process, best-effort).
    const reservedSessionId = input.sessionId;
    let slotReserved = false;
    const releaseSlot = () => {
      if (slotReserved) {
        stores.activeTurns?.clear(reservedSessionId);
        slotReserved = false;
      }
    };

    // OR source-order is not priority: `activeTurns` is the primary guard (see
    // above), the adapter check is the best-effort fallback.
    const alreadyBusy =
      runtimeAdapter.hasActiveTurn(input.sessionId) ||
      (stores.activeTurns?.snapshot().has(input.sessionId) ?? false);
    if (alreadyBusy) {
      reply.code(429);
      return apiError("session_busy");
    }
    if (stores.activeTurns) {
      stores.activeTurns.mark(input.sessionId);
      slotReserved = true;
    }

    // Everything past the reservation releases the slot on early exit or after
    // the AG-UI stream finishes.
    try {
        const artifactScope = await resolveEligibleArtifacts(reply, stores, {
        tenantId,
        sessionId: input.sessionId,
        userId,
        requestedArtifactIds: input.artifactIds
      });
      if (!artifactScope.ok) {
        return artifactScope.response;
      }
      const { readyArtifactById, selectedArtifactIds } = artifactScope;

      // The rate limit is consumed BEFORE the PII evaluation so the PII provider
      // (an LLM call) cannot be triggered by an over-limit user, and so probing
      // the PII filter costs a rate-limit token per attempt. The daily turn
      // quota is only consumed AFTER the PII gate: a blocked turn (or a provider
      // 503 fail-closed) never burns quota for a turn that was never dispatched.
      const rateLimitError = await stores.limits.consumeRateLimit({
        resource: "message_turn",
        userId: request.auth.userId,
        tenantId: request.auth.tenantId
      });
      if (rateLimitError) {
        reply.code(429);
        reply.header("retry-after", Math.max(1, Math.ceil(rateLimitError.retryAfterMs / 1000)));
        return rateLimitError;
      }

      const piiEvaluation = await evaluatePiiDecisionOrFailClosed(request, reply, stores, {
        tenantId,
        sessionId: input.sessionId,
        text: input.text
      });
      if (!piiEvaluation.ok) {
        return piiEvaluation.response;
      }
      const { piiDecision } = piiEvaluation;

      const scopedArtifacts = selectedArtifactIds
        .map((artifactId) => readyArtifactById.get(artifactId))
        .filter((artifact): artifact is ArtifactRecord => Boolean(artifact));

      const piiOutcome = await handlePiiDecision(
        piiDecision,
        { tenantId, sessionId: input.sessionId, userId, rawText: input.text },
        { piiScanRuns: stores.piiScanRuns, auditEvents: stores.auditEvents }
      );

      if (piiOutcome.kind === "block") {
        return respondWithPiiBlock({
          app,
          request,
          reply,
          stores,
          tenantId,
          sessionId: input.sessionId,
          userId,
          outcome: piiOutcome
        });
      }

      // Past the PII gate: this turn will actually be dispatched, so it now
      // spends a daily-quota unit.
      const quotaError = await stores.limits.consumeTurnQuota({
        userId: request.auth.userId,
        tenantId: request.auth.tenantId
      });
      if (quotaError) {
        reply.code(429);
        reply.header("retry-after", Math.max(1, Math.ceil(quotaError.retryAfterMs / 1000)));
        return quotaError;
      }

      const { persistedText: persistedUserText, runtimePrompt } = piiOutcome;
      const { userMessageReplacement } = await persistUserTurnMessage(stores, {
        tenantId,
        sessionId: input.sessionId,
        userId,
        piiOutcome,
        piiDecision
      });

      openSseResponse(app, request, reply);

      // Session auto-titling is fire-and-forget and uses the persisted user message.
      if (isUntitledSessionName(session.sessionName)) {
        request.log.info(
          { sessionId: input.sessionId, currentName: session.sessionName },
          "session titler triggered"
        );
        void titleSessionAsync({
          app,
          stores,
          tenantId,
          userId,
          sessionId: input.sessionId,
          currentSessionName: session.sessionName,
          firstMessage: persistedUserText,
          logger: request.log
        });
      }

      await streamAssistantReplyAGUI({
        logger: request.log,
        reply,
        messages: stores.messages,
        toolContexts: stores.toolContexts,
        runtimeAdapter,
        tenantId: request.auth.tenantId,
        sessionId: input.sessionId,
        userId: request.auth.userId,
        modelName: selectedModel?.id ?? input.model ?? DEFAULT_MODEL_ID,
        effort: selectedEffort,
        prompt: runtimePrompt,
        scopedArtifacts,
        artifactProcessor: stores.artifactProcessor,
        storage: stores.storage,
        selectedArtifactIds,
        userMessageReplacement,
        turnContext: "interactive",
        toolContextTtlMs: app.config.TOOL_CONTEXT_TTL_MS
      });
    } finally {
      releaseSlot();
    }
  });
}

// An artifact is eligible for chat context only when it is `ready` AND its
// PII scan is not pending/scanning/blocked. This prevents an async
// detect/transform scan that hasn't completed, or a blocked document, from
// leaking into the prompt just because the row happens to be ready.
async function resolveEligibleArtifacts(
  reply: FastifyReply,
  stores: MessageRouteStores,
  input: { tenantId: string; sessionId: string; userId: string; requestedArtifactIds?: string[] }
): Promise<
  | { ok: false; response: unknown }
  | { ok: true; readyArtifactById: Map<string, ArtifactRecord>; selectedArtifactIds: string[] }
> {
  const sessionArtifacts = await stores.artifacts.listBySession(
    input.tenantId,
    input.sessionId,
    input.userId
  );
  const readyArtifacts = sessionArtifacts.filter((artifact) => {
    if (artifact.status !== "ready") return false;
    const piiStatus = (artifact.detail?.pii as { status?: string } | undefined)?.status;
    return piiStatus !== "pending" && piiStatus !== "scanning" && piiStatus !== "blocked";
  });
  const readyArtifactById = new Map(
    readyArtifacts.map((artifact) => [artifact.artifactId, artifact])
  );
  const selectedArtifactIds = input.requestedArtifactIds
    ? Array.from(new Set(input.requestedArtifactIds))
    : [];

  for (const artifactId of selectedArtifactIds) {
    if (!readyArtifactById.has(artifactId)) {
      reply.code(400);
      return {
        ok: false,
        response: requestError([
          {
            path: "artifactIds",
            message: `Artifact ${artifactId} is not ready or is not available in this session.`
          }
        ])
      };
    }
  }

  return { ok: true, readyArtifactById, selectedArtifactIds };
}

// Fail closed when the PII provider is unavailable: a 503 is returned rather
// than letting an unscanned prompt through. A null decision means PII
// protection is not configured for this deployment.
async function evaluatePiiDecisionOrFailClosed(
  request: FastifyRequest,
  reply: FastifyReply,
  stores: MessageRouteStores,
  input: { tenantId: string; sessionId: string; text: string }
): Promise<{ ok: false; response: unknown } | { ok: true; piiDecision: PiiDecision | null }> {
  if (!stores.piiProtection) {
    return { ok: true, piiDecision: null };
  }
  try {
    const piiDecision = await stores.piiProtection.evaluateText({
      tenantId: input.tenantId,
      text: input.text,
      subject: { kind: "chat_prompt" }
    });
    return { ok: true, piiDecision };
  } catch (error) {
    if (error instanceof PiiProtectionServiceError) {
      request.log.warn(
        { err: error, tenantId: input.tenantId, sessionId: input.sessionId },
        "PII provider unavailable; failing closed"
      );
      reply.code(503);
      return { ok: false, response: apiError(error.code, error.message) };
    }
    throw error;
  }
}

async function respondWithPiiBlock(args: {
  app: FastifyInstance;
  request: FastifyRequest;
  reply: FastifyReply;
  stores: MessageRouteStores;
  tenantId: string;
  sessionId: string;
  userId: string;
  outcome: Extract<PiiHandlerOutcome, { kind: "block" }>;
}): Promise<void> {
  const { app, request, reply, stores, tenantId, sessionId, userId, outcome } = args;

  const blockMessage = "Message blocked by organization policy.";

  // Persist a system message so the blocked event shows up in history —
  // the raw user prompt is NOT persisted.
  await stores.messages.create({
    tenantId,
    sessionId,
    userId,
    role: "system",
    status: "completed",
    content: blockMessage,
    detail: {
      pii: {
        status: "blocked",
        modeApplied: "block",
        blockReason: outcome.blockReason,
        ...(outcome.scanRunId ? { scanRunId: outcome.scanRunId } : {})
      }
    }
  });

  openSseResponse(app, request, reply);

  const runId = uuidv7();
  const messageId = uuidv7();
  const aguiFrame = (event: BaseEvent) => `data: ${JSON.stringify(event)}\n\n`;
  reply.raw.write(aguiFrame({ type: EventType.RUN_STARTED, threadId: sessionId, runId } as BaseEvent));
  reply.raw.write(
    aguiFrame({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" } as BaseEvent)
  );
  reply.raw.write(
    aguiFrame({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: blockMessage } as BaseEvent)
  );
  reply.raw.write(aguiFrame({ type: EventType.TEXT_MESSAGE_END, messageId } as BaseEvent));
  reply.raw.write(aguiFrame({ type: EventType.RUN_FINISHED, threadId: sessionId, runId } as BaseEvent));
  reply.raw.end();
}

async function persistUserTurnMessage(
  stores: MessageRouteStores,
  input: {
    tenantId: string;
    sessionId: string;
    userId: string;
    piiOutcome: Extract<PiiHandlerOutcome, { kind: "continue" }>;
    piiDecision: PiiDecision | null;
  }
): Promise<{
  userMessageReplacement: { messageId: string; text: string; scanRunId?: string } | undefined;
}> {
  const { tenantId, sessionId, userId, piiOutcome, piiDecision } = input;

  const persistedUserMessage = await stores.messages.create({
    tenantId,
    sessionId,
    userId,
    role: "user",
    status: "completed",
    content: piiOutcome.persistedText,
    ...(piiOutcome.userDetail ? { detail: piiOutcome.userDetail } : {})
  });

  const userMessageReplacement =
    piiDecision?.action === "transform"
      ? {
          messageId: persistedUserMessage.messageId,
          text: piiOutcome.persistedText,
          ...(piiOutcome.transformScanRunId ? { scanRunId: piiOutcome.transformScanRunId } : {})
        }
      : undefined;

  return { userMessageReplacement };
}

async function titleSessionAsync(input: {
  app: FastifyInstance;
  stores: MessageRouteStores;
  tenantId: string;
  userId: string;
  sessionId: string;
  currentSessionName: string;
  firstMessage: string;
  logger: FastifyRequest["log"];
}): Promise<void> {
  const { app, stores, tenantId, userId, sessionId, currentSessionName, firstMessage, logger } = input;

  try {
    const tenantKey = stores.getTenantAnthropicApiKey
      ? (await stores.getTenantAnthropicApiKey(tenantId))?.trim() ?? null
      : null;
    const anthropicApiKey = tenantKey || app.config.ANTHROPIC_API_KEY || null;

    // Local-first titling: when UTILITY_LLM_* is configured (the homelab demo
    // points it at the local Gemma on Ollama), the raw first message goes to
    // the operator-run endpoint instead of a third-party API. Only if that path
    // is absent/fails does generateSessionTitle fall back to the Anthropic API
    // (best-effort — a non-Anthropic-only tenant simply skips titling, since
    // titles are non-critical and the Gemma path covers the demo).
    const utilityClient =
      app.config.UTILITY_LLM_ENABLED && app.config.UTILITY_LLM_BASE_URL && app.config.UTILITY_LLM_MODEL
        ? new UtilityLlmClient({
            baseUrl: app.config.UTILITY_LLM_BASE_URL,
            apiKey: app.config.UTILITY_LLM_API_KEY,
            model: app.config.UTILITY_LLM_MODEL,
            timeoutMs: app.config.UTILITY_LLM_TIMEOUT_MS,
            wireFormat: app.config.UTILITY_LLM_WIRE_FORMAT,
            disableThinking: app.config.UTILITY_LLM_DISABLE_THINKING
          })
        : undefined;

    const result = await generateSessionTitle({
      firstMessage,
      keys: { anthropicApiKey },
      config: {
        claudeModel: app.config.SESSION_TITLER_CLAUDE_MODEL,
        timeoutMs: app.config.SESSION_TITLER_TIMEOUT_MS
      },
      utilityClient
    });

    if (!result) {
      logger.warn(
        { sessionId, hasAnthropicKey: Boolean(anthropicApiKey) },
        "session titler skipped or failed"
      );
      return;
    }
    logger.info({ sessionId, title: result.title, tokens: result.tokenUsage.totalTokens }, "session titled");

    const renamed = await stores.sessions.renameIfCurrent(
      tenantId,
      sessionId,
      userId,
      currentSessionName,
      result.title
    );
    if (!renamed) {
      logger.debug(
        { sessionId },
        "session already renamed by another turn; skipping titling attribution"
      );
      return;
    }

    const titlingMessage = await stores.messages.create({
      tenantId,
      sessionId,
      userId,
      role: "system",
      status: "completed",
      content: result.title,
      detail: {
        kind: "session_titling"
      }
    });
    // Titler is a backend-direct LLM call (not routed through the proxy),
    // so we still write its usage here. The titling message is freshly
    // created with zero counters, so addTokenUsage = set.
    await stores.messages.addTokenUsage(
      tenantId,
      titlingMessage.messageId,
      userId,
      result.tokenUsage,
      result.modelName
    );
    await stores.messages.setCostUsd(
      tenantId,
      titlingMessage.messageId,
      userId,
      calculateCostUsd(result.modelName, result.tokenUsage)
    );
  } catch (err) {
    logger.warn({ err, sessionId }, "session titling failed");
  }
}
