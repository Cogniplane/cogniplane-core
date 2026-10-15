import os from "node:os";
import path from "node:path";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { test, expect, onTestFinished, vi } from "vitest";

// Records where the storage copies a bundle, to check the temporary path.
const copyDestinations = vi.hoisted(() => [] as string[]);
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    cp: (async (source: string, destination: string, options?: unknown) => {
      copyDestinations.push(String(destination));
      return actual.cp(source, destination, options as never);
    }) as typeof actual.cp
  };
});

import * as tar from "tar";

import {
  BucketSkillBundleStorage,
  LocalSkillBundleStorage
} from "./skill-bundle-storage.js";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand
} from "@aws-sdk/client-s3";

async function streamToBuffer(body: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body);
  if (body && typeof (body as AsyncIterable<Buffer>)[Symbol.asyncIterator] === "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Buffer | string>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new Error(`Unsupported Body type in fake S3 client: ${typeof body}`);
}

function createFakeS3Client(objects: Map<string, Buffer>) {
  // `getObjectCount` is the observable signal a cache-hit test needs: a real
  // download issues a GetObject, a cache hit does not.
  return {
    getObjectCount: 0,
    async send(command: unknown) {
      if (command instanceof GetObjectCommand) {
        this.getObjectCount += 1;
        const stored = objects.get(`${command.input.Bucket}/${command.input.Key}`);
        if (!stored) throw new Error("Missing object");
        return { Body: Readable.from([stored]), ContentLength: stored.length };
      }
      if (command instanceof DeleteObjectCommand) {
        objects.delete(`${command.input.Bucket}/${command.input.Key}`);
        return {};
      }
      if (command instanceof PutObjectCommand) {
        const buffer = await streamToBuffer(command.input.Body);
        objects.set(`${command.input.Bucket}/${command.input.Key}`, buffer);
        return {};
      }
      throw new Error(`Unexpected command: ${(command as { constructor: { name: string } }).constructor.name}`);
    }
  };
}

async function createFixtureTarball(): Promise<Buffer> {
  // Build a tar.gz of a minimal skill bundle off a temp dir and return the
  // bytes, so tests can pre-populate the fake S3 store with an object that
  // matches what BucketSkillBundleStorage would have uploaded.
  const staging = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-fixture-"));
  await writeFile(
    path.join(staging, "SKILL.md"),
    "---\nname: pdf-processing\n---\nBody\n"
  );
  const chunks: Buffer[] = [];
  for await (const chunk of tar.create({ cwd: staging, gzip: true, portable: true }, ["."])) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  await rm(staging, { recursive: true, force: true });
  return Buffer.concat(chunks);
}

// `BucketSkillBundleStorage` accepts an injectable uploader so tests don't
// have to stand up a real S3 HTTP server. The production default uses
// `@aws-sdk/lib-storage` to stream the tarball without buffering.
function createFakeUploader(objects: Map<string, Buffer>) {
  return async ({ bucketName, key, body }: {
    bucketName: string;
    key: string;
    body: NodeJS.ReadableStream;
    contentType: string;
  }) => {
    const buffer = await streamToBuffer(body);
    objects.set(`${bucketName}/${key}`, buffer);
  };
}

test("local skill bundle storage caches and materializes a bundle directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-storage-"));
  const sourcePath = path.join(root, "source-bundle");
  const cacheRoot = path.join(root, "cache");
  const storage = new LocalSkillBundleStorage(cacheRoot);

  await mkdir(sourcePath, { recursive: true });
  await writeFile(path.join(sourcePath, "SKILL.md"), "---\nname: pdf-processing\ndescription: Test\n---\n");
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  const stored = await storage.storeBundle({
    tenantId: "t1",
    skillId: "pdf-processing",
    revisionNumber: 1,
    bundleName: "pdf-processing",
    contentHash: "abc123",
    sourcePath
  });
  expect(stored.storageUri.startsWith("file://")).toBe(true);
  const { localPath: installRoot } = await storage.materializeBundle(stored.storageUri);

  const installedContent = await readFile(path.join(installRoot, "SKILL.md"), "utf8");
  expect(installedContent.includes("pdf-processing")).toBe(true);

  const storedAgain = await storage.storeBundle({
    tenantId: "t1",
    skillId: "pdf-processing",
    revisionNumber: 1,
    bundleName: "pdf-processing",
    contentHash: "abc123",
    sourcePath
  });
  expect(storedAgain.storageUri).toBe(stored.storageUri);

  const materialized = await storage.materializeBundle(stored.storageUri);
  // Local path is namespaced by tenantId so per-tenant cleanup cannot rm a
  // bundle another tenant still uses.
  expect(materialized.localPath.endsWith(path.join("t1", "pdf-processing", "abc123"))).toBeTruthy();
});

test("local skill bundle storage isolates identical bundles across tenants", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-tenant-iso-"));
  const sourcePath = path.join(root, "source-bundle");
  const cacheRoot = path.join(root, "cache");
  const storage = new LocalSkillBundleStorage(cacheRoot);

  await mkdir(sourcePath, { recursive: true });
  await writeFile(path.join(sourcePath, "SKILL.md"), "---\nname: shared\ndescription: Test\n---\n");
  onTestFinished(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const shared = {
    skillId: "shared",
    revisionNumber: 1,
    bundleName: "shared",
    contentHash: "samehash",
    sourcePath
  };

  const tenantA = await storage.storeBundle({ tenantId: "tenant-a", ...shared });
  const tenantB = await storage.storeBundle({ tenantId: "tenant-b", ...shared });

  // Same bundleName + contentHash, different tenant → distinct on-disk paths.
  expect(tenantA.storageUri).not.toBe(tenantB.storageUri);

  // Tenant A's cleanup must leave tenant B's bundle intact.
  await storage.deleteBundle(tenantA.storageUri);
  const survivor = await storage.materializeBundle(tenantB.storageUri);
  const body = await readFile(path.join(survivor.localPath, "SKILL.md"), "utf8");
  expect(body.includes("shared")).toBe(true);
});

test("bucket skill bundle storage uploads a tarball and extracts on materialize", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-bucket-"));
  const sourcePath = path.join(root, "src", "pdf-processing");
  await mkdir(sourcePath, { recursive: true });
  await writeFile(
    path.join(sourcePath, "SKILL.md"),
    "---\nname: pdf-processing\ndescription: Test\n---\n"
  );
  await mkdir(path.join(sourcePath, "scripts"), { recursive: true });
  await writeFile(path.join(sourcePath, "scripts", "run.sh"), "#!/bin/sh\necho hi\n");

  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  const objects = new Map<string, Buffer>();
  const client = createFakeS3Client(objects);

  const storage = new BucketSkillBundleStorage({
    client,
    bucketName: "skill-bucket",
    keyPrefix: "",
    cacheRoot: path.join(root, "cache"),
    uploader: createFakeUploader(objects)
  });

  const stored = await storage.storeBundle({
    tenantId: "tenant-a",
    skillId: "pdf-processing",
    revisionNumber: 3,
    bundleName: "pdf-processing",
    contentHash: "deadbeef",
    sourcePath
  });

  expect(stored.storageUri).toBe("s3://skill-bucket/skills/tenant-a/pdf-processing/3-deadbeef.tar.gz");
  expect(objects.has("skill-bucket/skills/tenant-a/pdf-processing/3-deadbeef.tar.gz")).toBeTruthy();

  const { localPath: installRoot } = await storage.materializeBundle(stored.storageUri);

  const installedSkill = await readFile(path.join(installRoot, "SKILL.md"), "utf8");
  expect(installedSkill.includes("pdf-processing")).toBe(true);
  const installedScript = await readFile(path.join(installRoot, "scripts", "run.sh"), "utf8");
  expect(installedScript.includes("echo hi")).toBe(true);

  // Second materialize should be a cache hit — no extra GetObject needed.
  const getObjectsBefore = client.getObjectCount;
  const second = await storage.materializeBundle(stored.storageUri);
  // Cache path is namespaced by bucket so renames do not collide.
  expect(second.localPath.includes(path.join("skill-bucket", "skills", "tenant-a"))).toBeTruthy();
  // No new GetObject issued: the content-addressed cache was reused rather than
  // re-downloaded from S3.
  expect(client.getObjectCount).toBe(getObjectsBefore);

  await storage.deleteBundle(stored.storageUri);
  expect(objects.size).toBe(0);
});

test("bucket skill bundle storage skips symlink entries during extraction", async () => {
  // Build a malicious tarball: contains both a regular SKILL.md and a
  // symlink "evil" -> "/etc/passwd". The runtime extractor must drop the
  // symlink even though the upload-time validator wasn't involved (S3
  // tarballs may have been written by another path).
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-symlink-"));
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  const staging = path.join(root, "staging");
  await mkdir(staging, { recursive: true });
  await writeFile(path.join(staging, "SKILL.md"), "---\nname: evil\n---\n");
  await symlink("/etc/passwd", path.join(staging, "evil"));

  const tarballChunks: Buffer[] = [];
  for await (const chunk of tar.create({ cwd: staging, gzip: true, portable: true }, ["."])) {
    tarballChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const objects = new Map<string, Buffer>();
  objects.set("skill-bucket/skills/tenant-a/evil-skill/1-deadbeef.tar.gz", Buffer.concat(tarballChunks));

  const storage = new BucketSkillBundleStorage({
    client: createFakeS3Client(objects),
    bucketName: "skill-bucket",
    keyPrefix: "",
    cacheRoot: path.join(root, "cache"),
    uploader: createFakeUploader(objects)
  });

  const { localPath } = await storage.materializeBundle(
    "s3://skill-bucket/skills/tenant-a/evil-skill/1-deadbeef.tar.gz"
  );

  // SKILL.md must be present (allowed entry); the symlink must NOT exist.
  const skillBody = await readFile(path.join(localPath, "SKILL.md"), "utf8");
  expect(skillBody.includes("evil")).toBeTruthy();

  await expect(() => lstat(path.join(localPath, "evil"))).rejects.toThrow(/ENOENT/);
});

test("bucket skill bundle storage reads URIs whose bucket differs from the configured bucket", async () => {
  // Simulates a `SKILL_BUNDLE_BUCKET_NAME` change after some revisions have
  // been imported. The persisted URI is authoritative for reads; materialize
  // and delete must route to the bucket in the URI, not the env-configured
  // one, so pre-rename revisions stay readable.
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-bucket-rename-"));
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  const objects = new Map<string, Buffer>();
  objects.set(
    "legacy-bucket/skills/tenant-a/pdf-processing/1-oldhash.tar.gz",
    await createFixtureTarball()
  );

  const storage = new BucketSkillBundleStorage({
    client: createFakeS3Client(objects),
    bucketName: "new-bucket",
    keyPrefix: "",
    cacheRoot: path.join(root, "cache"),
    uploader: createFakeUploader(objects)
  });

  const legacyUri = "s3://legacy-bucket/skills/tenant-a/pdf-processing/1-oldhash.tar.gz";
  const { localPath: installRoot } = await storage.materializeBundle(legacyUri);
  const installed = await readFile(path.join(installRoot, "SKILL.md"), "utf8");
  expect(installed.includes("pdf-processing")).toBe(true);

  await storage.deleteBundle(legacyUri);
  expect(!objects.has("legacy-bucket/skills/tenant-a/pdf-processing/1-oldhash.tar.gz")).toBeTruthy();
});

test("bucket skill bundle storage handles bucket prefixes with regex metacharacters", async () => {
  // Prefix characters like `[` or `.` are valid S3 object-key bytes but
  // would blow up a naive `new RegExp(prefix)` used for prefix stripping.
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-metachar-prefix-"));
  const sourcePath = path.join(root, "src");
  await mkdir(sourcePath, { recursive: true });
  await writeFile(path.join(sourcePath, "SKILL.md"), "---\nname: x\n---\nBody\n");
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  const objects = new Map<string, Buffer>();
  const prefix = "env[demo].v2";
  const storage = new BucketSkillBundleStorage({
    client: createFakeS3Client(objects),
    bucketName: "my-bucket",
    keyPrefix: prefix,
    cacheRoot: path.join(root, "cache"),
    uploader: createFakeUploader(objects)
  });

  const stored = await storage.storeBundle({
    tenantId: "t1",
    skillId: "s1",
    revisionNumber: 4,
    bundleName: "s1",
    contentHash: "abc",
    sourcePath
  });
  expect(stored.storageUri).toBe(`s3://my-bucket/${prefix}/skills/t1/s1/4-abc.tar.gz`);

  // Materialize must not throw even though the prefix has `[`, `]`, `.`.
  const { localPath: installRoot } = await storage.materializeBundle(stored.storageUri);
  const body = await readFile(path.join(installRoot, "SKILL.md"), "utf8");
  expect(body.includes("Body")).toBe(true);
});

test("bucket skill bundle storage applies the configured key prefix", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-prefix-"));
  const sourcePath = path.join(tmpRoot, "src");
  await mkdir(sourcePath, { recursive: true });
  await writeFile(path.join(sourcePath, "SKILL.md"), "---\nname: x\n---\n");

  const objects = new Map<string, Buffer>();
  const client = createFakeS3Client(objects);

  const storage = new BucketSkillBundleStorage({
    client,
    bucketName: "my-bucket",
    keyPrefix: "env/demo",
    cacheRoot: path.join(tmpRoot, "cache"),
    uploader: createFakeUploader(objects)
  });

  const stored = await storage.storeBundle({
    tenantId: "t1",
    skillId: "s1",
    revisionNumber: 7,
    bundleName: "s1",
    contentHash: "h",
    sourcePath
  });
  expect(stored.storageUri).toBe("s3://my-bucket/env/demo/skills/t1/s1/7-h.tar.gz");
  expect(objects.has("my-bucket/env/demo/skills/t1/s1/7-h.tar.gz")).toBeTruthy();

  await rm(tmpRoot, { recursive: true, force: true });
});

test("local skill bundle storage never reads or deletes outside its root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-contain-"));
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });
  const cacheRoot = path.join(root, "cache");
  const outside = path.join(root, "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "keep.txt"), "keep");
  const storage = new LocalSkillBundleStorage(cacheRoot);

  for (const uri of [`file://${outside}`, `file://${cacheRoot}/../outside`, `file://${cacheRoot}`]) {
    await expect(storage.deleteBundle(uri)).rejects.toThrow("outside the bundle storage root");
    await expect(storage.materializeBundle(uri)).rejects.toThrow("outside the bundle storage root");
  }
  await expect(storage.storeBundle({ tenantId: "t1", skillId: "s", revisionNumber: 1,
    bundleName: "../../outside", contentHash: "x", sourcePath: outside })).rejects.toThrow("outside the bundle storage root");
  expect(await readFile(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
});

test("bucket skill bundle storage keeps its cache path inside the cache root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-contain-bucket-"));
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });
  const outside = path.join(root, "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "keep.txt"), "keep");
  const objects = new Map<string, Buffer>();
  const storage = new BucketSkillBundleStorage({
    client: createFakeS3Client(objects), bucketName: "skill-bucket", keyPrefix: "",
    cacheRoot: path.join(root, "cache"), uploader: createFakeUploader(objects)
  });

  // A key that climbs out of the cache would make deleteBundle rm the target.
  await expect(storage.deleteBundle("s3://skill-bucket/../../outside")).rejects.toThrow("outside the bundle storage root");
  expect(await readFile(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
});

test("local skill bundle storage refuses a symlinked directory that leads outside its root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-symlink-"));
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });
  const cacheRoot = path.join(root, "cache");
  const outside = path.join(root, "outside");
  await mkdir(path.join(outside, "victim"), { recursive: true });
  await writeFile(path.join(outside, "victim", "keep.txt"), "keep");
  await mkdir(cacheRoot, { recursive: true });
  await symlink(outside, path.join(cacheRoot, "link"));
  const storage = new LocalSkillBundleStorage(cacheRoot);

  const uri = `file://${path.join(cacheRoot, "link", "victim")}`;
  await expect(storage.deleteBundle(uri)).rejects.toThrow("outside the bundle storage root");
  await expect(storage.materializeBundle(uri)).rejects.toThrow("outside the bundle storage root");
  await expect(storage.storeBundle({ tenantId: "link", skillId: "s", revisionNumber: 1,
    bundleName: "victim", contentHash: "h", sourcePath: outside })).rejects.toThrow("outside the bundle storage root");
  expect(await readFile(path.join(outside, "victim", "keep.txt"), "utf8")).toBe("keep");
});

test("local skill bundle storage builds its temporary path from the checked path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-temp-"));
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });
  const cacheRoot = path.join(root, "cache");
  const sourcePath = path.join(root, "source");
  await mkdir(sourcePath, { recursive: true });
  await writeFile(path.join(sourcePath, "SKILL.md"), "skill");
  const storage = new LocalSkillBundleStorage(cacheRoot);

  // Contained destination cache/t1/victim, but a raw-hash temp path would be outside.
  copyDestinations.length = 0;
  const stored = await storage.storeBundle({ tenantId: "t1", skillId: "s", revisionNumber: 1,
    bundleName: "a/b", contentHash: "../../victim", sourcePath });
  expect(stored.storageUri).toBe(`file://${path.join(cacheRoot, "t1", "victim")}`);
  expect(copyDestinations).toHaveLength(1);
  expect(copyDestinations[0]!.startsWith(`${cacheRoot}${path.sep}`)).toBe(true);
  expect((await readdir(root)).sort()).toEqual(["cache", "source"]);
});

test("local skill bundle storage still reads a relative stored path from the working directory", async () => {
  const root = await mkdtemp(path.join(process.cwd(), ".skill-relative-"));
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });
  const relativeRoot = path.relative(process.cwd(), root);
  await mkdir(path.join(root, "t1", "skill", "hash"), { recursive: true });
  const storage = new LocalSkillBundleStorage(relativeRoot);

  await expect(storage.materializeBundle(`file://${path.join(relativeRoot, "t1", "skill", "hash")}`))
    .resolves.toEqual({ localPath: path.join(root, "t1", "skill", "hash") });
});

test("bucket skill bundle storage refuses a traversal before it deletes the object", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-bucket-order-"));
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });
  const objects = new Map<string, Buffer>([["skill-bucket/env/demo/../../../outside.tar.gz", Buffer.from("x")]]);
  const client = createFakeS3Client(objects);
  const storage = new BucketSkillBundleStorage({
    client, bucketName: "skill-bucket", keyPrefix: "env/demo",
    cacheRoot: path.join(root, "cache"), uploader: createFakeUploader(objects)
  });

  await expect(storage.deleteBundle("s3://skill-bucket/env/demo/../../../outside.tar.gz"))
    .rejects.toThrow("outside the bundle storage root");
  expect(objects.size).toBe(1);
});

test("bucket skill bundle storage refuses a cache path through a symlink", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-bucket-link-"));
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });
  const cacheRoot = path.join(root, "cache");
  const outside = path.join(root, "outside");
  await mkdir(path.join(outside, "x"), { recursive: true });
  await mkdir(cacheRoot, { recursive: true });
  await symlink(outside, path.join(cacheRoot, "skill-bucket"));
  const objects = new Map<string, Buffer>();
  const storage = new BucketSkillBundleStorage({
    client: createFakeS3Client(objects), bucketName: "skill-bucket", keyPrefix: "",
    cacheRoot, uploader: createFakeUploader(objects)
  });

  await expect(storage.materializeBundle("s3://skill-bucket/x.tar.gz")).rejects.toThrow("outside the bundle storage root");
  await expect(storage.deleteBundle("s3://skill-bucket/x.tar.gz")).rejects.toThrow("outside the bundle storage root");
});

test("a bundle path that is itself a symlink is never read, and deleting it removes only the link", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-leaf-"));
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });
  const outside = path.join(root, "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "keep.txt"), "keep");

  const cacheRoot = path.join(root, "cache");
  await mkdir(path.join(cacheRoot, "t1", "skill"), { recursive: true });
  const leaf = path.join(cacheRoot, "t1", "skill", "hash");
  await symlink(outside, leaf);
  const local = new LocalSkillBundleStorage(cacheRoot);
  await expect(local.materializeBundle(`file://${leaf}`)).rejects.toThrow("outside the bundle storage root");
  await local.deleteBundle(`file://${leaf}`);
  await expect(lstat(leaf)).rejects.toThrow();
  expect(await readFile(path.join(outside, "keep.txt"), "utf8")).toBe("keep");

  const bucketCache = path.join(root, "bucket-cache");
  await mkdir(path.join(bucketCache, "skill-bucket"), { recursive: true });
  const bucketLeaf = path.join(bucketCache, "skill-bucket", "x");
  await symlink(outside, bucketLeaf);
  const objects = new Map<string, Buffer>();
  const bucket = new BucketSkillBundleStorage({
    client: createFakeS3Client(objects), bucketName: "skill-bucket", keyPrefix: "",
    cacheRoot: bucketCache, uploader: createFakeUploader(objects)
  });
  await expect(bucket.materializeBundle("s3://skill-bucket/x.tar.gz")).rejects.toThrow("outside the bundle storage root");
  await bucket.deleteBundle("s3://skill-bucket/x.tar.gz");
  await expect(lstat(bucketLeaf)).rejects.toThrow();
  expect(await readFile(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
});

test("a name that starts with two dots stays inside the root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-dots-"));
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });
  const cacheRoot = path.join(root, "cache");
  await mkdir(path.join(cacheRoot, "..legacy", "hash"), { recursive: true });
  const storage = new LocalSkillBundleStorage(cacheRoot);
  await expect(storage.materializeBundle(`file://${path.join(cacheRoot, "..legacy", "hash")}`))
    .resolves.toEqual({ localPath: path.join(cacheRoot, "..legacy", "hash") });
});
