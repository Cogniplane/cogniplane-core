import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { Readable } from "node:stream";

import { DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import JSZip from "jszip";
import type pg from "pg";
import { describe, expect, onTestFinished, test } from "vitest";

import { createTestConfig } from "../test-helpers/test-config.js";
import {
  BucketSkillBundleStorage,
  LocalSkillBundleStorage,
  type SkillBundleStorage
} from "../services/skills/skill-bundle-storage.js";
import { SkillConfigStore } from "../services/skills/skill-config-store.js";
import { importSkillBundleFromInline, importSkillBundleFromZip } from "../services/skills/skill-import-service.js";
import { cleanupInactiveSkillRevisions } from "../services/skills/skill-revision-cleanup-service.js";
import { SkillRevisionStore } from "../services/skills/skill-revision-store.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedTenantGraph } from "./support/fixtures.js";

// Skill bundle import and cleanup against a real database, with local storage
// in a temporary directory and bucket storage on an in-memory fake S3 client.

type Backend = {
  storage: SkillBundleStorage;
  /** Every stored bundle and temporary copy, as storage URIs. */
  stored: () => Promise<string[]>;
};

async function toBuffer(body: unknown): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-it-skill-bundles-"));
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });
  return root;
}

async function localBackend(): Promise<Backend> {
  const root = path.join(await tempRoot(), "bundles");
  return {
    storage: new LocalSkillBundleStorage(root),
    // Bundles are <root>/<tenant>/<bundle>/<leaf>.
    stored: async () => {
      const entries = await readdir(root, { recursive: true }).catch(() => [] as string[]);
      return entries.filter((entry) => entry.split(path.sep).length === 3)
        .map((entry) => `file://${path.join(root, entry)}`).sort();
    }
  };
}

async function bucketBackend(): Promise<Backend> {
  const objects = new Map<string, Buffer>();
  const client = {
    async send(command: unknown) {
      if (command instanceof GetObjectCommand) {
        const body = objects.get(`${command.input.Bucket}/${command.input.Key}`);
        if (!body) throw new Error("NoSuchKey");
        return { Body: Readable.from([body]) };
      }
      if (command instanceof DeleteObjectCommand) {
        objects.delete(`${command.input.Bucket}/${command.input.Key}`);
        return {};
      }
      throw new Error("Unexpected S3 command");
    }
  };
  return {
    storage: new BucketSkillBundleStorage({
      client,
      bucketName: "skill-bucket",
      keyPrefix: "it",
      cacheRoot: path.join(await tempRoot(), "cache"),
      uploader: async ({ bucketName, key, body }) => { objects.set(`${bucketName}/${key}`, await toBuffer(body)); }
    }),
    stored: async () => [...objects.keys()].map((key) => `s3://${key}`).sort()
  };
}

const backends = [
  { name: "local", create: localBackend },
  { name: "bucket", create: bucketBackend }
] as const;

type StoreHooks = { beforeStore?: () => Promise<void>; afterStore?: (storageUri: string) => Promise<void> };

function withHooks(storage: SkillBundleStorage, hooks: StoreHooks): SkillBundleStorage {
  return {
    backend: storage.backend,
    async storeBundle(input) {
      await hooks.beforeStore?.();
      const stored = await storage.storeBundle(input);
      await hooks.afterStore?.(stored.storageUri);
      return stored;
    },
    materializeBundle: (storageUri) => storage.materializeBundle(storageUri),
    deleteBundle: (storageUri) => storage.deleteBundle(storageUri)
  };
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
}

function uniqueName(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

async function bundleArchive(name: string, notes = "Shared notes."): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(`${name}/SKILL.md`, `---\nname: ${name}\ndescription: Integration bundle\n---\nRead the notes.\n`);
  // A companion file keeps the import a stored bundle, not an inline revision.
  zip.file(`${name}/references/notes.md`, notes);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function seed(options: { pool?: pg.Pool; skills?: SkillConfigStore } = {}) {
  const tenant = await seedTenantGraph();
  const skills = options.skills ?? new SkillConfigStore(appPool());
  const revisions = new SkillRevisionStore(options.pool ?? appPool(), skills);
  return { ...tenant, skills, revisions };
}

type Seed = Awaited<ReturnType<typeof seed>>;

function importZip(target: Seed, storage: SkillBundleStorage, archive: Buffer, fileName: string) {
  return importSkillBundleFromZip({
    tenantId: target.tenantId,
    config: createTestConfig(),
    skillRevisions: target.revisions,
    skillBundleStorage: storage,
    archiveBuffer: archive,
    originalFileName: fileName,
    actorUserId: target.userId
  });
}

async function revisionRows(tenantId: string, skillId: string) {
  const { rows } = await superuserPool().query<{ skill_revision_id: string; bundle_storage_uri: string | null }>(
    `SELECT skill_revision_id, bundle_storage_uri FROM admin_skill_revisions
     WHERE tenant_id = $1 AND skill_id = $2 ORDER BY revision_number`, [tenantId, skillId]);
  return rows.map((row) => ({ id: Number(row.skill_revision_id), uri: row.bundle_storage_uri }));
}

async function readNotes(storage: SkillBundleStorage, storageUri: string): Promise<string> {
  const { localPath } = await storage.materializeBundle(storageUri);
  return readFile(path.join(localPath, "references", "notes.md"), "utf8");
}

/** Makes every revision insert whose source label is `label` fail in the database. */
async function failRevisionInserts(label: string): Promise<void> {
  // Generated names and labels only: CREATE FUNCTION takes no bind parameters.
  if (!/^[a-z0-9-]+\.zip$/.test(label)) throw new Error("Unexpected label");
  const name = `it_fail_revision_${randomBytes(6).toString("hex")}`;
  await superuserPool().query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.source_label = '${label}' THEN RAISE EXCEPTION 'injected revision insert failure'; END IF;
      RETURN NEW;
    END $$`);
  await superuserPool().query(`CREATE TRIGGER ${name} BEFORE INSERT ON admin_skill_revisions
    FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  onTestFinished(async () => {
    await superuserPool().query(`DROP TRIGGER IF EXISTS ${name} ON admin_skill_revisions`);
    await superuserPool().query(`DROP FUNCTION IF EXISTS ${name}()`);
  });
}

/** True when another session can take the tenant's organization skill name lock now. */
async function nameLockIsFree(tenantId: string): Promise<boolean> {
  const client = await superuserPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ free: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS free",
      [JSON.stringify(["organization-skill-name", tenantId])]);
    return rows[0]!.free;
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

/**
 * A pool whose first COMMIT goes through `onCommit` instead. Simulates a commit
 * whose outcome the client does not learn.
 */
function poolWithFirstCommit(
  pool: pg.Pool,
  onCommit: (client: pg.PoolClient) => Promise<void>,
  options: { holdRelease?: () => Promise<unknown> } = {}
): pg.Pool {
  let faulted = false;
  return new Proxy(pool, {
    get(target, property) {
      if (property === "connect") {
        return async () => {
          const client = await target.connect();
          let intercepted = false;
          return new Proxy(client, {
            get(inner, key) {
              if (key === "query") {
                return (text: unknown, ...rest: unknown[]) => {
                  if (text === "COMMIT" && !faulted) {
                    faulted = true;
                    intercepted = true;
                    return onCommit(inner);
                  }
                  // A held transaction finishes on its own: drop the caller's ROLLBACK.
                  if (text === "ROLLBACK" && intercepted && options.holdRelease) return Promise.resolve();
                  return (inner.query as (...args: unknown[]) => unknown).call(inner, text, ...rest);
                };
              }
              if (key === "release") {
                return (error?: Error) => {
                  if (intercepted && options.holdRelease) {
                    void options.holdRelease().finally(() => inner.release());
                    return;
                  }
                  inner.release(error);
                };
              }
              const value = Reflect.get(inner, key);
              return typeof value === "function" ? value.bind(inner) : value;
            }
          });
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

class FailingSkillReads extends SkillConfigStore {
  override async getSkill(): Promise<never> {
    throw new Error("injected skill read failure");
  }
}

describe.skipIf(!adminDatabaseUrl())("skill bundle import", () => describe.each(backends)("with $name storage", ({ create }) => {
  test("a successful import stores one bundle that its revision reads", async () => {
    const backend = await create();
    const target = await seed();
    const name = uniqueName("ok");

    const imported = await importZip(target, backend.storage, await bundleArchive(name), `${name}.zip`);

    expect(imported.revision.bundleStorageUri).toBeTruthy();
    expect(await backend.stored()).toEqual([imported.revision.bundleStorageUri]);
    expect(await revisionRows(target.tenantId, name)).toEqual([
      { id: imported.revision.skillRevisionId, uri: imported.revision.bundleStorageUri }
    ]);
    expect(await readNotes(backend.storage, imported.revision.bundleStorageUri!)).toBe("Shared notes.");
  });

  test("an inline import stores no bundle, also when it fails", async () => {
    const backend = await create();
    const target = await seed();
    const name = uniqueName("inline");
    const zip = new JSZip();
    zip.file(`${name}/SKILL.md`, `---\nname: ${name}\ndescription: Inline bundle\n---\nInline body.\n`);
    const singleFile = await zip.generateAsync({ type: "nodebuffer" });
    await failRevisionInserts(`${name}-failing.zip`);

    await expect(importZip(target, backend.storage, singleFile, `${name}-failing.zip`))
      .rejects.toThrow("injected revision insert failure");
    const fromZip = await importZip(target, backend.storage, singleFile, `${name}.zip`);
    const fromText = await importSkillBundleFromInline({
      tenantId: target.tenantId, skillRevisions: target.revisions, skillId: name, skillName: "Inline",
      description: "Inline bundle", instructions: "Edited body.", actorUserId: target.userId
    });

    expect(await revisionRows(target.tenantId, name)).toEqual([
      { id: fromZip.revision.skillRevisionId, uri: null },
      { id: fromText.revision.skillRevisionId, uri: null }
    ]);
    expect(fromText.revision.metadata.instructions).toBe("Edited body.");
    expect(await backend.stored()).toEqual([]);
  });

  test("a failed revision insert deletes the bundle that the import wrote", async () => {
    const backend = await create();
    const target = await seed();
    const name = uniqueName("fail");
    await failRevisionInserts(`${name}.zip`);

    await expect(importZip(target, backend.storage, await bundleArchive(name), `${name}.zip`))
      .rejects.toThrow("injected revision insert failure");

    expect(await revisionRows(target.tenantId, name)).toEqual([]);
    expect(await backend.stored()).toEqual([]);
  });

  test("a failed import of the same bytes keeps the bundle of the earlier revision", async () => {
    const backend = await create();
    const target = await seed();
    const name = uniqueName("shared");
    const archive = await bundleArchive(name);
    const first = await importZip(target, backend.storage, archive, `${name}.zip`);
    await failRevisionInserts(`${name}-again.zip`);

    await expect(importZip(target, backend.storage, archive, `${name}-again.zip`))
      .rejects.toThrow("injected revision insert failure");

    expect(await revisionRows(target.tenantId, name)).toEqual([
      { id: first.revision.skillRevisionId, uri: first.revision.bundleStorageUri }
    ]);
    expect(await backend.stored()).toEqual([first.revision.bundleStorageUri]);
    expect(await readNotes(backend.storage, first.revision.bundleStorageUri!)).toBe("Shared notes.");
  });

  test("the import writes the bundle before it takes the tenant's skill name lock", async () => {
    const backend = await create();
    const target = await seed();
    const name = uniqueName("lock");
    const lockFree: boolean[] = [];
    const storage = withHooks(backend.storage, {
      beforeStore: async () => { lockFree.push(await nameLockIsFree(target.tenantId)); },
      afterStore: async () => { lockFree.push(await nameLockIsFree(target.tenantId)); }
    });

    await importZip(target, storage, await bundleArchive(name), `${name}.zip`);

    expect(lockFree).toEqual([true, true]);
  });

  test("an unclear commit that applied keeps the bundle of the committed revision", async () => {
    const backend = await create();
    const target = await seed({
      pool: poolWithFirstCommit(appPool(), async (client) => {
        await client.query("COMMIT");
        throw new Error("Connection terminated unexpectedly");
      })
    });
    const name = uniqueName("unclear");

    await expect(importZip(target, backend.storage, await bundleArchive(name), `${name}.zip`))
      .rejects.toThrow("Connection terminated unexpectedly");

    const rows = await revisionRows(target.tenantId, name);
    expect(rows).toHaveLength(1);
    expect(await backend.stored()).toEqual([rows[0]!.uri]);
    expect(await readNotes(backend.storage, rows[0]!.uri!)).toBe("Shared notes.");
  });

  test("a commit that did not apply deletes the bundle", async () => {
    const backend = await create();
    const target = await seed({
      pool: poolWithFirstCommit(appPool(), async (client) => {
        await client.query("ROLLBACK");
        throw new Error("Connection terminated unexpectedly");
      })
    });
    const name = uniqueName("lost");

    await expect(importZip(target, backend.storage, await bundleArchive(name), `${name}.zip`))
      .rejects.toThrow("Connection terminated unexpectedly");

    expect(await revisionRows(target.tenantId, name)).toEqual([]);
    expect(await backend.stored()).toEqual([]);
  });

  test("a commit still running when the client gives up keeps the bundle", async () => {
    const backend = await create();
    let pending: Promise<unknown> = Promise.resolve();
    const target = await seed({
      pool: poolWithFirstCommit(appPool(), async (client) => {
        // The server finishes the commit after the client has reported an error.
        pending = client.query("SELECT pg_sleep(1)").then(() => client.query("COMMIT"));
        throw new Error("Connection terminated unexpectedly");
      }, { holdRelease: () => pending })
    });
    const name = uniqueName("late");

    await expect(importZip(target, backend.storage, await bundleArchive(name), `${name}.zip`))
      .rejects.toThrow("Connection terminated unexpectedly");
    await pending;

    const rows = await revisionRows(target.tenantId, name);
    expect(rows).toHaveLength(1);
    expect(await backend.stored()).toEqual([rows[0]!.uri]);
    expect(await readNotes(backend.storage, rows[0]!.uri!)).toBe("Shared notes.");
  });

  test("a failure while loading the import result leaves no revision and no bundle", async () => {
    const backend = await create();
    const target = await seed({ skills: new FailingSkillReads(appPool()) });
    const name = uniqueName("read");

    await expect(importZip(target, backend.storage, await bundleArchive(name), `${name}.zip`))
      .rejects.toThrow("injected skill read failure");

    expect(await revisionRows(target.tenantId, name)).toEqual([]);
    expect(await backend.stored()).toEqual([]);
  });

  test("two imports of the same bytes, one failing, leave the other a working bundle", async () => {
    const backend = await create();
    const target = await seed();
    const name = uniqueName("pair");
    const archive = await bundleArchive(name);
    await failRevisionInserts(`${name}-failing.zip`);

    const [failing, passing] = await Promise.allSettled([
      importZip(target, backend.storage, archive, `${name}-failing.zip`),
      importZip(target, backend.storage, archive, `${name}-passing.zip`)
    ]);

    expect(failing.status).toBe("rejected");
    expect(passing.status).toBe("fulfilled");
    const uri = (passing as PromiseFulfilledResult<Awaited<ReturnType<typeof importZip>>>).value.revision.bundleStorageUri!;
    expect(await backend.stored()).toEqual([uri]);
    expect(await readNotes(backend.storage, uri)).toBe("Shared notes.");
  });
}));

const retention = { SKILL_BUNDLE_RETENTION_DAYS: 30 };

/** Skill with an old inactive revision of bytes X and an active latest revision of bytes Y. */
async function seedCleanupCandidate(backend: Backend) {
  const target = await seed();
  const name = uniqueName("cleanup");
  const oldArchive = await bundleArchive(name, "Old notes.");
  const old = await importZip(target, backend.storage, oldArchive, `${name}-old.zip`);
  const current = await importZip(target, backend.storage, await bundleArchive(name, "Current notes."), `${name}-current.zip`);
  await target.revisions.activateSkillRevision(target.tenantId, {
    skillId: name, skillRevisionId: current.revision.skillRevisionId, reviewedBy: target.userId, reviewNotes: null
  });
  await superuserPool().query(
    "UPDATE admin_skill_revisions SET created_at = now() - interval '400 days' WHERE skill_revision_id = $1",
    [old.revision.skillRevisionId]);
  const cleanup = (storage: SkillBundleStorage, dryRun = false) => cleanupInactiveSkillRevisions({
    tenantId: target.tenantId,
    config: retention,
    skills: target.skills,
    skillRevisions: target.revisions,
    skillBundleStorage: storage,
    dryRun
  });
  return { target, name, oldArchive, old, current, cleanup };
}

describe.skipIf(!adminDatabaseUrl())("skill revision cleanup", () => describe.each(backends)("with $name storage", ({ create }) => {
  test("cleanup of the last reference keeps the bundle that a concurrent import of the same bytes publishes", async () => {
    const backend = await create();
    const candidate = await seedCleanupCandidate(backend);
    const stored = gate();
    const resume = gate();
    const storage = withHooks(backend.storage, {
      afterStore: async () => { stored.open(); await resume.opened; }
    });

    const reimport = importZip(candidate.target, storage, candidate.oldArchive, `${candidate.name}-reimport.zip`);
    // The import has written or chosen its bundle and has not published it yet.
    await stored.opened;
    const report = await candidate.cleanup(backend.storage);
    resume.open();
    const reimported = await reimport;

    expect(report.deletedRevisionIds).toEqual([candidate.old.revision.skillRevisionId]);
    expect(report.failures).toEqual([]);
    expect(await readNotes(backend.storage, reimported.revision.bundleStorageUri!)).toBe("Old notes.");
    expect(await backend.stored()).toEqual(
      [candidate.current.revision.bundleStorageUri, reimported.revision.bundleStorageUri].sort());
  });

  test("dry run reports the candidates and changes nothing", async () => {
    const backend = await create();
    const candidate = await seedCleanupCandidate(backend);
    const before = await backend.stored();

    const report = await candidate.cleanup(backend.storage, true);

    expect(report).toMatchObject({
      dryRun: true,
      deletedRevisionIds: [candidate.old.revision.skillRevisionId],
      deletedBundleStorageUris: [candidate.old.revision.bundleStorageUri],
      failures: []
    });
    expect((await revisionRows(candidate.target.tenantId, candidate.name)).map((row) => row.id))
      .toEqual([candidate.old.revision.skillRevisionId, candidate.current.revision.skillRevisionId]);
    expect(await backend.stored()).toEqual(before);
  });

  test("a storage failure is reported, and a retry neither repeats it nor touches the active bundle", async () => {
    const backend = await create();
    const candidate = await seedCleanupCandidate(backend);
    const failing: SkillBundleStorage = {
      backend: backend.storage.backend,
      storeBundle: (input) => backend.storage.storeBundle(input),
      materializeBundle: (storageUri) => backend.storage.materializeBundle(storageUri),
      deleteBundle: async () => { throw new Error("injected storage failure"); }
    };

    const report = await candidate.cleanup(failing);

    // The row goes first; the bytes it named stay when the storage delete fails.
    expect(report.deletedRevisionIds).toEqual([candidate.old.revision.skillRevisionId]);
    expect(report.deletedBundleStorageUris).toEqual([]);
    expect(report.failures.map((failure) => failure.skillRevisionId)).toEqual([candidate.old.revision.skillRevisionId]);
    expect((await revisionRows(candidate.target.tenantId, candidate.name)).map((row) => row.id))
      .toEqual([candidate.current.revision.skillRevisionId]);
    expect(await backend.stored()).toContain(candidate.old.revision.bundleStorageUri);

    const retry = await candidate.cleanup(backend.storage);

    expect(retry).toMatchObject({ deletedRevisionIds: [], deletedBundleStorageUris: [], failures: [] });
    expect(await readNotes(backend.storage, candidate.current.revision.bundleStorageUri!)).toBe("Current notes.");
  });
}));
