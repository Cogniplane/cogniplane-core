import Fastify from "fastify";
import { describe, expect, onTestFinished, test } from "vitest";
import { DEFAULT_PII_PROTECTION } from "@cogniplane/shared-types";
import { withTenantScope } from "../lib/db.js";
import { deriveSessionAlerts } from "../services/admin-session-alerts.js";
import { PiiAnalyticsStore } from "../services/pii/pii-analytics-store.js";
import { registerAdminPiiRoutes } from "../routes/admin/admin-pii-routes.js";
import { registerAdminSessionRoutes } from "../routes/admin/admin-session-routes.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedApproval, seedMessage, seedPiiScanRun, seedSession, seedTenantGraph, type TenantFixture } from "./support/fixtures.js";

async function adminApp(owner: TenantFixture) {
  const app = Fastify();
  app.decorate("db", appPool());
  app.addHook("preHandler", async request => {
    request.auth = { tenantId: owner.tenantId, userId: owner.userId, isAdmin: true, role: "owner" };
  });
  onTestFinished(() => app.close());
  return app;
}

async function scan(owner: TenantFixture, status: string, findings: unknown[], action: string | null = null) {
  const id = await seedPiiScanRun(owner);
  await superuserPool().query(
    `UPDATE pii_scan_runs SET status = $2, findings_json = $3::jsonb, action_taken = $4,
     created_at = '2026-09-20T12:00:00Z' WHERE scan_run_id = $1`, [id, status, JSON.stringify(findings), action]
  );
  return id;
}

describe.skipIf(!adminDatabaseUrl())("admin database response boundaries", () => {
  test("aggregates actual scan, approval, and message statuses for only the requested tenant", async () => {
    const owner = await seedTenantGraph();
    const foreign = await seedTenantGraph();
    const emptySession = await seedSession(owner.tenantId, owner.userId);
    for (const tenant of [owner, foreign]) {
      await scan(tenant, "blocked", []);
      await scan(tenant, "blocked", [{ entityType: "email" }]);
      await scan(tenant, "transformed", [{ entityType: "email" }]);
      await scan(tenant, "completed", [{ entityType: "email" }]);
      await scan(tenant, "completed", []);
      await scan(tenant, "failed", [{ entityType: "email" }]);
      const rejected = await seedApproval(tenant);
      const approved = await seedApproval(tenant);
      await superuserPool().query("UPDATE approvals SET status = 'rejected' WHERE approval_id = $1", [rejected]);
      await superuserPool().query("UPDATE approvals SET status = 'approved' WHERE approval_id = $1", [approved]);
      for (const status of ["failed", "error", "completed"]) {
        const message = await seedMessage(tenant.tenantId, tenant.userId, tenant.sessionId);
        await superuserPool().query("UPDATE messages SET status = $2 WHERE message_id = $1", [message, status]);
      }
    }
    const ids = [owner.sessionId, foreign.sessionId, emptySession];
    const expected = [
      { kind: "pii-blocked", count: 2 }, { kind: "pii-transformed", count: 1 },
      { kind: "pii-detected", count: 1 }, { kind: "approval-rejected", count: 1 },
      { kind: "approval-pending", count: 1 }, { kind: "errored", count: 2 }
    ];
    const actual = await withTenantScope(appPool(), owner.tenantId, client => deriveSessionAlerts(client, owner.tenantId, ids));
    expect([...actual.entries()]).toEqual([[owner.sessionId, expected]]);
    // The explicit tenant predicate also protects callers with broader DB privileges.
    expect([...(await deriveSessionAlerts(superuserPool(), owner.tenantId, ids)).entries()])
      .toEqual([[owner.sessionId, expected]]);
    expect([...(await withTenantScope(appPool(), foreign.tenantId, client => deriveSessionAlerts(client, foreign.tenantId, ids))).entries()])
      .toEqual([[foreign.sessionId, expected]]);
  });

  test("the actual PII metrics response contains counts and never raw finding values", async () => {
    const owner = await seedTenantGraph();
    const foreign = await seedTenantGraph();
    const secret = "private-metrics-sentinel@example.test";
    await scan(owner, "completed", [
      { entityType: "email", confidence: "high", value: secret, start: 0, end: 44 },
      { entityType: "email", confidence: "low", value: "second-private-sentinel@example.test", start: 45, end: 79 }
    ], "report");
    await scan(foreign, "blocked", [{ entityType: "phone", confidence: "high", value: "foreign-private-sentinel" }], "block");
    const app = await adminApp(owner);
    await registerAdminPiiRoutes(app, {
      piiAnalytics: new PiiAnalyticsStore(appPool()),
      piiProtection: { getActiveSettings: async () => DEFAULT_PII_PROTECTION },
      piiCircuitBreaker: { snapshot: async () => ({ state: "closed", failureCount: 0, openedAt: null, willRetryAt: null }) }
    });
    const response = await app.inject({ method: "GET", url: "/admin/pii/metrics?range=custom&from=2026-09-20T00:00:00Z&to=2026-09-21T00:00:00Z" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.kpis).toMatchObject({ scans: { current: 1 }, findings: { current: 2 }, blocked: { current: 0 } });
    expect(body.byEntityType).toEqual([{ entityType: "email", count: 2 }]);
    expect(body.byConfidence).toEqual([{ entityType: "email", high: 1, medium: 0, low: 1 }]);
    expect(body.bySubjectType).toEqual([{ subjectType: "message", count: 1 }]);
    expect(body.timeSeries.reduce((total: number, point: { report: number }) => total + point.report, 0)).toBe(1);
    expect(response.body).not.toContain(secret);
    expect(response.body).not.toContain("private-sentinel");
    function assertNoFindingDetails(value: unknown): void {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        expect(["value", "findings_json", "rawText", "start", "end"]).not.toContain(key);
        assertNoFindingDetails(child);
      }
    }
    assertNoFindingDetails(body);
  });

  test("admin session pages preserve timestamp ties and microseconds while applying filters", async () => {
    const owner = await seedTenantGraph();
    const foreign = await seedTenantGraph();
    const ids: string[] = [];
    const timestamps = ["2026-09-20T12:00:00.123001Z", "2026-09-20T12:00:00.123002Z", "2026-09-20T12:00:00.123002Z", "2026-09-20T12:00:00.123003Z"];
    for (const timestamp of timestamps) {
      const sessionId = await seedSession(owner.tenantId, owner.userId);
      const messageId = await seedMessage(owner.tenantId, owner.userId, sessionId);
      await superuserPool().query("UPDATE sessions SET created_at = '2026-09-20T00:00:00Z' WHERE session_id = $1", [sessionId]);
      await superuserPool().query("UPDATE messages SET status = 'failed', created_at = $2 WHERE message_id = $1", [messageId, timestamp]);
      ids.push(sessionId);
    }
    // Same date and error status, but a different user. It must not appear.
    const otherSession = await seedSession(owner.tenantId, foreign.userId);
    const otherMessage = await seedMessage(owner.tenantId, foreign.userId, otherSession);
    await superuserPool().query("UPDATE sessions SET created_at = '2026-09-20T00:00:00Z' WHERE session_id = $1", [otherSession]);
    await superuserPool().query("UPDATE messages SET status = 'failed', created_at = '2026-09-20T12:00:00.123004Z' WHERE message_id = $1", [otherMessage]);
    // Correct owner/date but no error, and a correct owner/error outside the date range.
    await superuserPool().query("UPDATE sessions SET created_at = '2026-09-20T00:00:00Z' WHERE session_id = $1", [owner.sessionId]);
    const oldSession = await seedSession(owner.tenantId, owner.userId);
    const oldMessage = await seedMessage(owner.tenantId, owner.userId, oldSession);
    await superuserPool().query("UPDATE sessions SET created_at = '2026-09-01T00:00:00Z' WHERE session_id = $1", [oldSession]);
    await superuserPool().query("UPDATE messages SET status = 'failed' WHERE message_id = $1", [oldMessage]);
    const app = await adminApp(owner);
    await registerAdminSessionRoutes(app);
    const query = new URLSearchParams({ limit: "1", userId: owner.userId, status: "errored", alert: "errored",
      from: "2026-09-20T00:00:00Z", to: "2026-09-21T00:00:00Z" });
    const seen: string[] = [];
    for (let page = 0; page < 4; page++) {
      const response = await app.inject({ method: "GET", url: `/admin/sessions?${query}` });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.items).toHaveLength(1);
      seen.push(body.items[0].sessionId);
      if (page === 3) {
        expect(body.nextCursor).toBeNull();
      } else {
        expect(body.nextCursor).toEqual(expect.any(String));
        expect(body.nextCursor).not.toBe("");
        query.set("cursor", body.nextCursor);
      }
    }
    expect(seen).toEqual([ids[3], ...[ids[1]!, ids[2]!].sort().reverse(), ids[0]]);
  });
});
