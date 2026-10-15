import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, onTestFinished, test } from "vitest";

import { PolicyDecisionDetailResponseSchema, PolicyDecisionsListResponseSchema, PolicyMonitorSummaryResponseSchema } from "@cogniplane/shared-types";

import { registerAdminPolicyRoutes } from "../routes/admin/admin-policy-routes.js";
import { AuditEventStore } from "../services/audit-event-store.js";
import { PolicyDecisionStore } from "../services/policy/policy-decision-store.js";
import { PolicyRuleStore } from "../services/policy/policy-rule-store.js";
import { PolicyService } from "../services/policy/policy-service.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedMembership, seedTenant, seedUser } from "./support/fixtures.js";

// PostgreSQL stores created_at in microseconds. A JS Date keeps milliseconds.
// These tests page real rows whose timestamps differ below one millisecond, and
// read them through the HTTP route, so that each createdAt value goes to the
// client and comes back as the `before` bound of the next page.

const NEWEST = "2026-09-26T12:00:00.123456Z";
const WINDOW_END = new Date("2026-09-27T12:00:00.000Z");
const PAGE = 25;

/** Insert `count` Monitor gateway rows, the first at `at`, each next one `step` older. */
async function insertDecisions(tenantId: string, count: number, at: string, step = "0 microseconds"): Promise<string[]> {
  const result = await superuserPool().query<{ decision_id: string }>(
    `INSERT INTO policy_decision (decision_id, tenant_id, tool_name, matched_rule_id, outcome, enforced,
       action_snapshot_json, created_at)
     SELECT 'pdc_' || gen_random_uuid(), $1, 'export_customers', 'pol_paging', 'block', false,
            '{"argumentKeys":["repo"]}'::jsonb, $3::timestamptz - (n - 1) * $4::interval
     FROM generate_series(1, $2::int) AS n
     ORDER BY n
     RETURNING decision_id`,
    [tenantId, count, at, step]
  );
  return result.rows.map((row) => row.decision_id);
}

async function buildApp(tenantId: string) {
  const adminId = await seedUser();
  await seedMembership(tenantId, adminId, "admin");
  const decisions = new PolicyDecisionStore(appPool());
  const rules = new PolicyRuleStore(appPool());
  const auditEvents = new AuditEventStore(appPool());
  const app = Fastify();
  app.decorate("db", appPool());
  app.addHook("preHandler", async (request) => {
    request.auth = { tenantId, userId: adminId, role: "admin", isAdmin: true };
  });
  await registerAdminPolicyRoutes(app, {
    policyRules: rules,
    policyDecisions: decisions,
    policyService: new PolicyService({ rules, decisions, auditEvents }),
    auditEvents,
    now: () => WINDOW_END
  });
  onTestFinished(() => app.close());
  return { app, decisions };
}

async function listDecisions(app: FastifyInstance, query: Record<string, string>) {
  const response = await app.inject({ method: "GET", url: "/admin/policy/decisions", query });
  expect(response.statusCode).toBe(200);
  return PolicyDecisionsListResponseSchema.parse(response.json());
}

/** Read every page from `offset`, as the Policies page does, and check that the total stays the same. */
async function readPages(app: FastifyInstance, query: Record<string, string>, total: number, offset = 0) {
  const ids: string[] = [];
  for (let next = offset; ; next += PAGE) {
    const page = await listDecisions(app, { ...query, limit: String(PAGE), offset: String(next) });
    expect(page.total).toBe(total);
    ids.push(...page.decisions.map((decision) => decision.decisionId));
    if (!page.hasMore) return ids;
  }
}

describe.skipIf(!adminDatabaseUrl())("policy decision paging with microsecond timestamps", () => {
  test("pins later pages to the exact newest timestamp and lists every row once", async () => {
    const tenant = await seedTenant();
    const foreign = await seedTenant();
    const newest = await insertDecisions(tenant, 100, NEWEST);
    const older = await insertDecisions(tenant, 147, "2026-09-26T12:00:00.122455Z", "1001 microseconds");
    await insertDecisions(foreign, 5, NEWEST);
    const { app, decisions } = await buildApp(tenant);

    // Page 1 has no bound. The Policies page pins later pages to its first row.
    const first = await listDecisions(app, { limit: String(PAGE) });
    expect(first.total).toBe(247);
    const pin = first.decisions[0]!.createdAt;

    // Rows recorded after page 1 loaded: one later in the same millisecond,
    // and one that the store records now.
    await insertDecisions(tenant, 1, "2026-09-26T12:00:00.123457Z");
    const recorded = await decisions.record(tenant, {
      sessionId: null, userId: null, runtimeId: null, toolName: "export_customers", toolCategory: null,
      severity: null, serverId: null, matchedRuleId: "pol_paging", outcome: "block", enforced: false,
      explanation: null, actionSnapshot: { argumentKeys: ["repo"] }
    });

    const later = await readPages(app, { before: pin }, 247, PAGE);
    const listed = [...first.decisions.map((decision) => decision.decisionId), ...later];
    expect(listed).toHaveLength(247);
    expect(new Set(listed).size).toBe(247);
    expect(new Set(listed)).toEqual(new Set([...newest, ...older]));
    // Same order as created_at DESC, id DESC in the database.
    const expected = await superuserPool().query<{ decision_id: string }>(
      `SELECT decision_id FROM policy_decision WHERE tenant_id = $1 AND created_at <= $2
       ORDER BY created_at DESC, id DESC`,
      [tenant, NEWEST]
    );
    expect(listed).toEqual(expected.rows.map((row) => row.decision_id));

    // createdAt carries the stored microseconds on list, detail, and record.
    expect(pin).toBe(NEWEST);
    expect(recorded.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    const detail = await app.inject({ method: "GET", url: `/admin/policy/decisions/${first.decisions[0]!.decisionId}` });
    expect(PolicyDecisionDetailResponseSchema.parse(detail.json()).decision.createdAt).toBe(NEWEST);
    const unbound = await listDecisions(app, { limit: String(PAGE) });
    expect(unbound.total).toBe(249);
    expect(unbound.decisions[0]!.decisionId).toBe(recorded.decisionId);
  });

  test("keeps exact window bounds, including rows later in the same millisecond", async () => {
    const tenant = await seedTenant();
    const { app } = await buildApp(tenant);

    // The monitor summary window ends at a millisecond. Rows at the bounds are inside.
    const atEnd = await insertDecisions(tenant, 30, "2026-09-27T12:00:00.000000Z");
    const inside = await insertDecisions(tenant, 10, "2026-09-26T12:00:00.000000Z", "1 hour");
    const atStart = await insertDecisions(tenant, 1, "2026-09-20T12:00:00.000000Z");
    // Outside the summary window by less than one millisecond, and by more.
    const afterEndSameMs = await insertDecisions(tenant, 3, "2026-09-27T12:00:00.000456Z");
    const afterEndNextUs = await insertDecisions(tenant, 1, "2026-09-27T12:00:00.000457Z");
    await insertDecisions(tenant, 1, "2026-09-27T12:00:00.001000Z");
    const beforeStart = await insertDecisions(tenant, 1, "2026-09-20T11:59:59.999999Z");
    await insertDecisions(tenant, 1, "2026-09-20T11:59:59.999998Z");

    const summaryResponse = await app.inject({ method: "GET", url: "/admin/policy/monitor-summary" });
    const summary = PolicyMonitorSummaryResponseSchema.parse(summaryResponse.json());
    expect(summary.windowEnd).toBe(WINDOW_END.toISOString());
    const counted = [...atEnd, ...inside, ...atStart];
    expect(summary.totals.total).toBe(counted.length);

    // A Monitor link sends the same window on every page.
    const window = { evidence: "monitor_gateway", from: summary.windowStart, before: summary.windowEnd };
    const linked = await readPages(app, window, counted.length);
    expect(new Set(linked)).toEqual(new Set(counted));
    expect(linked).toHaveLength(counted.length);

    // A bound with microseconds is exact on both ends.
    const exact = { from: "2026-09-20T11:59:59.999999Z", before: "2026-09-27T12:00:00.000456Z" };
    const exactIds = await readPages(app, exact, counted.length + afterEndSameMs.length + beforeStart.length);
    expect(new Set(exactIds)).toEqual(new Set([...counted, ...afterEndSameMs, ...beforeStart]));
    expect(exactIds).not.toContain(afterEndNextUs[0]);
  });
});
