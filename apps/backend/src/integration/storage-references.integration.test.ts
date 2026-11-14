// Stored objects and the database rows that point to them (issue #117).
//
// - The catalog test fails for a column that names a stored object and that
//   STORAGE_LOCATOR_COLUMNS does not classify, so a new table cannot be
//   ignored by the reference checks and by tenant deletion.
// - Tenant deletion must take every tenant locator of the registry.
// - The queue drain keeps an object that a live row of any tenant uses, and
//   deletes it when only queue rows, deleted rows or released rows name it.
// - A queue row and the database change that queued it commit together.

import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";

import { ArtifactStore } from "../services/artifacts/artifact-store.js";
import { ProjectStore } from "../services/project-store.js";
import { SkillConfigStore } from "../services/skills/skill-config-store.js";
import { SkillRevisionStore } from "../services/skills/skill-revision-store.js";
import { StorageGc } from "../services/storage/storage-gc.js";
import { STORAGE_LOCATOR_COLUMNS, type StorageLocatorColumn } from "../services/storage/storage-references.js";
import { TenantDeletionService } from "../services/tenant-deletion-service.js";
import { adminDatabaseUrl, appPool, maintenancePool, superuserPool } from "./support/database.js";
import { seedArtifact, seedTenantGraph, type TenantFixture } from "./support/fixtures.js";

const LOCATOR_COLUMN = "(^|_)storage_(key|uri)$";

function storageGc(deleted: string[], options: { failing?: Set<string> } = {}) {
  const remove = async (locator: string) => {
    if (options.failing?.has(locator)) throw new Error("bucket unavailable");
    deleted.push(locator);
  };
  return new StorageGc({
    maintenanceDb: maintenancePool(),
    artifactStorage: { delete: remove },
    skillBundleStorage: { deleteBundle: remove }
  });
}

async function makeDue(table: string, tenantIds: string[]) {
  await superuserPool().query(`UPDATE ${table} SET next_attempt_at = NOW() WHERE tenant_id = ANY($1::text[])`, [tenantIds]);
}

async function queued(table: "session_storage_gc" | "skill_bundle_storage_gc" | "project_file_storage_gc", tenantId: string) {
  const column = table === "skill_bundle_storage_gc" ? "storage_uri" : "storage_key";
  return (await superuserPool().query<{ locator: string }>(
    `SELECT ${column} AS locator FROM ${table} WHERE tenant_id = $1 ORDER BY 1`, [tenantId]
  )).rows.map((row) => row.locator);
}

async function seedProject(fixture: TenantFixture): Promise<string> {
  return (await new ProjectStore(appPool()).create(fixture.tenantId, fixture.userId, `Storage ${randomUUID()}`)).projectId;
}

async function seedProjectFileVersion(fixture: TenantFixture, projectId: string, storageKey: string): Promise<void> {
  const client = await superuserPool().connect();
  try {
    await client.query("BEGIN");
    const fileId = randomUUID();
    await client.query(
      `INSERT INTO project_files (tenant_id, project_id, file_id, name, kind, current_version_id, created_by)
       VALUES ($1, $2, $3, $4, 'draft', 'v1', $5)`,
      [fixture.tenantId, projectId, fileId, `file-${fileId}.txt`, fixture.userId]
    );
    await client.query(
      `INSERT INTO project_file_versions (tenant_id, project_id, file_id, version_id, version_number,
         storage_backend, storage_key, mime_type, file_size_bytes, checksum_sha256, created_by)
       VALUES ($1, $2, $3, 'v1', 1, 'local', $4, 'text/plain', 1, 'sum', $5)`,
      [fixture.tenantId, projectId, fileId, storageKey, fixture.userId]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function seedSkillRevision(fixture: TenantFixture, storageUri: string): Promise<void> {
  const skillId = `storage-${randomUUID()}`;
  await superuserPool().query(
    "INSERT INTO admin_skills (tenant_id, skill_id, skill_name, created_by) VALUES ($1, $2, $2, $3)",
    [fixture.tenantId, skillId, fixture.userId]
  );
  await superuserPool().query(
    `INSERT INTO admin_skill_revisions (tenant_id, skill_id, revision_number, source_type, bundle_hash, created_by, bundle_storage_uri)
     VALUES ($1, $2, 1, 'upload', 'hash', $3, $4)`,
    [fixture.tenantId, skillId, fixture.userId, storageUri]
  );
}

const key = (column: Pick<StorageLocatorColumn, "table" | "column">) => `${column.table}.${column.column}`;

/**
 * Writes one row of a registry column for the tenant and returns its locator.
 * Tenant deletion must queue each one. A new tenant column of the registry
 * needs an entry here.
 */
const TENANT_LOCATOR_SEEDERS: Record<string, (fixture: TenantFixture) => Promise<string>> = {
  "artifacts.storage_key": async (fixture) => {
    const artifactId = await seedArtifact(fixture.tenantId, fixture.userId, fixture.sessionId);
    return `${fixture.tenantId}/${artifactId}`;
  },
  "project_file_versions.storage_key": async (fixture) => {
    const storageKey = `${fixture.tenantId}/version/${randomUUID()}`;
    await seedProjectFileVersion(fixture, await seedProject(fixture), storageKey);
    return storageKey;
  },
  "session_storage_gc.storage_key": async (fixture) => {
    const storageKey = `${fixture.tenantId}/session-queue/${randomUUID()}`;
    await superuserPool().query(
      "INSERT INTO session_storage_gc (tenant_id, session_id, storage_key) VALUES ($1, $2, $3)",
      [fixture.tenantId, "purged-session", storageKey]
    );
    return storageKey;
  },
  "project_file_storage_gc.storage_key": async (fixture) => {
    const storageKey = `${fixture.tenantId}/project-queue/${randomUUID()}`;
    await superuserPool().query(
      "INSERT INTO project_file_storage_gc (tenant_id, project_id, storage_key) VALUES ($1, $2, $3)",
      [fixture.tenantId, await seedProject(fixture), storageKey]
    );
    return storageKey;
  },
  "admin_skill_revisions.bundle_storage_uri": async (fixture) => {
    const storageUri = `file:///storage-references/${fixture.tenantId}/${randomUUID()}`;
    await seedSkillRevision(fixture, storageUri);
    return storageUri;
  },
  "skill_bundle_storage_gc.storage_uri": async (fixture) => {
    const storageUri = `file:///storage-references/${fixture.tenantId}/queued-${randomUUID()}`;
    await superuserPool().query(
      "INSERT INTO skill_bundle_storage_gc (tenant_id, storage_uri) VALUES ($1, $2)",
      [fixture.tenantId, storageUri]
    );
    return storageUri;
  }
};

describe.skipIf(!adminDatabaseUrl())("storage locator registry", () => {
  test("every column that names a stored object has a classification, and every entry exists", async () => {
    const { rows } = await superuserPool().query<{ table: string; column: string }>(
      `SELECT c.table_name AS table, c.column_name AS column
       FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.column_name ~ $1
       ORDER BY 1, 2`,
      [LOCATOR_COLUMN]
    );
    const catalog = rows.map(key);
    const registry = STORAGE_LOCATOR_COLUMNS.map(key);
    expect(
      catalog.filter((column) => !registry.includes(column)),
      "A column stores an object key or a bundle URI, but STORAGE_LOCATOR_COLUMNS " +
        "(services/storage/storage-references.ts) does not classify it. Add it as live, derived or queue, " +
        "add it to the reference check when it is live, and queue it in tenant deletion."
    ).toEqual([]);

    const existing = await superuserPool().query<{ table: string; column: string }>(
      `SELECT table_name AS table, column_name AS column FROM information_schema.columns
       WHERE table_schema = 'public'`
    );
    const columns = new Set(existing.rows.map(key));
    expect(registry.filter((column) => !columns.has(column)), "A registry entry names a column that is gone.").toEqual([]);
  });

  test("tenant deletion takes every tenant locator of the registry", async () => {
    const fixture = await seedTenantGraph();
    const tenantColumns = STORAGE_LOCATOR_COLUMNS.filter((column) => column.role !== "derived" &&
      column.table !== "tenant_deletion_cleanup");
    expect(
      tenantColumns.map(key).filter((column) => !(column in TENANT_LOCATOR_SEEDERS)),
      "A registry column has no seeder in this test."
    ).toEqual([]);
    const seeded: string[] = [];
    for (const column of tenantColumns) seeded.push(await TENANT_LOCATOR_SEEDERS[key(column)]!(fixture));

    const deleted: string[] = [];
    const service = new TenantDeletionService({
      db: superuserPool(),
      artifactStorage: { delete: async (locator) => { deleted.push(locator); } },
      skillBundleStorage: { deleteBundle: async (locator) => { deleted.push(locator); } },
      purgeRuntimeThread: async () => undefined
    });
    const receipt = await service.execute({
      requestId: `STORAGE-REGISTRY-${randomUUID()}`,
      tenantId: fixture.tenantId,
      redisDisposition: "Not used.",
      thirdPartyDisposition: "Not used.",
      backupDisposition: "Not used."
    });

    expect(receipt.status).toBe("completed");
    // The fixture's own rows (its artifact) are deleted too.
    expect(deleted).toEqual(expect.arrayContaining(seeded));
  });
});

describe.skipIf(!adminDatabaseUrl())("storage queue drain", () => {
  test("keeps an object that a live row of another tenant uses, and deletes objects that only dead rows name", async () => {
    const owner = await seedTenantGraph();
    const other = await seedTenantGraph();
    const shared = `shared/${randomUUID()}`;
    const unreferenced = `unreferenced/${randomUUID()}`;
    const deletedOnly = `deleted-artifact/${randomUUID()}`;
    const releasedOnly = `released-artifact/${randomUUID()}`;
    const versionShared = `version/${randomUUID()}`;
    // Live: an artifact and a project file version of the other tenant.
    await superuserPool().query("UPDATE artifacts SET storage_key = $2 WHERE artifact_id = $1", [other.artifactId, shared]);
    await seedProjectFileVersion(other, await seedProject(other), versionShared);
    // Not live: an artifact with status 'deleted', and one that a PII rejection released.
    const deletedArtifact = await seedArtifact(other.tenantId, other.userId, other.sessionId);
    const releasedArtifact = await seedArtifact(other.tenantId, other.userId, other.sessionId);
    await superuserPool().query(
      "UPDATE artifacts SET storage_key = $2, status = 'deleted' WHERE artifact_id = $1", [deletedArtifact, deletedOnly]);
    await superuserPool().query(
      "UPDATE artifacts SET storage_key = $2, storage_released_at = NOW() WHERE artifact_id = $1", [releasedArtifact, releasedOnly]);
    for (const storageKey of [shared, unreferenced, deletedOnly, releasedOnly, versionShared]) {
      await superuserPool().query(
        "INSERT INTO session_storage_gc (tenant_id, session_id, storage_key) VALUES ($1, 'purged', $2)",
        [owner.tenantId, storageKey]);
    }

    const deleted: string[] = [];
    await storageGc(deleted).drain(10_000);

    // The drain reads every tenant, so rows that earlier files left can be in it too.
    expect(deleted).toEqual(expect.arrayContaining([deletedOnly, releasedOnly, unreferenced]));
    expect(deleted).not.toContain(shared);
    expect(deleted).not.toContain(versionShared);
    expect(await queued("session_storage_gc", owner.tenantId)).toEqual([]);
  });

  test("two queues that hold the same key do not keep each other, and both rows go", async () => {
    const first = await seedTenantGraph();
    const second = await seedTenantGraph();
    const storageKey = `twice-queued/${randomUUID()}`;
    const bundle = `file:///storage-references/twice-${randomUUID()}`;
    await superuserPool().query(
      "INSERT INTO session_storage_gc (tenant_id, session_id, storage_key) VALUES ($1, 'purged', $2)", [first.tenantId, storageKey]);
    await superuserPool().query(
      "INSERT INTO project_file_storage_gc (tenant_id, project_id, storage_key) VALUES ($1, $2, $3)",
      [second.tenantId, await seedProject(second), storageKey]);
    for (const tenantId of [first.tenantId, second.tenantId]) {
      await superuserPool().query(
        "INSERT INTO skill_bundle_storage_gc (tenant_id, storage_uri) VALUES ($1, $2)", [tenantId, bundle]);
    }

    const deleted: string[] = [];
    await storageGc(deleted).drain(10_000);

    expect(deleted.filter((locator) => locator === storageKey).length).toBeGreaterThanOrEqual(1);
    expect(deleted.filter((locator) => locator === bundle).length).toBeGreaterThanOrEqual(1);
    for (const tenantId of [first.tenantId, second.tenantId]) {
      expect(await queued("session_storage_gc", tenantId)).toEqual([]);
      expect(await queued("project_file_storage_gc", tenantId)).toEqual([]);
      expect(await queued("skill_bundle_storage_gc", tenantId)).toEqual([]);
    }
  });

  test("a failed delete keeps the row with a backoff, and a later pass deletes it", async () => {
    const fixture = await seedTenantGraph();
    const storageKey = `flaky/${randomUUID()}`;
    await superuserPool().query(
      "INSERT INTO session_storage_gc (tenant_id, session_id, storage_key) VALUES ($1, 'purged', $2)",
      [fixture.tenantId, storageKey]);
    const failing = new Set([storageKey]);
    const deleted: string[] = [];

    const first = await storageGc(deleted, { failing }).drain(10_000);
    expect(first.pending).toBeGreaterThanOrEqual(1);
    const row = await superuserPool().query<{ attempts: number; last_error: string; due: boolean }>(
      `SELECT attempts, last_error, next_attempt_at <= NOW() AS due FROM session_storage_gc
       WHERE tenant_id = $1 AND storage_key = $2`, [fixture.tenantId, storageKey]);
    expect(row.rows).toEqual([{ attempts: 1, last_error: "bucket unavailable", due: false }]);

    failing.clear();
    await makeDue("session_storage_gc", [fixture.tenantId]);
    await storageGc(deleted).drain(10_000);
    expect(deleted).toContain(storageKey);
    expect(await queued("session_storage_gc", fixture.tenantId)).toEqual([]);
  });
});

describe.skipIf(!adminDatabaseUrl())("a queue row commits with the change that queues it", () => {
  async function withFailingInsert<T>(table: string, column: string, locator: string, run: () => Promise<T>): Promise<T> {
    const name = `fail_${randomUUID().replaceAll("-", "")}`;
    await superuserPool().query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.${column} = '${locator.replaceAll("'", "''")}' THEN RAISE EXCEPTION 'injected queue failure'; END IF;
        RETURN NEW;
      END $$`);
    await superuserPool().query(
      `CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    try {
      return await run();
    } finally {
      await superuserPool().query(`DROP TRIGGER ${name} ON ${table}`);
      await superuserPool().query(`DROP FUNCTION ${name}()`);
    }
  }

  test("a failed bundle queue insert rolls back the revision delete", async () => {
    const fixture = await seedTenantGraph();
    const revisions = new SkillRevisionStore(appPool(), new SkillConfigStore(appPool()));
    const skillId = `rollback-${randomUUID()}`;
    const storageUri = `file:///storage-references/rollback-${randomUUID()}`;
    const imported = await revisions.importSkillBundle(fixture.tenantId, {
      skillId, skillName: skillId, description: "Rollback", instructions: "Unused.", sourceType: "zip",
      sourceLabel: "rollback", bundleName: skillId, bundleHash: "e".repeat(64), validationStatus: "validated",
      validationMessages: [], metadata: {}, createdBy: fixture.userId, storeBundle: async () => ({ storageUri })
    });

    await withFailingInsert("skill_bundle_storage_gc", "storage_uri", storageUri, () =>
      expect(revisions.deleteSkillRevision(fixture.tenantId, skillId, imported.revision.skillRevisionId))
        .rejects.toThrow("injected queue failure"));

    expect((await superuserPool().query("SELECT 1 FROM admin_skill_revisions WHERE skill_revision_id = $1",
      [imported.revision.skillRevisionId])).rowCount).toBe(1);
    expect(await queued("skill_bundle_storage_gc", fixture.tenantId)).toEqual([]);

    // Without the fault, the delete and its queue row commit together.
    await expect(revisions.deleteSkillRevision(fixture.tenantId, skillId, imported.revision.skillRevisionId))
      .resolves.toMatchObject({ bundleStorageUri: storageUri });
    expect(await queued("skill_bundle_storage_gc", fixture.tenantId)).toEqual([storageUri]);
  });

  test("a failed object queue insert rolls back the PII rejection, and the artifact keeps its object", async () => {
    const fixture = await seedTenantGraph();
    const artifacts = new ArtifactStore(appPool());
    const storageKey = `${fixture.tenantId}/${fixture.artifactId}`;
    const blocked = { status: "blocked" as const, modeApplied: "block" as const, blockReason: "email" };

    await withFailingInsert("session_storage_gc", "storage_key", storageKey, () =>
      expect(artifacts.rejectStoredObject(fixture.tenantId, fixture.artifactId, { pii: blocked }))
        .rejects.toThrow("injected queue failure"));

    const state = async () => (await superuserPool().query<{ pii: unknown; released: boolean }>(
      `SELECT detail_json->'pii' AS pii, storage_released_at IS NOT NULL AS released FROM artifacts
       WHERE tenant_id = $1 AND artifact_id = $2`, [fixture.tenantId, fixture.artifactId])).rows[0];
    expect(await state()).toEqual({ pii: null, released: false });
    expect(await queued("session_storage_gc", fixture.tenantId)).toEqual([]);

    await expect(artifacts.rejectStoredObject(fixture.tenantId, fixture.artifactId, { pii: blocked }))
      .resolves.toEqual({ sessionId: fixture.sessionId, storageKey });
    expect(await state()).toEqual({ pii: blocked, released: true });
    expect(await queued("session_storage_gc", fixture.tenantId)).toEqual([storageKey]);
    // The row is leased to the caller that deletes right after the commit.
    expect((await superuserPool().query<{ due: boolean }>(
      "SELECT next_attempt_at <= NOW() AS due FROM session_storage_gc WHERE tenant_id = $1", [fixture.tenantId]
    )).rows).toEqual([{ due: false }]);
  });

  test("a rejection reads the key in its own transaction, and leaves a deleted artifact alone", async () => {
    const fixture = await seedTenantGraph();
    const artifacts = new ArtifactStore(appPool());
    const replaced = `${fixture.tenantId}/replaced-${randomUUID()}`;
    await superuserPool().query("UPDATE artifacts SET storage_key = $2 WHERE artifact_id = $1", [fixture.artifactId, replaced]);
    const pii = { status: "failed" as const, summaryText: "unsupported_mime" };

    await expect(artifacts.rejectStoredObject(fixture.tenantId, fixture.artifactId, { pii, status: "failed" }))
      .resolves.toEqual({ sessionId: fixture.sessionId, storageKey: replaced });
    expect((await superuserPool().query("SELECT status FROM artifacts WHERE artifact_id = $1", [fixture.artifactId])).rows)
      .toEqual([{ status: "failed" }]);

    const gone = await seedArtifact(fixture.tenantId, fixture.userId, fixture.sessionId);
    await superuserPool().query("UPDATE artifacts SET status = 'deleted' WHERE artifact_id = $1", [gone]);
    await expect(artifacts.rejectStoredObject(fixture.tenantId, gone, { pii })).resolves.toBeNull();
    expect(await queued("session_storage_gc", fixture.tenantId)).toEqual([replaced]);
    // Another tenant's scope cannot reject this tenant's artifact.
    const other = await seedTenantGraph();
    await expect(artifacts.rejectStoredObject(other.tenantId, fixture.artifactId, { pii })).resolves.toBeNull();
  });
});
