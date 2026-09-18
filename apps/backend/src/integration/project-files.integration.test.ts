import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, test, expect, onTestFinished, vi } from "vitest";
import { ProjectMemberStore } from "../services/project-member-store.js";
import { ProjectStore } from "../services/project-store.js";
import { SessionStore } from "../services/session-store.js";
import { ArtifactStore } from "../services/artifacts/artifact-store.js";
import { ProjectFileStore } from "../services/project-file-store.js";
import { LocalArtifactStorage } from "../services/artifacts/artifact-storage.js";
import { ArtifactProcessor } from "../services/artifacts/artifact-processor.js";
import { registerProjectFileRoutes } from "../routes/project-files.js";
import { createTestConfig } from "../test-helpers/test-config.js";
import { Pool, withTenantScope } from "../lib/db.js";
import {
  adminDatabaseUrl,
  runAppUserUrl,
  appPool,
  superuserPool,
} from "./support/database.js";
import { seedTenant, seedUser, seedMembership } from "./support/fixtures.js";
import type { ProjectFile } from "@cogniplane/shared-types";

async function setup() {
  const tenantId = await seedTenant(),
    userId = await seedUser();
  await seedMembership(tenantId, userId);
  const projects = new ProjectStore(appPool()),
    sessions = new SessionStore(appPool());
  const artifacts = new ArtifactStore(appPool());
  const project = await projects.create(tenantId, userId, "Library");
  const actor = { tenantId, userId, projectId: project.projectId };
  const root = await mkdtemp(join(tmpdir(), "project-versions-"));
  const storage = new LocalArtifactStorage(root);
  const app = Fastify();
  const files = new ProjectFileStore(appPool(), app.log);
  const config = createTestConfig();
  app.decorate("db", appPool());
  app.decorate("config", config);
  let auth = { tenantId, userId, role: "member" as const, isAdmin: false };
  app.addHook("preHandler", async (request) => {
    request.auth = auth;
  });
  const processor = new ArtifactProcessor({
    config,
    storage,
    logger: app.log,
    extractPdfText: async () => "Extracted PDF",
  });
  await registerProjectFileRoutes(app, {
    artifactStorage: storage,
    artifactProcessor: processor,
    limits: { consumeRateLimit: async () => null } as never,
  });
  onTestFinished(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  let count = 0;
  const source = async (text = "Original", mimeType = "text/plain") => {
    const stored = await storage.put({
      storageKey: `source/${count++}`,
      stream: Readable.from([text]),
    });
    return artifacts.create({
      tenantId,
      userId,
      sessionId: project.referenceSessionId,
      artifactType: "upload",
      artifactName: "Brief.txt",
      mimeType,
      status: "ready",
      createdByType: "user",
      ...stored,
    });
  };
  const add = async (
    options: Partial<{
      kind: "published" | "draft";
      name: string;
      folderId: string | null;
      target: ProjectFile;
      text: string;
    }> = {},
  ) => {
    const artifact = await source(options.text);
    return files.createFromArtifact(
      actor,
      {
        artifactId: artifact.artifactId,
        kind: options.kind ?? "published",
        name: options.name ?? "Brief.txt",
        folderId: options.folderId ?? null,
        targetFileId: options.target?.fileId ?? null,
        baseVersionId: options.target?.version.versionId ?? null,
      },
      storage,
      10000,
    );
  };
  const url = `/projects/${project.projectId}/library`;
  return {
    actor,
    project,
    projects,
    sessions,
    artifacts,
    files,
    storage,
    processor,
    app,
    source,
    add,
    url,
    setAuth: (next: typeof auth) => {
      auth = next;
    },
  };
}

describe.skipIf(!adminDatabaseUrl())("versioned project files", () => {
  test("shares versions and sources with members, denies viewer writes, and revokes access", async () => {
    const h = await setup();
    const members = new ProjectMemberStore(appPool());
    const viewerId = await seedUser(), editorId = await seedUser();
    await seedMembership(h.actor.tenantId, viewerId);
    await seedMembership(h.actor.tenantId, editorId);
    await members.setMember(h.actor, viewerId, "viewer");
    await members.setMember(h.actor, editorId, "editor");
    const viewer = { ...h.actor, userId: viewerId };
    const editor = { ...h.actor, userId: editorId };
    const file = await h.add();
    h.setAuth({ ...viewer, role: "member", isAdmin: false });
    expect((await h.app.inject(h.url)).statusCode).toBe(200);
    const contentUrl = `${h.url}/files/${file.fileId}/versions/${file.version.versionId}/content`;
    const content = await h.app.inject(contentUrl);
    expect(content.statusCode).toBe(200);
    expect(content.body).toBe("Original");
    expect(content.headers["cache-control"]).toBe("private, no-store");
    expect((await h.files.history(viewer, file.fileId))).toHaveLength(1);
    await expect(h.files.createFolder(viewer, "Denied", null)).rejects.toMatchObject({ status: 403 });
    expect((await h.app.inject({ method: "DELETE", url: `${h.url}/files/${file.fileId}` })).statusCode).toBe(403);
    const source = await h.source("Another member's source");
    const shared = await h.files.createFromArtifact(editor, {
      artifactId: source.artifactId, name: "Shared.txt", kind: "published", folderId: null,
      targetFileId: null, baseVersionId: null,
    }, h.storage, 10000);
    expect(shared.version.createdBy).toBe(editorId);
    await h.files.trash(editor, shared.fileId);
    await members.setMember(h.actor, viewerId, null);
    expect((await h.app.inject(contentUrl)).statusCode).toBe(404);
    await expect(h.files.history(viewer, file.fileId)).rejects.toMatchObject({ status: 404 });
    await members.setMember(h.actor, editorId, "viewer");
    await expect(h.files.createFolder(editor, "Denied", null)).rejects.toMatchObject({ status: 403 });
    await h.projects.setArchived(h.actor.tenantId, h.actor.userId, h.actor.projectId, true);
    expect((await h.files.content(editor, file.fileId, file.version.versionId)).mimeType).toBe("text/plain");
    await expect(h.files.trash(h.actor, file.fileId)).rejects.toMatchObject({ code: "project_archived" });
  });

  test.each(["unchanged", "deleted", "metadata", "bytes", "archived", "revoked", "downgraded"])(
    "releases the pool and project lock during copy, then revalidates %s source",
    async (change) => {
      const h = await setup();
      const artifact = await h.source();
      const pool = new Pool({
        connectionString: runAppUserUrl(),
        max: 1,
        connectionTimeoutMillis: 1000,
        statement_timeout: 1000,
      });
      const files = new ProjectFileStore(pool, h.app.log);
      let markEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        markEntered = resolve;
      });
      let releaseCopy!: () => void;
      const released = new Promise<void>((resolve) => {
        releaseCopy = resolve;
      });
      if (change === "bytes")
        vi.spyOn(h.storage, "openReadStream").mockResolvedValueOnce({
          stream: Readable.from(["Changed bytes"]),
          fileSizeBytes: artifact.fileSizeBytes,
        });
      const originalPut = h.storage.put.bind(h.storage);
      let copiedKey = "";
      vi.spyOn(h.storage, "put").mockImplementationOnce(async (input) => {
        copiedKey = input.storageKey;
        markEntered();
        await released;
        return originalPut(input);
      });
      const result = files
        .createFromArtifact(
          h.actor,
          {
            artifactId: artifact.artifactId,
            name: "Copy.txt",
            kind: "published",
            folderId: null,
            targetFileId: null,
            baseVersionId: null,
          },
          h.storage,
          10000,
        )
        .then(
          (value) => ({ value, error: null }),
          (error: unknown) => ({ value: null, error }),
        );
      try {
        await entered;
        // A one-connection pool catches a pinned connection as well as a held project lock.
        await files.createFolder(h.actor, "Concurrent folder", null);
        if (change === "deleted")
          await h.artifacts.update(h.actor.tenantId, artifact.artifactId, {
            status: "deleted",
          });
        if (change === "metadata")
          await superuserPool().query(
            "UPDATE artifacts SET mime_type='text/markdown' WHERE tenant_id=$1 AND artifact_id=$2",
            [h.actor.tenantId, artifact.artifactId],
          );
        if (change === "archived")
          await h.projects.setArchived(
            h.actor.tenantId,
            h.actor.userId,
            h.actor.projectId,
            true,
          );
        if (change === "revoked" || change === "downgraded") {
          const memberships = new ProjectMemberStore(appPool());
          await memberships.setMember(h.actor, h.actor.userId, change === "revoked" ? null : "viewer");
        }
        releaseCopy();
        const outcome = await result;
        if (change === "unchanged") {
          expect(outcome.error).toBeNull();
          expect(outcome.value?.name).toBe("Copy.txt");
        } else {
          expect(outcome.error).toMatchObject({
            code:
              change === "deleted"
                ? "project_source_unavailable"
                : change === "archived"
                  ? "project_archived"
                  : change === "revoked" ? "project_not_found"
                    : change === "downgraded" ? "project_role_required" : "project_source_changed",
          });
          const persisted = await superuserPool().query(
            "SELECT file_id FROM project_files WHERE tenant_id=$1 AND project_id=$2",
            [h.actor.tenantId, h.actor.projectId],
          );
          expect(persisted.rows).toHaveLength(0);
          await expect(
            h.storage.openReadStream(copiedKey),
          ).rejects.toMatchObject({ code: "ENOENT" });
        }
      } finally {
        releaseCopy();
        await result;
        await pool.end();
      }
    },
  );

  test("preserves the conflict response and logs failed orphan cleanup", async () => {
    const h = await setup();
    await h.add({ name: "Occupied.txt" });
    const source = await h.source();
    const cleanupError = new Error("Storage unavailable");
    vi.spyOn(h.storage, "delete").mockRejectedValueOnce(cleanupError);
    const warn = vi.spyOn(h.app.log, "warn");
    const response = await h.app.inject({
      method: "POST",
      url: `${h.url}/files`,
      payload: {
        artifactId: source.artifactId,
        name: "Occupied.txt",
        kind: "published",
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "project_path_occupied" });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: cleanupError,
        tenantId: h.actor.tenantId,
        projectId: h.actor.projectId,
        storageKey: expect.stringContaining("project-files/"),
      }),
      "Failed to remove an uncommitted project file copy",
    );
    expect((await h.files.list(h.actor)).files).toHaveLength(1);
  });

  test("direct store validation returns a client error before database work", async () => {
    const h = await setup();
    await expect(
      h.files.createFolder(h.actor, "../bad", null),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      h.files.renameFolder(h.actor, "missing", ""),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      h.files.relocate(h.actor, "missing", "bad/name", null),
    ).rejects.toMatchObject({ status: 400 });
  });

  test("preview failures provide readable messages", async () => {
    const h = await setup();
    const text = await h.add();
    const textResponse = await h.app.inject(
      `${h.url}/files/${text.fileId}/versions/${text.version.versionId}/preview-text`,
    );
    expect(textResponse.statusCode).toBe(422);
    expect(textResponse.json()).toMatchObject({
      error: "not_a_pdf",
      message: "Text preview is only available for PDF files.",
    });
    const source = await h.source("%PDF", "application/pdf");
    const pdf = await h.files.createFromArtifact(
      h.actor,
      {
        artifactId: source.artifactId,
        name: "Broken.pdf",
        kind: "published",
        folderId: null,
        targetFileId: null,
        baseVersionId: null,
      },
      h.storage,
      10000,
    );
    vi.spyOn(h.processor, "extractArtifactText").mockResolvedValueOnce(null);
    const response = await h.app.inject(
      `${h.url}/files/${pdf.fileId}/versions/${pdf.version.versionId}/preview-text`,
    );
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: "pdf_extraction_failed",
      message:
        "This PDF could not be previewed. Download it to view its contents.",
    });
  });

  test("stores independent bytes, survives source deletion, and serves authenticated downloads", async () => {
    const h = await setup();
    const source = await h.source();
    const response = await h.app.inject({
      method: "POST",
      url: `${h.url}/files`,
      payload: {
        artifactId: source.artifactId,
        name: "Brief.txt",
        kind: "published",
      },
    });
    expect(response.statusCode).toBe(201);
    const saved: ProjectFile = response.json();
    const content = await h.files.content(
      h.actor,
      saved.fileId,
      saved.version.versionId,
    );
    expect(content.storageKey).not.toBe(source.storageKey);
    await h.artifacts.update(h.actor.tenantId, source.artifactId, {
      status: "deleted",
    });
    await h.storage.delete(source.storageKey);
    const download = await h.app.inject(
      `${h.url}/files/${saved.fileId}/versions/${saved.version.versionId}/content`,
    );
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe("Original");
    expect(download.headers["cache-control"]).toBe("private, no-store");
    expect(download.headers["content-disposition"]).toContain("attachment;");
    expect(download.headers["x-content-type-options"]).toBe("nosniff");
    expect(JSON.stringify((await h.app.inject(h.url)).json())).not.toContain(
      "storageKey",
    );
  });
  test("isolates reads, writes, histories, downloads and PDF previews by current owner and tenant", async () => {
    const h = await setup(),
      saved = await h.add();
    for (const actor of [
      { ...h.actor, userId: await seedUser() },
      { ...h.actor, tenantId: await seedTenant() },
    ]) {
      h.setAuth({ ...actor, role: "member", isAdmin: false });
      expect((await h.app.inject(h.url)).statusCode).toBe(404);
      expect(
        (await h.app.inject(`${h.url}/files/${saved.fileId}/versions`))
          .statusCode,
      ).toBe(404);
      expect(
        (
          await h.app.inject(
            `${h.url}/files/${saved.fileId}/versions/${saved.version.versionId}/content`,
          )
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await h.app.inject(
            `${h.url}/files/${saved.fileId}/versions/${saved.version.versionId}/preview-text`,
          )
        ).statusCode,
      ).toBe(404);
      await expect(h.files.trash(actor, saved.fileId)).rejects.toMatchObject({
        status: 404,
      });
      await expect(
        h.files.createFolder(actor, "No access", null),
      ).rejects.toMatchObject({ status: 404 });
    }
    const otherTenant = await seedTenant();
    for (const table of [
      "project_files",
      "project_file_versions",
      "project_folders",
    ]) {
      const rows = await withTenantScope(appPool(), otherTenant, (db) =>
        db.query(`SELECT * FROM ${table} WHERE project_id=$1`, [
          h.actor.projectId,
        ]),
      );
      expect(rows.rows).toEqual([]);
    }
  });
  test("concurrent stale promotions preserve the losing draft and immutable history", async () => {
    const h = await setup(),
      initial = await h.add();
    const first = await h.add({
      kind: "draft",
      target: initial,
      text: "First",
    });
    const second = await h.add({
      kind: "draft",
      target: initial,
      text: "Second",
    });
    const results = await Promise.allSettled([
      h.files.promote(h.actor, first.fileId),
      new ProjectFileStore(appPool(), h.app.log).promote(
        h.actor,
        second.fileId,
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: { code: "project_version_conflict" } });
    const library = await h.files.list(h.actor);
    expect(
      library.files.filter((entry) => entry.kind === "draft"),
    ).toHaveLength(1);
    const published = library.files.find(
      (entry) => entry.kind === "published",
    )!;
    expect(published.fileId).toBe(initial.fileId);
    expect(published.version.versionNumber).toBe(2);
    expect(await h.files.history(h.actor, initial.fileId)).toHaveLength(2);
    await expect(
      withTenantScope(appPool(), h.actor.tenantId, (db) =>
        db.query(
          "UPDATE project_file_versions SET checksum_sha256='forged' WHERE file_id=$1",
          [initial.fileId],
        ),
      ),
    ).rejects.toThrow("immutable");
    const restored = await h.files.restoreVersion(
      h.actor,
      initial.fileId,
      initial.version.versionId,
      published.version.versionId,
    );
    expect(restored.version.versionNumber).toBe(3);
    expect(restored.version.checksumSha256).toBe(
      initial.version.checksumSha256,
    );
    expect(restored.version.restoredFromVersionId).toBe(
      initial.version.versionId,
    );
    expect(await h.files.history(h.actor, initial.fileId)).toHaveLength(3);
    await expect(
      h.files.restoreVersion(
        h.actor,
        initial.fileId,
        initial.version.versionId,
        published.version.versionId,
      ),
    ).rejects.toMatchObject({ code: "project_version_conflict" });
  });
  test("publishes new drafts only on promotion and allows manual recovery of a conflicting update", async () => {
    const h = await setup(),
      initial = await h.add();
    const draft = await h.add({
      kind: "draft",
      target: initial,
      text: "Proposal",
    });
    expect(
      (await h.files.list(h.actor)).files.filter(
        (entry) => entry.kind === "published",
      ),
    ).toEqual([initial]);
    await h.files.saveDraftAsNew(
      h.actor,
      draft.fileId,
      "Alternative.txt",
      null,
    );
    const alternative = await h.files.promote(h.actor, draft.fileId);
    expect(alternative.fileId).toBe(draft.fileId);
    expect(alternative.name).toBe("Alternative.txt");
    expect(
      (await h.files.list(h.actor)).files.filter(
        (entry) => entry.kind === "published",
      ),
    ).toHaveLength(2);
  });
  test("folder operations and file moves preserve identity and reject occupied or nonempty paths", async () => {
    const h = await setup();
    const folder = await h.files.createFolder(h.actor, "Research", null);
    await expect(
      h.files.createFolder(h.actor, "research", null),
    ).rejects.toMatchObject({ code: "project_path_occupied" });
    const child = await h.files.createFolder(h.actor, "Notes", folder.folderId);
    await expect(
      h.files.removeFolder(h.actor, folder.folderId),
    ).rejects.toMatchObject({ code: "project_folder_not_empty" });
    const saved = await h.add({ folderId: child.folderId });
    await expect(
      h.files.removeFolder(h.actor, child.folderId),
    ).rejects.toMatchObject({ code: "project_folder_not_empty" });
    await h.files.renameFolder(h.actor, folder.folderId, "Reference");
    await h.files.relocate(h.actor, saved.fileId, "Renamed.txt", null);
    const moved = (await h.files.list(h.actor)).files[0];
    expect(moved.version).toEqual(saved.version);
    expect(moved.folderId).toBeNull();
    await h.files.removeFolder(h.actor, child.folderId);
    await h.files.removeFolder(h.actor, folder.folderId);
    await expect(h.add({ folderId: child.folderId })).rejects.toMatchObject({
      code: "project_folder_missing",
    });
    await expect(
      h.files.createFolder(h.actor, "Renamed.txt", null),
    ).rejects.toMatchObject({ code: "project_path_occupied" });
  });
  test("Trash retains bytes and history, rejects restore collisions, and expires after 30 days", async () => {
    const h = await setup(),
      saved = await h.add();
    await h.files.trash(h.actor, saved.fileId);
    await h.files.trash(h.actor, saved.fileId);
    expect((await h.files.list(h.actor)).files[0].trashedAt).toBeTruthy();
    await expect(
      h.files.content(h.actor, saved.fileId, saved.version.versionId),
    ).rejects.toMatchObject({ status: 404 });
    await h.add();
    await expect(
      h.files.restoreTrash(h.actor, saved.fileId, saved.name, null),
    ).rejects.toMatchObject({ code: "project_path_occupied" });
    await h.files.restoreTrash(h.actor, saved.fileId, "Recovered.txt", null);
    expect(await h.files.history(h.actor, saved.fileId)).toHaveLength(1);
    await h.files.trash(h.actor, saved.fileId);
    await superuserPool().query(
      "UPDATE project_files SET trashed_at=NOW()-INTERVAL '31 days' WHERE file_id=$1",
      [saved.fileId],
    );
    await expect(
      h.files.restoreTrash(h.actor, saved.fileId, "Recovered.txt", null),
    ).rejects.toMatchObject({ code: "project_trash_expired" });
  });
  test("missing destinations require an explicit replacement when restoring a trashed draft", async () => {
    const h = await setup();
    const folder = await h.files.createFolder(h.actor, "Work", null);
    const draft = await h.add({ kind: "draft", folderId: folder.folderId });
    await h.files.trash(h.actor, draft.fileId);
    await h.files.removeFolder(h.actor, folder.folderId);
    await expect(
      h.files.restoreTrash(h.actor, draft.fileId, draft.name, folder.folderId),
    ).rejects.toMatchObject({ code: "project_folder_missing" });
    await h.files.restoreTrash(h.actor, draft.fileId, draft.name, null);
    expect((await h.files.promote(h.actor, draft.fileId)).kind).toBe(
      "published",
    );
  });
  test("archived projects remain readable but reject all file mutations", async () => {
    const h = await setup(),
      saved = await h.add(),
      draft = await h.add({ kind: "draft" });
    await h.projects.setArchived(
      h.actor.tenantId,
      h.actor.userId,
      h.actor.projectId,
      true,
    );
    expect((await h.files.list(h.actor)).files).toHaveLength(2);
    expect(
      (await h.files.content(h.actor, saved.fileId, saved.version.versionId))
        .fileId,
    ).toBe(saved.fileId);
    for (const operation of [
      () => h.files.promote(h.actor, draft.fileId),
      () => h.files.trash(h.actor, saved.fileId),
      () => h.files.relocate(h.actor, saved.fileId, "Other", null),
      () => h.files.createFolder(h.actor, "No", null),
      () =>
        h.files.restoreVersion(
          h.actor,
          saved.fileId,
          saved.version.versionId,
          saved.version.versionId,
        ),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        code: "project_archived",
      });
    }
  });
  test("rejects unavailable and oversized source files", async () => {
    const h = await setup();
    for (const status of ["pending", "failed", "deleted"] as const) {
      const source = await h.source();
      await h.artifacts.update(h.actor.tenantId, source.artifactId, { status });
      const response = await h.app.inject({
        method: "POST",
        url: `${h.url}/files`,
        payload: {
          artifactId: source.artifactId,
          name: "No.txt",
          kind: "published",
        },
      });
      expect(response.statusCode).toBe(404);
    }
    const blocked = await h.source();
    await h.artifacts.setPiiDetail(h.actor.tenantId, blocked.artifactId, {
      status: "blocked",
    });
    const input = {
      artifactId: blocked.artifactId,
      name: "No.txt",
      kind: "draft" as const,
      folderId: null,
      targetFileId: null,
      baseVersionId: null,
    };
    await expect(
      h.files.createFromArtifact(h.actor, input, h.storage, 100),
    ).rejects.toMatchObject({ code: "project_source_unavailable" });
    const huge = await h.source("a".repeat(101));
    await expect(
      h.files.createFromArtifact(
        h.actor,
        { ...input, artifactId: huge.artifactId },
        h.storage,
        100,
      ),
    ).rejects.toMatchObject({ status: 413 });
    expect((await h.files.list(h.actor)).files).toHaveLength(0);
  });
  test("published discovery excludes drafts and Trash, and moved targets require a destination review", async () => {
    const h = await setup();
    const initial = await h.add();
    const draft = await h.add({ kind: "draft", target: initial });
    const removed = await h.add({ name: "Removed.txt" });
    await h.files.trash(h.actor, removed.fileId);
    expect(
      (await h.files.listPublished(h.actor)).map((file) => file.fileId),
    ).toEqual([initial.fileId]);
    const folder = await h.files.createFolder(h.actor, "Moved", null);
    await h.files.relocate(
      h.actor,
      initial.fileId,
      initial.name,
      folder.folderId,
    );
    await expect(h.files.promote(h.actor, draft.fileId)).rejects.toMatchObject({
      code: "project_destination_changed",
    });
    await h.files.relocate(
      h.actor,
      draft.fileId,
      initial.name,
      folder.folderId,
    );
    expect(
      (await h.files.promote(h.actor, draft.fileId)).version.versionNumber,
    ).toBe(2);
  });

  test("captures stable agent snapshots, audits reads, and enforces agent file modes", async () => {
    const h = await setup();
    const published = await h.add({ text: "Original" });
    const pendingUpdate = await h.add({
      kind: "draft",
      target: published,
      text: "Proposed update",
    });
    const defaultSnapshot = await h.files.captureRuntimeSnapshot(h.actor);
    expect(defaultSnapshot.files.map((entry) => entry.fileId)).toEqual([
      published.fileId,
    ]);
    const selectedSnapshot = await h.files.captureRuntimeSnapshot(h.actor, [
      pendingUpdate.fileId,
    ]);
    expect(selectedSnapshot.files.map((entry) => entry.fileId)).toContain(
      pendingUpdate.fileId,
    );

    const current = await h.files.promote(h.actor, pendingUpdate.fileId);
    const postPromotionSelection = await h.files.captureRuntimeSnapshot(h.actor, [
      pendingUpdate.fileId,
    ]);
    expect(postPromotionSelection.files.map((entry) => entry.fileId)).toEqual([
      published.fileId,
    ]);
    const historical = await h.files.readRuntimeSnapshotFile({
      actor: h.actor,
      snapshot: defaultSnapshot,
      fileId: published.fileId,
      sessionId: h.project.referenceSessionId,
      messageId: null,
      storage: h.storage,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of historical.stream.stream)
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("Original");
    expect(historical.versionId).toBe(published.version.versionId);
    expect(current.version.versionId).not.toBe(historical.versionId);
    const reads = await withTenantScope(appPool(), h.actor.tenantId, (db) =>
      db.query(
        `SELECT payload FROM audit_events
         WHERE tenant_id=$1 AND event_type='project_file_read' AND payload->>'fileId'=$2`,
        [h.actor.tenantId, published.fileId],
      ),
    );
    expect(reads.rows).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          projectId: h.actor.projectId,
          versionId: published.version.versionId,
        }),
      }),
    ]);

    const content = new TextEncoder().encode("agent draft");
    await expect(
      h.files.createAgentDraftFromContent({
        actor: h.actor,
        name: "Empty.txt",
        folderId: null,
        targetFileId: null,
        baseVersionId: null,
        mimeType: "text/plain",
        content: new Uint8Array(),
        storage: h.storage,
        maxBytes: 10000,
      }),
    ).rejects.toMatchObject({ code: "project_file_empty", status: 400 });

    await expect(
      h.files.createAgentDraftFromContent({
        actor: h.actor,
        name: "Agent.txt",
        folderId: null,
        targetFileId: null,
        baseVersionId: null,
        mimeType: "text/plain",
        content,
        storage: h.storage,
        maxBytes: 10000,
      }),
    ).rejects.toMatchObject({ code: "project_agent_read_only" });

    await h.projects.setAgentFileMode(
      h.actor.tenantId,
      h.actor.userId,
      h.actor.projectId,
      "create-only",
    );
    const created = await h.files.createAgentDraftFromContent({
      actor: h.actor,
      name: "Agent.txt",
      folderId: null,
      targetFileId: null,
      baseVersionId: null,
      mimeType: "text/plain",
      content,
      storage: h.storage,
      maxBytes: 10000,
    });
    expect(created.kind).toBe("draft");
    await expect(
      h.files.createAgentDraftFromContent({
        actor: h.actor,
        name: current.name,
        folderId: current.folderId,
        targetFileId: current.fileId,
        baseVersionId: current.version.versionId,
        mimeType: current.version.mimeType,
        content,
        storage: h.storage,
        maxBytes: 10000,
      }),
    ).rejects.toMatchObject({ code: "project_agent_create_only" });

    await h.projects.setAgentFileMode(
      h.actor.tenantId,
      h.actor.userId,
      h.actor.projectId,
      "read-write",
    );
    const replacement = await h.files.createAgentDraftFromContent({
      actor: h.actor,
      name: current.name,
      folderId: current.folderId,
      targetFileId: current.fileId,
      baseVersionId: current.version.versionId,
      mimeType: current.version.mimeType,
      content,
      storage: h.storage,
      maxBytes: 10000,
    });
    expect(replacement.targetFileId).toBe(current.fileId);
    expect(replacement.baseVersionId).toBe(current.version.versionId);
  });

  test("reconciles a text conflict against the latest version without changing the original draft", async () => {
    const h = await setup();
    const published = await h.add({ text: "Original" });
    const originalDraft = await h.add({ kind: "draft", target: published, text: "Proposed" });
    const latestDraft = await h.add({ kind: "draft", target: published, text: "Latest" });
    const latest = await h.files.promote(h.actor, latestDraft.fileId);

    const conflict = await h.files.readConflictContext({
      actor: h.actor,
      draftId: originalDraft.fileId,
      sessionId: h.project.referenceSessionId,
      messageId: "conflict-message",
      storage: h.storage,
    });
    expect(conflict).toMatchObject({
      baseContent: "Original",
      latestContent: "Latest",
      proposedContent: "Proposed",
      baseVersionId: published.version.versionId,
      latestVersionId: latest.version.versionId,
    });

    await h.projects.setAgentFileMode(
      h.actor.tenantId,
      h.actor.userId,
      h.actor.projectId,
      "read-write",
    );

    const reconciled = await h.files.createAgentDraftFromContent({
      actor: h.actor,
      name: conflict.name,
      folderId: conflict.folderId,
      targetFileId: conflict.targetFileId,
      baseVersionId: conflict.latestVersionId,
      mimeType: conflict.mimeType,
      content: new TextEncoder().encode("Latest plus proposed"),
      storage: h.storage,
      maxBytes: 10_000,
      createdByType: "agent",
    });
    expect(reconciled.targetFileId).toBe(published.fileId);
    expect(reconciled.baseVersionId).toBe(latest.version.versionId);
    expect(reconciled.fileId).not.toBe(originalDraft.fileId);
    expect((await h.files.list(h.actor)).files.find((file) => file.fileId === originalDraft.fileId)?.version.versionId)
      .toBe(originalDraft.version.versionId);
  });

  test("agent drafts enforce the MIME allow-list and PII blocking gate", async () => {
    const h = await setup();
    const evaluateArtifact = vi.fn().mockResolvedValue({
      action: "block",
      findings: [],
      blockReason: "email",
      providerType: null,
      providerModel: null
    });
    h.files.setPiiProtection({ evaluateArtifact });
    const input = {
      actor: h.actor,
      name: "Agent.txt",
      folderId: null,
      targetFileId: null,
      baseVersionId: null,
      content: new TextEncoder().encode("secret@example.com"),
      storage: h.storage,
      maxBytes: 10000
    };

    await expect(h.files.createAgentDraftFromContent({
      ...input,
      mimeType: "application/octet-stream"
    })).rejects.toMatchObject({ code: "unsupported_media_type", status: 415 });
    expect(evaluateArtifact).not.toHaveBeenCalled();

    await h.projects.setAgentFileMode(
      h.actor.tenantId,
      h.actor.userId,
      h.actor.projectId,
      "read-write",
    );
    await expect(h.files.createAgentDraftFromContent({
      ...input,
      mimeType: "text/plain"
    })).rejects.toMatchObject({ code: "pii_block", status: 422 });
    expect(evaluateArtifact).toHaveBeenCalledOnce();
  });

  test("PDF preview uses the existing text extractor and version identity", async () => {
    const h = await setup(),
      source = await h.source("%PDF", "application/pdf");
    const response = await h.app.inject({
      method: "POST",
      url: `${h.url}/files`,
      payload: {
        artifactId: source.artifactId,
        name: "Brief.pdf",
        kind: "published",
      },
    });
    const saved = response.json();
    expect(
      (
        await h.app.inject(
          `${h.url}/files/${saved.fileId}/versions/${saved.version.versionId}/preview-text`,
        )
      ).json(),
    ).toEqual({ text: "Extracted PDF" });
  });
});
