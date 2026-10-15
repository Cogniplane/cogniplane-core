import { describe, expect, test } from "vitest";

import { PolicyRuleStore } from "../services/policy/policy-rule-store.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedTenantGraph } from "./support/fixtures.js";

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
    const rule = await store.create(owner.tenantId, { name: "before", effect: "block" }, owner.userId);

    // Another writer holds the tenant's rule lock and turns the rule off.
    const writer = await holdRuleLock(owner.tenantId);
    try {
      await writer.query("UPDATE policy_rule SET enabled = FALSE WHERE tenant_id = $1 AND rule_id = $2",
        [owner.tenantId, rule.ruleId]);
      // A rename starts while the writer is open. It must wait for the lock and
      // read after the writer commits.
      const rename = store.update(owner.tenantId, rule.ruleId, { name: "after" });
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
        store.create(owner.tenantId, { name: `rule ${index}`, effect: "allow" }, owner.userId)));
      await waitForAdvisoryWaiters(5);
      await holder.query("COMMIT");
      created = await pending;
    } finally {
      holder.release();
    }

    expect(new Set(created.map((rule) => rule.priority)).size).toBe(5);
  });
});
