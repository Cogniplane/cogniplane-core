import { randomUUID } from "node:crypto";

import { describe, expect, test } from "vitest";

import { PolicyDecisionStore } from "../services/policy/policy-decision-store.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedTenant } from "./support/fixtures.js";

const WINDOW_END = new Date("2026-09-27T12:00:00.000Z");
const WINDOW_START = "2026-09-20T12:00:00.000Z";
const GATEWAY = { argumentKeys: ["repo", "title"] };

type Row = {
  tenantId: string;
  ruleId: string | null;
  outcome: "allow" | "block" | "require_approval";
  enforced?: boolean;
  snapshot?: Record<string, unknown>;
  at?: string;
};

async function insertDecision(row: Row): Promise<string> {
  const decisionId = `pdc_${randomUUID()}`;
  await superuserPool().query(
    `INSERT INTO policy_decision (decision_id, tenant_id, tool_name, matched_rule_id, outcome, enforced,
       action_snapshot_json, created_at)
     VALUES ($1, $2, 'github_create_pr', $3, $4, $5, $6::jsonb, $7)`,
    [
      decisionId,
      row.tenantId,
      row.ruleId,
      row.outcome,
      row.enforced ?? false,
      JSON.stringify(row.snapshot ?? GATEWAY),
      row.at ?? "2026-09-26T10:00:00.000Z"
    ]
  );
  return decisionId;
}

async function insertRule(tenantId: string, ruleId: string, name: string, enabled: boolean, effect: string) {
  await superuserPool().query(
    `INSERT INTO policy_rule (rule_id, tenant_id, name, enabled, effect) VALUES ($1, $2, $3, $4, $5)`,
    [ruleId, tenantId, name, enabled, effect]
  );
}

describe.skipIf(!adminDatabaseUrl())("policy monitor summary with PostgreSQL RLS", () => {
  test("counts Monitor gateway evidence by rule in the exact window and matches the list filter", async () => {
    const tenant = await seedTenant();
    const foreign = await seedTenant();
    const ruleA = `pol_${randomUUID()}`;
    const ruleGone = `pol_${randomUUID()}`;
    // The rule changed after the decisions were recorded: now disabled and set to allow.
    await insertRule(tenant, ruleA, "Current name", false, "allow");
    // Another tenant has a rule with the same ID. Its name must not resolve here.
    await insertRule(foreign, ruleA, "Foreign rule name", true, "block");
    await insertRule(foreign, ruleGone, "Foreign rule for deleted ID", true, "block");

    const counted = [
      await insertDecision({ tenantId: tenant, ruleId: ruleA, outcome: "block", snapshot: { ...GATEWAY, turnContext: "interactive" } }),
      await insertDecision({ tenantId: tenant, ruleId: ruleA, outcome: "require_approval", snapshot: { ...GATEWAY, turnContext: "interactive" } }),
      await insertDecision({ tenantId: tenant, ruleId: ruleA, outcome: "require_approval", snapshot: { ...GATEWAY, turnContext: "scheduled" } }),
      // Bounds are inclusive on both ends.
      await insertDecision({ tenantId: tenant, ruleId: ruleA, outcome: "block", at: WINDOW_START }),
      await insertDecision({ tenantId: tenant, ruleId: ruleA, outcome: "block", at: WINDOW_END.toISOString() }),
      // A deleted rule, and a turn context the runtime does not write.
      await insertDecision({ tenantId: tenant, ruleId: ruleGone, outcome: "require_approval" }),
      await insertDecision({ tenantId: tenant, ruleId: ruleGone, outcome: "require_approval", snapshot: { ...GATEWAY, turnContext: "batch" } })
    ];

    // Not counted and not reported as excluded.
    await insertDecision({ tenantId: tenant, ruleId: ruleA, outcome: "block", enforced: true });
    await insertDecision({ tenantId: tenant, ruleId: ruleA, outcome: "allow" });
    await insertDecision({ tenantId: tenant, ruleId: ruleA, outcome: "block", at: "2026-09-20T11:59:59.999Z" });
    await insertDecision({ tenantId: tenant, ruleId: ruleA, outcome: "block", at: "2026-09-27T12:00:00.001Z" });
    await insertDecision({ tenantId: foreign, ruleId: ruleA, outcome: "block" });
    // Excluded: resource checks record require_approval unenforced in both modes.
    await insertDecision({
      tenantId: tenant,
      ruleId: ruleA,
      outcome: "require_approval",
      snapshot: { resourceUri: "ui://widget", toolCallId: "call_1", turnContext: "interactive" }
    });
    // A resource snapshot that also has argument keys is still a resource check.
    await insertDecision({
      tenantId: tenant,
      ruleId: ruleA,
      outcome: "block",
      snapshot: { ...GATEWAY, resourceUri: "ui://widget" }
    });
    // Excluded: older or unrecognized records.
    await insertDecision({ tenantId: tenant, ruleId: ruleA, outcome: "block", snapshot: { toolName: "x" } });
    await insertDecision({ tenantId: tenant, ruleId: ruleA, outcome: "block", snapshot: { argumentKeys: "repo" } });
    await insertDecision({ tenantId: tenant, ruleId: null, outcome: "block" });

    const store = new PolicyDecisionStore(appPool());
    const summary = await store.summarizeMonitor(tenant, WINDOW_END);

    expect(summary.windowStart).toBe(WINDOW_START);
    expect(summary.windowEnd).toBe(WINDOW_END.toISOString());
    expect(summary.totals).toEqual({
      block: 3,
      approvalInteractive: 1,
      approvalScheduled: 1,
      approvalUnknownContext: 2,
      total: counted.length
    });
    expect(summary.rules).toEqual([
      {
        ruleId: ruleA,
        currentRule: { name: "Current name", enabled: false, effect: "allow" },
        counts: { block: 3, approvalInteractive: 1, approvalScheduled: 1, approvalUnknownContext: 0, total: 5 },
        lastRecordedAt: WINDOW_END.toISOString()
      },
      {
        ruleId: ruleGone,
        currentRule: null,
        counts: { block: 0, approvalInteractive: 0, approvalScheduled: 0, approvalUnknownContext: 2, total: 2 },
        lastRecordedAt: "2026-09-26T10:00:00.000Z"
      }
    ]);
    expect(summary.excluded).toEqual({ resourceChecks: 2, unrecognized: 3 });
    expect(JSON.stringify(summary)).not.toContain("Foreign rule");
    expect(JSON.stringify(summary)).not.toContain("argumentKeys");

    // The links use the same window and evidence set, so each count lists the same rows.
    const window = { evidence: "monitor_gateway" as const, from: summary.windowStart, before: summary.windowEnd };
    const all = await store.list(tenant, { ...window, limit: 500 });
    expect(all.total).toBe(summary.totals.total);
    expect(all.decisions.map((d) => d.decisionId).sort()).toEqual([...counted].sort());
    for (const rule of summary.rules) {
      const listed = await store.list(tenant, { ...window, matchedRuleId: rule.ruleId });
      expect(listed.total).toBe(rule.counts.total);
      const blocks = await store.list(tenant, { ...window, matchedRuleId: rule.ruleId, outcomes: ["block"] });
      expect(blocks.total).toBe(rule.counts.block);
      const approvals = await store.list(tenant, { ...window, matchedRuleId: rule.ruleId, outcomes: ["require_approval"] });
      expect(approvals.total).toBe(
        rule.counts.approvalInteractive + rule.counts.approvalScheduled + rule.counts.approvalUnknownContext
      );
    }

    const foreignSummary = await store.summarizeMonitor(foreign, WINDOW_END);
    expect(foreignSummary.totals.total).toBe(1);
    expect(foreignSummary.rules[0]?.currentRule?.name).toBe("Foreign rule name");
  });

  test("returns an empty summary with zero counts when nothing was recorded", async () => {
    const tenant = await seedTenant();
    const summary = await new PolicyDecisionStore(appPool()).summarizeMonitor(tenant, WINDOW_END);
    expect(summary).toEqual({
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END.toISOString(),
      totals: { block: 0, approvalInteractive: 0, approvalScheduled: 0, approvalUnknownContext: 0, total: 0 },
      rules: [],
      excluded: { resourceChecks: 0, unrecognized: 0 }
    });
  });
});
