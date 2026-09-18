import Fastify from "fastify";
import { describe, expect, test } from "vitest";
import { registerProjectMemberRoutes } from "../routes/project-members.js";
import { ProjectMemberStore } from "../services/project-member-store.js";
import { ProjectStore } from "../services/project-store.js";
import { SessionExecutionStore } from "../services/session-execution-store.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedTenant, seedUser, seedMembership } from "./support/fixtures.js";

async function setup() {
  const tenantId = await seedTenant(), ownerId = await seedUser(), editorId = await seedUser(), adminId = await seedUser();
  for (const userId of [ownerId, editorId]) await seedMembership(tenantId, userId);
  await seedMembership(tenantId, adminId, "admin");
  const projects = new ProjectStore(appPool());
  const project = await projects.create(tenantId, ownerId, "Shared project");
  const members = new ProjectMemberStore(appPool());
  const app = Fastify();
  let auth = { tenantId, userId: ownerId, role: "member" as "member" | "admin", isAdmin: false };
  app.addHook("preHandler", async request => { request.auth = auth; });
  await registerProjectMemberRoutes(app, members);
  return { app, projects, members, projectId: project.projectId, tenantId, ownerId, editorId, adminId,
    authenticate(userId: string, tenant = tenantId) { auth = { ...auth, userId, tenantId: tenant }; } };
}

describe.skipIf(!adminDatabaseUrl())("project member HTTP authorization", () => {
  test("requires owner authority and explicit audience confirmation, then preserves organization access on removal", async () => {
    const h = await setup();
    const url = `/projects/${h.projectId}`;
    try {
      expect((await h.app.inject({ method: "GET", url: `${url}/members` })).json()).toMatchObject({ visibility: "private", members: [{ userId: h.ownerId, role: "owner" }] });
      const invite = await h.app.inject({ method: "PUT", url: `${url}/members/${h.editorId}`, payload: { role: "editor" } });
      expect(invite.json()).toEqual({ role: "editor", effectiveRole: "editor" });
      h.authenticate(h.editorId);
      expect((await h.app.inject({ method: "GET", url: `${url}/members` })).statusCode).toBe(403);
      expect((await h.app.inject({ method: "PUT", url: `${url}/sharing`, payload: { visibility: "organization", organizationRole: "editor", confirmAudience: true } })).statusCode).toBe(403);
      h.authenticate(h.ownerId);
      const sharing = { visibility: "organization", organizationRole: "viewer" };
      expect((await h.app.inject({ method: "PUT", url: `${url}/sharing`, payload: sharing })).statusCode).toBe(409);
      expect((await h.app.inject({ method: "PUT", url: `${url}/sharing`, payload: { ...sharing, confirmAudience: true } })).statusCode).toBe(204);
      h.authenticate(h.editorId);
      expect((await h.app.inject({ method: "PUT", url: `${url}/members/${h.editorId}`, payload: { role: null } })).statusCode).toBe(409);
      expect((await h.app.inject({ method: "PUT", url: `${url}/members/${h.editorId}`, payload: { role: null, confirmRetainedRole: "viewer" } })).json()).toEqual({ role: null, effectiveRole: "viewer" });
      const otherTenant = await seedTenant();
      h.authenticate(h.ownerId, otherTenant);
      expect((await h.app.inject({ method: "GET", url: `${url}/members` })).statusCode).toBe(404);
    } finally { await h.app.close(); }
  });

  test("permits ownerless projects and audited recovery without granting the administrator project content", async () => {
    const h = await setup();
    const url = `/projects/${h.projectId}`;
    try {
      expect((await h.app.inject({ method: "PUT", url: `${url}/members/${h.ownerId}`, payload: { role: null } })).statusCode).toBe(200);
      expect((await h.app.inject({ method: "GET", url: "/admin/projects/ownerless" })).statusCode).toBe(403);
      h.authenticate(h.adminId);
      const list = await h.app.inject({ method: "GET", url: "/admin/projects/ownerless" });
      expect(list.json()).toEqual({ projects: [{ projectId: h.projectId, name: "Shared project" }] });
      expect(list.headers["cache-control"]).toBe("private, no-store");
      const recovery = `/admin/projects/${h.projectId}/recover-owner`;
      expect((await h.app.inject({ method: "POST", url: recovery, payload: { userId: h.editorId } })).statusCode).toBe(204);
      expect((await h.app.inject({ method: "POST", url: recovery, payload: { userId: h.adminId } })).statusCode).toBe(409);
      expect((await h.app.inject({ method: "GET", url: `${url}/members` })).statusCode).toBe(404);
      expect(await h.projects.getReadable(h.tenantId, h.adminId, h.projectId)).toBeNull();
      const audit = await superuserPool().query("SELECT user_id, payload FROM audit_events WHERE tenant_id=$1 AND event_type='project_owner_recovered'", [h.tenantId]);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({ user_id: h.adminId, payload: { memberUserId: h.editorId } });
    } finally { await h.app.close(); }
  });

  test("member demotion through HTTP fences the active participant", async () => {
    const h = await setup();
    try {
      const actor = { tenantId: h.tenantId, userId: h.ownerId, projectId: h.projectId };
      await h.members.setMember(actor, h.editorId, "editor");
      const sessionId = (await h.projects.createSession(h.tenantId, h.ownerId, h.projectId, "Shared"))!;
      const executions = new SessionExecutionStore(appPool());
      const execution = await executions.acquire({ tenantId: h.tenantId, sessionId, userId: h.editorId }, 60_000);
      expect((await h.app.inject({ method: "PUT", url: `/projects/${h.projectId}/members/${h.editorId}`, payload: { role: "viewer" } })).statusCode).toBe(200);
      expect(await executions.isCurrent(execution)).toBe(false);
    } finally { await h.app.close(); }
  });
});
