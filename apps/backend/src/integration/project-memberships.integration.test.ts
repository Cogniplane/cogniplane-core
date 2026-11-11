import { describe, expect, test, vi } from "vitest";
import { AuditEventStore } from "../services/audit-event-store.js";
import { SessionStore } from "../services/session-store.js";
import { ProjectStore } from "../services/project-store.js";
import { ProjectMemberStore } from "../services/project-member-store.js";
import { requireProjectAccess } from "../services/project-access.js";
import { withTenantScope } from "../lib/db.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedMembership, seedTenant, seedUser } from "./support/fixtures.js";

const privateViewer = { visibility: "private", organizationRole: "viewer" } as const;
const sharedViewer = { visibility: "organization", organizationRole: "viewer" } as const;
const sharedEditor = { visibility: "organization", organizationRole: "editor" } as const;

async function setup() {
  const tenantId = await seedTenant();
  const userId = await seedUser();
  await seedMembership(tenantId, userId);
  const projects = new ProjectStore(appPool());
  const project = await projects.create(tenantId, userId, "Shared work");
  const actor = { tenantId, userId, projectId: project.projectId };
  const members = new ProjectMemberStore(appPool());
  const member = async (role: "owner" | "admin" | "member" = "member") => {
    const id = await seedUser();
    await seedMembership(tenantId, id, role);
    return { ...actor, userId: id };
  };
  const access = (who = actor) => withTenantScope(appPool(), who.tenantId,
    (db) => requireProjectAccess(db, who));
  return { actor, member, members, projects, access };
}

describe.skipIf(!adminDatabaseUrl())("project membership authorization", () => {
  test.each(["sharing", "membership"])("serializes organization departure with an owner's %s change", async operation => {
    const h = await setup();
    const target = await h.member();
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const writing = new Promise<void>(resolve => { reached = resolve; });
    const original = AuditEventStore.createInTransaction;
    const audit = vi.spyOn(AuditEventStore, "createInTransaction").mockImplementationOnce(async (db, input) => {
      await original(db, input);
      reached();
      await gate;
    });
    const change = operation === "sharing"
      ? h.members.setSharing(h.actor, { ...sharedViewer, confirmAudience: true, expected: privateViewer })
      : h.members.setMember(h.actor, target.userId, "editor");
    const departing = await superuserPool().connect();
    let departure: Promise<unknown> | undefined;
    try {
      await writing;
      const pid = (await departing.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      departure = departing.query("DELETE FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2", [h.actor.tenantId, h.actor.userId]);
      await vi.waitFor(async () => {
        const blocked = await superuserPool().query("SELECT cardinality(pg_blocking_pids($1)) AS count", [pid]);
        expect(blocked.rows[0].count).toBeGreaterThan(0);
      });
      release();
      await change;
      await departure;
      await expect(h.members.setMember(h.actor, target.userId, "owner")).rejects.toMatchObject({ status: 404 });
    } finally {
      release();
      await Promise.allSettled([change, departure]);
      audit.mockRestore();
      departing.release();
    }
  });

  test("starts private, admits only organization members, and does not give admins content access", async () => {
    const h = await setup();
    expect(await h.access()).toMatchObject({ role: "owner", visibility: "private", organizationRole: "viewer" });
    const stranger = await h.member();
    const admin = await h.member("admin");
    await expect(h.access(stranger)).rejects.toMatchObject({ status: 404 });
    await expect(h.access(admin)).rejects.toMatchObject({ status: 404 });
    const outsider = await seedUser();
    await expect(h.members.setMember(h.actor, outsider, "owner")).rejects.toMatchObject({ status: 404 });
    const otherTenant = await seedTenant();
    await seedMembership(otherTenant, outsider);
    await expect(h.members.setMember(h.actor, outsider, "viewer")).rejects.toMatchObject({ status: 404 });
    await expect(h.access({ ...h.actor, tenantId: otherTenant, userId: outsider })).rejects.toMatchObject({ status: 404 });
    await withTenantScope(appPool(), otherTenant, async (db) => {
      expect((await db.query("SELECT * FROM project_memberships WHERE project_id=$1", [h.actor.projectId])).rows).toEqual([]);
      await expect(db.query("INSERT INTO project_memberships (tenant_id,project_id,user_id,role) VALUES ($1,$2,$3,'owner')",
        [h.actor.tenantId, h.actor.projectId, outsider])).rejects.toMatchObject({ code: "42501" });
    });
  });

  test("uses the highest explicit or organization role, with confirmation for audience changes", async () => {
    const h = await setup();
    const editor = await h.member();
    const viewer = await h.member();
    await h.members.setMember(h.actor, editor.userId, "editor");
    await h.members.setMember(h.actor, viewer.userId, "viewer");
    await expect(h.members.setSharing(h.actor, { ...sharedViewer, expected: privateViewer }))
      .rejects.toMatchObject({ code: "project_audience_confirmation_required" });
    expect((await h.access()).visibility).toBe("private");
    await h.members.setSharing(h.actor, { ...sharedViewer, confirmAudience: true, expected: privateViewer });
    expect((await h.access(editor)).role).toBe("editor");
    expect((await h.access(viewer)).role).toBe("viewer");
    expect((await h.access(await h.member())).role).toBe("viewer");
    await h.members.setSharing(h.actor, { ...sharedEditor, confirmAudience: true, expected: sharedViewer });
    expect((await h.access(viewer)).role).toBe("editor");
    expect((await h.access()).role).toBe("owner");
    await expect(h.members.setMember(editor, viewer.userId, "owner")).rejects.toMatchObject({ status: 403 });
    await expect(h.members.setSharing(editor, { ...privateViewer, expected: sharedEditor })).rejects.toMatchObject({ status: 403 });
  });

  test("allows editors to create or assign their sessions and denies viewer assignment", async () => {
    const h = await setup();
    const editor = await h.member(), viewer = await h.member();
    await h.members.setMember(h.actor, editor.userId, "editor");
    await h.members.setMember(h.actor, viewer.userId, "viewer");
    const id = await h.projects.createSession(editor.tenantId, editor.userId, editor.projectId, "Editor session");
    expect(id).toBeTruthy();
    const sessions = new SessionStore(appPool());
    expect(await sessions.getOwned(editor.tenantId, id!, editor.userId)).toMatchObject({
      userId: editor.userId, projectId: editor.projectId,
    });
    const privateSession = await sessions.create(editor.tenantId, editor.userId, "Private work");
    expect(await h.projects.setSession(editor.tenantId, editor.userId, editor.projectId, privateSession.sessionId)).toBe(true);
    await expect(h.projects.createSession(viewer.tenantId, viewer.userId, viewer.projectId, "Denied")).rejects.toMatchObject({ status: 403 });
    const viewerSession = await sessions.create(viewer.tenantId, viewer.userId, "Private work");
    await expect(h.projects.setSession(viewer.tenantId, viewer.userId, viewer.projectId, viewerSession.sessionId)).rejects.toMatchObject({ status: 403 });
    expect(await h.projects.setSession(editor.tenantId, editor.userId, editor.projectId, viewerSession.sessionId)).toBe(false);
  });

  test("requires acknowledgement of retained organization access and reports effective roles", async () => {
    const h = await setup();
    const viewer = await h.member();
    await h.members.setMember(h.actor, viewer.userId, "editor");
    await h.members.setSharing(h.actor, { ...sharedEditor, confirmAudience: true, expected: privateViewer });
    await expect(h.members.setMember(h.actor, viewer.userId, "viewer"))
      .rejects.toMatchObject({ code: "project_organization_access_retained", status: 409 });
    await expect(h.members.setMember(h.actor, viewer.userId, "viewer", { confirmRetainedRole: "viewer" }))
      .rejects.toMatchObject({ code: "project_organization_access_retained" });
    expect((await h.members.list(h.actor)).members.find((m) => m.userId === viewer.userId)?.role).toBe("editor");
    expect(await h.members.setMember(h.actor, viewer.userId, "viewer", { confirmRetainedRole: "editor" }))
      .toEqual({ role: "viewer", effectiveRole: "editor" });
    await expect(h.members.setMember(h.actor, h.actor.userId, null))
      .rejects.toMatchObject({ code: "project_organization_access_retained" });
    expect((await h.access()).role).toBe("owner");
    expect(await h.members.setMember(h.actor, h.actor.userId, null, { confirmRetainedRole: "editor", confirmNoOwner: true }))
      .toEqual({ role: null, effectiveRole: "editor" });
    expect((await h.access()).role).toBe("editor");
    await expect(h.members.setMember(h.actor, h.actor.userId, null))
      .rejects.toMatchObject({ code: "project_no_explicit_membership" });
    await expect(h.members.setMember(h.actor, h.actor.userId, null, { confirmRetainedRole: "editor" }))
      .rejects.toMatchObject({ code: "project_no_explicit_membership" });
    const audit = await superuserPool().query(
      "SELECT payload FROM audit_events WHERE tenant_id=$1 AND event_type='project_member_changed' ORDER BY id", [h.actor.tenantId]);
    expect(audit.rows).toHaveLength(3);
    expect(audit.rows[2].payload).toMatchObject({ role: null, effectiveRole: "editor" });
  });

  test("removes a departed organization member without claiming that access remains", async () => {
    const h = await setup();
    const departed = await h.member();
    await h.members.setMember(h.actor, departed.userId, "editor");
    await h.members.setSharing(h.actor, { ...sharedEditor, confirmAudience: true, expected: privateViewer });
    await superuserPool().query("DELETE FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2", [departed.tenantId, departed.userId]);
    expect(await h.members.setMember(h.actor, departed.userId, null)).toEqual({ role: null, effectiveRole: null });
  });

  test("rolls membership and its audit back together when the transaction fails", async () => {
    const h = await setup();
    const invited = await h.member();
    const original = AuditEventStore.createInTransaction;
    const failure = vi.spyOn(AuditEventStore, "createInTransaction").mockImplementationOnce(async (client, input) => {
      await original(client, input);
      throw new Error("Failure after audit insertion");
    });
    try {
      await expect(h.members.setMember(h.actor, invited.userId, "owner")).rejects.toThrow("Failure after audit insertion");
    } finally {
      failure.mockRestore();
    }
    await expect(h.access(invited)).rejects.toMatchObject({ status: 404 });
    const rows = await superuserPool().query("SELECT id FROM audit_events WHERE tenant_id=$1 AND event_type='project_member_changed'", [h.actor.tenantId]);
    expect(rows.rows).toEqual([]);
  });

  test("allows multiple owners and an ownerless project, with atomic audited recovery", async () => {
    const h = await setup();
    const second = await h.member();
    const editor = await h.member();
    const admin = await h.member("admin");
    await h.members.setMember(h.actor, second.userId, "owner");
    await h.members.setMember(second, editor.userId, "editor");
    await expect(h.members.recoverOwner(admin, admin.userId)).rejects.toMatchObject({ code: "project_has_owner" });
    await h.members.setMember(second, h.actor.userId, null);
    await h.members.setMember(second, second.userId, null, { confirmNoOwner: true });
    await expect(h.access()).rejects.toMatchObject({ status: 404 });
    expect((await h.access(editor)).role).toBe("editor");
    await expect(h.members.recoverOwner(editor, editor.userId)).rejects.toMatchObject({ status: 403 });
    const results = await Promise.allSettled([
      h.members.recoverOwner(admin, editor.userId), h.members.recoverOwner(admin, second.userId),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    await expect(h.access(admin)).rejects.toMatchObject({ status: 404 });
    const audit = await superuserPool().query("SELECT payload FROM audit_events WHERE tenant_id=$1 AND event_type='project_owner_recovered'", [h.actor.tenantId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].payload.projectId).toBe(h.actor.projectId);
  });

  test("revokes creator access when demoted or removed, and revokes all roles after organization departure", async () => {
    const h = await setup();
    const owner = await h.member();
    await h.members.setMember(h.actor, owner.userId, "owner");
    await h.members.setMember(owner, h.actor.userId, "viewer");
    expect((await h.access()).role).toBe("viewer");
    await expect(h.projects.rename(h.actor.tenantId, h.actor.userId, h.actor.projectId, "Bypass")).rejects.toMatchObject({ status: 403 });
    await expect(h.projects.updateInstructions(h.actor.tenantId, h.actor.userId, h.actor.projectId, "Bypass", 0)).rejects.toMatchObject({ status: 403 });
    await h.members.setMember(owner, h.actor.userId, null);
    await expect(h.access()).rejects.toMatchObject({ status: 404 });
    await superuserPool().query("DELETE FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2", [owner.tenantId, owner.userId]);
    await expect(h.access(owner)).rejects.toMatchObject({ status: 404 });
  });

  test("allows archived access reductions and owner recovery but rejects new grants", async () => {
    const h = await setup();
    const viewer = await h.member();
    const admin = await h.member("admin");
    await h.members.setMember(h.actor, viewer.userId, "editor");
    await h.projects.setArchived(h.actor.tenantId, h.actor.userId, h.actor.projectId, true);
    await expect(h.members.setMember(h.actor, admin.userId, "viewer")).rejects.toMatchObject({ code: "project_archived" });
    await expect(h.members.setSharing(h.actor, { ...sharedViewer, confirmAudience: true, expected: privateViewer }))
      .rejects.toMatchObject({ code: "project_archived" });
    await h.members.setMember(h.actor, viewer.userId, "viewer");
    await h.members.setMember(h.actor, h.actor.userId, null, { confirmNoOwner: true });
    await h.members.recoverOwner(admin, viewer.userId);
    expect((await h.access(viewer)).role).toBe("owner");
  });

  // Issue #42: owners A and B both loaded the member list. B left. A's page
  // still shows two owners, so it does not warn before A leaves or loses the
  // role. The store counts the owners again under the project lock.
  describe("the last owner leaves from a stale member list", () => {
    async function twoOwners() {
      const h = await setup();
      const second = await h.member();
      const admin = await h.member("admin");
      await h.members.setMember(h.actor, second.userId, "owner");
      const memberAudits = async () => (await superuserPool().query(
        "SELECT payload FROM audit_events WHERE tenant_id=$1 AND event_type='project_member_changed' ORDER BY id",
        [h.actor.tenantId])).rows.map(row => row.payload as Record<string, unknown>);
      const explicit = async () => Object.fromEntries((await superuserPool().query(
        "SELECT user_id, role FROM project_memberships WHERE tenant_id=$1 AND project_id=$2",
        [h.actor.tenantId, h.actor.projectId])).rows.map(row => [String(row.user_id), String(row.role)]));
      const ownerless = async () => (await h.members.listOwnerless(admin.tenantId, admin.userId))
        .some(project => project.projectId === h.actor.projectId);
      return { ...h, second, memberAudits, explicit, ownerless };
    }

    // Hold the first change open after its audit row, so the second change
    // must wait for the project lock.
    async function whileHeld(first: () => Promise<unknown>, second: () => Promise<unknown>) {
      let release!: () => void;
      let reached!: (pid: number) => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const holding = new Promise<number>(resolve => { reached = resolve; });
      const original = AuditEventStore.createInTransaction;
      const audit = vi.spyOn(AuditEventStore, "createInTransaction").mockImplementationOnce(async (db, input) => {
        await original(db, input);
        reached(Number((await db.query("SELECT pg_backend_pid() AS pid")).rows[0].pid));
        await gate;
      });
      const held = first();
      let waiting: Promise<unknown> | undefined;
      try {
        const pid = await holding;
        waiting = second();
        waiting.catch(() => undefined);
        await vi.waitFor(async () => {
          const blocked = await superuserPool().query(
            "SELECT count(*)::int AS count FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [pid]);
          expect(blocked.rows[0].count).toBeGreaterThan(0);
        });
        release();
        return await Promise.allSettled([held, waiting]);
      } finally {
        release();
        await Promise.allSettled([held, waiting]);
        audit.mockRestore();
      }
    }

    test.each([
      ["leaves", null],
      ["becomes an editor", "editor"],
      ["becomes a viewer", "viewer"]
    ] as const)("refuses without a write or audit when the other owner left first and A %s, then accepts the confirmation", async (_label, role) => {
      const h = await twoOwners();
      await h.members.setMember(h.second, h.second.userId, null);
      const audits = await h.memberAudits();

      await expect(h.members.setMember(h.actor, h.actor.userId, role))
        .rejects.toMatchObject({ code: "project_no_owner_confirmation_required", status: 409 });
      expect(await h.explicit()).toEqual({ [h.actor.userId]: "owner" });
      expect(await h.memberAudits()).toEqual(audits);
      expect(await h.ownerless()).toBe(false);

      expect(await h.members.setMember(h.actor, h.actor.userId, role, { confirmNoOwner: true })).toMatchObject({ role });
      expect(await h.explicit()).toEqual(role ? { [h.actor.userId]: role } : {});
      expect((await h.memberAudits()).at(-1)).toMatchObject({ memberUserId: h.actor.userId, previousRole: "owner", role });
      expect(await h.ownerless()).toBe(true);
    });

    test("does not count an owner who left the organization", async () => {
      const h = await twoOwners();
      await superuserPool().query("DELETE FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2", [h.second.tenantId, h.second.userId]);

      await expect(h.members.setMember(h.actor, h.actor.userId, null))
        .rejects.toMatchObject({ code: "project_no_owner_confirmation_required", status: 409 });
      expect((await h.access()).role).toBe("owner");
    });

    test("refuses a person outside the project or the tenant before it counts the owners", async () => {
      const h = await twoOwners();
      await h.members.setMember(h.second, h.second.userId, null);
      const editor = await h.member();
      await h.members.setMember(h.actor, editor.userId, "editor");
      const audits = await h.memberAudits();
      const otherTenant = await seedTenant();
      await seedMembership(otherTenant, h.actor.userId, "owner");

      for (const confirmNoOwner of [false, true]) {
        await expect(h.members.setMember(editor, h.actor.userId, null, { confirmNoOwner }))
          .rejects.toMatchObject({ code: "project_role_required", status: 403 });
        await expect(h.members.setMember({ ...h.actor, tenantId: otherTenant }, h.actor.userId, null, { confirmNoOwner }))
          .rejects.toMatchObject({ code: "project_not_found", status: 404 });
      }
      expect((await h.access()).role).toBe("owner");
      expect(await h.memberAudits()).toEqual(audits);
    });

    test("asks for the retained organization role, then for the missing owner, in an archived shared project", async () => {
      const h = await setup();
      await h.members.setSharing(h.actor, { ...sharedEditor, confirmAudience: true, expected: privateViewer });
      await h.projects.setArchived(h.actor.tenantId, h.actor.userId, h.actor.projectId, true);

      await expect(h.members.setMember(h.actor, h.actor.userId, null, { confirmNoOwner: true }))
        .rejects.toMatchObject({ code: "project_organization_access_retained", status: 409 });
      await expect(h.members.setMember(h.actor, h.actor.userId, null, { confirmRetainedRole: "editor" }))
        .rejects.toMatchObject({ code: "project_no_owner_confirmation_required", status: 409 });
      expect((await h.access()).role).toBe("owner");

      expect(await h.members.setMember(h.actor, h.actor.userId, null, { confirmRetainedRole: "editor", confirmNoOwner: true }))
        .toEqual({ role: null, effectiveRole: "editor" });
      expect((await h.access()).role).toBe("editor");
    });

    test.each([
      ["B leaves while A becomes a viewer", null, "viewer"],
      ["B becomes an editor while A leaves", "editor", null]
    ] as const)("serializes two owners who change at the same time: %s", async (_label, secondRole, actorRole) => {
      const h = await twoOwners();
      const audits = await h.memberAudits();

      const [first, second] = await whileHeld(
        () => h.members.setMember(h.second, h.second.userId, secondRole),
        () => h.members.setMember(h.actor, h.actor.userId, actorRole));

      expect(first.status).toBe("fulfilled");
      expect(second).toMatchObject({ status: "rejected", reason: { code: "project_no_owner_confirmation_required", status: 409 } });
      expect(await h.explicit()).toEqual({ [h.actor.userId]: "owner", ...(secondRole ? { [h.second.userId]: secondRole } : {}) });
      expect(await h.memberAudits()).toHaveLength(audits.length + 1);
      expect(await h.ownerless()).toBe(false);

      await h.members.setMember(h.actor, h.actor.userId, actorRole, { confirmNoOwner: true });
      expect(await h.memberAudits()).toHaveLength(audits.length + 2);
      expect(await h.ownerless()).toBe(true);
    });

    // The other owner's organization removal commits while A's change waits
    // for its row. A's count then sees no other owner.
    test("waits for the other owner's organization departure, then asks to confirm", async () => {
      const h = await twoOwners();
      const audits = await h.memberAudits();
      const departing = await superuserPool().connect();
      let change: Promise<unknown> | undefined;
      try {
        await departing.query("BEGIN");
        const pid = Number((await departing.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        await departing.query("DELETE FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2", [h.second.tenantId, h.second.userId]);
        change = h.members.setMember(h.actor, h.actor.userId, "viewer");
        change.catch(() => undefined);
        await vi.waitFor(async () => {
          const blocked = await superuserPool().query(
            "SELECT count(*)::int AS count FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [pid]);
          expect(blocked.rows[0].count).toBeGreaterThan(0);
        });
        await departing.query("COMMIT");
        await expect(change).rejects.toMatchObject({ code: "project_no_owner_confirmation_required", status: 409 });
      } finally {
        await departing.query("ROLLBACK").catch(() => undefined);
        await Promise.allSettled([change]);
        departing.release();
      }
      expect((await h.access()).role).toBe("owner");
      expect(await h.memberAudits()).toEqual(audits);
    });
  });

  // Issue #42: owner A loaded "organization, viewer". Owner B then made the
  // project private. A's confirmation said that everyone already had access.
  describe("sharing confirmed from stale access", () => {
    async function staleOwners() {
      const h = await setup();
      const second = await h.member();
      await h.members.setMember(h.actor, second.userId, "owner");
      await h.members.setSharing(h.actor, { ...sharedViewer, confirmAudience: true, expected: privateViewer });
      const sharingAudits = async () => (await superuserPool().query(
        "SELECT payload FROM audit_events WHERE tenant_id=$1 AND event_type='project_sharing_changed' ORDER BY id",
        [h.actor.tenantId])).rows.map(row => row.payload as Record<string, unknown>);
      return { ...h, second, sharingAudits };
    }

    test("refuses the old request that confirms without naming the saved access", async () => {
      const h = await staleOwners();
      await h.members.setSharing(h.second, { ...privateViewer, expected: sharedViewer });
      const unnamed = { ...sharedEditor, confirmAudience: true } as unknown as Parameters<ProjectMemberStore["setSharing"]>[1];

      await expect(h.members.setSharing(h.actor, unnamed)).rejects.toMatchObject({ code: "invalid_project_sharing", status: 400 });
      expect(await h.access()).toMatchObject(privateViewer);
      expect(await h.sharingAudits()).toHaveLength(2);
    });

    test("refuses a change from a stale visibility or role without a write or audit, then accepts a fresh confirmation", async () => {
      const h = await staleOwners();
      await h.members.setSharing(h.second, { ...privateViewer, expected: sharedViewer });

      await expect(h.members.setSharing(h.actor, { ...sharedEditor, confirmAudience: true, expected: sharedViewer }))
        .rejects.toMatchObject({ code: "project_sharing_conflict", status: 409 });
      expect(await h.access()).toMatchObject(privateViewer);

      await h.members.setSharing(h.second, { ...sharedEditor, confirmAudience: true, expected: privateViewer });
      await expect(h.members.setSharing(h.actor, { ...privateViewer, expected: sharedViewer }))
        .rejects.toMatchObject({ code: "project_sharing_conflict", status: 409 });
      expect(await h.access()).toMatchObject(sharedEditor);
      expect(await h.sharingAudits()).toHaveLength(3);

      await h.members.setSharing(h.actor, { ...sharedViewer, confirmAudience: true, expected: sharedEditor });
      expect(await h.access()).toMatchObject(sharedViewer);
      const audits = await h.sharingAudits();
      expect(audits).toHaveLength(4);
      expect(audits.at(-1)).toMatchObject({ previousVisibility: "organization", previousOrganizationRole: "editor",
        visibility: "organization", organizationRole: "viewer" });
    });

    test("compares the saved access after the row lock, so the later of two changes from the same access fails", async () => {
      const h = await staleOwners();
      let release!: () => void;
      let reached!: (pid: number) => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const holding = new Promise<number>(resolve => { reached = resolve; });
      const original = AuditEventStore.createInTransaction;
      const audit = vi.spyOn(AuditEventStore, "createInTransaction").mockImplementationOnce(async (db, input) => {
        await original(db, input);
        reached(Number((await db.query("SELECT pg_backend_pid() AS pid")).rows[0].pid));
        await gate;
      });
      // Both owners loaded "organization, viewer". B makes the project private
      // and holds its transaction open; A confirms edit access meanwhile.
      const makePrivate = h.members.setSharing(h.second, { ...privateViewer, expected: sharedViewer });
      let widen: Promise<unknown> | undefined;
      try {
        const pid = await holding;
        widen = h.members.setSharing(h.actor, { ...sharedEditor, confirmAudience: true, expected: sharedViewer });
        widen.catch(() => undefined);
        await vi.waitFor(async () => {
          const waiting = await superuserPool().query(
            "SELECT count(*)::int AS count FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [pid]);
          expect(waiting.rows[0].count).toBeGreaterThan(0);
        });
        release();
        await makePrivate;
        await expect(widen).rejects.toMatchObject({ code: "project_sharing_conflict", status: 409 });
      } finally {
        release();
        await Promise.allSettled([makePrivate, widen]);
        audit.mockRestore();
      }
      expect(await h.access()).toMatchObject(privateViewer);
      const audits = await h.sharingAudits();
      expect(audits).toHaveLength(2);
      expect(audits.at(-1)).toMatchObject({ previousVisibility: "organization", visibility: "private" });
    });
  });
});
