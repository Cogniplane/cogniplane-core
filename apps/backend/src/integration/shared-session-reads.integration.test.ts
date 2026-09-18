import { createSessionTools } from "../services/managed-tools/session-tools.js";
import type { ToolExecutionContext } from "../services/auth/tool-execution-context-store.js";
import Fastify from "fastify";
import { Readable } from "node:stream";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { registerSessionCapabilityRoutes, type SessionCapabilityStores } from "../routes/session-capabilities.js";
import { ActiveTurnsRegistry } from "../services/active-turns-registry.js";
import { ProjectStore } from "../services/project-store.js";
import { ProjectFileStore } from "../services/project-file-store.js";
import { ProjectMemberStore } from "../services/project-member-store.js";
import { SessionStore } from "../services/session-store.js";
import { MessageStore } from "../services/message-store.js";
import { ArtifactStore } from "../services/artifacts/artifact-store.js";
import { AuditEventStore } from "../services/audit-event-store.js";
import { registerProjectRoutes, type ProjectRouteStores } from "../routes/projects.js";
import { registerAdminArtifactRoutes } from "../routes/admin/admin-artifact-routes.js";
import { registerArtifactRoutes } from "../routes/artifacts.js";
import { registerSessionRoutes, type SessionRouteStores } from "../routes/sessions.js";
import { createTestConfig } from "../test-helpers/test-config.js";
import { appPool, superuserPool, adminDatabaseUrl } from "./support/database.js";
import { seedTenant, seedUser, seedMembership } from "./support/fixtures.js";

async function setup() {
  const tenantId = await seedTenant(), userId = await seedUser();
  await seedMembership(tenantId, userId);
  const projects = new ProjectStore(appPool());
  const projectFiles = new ProjectFileStore(appPool(), { warn() {} });
  const project = await projects.create(tenantId, userId, "Shared research");
  const actor = { tenantId, userId, projectId: project.projectId };
  const members = new ProjectMemberStore(appPool());
  const viewerId = await seedUser();
  await seedMembership(tenantId, viewerId);
  await members.setMember(actor, viewerId, "viewer");
  const sessionId = (await projects.createSession(tenantId, userId, project.projectId, "Research"))!;
  const sessions = new SessionStore(appPool());
  const messages = new MessageStore(appPool());
  const artifacts = new ArtifactStore(appPool(), superuserPool());
  const first = await messages.create({ tenantId, userId, sessionId, role: "user", status: "completed", content: "Question" });
  const second = await messages.create({ tenantId, userId: viewerId, sessionId, role: "assistant", status: "completed", content: "Shared result" });
  await messages.upsertToolResult({ tenantId, userId: viewerId, sessionId, messageId: second.messageId,
    toolResultId: "tool-" + sessionId, kind: "mcp", title: "Read", status: "completed", command: null,
    cwd: null, server: "source", toolName: "read", input: "{}", output: "Shared source", exitCode: null, durationMs: 1 });
  const artifact = await artifacts.create({ tenantId, userId, sessionId, artifactType: "upload", artifactName: "report.pdf",
    mimeType: "application/pdf", storageBackend: "local", storageKey: "shared/" + sessionId,
    fileSizeBytes: 4, checksumSha256: "test", status: "ready", createdByType: "user", detail: {} });
  const app = Fastify();
  app.decorate("db", appPool());
  app.decorate("config", createTestConfig());
  let auth = { tenantId, userId: viewerId, role: "member" as "member" | "admin", isAdmin: false };
  app.addHook("preHandler", async request => { request.auth = auth; });
  const openReadStream = vi.fn(async (_key: string) => ({ stream: Readable.from(["data"]), fileSizeBytes: 4 }));
  const extractArtifactText = vi.fn(async () => "PDF text");
  await registerArtifactRoutes(app, { sessions, artifacts, auditEvents: new AuditEventStore(appPool()),
    storage: { openReadStream, put: vi.fn(), delete: vi.fn() }, processor: { extractArtifactText },
    limits: { consumeRateLimit: async () => null } });
  await registerSessionCapabilityRoutes(app, {
    sessions, activeTurns: new ActiveTurnsRegistry(), runtimeAdapter: { hasActiveTurn: () => false },
    tenantMembers: { isUserBetaTester: async () => false },
    dynamicConfig: { compileRuntimeConfig: async () => ({ skills: [], mcpServers: [] }), listMcpServers: async () => [] },
  } as unknown as SessionCapabilityStores);
  await registerAdminArtifactRoutes(app, { auditEvents: new AuditEventStore(appPool()) });
  await registerSessionRoutes(app, { sessions, messages } as unknown as SessionRouteStores);
  await registerProjectRoutes(app, {
    projects,
    projectFiles,
    sessions,
    artifacts,
    auditEvents: new AuditEventStore(appPool()),
  } as unknown as ProjectRouteStores);
  onTestFinished(() => app.close());
  const mint = async () => {
    const response = await app.inject({ method: "POST", url: `/artifacts/${artifact.artifactId}/download-token` });
    expect(response.statusCode).toBe(200);
    return response.json().download.token as string;
  };
  return { tenantId, userId, viewerId, sessionId, actor, projects, members, sessions, messages, artifacts,
    artifact, first, second, app, mint, openReadStream, extractArtifactText,
    authenticate: (user: string, tenant = tenantId, admin = false) => {
      auth = { tenantId: tenant, userId: user, role: admin ? "admin" : "member", isAdmin: admin };
    } };
}

describe.skipIf(!adminDatabaseUrl())("shared session reads", () => {
  test("reads all authors and tool results through HTTP, including archived sessions", async () => {
    const h = await setup();
    expect((await h.app.inject("/projects")).json().projects).toMatchObject([{ projectId: h.actor.projectId }]);
    const detail = await h.app.inject(`/projects/${h.actor.projectId}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ sessions: [{ sessionId: h.sessionId }], files: [{ artifactId: h.artifact.artifactId }] });
    expect(await h.projects.getOwned(h.tenantId, h.viewerId, h.actor.projectId)).toBeNull();
    expect((await h.app.inject({ method: "PUT", url: `/projects/${h.actor.projectId}`, payload: { name: "Denied" } })).statusCode).toBe(404);
    const history = await h.app.inject(`/sessions/${h.sessionId}/messages`);
    expect(history.statusCode).toBe(200);
    expect(history.json().messages).toMatchObject([
      { userId: h.userId, content: "Question" },
      { userId: h.viewerId, content: "Shared result", toolResults: [{ output: "Shared source" }] },
    ]);
    expect(await h.sessions.list(h.tenantId, h.viewerId)).toMatchObject([{ sessionId: h.sessionId, latestTurnId: h.second.messageId }]);
    expect((await h.app.inject(`/sessions/${h.sessionId}/artifacts`)).json().artifacts).toMatchObject([{ artifactId: h.artifact.artifactId }]);
    expect(await h.artifacts.listByProject(h.tenantId, h.viewerId, h.actor.projectId)).toHaveLength(1);
    await superuserPool().query("UPDATE sessions SET status='archived' WHERE session_id=$1", [h.sessionId]);
    await h.projects.setArchived(h.tenantId, h.userId, h.actor.projectId, true);
    expect((await h.app.inject(`/sessions/${h.sessionId}/messages`)).statusCode).toBe(200);
    expect((await h.app.inject(`/sessions/${h.sessionId}/artifacts`)).statusCode).toBe(200);
    expect((await h.app.inject(`/artifacts/${h.artifact.artifactId}/preview-text`)).json()).toEqual({ text: "PDF text" });
    const token = await h.mint();
    const download = await h.app.inject(`/downloads/${token}`);
    expect(download.statusCode).toBe(200);
    expect(download.headers["cache-control"]).toBe("private, no-store");
    expect((await h.app.inject(`/downloads/${token}`)).statusCode).toBe(404);
  });

  test("revokes creator and member reads without granting organization admins access", async () => {
    const h = await setup();
    const token = await h.mint();
    await h.members.setMember(h.actor, h.viewerId, null);
    expect((await h.app.inject(`/projects/${h.actor.projectId}`)).statusCode).toBe(404);
    expect((await h.app.inject("/projects")).json().projects).toEqual([]);
    expect(await h.sessions.getReadable(h.tenantId, h.sessionId, h.viewerId)).toBeNull();
    expect(await h.sessions.list(h.tenantId, h.viewerId)).toEqual([]);
    expect((await h.messages.listBySession(h.tenantId, h.sessionId, h.viewerId)).messages).toEqual([]);
    expect(await h.artifacts.listBySession(h.tenantId, h.sessionId, h.viewerId)).toEqual([]);
    expect((await h.app.inject(`/downloads/${token}`)).statusCode).toBe(404);
    const admin = await seedUser();
    await seedMembership(h.tenantId, admin, "admin");
    h.authenticate(admin, h.tenantId, true);
    expect((await h.app.inject(`/sessions/${h.sessionId}/messages`)).statusCode).toBe(404);
    expect((await h.app.inject(`/downloads/${token}`)).statusCode).toBe(404);
    await h.members.setMember(h.actor, h.userId, null);
    h.authenticate(h.userId);
    expect((await h.app.inject(`/sessions/${h.sessionId}/messages`)).statusCode).toBe(404);
    expect((await h.artifacts.listForUser(h.tenantId, h.userId, {})).items).toEqual([]);
    expect(await h.artifacts.getReadable(h.tenantId, h.artifact.artifactId, h.userId)).toBeNull();
  });

  test("binds tokens to the requester and rejects revocation between peek and consumption", async () => {
    const h = await setup();
    const token = await h.mint();
    h.authenticate(h.userId);
    expect((await h.app.inject(`/downloads/${token}`)).statusCode).toBe(404);
    h.authenticate(h.viewerId, await seedTenant());
    expect((await h.app.inject(`/downloads/${token}`)).statusCode).toBe(404);
    h.authenticate(h.viewerId);
    const stream = Readable.from(["data"]);
    h.openReadStream.mockImplementationOnce(async () => {
      await h.members.setMember(h.actor, h.viewerId, null);
      return { stream, fileSizeBytes: 4 };
    });
    expect((await h.app.inject(`/downloads/${token}`)).statusCode).toBe(404);
    expect(stream.destroyed).toBe(true);
    const row = await superuserPool().query("SELECT consumed_at FROM artifact_download_tokens WHERE token=$1", [token]);
    expect(row.rows[0].consumed_at).toBeNull();
  });

  test("rechecks access after PDF extraction and honors organization baseline departure", async () => {
    const h = await setup();
    await h.members.setSharing(h.actor, { visibility: "organization", organizationRole: "viewer", confirmAudience: true });
    await h.members.setMember(h.actor, h.viewerId, null, { confirmRetainedRole: "viewer" });
    expect(await h.sessions.getReadable(h.tenantId, h.sessionId, h.viewerId)).not.toBeNull();
    h.extractArtifactText.mockImplementationOnce(async () => {
      await superuserPool().query("DELETE FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2", [h.tenantId, h.viewerId]);
      return "No longer authorized";
    });
    const response = await h.app.inject(`/artifacts/${h.artifact.artifactId}/preview-text`);
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("No longer authorized");
  });

  test("keeps remaining members readable without an owner and consumes a token only once", async () => {
    const h = await setup();
    const token = await h.mint();
    await h.members.setMember(h.actor, h.userId, null);
    expect((await h.app.inject(`/projects/${h.actor.projectId}`)).statusCode).toBe(200);
    expect((await h.app.inject(`/sessions/${h.sessionId}/messages`)).statusCode).toBe(200);
    const consume = () => h.artifacts.consumeDownloadToken({ token, requesterTenantId: h.tenantId,
      requesterUserId: h.viewerId, callerIsAdmin: false });
    const results = await Promise.all([consume(), consume()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter(result => result === null)).toHaveLength(1);
  });

  test("rejects a token after artifact deletion or a storage location change", async () => {
    const h = await setup();
    const token = await h.mint();
    await superuserPool().query("UPDATE artifacts SET storage_key='replaced' WHERE artifact_id=$1", [h.artifact.artifactId]);
    expect((await h.app.inject(`/downloads/${token}`)).statusCode).toBe(404);
    await superuserPool().query("UPDATE artifacts SET storage_key=$2, status='deleted' WHERE artifact_id=$1",
      [h.artifact.artifactId, h.artifact.storageKey]);
    expect((await h.app.inject(`/downloads/${token}`)).statusCode).toBe(404);
    expect(h.openReadStream).not.toHaveBeenCalled();
  });

  test("rejects admin minting for project artifacts without inserting tokens or success audits", async () => {
    const h = await setup();
    const adminId = await seedUser();
    await seedMembership(h.tenantId, adminId, "admin");
    h.authenticate(adminId, h.tenantId, true);
    const mintAdmin = () => h.app.inject({ method: "POST", url: `/admin/artifacts/${h.artifact.artifactId}/download-token` });
    expect((await mintAdmin()).statusCode).toBe(404);
    await h.members.setMember(h.actor, adminId, "viewer");
    expect((await mintAdmin()).statusCode).toBe(404);
    expect((await superuserPool().query("SELECT token FROM artifact_download_tokens WHERE artifact_id=$1", [h.artifact.artifactId])).rows).toEqual([]);
    expect((await superuserPool().query("SELECT id FROM audit_events WHERE tenant_id=$1 AND event_type='admin.artifact.download_token_minted'", [h.tenantId])).rows).toEqual([]);
    const token = await h.mint();
    expect((await h.app.inject(`/downloads/${token}`)).statusCode).toBe(200);
  });

  test("retains personal artifacts after chat deletion, including administrative downloads", async () => {
    const h = await setup();
    const personal = await h.sessions.create(h.tenantId, h.userId, "Personal");
    const artifact = await h.artifacts.create({ tenantId: h.tenantId, userId: h.userId,
      sessionId: personal.sessionId, artifactType: "upload", artifactName: "retained.pdf",
      mimeType: "application/pdf", storageBackend: "local", storageKey: "personal/" + personal.sessionId,
      fileSizeBytes: 4, checksumSha256: "test", status: "ready", createdByType: "user", detail: {} });
    h.authenticate(h.userId);
    expect(await h.sessions.setArchived(h.tenantId, personal.sessionId, h.userId, true)).not.toBeNull();
    expect((await h.app.inject(`/sessions/${personal.sessionId}/messages`)).statusCode).toBe(404);
    expect((await h.app.inject(`/sessions/${personal.sessionId}/artifacts`)).statusCode).toBe(404);
    expect((await h.app.inject(`/artifacts/${artifact.artifactId}/preview-text`)).statusCode).toBe(200);
    expect(await h.sessions.remove(h.tenantId, personal.sessionId, h.userId)).toBe(true);
    expect((await h.app.inject(`/sessions/${personal.sessionId}/messages`)).statusCode).toBe(404);
    expect((await h.app.inject("/artifacts")).json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ artifactId: artifact.artifactId }),
    ]));
    expect((await h.app.inject(`/artifacts/${artifact.artifactId}/preview-text`)).statusCode).toBe(200);
    const mint = await h.app.inject({ method: "POST", url: `/artifacts/${artifact.artifactId}/download-token` });
    expect(mint.statusCode).toBe(200);
    const token = mint.json().download.token;
    h.authenticate(h.viewerId);
    expect((await h.app.inject(`/downloads/${token}`)).statusCode).toBe(404);
    h.authenticate(h.userId);
    expect((await h.app.inject(`/downloads/${token}`)).statusCode).toBe(200);
    const adminId = await seedUser();
    await seedMembership(h.tenantId, adminId, "admin");
    h.authenticate(adminId, h.tenantId, true);
    const adminMint = await h.app.inject({ method: "POST", url: `/admin/artifacts/${artifact.artifactId}/download-token` });
    expect(adminMint.statusCode).toBe(200);
    const adminToken = adminMint.json().download.token;
    const persisted = await superuserPool().query("SELECT user_id FROM artifact_download_tokens WHERE token=$1", [adminToken]);
    expect(persisted.rows[0].user_id).toBe(h.userId);
    expect((await h.app.inject(`/downloads/${adminToken}`)).statusCode).toBe(200);
  });

  test("lets members inspect capabilities without granting mutation access", async () => {
    const h = await setup();
    const response = await h.app.inject(`/sessions/${h.sessionId}/capabilities`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ selection: null, version: 0, canEdit: false });
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect((await h.app.inject({ method: "PUT", url: `/sessions/${h.sessionId}/capabilities`,
      payload: { selection: null, version: 0 } })).statusCode).toBe(403);
    await h.members.setMember(h.actor, h.viewerId, null);
    expect((await h.app.inject(`/sessions/${h.sessionId}/capabilities`)).statusCode).toBe(404);
    await expect(h.sessions.getCapabilities(h.tenantId, h.sessionId, h.viewerId)).rejects.toMatchObject({ statusCode: 404 });
    h.authenticate(h.userId);
    expect((await h.app.inject(`/sessions/${h.sessionId}/capabilities`)).json().canEdit).toBe(true);
  });

  test("reports an unready PDF consistently before and after extraction", async () => {
    const h = await setup();
    await h.artifacts.update(h.tenantId, h.artifact.artifactId, { status: "processing" });
    const before = await h.app.inject(`/artifacts/${h.artifact.artifactId}/preview-text`);
    expect(before.statusCode).toBe(422);
    expect(h.extractArtifactText).not.toHaveBeenCalled();
    await h.artifacts.update(h.tenantId, h.artifact.artifactId, { status: "ready" });
    h.extractArtifactText.mockImplementationOnce(async () => {
      await h.artifacts.update(h.tenantId, h.artifact.artifactId, { status: "processing" });
      return "Unavailable text";
    });
    const after = await h.app.inject(`/artifacts/${h.artifact.artifactId}/preview-text`);
    expect(after.statusCode).toBe(422);
    expect(after.json()).toEqual(before.json());
    expect(after.body).not.toContain("Unavailable text");
  });

  test("keeps private conversations isolated and hides deleted project sessions", async () => {
    const h = await setup();
    const privateSession = await h.sessions.create(h.tenantId, h.userId, "Private");
    expect(await h.sessions.getReadable(h.tenantId, privateSession.sessionId, h.viewerId)).toBeNull();
    expect(await h.sessions.getReadable(h.tenantId, privateSession.sessionId, h.userId)).not.toBeNull();
    await superuserPool().query("UPDATE sessions SET status='deleted' WHERE session_id=$1", [h.sessionId]);
    expect((await h.app.inject(`/sessions/${h.sessionId}/messages`)).statusCode).toBe(404);
    expect(await h.artifacts.listByProject(h.tenantId, h.viewerId, h.actor.projectId)).toEqual([]);
    expect((await h.app.inject({ method: "POST", url: `/artifacts/${h.artifact.artifactId}/download-token` })).statusCode).toBe(404);
  });
});


describe.skipIf(!adminDatabaseUrl())("shared managed session tools", () => {
  test("reads another participant's context and derived text, then rejects revocation during storage I/O", async () => {
    const h = await setup();
    const derived = await h.artifacts.create({ tenantId: h.tenantId, userId: h.userId, sessionId: h.sessionId,
      artifactType: "derived", sourceArtifactId: h.artifact.artifactId, artifactName: "report.txt",
      mimeType: "text/plain", storageBackend: "local", storageKey: "derived/" + h.sessionId,
      fileSizeBytes: 4, checksumSha256: "text", status: "ready", createdByType: "system" });
    const context: ToolExecutionContext = {
      tenantId: h.tenantId, userId: h.viewerId, sessionId: h.sessionId, toolContextId: "ctx_test",
      runtimeId: "runtime", runtimePolicyId: "default", messageId: null, credentialEnvelope: {},
      metadata: {}, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const tools = createSessionTools({ sessions: h.sessions, messages: h.messages, artifacts: h.artifacts,
      storage: { openReadStream: h.openReadStream } });
    const call = (name: string, args = {}) => tools.find(tool => tool.name === name)!.handler({ context, arguments: args });
    expect(await call("session_context")).toMatchObject({ session: { sessionId: h.sessionId },
      recentMessages: expect.arrayContaining([expect.objectContaining({ content: "Question" })]) });
    expect(await call("list_artifacts")).toMatchObject({ artifacts: expect.arrayContaining([
      expect.objectContaining({ artifactId: h.artifact.artifactId }),
    ]) });
    expect(await call("read_text_artifact", { artifactId: h.artifact.artifactId })).toMatchObject({
      artifact: { artifactId: derived.artifactId }, content: "data",
    });
    h.openReadStream.mockImplementationOnce(async () => {
      await h.members.setMember(h.actor, h.viewerId, null);
      return { stream: Readable.from(["revoked data"]), fileSizeBytes: 12 };
    });
    await expect(call("read_text_artifact", { artifactId: h.artifact.artifactId })).rejects.toThrow("Artifact not found");
    await expect(call("session_context")).rejects.toThrow("Session not found");
    await expect(call("list_artifacts")).rejects.toThrow("Session not found");
  });
});
