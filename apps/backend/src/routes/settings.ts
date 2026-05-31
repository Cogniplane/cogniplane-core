
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import {
  GithubConnectionStatusSchema,
  NotionConnectionStatusSchema,
  ScheduledJobEnvelopeSchema,
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
import { GithubConnectionNotConfiguredError } from "../services/integrations/github/github-connection-service.js";
import { loadIntegrationEnablement } from "../services/integrations/integration-enablement.js";
import { NotionConnectionNotConfiguredError } from "../services/integrations/notion/notion-connection-service.js";
import {
  userSettingsSectionKeys,
  type UserSettingsStore
} from "../services/user-settings-store.js";

import {
  buildScheduledJobAuditPayload,
  buildSectionSummaries,
  buildSettingsSnapshot,
  getSectionTitle,
  isLiveSettingsSection
} from "./settings-helpers.js";

const sectionKeySchema = z.enum(userSettingsSectionKeys);

const settingsSectionBodySchema = z.object({
  config: z.record(z.string(), z.unknown())
});

const scheduledJobBodySchema = z.object({
  jobName: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  cronExpression: z.string().trim().min(1).max(120),
  timeZone: z.string().trim().min(1).max(100),
  targetType: z.enum(["prompt", "skill"]).default("prompt"),
  targetRef: z.string().trim().min(1).max(120).nullable().optional(),
  input: z.object({
    prompt: z.string().trim().min(1).max(4_000)
  }),
  enabled: z.boolean().default(true)
});

type ScheduledJobBody = z.infer<typeof scheduledJobBodySchema>;

function buildInvalidScheduledJobConfigError(error: unknown) {
  return requestError([
    {
      path: "cronExpression",
      message: getErrorMessage(error, "Invalid scheduled job configuration.")
    }
  ]);
}

async function buildScheduledJobPersistenceInput(
  settings: UserSettingsStore,
  tenantId: string,
  userId: string,
  body: ScheduledJobBody
) {
  const nextRunAt = body.enabled ? computeNextCronRunAt(body.cronExpression, body.timeZone) : null;

  const sections = await settings.listSections(tenantId, userId);
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
    settingsSnapshot: buildSettingsSnapshot(sections),
    enabled: body.enabled,
    nextRunAt
  };
}

async function resolveScheduledJobPersistenceInput(
  reply: FastifyReply,
  settings: UserSettingsStore,
  tenantId: string,
  userId: string,
  body: unknown
) {
  const bodyResult = parseRequestInput(reply, scheduledJobBodySchema, body);
  if (!bodyResult.ok) {
    return bodyResult;
  }

  try {
    return {
      ok: true as const,
      value: await buildScheduledJobPersistenceInput(settings, tenantId, userId, bodyResult.value)
    };
  } catch (error) {
    reply.code(400);
    return {
      ok: false as const,
      response: buildInvalidScheduledJobConfigError(error)
    };
  }
}

export function buildSettingsRouteStores(deps: AppDependencies, extras: { config: AppConfig }) {
  return {
    settings: deps.userSettings,
    auditEvents: deps.auditEvents,
    githubConnections: deps.githubConnectionService,
    notionConnections: deps.notionConnectionService,
    config: extras.config,
    integrationStates: deps.integrationStates,
    integrationRegistry: deps.integrationRegistry,
    limits: deps.limits
  };
}

export type SettingsRouteStores = ReturnType<typeof buildSettingsRouteStores>;

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

  app.put("/me/settings/:section", async (request, reply) => {
    const { userId, tenantId } = request.auth;
    await ensureUser(app.db, userId);
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

    const section = await stores.settings.upsertSection({
      tenantId,
      userId,
      sectionKey: paramsResult.value.section,
      config: bodyResult.value.config
    });

    await stores.auditEvents.create({
      tenantId,
      sessionId: null,
      userId,
      type: "user.settings.updated",
      payload: {
        sectionKey: section.sectionKey,
        version: section.version
      }
    });

    return serialize(UserSettingsSectionEnvelopeSchema, {
      section: {
        ...section,
        title: getSectionTitle(section.sectionKey),
        status: isLiveSettingsSection(section.sectionKey) ? "live" : "planned"
      }
    });
  });

  app.get("/me/github-connection", async (request) => {
    const { userId, tenantId } = request.auth;
    await ensureUser(app.db, userId);
    const [status, enablement] = await Promise.all([
      stores.githubConnections.getConnectionStatus(tenantId, userId),
      loadIntegrationEnablement(stores.integrationStates, stores.config, tenantId, "github")
    ]);
    return serialize(GithubConnectionStatusSchema, { ...status, ...enablement });
  });

  app.post("/me/github-connection/authorize", async (request, reply) => {
    const { userId, tenantId } = request.auth;
    await ensureUser(app.db, userId);

    try {
      const url = await stores.githubConnections.getAuthorizationUrl({
        tenantId,
        userId
      });
      return { url };
    } catch (error) {
      if (error instanceof GithubConnectionNotConfiguredError) {
        reply.code(503);
        return notFoundError("github_integration_not_configured");
      }
      throw error;
    }
  });

  app.delete("/me/github-connection", async (request, reply) => {
    const { userId, tenantId } = request.auth;
    await ensureUser(app.db, userId);
    const removed = await stores.githubConnections.disconnect(tenantId, userId);
    if (!removed) {
      reply.code(404);
      return notFoundError("github_connection_not_found");
    }

    reply.code(204);
    return null;
  });

  app.get("/me/notion-connection", async (request) => {
    const { userId, tenantId } = request.auth;
    await ensureUser(app.db, userId);
    const [status, enablement] = await Promise.all([
      stores.notionConnections.getConnectionStatus(tenantId, userId),
      loadIntegrationEnablement(stores.integrationStates, stores.config, tenantId, "notion")
    ]);
    return serialize(NotionConnectionStatusSchema, { ...status, ...enablement });
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

  app.post("/me/notion-connection/authorize", async (request, reply) => {
    const { userId, tenantId } = request.auth;
    await ensureUser(app.db, userId);

    try {
      const url = await stores.notionConnections.getAuthorizationUrl({
        tenantId,
        userId
      });
      return { url };
    } catch (error) {
      if (error instanceof NotionConnectionNotConfiguredError) {
        reply.code(503);
        return notFoundError("notion_integration_not_configured");
      }
      throw error;
    }
  });

  app.delete("/me/notion-connection", async (request, reply) => {
    const { userId, tenantId } = request.auth;
    await ensureUser(app.db, userId);
    const removed = await stores.notionConnections.disconnect(tenantId, userId);
    if (!removed) {
      reply.code(404);
      return notFoundError("notion_connection_not_found");
    }
    reply.code(204);
    return null;
  });

  app.get("/me/scheduled-jobs", async (request) => {
    const { userId, tenantId } = request.auth;
    await ensureUser(app.db, userId);
    return serialize(ScheduledJobsListResponseSchema, {
      scheduledJobs: await stores.settings.listScheduledJobs(tenantId, userId)
    });
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

    const persistenceInputResult = await resolveScheduledJobPersistenceInput(
      reply,
      stores.settings,
      tenantId,
      userId,
      request.body
    );
    if (!persistenceInputResult.ok) {
      return persistenceInputResult.response;
    }

    // Total-active-job cap: only ENABLED jobs fire turns, so a request creating a
    // disabled job must NOT be blocked even when the user is already at the cap.
    // Enforced after body parse so we know whether this creation is enabled.
    const maxActive = stores.config.SCHEDULED_JOB_MAX_ACTIVE_PER_USER;
    if (maxActive > 0 && persistenceInputResult.value.enabled) {
      const activeCount = await stores.settings.countActiveScheduledJobs(tenantId, userId);
      if (activeCount >= maxActive) {
        reply.code(409);
        return apiError(
          "scheduled_job_limit_reached",
          `You have reached the maximum of ${maxActive} active scheduled jobs. Delete or disable an existing job before creating a new one.`
        );
      }
    }

    const job = await stores.settings.createScheduledJob({
      jobId: uuidv7(),
      ...persistenceInputResult.value
    });

    // sessionId: null — this is a non-interactive (route-driven) audit event.
    await stores.auditEvents.create({
      tenantId,
      sessionId: null,
      userId,
      type: "user.scheduled_job.created",
      payload: buildScheduledJobAuditPayload(job)
    });

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

    const persistenceInputResult = await resolveScheduledJobPersistenceInput(
      reply,
      stores.settings,
      tenantId,
      userId,
      request.body
    );
    if (!persistenceInputResult.ok) {
      return persistenceInputResult.response;
    }

    const job = await stores.settings.updateScheduledJob({
      jobId: paramsResult.value.jobId,
      ...persistenceInputResult.value
    });

    if (!job) {
      reply.code(404);
      return notFoundError("scheduled_job_not_found");
    }

    // sessionId: null — this is a non-interactive (route-driven) audit event.
    await stores.auditEvents.create({
      tenantId,
      sessionId: null,
      userId,
      type: "user.scheduled_job.updated",
      payload: buildScheduledJobAuditPayload(job)
    });

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

    const removed = await stores.settings.deleteScheduledJob(
      tenantId,
      paramsResult.value.jobId,
      userId
    );

    if (!removed) {
      reply.code(404);
      return notFoundError("scheduled_job_not_found");
    }

    // sessionId: null — this is a non-interactive (route-driven) audit event.
    await stores.auditEvents.create({
      tenantId,
      sessionId: null,
      userId,
      type: "user.scheduled_job.deleted",
      payload: { jobId: paramsResult.value.jobId }
    });

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
              DATE(created_at AT TIME ZONE 'UTC') AS date,
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
