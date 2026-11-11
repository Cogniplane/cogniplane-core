import type { PolicyRule } from "@cogniplane/shared-types";
import type { PoolClient } from "pg";
import { describe, expect, test, vi } from "vitest";

import { evaluatePolicy } from "../services/policy/policy-engine.js";
import { PolicyRuleConflictError, PolicyRuleStore } from "../services/policy/policy-rule-store.js";
import { WeakerChangeError } from "../services/weaker-change-error.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedTenantGraph } from "./support/fixtures.js";
import { ALLOW_WEAKER } from "../test-helpers/data-routes.js";

// Match this holder's lock so unrelated work cannot satisfy the waiter count.
async function waitForAdvisoryWaiters(count: number, holder: PoolClient): Promise<void> {
  const { rows } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  await vi.waitFor(async () => {
    const waiting = await superuserPool().query<{ count: string }>(`
      SELECT count(*)::text AS count FROM pg_locks waiting
      JOIN pg_locks held USING (locktype, database, classid, objid, objsubid)
      WHERE waiting.locktype = 'advisory' AND NOT waiting.granted
        AND held.granted AND held.pid = $1`, [rows[0]!.pid]);
    expect(Number(waiting.rows[0]!.count)).toBe(count);
  }, { timeout: 5_000 });
}

// Any lock that this holder has and another backend waits for (here, a row lock).
async function waitForBlockedBy(holder: PoolClient): Promise<void> {
  const { rows } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  await vi.waitFor(async () => {
    const waiting = await superuserPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [rows[0]!.pid]);
    expect(Number(waiting.rows[0]!.count)).toBe(1);
  }, { timeout: 5_000 });
}

async function ruleUpdateEvents(tenantId: string): Promise<Array<Record<string, unknown>>> {
  const events = await superuserPool().query<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM audit_events WHERE tenant_id = $1 AND event_type = 'admin.policy_rule.updated'", [tenantId]);
  return events.rows.map((row) => row.payload);
}

function updateAudit(tenantId: string, userId: string) {
  return vi.fn((saved: PolicyRule) => ({
    tenantId, sessionId: null, userId, type: "admin.policy_rule.updated" as const,
    payload: { name: saved.name, revision: saved.revision }
  }));
}

async function releaseRuleLock(holder: PoolClient, settled: Promise<unknown>): Promise<void> {
  let rollbackError: Error | undefined;
  try {
    await holder.query("ROLLBACK");
  } catch (error) {
    rollbackError = error as Error;
    throw error;
  } finally {
    holder.release(rollbackError);
    await settled;
  }
}

async function holdRuleLock(tenantId: string) {
  const holder = await superuserPool().connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('policy_rule:' || $1, 0))", [tenantId]);
    return holder;
  } catch (error) {
    holder.release(error as Error);
    throw error;
  }
}

describe.skipIf(!adminDatabaseUrl())("policy rule write concurrency", () => {
  test("a partial update does not overwrite a field that a concurrent writer changed", async () => {
    const owner = await seedTenantGraph();
    const store = new PolicyRuleStore(appPool());
    const rule = await store.create(owner.tenantId, { name: "before", effect: "block" }, owner.userId, ALLOW_WEAKER);

    // Another writer holds the tenant's rule lock and turns the rule off.
    const writer = await holdRuleLock(owner.tenantId);
    let settled: Promise<unknown> = Promise.resolve();
    try {
      await writer.query("UPDATE policy_rule SET enabled = FALSE WHERE tenant_id = $1 AND rule_id = $2",
        [owner.tenantId, rule.ruleId]);
      // A rename starts while the writer is open. It must wait for the lock and
      // read after the writer commits.
      const rename = store.update(owner.tenantId, rule.ruleId, { expectedRevision: rule.revision, name: "after" }, ALLOW_WEAKER);
      settled = Promise.allSettled([rename]);
      await waitForAdvisoryWaiters(1, writer);
      await writer.query("COMMIT");

      await expect(rename).resolves.toMatchObject({ name: "after", enabled: false });
    } finally {
      await releaseRuleLock(writer, settled);
    }
    expect(await store.get(owner.tenantId, rule.ruleId)).toMatchObject({ name: "after", enabled: false });
  });

  test("concurrent creates without a priority get different append priorities", async () => {
    const owner = await seedTenantGraph();
    const store = new PolicyRuleStore(appPool());

    // Hold the lock until all five creates wait for it, then let them run.
    const holder = await holdRuleLock(owner.tenantId);
    let created;
    let settled: Promise<unknown> = Promise.resolve();
    try {
      const pending = Array.from({ length: 5 }, (_, index) =>
        store.create(owner.tenantId, { name: `rule ${index}`, effect: "allow" }, owner.userId, ALLOW_WEAKER));
      settled = Promise.allSettled(pending);
      await waitForAdvisoryWaiters(5, holder);
      await holder.query("COMMIT");
      created = await Promise.all(pending);
    } finally {
      await releaseRuleLock(holder, settled);
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
    let settled: Promise<unknown> = Promise.resolve();
    try {
      const pending = Promise.allSettled([
        // After the block rule: never the first match for the export tool.
        store.create(owner.tenantId, { name: "allow exports", effect: "allow", priority: 20,
          conditions: { toolNames: ["export_customers"] } }, owner.userId, { allowWeaker: false }),
        // The only rule, moved: the same outcomes.
        store.update(owner.tenantId, block.ruleId, { expectedRevision: block.revision, priority: 30 }, { allowWeaker: false })
      ]);
      settled = pending;
      await waitForAdvisoryWaiters(2, holder);
      await holder.query("COMMIT");
      results = await pending;
    } finally {
      await releaseRuleLock(holder, settled);
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

// A rule edit names the revision that the admin loaded (expectedRevision). A
// save from an older copy of the rule must not replace a newer save.
describe.skipIf(!adminDatabaseUrl())("policy rule revisions", () => {
  test("a save from an older revision is refused: a stale form cannot turn a stricter rule back off", async () => {
    const owner = await seedTenantGraph();
    const store = new PolicyRuleStore(appPool());
    // Admin A opens an allow rule that is off.
    const loaded = await store.create(owner.tenantId, { name: "Allow exports", effect: "allow", enabled: false,
      conditions: { toolNames: ["export_customers"] } }, owner.userId, ALLOW_WEAKER);
    // Admin B turns it on and makes it a block rule.
    await store.update(owner.tenantId, loaded.ruleId,
      { expectedRevision: loaded.revision, enabled: true, effect: "block" }, { allowWeaker: false });

    // Admin A saves the old form with a new name. A has step-up (or needs none).
    const audit = updateAudit(owner.tenantId, owner.userId);
    await expect(store.update(owner.tenantId, loaded.ruleId, {
      expectedRevision: loaded.revision, name: "Allow customer exports", enabled: false, effect: "allow",
      conditions: { toolNames: ["export_customers"] }, reason: null
    }, { allowWeaker: true, audit })).rejects.toBeInstanceOf(PolicyRuleConflictError);

    expect(await store.get(owner.tenantId, loaded.ruleId)).toMatchObject({
      name: "Allow exports", enabled: true, effect: "block", revision: 2
    });
    expect(audit).not.toHaveBeenCalled();
    expect(await ruleUpdateEvents(owner.tenantId)).toEqual([]);
  });

  // The revision check runs before the weaker-change check, so a stale save
  // answers 409 and never asks for step-up.
  test("a stale save that would also make the policy weaker is refused as a conflict, not as a weaker change", async () => {
    const owner = await seedTenantGraph();
    const store = new PolicyRuleStore(appPool());
    const loaded = await store.create(owner.tenantId, { name: "Block exports", effect: "block" }, owner.userId, ALLOW_WEAKER);
    await store.update(owner.tenantId, loaded.ruleId, { expectedRevision: loaded.revision, name: "Block all exports" }, { allowWeaker: false });

    await expect(store.update(owner.tenantId, loaded.ruleId, { expectedRevision: loaded.revision, enabled: false },
      { allowWeaker: false })).rejects.toMatchObject({ name: "PolicyRuleConflictError" });
    expect(await store.get(owner.tenantId, loaded.ruleId)).toMatchObject({ name: "Block all exports", enabled: true, revision: 2 });
  });

  test("a save from the current revision writes the change, its audit event, and the next revision", async () => {
    const owner = await seedTenantGraph();
    const store = new PolicyRuleStore(appPool());
    const rule = await store.create(owner.tenantId, { name: "Ask first", effect: "require_approval" }, owner.userId, ALLOW_WEAKER);
    const audit = updateAudit(owner.tenantId, owner.userId);

    const saved = await store.update(owner.tenantId, rule.ruleId,
      { expectedRevision: rule.revision, name: "Ask before exports" }, { allowWeaker: false, audit });

    expect(rule.revision).toBe(1);
    expect(saved).toMatchObject({ name: "Ask before exports", effect: "require_approval", revision: 2 });
    expect(await store.get(owner.tenantId, rule.ruleId)).toEqual(saved);
    expect(await ruleUpdateEvents(owner.tenantId)).toEqual([{ name: "Ask before exports", revision: 2 }]);
  });

  test("two saves from the same revision: the first one is stored and the second is refused with no audit event", async () => {
    const owner = await seedTenantGraph();
    const store = new PolicyRuleStore(appPool());
    const rule = await store.create(owner.tenantId, { name: "Ask first", effect: "require_approval" }, owner.userId, ALLOW_WEAKER);
    const audit = updateAudit(owner.tenantId, owner.userId);

    // Both saves wait for the tenant's rule lock, then run one after the other.
    const holder = await holdRuleLock(owner.tenantId);
    let results: PromiseSettledResult<PolicyRule | null>[];
    let settled: Promise<unknown> = Promise.resolve();
    try {
      const pending = Promise.allSettled([
        store.update(owner.tenantId, rule.ruleId, { expectedRevision: rule.revision, name: "Block", effect: "block" }, { allowWeaker: true, audit }),
        store.update(owner.tenantId, rule.ruleId, { expectedRevision: rule.revision, name: "Allow", effect: "allow" }, { allowWeaker: true, audit })
      ]);
      settled = pending;
      await waitForAdvisoryWaiters(2, holder);
      await holder.query("COMMIT");
      results = await pending;
    } finally {
      await releaseRuleLock(holder, settled);
    }

    const stored = results.filter((result): result is PromiseFulfilledResult<PolicyRule | null> => result.status === "fulfilled");
    const refused = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(stored).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toBeInstanceOf(PolicyRuleConflictError);
    const winner = stored[0]!.value!;
    expect(winner.revision).toBe(2);
    expect(await store.get(owner.tenantId, rule.ruleId)).toEqual(winner);
    expect(await ruleUpdateEvents(owner.tenantId)).toEqual([{ name: winner.name, revision: 2 }]);
  });

  // Every store write takes the tenant's rule lock. The UPDATE also names the
  // revision, so a writer that skips the lock cannot be overwritten either.
  test("the update refuses an older revision that a writer without the rule lock replaced after the read", async () => {
    const owner = await seedTenantGraph();
    const store = new PolicyRuleStore(appPool());
    const rule = await store.create(owner.tenantId, { name: "Block exports", effect: "block" }, owner.userId, ALLOW_WEAKER);

    // The writer holds the row lock, not the tenant's rule lock.
    const writer = await superuserPool().connect();
    let settled: Promise<unknown> = Promise.resolve();
    try {
      await writer.query("BEGIN");
      await writer.query("UPDATE policy_rule SET enabled = FALSE, revision = revision + 1 WHERE tenant_id = $1 AND rule_id = $2",
        [owner.tenantId, rule.ruleId]);
      // The store reads revision 1, because the writer has not committed. Its UPDATE then waits for the row.
      const stale = store.update(owner.tenantId, rule.ruleId, { expectedRevision: rule.revision, name: "Block customer exports" }, ALLOW_WEAKER);
      settled = Promise.allSettled([stale]);
      await waitForBlockedBy(writer);
      await writer.query("COMMIT");
      await expect(stale).rejects.toBeInstanceOf(PolicyRuleConflictError);
    } finally {
      await releaseRuleLock(writer, settled);
    }
    expect(await store.get(owner.tenantId, rule.ruleId)).toMatchObject({ name: "Block exports", enabled: false, revision: 2 });
  });

  // A rule's place in the order is part of what it does (the first match
  // decides), so an edit from before a move must see the move.
  test("a reorder gives each rule that it moves a new revision, so an edit from before the move is refused", async () => {
    const owner = await seedTenantGraph();
    const store = new PolicyRuleStore(appPool());
    const first = await store.create(owner.tenantId, { name: "first", effect: "block", priority: 0 }, owner.userId, ALLOW_WEAKER);
    const second = await store.create(owner.tenantId, { name: "second", effect: "block", priority: 10 }, owner.userId, ALLOW_WEAKER);
    const third = await store.create(owner.tenantId, { name: "third", effect: "block", priority: 20 }, owner.userId, ALLOW_WEAKER);

    const reordered = await store.reorder(owner.tenantId, [second.ruleId, first.ruleId, third.ruleId], ALLOW_WEAKER);
    expect(reordered.map((rule) => [rule.name, rule.priority, rule.revision])).toEqual([
      ["second", 0, 2], ["first", 10, 2], ["third", 20, 1]
    ]);

    await expect(store.update(owner.tenantId, first.ruleId, { expectedRevision: first.revision, enabled: false }, ALLOW_WEAKER))
      .rejects.toBeInstanceOf(PolicyRuleConflictError);
    await expect(store.update(owner.tenantId, third.ruleId, { expectedRevision: third.revision, name: "third, renamed" }, ALLOW_WEAKER))
      .resolves.toMatchObject({ name: "third, renamed", revision: 2 });
    expect(await store.get(owner.tenantId, first.ruleId)).toMatchObject({ enabled: true, revision: 2 });
  });

  test("a rule of another tenant is not found, and stays as it is", async () => {
    const owner = await seedTenantGraph();
    const other = await seedTenantGraph();
    const store = new PolicyRuleStore(appPool());
    const theirs = await store.create(other.tenantId, { name: "Block exports", effect: "block" }, other.userId, ALLOW_WEAKER);

    await expect(store.update(owner.tenantId, theirs.ruleId, { expectedRevision: theirs.revision, enabled: false }, ALLOW_WEAKER))
      .resolves.toBeNull();
    expect(await store.get(other.tenantId, theirs.ruleId)).toEqual(theirs);
  });
});
