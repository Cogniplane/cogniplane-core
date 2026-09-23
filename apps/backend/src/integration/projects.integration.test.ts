import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, test, vi, onTestFinished } from "vitest";
import { AuditEventStore } from "../services/audit-event-store.js";
import * as projectAccess from "../services/project-access.js";
import { ProjectMemberStore } from "../services/project-member-store.js";
import { ProjectStore } from "../services/project-store.js";
import { ProjectFileStore } from "../services/project-file-store.js";
import { SessionStore } from "../services/session-store.js";
import { ArtifactStore } from "../services/artifacts/artifact-store.js";
import { createArtifactStorage } from "../services/artifacts/artifact-storage.js";
import { ActiveTurnsRegistry } from "../services/active-turns-registry.js";
import { registerProjectRoutes, type ProjectRouteStores } from "../routes/projects.js";
import { createTestConfig } from "../test-helpers/test-config.js";
import { withTenantScope } from "../lib/db.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedTenant, seedUser, seedMembership } from "./support/fixtures.js";

async function setup() {
  const tenantId = await seedTenant(),
    userId = await seedUser();
  await seedMembership(tenantId, userId);
  const projects = new ProjectStore(appPool()),
    projectFiles = new ProjectFileStore(appPool(), { warn() {} }),
    sessions = new SessionStore(appPool()),
    artifacts = new ArtifactStore(appPool());
  const root = await mkdtemp(join(tmpdir(), "project-files-"));
  const storage = createArtifactStorage(createTestConfig({ ARTIFACT_STORAGE_ROOT: root }));
  const app = Fastify();
  app.decorate("db", appPool());
  app.decorate("config", createTestConfig());
  let auth = { tenantId, userId, role: "member" as const, isAdmin: false };
  app.addHook("preHandler", async (request) => {
    request.auth = auth;
  });
  const activeTurns = new ActiveTurnsRegistry();
  const abortSession = vi.fn(async () => undefined);
  const purgeSessionData = vi.fn(async () => undefined);
  await registerProjectRoutes(app, {
    projects,
    sessions,
    artifacts,
    artifactStorage: storage,
    activeTurns,
    runtimeAdapter: { id: "test", hasActiveTurn: () => false, abortSession, purgeSessionData },
    limits: { consumeRateLimit: async () => null },
    auditEvents: new AuditEventStore(appPool()),
    projectFiles
  } as unknown as ProjectRouteStores);
  onTestFinished(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const response = await app.inject({
    method: "POST",
    url: "/projects",
    payload: { name: "Planning" }
  });
  expect(response.statusCode).toBe(201);
  const project = response.json();
  const first = await sessions.create(tenantId, userId, "Research");
  expect(
    await projects.setSession(tenantId, userId, project.projectId, first.sessionId)
  ).toBe(true);
  const stored = await storage.put({
    storageKey: "source/report",
    stream: Readable.from(["Original report"])
  });
  const source = await artifacts.create({
    tenantId,
    userId,
    sessionId: first.sessionId,
    artifactType: "generated",
    artifactName: "report.txt",
    mimeType: "text/plain",
    status: "ready",
    createdByType: "tool",
    ...stored
  });
  return {
    tenantId,
    userId,
    projects,
    sessions,
    artifacts,
    storage,
    app,
    project,
    first,
    source,
    purgeSessionData,
    abortSession,
    activeTurns,
    setAuth: (next: typeof auth) => {
      auth = next;
    }
  };
}

test.skipIf(!adminDatabaseUrl())("legacy project artifact routes are no longer mounted", async () => {
  const h = await setup();
  expect((await h.app.inject({
    method: "POST",
    url: `/projects/${h.project.projectId}/files/copy`,
    payload: { artifactId: h.source.artifactId }
  })).statusCode).toBe(404);
  expect((await h.app.inject({
    method: "DELETE",
    url: `/projects/${h.project.projectId}/files/${h.source.artifactId}`
  })).statusCode).toBe(404);
});

/* Legacy artifact-reference coverage moved to project-file integration tests. */
describe.skipIf(!adminDatabaseUrl())("private project workspaces", () => {
  test("returns management capability with readable project details", async () => {
    const h = await setup();
    expect((await h.app.inject(`/projects/${h.project.projectId}`)).json().canManage).toBe(true);
  });

  test("does not expose whole-project deletion", async () => {
    const h = await setup();
    const response = await h.app.inject({
      method: "DELETE",
      url: `/projects/${h.project.projectId}`
    });
    expect(response.statusCode).toBe(404);
  });

  test("organizes sessions and protects the project reference session", async () => {
    const h = await setup();
    const created = await h.app.inject({
      method: "POST",
      url: `/projects/${h.project.projectId}/sessions`,
      payload: { name: "Drafting" }
    });
    expect(created.statusCode).toBe(201);
    const target = created.json().session;
    expect(target.projectId).toBe(h.project.projectId);
    expect((await h.sessions.listPage(h.tenantId, h.userId)).sessions.map((s) => s.purpose)).toEqual([
      "normal",
      "normal"
    ]);
    // The reference session backs project files and must not be removable or
    // archivable through the ordinary session routes.
    expect(await h.sessions.remove(h.tenantId, h.project.referenceSessionId, h.userId)).toBe(false);
    expect(
      await h.sessions.setArchived(h.tenantId, h.project.referenceSessionId, h.userId, true)
    ).toBeNull();
  });

  test("enforces tenant and owner isolation for projects and membership", async () => {
    const h = await setup();
    const foreignUser = await seedUser(),
      foreignTenant = await seedTenant();
    for (const [tenantId, userId] of [
      [h.tenantId, foreignUser],
      [foreignTenant, h.userId]
    ]) {
      expect(await h.projects.getOwned(tenantId, userId, h.project.projectId)).toBeNull();
      expect(await h.projects.list(tenantId, userId)).toEqual([]);
      await expect(h.projects.rename(tenantId, userId, h.project.projectId, "No")).rejects.toMatchObject({ status: 404 });
      await expect(h.projects.setSession(tenantId, userId, h.project.projectId, h.first.sessionId))
        .rejects.toMatchObject({ status: 404 });
      expect(await h.artifacts.listByProject(tenantId, userId, h.project.projectId)).toEqual([]);
      h.setAuth({ tenantId, userId, role: "member", isAdmin: false });
      expect((await h.app.inject(`/projects/${h.project.projectId}`)).statusCode).toBe(404);
    }
    const rows = await withTenantScope(appPool(), foreignTenant, (db) =>
      db.query("SELECT * FROM projects WHERE project_id = $1", [h.project.projectId])
    );
    expect(rows.rowCount).toBe(0);
    const otherSession = await h.sessions.create(foreignTenant, foreignUser, "Other tenant");
    await expect(
      superuserPool().query("UPDATE sessions SET project_id = $1 WHERE session_id = $2", [
        h.project.projectId,
        otherSession.sessionId
      ])
    ).rejects.toThrow(/sessions_project_tenant_fk/);
  });

  test("activity respects project access and never returns event payloads", async () => {
    const h = await setup();
    const audits = new AuditEventStore(appPool());
    // A payload carrying exactly what D11c says the feed must not expose.
    const secret = "test-only-upstream-token";
    await audits.create({
      tenantId: h.tenantId,
      sessionId: null,
      userId: h.userId,
      type: "project_sharing_changed",
      payload: {
        projectId: h.project.projectId,
        upstreamToken: secret,
        sourceExcerpt: "restricted source content"
      }
    });

    const detail = (await h.app.inject(`/projects/${h.project.projectId}`)).json();
    expect(detail.activity).toHaveLength(1);
    const [event] = detail.activity;
    expect(event).toMatchObject({ type: "project_sharing_changed", userId: h.userId });
    expect(Object.keys(event).sort()).toEqual(["createdAt", "eventId", "type", "userId"]);
    const body = (await h.app.inject(`/projects/${h.project.projectId}`)).body;
    expect(body).not.toContain(secret);
    expect(body).not.toContain("restricted source content");

    // Assert redaction at the STORE boundary as well. ProjectDetailSchema
    // strips unknown keys, so a route-level assertion alone passes even if the
    // query starts selecting payload. Any other caller of listProjectActivity
    // would get the credential. This is the assertion that fails if the
    // projection changes.
    const events = await audits.listProjectActivity(h.tenantId, h.project.projectId);
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]!).sort()).toEqual(["createdAt", "eventId", "type", "userId"]);
    expect(JSON.stringify(events)).not.toContain(secret);

    // An event belonging to another project must not appear in this feed.
    const other = await h.projects.create(h.tenantId, h.userId, "Other project");
    await audits.create({
      tenantId: h.tenantId,
      sessionId: null,
      userId: h.userId,
      type: "project_archived",
      payload: { projectId: other.projectId }
    });
    expect((await h.app.inject(`/projects/${h.project.projectId}`)).json().activity)
      .toHaveLength(1);

    // Current project access gates the feed: a member of the tenant who is not
    // a member of the project cannot read it at all.
    const outsider = await seedUser();
    await seedMembership(h.tenantId, outsider, "member");
    h.setAuth({ tenantId: h.tenantId, userId: outsider, role: "member", isAdmin: false });
    expect((await h.app.inject(`/projects/${h.project.projectId}`)).statusCode).toBe(404);

    // Another tenant cannot reach it either, even with the same project id.
    const foreignTenant = await seedTenant();
    const foreignUser = await seedUser();
    await seedMembership(foreignTenant, foreignUser, "owner");
    h.setAuth({ tenantId: foreignTenant, userId: foreignUser, role: "member", isAdmin: false });
    expect((await h.app.inject(`/projects/${h.project.projectId}`)).statusCode).toBe(404);
  });

  test("rejects moves and detachment without changing session assignment", async () => {
    const h = await setup();
    const second = await h.projects.create(h.tenantId, h.userId, "Second project");
    const original = await h.sessions.getOwned(h.tenantId, h.first.sessionId, h.userId);
    for (const [projectId, attach, error] of [
      [second.projectId, true, "project_session_move_forbidden"],
      [h.project.projectId, false, "project_session_detach_forbidden"]
    ] as const) {
      const response = await h.app.inject({
        method: "PUT", url: `/projects/${projectId}/sessions`,
        payload: { sessionId: h.first.sessionId, attach, confirmAudience: true }
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe(error);
      if (attach) expect(await h.projects.setSession(h.tenantId, h.userId, projectId, h.first.sessionId))
        .toBe(false);
    }
    expect(await h.sessions.getOwned(h.tenantId, h.first.sessionId, h.userId)).toEqual(original);
  });

  test("requires audience confirmation for an unassigned session and allows identical retries", async () => {
    const h = await setup();
    const session = await h.sessions.create(h.tenantId, h.userId, "Private conversation");
    const url = `/projects/${h.project.projectId}/sessions`;
    for (const confirmAudience of [undefined, false]) {
      const response = await h.app.inject({ method: "PUT", url,
        payload: { sessionId: session.sessionId, confirmAudience } });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("project_audience_confirmation_required");
      expect((await h.sessions.getOwned(h.tenantId, session.sessionId, h.userId))?.projectId).toBeNull();
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await h.app.inject({ method: "PUT", url,
        payload: { sessionId: session.sessionId, confirmAudience: true } })).statusCode).toBe(204);
    }
    expect((await h.sessions.getOwned(h.tenantId, session.sessionId, h.userId))?.projectId)
      .toBe(h.project.projectId);
  });

  test("concurrent assignments through separate stores have one destination", async () => {
    const h = await setup();
    const other = await h.projects.create(h.tenantId, h.userId, "Other project");
    const session = await h.sessions.create(h.tenantId, h.userId, "Unassigned");
    const secondStore = new ProjectStore(appPool());
    const results = await Promise.all([
      h.projects.setSession(h.tenantId, h.userId, h.project.projectId, session.sessionId),
      secondStore.setSession(h.tenantId, h.userId, other.projectId, session.sessionId)
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await h.sessions.getOwned(h.tenantId, session.sessionId, h.userId))?.projectId)
      .toBe(results[0] ? h.project.projectId : other.projectId);
  });

  test("rejects busy, archived and non-chat session assignments", async () => {
    const h = await setup();
    const session = await h.sessions.create(h.tenantId, h.userId, "Unassigned");
    const url = `/projects/${h.project.projectId}/sessions`;
    const payload = { sessionId: session.sessionId, confirmAudience: true };
    h.activeTurns.mark(session.sessionId);
    expect((await h.app.inject({ method: "PUT", url, payload })).json().error).toBe("session_busy");
    h.activeTurns.clear(session.sessionId);
    await h.projects.setArchived(h.tenantId, h.userId, h.project.projectId, true);
    expect((await h.app.inject({ method: "PUT", url, payload })).json().error).toBe("project_archived");
    await expect(h.projects.setSession(h.tenantId, h.userId, h.project.projectId, session.sessionId))
      .rejects.toMatchObject({ code: "project_archived" });
    await h.projects.setArchived(h.tenantId, h.userId, h.project.projectId, false);
    await h.sessions.setArchived(h.tenantId, session.sessionId, h.userId, true);
    expect((await h.app.inject({ method: "PUT", url, payload })).statusCode).toBe(404);
    expect(await h.projects.setSession(h.tenantId, h.userId, h.project.projectId, session.sessionId)).toBe(false);
    expect(await h.projects.setSession(h.tenantId, h.userId, h.project.projectId, h.project.referenceSessionId)).toBe(false);
    const scheduled = await h.sessions.create(h.tenantId, h.userId, "Scheduled", { purpose: "scheduled" });
    expect(await h.projects.setSession(h.tenantId, h.userId, h.project.projectId, scheduled.sessionId)).toBe(false);
  });
});

test.skipIf(!adminDatabaseUrl())(
  "project ordering reflects session membership and conversation activity",
  async () => {
    const h = await setup();
    const other = await h.projects.create(h.tenantId, h.userId, "Other");
    await superuserPool().query(
      "UPDATE projects SET updated_at = '2020-01-01' WHERE project_id = $1",
      [h.project.projectId]
    );
    await superuserPool().query(
      "UPDATE sessions SET updated_at = '2020-01-01' WHERE project_id = $1",
      [h.project.projectId]
    );
    expect((await h.projects.list(h.tenantId, h.userId))[0].projectId).toBe(other.projectId);
    const unassigned = await h.sessions.create(h.tenantId, h.userId, "Another conversation");
    expect(await h.projects.setSession(
      h.tenantId, h.userId, h.project.projectId, unassigned.sessionId
    )).toBe(true);
    expect((await h.projects.list(h.tenantId, h.userId))[0].projectId).toBe(h.project.projectId);
    await h.projects.rename(h.tenantId, h.userId, other.projectId, "Other renamed");
    await h.sessions.rename(h.tenantId, h.first.sessionId, h.userId, "Active conversation");
    expect((await h.projects.list(h.tenantId, h.userId))[0].projectId).toBe(h.project.projectId);
  }
);

describe.skipIf(!adminDatabaseUrl())("project lifecycle", () => {
  test.each([true, false])("commits archive=%s and its audit together, or rolls both back", async (archived) => {
    const h = await setup();
    if (!archived) await h.projects.setArchived(h.tenantId, h.userId, h.project.projectId, true);
    const event = archived ? "project_archived" : "project_restored";
    const original = AuditEventStore.createInTransaction;
    const failure = vi.spyOn(AuditEventStore, "createInTransaction").mockImplementationOnce(async (client, input) => {
      await original(client, input);
      throw new Error("Failure after archive audit insertion");
    });
    try {
      const result = await h.app.inject({ method: "PUT", url: `/projects/${h.project.projectId}/archive`, payload: { archived } });
      expect(result.statusCode).toBe(500);
    } finally {
      failure.mockRestore();
    }
    expect(Boolean((await h.projects.getOwned(h.tenantId, h.userId, h.project.projectId))?.archivedAt)).toBe(!archived);
    const auditRows = () => superuserPool().query(
      "SELECT user_id, payload FROM audit_events WHERE tenant_id=$1 AND event_type=$2", [h.tenantId, event]);
    expect((await auditRows()).rows).toEqual([]);
    const retry = await h.app.inject({ method: "PUT", url: `/projects/${h.project.projectId}/archive`, payload: { archived } });
    expect(retry.statusCode).toBe(204);
    expect(Boolean((await h.projects.getOwned(h.tenantId, h.userId, h.project.projectId))?.archivedAt)).toBe(archived);
    expect((await auditRows()).rows).toEqual([{ user_id: h.userId, payload: { projectId: h.project.projectId } }]);
  });

  test.each(["instructions", "archive", "session", "rename"] as const)(
    "rejects %s when organization membership disappears after acquiring the project lock", async (operation) => {
      const h = await setup();
      const original = projectAccess.requireProjectAccess;
      const departure = vi.spyOn(projectAccess, "requireProjectAccess").mockImplementationOnce(async (...args) => {
        const access = await original(...args);
        // This connection commits independently while the store holds FOR UPDATE on projects.
        await superuserPool().query("DELETE FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2", [h.tenantId, h.userId]);
        return access;
      });
      try {
        const url = `/projects/${h.project.projectId}`;
        const request = operation === "instructions"
          ? { method: "PUT" as const, url: `${url}/instructions`, payload: { instructions: "Denied", expectedRevision: 0 } }
          : operation === "archive" ? { method: "PUT" as const, url: `${url}/archive`, payload: { archived: true } }
            : operation === "session" ? { method: "POST" as const, url: `${url}/sessions`, payload: { name: "Denied" } }
              : { method: "PUT" as const, url, payload: { name: "Denied" } };
        const response = await h.app.inject(request);
        expect(response.statusCode).toBe(404);
        expect(response.json().error).toBe("project_not_found");
        expect(departure).toHaveBeenCalled();
      } finally {
        departure.mockRestore();
      }
      const project = await superuserPool().query("SELECT name, archived_at, instructions_revision FROM projects WHERE project_id=$1", [h.project.projectId]);
      expect(project.rows[0]).toMatchObject({ name: "Planning", archived_at: null, instructions_revision: 0 });
      const sessions = await superuserPool().query("SELECT session_id FROM sessions WHERE project_id=$1", [h.project.projectId]);
      expect(sessions.rows).toHaveLength(2);
      const audits = await superuserPool().query("SELECT id FROM audit_events WHERE tenant_id=$1 AND event_type='project_archived'", [h.tenantId]);
      expect(audits.rows).toEqual([]);
    },
  );

  test("archives projects, blocks new sessions and settings, restores, and searches literal names", async () => {
    const h = await setup();
    const url = `/projects/${h.project.projectId}/archive`;
    expect(
      (await h.app.inject({ method: "PUT", url, payload: { archived: true } })).statusCode
    ).toBe(204);
    expect((await h.app.inject("/projects")).json().projects).toEqual([]);
    expect((await h.app.inject("/projects?archived=true&q=REPORT")).json().projects).toHaveLength(
      1
    );
    expect(
      (await h.projects.getOwned(h.tenantId, h.userId, h.project.projectId))?.archivedAt
    ).toBeTruthy();
    expect((await h.sessions.getOwned(h.tenantId, h.first.sessionId, h.userId))?.status).toBe(
      "active"
    );
    expect((await h.app.inject({
      method: "POST",
      url: `/projects/${h.project.projectId}/files/copy`,
      payload: { artifactId: h.source.artifactId }
    })).statusCode).toBe(404);
    await expect(h.projects.createSession(h.tenantId, h.userId, h.project.projectId, "Archived work"))
      .rejects.toMatchObject({ code: "project_archived" });
    expect((await h.app.inject("/projects?archived=true&q=%25")).json().projects).toEqual([]);
    await expect(h.projects.rename(h.tenantId, h.userId, h.project.projectId, "Denied")).rejects.toMatchObject({ code: "project_archived" });
    const settingsResponse = await h.app.inject({ method: "PUT", url: `/projects/${h.project.projectId}/instructions`,
      payload: { instructions: "Denied", expectedRevision: 0 } });
    expect(settingsResponse.statusCode).toBe(409);
    expect(settingsResponse.json().error).toBe("project_archived");
    await h.projects.setArchived(h.tenantId, h.userId, h.project.projectId, false);
    await h.projects.rename(h.tenantId, h.userId, h.project.projectId, "100%_Plan");
    await h.projects.setArchived(h.tenantId, h.userId, h.project.projectId, true);
    expect((await h.app.inject("/projects?archived=true&q=%25_")).json().projects).toHaveLength(1);
    const otherUser = await seedUser();
    h.setAuth({
      tenantId: h.tenantId,
      userId: otherUser,
      role: "member",
      isAdmin: false
    });
    expect((await h.app.inject("/projects?archived=true&q=report")).json().projects).toEqual([]);
    expect(
      (await h.app.inject({ method: "PUT", url, payload: { archived: false } })).statusCode
    ).toBe(404);
    h.setAuth({
      tenantId: await seedTenant(),
      userId: h.userId,
      role: "member",
      isAdmin: false
    });
    expect(
      (await h.app.inject({ method: "PUT", url, payload: { archived: false } })).statusCode
    ).toBe(404);
    h.setAuth({
      tenantId: h.tenantId,
      userId: h.userId,
      role: "member",
      isAdmin: false
    });
    expect(
      (await h.app.inject({ method: "PUT", url, payload: { archived: false } })).statusCode
    ).toBe(204);
    expect((await h.app.inject("/projects")).json().projects[0].archivedAt).toBeNull();
    expect((await h.app.inject("/projects?archived=invalid")).statusCode).toBe(400);
  });
});

describe.skipIf(!adminDatabaseUrl())("project instructions", () => {
  test.each(["demoted", "removed", "archived"] as const)(
    "reports %s access after the route precheck without claiming a revision conflict", async (change) => {
      const h = await setup();
      const actor = { tenantId: h.tenantId, userId: h.userId, projectId: h.project.projectId };
      const memberships = new ProjectMemberStore(appPool());
      const getOwned = h.projects.getOwned.bind(h.projects);
      const intercepted = vi.spyOn(h.projects, "getOwned").mockImplementationOnce(async (...args) => {
        const project = await getOwned(...args);
        if (change === "archived") await h.projects.setArchived(h.tenantId, h.userId, h.project.projectId, true);
        else await memberships.setMember(actor, h.userId, change === "removed" ? null : "viewer");
        return project;
      });
      try {
        const result = await h.app.inject({ method: "PUT", url: `/projects/${h.project.projectId}/instructions`,
          payload: { instructions: "Should not save", expectedRevision: 0 } });
        expect(result.statusCode).toBe(change === "removed" ? 404 : change === "demoted" ? 403 : 409);
        expect(result.json().error).toBe(change === "removed" ? "project_not_found" : change === "demoted" ? "project_role_required" : "project_archived");
        const persisted = await superuserPool().query("SELECT instructions_revision FROM projects WHERE project_id=$1", [h.project.projectId]);
        expect(Number(persisted.rows[0].instructions_revision)).toBe(0);
      } finally {
        intercepted.mockRestore();
      }
    },
  );

  test("saves, rejects stale revisions, clears, and preserves instructions when renaming", async () => {
    const h = await setup();
    const url = `/projects/${h.project.projectId}/instructions`;
    expect((await h.app.inject({ url: url + "/status" })).json()).toEqual({ projectId: h.project.projectId, hasInstructions: false, instructionsRevision: 0 });
    const updates = await Promise.all(["Write in French", "Use CAD"].map((instructions) =>
      h.app.inject({ method: "PUT", url, payload: { instructions, expectedRevision: 0 } })));
    expect(updates.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const saved = updates.find((r) => r.statusCode === 200)!.json();
    expect(saved.instructionsRevision).toBe(1);
    expect((await h.app.inject({ url: url + "/status" })).json()).toEqual({ projectId: h.project.projectId, hasInstructions: true, instructionsRevision: 1 });
    expect((await h.app.inject({ method: "PUT", url,
      payload: { instructions: "a".repeat(12000) + "\n", expectedRevision: 1 } })).statusCode).toBe(200);
    expect(await h.projects.rename(h.tenantId, h.userId, h.project.projectId, "New name"))
      .toMatchObject({ instructions: "a".repeat(12000), instructionsRevision: 2 });
    expect((await h.app.inject({ method: "PUT", url,
      payload: { instructions: " ", expectedRevision: 2 } })).json())
      .toMatchObject({ instructions: "", instructionsRevision: 3 });
    expect((await h.app.inject({ method: "PUT", url,
      payload: { instructions: "a".repeat(12001), expectedRevision: 2 } })).statusCode).toBe(400);
    expect((await h.app.inject({ method: "PUT", url,
      payload: { instructions: "Valid", expectedRevision: 2, userId: "forged" } })).statusCode).toBe(400);
  });

  test("enforces owner and tenant checks for reads and writes, including RLS", async () => {
    const h = await setup();
    const otherTenant = await seedTenant();
    const otherUser = await seedUser();
    const url = `/projects/${h.project.projectId}/instructions`;
    for (const auth of [{ tenantId: h.tenantId, userId: otherUser }, { tenantId: otherTenant, userId: h.userId }]) {
      h.setAuth({ ...auth, role: "member", isAdmin: false });
      expect((await h.app.inject({ url: url + "/status" })).statusCode).toBe(404);
      expect((await h.app.inject({ method: "PUT", url,
        payload: { instructions: "forged", expectedRevision: 0 } })).statusCode).toBe(404);
      await expect(h.projects.updateInstructions(auth.tenantId, auth.userId, h.project.projectId, "forged", 0)).rejects.toMatchObject({ status: 404 });
    }
    const hidden = await withTenantScope(appPool(), otherTenant, (db) => db.query(
      "UPDATE projects SET instructions = 'forged' WHERE project_id = $1 RETURNING project_id", [h.project.projectId]));
    expect(hidden.rowCount).toBe(0);
    expect(await h.projects.getOwned(h.tenantId, h.userId, h.project.projectId))
      .toMatchObject({ instructions: "", instructionsRevision: 0 });
  });
});

describe.skipIf(!adminDatabaseUrl())("project approval settings", () => {
  test("defaults to organization behavior and allows only the owner to change it", async () => {
    const h = await setup();
    const url = `/projects/${h.project.projectId}/approval-mode`;
    expect(h.project.approvalMode).toBe("organization_default");
    const manual = await h.app.inject({ method: "PUT", url, payload: { approvalMode: "manual" } });
    expect(manual.statusCode).toBe(200);
    expect(manual.json()).toMatchObject({ approvalMode: "manual" });
    expect((await h.projects.getOwned(h.tenantId, h.userId, h.project.projectId))?.approvalMode)
      .toBe("manual");

    const automatic = await h.app.inject({ method: "PUT", url, payload: { approvalMode: "automatic" } });
    expect(automatic.statusCode).toBe(200);
    expect(automatic.json()).toMatchObject({ approvalMode: "automatic" });
    expect((await h.projects.getOwned(h.tenantId, h.userId, h.project.projectId))?.approvalMode)
      .toBe("automatic");
    const fileMode = await h.app.inject({
      method: "PUT",
      url: `/projects/${h.project.projectId}/agent-file-mode`,
      payload: { agentFileMode: "read-write" },
    });
    expect(fileMode.statusCode).toBe(200);
    const settingAudits = await superuserPool().query(
      `SELECT event_type, user_id, payload
       FROM audit_events
       WHERE tenant_id=$1 AND payload->>'projectId'=$2
         AND event_type IN ('project_approval_mode_changed', 'project_agent_file_mode_changed')
       ORDER BY id`,
      [h.tenantId, h.project.projectId],
    );
    expect(settingAudits.rows).toEqual([
      {
        event_type: "project_approval_mode_changed",
        user_id: h.userId,
        payload: { projectId: h.project.projectId, approvalMode: "manual" },
      },
      {
        event_type: "project_approval_mode_changed",
        user_id: h.userId,
        payload: { projectId: h.project.projectId, approvalMode: "automatic" },
      },
      {
        event_type: "project_agent_file_mode_changed",
        user_id: h.userId,
        payload: { projectId: h.project.projectId, agentFileMode: "read-write" },
      },
    ]);

    const viewerId = await seedUser();
    await seedMembership(h.tenantId, viewerId);
    const members = new ProjectMemberStore(appPool());
    await members.setMember({ tenantId: h.tenantId, userId: h.userId, projectId: h.project.projectId }, viewerId, "viewer");
    await members.setSharing({ tenantId: h.tenantId, userId: h.userId, projectId: h.project.projectId }, {
      visibility: "organization", organizationRole: "viewer", confirmAudience: true
    });
    h.setAuth({ tenantId: h.tenantId, userId: viewerId, role: "member", isAdmin: false });
    expect((await h.app.inject({ method: "PUT", url, payload: { approvalMode: "manual" } })).statusCode).toBe(404);
    expect((await h.app.inject({ method: "PUT", url, payload: { approvalMode: "automatic" } })).statusCode).toBe(404);
  });
});


describe.skipIf(!adminDatabaseUrl())("project session pagination", () => {
  test("bounds detail lists and walks active, archived and Trash pages with independent cursors", async () => {
    const h = await setup();
    const url = `/projects/${h.project.projectId}`;
    await superuserPool().query(`INSERT INTO sessions
      (session_id, tenant_id, user_id, session_name, project_id, status, updated_at)
      SELECT gen_random_uuid()::text, $1, $2, status || '-' || n, $3, status,
        '2026-09-21T00:00:00.123000Z'::timestamptz + n * interval '1 microsecond'
      FROM unnest(ARRAY['active','archived','deleted']) status CROSS JOIN generate_series(1, 52) n`,
    [h.tenantId, h.userId, h.project.projectId]);
    // Neither personal sessions nor another project's sessions belong in these pages.
    await h.sessions.create(h.tenantId, h.userId, "Personal");
    const other = await h.projects.create(h.tenantId, h.userId, "Other project");
    await h.projects.createSession(h.tenantId, h.userId, other.projectId, "Other conversation");
    const detail = await h.app.inject(url);
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.sessions).toHaveLength(100);
    expect(body.trash.sessions).toHaveLength(50);
    for (const status of ["active", "archived", "deleted"]) {
      const first = status === "deleted" ? body.trash.sessions : body.sessions.filter((s: { status: string }) => s.status === status);
      const cursor = status === "deleted" ? body.trash.nextCursor : body.sessionCursors[status];
      expect(cursor).toEqual(expect.any(String));
      const page = await h.app.inject(`${url}/sessions?status=${status}&cursor=${encodeURIComponent(cursor)}`);
      expect(page.statusCode).toBe(200);
      expect(page.headers["cache-control"]).toBe("private, no-store");
      const rows = [...first, ...page.json().sessions];
      expect(rows).toHaveLength(status === "active" ? 53 : 52);
      expect(new Set(rows.map((s: { sessionId: string }) => s.sessionId)).size).toBe(rows.length);
      expect(rows.every((s: { projectId: string; status: string; purpose: string }) =>
        s.projectId === h.project.projectId && s.status === status && s.purpose === "normal")).toBe(true);
      expect(page.json().nextCursor).toBeNull();
    }
    expect((await h.app.inject(`${url}/sessions?limit=1`)).json().sessions).toHaveLength(1);
  });

  test.each(["limit=0", "limit=101", "limit=1.5", "cursor=garbage", "status=unknown", "status=active&utm_source=x"])(
    "rejects invalid or unsupported project session query: %s", async (query) => {
      const h = await setup();
      expect((await h.app.inject(`/projects/${h.project.projectId}/sessions?${query}`)).statusCode).toBe(400);
    }
  );

  test("rechecks project membership and Trash editor access on every page", async () => {
    const h = await setup();
    const reader = await seedUser();
    await seedMembership(h.tenantId, reader);
    const members = new ProjectMemberStore(appPool());
    const actor = { tenantId: h.tenantId, userId: h.userId, projectId: h.project.projectId };
    await members.setMember(actor, reader, "viewer");
    const url = `/projects/${h.project.projectId}/sessions`;
    h.setAuth({ tenantId: h.tenantId, userId: reader, role: "member", isAdmin: false });
    expect((await h.app.inject(url)).json().sessions).toHaveLength(1);
    expect((await h.app.inject(`${url}?status=deleted`)).statusCode).toBe(403);
    await members.setMember(actor, reader, "editor");
    expect((await h.app.inject(`${url}?status=deleted`)).statusCode).toBe(200);
    const cursor = Buffer.from(JSON.stringify({ updatedAt: h.first.updatedAt, sessionId: h.first.sessionId })).toString("base64url");
    await members.setMember(actor, reader, null);
    expect((await h.app.inject(`${url}?cursor=${cursor}`)).statusCode).toBe(404);
    const foreignTenant = await seedTenant();
    h.setAuth({ tenantId: foreignTenant, userId: h.userId, role: "member", isAdmin: false });
    expect((await h.app.inject(url)).statusCode).toBe(404);
  });
});
