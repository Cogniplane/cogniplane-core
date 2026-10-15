import { parseRequestInput } from "../../lib/route-validation.js";

import type { FastifyInstance } from "fastify";

import {
  AdminRuntimeConfigSchema,
  AdminRuntimeHealthResponseSchema,
  MODEL_PROVIDERS,
  MODEL_PROVIDER_META,
  RuntimeSessionsListResponseSchema
} from "@cogniplane/shared-types";

import { serialize } from "../../lib/serialize-response.js";
import { summarizeRuntimeConfig } from "../../domain/runtime-manifest.js";
import type { AuditEventStore } from "../../services/audit-event-store.js";
import type { DeepAgentsRuntimeAdapter } from "../../services/deep-agents/deep-agents-runtime-adapter.js";
import type { RuntimeSessionStore } from "../../services/runtime/runtime-session-store.js";
import { rolloutBodySchema } from "./admin-route-schemas.js";
import {
  createAdminAuditEvent,
  withAdmin
} from "./admin-route-helpers.js";

export async function registerAdminRuntimeRoutes(
  app: FastifyInstance,
  stores: {
    auditEvents: Pick<AuditEventStore, "create">;
    runtimeSessions: Pick<RuntimeSessionStore, "listRecent">;
    deepAgentsAdapter: Pick<
      DeepAgentsRuntimeAdapter,
      "getRuntimeHealthDetail" | "invalidateTenantRuntimes"
    >;
  }
): Promise<void> {
  app.get("/admin/runtime-sessions", withAdmin(app, async (request) => {
    const runtimeSessions = await stores.runtimeSessions.listRecent(request.auth.tenantId, 100);
    return serialize(RuntimeSessionsListResponseSchema, {
      runtimeSessions: runtimeSessions.map((runtimeSession) => ({
        ...runtimeSession,
        configSummary: summarizeRuntimeConfig(runtimeSession.manifestMetadata)
        // `runtimeProvider` comes through the spread from the store column
        // `runtime_sessions.runtime_provider`.
      }))
    });
  }));

  // Build, uptime and runtime activity for operators. The public /health and
  // /ready answer with a bare status; this is the admin-only detail they used
  // to carry. The counts cover the caller's tenant only: the in-memory maps
  // also hold other tenants' sessions, which a tenant admin must not see even
  // as totals.
  app.get("/admin/diagnostics", withAdmin(app, async (request) => {
    const runtimes = stores.deepAgentsAdapter.getRuntimeHealthDetail(request.auth.tenantId);
    return {
      status: "ok",
      uptimeSeconds: Math.round(process.uptime()),
      version: {
        sha: process.env.BUILD_SHA ?? "dev",
        buildDate: process.env.BUILD_DATE ?? ""
      },
      runtimes: {
        activeRuntimeCount: runtimes.length,
        activeTurnCount: runtimes.filter((runtime) => runtime.hasActiveTurn).length
      }
    };
  }));

  // Live in-memory session-runtime detail (active turn, last activity),
  // scoped to the caller's tenant. This is the relocated detail that the
  // unauthenticated /health endpoint used to expose for every tenant.
  app.get("/admin/runtime-health", withAdmin(app, async (request) => {
    return serialize(AdminRuntimeHealthResponseSchema, {
      runtimes: stores.deepAgentsAdapter.getRuntimeHealthDetail(request.auth.tenantId)
    });
  }));

  // Surfaces operator-level runtime configuration (env-driven, read-only) so
  // the admin UI can tell at a glance which execution backends are active
  // across the fleet. Intentionally small — add new fields here lazily as
  // the UI needs them.
  app.get("/admin/runtime-config", withAdmin(app, async () => {
    // Report every provider with a platform-level env key, not just Anthropic —
    // an OpenAI/Google/Z.AI-only deployment would otherwise read "missing" while
    // working fine. Same key-presence rule as buildProviderCredentials.
    const platformProviders = MODEL_PROVIDERS.filter((provider) =>
      Boolean(app.config[MODEL_PROVIDER_META[provider].envKey]?.trim())
    );
    return serialize(AdminRuntimeConfigSchema, {
      e2bTemplateId: app.config.E2B_TEMPLATE_ID,
      platformProviders
    });
  }));

  app.post("/admin/runtime-sessions/rollout", withAdmin(app, async (request, reply) => {
    const parsed = parseRequestInput(reply, rolloutBodySchema, request.body);
    if (!parsed.ok) {
      return parsed.response;
    }

    // Both rollout actions collapse to the same deep-agents operation:
    // tear down the tenant's IDLE session runtimes so the next turn rebuilds
    // them against fresh config. Sessions with an active turn are skipped —
    // the actions are labeled "idle" and must not interrupt running
    // conversations. (The Codex-era distinction between draining and
    // refreshing separate processes no longer applies — turns hold no
    // long-lived process.)
    const affectedSessionIds = await stores.deepAgentsAdapter.invalidateTenantRuntimes(
      request.auth.tenantId,
      {
        idleOnly: true,
        workspaceResetReason:
          "An administrator refreshed idle runtimes for this organization. " +
          "The execution workspace was reset. Recreate any files you still need."
      }
    );
    await createAdminAuditEvent(stores.auditEvents, {
      tenantId: request.auth.tenantId,
      userId: request.auth.userId,
      type: "admin.runtime_rollout.executed",
      payload: {
        action: parsed.value.action,
        affectedSessionIds
      },
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    });

    return {
      action: parsed.value.action,
      affectedSessionIds
    };
  }));
}
