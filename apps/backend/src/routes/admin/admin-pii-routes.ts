import type { FastifyInstance } from "fastify";

import { parseRequestInput } from "../../lib/route-validation.js";
import type { PiiAnalyticsStore } from "../../services/pii/pii-analytics-store.js";
import type { PiiCircuitBreaker } from "../../services/pii/pii-circuit-breaker.js";
import type { PiiProtectionService } from "../../services/pii/pii-protection-service.js";
import type { PlatformEventStore } from "../../services/platform-event-store.js";
import { withAdmin } from "./admin-route-helpers.js";

import {
  metricsQuerySchema,
  recentQuerySchema,
  resolveRange,
  topQuerySchema,
  type KpiDeltas
} from "./admin-pii-schemas.js";

// Re-exported so existing test imports keep working without churn.
export { resolveRange } from "./admin-pii-schemas.js";

export interface AdminPiiRouteStores {
  piiCircuitBreaker: PiiCircuitBreaker;
  /**
   * Optional so test harnesses that don't exercise the metrics endpoint can
   * skip wiring it. When absent, /admin/pii/metrics, /admin/pii/top,
   * /admin/pii/recent, and /admin/pii/jobs/stats are not registered.
   */
  piiProtection?: PiiProtectionService;
  /** Read-only aggregates for the dashboard. Required when piiProtection is wired. */
  piiAnalytics?: PiiAnalyticsStore;
  /**
   * Powers the breaker transition timeline on the ops health endpoint.
   * Optional — when missing, /admin/pii/jobs/stats returns an empty
   * breakerTimeline rather than 404'ing the whole route.
   */
  platformEvents?: PlatformEventStore;
}

export async function registerAdminPiiRoutes(
  app: FastifyInstance,
  stores: AdminPiiRouteStores
): Promise<void> {
  app.get("/admin/pii/provider-status", withAdmin(app, async () => {
    const snapshot = await stores.piiCircuitBreaker.snapshot();
    return {
      provider: "pii-llm",
      state: snapshot.state,
      failureCount: snapshot.failureCount,
      openedAt: snapshot.openedAt,
      willRetryAt: snapshot.willRetryAt
    };
  }));

  if (!stores.piiProtection || !stores.piiAnalytics) return;

  const piiProtection = stores.piiProtection;
  const piiAnalytics = stores.piiAnalytics;

  app.get(
    "/admin/pii/metrics",
    withAdmin(app, async (request, reply) => {
      const parsed = parseRequestInput(reply, metricsQuerySchema, request.query);
      if (!parsed.ok) return parsed.response;

      const range = resolveRange(parsed.value);
      const { tenantId } = request.auth;

      // Active policy goes through the protection service so callers get the
      // same default-fallback behavior as the runtime path.
      const settings = await piiProtection.getActiveSettings(tenantId);

      const [kpiCurrent, kpiPrevious, timeSeries, byEntityType, byConfidence, bySubjectType] =
        await Promise.all([
          piiAnalytics.getKpis(tenantId, range.from, range.to),
          piiAnalytics.getKpis(tenantId, range.prevFrom, range.prevTo),
          piiAnalytics.getTimeSeries(tenantId, range),
          piiAnalytics.getByEntityType(tenantId, range.from, range.to),
          piiAnalytics.getByConfidence(tenantId, range.from, range.to),
          piiAnalytics.getBySubjectType(tenantId, range.from, range.to)
        ]);

      const kpis: KpiDeltas = {
        scans: { current: kpiCurrent.scans, previous: kpiPrevious.scans },
        findings: { current: kpiCurrent.findings, previous: kpiPrevious.findings },
        blocked: { current: kpiCurrent.blocked, previous: kpiPrevious.blocked },
        transformed: {
          current: kpiCurrent.transformed,
          previous: kpiPrevious.transformed
        },
        failed: { current: kpiCurrent.failed, previous: kpiPrevious.failed }
      };

      return {
        range: {
          preset: parsed.value.range,
          from: range.from.toISOString(),
          to: range.to.toISOString(),
          bucket: range.bucket
        },
        policy: {
          enabled: settings.enabled,
          mode: settings.mode,
          rawRetention: settings.rawRetention,
          scopes: settings.scopes,
          entityTypes: settings.detectors.entityTypes
        },
        kpis,
        timeSeries,
        byEntityType,
        byConfidence,
        bySubjectType
      };
    })
  );

  app.get(
    "/admin/pii/top",
    withAdmin(app, async (request, reply) => {
      const parsed = parseRequestInput(reply, topQuerySchema, request.query);
      if (!parsed.ok) return parsed.response;

      const range = resolveRange(parsed.value);
      const { tenantId } = request.auth;

      const rows =
        parsed.value.groupBy === "user"
          ? await piiAnalytics.getTopByUser(tenantId, range.from, range.to, parsed.value.limit)
          : await piiAnalytics.getTopBySession(tenantId, range.from, range.to, parsed.value.limit);

      return {
        range: {
          preset: parsed.value.range,
          from: range.from.toISOString(),
          to: range.to.toISOString()
        },
        groupBy: parsed.value.groupBy,
        rows
      };
    })
  );

  app.get(
    "/admin/pii/jobs/stats",
    withAdmin(app, async (request, reply) => {
      const parsed = parseRequestInput(reply, metricsQuerySchema, request.query);
      if (!parsed.ok) return parsed.response;

      const range = resolveRange(parsed.value);
      const { tenantId } = request.auth;

      const [queue, latency, topErrors] = await Promise.all([
        piiAnalytics.getQueueStats(tenantId),
        piiAnalytics.getLatencyPercentiles(tenantId, range.from, range.to),
        piiAnalytics.getTopErrors(tenantId, range.from, range.to)
      ]);

      // Breaker timeline lives in platform_events, which has no RLS — read it
      // outside the tenant scope. The events themselves are tenant-agnostic
      // (the breaker is global per provider type).
      const breakerTimeline = stores.platformEvents
        ? (await stores.platformEvents.listByType("pii_breaker_transition", {
            since: range.from,
            limit: 200
          })).map((event) => ({
            at: event.createdAt,
            provider: String((event.payload as Record<string, unknown>).provider ?? ""),
            from: String((event.payload as Record<string, unknown>).from ?? ""),
            to: String((event.payload as Record<string, unknown>).to ?? ""),
            failureCount: Number(
              (event.payload as Record<string, unknown>).failureCount ?? 0
            )
          }))
        : [];

      return {
        range: {
          preset: parsed.value.range,
          from: range.from.toISOString(),
          to: range.to.toISOString()
        },
        queue,
        latency,
        topErrors,
        breakerTimeline
      };
    })
  );

  app.get(
    "/admin/pii/recent",
    withAdmin(app, async (request, reply) => {
      const parsed = parseRequestInput(reply, recentQuerySchema, request.query);
      if (!parsed.ok) return parsed.response;

      const range = resolveRange(parsed.value);
      const { tenantId } = request.auth;

      const rows = await piiAnalytics.getRecentActivity(
        tenantId,
        range.from,
        range.to,
        parsed.value.actions,
        parsed.value.limit
      );

      return {
        range: {
          preset: parsed.value.range,
          from: range.from.toISOString(),
          to: range.to.toISOString()
        },
        actions: parsed.value.actions,
        rows
      };
    })
  );
}
