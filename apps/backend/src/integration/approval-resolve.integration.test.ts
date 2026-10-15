import { describe, expect, test, vi } from "vitest";

import { withTenantScope } from "../lib/db.js";
import { ApprovalStore } from "../services/auth/approval-store.js";
import { adminDatabaseUrl, appPool, maintenancePool, superuserPool } from "./support/database.js";
import { seedApproval, seedMembership, seedTenantGraph } from "./support/fixtures.js";

// ApprovalStore.resolve is the last guard for a decision that arrives on
// another replica: its UPDATE only matches a pending, unexpired row of the
// same tenant and user. The refusal cases run on the privileged pool, which
// RLS does not filter, so each one can be refused by exactly one predicate.
describe.skipIf(!adminDatabaseUrl())("ApprovalStore.resolve", () => {
  async function row(approvalId: string) {
    const result = await superuserPool().query<{ status: string; decision: string | null; resolved_at: Date | null }>(
      "SELECT status, decision, resolved_at FROM approvals WHERE approval_id = $1",
      [approvalId]
    );
    return result.rows[0]!;
  }

  async function setup(options: { expired?: boolean } = {}) {
    const owner = await seedTenantGraph();
    const other = await seedTenantGraph();
    const approvalId = await seedApproval({
      tenantId: owner.tenantId, userId: owner.userId, sessionId: owner.sessionId, runtimeId: owner.runtimeId,
      expired: options.expired
    });
    return { owner, other, approvalId };
  }

  test.each(["approve", "reject"] as const)("records an owner's %s decision", async (decision) => {
    const { owner, approvalId } = await setup();

    const resolved = await new ApprovalStore(appPool()).resolve(owner.tenantId, approvalId, owner.userId, decision);

    const status = decision === "approve" ? "approved" : "rejected";
    expect(resolved).toMatchObject({ approvalId, status, decision });
    expect(await row(approvalId)).toMatchObject({ status, decision, resolved_at: expect.any(Date) });
  });

  test("refuses a decision made in another tenant", async () => {
    const { owner, other, approvalId } = await setup();

    expect(await new ApprovalStore(maintenancePool()).resolve(other.tenantId, approvalId, owner.userId, "approve")).toBeNull();
    expect(await row(approvalId)).toEqual({ status: "pending", decision: null, resolved_at: null });
  });

  test("refuses a decision by another user of the same tenant", async () => {
    const { owner, other, approvalId } = await setup();
    await seedMembership(owner.tenantId, other.userId);

    expect(await new ApprovalStore(maintenancePool()).resolve(owner.tenantId, approvalId, other.userId, "approve")).toBeNull();
    expect(await row(approvalId)).toEqual({ status: "pending", decision: null, resolved_at: null });
  });

  test("refuses a second decision on an approval that is already resolved", async () => {
    const { owner, approvalId } = await setup();
    await superuserPool().query(
      "UPDATE approvals SET status = 'rejected', decision = 'reject', resolved_at = NOW() WHERE approval_id = $1",
      [approvalId]
    );

    expect(await new ApprovalStore(maintenancePool()).resolve(owner.tenantId, approvalId, owner.userId, "approve")).toBeNull();
    expect(await row(approvalId)).toMatchObject({ status: "rejected", decision: "reject" });
  });

  test("refuses a decision on a pending approval past its expiry", async () => {
    const { owner, approvalId } = await setup({ expired: true });

    expect(await new ApprovalStore(maintenancePool()).resolve(owner.tenantId, approvalId, owner.userId, "approve")).toBeNull();
    expect(await row(approvalId)).toEqual({ status: "pending", decision: null, resolved_at: null });
  });

  test("hides another tenant's approval from the RLS pool too", async () => {
    const { owner, other, approvalId } = await setup();

    expect(await new ApprovalStore(appPool()).resolve(other.tenantId, approvalId, owner.userId, "approve")).toBeNull();
    expect((await row(approvalId)).status).toBe("pending");
  });

  test("RLS alone hides and prevents updates to a foreign approval", async () => {
    const { other, approvalId } = await setup();
    await withTenantScope(appPool(), other.tenantId, async (client) => {
      expect((await client.query("SELECT * FROM approvals WHERE approval_id=$1", [approvalId])).rows).toEqual([]);
      expect((await client.query("UPDATE approvals SET status='approved' WHERE approval_id=$1 RETURNING *",
        [approvalId])).rows).toEqual([]);
    });
    expect(await row(approvalId)).toEqual({ status: "pending", decision: null, resolved_at: null });
  });

  test.each(["second answer", "expiry"] as const)("only one transition wins while an answer races %s", async (rival) => {
    const { owner, approvalId } = await setup();
    const store = new ApprovalStore(appPool());
    const blocker = await superuserPool().connect();
    const pending: Promise<unknown>[] = [];
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT approval_id FROM approvals WHERE approval_id=$1 FOR UPDATE", [approvalId]);
      pending.push(store.resolve(owner.tenantId, approvalId, owner.userId, "approve"));
      pending.push(rival === "expiry" ? store.expire(owner.tenantId, approvalId)
        : store.resolve(owner.tenantId, approvalId, owner.userId, "reject"));
      // Prove both UPDATEs reached Postgres and wait on locks before release.
      await vi.waitFor(async () => {
        const result = await superuserPool().query<{ count: string }>(`SELECT count(*) FROM pg_stat_activity
          WHERE datname=current_database() AND application_name='cogniplane-integration-app-user'
            AND wait_event_type='Lock' AND query LIKE '%UPDATE approvals%'`);
        expect(Number(result.rows[0]!.count)).toBe(2);
      });
      await blocker.query("COMMIT");
      const results = await Promise.all(pending);
      expect(results.filter(Boolean)).toHaveLength(1);
      const winner = await row(approvalId);
      expect(winner.status).toBe(results[0] ? "approved" : rival === "expiry" ? "expired" : "rejected");
      expect(winner.decision).toBe(results[0] ? "approve" : rival === "expiry" ? null : "reject");
      expect(winner.resolved_at).toBeInstanceOf(Date);
      expect(await store.resolve(owner.tenantId, approvalId, owner.userId, "reject")).toBeNull();
      expect(await store.expire(owner.tenantId, approvalId)).toBeNull();
      expect(await row(approvalId)).toEqual(winner);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await Promise.allSettled(pending);
    }
  });
});
