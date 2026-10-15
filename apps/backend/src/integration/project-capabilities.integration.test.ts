import { describe, expect, test, vi } from "vitest";
import { AuditEventStore } from "../services/audit-event-store.js";
import { ProjectStore } from "../services/project-store.js";
import { SessionExecutionStore } from "../services/session-execution-store.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedMembership, seedTenant, seedUser, seedRuntimeSession, seedApproval, seedStreamingMessage } from "./support/fixtures.js";

describe.skipIf(!adminDatabaseUrl())("project capability persistence", () => {
  test("enforces project roles, tenant isolation, revisions, inheritance, archive, and audit", async () => {
    const tenantId = await seedTenant();
    const owner = await seedUser(), editor = await seedUser(), viewer = await seedUser(), admin = await seedUser();
    for (const user of [owner, editor, viewer]) await seedMembership(tenantId, user);
    await seedMembership(tenantId, admin, "admin");
    const store = new ProjectStore(appPool());
    const project = await store.create(tenantId, owner, "Capabilities");
    for (const [user, role] of [[editor, "editor"], [viewer, "viewer"]] as const) {
      await superuserPool().query("INSERT INTO project_memberships (tenant_id,project_id,user_id,role) VALUES ($1,$2,$3,$4)",
        [tenantId, project.projectId, user, role]);
    }
    const id = project.projectId;
    const foreignTenant = await seedTenant();
    await seedMembership(foreignTenant, owner);
    expect(await store.getCapabilities(tenantId, owner, id)).toEqual({ selection: null, version: 0, canEdit: true });
    expect((await store.getCapabilities(tenantId, editor, id)).canEdit).toBe(false);
    expect((await store.getCapabilities(tenantId, viewer, id)).canEdit).toBe(false);
    await expect(store.getCapabilities(tenantId, admin, id)).rejects.toMatchObject({ status: 404 });
    await expect(store.getCapabilities(foreignTenant, owner, id)).rejects.toMatchObject({ status: 404 });
    const selection = { skillIds: ["unavailable-skill"], connectorIds: ["unavailable-server"] };
    await expect(store.setCapabilities(tenantId, editor, id, { selection, version: 0 })).rejects.toMatchObject({ status: 403 });
    await expect(store.setCapabilities(tenantId, viewer, id, { selection, version: 0 })).rejects.toMatchObject({ status: 403 });
    await expect(store.setCapabilities(tenantId, admin, id, { selection, version: 0 })).rejects.toMatchObject({ status: 404 });
    await expect(store.setCapabilities(foreignTenant, owner, id, { selection, version: 0 })).rejects.toMatchObject({ status: 404 });
    expect(await store.setCapabilities(tenantId, owner, id, { selection, version: 0 })).toBe(true);
    expect(await store.getCapabilities(tenantId, viewer, id)).toEqual({ selection, version: 1, canEdit: false });
    expect(await store.setCapabilities(tenantId, owner, id, { selection: null, version: 0 })).toBe(false);
    expect(await store.setCapabilities(tenantId, owner, id, { selection: null, version: 1 })).toBe(true);
    expect((await store.getCapabilities(tenantId, owner, id)).selection).toBeNull();
    const audit = await superuserPool().query(
      "SELECT payload FROM audit_events WHERE tenant_id=$1 AND event_type='project_capabilities_changed' AND payload->>'projectId'=$2 ORDER BY created_at",
      [tenantId, id]);
    expect(audit.rows).toHaveLength(2);
    expect(audit.rows.map(row => row.payload.version)).toEqual([1, 2]);
    await store.setArchived(tenantId, owner, id, true);
    expect((await store.getCapabilities(tenantId, owner, id)).canEdit).toBe(false);
    await expect(store.setCapabilities(tenantId, owner, id, { selection, version: 2 })).rejects.toMatchObject({ code: "project_archived" });
  });

  test("blocks pending approvals and streaming turns until they finish", async () => {
    const tenantId = await seedTenant(), owner = await seedUser();
    await seedMembership(tenantId, owner);
    const store = new ProjectStore(appPool());
    const project = await store.create(tenantId, owner, "Busy project");
    const session = await store.createSession(tenantId, owner, project.projectId, "Chat");
    expect(session).toBeTruthy();
    const executions = new SessionExecutionStore(appPool());
    const execution = await executions.acquire({ tenantId, userId: owner, sessionId: session! }, 30_000);
    const input = { selection: { skillIds: [], connectorIds: [] }, version: 0 };
    expect((await store.getCapabilities(tenantId, owner, project.projectId)).canEdit).toBe(false);
    expect(await store.setCapabilities(tenantId, owner, project.projectId, input)).toBe(false);
    await executions.release(execution);
    const runtime = await seedRuntimeSession(tenantId, owner, session!);
    const approval = await seedApproval({ tenantId, userId: owner, sessionId: session!, runtimeId: runtime });
    expect((await store.getCapabilities(tenantId, owner, project.projectId)).canEdit).toBe(false);
    expect(await store.setCapabilities(tenantId, owner, project.projectId, input)).toBe(false);
    await superuserPool().query("UPDATE approvals SET status='approved' WHERE approval_id=$1", [approval]);
    const message = await seedStreamingMessage(tenantId, owner, session!);
    expect(await store.setCapabilities(tenantId, owner, project.projectId, input)).toBe(false);
    await superuserPool().query("UPDATE messages SET status='completed' WHERE message_id=$1", [message]);
    expect(await store.setCapabilities(tenantId, owner, project.projectId, input)).toBe(true);
  });

  test("rolls back the selection and version when its audit write fails", async () => {
    const tenantId = await seedTenant(), owner = await seedUser();
    await seedMembership(tenantId, owner);
    const store = new ProjectStore(appPool());
    const project = await store.create(tenantId, owner, "Audit rollback");
    const selection = { skillIds: ["pdf"], connectorIds: [] };
    const audit = vi.spyOn(AuditEventStore, "createInTransaction").mockRejectedValueOnce(new Error("audit unavailable"));
    try {
      await expect(store.setCapabilities(tenantId, owner, project.projectId, { selection, version: 0 }))
        .rejects.toThrow("audit unavailable");
    } finally {
      audit.mockRestore();
    }
    expect(await store.getCapabilities(tenantId, owner, project.projectId))
      .toEqual({ selection: null, version: 0, canEdit: true });
    const events = await superuserPool().query(
      "SELECT 1 FROM audit_events WHERE tenant_id=$1 AND event_type='project_capabilities_changed' AND payload->>'projectId'=$2",
      [tenantId, project.projectId]);
    expect(events.rowCount).toBe(0);
  });

  test("only one concurrent update can use the same version", async () => {
    const tenantId = await seedTenant(), owner = await seedUser();
    await seedMembership(tenantId, owner);
    const store = new ProjectStore(appPool());
    const project = await store.create(tenantId, owner, "Concurrent updates");
    const first = { skillIds: ["pdf"], connectorIds: [] };
    const second = { skillIds: [], connectorIds: ["docs"] };
    const results = await Promise.all([
      store.setCapabilities(tenantId, owner, project.projectId, { selection: first, version: 0 }),
      store.setCapabilities(tenantId, owner, project.projectId, { selection: second, version: 0 })
    ]);
    expect(results.sort()).toEqual([false, true]);
    const saved = await store.getCapabilities(tenantId, owner, project.projectId);
    expect(saved.version).toBe(1);
    expect([first, second]).toContainEqual(saved.selection);
    const events = await superuserPool().query(
      "SELECT payload FROM audit_events WHERE tenant_id=$1 AND event_type='project_capabilities_changed' AND payload->>'projectId'=$2",
      [tenantId, project.projectId]);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].payload.selection).toEqual(saved.selection);
  });

  test("retains saved unavailable IDs and rejects additions outside the actor catalog", async () => {
    const tenantId = await seedTenant(), owner = await seedUser();
    await seedMembership(tenantId, owner);
    const store = new ProjectStore(appPool());
    const project = await store.create(tenantId, owner, "Retained selections");
    const id = project.projectId;
    const unavailable = { skillIds: ["retired"], connectorIds: ["disabled"] };
    const available = { skillIds: ["pdf"], connectorIds: ["docs"] };
    expect(await store.setCapabilities(tenantId, owner, id, { selection: unavailable, version: 0 })).toBe(true);
    const retained = { skillIds: ["retired", "pdf"], connectorIds: ["disabled", "docs"] };
    expect(await store.setCapabilities(tenantId, owner, id, { selection: retained, version: 1 }, available)).toBe(true);
    expect(await store.setCapabilities(tenantId, owner, id, { selection: { skillIds: ["retired", "new"], connectorIds: ["disabled", "docs"] }, version: 2 }, available)).toBe(false);
    expect(await store.setCapabilities(tenantId, owner, id, { selection: { skillIds: ["pdf"], connectorIds: ["docs"] }, version: 2 }, available)).toBe(true);
    expect(await store.setCapabilities(tenantId, owner, id, { selection: retained, version: 2 }, available)).toBe(false);
    expect(await store.setCapabilities(tenantId, owner, id, { selection: retained, version: 3 }, available)).toBe(false);
    expect(await store.getCapabilities(tenantId, owner, id)).toMatchObject({
      selection: { skillIds: ["pdf"], connectorIds: ["docs"] }, version: 3
    });
  });

  test("turn admission waits for a project selection write to commit", async () => {
    const tenantId = await seedTenant(), owner = await seedUser();
    await seedMembership(tenantId, owner);
    const store = new ProjectStore(appPool());
    const project = await store.create(tenantId, owner, "Admission race");
    const sessionId = await store.createSession(tenantId, owner, project.projectId, "Chat");
    if (!sessionId) throw new Error("Expected a project session");
    const executions = new SessionExecutionStore(appPool());
    const selection = { skillIds: ["pdf"], connectorIds: [] };
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const writing = new Promise<void>(resolve => { entered = resolve; });
    let holderPid: number | undefined;
    const original = AuditEventStore.createInTransaction;
    const audit = vi.spyOn(AuditEventStore, "createInTransaction").mockImplementationOnce(async (db, input) => {
      await original(db, input);
      holderPid = Number((await db.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      entered();
      await gate;
    });
    const change = store.setCapabilities(tenantId, owner, project.projectId, { selection, version: 0 });
    let admission: ReturnType<typeof executions.acquire> | undefined;
    try {
      await writing;
      admission = executions.acquire({ tenantId, userId: owner, sessionId }, 30_000);
      await vi.waitFor(async () => {
        const blocked = await superuserPool().query(
          "SELECT 1 FROM pg_stat_activity WHERE $1::integer = ANY(pg_blocking_pids(pid)) LIMIT 1", [holderPid]);
        expect(blocked.rowCount).toBe(1);
      });
      release();
      expect(await change).toBe(true);
      const execution = await admission;
      expect((await store.getCapabilities(tenantId, owner, project.projectId)).selection).toEqual(selection);
      expect(await executions.isCurrent(execution)).toBe(true);
      await executions.release(execution);
    } finally {
      release();
      await Promise.allSettled(admission ? [change, admission] : [change]);
      audit.mockRestore();
    }
  });
});
