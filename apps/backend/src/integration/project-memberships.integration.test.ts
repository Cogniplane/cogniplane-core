import { describe, expect, test, vi } from "vitest";
import { AuditEventStore } from "../services/audit-event-store.js";
import { SessionStore } from "../services/session-store.js";
import { ProjectStore } from "../services/project-store.js";
import { ProjectMemberStore } from "../services/project-member-store.js";
import { requireProjectAccess } from "../services/project-access.js";
import { withTenantScope } from "../lib/db.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedMembership, seedTenant, seedUser } from "./support/fixtures.js";

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
      ? h.members.setSharing(h.actor, { visibility: "organization", organizationRole: "viewer", confirmAudience: true })
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
    await expect(h.members.setSharing(h.actor, { visibility: "organization", organizationRole: "viewer" }))
      .rejects.toMatchObject({ code: "project_audience_confirmation_required" });
    expect((await h.access()).visibility).toBe("private");
    await h.members.setSharing(h.actor, { visibility: "organization", organizationRole: "viewer", confirmAudience: true });
    expect((await h.access(editor)).role).toBe("editor");
    expect((await h.access(viewer)).role).toBe("viewer");
    expect((await h.access(await h.member())).role).toBe("viewer");
    await h.members.setSharing(h.actor, { visibility: "organization", organizationRole: "editor", confirmAudience: true });
    expect((await h.access(viewer)).role).toBe("editor");
    expect((await h.access()).role).toBe("owner");
    await expect(h.members.setMember(editor, viewer.userId, "owner")).rejects.toMatchObject({ status: 403 });
    await expect(h.members.setSharing(editor, { visibility: "private", organizationRole: "viewer" })).rejects.toMatchObject({ status: 403 });
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
    await h.members.setSharing(h.actor, { visibility: "organization", organizationRole: "editor", confirmAudience: true });
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
    expect(await h.members.setMember(h.actor, h.actor.userId, null, { confirmRetainedRole: "editor" }))
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
    await h.members.setSharing(h.actor, { visibility: "organization", organizationRole: "editor", confirmAudience: true });
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
    await h.members.setMember(second, second.userId, null);
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
    await expect(h.members.setSharing(h.actor, { visibility: "organization", organizationRole: "viewer", confirmAudience: true }))
      .rejects.toMatchObject({ code: "project_archived" });
    await h.members.setMember(h.actor, viewer.userId, "viewer");
    await h.members.setMember(h.actor, h.actor.userId, null);
    await h.members.recoverOwner(admin, viewer.userId);
    expect((await h.access(viewer)).role).toBe("owner");
  });
});
