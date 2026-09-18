import { test, expect, vi } from "vitest";
import { Readable } from "node:stream";

import { FakePool } from "../test-helpers/fake-pool.js";
import { createSilentLogger } from "../test-helpers/silent-logger.js";
import {
  MAX_PROJECT_FILE_SELECTIONS,
  MAX_PROJECT_RUNTIME_SNAPSHOT_FILES,
  ProjectFileError,
  ProjectFileStore,
  type ProjectFileActor,
  type ProjectRuntimeFileSnapshot,
} from "./project-file-store.js";

const actor: ProjectFileActor = {
  tenantId: "tenant-1",
  userId: "user-1",
  projectId: "project-1",
};

/**
 * `requireProjectAccess` runs before every store operation. Granting the role
 * here keeps each test focused on the logic under test; the access predicates
 * themselves are SQL and are covered by the Postgres integration suite.
 */
function grantAccess(pool: FakePool, role: "owner" | "editor" | "viewer" = "owner") {
  return pool
    .onQuery(/FROM projects WHERE tenant_id=\$1 AND project_id=\$2 FOR UPDATE/, () => ({
      rows: [{ project_id: actor.projectId }],
      rowCount: 1,
    }))
    .onQuery(/AS role\s+FROM projects p/, () => ({
      rows: [{ role, archived_at: null, visibility: "private", organization_role: "viewer" }],
      rowCount: 1,
    }));
}

/** One row of the `captureRuntimeSnapshot` join, with a controllable window count. */
function snapshotRow(fileId: string, overrides: Record<string, unknown> = {}) {
  return {
    file_id: fileId,
    version_id: `${fileId}-v1`,
    version_number: 1,
    folder_id: null,
    name: `${fileId}.md`,
    mime_type: "text/markdown",
    kind: "published",
    ...overrides,
  };
}

function storeWith(pool: FakePool) {
  return new ProjectFileStore(pool.asPool(), createSilentLogger());
}

test("cleanup leases project storage rows and records delete failures with backoff", async () => {
  const pool = new FakePool();
  let claimSql = "";
  let retryValues: unknown[] | undefined;
  pool
    .onQuery(/FROM project_files\s+WHERE kind/, () => ({ rows: [], rowCount: 0 }))
    .onQuery(/DELETE FROM project_file_storage_gc gc/, () => ({ rows: [], rowCount: 0 }))
    .onQuery("WITH candidates AS", (text) => {
      claimSql = text;
      return {
        rows: [{ tenant_id: "tenant-1", project_id: "project-1", storage_key: "project/key" }],
        rowCount: 1,
      };
    })
    .onQuery(/WHERE storage_key=\$1/, () => ({ rows: [], rowCount: 0 }))
    .onQuery(/UPDATE project_file_storage_gc\s+SET next_attempt_at/, (_text, values) => {
      retryValues = values;
      return { rows: [], rowCount: 1 };
    });

  const storage = {
    delete: vi.fn(async () => {
      throw new Error("bucket unavailable");
    }),
  };
  const result = await new ProjectFileStore(pool.asPool(), createSilentLogger()).cleanupExpired(storage);

  expect(result).toEqual({ deletedFiles: 0, deletedObjects: 0 });
  expect(storage.delete).toHaveBeenCalledWith("project/key");
  expect(claimSql).toContain("FOR UPDATE SKIP LOCKED");
  expect(claimSql).toContain("next_attempt_at <= NOW()");
  expect(retryValues).toEqual(["tenant-1", "project-1", "project/key", "bucket unavailable"]);
});

test("captureRuntimeSnapshot caps the selection list it sends to the query", async () => {
  const pool = grantAccess(new FakePool(), "viewer");
  let selectedParameter: string[] = [];
  pool.onQuery("total_count", (_text, values) => {
    selectedParameter = values[2] as string[];
    return { rows: [], rowCount: 0 };
  });

  // More selections than the cap allows, so an unbounded pass-through is visible.
  const requested = Array.from({ length: MAX_PROJECT_FILE_SELECTIONS + 12 }, (_, i) => `file-${i}`);
  await storeWith(pool).captureRuntimeSnapshot(actor, requested);

  expect(selectedParameter).toHaveLength(MAX_PROJECT_FILE_SELECTIONS);
  // The cap keeps the earliest selections rather than an arbitrary subset.
  expect(selectedParameter[0]).toBe("file-0");
  expect(selectedParameter).not.toContain(`file-${MAX_PROJECT_FILE_SELECTIONS}`);
});

test("captureRuntimeSnapshot removes duplicate selections before applying the cap", async () => {
  const pool = grantAccess(new FakePool(), "viewer");
  let selectedParameter: string[] = [];
  pool.onQuery("total_count", (_text, values) => {
    selectedParameter = values[2] as string[];
    return { rows: [], rowCount: 0 };
  });

  // Without dedupe, repeats would consume the budget and crowd out real ids.
  const repeated = Array.from({ length: MAX_PROJECT_FILE_SELECTIONS + 5 }, () => "file-same");
  await storeWith(pool).captureRuntimeSnapshot(actor, [...repeated, "file-other"]);

  expect(selectedParameter).toEqual(["file-same", "file-other"]);
});

test("captureRuntimeSnapshot bounds the row count it asks the database for", async () => {
  const pool = grantAccess(new FakePool(), "viewer");
  let limitParameter: unknown;
  pool.onQuery("total_count", (_text, values) => {
    limitParameter = values[3];
    return { rows: [], rowCount: 0 };
  });

  await storeWith(pool).captureRuntimeSnapshot(actor, []);

  // The limit is what stops a large project from loading unbounded rows into
  // the turn; asserting it here fails loudly if the LIMIT is ever dropped.
  expect(limitParameter).toBe(MAX_PROJECT_RUNTIME_SNAPSHOT_FILES);
});

test("captureRuntimeSnapshot reports truncated when the project holds more files than were returned", async () => {
  const pool = grantAccess(new FakePool(), "viewer");
  pool.onQuery("total_count", () => ({
    rows: [snapshotRow("file-a", { total_count: "9" }), snapshotRow("file-b", { total_count: "9" })],
    rowCount: 2,
  }));

  const snapshot = await storeWith(pool).captureRuntimeSnapshot(actor, []);

  expect(snapshot.files).toHaveLength(2);
  expect(snapshot.truncated).toBe(true);
});

test("captureRuntimeSnapshot reports not truncated when every file was returned", async () => {
  const pool = grantAccess(new FakePool(), "viewer");
  pool.onQuery("total_count", () => ({
    rows: [snapshotRow("file-a", { total_count: "2" }), snapshotRow("file-b", { total_count: "2" })],
    rowCount: 2,
  }));

  const snapshot = await storeWith(pool).captureRuntimeSnapshot(actor, []);

  expect(snapshot.truncated).toBe(false);
});

test("captureRuntimeSnapshot marks only the requested files as selected", async () => {
  const pool = grantAccess(new FakePool(), "viewer");
  pool.onQuery("total_count", () => ({
    rows: [
      snapshotRow("file-a", { total_count: "2" }),
      snapshotRow("file-b", { total_count: "2", kind: "draft" }),
    ],
    rowCount: 2,
  }));

  const snapshot = await storeWith(pool).captureRuntimeSnapshot(actor, ["file-b"]);

  expect(snapshot.files.map((entry) => [entry.fileId, entry.selected])).toEqual([
    ["file-a", false],
    ["file-b", true],
  ]);
  // An unselected draft must not be relabelled as published.
  expect(snapshot.files[1]?.kind).toBe("draft");
});

function pinnedSnapshot(overrides: Partial<ProjectRuntimeFileSnapshot> = {}): ProjectRuntimeFileSnapshot {
  return {
    projectId: actor.projectId,
    capturedAt: "2026-09-16T12:00:00.000Z",
    truncated: false,
    files: [
      {
        fileId: "file-a",
        versionId: "file-a-v1",
        versionNumber: 1,
        folderId: null,
        name: "README.md",
        mimeType: "text/markdown",
        kind: "published",
        selected: true,
      },
    ],
    ...overrides,
  };
}

test("readRuntimeSnapshotFile refuses a file the snapshot does not pin", async () => {
  const pool = grantAccess(new FakePool(), "viewer");
  const storage = { openReadStream: vi.fn() };

  await expect(
    storeWith(pool).readRuntimeSnapshotFile({
      actor,
      snapshot: pinnedSnapshot(),
      fileId: "file-never-captured",
      sessionId: "session-1",
      messageId: null,
      storage,
    }),
  ).rejects.toMatchObject({ code: "project_file_not_found", status: 404 });

  // The guard must reject before any storage read is attempted.
  expect(storage.openReadStream).not.toHaveBeenCalled();
});

test("readRuntimeSnapshotFile refuses a snapshot captured for a different project", async () => {
  const pool = grantAccess(new FakePool(), "viewer");
  const storage = { openReadStream: vi.fn() };

  // A snapshot from another project must not become a cross-project read,
  // even though the requested file id is genuinely present inside it.
  await expect(
    storeWith(pool).readRuntimeSnapshotFile({
      actor,
      snapshot: pinnedSnapshot({ projectId: "project-other" }),
      fileId: "file-a",
      sessionId: "session-1",
      messageId: null,
      storage,
    }),
  ).rejects.toBeInstanceOf(ProjectFileError);

  expect(storage.openReadStream).not.toHaveBeenCalled();
});

test("readRuntimeSnapshotFile reads the version the snapshot pinned, not the current one", async () => {
  const pool = grantAccess(new FakePool(), "viewer");
  let requestedVersion: unknown;
  pool
    .onQuery(/FROM project_files f JOIN project_file_versions v/, (_text, values) => {
      requestedVersion = values[3];
      return {
        rows: [
          {
            file_id: "file-a",
            version_id: "file-a-v1",
            version_number: 1,
            mime_type: "text/markdown",
            file_size_bytes: 12,
            checksum_sha256: "abc",
            created_by: "user-1",
            created_at: new Date("2026-09-16T12:00:00.000Z"),
            name: "README.md",
            storage_key: "tenant-1/file-a-v1",
          },
        ],
        rowCount: 1,
      };
    })
    .onQuery("INSERT INTO audit_events", () => ({ rows: [], rowCount: 1 }));

  const storage = { openReadStream: vi.fn(async () => "stream") };
  const result = await storeWith(pool).readRuntimeSnapshotFile({
    actor,
    snapshot: pinnedSnapshot(),
    fileId: "file-a",
    sessionId: "session-1",
    messageId: "message-1",
    storage: storage as never,
  });

  // Turn consistency: the pinned version is what gets read.
  expect(requestedVersion).toBe("file-a-v1");
  expect(storage.openReadStream).toHaveBeenCalledWith("tenant-1/file-a-v1");
  expect(result.name).toBe("README.md");
});

test("readRuntimeSnapshotFile records an audit event for the file the agent read", async () => {
  const pool = grantAccess(new FakePool(), "viewer");
  let auditPayload: Record<string, unknown> = {};
  pool
    .onQuery(/FROM project_files f JOIN project_file_versions v/, () => ({
      rows: [
        {
          file_id: "file-a",
          version_id: "file-a-v1",
          version_number: 1,
          mime_type: "text/markdown",
          file_size_bytes: 12,
          checksum_sha256: "abc",
          created_by: "user-1",
          created_at: new Date("2026-09-16T12:00:00.000Z"),
          name: "README.md",
          storage_key: "tenant-1/file-a-v1",
        },
      ],
      rowCount: 1,
    }))
    .onQuery("INSERT INTO audit_events", (_text, values) => {
      auditPayload = JSON.parse(String(values[3]));
      return { rows: [], rowCount: 1 };
    });

  await storeWith(pool).readRuntimeSnapshotFile({
    actor,
    snapshot: pinnedSnapshot(),
    fileId: "file-a",
    sessionId: "session-1",
    messageId: "message-1",
    storage: { openReadStream: vi.fn(async () => "stream") } as never,
  });

  // Agent file reads are audit evidence; losing the binding would break it.
  expect(auditPayload).toMatchObject({
    projectId: actor.projectId,
    fileId: "file-a",
    versionId: "file-a-v1",
    messageId: "message-1",
  });
});

function conflictRow(overrides: Record<string, unknown> = {}) {
  return {
    draft_file_id: "draft-a",
    draft_name: "README.md",
    draft_folder_id: null,
    target_file_id: "file-a",
    base_version_id: "file-a-v1",
    proposed_version_id: "draft-a-v1",
    proposed_mime_type: "text/markdown",
    proposed_storage_key: "draft-a/content",
    base_version_id_actual: "file-a-v1",
    base_version_number: 1,
    base_mime_type: "text/markdown",
    base_storage_key: "file-a-v1/content",
    latest_version_id: "file-a-v2",
    latest_version_number: 2,
    latest_mime_type: "text/markdown",
    latest_storage_key: "file-a-v2/content",
    ...overrides,
  };
}

test("readConflictContext reads base, latest, and proposed versions and audits the comparison", async () => {
  const pool = grantAccess(new FakePool(), "editor");
  let auditPayload: Record<string, unknown> = {};
  pool
    .onQuery(/FROM project_files draft/, () => ({ rows: [conflictRow()], rowCount: 1 }))
    .onQuery("INSERT INTO audit_events", (_text, values) => {
      auditPayload = JSON.parse(String(values[3]));
      return { rows: [], rowCount: 1 };
    });
  const storage = {
    openReadStream: vi.fn(async (key: string) => ({
      stream: Readable.from([{ "file-a-v1/content": "base", "file-a-v2/content": "latest", "draft-a/content": "proposed" }[key]]),
      fileSizeBytes: 1,
    })),
  };

  await expect(storeWith(pool).readConflictContext({
    actor,
    draftId: "draft-a",
    sessionId: "session-1",
    messageId: "message-1",
    storage,
  })).resolves.toEqual(expect.objectContaining({
    baseContent: "base",
    latestContent: "latest",
    proposedContent: "proposed",
    baseVersionId: "file-a-v1",
    latestVersionId: "file-a-v2",
  }));
  expect(storage.openReadStream).toHaveBeenCalledTimes(3);
  expect(auditPayload).toMatchObject({
    projectId: actor.projectId,
    draftId: "draft-a",
    purpose: "conflict_resolution",
    messageId: "message-1",
    versionIds: ["file-a-v1", "file-a-v2", "draft-a-v1"],
  });
});

test("readConflictMetadata returns fresh version metadata without opening content", async () => {
  const pool = grantAccess(new FakePool(), "editor");
  let auditCount = 0;
  pool
    .onQuery(/FROM project_files draft/, () => ({ rows: [conflictRow()], rowCount: 1 }))
    .onQuery("INSERT INTO audit_events", () => {
      auditCount += 1;
      return { rows: [], rowCount: 1 };
    });

  await expect(storeWith(pool).readConflictMetadata({
    actor,
    draftId: "draft-a",
    sessionId: "session-1",
    messageId: "message-1",
  })).resolves.toMatchObject({
    targetFileId: "file-a",
    latestVersionId: "file-a-v2",
    mimeType: "text/markdown",
  });
  expect(auditCount).toBe(1);
});

test("readConflictContext sends mismatched formats to manual recovery before reading bytes", async () => {
  const pool = grantAccess(new FakePool(), "editor");
  pool.onQuery(/FROM project_files draft/, () => ({
    rows: [conflictRow({ latest_mime_type: "application/pdf" })],
    rowCount: 1,
  }));
  const storage = { openReadStream: vi.fn() };

  await expect(storeWith(pool).readConflictContext({
    actor,
    draftId: "draft-a",
    sessionId: "session-1",
    messageId: null,
    storage: storage as never,
  })).rejects.toMatchObject({ code: "project_conflict_unsupported", status: 422 });
  expect(storage.openReadStream).not.toHaveBeenCalled();
});

test("readConflictContext rejects readable versions whose MIME subtypes differ", async () => {
  const pool = grantAccess(new FakePool(), "editor");
  pool.onQuery(/FROM project_files draft/, () => ({
    rows: [conflictRow({ base_mime_type: "text/markdown", proposed_mime_type: "text/plain" })],
    rowCount: 1,
  }));
  const storage = { openReadStream: vi.fn() };

  await expect(storeWith(pool).readConflictContext({
    actor,
    draftId: "draft-a",
    sessionId: "session-1",
    messageId: null,
    storage: storage as never,
  })).rejects.toMatchObject({ code: "project_conflict_unsupported", status: 422 });
  expect(storage.openReadStream).not.toHaveBeenCalled();
});

/** Minimal valid input for `createAgentDraftFromContent`, overridable per case. */
function draftInput(overrides: Record<string, unknown> = {}) {
  return {
    actor,
    name: "notes.md",
    folderId: null,
    targetFileId: null,
    baseVersionId: null,
    mimeType: "text/markdown",
    content: new TextEncoder().encode("hello"),
    storage: { put: vi.fn(), delete: vi.fn() } as never,
    maxBytes: 1_000,
    ...overrides,
  };
}

test("createAgentDraftFromContent rejects empty content", async () => {
  const store = storeWith(grantAccess(new FakePool()));

  await expect(
    store.createAgentDraftFromContent(draftInput({ content: new Uint8Array() })),
  ).rejects.toMatchObject({ code: "project_file_empty", status: 400 });
});

test("createAgentDraftFromContent rejects content over the caller's byte limit", async () => {
  const store = storeWith(grantAccess(new FakePool()));

  await expect(
    store.createAgentDraftFromContent(
      draftInput({ content: new Uint8Array(101), maxBytes: 100 }),
    ),
  ).rejects.toMatchObject({ code: "project_file_too_large", status: 413 });
});

test("createAgentDraftFromContent accepts content exactly at the byte limit", async () => {
  const pool = grantAccess(new FakePool());
  pool.onQuery("SELECT agent_file_mode FROM projects", () => ({
    rows: [{ agent_file_mode: "read-only" }],
    rowCount: 1,
  }));
  const store = storeWith(pool);

  // The boundary must not be off by one: a file of exactly maxBytes is legal,
  // so this reaches the later mode check rather than failing on size.
  await expect(
    store.createAgentDraftFromContent(
      draftInput({ content: new Uint8Array(100), maxBytes: 100 }),
    ),
  ).rejects.toMatchObject({ code: "project_agent_read_only" });
});

test("createAgentDraftFromContent rejects an update draft missing its base version", async () => {
  const store = storeWith(grantAccess(new FakePool()));

  await expect(
    store.createAgentDraftFromContent(
      draftInput({ targetFileId: "file-a", baseVersionId: null }),
    ),
  ).rejects.toMatchObject({ code: "project_base_missing", status: 400 });
});

test("createAgentDraftFromContent rejects a base version with no target file", async () => {
  const store = storeWith(grantAccess(new FakePool()));

  await expect(
    store.createAgentDraftFromContent(
      draftInput({ targetFileId: null, baseVersionId: "file-a-v1" }),
    ),
  ).rejects.toMatchObject({ code: "project_base_missing", status: 400 });
});

test("createAgentDraftFromContent rejects a MIME type outside the artifact allowlist", async () => {
  const store = storeWith(grantAccess(new FakePool()));

  await expect(
    store.createAgentDraftFromContent(
      draftInput({ mimeType: "application/x-msdownload" }),
    ),
  ).rejects.toMatchObject({ code: "unsupported_media_type", status: 415 });
});

test("createAgentDraftFromContent normalizes MIME parameters before the allowlist check", async () => {
  const pool = grantAccess(new FakePool());
  pool.onQuery("SELECT agent_file_mode FROM projects", () => ({
    rows: [{ agent_file_mode: "read-only" }],
    rowCount: 1,
  }));
  const store = storeWith(pool);

  // "text/markdown; charset=utf-8" is the allowed type with a parameter, so it
  // must pass the allowlist and fail later on mode instead.
  await expect(
    store.createAgentDraftFromContent(
      draftInput({ mimeType: "TEXT/Markdown; charset=utf-8" }),
    ),
  ).rejects.toMatchObject({ code: "project_agent_read_only" });
});

test("createAgentDraftFromContent refuses to write when the project is read-only for agents", async () => {
  const pool = grantAccess(new FakePool());
  const storage = { put: vi.fn(), delete: vi.fn() };
  pool.onQuery("SELECT agent_file_mode FROM projects", () => ({
    rows: [{ agent_file_mode: "read-only" }],
    rowCount: 1,
  }));

  await expect(
    storeWith(pool).createAgentDraftFromContent(
      draftInput({ storage: storage as never }),
    ),
  ).rejects.toMatchObject({ code: "project_agent_read_only" });

  // The mode check must precede storage work, not compensate afterwards.
  expect(storage.put).not.toHaveBeenCalled();
});

test("createAgentDraftFromContent defaults to read-only when the project row is absent", async () => {
  const pool = grantAccess(new FakePool());
  pool.onQuery("SELECT agent_file_mode FROM projects", () => ({ rows: [], rowCount: 0 }));

  // Fail closed: a missing mode must not be read as permission to write.
  await expect(
    storeWith(pool).createAgentDraftFromContent(draftInput()),
  ).rejects.toMatchObject({ code: "project_agent_read_only" });
});

test("createAgentDraftFromContent blocks an update to an existing file in create-only mode", async () => {
  const pool = grantAccess(new FakePool());
  const storage = { put: vi.fn(), delete: vi.fn() };
  pool.onQuery("SELECT agent_file_mode FROM projects", () => ({
    rows: [{ agent_file_mode: "create-only" }],
    rowCount: 1,
  }));

  await expect(
    storeWith(pool).createAgentDraftFromContent(
      draftInput({
        targetFileId: "file-a",
        baseVersionId: "file-a-v1",
        storage: storage as never,
      }),
    ),
  ).rejects.toMatchObject({ code: "project_agent_create_only" });

  expect(storage.put).not.toHaveBeenCalled();
});
