import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { DEFAULT_PII_PROTECTION, type PiiProtectionSettings } from "@cogniplane/shared-types";
import { registerArtifactRoutes } from "../routes/artifacts.js";
import { registerProjectFileRoutes } from "../routes/project-files.js";
import { ProjectStore } from "../services/project-store.js";
import { ProjectMemberStore } from "../services/project-member-store.js";
import { SessionStore } from "../services/session-store.js";
import { ArtifactStore } from "../services/artifacts/artifact-store.js";
import { LocalArtifactStorage } from "../services/artifacts/artifact-storage.js";
import { ArtifactProcessor } from "../services/artifacts/artifact-processor.js";
import { AuditEventStore } from "../services/audit-event-store.js";
import { PiiArtifactScanEnqueuer } from "../services/pii/pii-artifact-scan-enqueuer.js";
import { PiiScanRunStore } from "../services/pii/pii-scan-run-store.js";
import { PiiScanJobStore } from "../services/pii/pii-scan-job-store.js";
import { PiiScanJobHandler } from "../services/pii/pii-scan-job-handler.js";
import type { PiiDecision } from "../services/pii/pii-protection-service.js";
import * as uploadAccess from "../services/session-upload-access.js";
import * as projectAccess from "../services/project-access.js";
import { createTestConfig } from "../test-helpers/test-config.js";
import { appPool, superuserPool, adminDatabaseUrl } from "./support/database.js";
import { seedTenant, seedUser, seedMembership } from "./support/fixtures.js";

async function setup(mode: PiiProtectionSettings["mode"] = "off") {
  const tenantId = await seedTenant(), ownerId = await seedUser(), editorId = await seedUser(), viewerId = await seedUser();
  for (const userId of [ownerId, editorId, viewerId]) await seedMembership(tenantId, userId);
  const projects = new ProjectStore(appPool());
  const project = await projects.create(tenantId, ownerId, "Shared uploads");
  const actor = { tenantId, userId: ownerId, projectId: project.projectId };
  const members = new ProjectMemberStore(appPool());
  await members.setMember(actor, editorId, "editor");
  await members.setMember(actor, viewerId, "viewer");
  const sessionId = (await projects.createSession(tenantId, ownerId, project.projectId, "Shared conversation"))!;
  const sessions = new SessionStore(appPool());
  const artifacts = new ArtifactStore(appPool(), superuserPool());
  const root = await mkdtemp(join(tmpdir(), "shared-uploads-"));
  const storage = new LocalArtifactStorage(root);
  const put = vi.spyOn(storage, "put");
  const remove = vi.spyOn(storage, "delete");
  const app = Fastify();
  const config = createTestConfig();
  app.decorate("db", appPool());
  app.decorate("config", config);
  await app.register(multipart);
  let auth = { tenantId, userId: editorId, role: "member" as const, isAdmin: false };
  app.addHook("preHandler", async request => { request.auth = auth; });
  const auditEvents = new AuditEventStore(appPool());
  const piiScanRuns = new PiiScanRunStore(appPool());
  const piiScanJobs = new PiiScanJobStore(appPool(), superuserPool());
  const evaluateArtifact = vi.fn(async (): Promise<PiiDecision> => ({ action: "allow", reason: "no_findings" }));
  const getActiveSettings = vi.fn(async (): Promise<PiiProtectionSettings> => ({
    ...DEFAULT_PII_PROTECTION, enabled: true, mode,
    scopes: { ...DEFAULT_PII_PROTECTION.scopes, uploads: true },
  }));
  const subjectReader = {
    readMessageText: async () => null,
    readArtifact: async ({ artifactId }: { artifactId: string }) => {
      const artifact = await artifacts.get(tenantId, artifactId);
      if (!artifact) return null;
      return { artifactId, contentType: artifact.mimeType, entityTypes: [], readContent: async () => {
        const handle = await storage.openReadStream(artifact.storageKey);
        const chunks: Buffer[] = [];
        for await (const chunk of handle.stream) chunks.push(Buffer.from(chunk));
        return Buffer.concat(chunks).toString();
      } };
    },
  };
  const scanDeps = { artifacts, storage, piiScanRuns, piiScanJobs, subjectReader, auditEvents,
    piiProtection: { getActiveSettings, evaluateArtifact, evaluateText: async (): Promise<PiiDecision> => ({ action: "allow", reason: "no_findings" }) },
    logger: app.log };
  const enqueuer = new PiiArtifactScanEnqueuer(scanDeps);
  const worker = new PiiScanJobHandler({ ...scanDeps, messages: { setPiiDetail: async () => {} } });
  const processor = new ArtifactProcessor({ config, storage, logger: app.log });
  await registerArtifactRoutes(app, { sessions, artifacts, storage, processor, auditEvents,
    piiScanEnqueuer: enqueuer, limits: { consumeRateLimit: async () => null } });
  await registerProjectFileRoutes(app, { artifactStorage: storage, artifactProcessor: processor,
    limits: { consumeRateLimit: async () => null } as never });
  onTestFinished(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const upload = async (target = project.referenceSessionId, text = "Shared report", mime = "text/plain") => {
    const form = new FormData();
    form.set("sessionId", target);
    form.set("file", new Blob([text], { type: mime }), "report.txt");
    const request = new Request("http://localhost/artifacts", { method: "POST", body: form });
    return app.inject({ method: "POST", url: "/artifacts",
      headers: { "content-type": request.headers.get("content-type")! },
      payload: Buffer.from(await request.arrayBuffer()) });
  };
  const publish = (artifactId: string) => app.inject({ method: "POST",
    url: `/projects/${project.projectId}/library/files`,
    payload: { artifactId, name: "Published.txt", kind: "published" } });
  const count = async () => Number((await superuserPool().query(
    "SELECT count(*) FROM artifacts WHERE tenant_id=$1", [tenantId])).rows[0].count);
  return { app, tenantId, ownerId, editorId, viewerId, project, actor, members, projects, sessionId,
    sessions, artifacts, storage, put, remove, upload, publish, count, getActiveSettings,
    evaluateArtifact, enqueuer, worker, piiScanJobs,
    authenticate: (userId: string, tenant = tenantId) => { auth = { ...auth, userId, tenantId: tenant }; } };
}

describe.skipIf(!adminDatabaseUrl())("shared session uploads", () => {
  test("an editor uploads to another member's reference session and publishes independent shared bytes", async () => {
    const h = await setup();
    const response = await h.upload();
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    const artifact = response.json().artifact;
    expect(artifact).toMatchObject({ userId: h.editorId, sessionId: h.project.referenceSessionId, status: "ready" });
    const sources = await h.app.inject(`/sessions/${h.project.referenceSessionId}/artifacts`);
    expect(sources.json().artifacts).toMatchObject([{ artifactId: artifact.artifactId, userId: h.editorId }]);
    // Another editor/owner can select and publish the participant's upload.
    h.authenticate(h.ownerId);
    const saved = await h.publish(artifact.artifactId);
    expect(saved.statusCode).toBe(201);
    const file = saved.json();
    // Published versions must own independent bytes, not the source object's key.
    await h.storage.delete(artifact.storageKey);
    h.authenticate(h.viewerId);
    const download = await h.app.inject(`/projects/${h.project.projectId}/library/files/${file.fileId}/versions/${file.version.versionId}/content`);
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe("Shared report");
    const audits = await superuserPool().query(
      "SELECT user_id,session_id FROM audit_events WHERE tenant_id=$1 AND event_type='artifact_uploaded'", [h.tenantId]);
    expect(audits.rows).toEqual([{ user_id: h.editorId, session_id: h.project.referenceSessionId }]);
  });

  test("allows editor uploads to shared conversations and keeps private sessions creator-only", async () => {
    const h = await setup();
    expect((await h.upload(h.sessionId)).statusCode).toBe(201);
    const personal = await h.sessions.create(h.tenantId, h.ownerId, "Private");
    expect((await h.upload(personal.sessionId)).statusCode).toBe(404);
    h.authenticate(h.ownerId);
    expect((await h.upload(personal.sessionId)).statusCode).toBe(201);
    await h.sessions.setArchived(h.tenantId, personal.sessionId, h.ownerId, true);
    expect((await h.upload(personal.sessionId)).statusCode).toBe(404);
  });

  test("denies viewers, outsiders, foreign tenants, and removed creators before writing bytes", async () => {
    const h = await setup();
    h.authenticate(h.viewerId);
    expect((await h.upload()).statusCode).toBe(403);
    const outsider = await seedUser();
    await seedMembership(h.tenantId, outsider, "admin");
    h.authenticate(outsider);
    expect((await h.upload()).statusCode).toBe(404);
    const otherTenant = await seedTenant();
    await seedMembership(otherTenant, h.editorId);
    h.authenticate(h.editorId, otherTenant);
    expect((await h.upload()).statusCode).toBe(404);
    await h.members.setMember(h.actor, h.ownerId, null);
    h.authenticate(h.ownerId);
    expect((await h.upload()).statusCode).toBe(404);
    expect(h.put).not.toHaveBeenCalled();
    expect(await h.count()).toBe(0);
  });

  test("uses the effective organization editor baseline", async () => {
    const h = await setup();
    await h.members.setSharing(h.actor, { visibility: "organization", organizationRole: "editor", confirmAudience: true });
    h.authenticate(h.viewerId);
    expect((await h.upload()).statusCode).toBe(201);
  });

  test.each(["demotion", "removal", "departure", "project archive", "session archive", "session deletion"])(
    "rejects %s during storage I/O and removes the unreferenced bytes", async change => {
      const h = await setup();
      const originalPut = LocalArtifactStorage.prototype.put.bind(h.storage);
      h.put.mockImplementationOnce(async input => {
        const stored = await originalPut(input);
        if (change === "demotion") await h.members.setMember(h.actor, h.editorId, "viewer");
        if (change === "removal") await h.members.setMember(h.actor, h.editorId, null);
        if (change === "departure") await superuserPool().query("DELETE FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2", [h.tenantId, h.editorId]);
        if (change === "project archive") await h.projects.setArchived(h.tenantId, h.ownerId, h.project.projectId, true);
        if (change === "session archive") await h.sessions.setArchived(h.tenantId, h.sessionId, h.ownerId, true);
        if (change === "session deletion") await h.sessions.remove(h.tenantId, h.sessionId, h.ownerId);
        return stored;
      });
      const response = await h.upload(h.sessionId);
      expect(response.statusCode).toBe(change === "demotion" ? 403 : change === "project archive" ? 409 : 404);
      expect(await h.count()).toBe(0);
      expect(h.remove).toHaveBeenCalledOnce();
      await expect(h.storage.openReadStream(h.remove.mock.calls[0]![0])).rejects.toThrow();
      expect(h.getActiveSettings).not.toHaveBeenCalled();
      expect((await superuserPool().query(
        "SELECT id FROM audit_events WHERE tenant_id=$1 AND event_type='artifact_uploaded'", [h.tenantId])).rows).toEqual([]);
    },
  );

  test("preserves access errors when rejected-upload cleanup fails", async () => {
    const h = await setup();
    const originalPut = LocalArtifactStorage.prototype.put.bind(h.storage);
    h.put.mockImplementationOnce(async input => {
      const stored = await originalPut(input);
      await h.members.setMember(h.actor, h.editorId, "viewer");
      return stored;
    });
    h.remove.mockRejectedValueOnce(new Error("storage unavailable"));
    const logged = vi.spyOn(h.app.log, "error");
    expect((await h.upload()).statusCode).toBe(403);
    expect(await h.count()).toBe(0);
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ tenantId: h.tenantId, storageKey: expect.any(String) }),
      "Failed to delete rejected artifact upload");
  });

  test("rejects organization departure after acquiring upload locks and checking access", async () => {
    const h = await setup();
    const original = uploadAccess.requireSessionUploadAccess;
    let departureCommitted = false;
    // Inject after the actual lock/access check, before the INSERT predicate.
    // Keep the explicit assertion below if this exported helper is refactored.
    const guard = vi.spyOn(uploadAccess, "requireSessionUploadAccess").mockImplementation(async (db, actor, lock) => {
      const projectId = await original(db, actor, lock);
      if (lock) {
        await superuserPool().query(
          "DELETE FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2", [h.tenantId, h.editorId]);
        departureCommitted = true;
      }
      return projectId;
    });
    try {
      expect((await h.upload()).statusCode).toBe(404);
      expect(departureCommitted).toBe(true);
      expect(await h.count()).toBe(0);
      expect(h.remove).toHaveBeenCalledOnce();
    } finally {
      guard.mockRestore();
    }
  });

  test("concurrent upload and session assignment acquire project before session without deadlocking", async () => {
    const h = await setup();
    const original = projectAccess.requireProjectAccess;
    let assignmentPid: number | undefined;
    let releaseAssignment!: () => void;
    const proceed = new Promise<void>(resolve => { releaseAssignment = resolve; });
    const guard = vi.spyOn(projectAccess, "requireProjectAccess").mockImplementation(async (db, actor, minimum, options) => {
      const access = await original(db, actor, minimum, options);
      if (actor.userId === h.ownerId && options?.lock) {
        await db.query("SET LOCAL lock_timeout = '5s'");
        assignmentPid = Number((await db.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        // Pause the real assignment after its project lock, before its session lock.
        await proceed;
      }
      return access;
    });
    const assignment = h.projects.setSession(h.tenantId, h.ownerId, h.project.projectId, h.sessionId)
      .catch((error: unknown) => error);
    let upload: ReturnType<typeof h.upload> | undefined;
    try {
      await expect.poll(() => assignmentPid, { timeout: 5_000 }).toBeDefined();
      upload = h.upload(h.sessionId);
      // Observe a real database lock wait instead of assuming request timing.
      await expect.poll(async () => {
        const result = await superuserPool().query(
          `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))) AS waiting`,
          [assignmentPid],
        );
        return result.rows[0].waiting;
      }, { timeout: 5_000, interval: 10 }).toBe(true);
      releaseAssignment();
      expect(await assignment).toBe(true);
      expect((await upload).statusCode).toBe(201);
      expect(await h.count()).toBe(1);
    } finally {
      releaseAssignment();
      await Promise.allSettled([assignment, ...(upload ? [upload] : [])]);
      guard.mockRestore();
    }
  });

  test("requires retry when a private session joins a project during upload", async () => {
    const h = await setup();
    h.authenticate(h.ownerId);
    const personal = await h.sessions.create(h.tenantId, h.ownerId, "Private upload");
    const originalPut = LocalArtifactStorage.prototype.put.bind(h.storage);
    h.put.mockImplementationOnce(async input => {
      const stored = await originalPut(input);
      await h.projects.setSession(h.tenantId, h.ownerId, h.project.projectId, personal.sessionId);
      return stored;
    });
    const response = await h.upload(personal.sessionId);
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("session_changed");
    expect(await h.count()).toBe(0);
    expect(h.remove).toHaveBeenCalledOnce();
    expect((await h.upload(personal.sessionId)).statusCode).toBe(201);
  });

  test("keeps the file unpublished before enqueue and completes queued scans under the uploader's identity", async () => {
    const h = await setup("detect");
    const enqueue = h.enqueuer.enqueue.bind(h.enqueuer);
    vi.spyOn(h.enqueuer, "enqueue").mockImplementationOnce(async input => {
      expect((await h.artifacts.get(h.tenantId, input.artifactId))?.status).toBe("pending");
      expect((await h.publish(input.artifactId)).statusCode).toBe(404);
      return enqueue(input);
    });
    const response = await h.upload();
    expect(response.statusCode).toBe(201);
    const artifact = response.json().artifact;
    expect(artifact).toMatchObject({ status: "pending", detail: { pii: { status: "pending" } } });
    expect((await h.publish(artifact.artifactId)).statusCode).toBe(404);
    const jobs = await h.piiScanJobs.claimDueJobs(100);
    const job = jobs.find(item => item.subjectId === artifact.artifactId)!;
    expect(job).toMatchObject({ sourceUserId: h.editorId, sourceSessionId: h.project.referenceSessionId });
    await h.worker.execute(job);
    expect((await h.artifacts.get(h.tenantId, artifact.artifactId))).toMatchObject({ status: "ready", detail: { pii: { status: "scanned" } } });
    expect((await h.publish(artifact.artifactId)).statusCode).toBe(201);
  });

  test("synchronous scan failures never publish ready source files", async () => {
    const h = await setup("block");
    h.evaluateArtifact.mockRejectedValue(new Error("Provider unavailable"));
    expect((await h.upload()).statusCode).toBe(503);
    const [artifact] = await h.artifacts.listByProject(h.tenantId, h.editorId, h.project.projectId);
    expect(artifact).toMatchObject({ status: "failed", userId: h.editorId, detail: { pii: { status: "failed" } } });
    expect((await h.publish(artifact!.artifactId)).statusCode).toBe(404);
  });

  test("rechecks read access after a synchronous scan without discarding already accepted project content", async () => {
    const h = await setup("block");
    h.evaluateArtifact.mockImplementationOnce(async () => {
      await h.members.setMember(h.actor, h.editorId, null);
      return { action: "allow", reason: "no_findings" };
    });
    expect((await h.upload()).statusCode).toBe(404);
    const files = await h.artifacts.listByProject(h.tenantId, h.ownerId, h.project.projectId);
    expect(files).toMatchObject([{ status: "ready", userId: h.editorId }]);
  });
});
