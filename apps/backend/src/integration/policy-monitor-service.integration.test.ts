import { describe, expect, test } from "vitest";
import { AuditEventStore } from "../services/audit-event-store.js";
import { PolicyDecisionStore } from "../services/policy/policy-decision-store.js";
import { PolicyRuleStore } from "../services/policy/policy-rule-store.js";
import { PolicyService } from "../services/policy/policy-service.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedMembership, seedTenant, seedUser } from "./support/fixtures.js";

describe.skipIf(!adminDatabaseUrl())("Monitor summary from recorded policy actions", () => {
  test("counts Monitor gateway matches and excludes resource rechecks in either mode", async () => {
    const tenantId = await seedTenant(), userId = await seedUser();
    await seedMembership(tenantId, userId, "admin");
    const rules = new PolicyRuleStore(appPool());
    const decisions = new PolicyDecisionStore(appPool());
    const service = new PolicyService({ rules, decisions, auditEvents: new AuditEventStore(appPool()) });
    const rule = await rules.create(tenantId, {
      name: "Review messages", effect: "require_approval", conditions: { toolNames: ["send_message"] }
    }, userId);
    const input = {
      tenantId, userId, sessionId: null, runtimeId: null, toolName: "send_message",
      category: null, severity: "file_change" as const, serverId: null,
      turnContext: "interactive" as const, enforcementMode: "monitor" as const,
      actionSnapshot: { argumentKeys: ["recipient"] }
    };
    await service.gateAction(input);
    await service.gateAction({ ...input, turnContext: "scheduled" });
    await service.gateAction({ ...input, turnContext: null });
    await service.gateAction({ ...input, enforcementMode: "enforce", approvalDisposition: "approve" });
    await service.gateAction({ ...input, toolName: "unmatched_tool" });
    for (const enforcementMode of ["monitor", "enforce"] as const) {
      await service.gateCompletedToolResource({
        ...input, enforcementMode, actionSnapshot: { resourceUri: "ui://message", toolCallId: "finished-call" }
      });
    }
    const summary = await decisions.summarizeMonitor(tenantId, new Date(Date.now() + 1_000));
    expect(summary.totals).toEqual({ block: 0, approvalInteractive: 1, approvalScheduled: 1, approvalUnknownContext: 1, total: 3 });
    expect(summary.excluded).toEqual({ resourceChecks: 2, unrecognized: 0 });
    expect(summary.rules[0]?.ruleId).toBe(rule.ruleId);
    const matching = await decisions.list(tenantId, {
      evidence: "monitor_gateway", matchedRuleId: rule.ruleId,
      from: summary.windowStart, before: summary.windowEnd
    });
    expect(matching.total).toBe(3);
    expect((await decisions.list(tenantId)).total).toBe(6);
  });
  test("counts beyond one evidence page and keeps tenant predicates on privileged connections", async () => {
    const tenantId = await seedTenant(), foreign = await seedTenant();
    const db = superuserPool();
    await db.query("INSERT INTO policy_rule(tenant_id,rule_id,name,effect) VALUES($1,'shared-id','Foreign rule','block')", [foreign]);
    await db.query(`INSERT INTO policy_decision(decision_id,tenant_id,tool_name,matched_rule_id,outcome,action_snapshot_json,created_at)
      SELECT 'bulk_' || n, $1, 'export_customers', 'shared-id', 'block', '{"argumentKeys":[]}', '2026-09-26T12:00:00Z'
      FROM generate_series(1,601) AS n`, [tenantId]);
    await db.query(`INSERT INTO policy_decision(decision_id,tenant_id,tool_name,matched_rule_id,outcome,action_snapshot_json,created_at)
      VALUES('foreign', $1, 'export_customers', 'shared-id', 'block', '{"argumentKeys":[]}', '2026-09-26T12:00:00Z')`, [foreign]);
    const store = new PolicyDecisionStore(db);
    const summary = await store.summarizeMonitor(tenantId, new Date("2026-09-27T12:00:00Z"));
    expect(summary.totals.block).toBe(601);
    expect(summary.rules).toHaveLength(1);
    expect(summary.rules[0]?.currentRule).toBeNull();
    const page = await store.list(tenantId, {
      evidence: "monitor_gateway", from: summary.windowStart, before: summary.windowEnd, limit: 500
    });
    expect(page.decisions).toHaveLength(500);
    expect(page.total).toBe(601);
    expect(page.hasMore).toBe(true);
  });
});
