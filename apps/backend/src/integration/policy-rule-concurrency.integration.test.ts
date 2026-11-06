import { describe, expect, test } from "vitest";

import { evaluatePolicy } from "../services/policy/policy-engine.js";
import { PolicyRuleStore } from "../services/policy/policy-rule-store.js";
import { WeakerChangeError } from "../services/weaker-change-error.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedTenantGraph } from "./support/fixtures.js";
import { ALLOW_WEAKER } from "../test-helpers/data-routes.js";

// Waits until `count` sessions wait for an advisory lock, so a test releases its
// held lock only after the writers it started are really blocked on it.
async function waitForAdvisoryWaiters(count: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await superuserPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pg_locks WHERE locktype = 'advisory' AND NOT granted");
    if (Number(waiting.rows[0]!.count) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Expected ${count} sessions to wait for the policy rule lock.`);
}

async function holdRuleLock(tenantId: string) {
  const holder = await superuserPool().connect();
  await holder.query("BEGIN");
  await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('policy_rule:' || $1, 0))", [tenantId]);
  return holder;
}

describe.skipIf(!adminDatabaseUrl())("policy rule write concurrency", () => {
  test("a partial update does not overwrite a field that a concurrent writer changed", async () => {
    const owner = await seedTenantGraph();
    const store = new PolicyRuleStore(appPool());
    const rule = await store.create(owner.tenantId, { name: "before", effect: "block" }, owner.userId, ALLOW_WEAKER);

    // Another writer holds the tenant's rule lock and turns the rule off.
    const writer = await holdRuleLock(owner.tenantId);
    try {
      await writer.query("UPDATE policy_rule SET enabled = FALSE WHERE tenant_id = $1 AND rule_id = $2",
        [owner.tenantId, rule.ruleId]);
      // A rename starts while the writer is open. It must wait for the lock and
      // read after the writer commits.
      const rename = store.update(owner.tenantId, rule.ruleId, { name: "after" }, ALLOW_WEAKER);
      await waitForAdvisoryWaiters(1);
      await writer.query("COMMIT");

      await expect(rename).resolves.toMatchObject({ name: "after", enabled: false });
    } finally {
      writer.release();
    }
    expect(await store.get(owner.tenantId, rule.ruleId)).toMatchObject({ name: "after", enabled: false });
  });

  test("concurrent creates without a priority get different append priorities", async () => {
    const owner = await seedTenantGraph();
    const store = new PolicyRuleStore(appPool());

    // Hold the lock until all five creates wait for it, then let them run.
    const holder = await holdRuleLock(owner.tenantId);
    let created;
    try {
      const pending = Promise.all(Array.from({ length: 5 }, (_, index) =>
        store.create(owner.tenantId, { name: `rule ${index}`, effect: "allow" }, owner.userId, ALLOW_WEAKER)));
      await waitForAdvisoryWaiters(5);
      await holder.query("COMMIT");
      created = await pending;
    } finally {
      holder.release();
    }

    expect(new Set(created.map((rule) => rule.priority)).size).toBe(5);
  });

  // The store classifies a change against the rules it reads under the
  // tenant's rule lock (policy-weakening.ts). A classification against rules
  // read before the lock would let two changes that are not weaker alone
  // make the policy weaker together, with no step-up.
  test("two changes that are not weaker alone cannot make the policy weaker together without step-up", async () => {
    const owner = await seedTenantGraph();
    const store = new PolicyRuleStore(appPool());
    const block = await store.create(owner.tenantId,
      { name: "block exports", effect: "block", priority: 10, conditions: { toolNames: ["export_customers"] } }, owner.userId, ALLOW_WEAKER);

    const holder = await holdRuleLock(owner.tenantId);
    let results: PromiseSettledResult<unknown>[];
    try {
      const pending = Promise.allSettled([
        // After the block rule: never the first match for the export tool.
        store.create(owner.tenantId, { name: "allow exports", effect: "allow", priority: 20,
          conditions: { toolNames: ["export_customers"] } }, owner.userId, { allowWeaker: false }),
        // The only rule, moved: the same outcomes.
        store.update(owner.tenantId, block.ruleId, { priority: 30 }, { allowWeaker: false })
      ]);
      await waitForAdvisoryWaiters(2);
      await holder.query("COMMIT");
      results = await pending;
    } finally {
      holder.release();
    }

    // The second writer reads the first one's committed rule and is refused.
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const refused = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toBeInstanceOf(WeakerChangeError);
    const rules = await store.list(owner.tenantId);
    expect(evaluatePolicy(rules, { toolName: "export_customers", category: null, severity: null, serverId: null, turnContext: null }).outcome)
      .toBe("block");
  });

  test("a weaker change that is not allowed rolls back: no change and no audit event", async () => {
    const owner = await seedTenantGraph();
    const store = new PolicyRuleStore(appPool());
    const block = await store.create(owner.tenantId, { name: "block all", effect: "block", priority: 10 }, owner.userId, ALLOW_WEAKER);
    const audit = () => ({ tenantId: owner.tenantId, sessionId: null, userId: owner.userId, type: "admin.policy_rule.deleted" as const, payload: {} });

    await expect(store.delete(owner.tenantId, block.ruleId, { allowWeaker: false, audit })).rejects.toBeInstanceOf(WeakerChangeError);
    await expect(store.create(owner.tenantId, { name: "allow all", effect: "allow", priority: 0 }, owner.userId,
      { allowWeaker: false, audit })).rejects.toBeInstanceOf(WeakerChangeError);

    expect((await store.list(owner.tenantId)).map((rule) => rule.ruleId)).toEqual([block.ruleId]);
    const events = await superuserPool().query("SELECT 1 FROM audit_events WHERE tenant_id = $1 AND event_type = 'admin.policy_rule.deleted'",
      [owner.tenantId]);
    expect(events.rowCount).toBe(0);

    // With step-up, the same change commits with its audit event.
    await store.delete(owner.tenantId, block.ruleId, { allowWeaker: true, audit });
    expect(await store.list(owner.tenantId)).toEqual([]);
    const committed = await superuserPool().query("SELECT 1 FROM audit_events WHERE tenant_id = $1 AND event_type = 'admin.policy_rule.deleted'",
      [owner.tenantId]);
    expect(committed.rowCount).toBe(1);
  });
});
