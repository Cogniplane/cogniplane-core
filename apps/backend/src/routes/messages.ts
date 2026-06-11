import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { MessagePostRequestSchema } from "@cogniplane/shared-types";

import type { AppDependencies } from "../app-dependencies.js";
import { apiError, notFoundError, requestError } from "../lib/http-errors.js";
import { parseRequestInput } from "../lib/route-validation.js";
import { sseFrame, type RuntimeReasoningEffort } from "../runtime-contracts.js";
import type { RuntimeProvider } from "../services/admin-config-records.js";
import type { ArtifactRecord } from "../services/artifacts/artifact-store.js";
import type { PiiDecision } from "../services/pii/pii-protection-service.js";
import { PiiProtectionServiceError } from "../services/pii/pii-protection-service.js";
import { resolveRuntimeProviderAndModel } from "../services/runtime/runtime-provider-resolver.js";
import { streamAssistantReply } from "../services/sse-stream-writer.js";
import { generateSessionTitle } from "../services/session-titler.js";
import { calculateCostUsd } from "../services/token-cost-calculator.js";
import { isCorsOriginAllowed } from "../lib/cors.js";
import { handlePiiDecision } from "./messages-pii-handler.js";
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
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.flushHeaders();
}

// Wire shape lives in `@cogniplane/shared-types`; the route adds a stricter
// `model` check (allowlist via AVAILABLE_MODELS) that doesn't belong in the
// shared package — the frontend can't enumerate platform-internal model IDs
// without depending on the backend.
const sendMessageSchema = MessagePostRequestSchema.extend({
  model: z.enum(AVAILABLE_MODELS.map((m) => m.id) as [string, ...string[]]).optional()
});

export function buildMessageRouteStores(
  deps: AppDependencies,
  extras: {
    hasAnthropicApiKey: (tenantId: string) => Promise<boolean>;
    hasOpenaiApiKey: (tenantId: string) => Promise<boolean>;
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
    runtimeManager: deps.runtimeManager,
    dynamicConfig: deps.dynamicConfig,
    runtimeAdapters: deps.runtimeAdapters,
    hasAnthropicApiKey: extras.hasAnthropicApiKey,
    hasOpenaiApiKey: extras.hasOpenaiApiKey,
    getTenantAnthropicApiKey: deps.getTenantAnthropicApiKey,
    getTenantOpenaiApiKey: deps.getTenantOpenaiApiKey,
    piiProtection: deps.piiProtection,
    piiScanRuns: deps.piiScanRuns,
    auditEvents: deps.auditEvents,
    activeTurns: deps.activeTurns,
    activeTurnMessageMap: deps.activeTurnMessageMap
  };
}

export type MessageRouteStores = ReturnType<typeof buildMessageRouteStores>;

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

    // Resolve the correct runtime adapter early so hasActiveTurn checks the right provider.
    const resolution = await resolveRuntimeProviderAndModel({
      tenantId,
      requestedModel: input.model,
      requestedEffort: input.effort,
      defaultAdapter: stores.runtimeManager,
      stores: {
        dynamicConfig: stores.dynamicConfig,
        runtimeAdapters: stores.runtimeAdapters,
        hasAnthropicApiKey: stores.hasAnthropicApiKey,
        hasOpenaiApiKey: stores.hasOpenaiApiKey
      }
    });

    if (resolution.kind === "error") {
      reply.code(resolution.statusCode);
      return resolution.body;
    }

    const { runtimeAdapter, provider: resolvedProvider, selectedModel } = resolution;

    // Atomic turn-slot reservation. The adapter only flips `hasActiveTurn` to
    // true deep inside `runMessage`, which doesn't run until `streamAssistantReply`
    // far below — after several `await`s that persist the user message and burn
    // rate-limit/quota. Two requests racing on the same session would BOTH pass
    // an `hasActiveTurn`-only check and BOTH do those side effects before one
    // loses. `activeTurns` is the single-process, synchronous registry the stream
    // writer already marks for the turn's lifetime; check-and-mark it here with
    // NO `await` in between so the event loop cannot interleave a second request.
    // The loser returns 429 before persisting anything or consuming quota.
    //
    // We release the slot on every early-return path below, and the stream
    // writer clears it in its own `finally` once the turn ends. `activeTurns`
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

    // Everything past the reservation must release the slot on any early exit
    // (validation error, PII block, thrown error) UNLESS the turn was handed to
    // `streamAssistantReply`, which then owns the slot's lifetime and clears it
    // in its own `finally`.
    let handedOff = false;
    try {
    const sessionArtifacts = await stores.artifacts.listBySession(
      tenantId,
      input.sessionId,
      userId
    );
    // An artifact is eligible for chat context only when it is `ready` AND
    // its PII scan is not pending/scanning/blocked. This prevents an async
    // detect/transform scan that hasn't completed, or a blocked document,
    // from leaking into the prompt just because the row happens to be ready.
    const readyArtifacts = sessionArtifacts.filter((artifact) => {
      if (artifact.status !== "ready") return false;
      const piiStatus = (artifact.detail?.pii as { status?: string } | undefined)?.status;
      return piiStatus !== "pending" && piiStatus !== "scanning" && piiStatus !== "blocked";
    });
    const readyArtifactById = new Map(
      readyArtifacts.map((artifact) => [artifact.artifactId, artifact])
    );
    const selectedArtifactIds = input.artifactIds ? Array.from(new Set(input.artifactIds)) : [];

    if (input.artifactIds?.length) {
      for (const artifactId of selectedArtifactIds) {
        if (!readyArtifactById.has(artifactId)) {
          reply.code(400);
          return requestError([
            {
              path: "artifactIds",
              message: `Artifact ${artifactId} is not ready or is not available in this session.`
            }
          ]);
        }
      }
    }

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

    let piiDecision: PiiDecision | null = null;
    if (stores.piiProtection) {
      try {
        piiDecision = await stores.piiProtection.evaluateText({
          tenantId,
          text: input.text,
          subject: { kind: "chat_prompt" }
        });
      } catch (error) {
        if (error instanceof PiiProtectionServiceError) {
          request.log.warn(
            { err: error, tenantId, sessionId: input.sessionId },
            "PII provider unavailable; failing closed"
          );
          reply.code(503);
          return apiError(error.code, error.message);
        }
        throw error;
      }
    }

    const scopedArtifacts = selectedArtifactIds
      .map((artifactId) => readyArtifactById.get(artifactId))
      .filter((artifact): artifact is ArtifactRecord => Boolean(artifact));

    const piiOutcome = await handlePiiDecision(
      piiDecision,
      { tenantId, sessionId: input.sessionId, userId, rawText: input.text },
      { piiScanRuns: stores.piiScanRuns, auditEvents: stores.auditEvents }
    );

    if (piiOutcome.kind === "block") {
      // Persist a system message so the blocked event shows up in history —
      // the raw user prompt is NOT persisted.
      await stores.messages.create({
        tenantId,
        sessionId: input.sessionId,
        userId,
        role: "system",
        status: "completed",
        content: "Message blocked by organization policy.",
        detail: {
          pii: {
            status: "blocked",
            modeApplied: "block",
            blockReason: piiOutcome.blockReason,
            ...(piiOutcome.scanRunId ? { scanRunId: piiOutcome.scanRunId } : {})
          }
        }
      });

      // Frontend consumes /messages as an SSE stream; stay on that contract
      // and emit a terminal blocked frame so existing streamMessage() handlers
      // complete cleanly with the block payload visible to the UI.
      openSseResponse(app, request, reply);
      reply.raw.write(sseFrame("framework:message_blocked", {
        type: "framework:message_blocked",
        reason: "pii_block",
        block_reason: piiOutcome.blockReason,
        scan_run_id: piiOutcome.scanRunId,
        message: "Message blocked by organization policy."
      }));
      reply.raw.write(sseFrame("response.completed", {
        type: "response.completed",
        response: { id: null, status: "blocked" }
      }));
      reply.raw.end();
      return;
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

    const { persistedText: persistedUserText, runtimePrompt, userDetail, transformScanRunId } = piiOutcome;

    const persistedUserMessage = await stores.messages.create({
      tenantId,
      sessionId: input.sessionId,
      userId,
      role: "user",
      status: "completed",
      content: persistedUserText,
      ...(userDetail ? { detail: userDetail } : {})
    });

    const userMessageReplacement: { messageId: string; text: string; scanRunId?: string } | undefined =
      piiDecision?.action === "transform"
        ? {
            messageId: persistedUserMessage.messageId,
            text: persistedUserText,
            ...(transformScanRunId ? { scanRunId: transformScanRunId } : {})
          }
        : undefined;

    openSseResponse(app, request, reply);

    if (isUntitledSessionName(session.sessionName)) {
      request.log.info(
        { sessionId: input.sessionId, runtimeProvider: resolvedProvider, currentName: session.sessionName },
        "session titler triggered"
      );
      void titleSessionAsync({
        app,
        stores,
        tenantId,
        userId,
        sessionId: input.sessionId,
        currentSessionName: session.sessionName,
        runtimeProvider: resolvedProvider,
        firstMessage: persistedUserText,
        logger: request.log
      });
    }

    // From here the stream writer owns the reserved slot (it re-marks at turn
    // start and clears in its `finally`, whose try covers every await on the
    // hijacked reply). Mark handoff so this route's `finally` does not also
    // clear it. The throw-path release below is defense in depth — `clear()`
    // is idempotent, so it never double-frees a slot the writer already cleared.
    handedOff = true;
    try {
      await streamAssistantReply({
        logger: request.log,
        reply,
        messages: stores.messages,
        toolContexts: stores.toolContexts,
        runtimeManager: runtimeAdapter,
        tenantId: request.auth.tenantId,
        sessionId: input.sessionId,
        userId: request.auth.userId,
        modelName: selectedModel?.id ?? input.model ?? app.config.CODEX_MODEL,
        effort: input.effort as RuntimeReasoningEffort | undefined,
        prompt: runtimePrompt,
        scopedArtifacts,
        artifactProcessor: stores.artifactProcessor,
        storage: stores.storage,
        selectedArtifactIds,
        sourceArtifactNames: scopedArtifacts.map((artifact) => artifact.artifactName),
        userMessageReplacement,
        activeTurns: stores.activeTurns,
        activeTurnMessageMap: stores.activeTurnMessageMap,
        // Policy Center turn-context snapshot — this is an interactive turn (a
        // user in the loop); the scheduler passes turnContext: "scheduled".
        turnContext: "interactive"
      });
    } catch (streamError) {
      releaseSlot();
      throw streamError;
    }
    } finally {
      if (!handedOff) {
        releaseSlot();
      }
    }
  });
}

async function titleSessionAsync(input: {
  app: FastifyInstance;
  stores: MessageRouteStores;
  tenantId: string;
  userId: string;
  sessionId: string;
  currentSessionName: string;
  runtimeProvider: RuntimeProvider;
  firstMessage: string;
  logger: FastifyRequest["log"];
}): Promise<void> {
  const { app, stores, tenantId, userId, sessionId, currentSessionName, runtimeProvider, firstMessage, logger } = input;

  try {
    let anthropicApiKey: string | null = null;
    let openaiApiKey: string | null = null;

    if (runtimeProvider === "claude-code") {
      const tenantKey = stores.getTenantAnthropicApiKey
        ? (await stores.getTenantAnthropicApiKey(tenantId))?.trim() ?? null
        : null;
      anthropicApiKey = tenantKey || app.config.ANTHROPIC_API_KEY || null;
    } else {
      const tenantKey = stores.getTenantOpenaiApiKey
        ? (await stores.getTenantOpenaiApiKey(tenantId))?.trim() ?? null
        : null;
      openaiApiKey = tenantKey || app.config.OPENAI_API_KEY || null;
    }

    const result = await generateSessionTitle({
      runtimeProvider,
      firstMessage,
      keys: { anthropicApiKey, openaiApiKey },
      config: {
        claudeModel: app.config.SESSION_TITLER_CLAUDE_MODEL,
        codexModel: app.config.SESSION_TITLER_CODEX_MODEL,
        timeoutMs: app.config.SESSION_TITLER_TIMEOUT_MS
      }
    });

    if (!result) {
      logger.warn(
        { sessionId, runtimeProvider, hasAnthropicKey: Boolean(anthropicApiKey), hasOpenaiKey: Boolean(openaiApiKey) },
        "session titler skipped or failed"
      );
      return;
    }
    logger.info({ sessionId, runtimeProvider, title: result.title, tokens: result.tokenUsage.totalTokens }, "session titled");

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
        kind: "session_titling",
        runtimeProvider
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
