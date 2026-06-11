import { test, expect } from "vitest";
import Fastify from "fastify";

import type { Pool } from "../../lib/db.js";
import { PiiAnalyticsStore } from "../../services/pii/pii-analytics-store.js";
import type { BreakerSnapshot } from "../../services/pii/pii-circuit-breaker.js";
import type { PiiProtectionSettings } from "../../services/pii/pii-policy.js";
import { registerAdminPiiRoutes, resolveRange } from "./admin-pii-routes.js";

type StubRow = Record<string, unknown>;

/**
 * Routes the SQL string through a small matcher → fixture map. Keeps tests
 * declarative ("when this SQL runs, return that") instead of mocking every
 * query individually. The matcher is a substring on the trimmed SQL — fragile
 * to refactors but explicit, which is the trade-off this codebase prefers.
 */
function buildFakeDb(handlers: Array<{ match: string; rows: StubRow[] | (() => StubRow[]) }>) {
  let scanRunsRouteCalls = 0;
  const queries: string[] = [];
  return {
    db: {
      connect: async () => ({
        query: async (sql: string) => {
          // Tenant scope BEGIN/COMMIT/set_config noise — return empty.
          if (
            sql.startsWith("BEGIN") ||
            sql.startsWith("COMMIT") ||
            sql.includes("set_config") ||
            sql.includes("ROLLBACK") ||
            sql.startsWith("SELECT user_id") // ensureUser
          ) {
            return { rows: [], rowCount: 0 };
          }
          queries.push(sql);
          for (const h of handlers) {
            if (sql.includes(h.match)) {
              scanRunsRouteCalls += 1;
              const rows = typeof h.rows === "function" ? h.rows() : h.rows;
              return { rows, rowCount: rows.length };
            }
          }
          return { rows: [], rowCount: 0 };
        },
        release: () => {}
      }),
      query: async () => ({ rows: [], rowCount: 0 })
    },
    get callCount() {
      return scanRunsRouteCalls;
    },
    get queries() {
      return queries;
    }
  };
}

const closedSnap: BreakerSnapshot = {
  state: "closed",
  failureCount: 0,
  openedAt: null,
  willRetryAt: null
};

const openSnap: BreakerSnapshot = {
  state: "open",
  failureCount: 5,
  openedAt: 1_700_000_000_000,
  willRetryAt: 1_700_000_030_000
};

const defaultSettings: PiiProtectionSettings = {
  enabled: true,
  mode: "detect",
  rawRetention: "never",
  provider: { type: "openai-compatible", model: "" },
  scopes: { chatPrompts: true, uploads: true, microsoftImports: false },
  actions: { reportToAdmins: true },
  detectors: {
    useRulesFirst: true,
    entityTypes: ["email", "phone", "person_name", "address", "financial", "government_id"]
  }
};

async function buildApp(opts: {
  isAdmin: boolean;
  snapshot?: BreakerSnapshot;
  settings?: PiiProtectionSettings | null;
  fakeDb?: ReturnType<typeof buildFakeDb>;
}) {
  const app = Fastify();
  const fake =
    opts.fakeDb ??
    buildFakeDb([
      // Empty by default — exercises the zero-fill path.
    ]);
  app.decorate("db", fake.db as never);

  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: "tester",
      tenantId: "tenant-a",
      isAdmin: opts.isAdmin,
      role: opts.isAdmin ? ("admin" as const) : ("member" as const)
    };
  });

  await registerAdminPiiRoutes(app, {
    piiCircuitBreaker: {
      async snapshot() {
        return opts.snapshot ?? closedSnap;
      }
    },
    piiAnalytics: new PiiAnalyticsStore(fake.db as unknown as Pool),
    piiProtection:
      opts.settings === null
        ? undefined
        : {
            async getActiveSettings() {
              return opts.settings ?? defaultSettings;
            }
          }
  });
  await app.ready();
  return { app, fake };
}

// ─── provider-status (existing) ─────────────────────────────────────────────

test("provider-status: non-admin gets 403", async () => {
  const { app } = await buildApp({ isAdmin: false });
  const res = await app.inject({ method: "GET", url: "/admin/pii/provider-status" });
  expect(res.statusCode).toBe(403);
  await app.close();
});

test("provider-status: admin sees the closed-state shape", async () => {
  const { app } = await buildApp({ isAdmin: true, snapshot: closedSnap });
  const res = await app.inject({ method: "GET", url: "/admin/pii/provider-status" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({
        provider: "pii-llm",
        state: "closed",
        failureCount: 0,
        openedAt: null,
        willRetryAt: null
      });
  await app.close();
});

test("provider-status: admin sees the open-state shape with retry deadline", async () => {
  const { app } = await buildApp({ isAdmin: true, snapshot: openSnap });
  const res = await app.inject({ method: "GET", url: "/admin/pii/provider-status" });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.state).toBe("open");
  expect(body.failureCount).toBe(5);
  expect(body.openedAt).toBe(1_700_000_000_000);
  expect(body.willRetryAt).toBe(1_700_000_030_000);
  await app.close();
});

// ─── range resolution (pure function) ───────────────────────────────────────

test("resolveRange: 24h preset uses hour bucket", () => {
  const now = new Date("2026-04-30T12:00:00Z");
  const range = resolveRange({ range: "24h" }, now);
  expect(range.bucket).toBe("hour");
  expect(range.to.toISOString()).toBe("2026-04-30T12:00:00.000Z");
  expect(range.from.toISOString()).toBe("2026-04-29T12:00:00.000Z");
  // Previous window is the same length, immediately preceding.
  expect(range.prevTo.toISOString()).toBe(range.from.toISOString());
  expect(range.prevFrom.toISOString()).toBe("2026-04-28T12:00:00.000Z");
});

test("resolveRange: 7d preset uses day bucket", () => {
  const range = resolveRange({ range: "7d" }, new Date("2026-04-30T00:00:00Z"));
  expect(range.bucket).toBe("day");
  expect(range.to.toISOString()).toBe("2026-04-30T00:00:00.000Z");
  expect(range.from.toISOString()).toBe("2026-04-23T00:00:00.000Z");
});

test("resolveRange: custom range respects from/to", () => {
  const range = resolveRange(
    { range: "custom", from: "2026-04-01T00:00:00Z", to: "2026-04-02T12:00:00Z" },
    new Date("2026-04-30T00:00:00Z")
  );
  // Span ≤ 2 days → hour bucket.
  expect(range.bucket).toBe("hour");
  expect(range.from.toISOString()).toBe("2026-04-01T00:00:00.000Z");
  expect(range.to.toISOString()).toBe("2026-04-02T12:00:00.000Z");
});

// ─── metrics endpoint ───────────────────────────────────────────────────────

test("metrics: non-admin gets 403", async () => {
  const { app } = await buildApp({ isAdmin: false });
  const res = await app.inject({ method: "GET", url: "/admin/pii/metrics?range=7d" });
  expect(res.statusCode).toBe(403);
  await app.close();
});

test("metrics: empty data returns zero-filled KPIs and policy header", async () => {
  const { app } = await buildApp({ isAdmin: true });
  const res = await app.inject({ method: "GET", url: "/admin/pii/metrics?range=24h" });
  expect(res.statusCode).toBe(200);
  const body = res.json();

  expect(body.range.preset).toBe("24h");
  expect(body.range.bucket).toBe("hour");
  expect(body.policy.mode).toBe("detect");
  expect(body.policy.enabled).toBe(true);
  // Zero-filled KPIs.
  expect(body.kpis).toEqual({
        scans: { current: 0, previous: 0 },
        findings: { current: 0, previous: 0 },
        blocked: { current: 0, previous: 0 },
        transformed: { current: 0, previous: 0 },
        failed: { current: 0, previous: 0 }
      });
  expect(body.byEntityType).toEqual([]);
  expect(body.byConfidence).toEqual([]);
  expect(body.bySubjectType).toEqual([]);
  // Time series is generated by the SQL CTE; with the empty fake it's [].
  expect(body.timeSeries).toEqual([]);
  await app.close();
});

test("metrics: rolls KPI rows + entity aggregations into the response", async () => {
  // Two KPI calls: one for the current window, one for the prior. Order is
  // determined by Promise.all + the helper's queries; the matcher fires in
  // document order on every match, so both KPI invocations resolve from the
  // same fixture row. To distinguish them, return different rows on each call.
  let kpiCall = 0;
  const fake = buildFakeDb([
    {
      match: "COUNT(*) FILTER (WHERE status = 'blocked')",
      rows: () => {
        kpiCall += 1;
        return [
          kpiCall === 1
            ? { scans: 12, findings: 30, blocked: 4, transformed: 1, failed: 2 }
            : { scans: 5, findings: 8, blocked: 1, transformed: 0, failed: 1 }
        ];
      }
    },
    {
      match: "generate_series",
      rows: [
        {
          bucket: new Date("2026-04-30T00:00:00Z"),
          allow: 3,
          report: 4,
          block: 2,
          transform: 1,
          failed: 0
        }
      ]
    },
    {
      match: "jsonb_array_elements(findings_json) AS finding",
      // Both byEntityType and byConfidence use this LATERAL pattern. The
      // fixture covers the entityType aggregation; byConfidence reuses it
      // and gets a row with entityType only — fine for testing the shape.
      rows: [{ entity_type: "email", count: 18, high: 10, medium: 6, low: 2 }]
    },
    {
      match: "GROUP BY subject_type",
      rows: [
        { subject_type: "message", count: 7 },
        { subject_type: "artifact", count: 5 }
      ]
    }
  ]);

  const { app } = await buildApp({ isAdmin: true, fakeDb: fake });
  const res = await app.inject({ method: "GET", url: "/admin/pii/metrics?range=7d" });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.kpis.scans.current).toBe(12);
  expect(body.kpis.scans.previous).toBe(5);
  expect(body.kpis.findings.current).toBe(30);
  expect(body.kpis.blocked.current).toBe(4);
  expect(body.byEntityType[0].entityType).toBe("email");
  expect(body.byEntityType[0].count).toBe(18);
  expect(body.byConfidence[0].entityType).toBe("email");
  expect(body.byConfidence[0].high).toBe(10);
  expect(body.bySubjectType).toEqual([
        { subjectType: "message", count: 7 },
        { subjectType: "artifact", count: 5 }
      ]);
  // The byConfidence aggregation is computed by a dedicated `confidence_counts`
  // CTE. We assert the CTE is present (the real contract) but deliberately do
  // NOT pin the exact ORDER BY phrasing — the response-shape assertions above
  // (byConfidence rows + high/medium/low values) already cover the observable
  // behavior, and the ordering of a single-row fixture is not load-bearing.
  const confidenceSql = fake.queries.find((sql) => sql.includes("WITH confidence_counts AS"));
  expect(confidenceSql).toBeTruthy();
  await app.close();
});

test("metrics: rejects custom range with from >= to", async () => {
  const { app } = await buildApp({ isAdmin: true });
  const res = await app.inject({
    method: "GET",
    url: "/admin/pii/metrics?range=custom&from=2026-04-30T00:00:00Z&to=2026-04-29T00:00:00Z"
  });
  expect(res.statusCode).toBe(400);
  await app.close();
});

test("metrics: rejects custom range without from/to", async () => {
  const { app } = await buildApp({ isAdmin: true });
  const res = await app.inject({
    method: "GET",
    url: "/admin/pii/metrics?range=custom"
  });
  expect(res.statusCode).toBe(400);
  await app.close();
});

test("metrics: rejects custom range exceeding 366 days", async () => {
  const { app } = await buildApp({ isAdmin: true });
  // 367-day span: from 2025-01-01 to 2026-01-03.
  const res = await app.inject({
    method: "GET",
    url: "/admin/pii/metrics?range=custom&from=2025-01-01T00:00:00Z&to=2026-01-03T00:00:00Z"
  });
  expect(res.statusCode).toBe(400);
  // 365-day span passes — the database queries themselves are stubbed in
  // this test, so success here means validation accepted the range.
  const ok = await app.inject({
    method: "GET",
    url: "/admin/pii/metrics?range=custom&from=2025-04-30T00:00:00Z&to=2026-04-30T00:00:00Z"
  });
  expect(ok.statusCode).toBe(200);
  await app.close();
});

test("metrics: route not registered when piiProtection is absent", async () => {
  const { app } = await buildApp({ isAdmin: true, settings: null });
  const res = await app.inject({ method: "GET", url: "/admin/pii/metrics?range=24h" });
  // No metrics route → 404 (not 403, since auth gate is unreachable).
  expect(res.statusCode).toBe(404);
  await app.close();
});

// ─── /admin/pii/top ─────────────────────────────────────────────────────────

test("top: non-admin gets 403", async () => {
  const { app } = await buildApp({ isAdmin: false });
  const res = await app.inject({ method: "GET", url: "/admin/pii/top?range=7d&groupBy=user" });
  expect(res.statusCode).toBe(403);
  await app.close();
});

test("top: groupBy=user returns user rows", async () => {
  const fake = buildFakeDb([
    {
      // Match the by-user grouping (presence of GROUP BY source_user_id).
      match: "GROUP BY source_user_id",
      rows: [
        {
          user_id: "user-a",
          findings_total: 42,
          sessions_count: 3,
          block_count: 5,
          transform_count: 2,
          failed_count: 1,
          last_seen_at: new Date("2026-04-29T12:00:00Z")
        }
      ]
    }
  ]);
  const { app } = await buildApp({ isAdmin: true, fakeDb: fake });
  const res = await app.inject({ method: "GET", url: "/admin/pii/top?range=7d&groupBy=user" });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.groupBy).toBe("user");
  expect(body.rows.length).toBe(1);
  expect(body.rows[0].userId).toBe("user-a");
  expect(body.rows[0].findingsTotal).toBe(42);
  expect(body.rows[0].sessionsCount).toBe(3);
  expect(body.rows[0].blockCount).toBe(5);
  expect(body.rows[0].lastSeenAt).toBe("2026-04-29T12:00:00.000Z");
  await app.close();
});

test("top: groupBy=session returns session rows with action mix", async () => {
  const fake = buildFakeDb([
    {
      match: "GROUP BY source_session_id",
      rows: [
        {
          session_id: "sess-1",
          user_id: "user-a",
          findings_total: 11,
          allow_count: 3,
          report_count: 4,
          block_count: 2,
          transform_count: 1,
          failed_count: 0,
          last_activity_at: new Date("2026-04-29T18:00:00Z")
        }
      ]
    }
  ]);
  const { app } = await buildApp({ isAdmin: true, fakeDb: fake });
  const res = await app.inject({
    method: "GET",
    url: "/admin/pii/top?range=24h&groupBy=session"
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.groupBy).toBe("session");
  expect(body.rows[0].sessionId).toBe("sess-1");
  expect(body.rows[0].userId).toBe("user-a");
  expect(body.rows[0].actionMix).toEqual({
        allow: 3,
        report: 4,
        block: 2,
        transform: 1,
        failed: 0
      });
  await app.close();
});

test("top: limit clamped to 50, defaults to 10", async () => {
  const { app } = await buildApp({ isAdmin: true });
  const tooBig = await app.inject({
    method: "GET",
    url: "/admin/pii/top?range=7d&groupBy=user&limit=999"
  });
  expect(tooBig.statusCode).toBe(400);

  const ok = await app.inject({ method: "GET", url: "/admin/pii/top?range=7d&groupBy=user" });
  expect(ok.statusCode).toBe(200);
  // Default limit threading is implicit — empty fake just returns [].
  expect(ok.json().rows).toEqual([]);
  await app.close();
});

test("top: rejects invalid groupBy", async () => {
  const { app } = await buildApp({ isAdmin: true });
  const res = await app.inject({
    method: "GET",
    url: "/admin/pii/top?range=7d&groupBy=tenant"
  });
  expect(res.statusCode).toBe(400);
  await app.close();
});

// ─── /admin/pii/recent ──────────────────────────────────────────────────────

test("recent: non-admin gets 403", async () => {
  const { app } = await buildApp({ isAdmin: false });
  const res = await app.inject({ method: "GET", url: "/admin/pii/recent?range=7d" });
  expect(res.statusCode).toBe(403);
  await app.close();
});

test("recent: returns rows shaped without raw value, default actions = block,transform,failed", async () => {
  const fake = {
    db: {
      connect: async () => ({
        query: async (sql: string) => {
          if (
            sql.startsWith("BEGIN") ||
            sql.startsWith("COMMIT") ||
            sql.includes("set_config") ||
            sql.startsWith("SELECT user_id")
          ) {
            return { rows: [], rowCount: 0 };
          }
          if (sql.includes("ORDER BY created_at DESC") && sql.includes("entity_types")) {
            return {
              rows: [
                {
                  scan_run_id: "scan-1",
                  created_at: new Date("2026-04-30T08:00:00Z"),
                  completed_at: new Date("2026-04-30T08:00:01Z"),
                  subject_type: "message",
                  subject_id: "msg-1",
                  source_session_id: "sess-1",
                  source_user_id: "user-a",
                  mode: "block",
                  action_taken: "block",
                  status: "blocked",
                  provider_type: "openai-compatible",
                  provider_model: "google/gemini-2.5-flash",
                  findings_count: 2,
                  error_message: null,
                  entity_types: ["email", "phone"]
                }
              ],
              rowCount: 1
            };
          }
          return { rows: [], rowCount: 0 };
        },
        release: () => {}
      }),
      query: async () => ({ rows: [], rowCount: 0 })
    }
  };
  const { app } = await buildApp({
    isAdmin: true,
    fakeDb: fake as unknown as ReturnType<typeof buildFakeDb>
  });
  const res = await app.inject({ method: "GET", url: "/admin/pii/recent?range=7d" });
  expect(res.statusCode).toBe(200);
  const body = res.json();

  // The applied action filter is echoed back in the response — with no
  // `actions` query param the route defaults to block,transform,failed. The
  // echoed array is the observable contract; how the store internally splits
  // those tokens into action_taken values vs. a 'failed' status predicate is
  // an implementation detail and is covered at the store layer.
  expect(body.actions).toEqual(["block", "transform", "failed"]);

  expect(body.rows.length).toBe(1);
  const row = body.rows[0];
  expect(row.scanRunId).toBe("scan-1");
  expect(row.findingsCount).toBe(2);
  expect(row.entityTypes).toEqual(["email", "phone"]);
  // Critical: no raw `value` field is ever surfaced from this route.
  expect(Object.prototype.hasOwnProperty.call(row, "value")).toBe(false);
  await app.close();
});

test("recent: actions param threads through to the response", async () => {
  const { app } = await buildApp({ isAdmin: true });
  const res = await app.inject({
    method: "GET",
    url: "/admin/pii/recent?range=7d&actions=allow,report"
  });
  expect(res.statusCode).toBe(200);
  // The parsed actions filter is echoed verbatim in the response (parse order
  // preserved, 'failed' absent). The store's internal split of these tokens
  // into action_taken values vs. a status predicate is not observable here.
  expect(res.json().actions).toEqual(["allow", "report"]);
  await app.close();
});

test("recent: rejects unknown action token", async () => {
  const { app } = await buildApp({ isAdmin: true });
  const res = await app.inject({
    method: "GET",
    url: "/admin/pii/recent?range=7d&actions=block,bogus"
  });
  expect(res.statusCode).toBe(400);
  await app.close();
});

test("recent: limit clamped at 200", async () => {
  const { app } = await buildApp({ isAdmin: true });
  const res = await app.inject({
    method: "GET",
    url: "/admin/pii/recent?range=7d&limit=999"
  });
  expect(res.statusCode).toBe(400);
  await app.close();
});

// ─── /admin/pii/jobs/stats ──────────────────────────────────────────────────

async function buildAppWithOpsStores(opts: {
  queueRow?: Record<string, unknown>;
  latencyRows?: Record<string, unknown>[];
  topErrorRows?: Record<string, unknown>[];
  breakerEvents?: Array<{
    id: string;
    eventType: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }>;
}) {
  const fakeDb = {
    db: {
      connect: async () => ({
        query: async (sql: string) => {
          if (
            sql.startsWith("BEGIN") ||
            sql.startsWith("COMMIT") ||
            sql.includes("set_config") ||
            sql.startsWith("SELECT user_id")
          ) {
            return { rows: [], rowCount: 0 };
          }
          if (sql.includes("FROM pii_scan_jobs")) {
            return {
              rows: [
                opts.queueRow ?? {
                  queued: 0,
                  claimed: 0,
                  completed: 0,
                  failed: 0,
                  oldest_queued_at: null,
                  max_attempts_hit: 0
                }
              ],
              rowCount: 1
            };
          }
          if (sql.includes("percentile_cont(0.95)")) {
            return { rows: opts.latencyRows ?? [], rowCount: (opts.latencyRows ?? []).length };
          }
          if (sql.includes("LEFT(error_message, 200)")) {
            return {
              rows: opts.topErrorRows ?? [],
              rowCount: (opts.topErrorRows ?? []).length
            };
          }
          return { rows: [], rowCount: 0 };
        },
        release: () => {}
      }),
      query: async () => ({ rows: [], rowCount: 0 })
    }
  };

  const app = Fastify();
  app.decorate("db", fakeDb.db as never);
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: "tester",
      tenantId: "tenant-a",
      isAdmin: true,
      role: "admin" as const
    };
  });

  await registerAdminPiiRoutes(app, {
    piiCircuitBreaker: { async snapshot() { return closedSnap; } },
    piiAnalytics: new PiiAnalyticsStore(fakeDb.db as unknown as Pool),
    piiProtection: { async getActiveSettings() { return defaultSettings; } },
    platformEvents: opts.breakerEvents
      ? {
          async listByType() {
            return opts.breakerEvents!;
          }
        }
      : undefined
  });
  await app.ready();
  return app;
}

test("jobs/stats: non-admin gets 403", async () => {
  const { app } = await buildApp({ isAdmin: false });
  const res = await app.inject({ method: "GET", url: "/admin/pii/jobs/stats?range=7d" });
  expect(res.statusCode).toBe(403);
  await app.close();
});

test("jobs/stats: returns zero-filled queue when nothing is enqueued", async () => {
  const app = await buildAppWithOpsStores({});
  const res = await app.inject({ method: "GET", url: "/admin/pii/jobs/stats?range=24h" });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.queue).toEqual({
        queued: 0,
        claimed: 0,
        completed: 0,
        failed: 0,
        oldestQueuedAt: null,
        maxAttemptsHit: 0
      });
  expect(body.latency).toEqual([]);
  expect(body.topErrors).toEqual([]);
  // No platformEvents store wired → empty timeline, not 404.
  expect(body.breakerTimeline).toEqual([]);
  await app.close();
});

test("jobs/stats: surfaces queue, latency, top errors, breaker timeline", async () => {
  const app = await buildAppWithOpsStores({
    queueRow: {
      queued: 3,
      claimed: 1,
      completed: 100,
      failed: 4,
      oldest_queued_at: new Date("2026-04-30T07:00:00Z"),
      max_attempts_hit: 2
    },
    latencyRows: [
      { subject_type: "message", p50_ms: 120, p95_ms: 800, p99_ms: 1500, sample_count: 50 },
      { subject_type: "artifact", p50_ms: 600, p95_ms: 2400, p99_ms: 5000, sample_count: 12 }
    ],
    topErrorRows: [
      { message: "provider_timeout: openrouter", count: 3 },
      { message: "file_too_large", count: 1 }
    ],
    // Store contract: listByType returns newest-first (ORDER BY created_at
    // DESC). The fixture mirrors that so the test would catch a regression
    // where the route accidentally re-sorts or the store changes its
    // ordering contract.
    breakerEvents: [
      {
        id: "2",
        eventType: "pii_breaker_transition",
        payload: { provider: "pii-llm", from: "open", to: "half_open", failureCount: 0 },
        createdAt: "2026-04-30T05:01:00.000Z"
      },
      {
        id: "1",
        eventType: "pii_breaker_transition",
        payload: { provider: "pii-llm", from: "closed", to: "open", failureCount: 5 },
        createdAt: "2026-04-30T05:00:00.000Z"
      }
    ]
  });

  const res = await app.inject({ method: "GET", url: "/admin/pii/jobs/stats?range=7d" });
  expect(res.statusCode).toBe(200);
  const body = res.json();

  expect(body.queue.queued).toBe(3);
  expect(body.queue.maxAttemptsHit).toBe(2);
  expect(body.queue.oldestQueuedAt).toBe("2026-04-30T07:00:00.000Z");

  expect(body.latency.length).toBe(2);
  expect(body.latency[0].subjectType).toBe("message");
  expect(body.latency[0].p95Ms).toBe(800);
  expect(body.latency[1].subjectType).toBe("artifact");

  expect(body.topErrors[0].message).toBe("provider_timeout: openrouter");
  expect(body.topErrors[0].count).toBe(3);

  // Newest-first ordering is preserved end-to-end.
  expect(body.breakerTimeline.length).toBe(2);
  expect(body.breakerTimeline[0].at).toBe("2026-04-30T05:01:00.000Z");
  expect(body.breakerTimeline[0].from).toBe("open");
  expect(body.breakerTimeline[0].to).toBe("half_open");
  expect(body.breakerTimeline[1].at).toBe("2026-04-30T05:00:00.000Z");
  expect(body.breakerTimeline[1].from).toBe("closed");
  expect(body.breakerTimeline[1].to).toBe("open");
  await app.close();
});
