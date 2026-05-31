import os from "node:os";
import path from "node:path";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { test, expect, onTestFinished } from "vitest";

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

test("local skill bundle storage caches and installs a bundle directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-storage-"));
  const sourcePath = path.join(root, "source-bundle");
  const cacheRoot = path.join(root, "cache");
  const installRoot = path.join(root, "runtime", ".codex", "skills", "pdf-processing");
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
  await storage.installBundle({
    storageUri: stored.storageUri,
    destinationPath: installRoot
  });

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

  const installRoot = path.join(root, "install", ".codex", "skills", "pdf-processing");
  await storage.installBundle({
    storageUri: stored.storageUri,
    destinationPath: installRoot
  });

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
  const installRoot = path.join(root, "install", ".codex", "skills", "pdf-processing");

  await storage.installBundle({ storageUri: legacyUri, destinationPath: installRoot });
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
  const installRoot = path.join(root, "install", "s1");
  await storage.installBundle({ storageUri: stored.storageUri, destinationPath: installRoot });
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
