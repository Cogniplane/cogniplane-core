import { describe, expect, test, vi } from "vitest";

import { ApprovalStore } from "../services/auth/approval-store.js";
import { adminDatabaseUrl, appPool, maintenancePool, superuserPool } from "./support/database.js";
import { seedApproval, seedMembership, seedTenantGraph } from "./support/fixtures.js";

// The MCP gateway claims an approved Policy Center decision before dispatch.
// One approval must authorize exactly one call, even when dispatches race.
describe.skipIf(!adminDatabaseUrl())("ApprovalStore.consume", () => {
  async function consumedAt(approvalId: string) {
    const result = await superuserPool().query<{ consumed_at: Date | null }>(
      "SELECT consumed_at FROM approvals WHERE approval_id = $1",
      [approvalId]
    );
    return result.rows[0]!.consumed_at;
  }

  async function setup(status: "approved" | "pending" | "approved-reject" = "approved") {
    const owner = await seedTenantGraph();
    const other = await seedTenantGraph();
    const approvalId = await seedApproval({
      tenantId: owner.tenantId, userId: owner.userId, sessionId: owner.sessionId, runtimeId: owner.runtimeId
    });
    if (status !== "pending") {
      await superuserPool().query(
        "UPDATE approvals SET status = 'approved', decision = $2, resolved_at = NOW() WHERE approval_id = $1",
        [approvalId, status === "approved" ? "approve" : "reject"]
      );
    }
    return { owner, other, approvalId };
  }

  test("claims an approved decision once", async () => {
    const { owner, approvalId } = await setup();
    const store = new ApprovalStore(appPool());

    expect(await store.consume(owner.tenantId, approvalId, owner.userId)).toBe(true);
    expect(await consumedAt(approvalId)).toBeInstanceOf(Date);
    expect(await store.consume(owner.tenantId, approvalId, owner.userId)).toBe(false);
  });

  test.each(["pending", "approved-reject"] as const)("refuses to claim a %s decision", async (status) => {
    const { owner, approvalId } = await setup(status);

    expect(await new ApprovalStore(maintenancePool()).consume(owner.tenantId, approvalId, owner.userId)).toBe(false);
    expect(await consumedAt(approvalId)).toBeNull();
  });

  test("refuses a claim by another user or tenant", async () => {
    const { owner, other, approvalId } = await setup();
    await seedMembership(owner.tenantId, other.userId);

    expect(await new ApprovalStore(maintenancePool()).consume(owner.tenantId, approvalId, other.userId)).toBe(false);
    expect(await new ApprovalStore(maintenancePool()).consume(other.tenantId, approvalId, owner.userId)).toBe(false);
    expect(await new ApprovalStore(appPool()).consume(other.tenantId, approvalId, owner.userId)).toBe(false);
    expect(await consumedAt(approvalId)).toBeNull();
  });

  test("lets exactly one of two racing dispatches claim the approval", async () => {
    const { owner, approvalId } = await setup();
    const store = new ApprovalStore(appPool());
    const blocker = await superuserPool().connect();
    const pending: Promise<boolean>[] = [];
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT approval_id FROM approvals WHERE approval_id=$1 FOR UPDATE", [approvalId]);
      pending.push(store.consume(owner.tenantId, approvalId, owner.userId));
      pending.push(store.consume(owner.tenantId, approvalId, owner.userId));
      // Prove both UPDATEs reached Postgres and wait on the row lock.
      await vi.waitFor(async () => {
        const result = await superuserPool().query<{ count: string }>(`SELECT count(*) FROM pg_stat_activity
          WHERE datname=current_database() AND application_name='cogniplane-integration-app-user'
            AND wait_event_type='Lock' AND query LIKE '%UPDATE approvals%'`);
        expect(Number(result.rows[0]!.count)).toBe(2);
      });
      await blocker.query("COMMIT");
      expect((await Promise.all(pending)).filter(Boolean)).toHaveLength(1);
      expect(await consumedAt(approvalId)).toBeInstanceOf(Date);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await Promise.allSettled(pending);
    }
  });
});
