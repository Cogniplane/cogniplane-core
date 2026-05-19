import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppConfig } from "../../config.js";
import type { AuditEventStore } from "../../services/audit-event-store.js";
import type { DynamicConfigService } from "../../services/dynamic-config-service.js";
import type { SessionJudgmentStore } from "../../services/session-judgment-store.js";
import type {
  JudgeProgressEvent,
  SessionJudgeWorker
} from "../../services/skills/judge/session-judge-worker.js";
import { isCorsOriginAllowed } from "../../lib/cors.js";
import { apiError } from "../../lib/http-errors.js";
import { createAdminAuditEvent, withAdmin } from "./admin-route-helpers.js";

/**
 * Curated list of small models that are reasonable for the LLM judge.
 *
 * The judge is invoked once per inactive session — across an active tenant
 * that's hundreds of sessions per day. Cost matters far more than capability:
 * a Haiku-class model is plenty for "did skill X get followed?" classification,
 * and using a flagship model would be ~10× the spend without measurably
 * improving precision/recall on this task.
 *
 * Kept here (not in `models.ts`) on purpose — chat-runtime models and
 * judge-suitable models are different concerns and the lists drift apart.
 */
type JudgeModelOption = {
  id: string;
  label: string;
  provider: "anthropic" | "openai";
  isDefault?: boolean;
  /** Human-friendly note shown in the UI. */
  hint?: string;
};

const JUDGE_MODELS: readonly JudgeModelOption[] = [
  {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    provider: "anthropic",
    isDefault: true,
    hint: "Smallest, cheapest. Recommended for most tenants."
  },
  {
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    provider: "anthropic",
    hint: "Higher accuracy, ~3× cost."
  },
  {
    id: "gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    provider: "openai",
    hint: "OpenAI's small model. Comparable to Haiku."
  },
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    provider: "openai",
    hint: "Flagship — only if Mini consistently misclassifies."
  }
];

const updateBodySchema = z.object({
  skillJudgeEnabled: z.boolean(),
  skillJudgeProvider: z.enum(["anthropic", "openai"]).nullable(),
  skillJudgeModel: z.string().trim().min(1).max(120).nullable(),
  skillJudgeMode: z.enum(["sync", "batch"])
});

const runQuerySchema = z.object({
  /** Optional override; defaults to the admin's own tenant. */
  scope: z.enum(["tenant"]).optional()
});

export type AdminSkillJudgeRouteStores = {
  config: AppConfig;
  dynamicConfig: DynamicConfigService;
  auditEvents: AuditEventStore;
  sessionJudgeWorker?: SessionJudgeWorker;
  sessionJudgments?: SessionJudgmentStore;
};

export async function registerAdminSkillJudgeRoutes(
  app: FastifyInstance,
  stores: AdminSkillJudgeRouteStores
): Promise<void> {
  app.get("/admin/skill-judge", withAdmin(app, async (request, _reply) => {
    const settings = await stores.dynamicConfig.getOrCreateTenantSettings(request.auth.tenantId);

    let eligibleNow = 0;
    // Sync rows mid-call. Should resolve in seconds; anything older than
    // SKILL_JUDGE_RUNNING_TIMEOUT_MS will be reaped on the next tick.
    let syncRunning = 0;
    // Batch rows awaiting their poll loop. Can legitimately stay here for
    // hours (Anthropic Batch has no SLA, max 24h).
    let batchPending = 0;
    let oldestBatchSubmittedAt: string | null = null;
    let recentFailures: Array<{ sessionId: string; error: string | null; completedAt: string | null }> = [];

    if (stores.sessionJudgments) {
      const eligibleRows = await stores.sessionJudgments.listSessionsToJudge(
        "skill_invocation",
        stores.config.SKILL_JUDGE_INACTIVE_BEFORE_MS,
        // Use a large cap purely for the count — the worker still respects
        // its per-tick limit during real runs.
        500,
        request.auth.tenantId
      );
      eligibleNow = eligibleRows.length;

      const inflightRows = await stores.sessionJudgments.listInflightForTenant(
        request.auth.tenantId,
        200
      );
      for (const row of inflightRows) {
        if (row.status === "running") {
          syncRunning += 1;
        } else if (row.status === "submitted") {
          batchPending += 1;
          if (!oldestBatchSubmittedAt || row.submittedAt < oldestBatchSubmittedAt) {
            oldestBatchSubmittedAt = row.submittedAt;
          }
        } else if (row.status === "failed") {
          // Failed rows shouldn't appear via listInflight (which filters
          // submitted/running), but be defensive in case the contract
          // changes.
          recentFailures.push({
            sessionId: row.sessionId,
            error: row.error,
            completedAt: row.completedAt
          });
        }
      }
      recentFailures = recentFailures.slice(0, 10);
    }

    return {
      settings: {
        skillJudgeEnabled: settings.skillJudgeEnabled,
        skillJudgeProvider: settings.skillJudgeProvider,
        skillJudgeModel: settings.skillJudgeModel,
        skillJudgeMode: settings.skillJudgeMode
      },
      availableModels: JUDGE_MODELS,
      platform: {
        workerEnabled: stores.config.SKILL_JUDGE_WORKER_ENABLED,
        pollIntervalMs: stores.config.SKILL_JUDGE_POLL_INTERVAL_MS,
        inactiveBeforeMs: stores.config.SKILL_JUDGE_INACTIVE_BEFORE_MS,
        maxSessionsPerTick: stores.config.SKILL_JUDGE_MAX_SESSIONS_PER_TICK
      },
      stats: {
        eligibleNow,
        syncRunning,
        batchPending,
        oldestBatchSubmittedAt,
        recentFailures
      }
    };
  }));

  app.put("/admin/skill-judge", withAdmin(app, async (request, reply) => {
    const parsed = updateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "validation_error",
        message: parsed.error.issues.map((i) => i.message).join(", ")
      });
    }

    const body = parsed.data;
    if (body.skillJudgeEnabled && (!body.skillJudgeProvider || !body.skillJudgeModel)) {
      return reply.status(400).send({
        error: "validation_error",
        message: "Cannot enable skill judge without a provider and model."
      });
    }
    if (body.skillJudgeProvider && body.skillJudgeModel) {
      const known = JUDGE_MODELS.find(
        (m) => m.id === body.skillJudgeModel && m.provider === body.skillJudgeProvider
      );
      if (!known) {
        return reply.status(400).send({
          error: "validation_error",
          message: "Selected model is not in the curated judge model list."
        });
      }
    }

    try {
      const settings = await stores.dynamicConfig.updateTenantSettings(request.auth.tenantId, {
        skillJudgeEnabled: body.skillJudgeEnabled,
        skillJudgeProvider: body.skillJudgeProvider,
        skillJudgeModel: body.skillJudgeModel,
        skillJudgeMode: body.skillJudgeMode
      });
      await createAdminAuditEvent(stores.auditEvents, {
        tenantId: request.auth.tenantId,
        userId: request.auth.userId,
        type: "admin.skill_judge.updated",
        payload: {
          skillJudgeEnabled: settings.skillJudgeEnabled,
          skillJudgeProvider: settings.skillJudgeProvider,
          skillJudgeModel: settings.skillJudgeModel,
          skillJudgeMode: settings.skillJudgeMode
        },
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]
      });
      return {
        settings: {
          skillJudgeEnabled: settings.skillJudgeEnabled,
          skillJudgeProvider: settings.skillJudgeProvider,
          skillJudgeModel: settings.skillJudgeModel,
          skillJudgeMode: settings.skillJudgeMode
        }
      };
    } catch (err) {
      return reply.status(400).send({
        error: "invalid_config",
        message: err instanceof Error ? err.message : "Failed to update skill judge settings."
      });
    }
  }));

  app.post("/admin/skill-judge/run", withAdmin(app, async (request, reply) => {
    if (!stores.sessionJudgeWorker) {
      reply.code(503);
      return apiError(
        "judge_worker_disabled",
        "The skill judge worker is not enabled on this instance (SKILL_JUDGE_WORKER_ENABLED=false)."
      );
    }

    const queryResult = runQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      reply.code(400);
      return apiError(
        "validation_error",
        queryResult.error.issues.map((i) => i.message).join(", ")
      );
    }

    const settings = await stores.dynamicConfig.getOrCreateTenantSettings(request.auth.tenantId);
    if (!settings.skillJudgeEnabled || !settings.skillJudgeProvider || !settings.skillJudgeModel) {
      reply.code(400);
      return apiError(
        "judge_not_configured",
        "Configure and enable the judge for this tenant before running it."
      );
    }

    // Hijack the socket and stream SSE — same pattern as the chat runtime
    // (sse-stream-writer.ts). @fastify/cors cannot intercept hijacked replies,
    // so CORS headers are set manually using the same allow-list check as
    // the plugin. Without these the browser drops the response on the floor
    // with NetworkError on cross-origin dev (frontend 3000 → backend 3001).
    reply.hijack();
    const raw = reply.raw;
    const requestOrigin = request.headers.origin;
    if (requestOrigin && isCorsOriginAllowed(requestOrigin, stores.config.API_ORIGIN)) {
      raw.setHeader("Access-Control-Allow-Origin", requestOrigin);
      raw.setHeader("Access-Control-Allow-Credentials", "true");
      raw.setHeader("Vary", "Origin");
    }
    raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    raw.setHeader("Cache-Control", "no-cache, no-transform");
    raw.setHeader("Connection", "keep-alive");
    raw.setHeader("X-Accel-Buffering", "no");
    raw.flushHeaders();

    const send = (event: string, data: unknown) => {
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let writerClosed = false;
    raw.on("close", () => {
      writerClosed = true;
    });

    try {
      await stores.sessionJudgeWorker.tick({
        tenantId: request.auth.tenantId,
        onProgress: (event: JudgeProgressEvent) => {
          if (writerClosed) return;
          send("progress", event);
        }
      });
      if (!writerClosed) send("done", { ok: true });
    } catch (err) {
      if (!writerClosed) {
        send("error", {
          message: err instanceof Error ? err.message : "Unknown error during tick."
        });
      }
    } finally {
      if (!writerClosed) raw.end();
    }

    await createAdminAuditEvent(stores.auditEvents, {
      tenantId: request.auth.tenantId,
      userId: request.auth.userId,
      type: "admin.skill_judge.executed",
      payload: { source: "manual" },
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    });
  }));
}
