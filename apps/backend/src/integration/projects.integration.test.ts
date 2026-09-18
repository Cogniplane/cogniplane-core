import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { applyMigrations } from "../scripts/migrate-lib.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, test, vi, onTestFinished } from "vitest";
import { PiiScanJobHandler } from "../services/pii/pii-scan-job-handler.js";
import type { PiiScanJobRecord } from "../services/pii/pii-scan-job-store.js";
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
  const enqueue = vi.fn(async () => ({
    kind: "skipped" as string,
    errorCode: "provider_unavailable",
    errorMessage: "Scan unavailable"
  }));
  await registerProjectRoutes(app, {
    projects,
    sessions,
    artifacts,
    artifactStorage: storage,
    activeTurns,
    runtimeAdapter: { id: "test", hasActiveTurn: () => false, abortSession, purgeSessionData },
    limits: { consumeRateLimit: async () => null },
    piiScanEnqueuer: { enqueue },
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
  const copy = (sessionId?: string) =>
    app.inject({
      method: "POST",
      url: `/projects/${project.projectId}/files/copy`,
      payload: { artifactId: source.artifactId, ...(sessionId ? { sessionId } : {}) }
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
    copy,
    enqueue,
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

  test.skip("organizes sessions and persists independent references through source deletion", async () => {
    const h = await setup();
    const created = await h.app.inject({
      method: "POST",
      url: `/projects/${h.project.projectId}/sessions`,
      payload: { name: "Drafting" }
    });
    expect(created.statusCode).toBe(201);
    const target = created.json().session;
    expect(target.projectId).toBe(h.project.projectId);
    expect((await h.sessions.list(h.tenantId, h.userId)).map((s) => s.purpose)).toEqual([
      "normal",
      "normal"
    ]);
    const saved = await h.copy();
    expect(saved.statusCode).toBe(201);
    const reference = saved.json().artifact;
    expect(reference.sessionId).toBe(h.project.referenceSessionId);
    expect(reference.storageKey).not.toBe(h.source.storageKey);
    expect(reference.checksumSha256).toBe(h.source.checksumSha256);
    expect(await h.sessions.remove(h.tenantId, h.project.referenceSessionId, h.userId)).toBe(false);
    expect(
      await h.sessions.setArchived(h.tenantId, h.project.referenceSessionId, h.userId, true)
    ).toBeNull();
    await h.sessions.remove(h.tenantId, h.first.sessionId, h.userId);
    await h.storage.delete(h.source.storageKey);
    const detail = await h.app.inject(`/projects/${h.project.projectId}`);
    expect(detail.json().files.map((f: { artifactId: string }) => f.artifactId)).toEqual([
      reference.artifactId
    ]);
    const reused = await h.app.inject({
      method: "POST",
      url: `/projects/${h.project.projectId}/files/copy`,
      payload: {
        artifactId: reference.artifactId,
        sessionId: target.sessionId
      }
    });
    expect(reused.statusCode).toBe(201);
    expect(reused.json().artifact.storageKey).not.toBe(reference.storageKey);
    const handle = await h.storage.openReadStream(reused.json().artifact.storageKey);
    const chunks = [];
    for await (const chunk of handle.stream)
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    expect(Buffer.concat(chunks).toString()).toBe("Original report");
    expect(h.enqueue).toHaveBeenCalledTimes(2);
    expect(await h.artifacts.listBySession(h.tenantId, target.sessionId, h.userId)).toHaveLength(1);
  });

  test.skip("enforces tenant and owner isolation for projects, membership and file copies", async () => {
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
      expect((await h.copy()).statusCode).toBe(404);
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
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  test.skip("rejects unavailable sources and busy targets, and fails closed on a scan error", async () => {
    const h = await setup();
    h.activeTurns.mark(h.project.referenceSessionId);
    expect((await h.copy()).statusCode).toBe(409);
    h.activeTurns.clear(h.project.referenceSessionId);
    await h.artifacts.setPiiDetail(h.tenantId, h.source.artifactId, { status: "blocked" });
    expect((await h.copy()).statusCode).toBe(409);
    await h.artifacts.setPiiDetail(h.tenantId, h.source.artifactId, { status: "scanned" });
    h.enqueue.mockResolvedValue({
      kind: "failed",
      errorCode: "provider_unavailable",
      errorMessage: "Scan unavailable"
    });
    expect((await h.copy()).statusCode).toBe(503);
    expect(h.activeTurns.isBusy(h.project.referenceSessionId)).toBe(false);
    const copies = await h.artifacts.listBySession(
      h.tenantId,
      h.project.referenceSessionId,
      h.userId
    );
    expect(copies).toHaveLength(1);
    expect(copies[0].status).toBe("pending");
    expect(copies[0].checksumSha256).toBe(h.source.checksumSha256);
  });

  test.skip("rejects moves and detachment without changing conversation files or references", async () => {
    const h = await setup();
    await h.copy();
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
    expect((await h.app.inject(`/projects/${h.project.projectId}`)).json().files).toHaveLength(2);
    expect((await h.app.inject(`/projects/${second.projectId}`)).json().files).toHaveLength(0);
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

describe.skip("project copy review regressions", () => {
  test.each(["scanned", "transformed", "blocked", "failed"] as const)(
    "queued copies stay pending until the worker verdict %s",
    async (verdict) => {
      const h = await setup();
      h.enqueue.mockResolvedValue({ kind: "queued", errorCode: "", errorMessage: "" });
      const response = await h.copy();
      expect(response.statusCode).toBe(201);
      const copy = response.json().artifact;
      expect(copy.status).toBe("pending");
      await h.artifacts.setPiiDetail(h.tenantId, copy.artifactId, { status: verdict });
      expect((await h.artifacts.getOwned(h.tenantId, copy.artifactId, h.userId))?.status).toBe(
        ["scanned", "transformed"].includes(verdict) ? "ready" : "failed"
      );
    }
  );
  test("real scan worker completes a queued copy after its project is archived", async () => {
    const h = await setup();
    h.enqueue.mockResolvedValue({ kind: "queued", errorCode: "", errorMessage: "" });
    const copy = (await h.copy()).json().artifact;
    expect((await h.app.inject({ method: "PUT", url: `/projects/${h.project.projectId}/archive`,
      payload: { archived: true } })).statusCode).toBe(204);
    const worker = new PiiScanJobHandler({
      artifacts: h.artifacts,
      storage: h.storage,
      piiProtection: {
        evaluateArtifact: async () => ({ action: "allow", reason: "disabled" }),
        evaluateText: async () => ({ action: "allow", reason: "disabled" })
      },
      piiScanRuns: { update: async () => null },
      piiScanJobs: { markCompleted: async () => {}, recordFailure: async () => null },
      messages: { setPiiDetail: async () => {} },
      subjectReader: {
        readMessageText: async () => null,
        readArtifact: async () => ({
          artifactId: copy.artifactId,
          contentType: "text/plain",
          entityTypes: [],
          readContent: async () => "Original report"
        })
      },
      logger: { warn() {}, error() {} }
    });
    const now = new Date().toISOString();
    const job: PiiScanJobRecord = {
      tenantId: h.tenantId,
      jobId: "job",
      scanRunId: "scan",
      subjectType: "artifact",
      subjectId: copy.artifactId,
      sourceSessionId: copy.sessionId,
      sourceUserId: h.userId,
      mode: "detect",
      payload: { subjectKind: "upload" },
      status: "claimed",
      attempts: 1,
      maxAttempts: 3,
      runAfter: now,
      claimedAt: now,
      completedAt: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now
    };
    await worker.execute(job);
    const saved = await h.artifacts.getOwned(h.tenantId, copy.artifactId, h.userId);
    expect(saved?.status).toBe("ready");
    expect(saved?.detail.pii?.status).toBe("scanned");
  });
  test.each([
    ["allowed", "", 201],
    ["failed", "file_too_large", 422],
    ["failed", "provider_unavailable", 503]
  ] as const)("maps %s / %s to %s", async (kind, errorCode, status) => {
    const h = await setup();
    h.enqueue.mockResolvedValue({ kind, errorCode, errorMessage: "Scan result" });
    const response = await h.copy();
    expect(response.statusCode).toBe(status);
    if (status === 201) expect(response.json().artifact.status).toBe("ready");
    else expect(response.json()).toMatchObject({ error: errorCode });
  });
  test("rejects blank names and derived sources; v7 IDs work through HTTP", async () => {
    const h = await setup();
    expect(
      (await h.app.inject({ method: "POST", url: "/projects", payload: { name: "   " } }))
        .statusCode
    ).toBe(400);
    await superuserPool().query(
      "UPDATE artifacts SET artifact_type = 'derived' WHERE artifact_id = $1",
      [h.source.artifactId]
    );
    expect((await h.copy()).statusCode).toBe(409);
    expect(h.enqueue).not.toHaveBeenCalled();
    const renamed = await h.app.inject({
      method: "PUT",
      url: `/projects/${h.project.projectId}`,
      payload: { name: "Renamed" }
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().name).toBe("Renamed");
  });
  test("rerunning the migration runner preserves rows and isolation", async () => {
    const h = await setup();
    const migrations = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
    expect(await applyMigrations(superuserPool(), migrations, () => {})).toEqual([]);
    expect(await applyMigrations(superuserPool(), migrations, () => {})).toEqual([]);
    expect((await h.projects.getOwned(h.tenantId, h.userId, h.project.projectId))?.name).toBe(
      "Planning"
    );
    const otherTenant = await seedTenant();
    expect(
      (
        await withTenantScope(appPool(), otherTenant, (db) =>
          db.query("SELECT * FROM projects WHERE project_id = $1", [h.project.projectId])
        )
      ).rowCount
    ).toBe(0);
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

test.skip(
  "copies reject unsupported generated MIME types before scanning",
  async () => {
    const h = await setup();
    await superuserPool().query(
      "UPDATE artifacts SET mime_type = 'application/x-unsupported' WHERE artifact_id = $1",
      [h.source.artifactId]
    );
    const response = await h.copy();
    expect(response.statusCode).toBe(415);
    expect(response.json()).toMatchObject({ error: "unsupported_media_type" });
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(
      await h.artifacts.listBySession(h.tenantId, h.project.referenceSessionId, h.userId)
    ).toEqual([]);
  }
);

test.skip(
  "scan completion supports previously persisted copy metadata",
  async () => {
    const h = await setup();
    // Literal JSON represents an existing database row, independent of the
    // current writer's constant. Renaming the persisted key must not strand it.
    await superuserPool().query(
      `UPDATE artifacts SET status = 'pending',
    detail_json = '{"projectId":"old-project","reusedFromArtifactId":"old-source"}'::jsonb
    WHERE artifact_id = $1`,
      [h.source.artifactId]
    );
    await h.artifacts.setPiiDetail(h.tenantId, h.source.artifactId, { status: "scanned" });
    expect((await h.artifacts.getOwned(h.tenantId, h.source.artifactId, h.userId))?.status).toBe(
      "ready"
    );
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

describe.skip("shared legacy project mutations", () => {
  test("editors create sessions, attach private sessions and copy/remove another member's source", async () => {
    const h = await setup();
    const editorId = await seedUser();
    await seedMembership(h.tenantId, editorId);
    const members = new ProjectMemberStore(appPool());
    await members.setMember({ tenantId: h.tenantId, userId: h.userId, projectId: h.project.projectId }, editorId, "editor");
    h.setAuth({ tenantId: h.tenantId, userId: editorId, role: "member", isAdmin: false });
    const url = `/projects/${h.project.projectId}/sessions`;
    expect((await h.app.inject({ method: "POST", url, payload: { name: "Editor session" } })).statusCode).toBe(201);
    const personal = await h.sessions.create(h.tenantId, editorId, "Personal");
    expect((await h.app.inject({ method: "PUT", url, payload: { sessionId: personal.sessionId, confirmAudience: true } })).statusCode).toBe(204);
    const copied = await h.copy();
    expect(copied.statusCode).toBe(201);
    expect(copied.json().artifact.userId).toBe(editorId);
    h.setAuth({ tenantId: h.tenantId, userId: h.userId, role: "member", isAdmin: false });
    expect((await h.app.inject({ method: "DELETE", url: `/projects/${h.project.projectId}/files/${copied.json().artifact.artifactId}` })).statusCode).toBe(204);
  });

  test.each(["demoted", "removed", "archived", "source_deleted", "source_blocked"] as const)(
    "rejects %s during copy and cleans up new bytes", async change => {
      const h = await setup();
      const actor = { tenantId: h.tenantId, userId: h.userId, projectId: h.project.projectId };
      const members = new ProjectMemberStore(appPool());
      const put = h.storage.put.bind(h.storage);
      let copiedKey = "";
      vi.spyOn(h.storage, "put").mockImplementationOnce(async input => {
        const stored = await put(input);
        copiedKey = stored.storageKey;
        if (change === "archived") await h.projects.setArchived(h.tenantId, h.userId, h.project.projectId, true);
        else if (change === "source_deleted") await h.artifacts.update(h.tenantId, h.source.artifactId, { status: "deleted" });
        else if (change === "source_blocked") await h.artifacts.setPiiDetail(h.tenantId, h.source.artifactId, { status: "blocked" });
        else await members.setMember(actor, h.userId, change === "removed" ? null : "viewer");
        return stored;
      });
      const response = await h.copy();
      expect(response.statusCode).toBe(change === "removed" ? 404 : change === "demoted" ? 403 : 409);
      expect(h.enqueue).not.toHaveBeenCalled();
      expect(copiedKey).not.toBe("");
      await expect(h.storage.openReadStream(copiedKey)).rejects.toThrow();
      const rows = await superuserPool().query("SELECT artifact_id FROM artifacts WHERE tenant_id=$1 AND source_artifact_id=$2", [h.tenantId, h.source.artifactId]);
      expect(rows.rowCount).toBe(0);
    },
  );

  test.each(["viewer", "removed", "archived"] as const)("reference creator cannot remove after %s", async change => {
    const h = await setup();
    const ref = (await h.copy()).json().artifact;
    if (change === "archived") await h.projects.setArchived(h.tenantId, h.userId, h.project.projectId, true);
    else await new ProjectMemberStore(appPool()).setMember({ tenantId: h.tenantId, userId: h.userId, projectId: h.project.projectId }, h.userId, change === "removed" ? null : "viewer");
    const response = await h.app.inject({ method: "DELETE", url: `/projects/${h.project.projectId}/files/${ref.artifactId}` });
    expect(response.statusCode).toBe(change === "removed" ? 404 : change === "viewer" ? 403 : 409);
    const row = await superuserPool().query("SELECT status FROM artifacts WHERE artifact_id=$1", [ref.artifactId]);
    expect(row.rows[0].status).toBe("ready");
  });
});
