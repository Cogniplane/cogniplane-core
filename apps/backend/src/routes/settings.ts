
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  ScheduledJobEnvelopeSchema,
  ScheduledJobPreviewRequestSchema,
  ScheduledJobPreviewResponseSchema,
  ScheduledJobRequestSchema,
  ScheduledJobRunsListResponseSchema,
  ScheduledJobsListResponseSchema,
  UserSettingsSectionEnvelopeSchema,
  UserSettingsSectionsResponseSchema
} from "@cogniplane/shared-types";

import { uuidv7 } from "../lib/uuid.js";

import { computeNextCronRunAt } from "../lib/cron.js";
import { ensureUser, withTenantScope } from "../lib/db.js";
import { apiError, getErrorMessage, notFoundError, requestError } from "../lib/http-errors.js";
import { jobIdParams } from "../lib/route-schemas.js";
import { parseRequestInput } from "../lib/route-validation.js";
import { serialize } from "../lib/serialize-response.js";
import type { AppConfig } from "../config.js";
import type { AppDependencies } from "../app-dependencies.js";
import type { IntegrationRegistryService } from "../services/integrations/integration-registry-service.js";
import type { AuditEventStore } from "../services/audit-event-store.js";
import type { RequestLimitsInterface } from "../services/request-limits.js";
import { PiiProtectionServiceError, type PiiProtectionService } from "../services/pii/pii-protection-service.js";
import { scheduledJobPrompt } from "../services/scheduler-worker.js";
import { requestSecurityVersion } from "../services/auth/security-change.js";
import {
  userSettingsSectionKeys,
  type ScheduledJobOwnerSession,
  type ScheduledJobRecord,
  type UserSettingsStore
} from "../services/user-settings-store.js";

import {
  buildScheduledJobAuditPayload,
  buildSectionSummaries,
  getSectionTitle,
  isLiveSettingsSection
} from "./settings-helpers.js";

const sectionKeySchema = z.enum(userSettingsSectionKeys);

const settingsSectionBodySchema = z.object({
  config: z.record(z.string(), z.unknown())
});

/**
 * Byte limit of one settings section save, 64 KiB. Fastify checks the raw
 * request body before it parses it: it refuses a Content-Length over the
 * limit and stops reading when more bytes arrive. The route then checks the
 * text that it stores, `JSON.stringify(config)` in UTF-8, because parsing can
 * make that text longer than the body: `1e20` becomes 21 digits. Each check
 * accepts exactly this many bytes.
 */
export const SETTINGS_SECTION_MAX_BYTES = 64 * 1024;

function settingsSectionTooLargeError() {
  return apiError("settings_section_too_large", "The settings section is larger than the 64 KiB limit.");
}

type ScheduledJobBody = z.output<typeof ScheduledJobRequestSchema>;

function buildInvalidScheduledJobConfigError(error: unknown) {
  return requestError([
    {
      path: "cronExpression",
      message: getErrorMessage(error, "Invalid scheduled job configuration.")
    }
  ]);
}

function buildScheduledJobPersistenceInput(tenantId: string, userId: string, body: ScheduledJobBody) {
  const nextRunAt = body.enabled ? computeNextCronRunAt(body.cronExpression, body.timeZone) : null;

  return {
    tenantId,
    userId,
    jobName: body.jobName,
    description: body.description ?? null,
    cronExpression: body.cronExpression,
    timeZone: body.timeZone,
    targetType: body.targetType,
    targetRef: body.targetRef ?? null,
    input: body.input,
    // No code reads a job's settings snapshot: the scheduler runs a job from
    // its own fields. So a new or edited job copies no settings section, and
    // a large section cannot make the job row larger. A job that an earlier
    // version saved keeps its snapshot until its next edit.
    settingsSnapshot: {},
    enabled: body.enabled,
    nextRunAt
  };
}

function resolveScheduledJobPersistenceInput(
  reply: FastifyReply,
  tenantId: string,
  userId: string,
  body: unknown
) {
  const bodyResult = parseRequestInput(reply, ScheduledJobRequestSchema, body);
  if (!bodyResult.ok) {
    return bodyResult;
  }

  try {
    return {
      ok: true as const,
      value: buildScheduledJobPersistenceInput(tenantId, userId, bodyResult.value)
    };
  } catch (error) {
    reply.code(400);
    return {
      ok: false as const,
      response: buildInvalidScheduledJobConfigError(error)
    };
  }
}

// The security version of the session that saves the job. The scheduler
// pauses the job after a later security change of the account (password
// change or reset, sign out everywhere), so a job that a stolen access token
// saved stops acting as the owner. requestSecurityVersion has the rule for a
// WorkOS session (null) and for AUTH_MODE=dev-headers (the version now).
async function scheduledJobOwnerSession(
  request: FastifyRequest,
  stores: Pick<SettingsRouteStores, "settings" | "config">
): Promise<ScheduledJobOwnerSession> {
  return {
    ownerSecurityVersion: await requestSecurityVersion(request.auth, stores.config.AUTH_MODE, (tenantId, userId) =>
      stores.settings.getOwnerSecurityVersion(tenantId, userId))
  };
}

// Tell the owner at save time that the policy blocks the prompt. This is a
// convenience only: the worker checks again at every run, because the policy
// can change. An outage does not stop the save for the same reason.
async function rejectBlockedScheduledPrompt(
  reply: FastifyReply,
  piiProtection: SettingsRouteStores["piiProtection"],
  tenantId: string,
  job: { enabled: boolean; input: ScheduledJobRecord["input"] }
): Promise<unknown | null> {
  // A disabled job does not run, and the owner must be able to disable a
  // job whose prompt a new policy blocks.
  if (!piiProtection || !job.enabled) return null;
  try {
    const decision = await piiProtection.evaluateText({
      tenantId,
      text: scheduledJobPrompt(job.input),
      subject: { kind: "chat_prompt" }
    });
    if (decision.action !== "block") return null;
    reply.code(422);
    return apiError(
      "pii_block",
      `The prompt is blocked by organization policy (${decision.blockReason}). Edit it before you save the job.`
    );
  } catch (error) {
    if (error instanceof PiiProtectionServiceError) return null;
    throw error;
  }
}

export function buildSettingsRouteStores(deps: AppDependencies, extras: { config: AppConfig }) {
  return {
    settings: deps.userSettings,
    auditEvents: deps.auditEvents,
    config: extras.config,
    integrationRegistry: deps.integrationRegistry,
    limits: deps.limits,
    piiProtection: deps.piiProtection
  };
}

export type SettingsRouteStores = {
  settings: Pick<
    UserSettingsStore,
    | "listSections"
    | "upsertSection"
    | "listScheduledJobs"
    | "getScheduledJob"
    | "createScheduledJob"
    | "updateScheduledJob"
    | "deleteScheduledJob"
    | "listJobRuns"
    | "getOwnerSecurityVersion"
  >;
  auditEvents: Pick<AuditEventStore, "create">;
  config: AppConfig;
  integrationRegistry: Pick<IntegrationRegistryService, "getIntegrationsForUser">;
  limits: RequestLimitsInterface;
  // The save-time check records nothing, so it needs only the decision.
  piiProtection?: Pick<PiiProtectionService, "evaluateText">;
};

export async function registerSettingsRoutes(
  app: FastifyInstance,
  stores: SettingsRouteStores
): Promise<void> {
  app.get("/me/settings", async (request) => {
    const { userId, tenantId } = request.auth;
    await ensureUser(app.db, userId);
    const sections = await stores.settings.listSections(tenantId, userId);
    return serialize(UserSettingsSectionsResponseSchema, {
      sections: buildSectionSummaries(sections)
    });
  });

  app.put("/me/settings/:section", {
    bodyLimit: SETTINGS_SECTION_MAX_BYTES,
    // Give the body limit refusal fixed public text. Every other error goes on
    // to the app error handler.
    errorHandler(error, _request, reply) {
      if (error.code !== "FST_ERR_CTP_BODY_TOO_LARGE") throw error;
      reply.code(413).send(settingsSectionTooLargeError());
    }
  }, async (request, reply) => {
    const { userId, tenantId } = request.auth;
    // Each save writes the section row and an audit event, so the limit comes
    // before any database write.
    const rateLimitError = await stores.limits.consumeRateLimit({
      resource: "settings_write",
      userId,
      tenantId
    });
    if (rateLimitError) {
      reply.code(429);
      reply.header("retry-after", Math.max(1, Math.ceil(rateLimitError.retryAfterMs / 1000)));
      return rateLimitError;
    }

    const paramsResult = parseRequestInput(
      reply,
      z.object({ section: sectionKeySchema }),
      request.params
    );
    if (!paramsResult.ok) {
      return paramsResult.response;
    }

    const bodyResult = parseRequestInput(reply, settingsSectionBodySchema, request.body);
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    if (Buffer.byteLength(JSON.stringify(bodyResult.value.config), "utf8") > SETTINGS_SECTION_MAX_BYTES) {
      reply.code(413);
      return settingsSectionTooLargeError();
    }

    await ensureUser(app.db, userId);
    const section = await stores.settings.upsertSection({
      tenantId,
      userId,
      sectionKey: paramsResult.value.section,
      config: bodyResult.value.config
    }, (saved) => ({
      tenantId,
      sessionId: null,
      userId,
      type: "user.settings.updated",
      payload: {
        sectionKey: saved.sectionKey,
        version: saved.version
      }
    }));

    return serialize(UserSettingsSectionEnvelopeSchema, {
      section: {
        ...section,
        title: getSectionTitle(section.sectionKey),
        status: isLiveSettingsSection(section.sectionKey) ? "live" : "planned"
      }
    });
  });

  app.get("/me/integrations-availability", async (request) => {
    const { userId, tenantId } = request.auth;
    await ensureUser(app.db, userId);
    const views = await stores.integrationRegistry.getIntegrationsForUser(tenantId, userId);
    return {
      enabled: views.map((v) => ({
        id: v.id,
        name: v.name,
        logoSlug: v.logoSlug,
        category: v.category,
        readsEnabled: v.readsEnabled,
        writesEnabled: v.writesEnabled
      }))
    };
  });

  app.get("/me/scheduled-jobs", async (request) => {
    const { userId, tenantId } = request.auth;
    await ensureUser(app.db, userId);
    return serialize(ScheduledJobsListResponseSchema, {
      scheduledJobs: await stores.settings.listScheduledJobs(tenantId, userId)
    });
  });

  app.post("/me/scheduled-jobs/preview", async (request, reply) => {
    await ensureUser(app.db, request.auth.userId);
    const result = parseRequestInput(reply, ScheduledJobPreviewRequestSchema, request.body);
    if (!result.ok) return result.response;
    try {
      return serialize(ScheduledJobPreviewResponseSchema, {
        nextRunAt: computeNextCronRunAt(result.value.cronExpression, result.value.timeZone)
      });
    } catch (error) {
      reply.code(400);
      return buildInvalidScheduledJobConfigError(error);
    }
  });

  app.post("/me/scheduled-jobs", async (request, reply) => {
    const { userId, tenantId } = request.auth;
    await ensureUser(app.db, userId);

    // Scheduled jobs run as recurring synthetic turns that deliberately do NOT
    // draw down the interactive turn quota, so they are throttled here at
    // creation with a per-window rate limit. (The total-active-job cap is
    // enforced further down, after the body is parsed, since it only applies to
    // jobs that will actually be enabled.)
    const rateLimitError = await stores.limits.consumeRateLimit({
      resource: "scheduled_job_create",
      userId,
      tenantId
    });
    if (rateLimitError) {
      reply.code(429);
      reply.header("retry-after", Math.max(1, Math.ceil(rateLimitError.retryAfterMs / 1000)));
      return rateLimitError;
    }

    const persistenceInputResult = resolveScheduledJobPersistenceInput(reply, tenantId, userId, request.body);
    if (!persistenceInputResult.ok) {
      return persistenceInputResult.response;
    }
    const blocked = await rejectBlockedScheduledPrompt(
      reply, stores.piiProtection, tenantId, persistenceInputResult.value
    );
    if (blocked) return blocked;

    // Total-active-job cap: only ENABLED jobs fire turns, so a request creating a
    // disabled job must NOT be blocked even when the user is already at the cap.
    // The store counts and inserts in one locked transaction, so concurrent
    // requests cannot pass the check together.
    const maxActive = stores.config.SCHEDULED_JOB_MAX_ACTIVE_PER_USER;
    // sessionId: null — this is a non-interactive (route-driven) audit event.
    const created = await stores.settings.createScheduledJob(
      { jobId: uuidv7(), ...persistenceInputResult.value, ...(await scheduledJobOwnerSession(request, stores)) },
      { maxActive },
      (saved) => ({
        tenantId,
        sessionId: null,
        userId,
        type: "user.scheduled_job.created",
        payload: buildScheduledJobAuditPayload(saved)
      })
    );
    if (created.status === "limit_reached") {
      reply.code(409);
      return apiError(
        "scheduled_job_limit_reached",
        `You have reached the maximum of ${maxActive} active scheduled jobs. Delete or disable an existing job before creating a new one.`
      );
    }
    const job = created.job;

    reply.code(201);
    return serialize(ScheduledJobEnvelopeSchema, { scheduledJob: job });
  });

  app.put("/me/scheduled-jobs/:jobId", async (request, reply) => {
    const { userId, tenantId } = request.auth;
    await ensureUser(app.db, userId);
    const paramsResult = parseRequestInput(reply, jobIdParams, request.params);
    if (!paramsResult.ok) {
      return paramsResult.response;
    }

    const persistenceInputResult = resolveScheduledJobPersistenceInput(reply, tenantId, userId, request.body);
    if (!persistenceInputResult.ok) {
      return persistenceInputResult.response;
    }

    const existing = await stores.settings.getScheduledJob(
      tenantId,
      paramsResult.value.jobId,
      userId
    );
    if (!existing) {
      reply.code(404);
      return notFoundError("scheduled_job_not_found");
    }
    const blocked = await rejectBlockedScheduledPrompt(
      reply, stores.piiProtection, tenantId, persistenceInputResult.value
    );
    if (blocked) return blocked;

    // Enabling a previously-disabled job is what makes it start firing turns,
    // so treat the disabled→enabled transition exactly like creating an
    // enabled job: it consumes the creation rate limit and is subject to the
    // total-active-job cap. Without this, a user at the cap could create N
    // disabled jobs and PUT-enable them all, bypassing both controls. Updates
    // that keep the job enabled (or disable it) are not gated — the active
    // count already includes the job itself.
    //
    // A job that was paused after a security change does not use the limit
    // when its owner turns it on again: one password change can pause more
    // jobs than the window allows. The active-job cap below still applies.
    if (
      persistenceInputResult.value.enabled && !existing.enabled &&
      existing.pausedReason !== "security_change"
    ) {
      const rateLimitError = await stores.limits.consumeRateLimit({
        resource: "scheduled_job_create",
        userId,
        tenantId
      });
      if (rateLimitError) {
        reply.code(429);
        reply.header("retry-after", Math.max(1, Math.ceil(rateLimitError.retryAfterMs / 1000)));
        return rateLimitError;
      }
    }

    // The store applies the active-job cap to a disabled to enabled change in
    // one locked transaction. It decides the transition from the job row it
    // locks, not from the `existing` read above, which can be stale. The edit
    // also confirms the job for this session: a job that the scheduler paused
    // after a security change can run again.
    const maxActive = stores.config.SCHEDULED_JOB_MAX_ACTIVE_PER_USER;
    const updated = await stores.settings.updateScheduledJob(
      { jobId: paramsResult.value.jobId, ...persistenceInputResult.value, ...(await scheduledJobOwnerSession(request, stores)) },
      { maxActive },
      // sessionId: null — this is a non-interactive (route-driven) audit event.
      (saved) => ({
        tenantId,
        sessionId: null,
        userId,
        type: "user.scheduled_job.updated",
        payload: {
          ...buildScheduledJobAuditPayload(saved),
          ...(existing.pausedReason ? { previousPausedReason: existing.pausedReason } : {})
        }
      })
    );

    if (updated.status === "not_found") {
      reply.code(404);
      return notFoundError("scheduled_job_not_found");
    }
    if (updated.status === "limit_reached") {
      reply.code(409);
      return apiError(
        "scheduled_job_limit_reached",
        `You have reached the maximum of ${maxActive} active scheduled jobs. Delete or disable an existing job before enabling this one.`
      );
    }
    const job = updated.job;

    return serialize(ScheduledJobEnvelopeSchema, { scheduledJob: job });
  });

  app.get("/me/scheduled-jobs/:jobId/runs", async (request, reply) => {
    const paramsResult = parseRequestInput(reply, jobIdParams, request.params);
    if (!paramsResult.ok) {
      return paramsResult.response;
    }
    const { userId, tenantId } = request.auth;
    const runs = await stores.settings.listJobRuns(
      tenantId,
      paramsResult.value.jobId,
      userId
    );
    return serialize(ScheduledJobRunsListResponseSchema, { runs });
  });

  app.delete("/me/scheduled-jobs/:jobId", async (request, reply) => {
    const { userId, tenantId } = request.auth;
    await ensureUser(app.db, userId);
    const paramsResult = parseRequestInput(reply, jobIdParams, request.params);
    if (!paramsResult.ok) {
      return paramsResult.response;
    }

    // sessionId: null — this is a non-interactive (route-driven) audit event.
    const removed = await stores.settings.deleteScheduledJob(
      tenantId,
      paramsResult.value.jobId,
      userId,
      {
        tenantId,
        sessionId: null,
        userId,
        type: "user.scheduled_job.deleted",
        payload: { jobId: paramsResult.value.jobId }
      }
    );

    if (!removed) {
      reply.code(404);
      return notFoundError("scheduled_job_not_found");
    }

    reply.code(204);
    return null;
  });

  const tokenUsageQuerySchema = z.object({
    days: z
      .string()
      .optional()
      .transform((v) => {
        const n = parseInt(v ?? "30", 10);
        return Number.isFinite(n) && n >= 1 && n <= 365 ? n : 30;
      })
  });

  app.get("/me/token-usage", async (request, reply) => {
    const { userId, tenantId } = request.auth;
    await ensureUser(app.db, userId);

    const parsed = parseRequestInput(reply, tokenUsageQuerySchema, request.query);
    if (!parsed.ok) {
      return parsed.response;
    }
    const { days } = parsed.value;

    const usage = await withTenantScope(app.db, tenantId, async (client) => {
      const [dailyResult, modelResult, totalsResult] = await Promise.all([
        client.query(
          `
            SELECT
              -- As text: node-postgres turns a DATE into a JS Date at local midnight.
              DATE(created_at AT TIME ZONE 'UTC')::text AS date,
              COALESCE(SUM(input_tokens), 0)::bigint  AS input_tokens,
              COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
              COALESCE(SUM(total_tokens), 0)::bigint  AS total_tokens,
              COALESCE(SUM(cost_usd), 0)::float       AS cost_usd
            FROM messages
            WHERE
              tenant_id = $1
              AND user_id = $2
              AND role = 'assistant'
              AND total_tokens IS NOT NULL
              AND created_at >= NOW() - ($3 || ' days')::interval
            GROUP BY DATE(created_at AT TIME ZONE 'UTC')
            ORDER BY date ASC
          `,
          [tenantId, userId, days]
        ),
        client.query(
          `
            SELECT
              COALESCE(model_name, 'unknown') AS model_name,
              COALESCE(SUM(input_tokens), 0)::bigint  AS input_tokens,
              COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
              COALESCE(SUM(total_tokens), 0)::bigint  AS total_tokens,
              COALESCE(SUM(cost_usd), 0)::float       AS cost_usd
            FROM messages
            WHERE
              tenant_id = $1
              AND user_id = $2
              AND role = 'assistant'
              AND total_tokens IS NOT NULL
              AND created_at >= NOW() - ($3 || ' days')::interval
            GROUP BY COALESCE(model_name, 'unknown')
            ORDER BY total_tokens DESC
          `,
          [tenantId, userId, days]
        ),
        client.query(
          `
            SELECT
              COALESCE(SUM(input_tokens), 0)::bigint  AS input_tokens,
              COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
              COALESCE(SUM(total_tokens), 0)::bigint  AS total_tokens,
              COALESCE(SUM(cost_usd), 0)::float       AS cost_usd,
              COUNT(*)::bigint                         AS message_count
            FROM messages
            WHERE
              tenant_id = $1
              AND user_id = $2
              AND role = 'assistant'
              AND total_tokens IS NOT NULL
              AND created_at >= NOW() - ($3 || ' days')::interval
          `,
          [tenantId, userId, days]
        )
      ]);

      const daily = dailyResult.rows.map((row) => ({
        date: String(row.date).slice(0, 10),
        inputTokens: Number(row.input_tokens),
        outputTokens: Number(row.output_tokens),
        totalTokens: Number(row.total_tokens),
        costUsd: Number(row.cost_usd)
      }));

      const byModel = modelResult.rows.map((row) => ({
        modelName: String(row.model_name),
        inputTokens: Number(row.input_tokens),
        outputTokens: Number(row.output_tokens),
        totalTokens: Number(row.total_tokens),
        costUsd: Number(row.cost_usd)
      }));

      const t = totalsResult.rows[0];
      const totals = {
        inputTokens: Number(t?.input_tokens ?? 0),
        outputTokens: Number(t?.output_tokens ?? 0),
        totalTokens: Number(t?.total_tokens ?? 0),
        costUsd: Number(t?.cost_usd ?? 0),
        messageCount: Number(t?.message_count ?? 0)
      };

      return { daily, byModel, totals };
    });

    return { usage, days };
  });
}
