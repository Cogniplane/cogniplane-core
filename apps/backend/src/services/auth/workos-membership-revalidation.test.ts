import { describe, expect, test, vi } from "vitest";

import { FakePool } from "../../test-helpers/fake-pool.js";
import { createFakeWorkOS } from "../../test-helpers/fake-workos.js";
import { WorkOsMembershipRevalidation } from "./workos-membership-revalidation.js";

function harness(input: {
  failRemoval?: boolean; missingMembership?: boolean; missingProviderIds?: boolean; alreadyRemoved?: boolean;
  role?: "owner" | "member"; otherOwner?: boolean;
} = {}) {
  const lookupDb = new FakePool();
  const db = new FakePool();
  const { workos, mocks } = createFakeWorkOS();
  const afterSecurityChange = vi.fn(async () => {});
  const afterRemoval = vi.fn(async (_member: { tenantId: string; userId: string }) => {});
  lookupDb.onQuery("SELECT u.workos_user_id, t.workos_org_id", () => ({
    rows: input.missingMembership ? [] : [{ workos_user_id: input.missingProviderIds ? null : "workos-user", workos_org_id: "org-one" }],
    rowCount: input.missingMembership ? 0 : 1
  }));
  db.onQuery("SELECT s.session_id FROM sessions s", () => ({ rows: [], rowCount: 0 }));
  db.onQuery("SELECT role, user_auth_source FROM tenant_memberships", () => ({
    rows: input.alreadyRemoved ? [] : [{ role: input.role ?? "member", user_auth_source: "workos" }],
    rowCount: input.alreadyRemoved ? 0 : 1
  }));
  db.onQuery("WHERE tenant_id = $1 AND role = 'owner' AND user_id <> $2", () => ({
    rows: input.otherOwner ? [{}] : [], rowCount: input.otherOwner ? 1 : 0
  }));
  if (input.failRemoval) {
    db.onQuery("INSERT INTO tenant_member_removals", () => { throw new Error("write failed"); });
  }
  for (const sql of ["UPDATE scheduled_jobs", "DELETE FROM project_memberships", "DELETE FROM tenant_memberships",
    "INSERT INTO tenant_member_removals", "INSERT INTO audit_events", "UPDATE session_executions"]) {
    db.onQuery(sql, () => ({ rows: [], rowCount: sql.includes("project_memberships") ? 2 : 1 }));
  }
  db.onQuery("WITH taken AS", () => ({
    rows: [{ user_id: "user-one", session_id: "chat-one", sandbox_id: "sandbox-one" }], rowCount: 1
  }));
  const service = new WorkOsMembershipRevalidation({
    lookupDb: lookupDb.asPool(), db: db.asPool(), workos, afterSecurityChange, afterRemoval
  });
  return { service, lookupDb, db, mocks, afterSecurityChange, afterRemoval };
}

const ACTIVE = { userId: "workos-user", organizationId: "org-one", status: "active" };

describe("WorkOS membership revalidation", () => {
  test("checks the bound organization and user and retains an active member", async () => {
    const h = harness();
    h.mocks.listOrganizationMemberships.mockResolvedValue({ data: [ACTIVE] });
    expect(await h.service.revalidate("tenant-one", "user-one")).toBe(true);
    expect(h.lookupDb.queries[0]?.values).toEqual(["tenant-one", "user-one"]);
    expect(h.mocks.listOrganizationMemberships).toHaveBeenCalledWith({
      userId: "workos-user", organizationId: "org-one", statuses: ["active"]
    });
    expect(h.db.queries).toEqual([]);
    expect(h.afterSecurityChange).not.toHaveBeenCalled();
    expect(h.afterRemoval).not.toHaveBeenCalled();
  });

  test.each([
    ["deleted", []],
    ["disabled", [{ ...ACTIVE, status: "inactive" }]],
    ["pending", [{ ...ACTIVE, status: "pending" }]],
    ["another organization", [{ ...ACTIVE, organizationId: "org-other" }]],
    ["another user", [{ ...ACTIVE, userId: "workos-other" }]]
  ])("ends a %s membership, pauses jobs and stops active work after commit", async (_name, data) => {
    const h = harness();
    h.mocks.listOrganizationMemberships.mockResolvedValue({ data });
    h.afterSecurityChange.mockImplementation(async () => {
      expect(h.db.queries.at(-1)?.text).toBe("COMMIT");
    });
    expect(await h.service.revalidate("tenant-one", "user-one")).toBe(false);
    // The confirming read has no status filter.
    expect(h.mocks.listOrganizationMemberships).toHaveBeenCalledTimes(2);
    expect(h.mocks.listOrganizationMemberships).toHaveBeenLastCalledWith({ userId: "workos-user", organizationId: "org-one" });
    const statements = h.db.queries.map(({ text }) => text);
    expect(statements).toContainEqual(expect.stringContaining("UPDATE scheduled_jobs"));
    expect(statements).toContainEqual(expect.stringContaining("DELETE FROM project_memberships"));
    expect(statements).toContainEqual(expect.stringContaining("DELETE FROM tenant_memberships"));
    expect(statements).toContainEqual(expect.stringContaining("INSERT INTO tenant_member_removals"));
    const audit = h.db.queries.find(({ text }) => text.includes("INSERT INTO audit_events"));
    expect(JSON.parse(audit!.values[5] as string)).toMatchObject({ projectRolesRemoved: 2, reason: "workos_membership_inactive" });
    expect(h.afterSecurityChange).toHaveBeenCalledWith({
      tenantId: "tenant-one", userIds: ["user-one"],
      releasedSandboxes: [{ tenantId: "tenant-one", userId: "user-one", sessionId: "chat-one", sandboxId: "sandbox-one" }]
    });
  });

  // Same follow-up as a removal in People: the member's stored connections are revoked.
  test("revokes the member's connections after the removal commits", async () => {
    const h = harness();
    h.mocks.listOrganizationMemberships.mockResolvedValue({ data: [] });
    h.afterRemoval.mockImplementation(async () => {
      expect(h.db.queries.at(-1)?.text).toBe("COMMIT");
    });
    expect(await h.service.revalidate("tenant-one", "user-one")).toBe(false);
    expect(h.afterRemoval).toHaveBeenCalledExactlyOnceWith({ tenantId: "tenant-one", userId: "user-one" });
  });

  test("does not revoke connections again when another request removed the member first", async () => {
    const h = harness({ alreadyRemoved: true });
    h.mocks.listOrganizationMemberships.mockResolvedValue({ data: [] });
    expect(await h.service.revalidate("tenant-one", "user-one")).toBe(false);
    expect(h.afterRemoval).not.toHaveBeenCalled();
  });

  test("reads that disagree throw and remove nothing", async () => {
    const h = harness();
    h.mocks.listOrganizationMemberships.mockResolvedValueOnce({ data: [] }).mockResolvedValueOnce({ data: [ACTIVE] });
    await expect(h.service.revalidate("tenant-one", "user-one")).rejects.toThrow("WorkOS membership reads disagree.");
    expect(h.mocks.listOrganizationMemberships).toHaveBeenCalledTimes(2);
    expect(h.db.queries).toEqual([]);
    expect(h.afterSecurityChange).not.toHaveBeenCalled();
    expect(h.afterRemoval).not.toHaveBeenCalled();
  });

  test("a failed confirming read removes nothing", async () => {
    const h = harness();
    h.mocks.listOrganizationMemberships.mockResolvedValueOnce({ data: [] }).mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(h.service.revalidate("tenant-one", "user-one")).rejects.toThrow("provider unavailable");
    expect(h.db.queries).toEqual([]);
    expect(h.afterRemoval).not.toHaveBeenCalled();
  });

  test("the last owner is refused but keeps the membership, jobs and connections", async () => {
    const h = harness({ role: "owner" });
    h.mocks.listOrganizationMemberships.mockResolvedValue({ data: [] });
    expect(await h.service.revalidate("tenant-one", "user-one")).toBe(false);
    const statements = h.db.queries.map(({ text }) => text);
    for (const sql of ["UPDATE scheduled_jobs", "DELETE FROM project_memberships", "DELETE FROM tenant_memberships",
      "INSERT INTO tenant_member_removals"]) {
      expect(statements).not.toContainEqual(expect.stringContaining(sql));
    }
    const audit = h.db.queries.find(({ text }) => text.includes("INSERT INTO audit_events"));
    expect(audit!.values).toContain("tenant.member.removal_refused");
    expect(JSON.parse(audit!.values[5] as string)).toEqual({
      targetUserId: "user-one", role: "owner", reason: "workos_membership_inactive_last_owner"
    });
    expect(statements.at(-1)).toBe("COMMIT");
    expect(h.afterSecurityChange).not.toHaveBeenCalled();
    expect(h.afterRemoval).not.toHaveBeenCalled();
  });

  test("an owner is removed when the tenant has another owner", async () => {
    const h = harness({ role: "owner", otherOwner: true });
    h.mocks.listOrganizationMemberships.mockResolvedValue({ data: [] });
    expect(await h.service.revalidate("tenant-one", "user-one")).toBe(false);
    const statements = h.db.queries.map(({ text }) => text);
    expect(statements).toContainEqual(expect.stringContaining("DELETE FROM tenant_memberships"));
    expect(statements).toContainEqual(expect.stringContaining("INSERT INTO tenant_member_removals"));
    const audit = h.db.queries.find(({ text }) => text.includes("INSERT INTO audit_events"));
    expect(audit!.values).toContain("tenant.member.removed");
    expect(JSON.parse(audit!.values[5] as string)).toMatchObject({ previousRole: "owner", reason: "workos_membership_inactive" });
    expect(h.afterRemoval).toHaveBeenCalledExactlyOnceWith({ tenantId: "tenant-one", userId: "user-one" });
  });

  test("a WorkOS outage does not delete membership or stop work", async () => {
    const h = harness();
    h.mocks.listOrganizationMemberships.mockRejectedValue(new Error("provider unavailable"));
    await expect(h.service.revalidate("tenant-one", "user-one")).rejects.toThrow("provider unavailable");
    expect(h.db.queries).toEqual([]);
    expect(h.afterSecurityChange).not.toHaveBeenCalled();
    expect(h.afterRemoval).not.toHaveBeenCalled();
  });

  test("a missing local membership is refused without a provider call", async () => {
    const h = harness({ missingMembership: true });
    expect(await h.service.revalidate("tenant-one", "user-one")).toBe(false);
    expect(h.mocks.listOrganizationMemberships).not.toHaveBeenCalled();
    expect(h.db.queries).toEqual([]);
  });

  test("missing provider identifiers fail closed without removing the member", async () => {
    const h = harness({ missingProviderIds: true });
    await expect(h.service.revalidate("tenant-one", "user-one")).rejects.toThrow("WorkOS identity identifiers are missing.");
    expect(h.mocks.listOrganizationMemberships).not.toHaveBeenCalled();
    expect(h.db.queries).toEqual([]);
  });

  test("a failed removal rolls back and never stops active work", async () => {
    const h = harness({ failRemoval: true });
    h.mocks.listOrganizationMemberships.mockResolvedValue({ data: [] });
    await expect(h.service.revalidate("tenant-one", "user-one")).rejects.toThrow("write failed");
    expect(h.db.queries.at(-1)?.text).toBe("ROLLBACK");
    expect(h.afterSecurityChange).not.toHaveBeenCalled();
    expect(h.afterRemoval).not.toHaveBeenCalled();
  });
});
