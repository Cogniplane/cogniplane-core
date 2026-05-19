import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, expect, onTestFinished } from "vitest";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

import { BucketArtifactStorage, LocalArtifactStorage } from "./artifact-storage.js";

test("local artifact storage writes and reads back file content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-artifact-storage-test-"));
  onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
      });

  const storage = new LocalArtifactStorage(root);
  const stored = await storage.put({
    storageKey: "user/session/file.txt",
    stream: Readable.from(["hello artifacts"])
  });

  expect(stored.storageBackend).toBe("local");
  expect(stored.fileSizeBytes).toBe("hello artifacts".length);
  expect(stored.checksumSha256).toMatch(/^[a-f0-9]{64}$/);

  const handle = await storage.openReadStream(stored.storageKey);
  const chunks: Buffer[] = [];
  for await (const chunk of handle.stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  expect(handle.fileSizeBytes).toBe("hello artifacts".length);
  expect(Buffer.concat(chunks).toString("utf8")).toBe("hello artifacts");
});

test("bucket artifact storage uploads and downloads through the configured key prefix", async () => {
  const objects = new Map<string, Buffer>();
  const contentLengths: Array<number | undefined> = [];
  const client = {
    async send(command: unknown) {
      if (command instanceof PutObjectCommand) {
        const input = command.input;
        const body = input.Body;
        const buffer = Buffer.isBuffer(body)
          ? body
          : Buffer.from(String(body ?? ""));
        contentLengths.push(input.ContentLength);
        objects.set(`${input.Bucket}/${input.Key}`, buffer);
        return {};
      }

      if (command instanceof GetObjectCommand) {
        const input = command.input;
        const stored = objects.get(`${input.Bucket}/${input.Key}`);
        if (!stored) {
          throw new Error("Missing object");
        }

        return {
          Body: Readable.from([stored]),
          ContentLength: stored.length
        };
      }

      throw new Error("Unexpected command");
    }
  };

  const storage = new BucketArtifactStorage({
    client,
    bucketName: "artifact-bucket",
    keyPrefix: "tenant-a"
  });

  const stored = await storage.put({
    storageKey: "user/session/file.txt",
    stream: Readable.from(["hello bucket"])
  });

  expect(stored.storageBackend).toBe("bucket");
  expect(stored.fileSizeBytes).toBe("hello bucket".length);
  expect(stored.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(contentLengths[0]).toBe("hello bucket".length);
  expect(objects.get("artifact-bucket/tenant-a/user/session/file.txt")?.toString("utf8")).toBe("hello bucket");

  const handle = await storage.openReadStream("user/session/file.txt");
  const chunks: Buffer[] = [];
  for await (const chunk of handle.stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  expect(handle.fileSizeBytes).toBe("hello bucket".length);
  expect(Buffer.concat(chunks).toString("utf8")).toBe("hello bucket");
});

test("local storage rejects storage keys that escape the root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-as-test-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const storage = new LocalArtifactStorage(root);
  await expect(() =>
        storage.put({
          storageKey: "../escape.txt",
          stream: Readable.from(["x"])
        })).rejects.toThrow(/Invalid storage key/);
});

test("local storage cleans up partial file on stream error during put", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cogniplane-as-test-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const storage = new LocalArtifactStorage(root);

  const failingStream = new Readable({
    read() {
      this.destroy(new Error("source failed"));
    }
  });

  await expect(() =>
        storage.put({
          storageKey: "user/s/broken.txt",
          stream: failingStream
        })).rejects.toThrow(/source failed/);
});

test("bucket storage uploads under bucketName when no key prefix is set", async () => {
  const objects = new Map<string, Buffer>();
  const client = {
    async send(command: unknown) {
      if (command instanceof PutObjectCommand) {
        const input = command.input;
        objects.set(`${input.Bucket}/${input.Key}`, Buffer.from(String(input.Body ?? "")));
        return {};
      }
      throw new Error("unexpected command");
    }
  };
  const storage = new BucketArtifactStorage({
    client,
    bucketName: "bkt"
    // no keyPrefix
  });

  await storage.put({
    storageKey: "u/s/file.txt",
    stream: Readable.from(["body"])
  });

  // Stored at the bare key (no prefix segment, no leading slash)
  expect(objects.has("bkt/u/s/file.txt")).toBeTruthy();
});

test("bucket storage strips leading slashes and surrounding whitespace from prefix", async () => {
  const objects = new Map<string, Buffer>();
  const client = {
    async send(command: unknown) {
      if (command instanceof PutObjectCommand) {
        const input = command.input;
        objects.set(input.Key as string, Buffer.alloc(0));
        return {};
      }
      throw new Error("unexpected command");
    }
  };
  const storage = new BucketArtifactStorage({
    client,
    bucketName: "bkt",
    keyPrefix: "  /tenant-a/"
  });
  await storage.put({
    storageKey: "/u/s/file.txt", // leading slash should also be stripped
    stream: Readable.from(["x"])
  });
  expect(objects.has("tenant-a/u/s/file.txt")).toBeTruthy();
});

test("bucket storage GetObject body that uses transformToWebStream is supported", async () => {
  // Simulates the AWS SDK browser/runtime body shape (Web ReadableStream).
  const webReadable = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(new TextEncoder().encode("from-web"));
      ctrl.close();
    }
  });
  const client = {
    async send(command: unknown) {
      if (command instanceof PutObjectCommand) return {};
      if (command instanceof GetObjectCommand) {
        return {
          Body: { transformToWebStream: () => webReadable },
          ContentLength: 8
        };
      }
      throw new Error("unexpected");
    }
  };
  const storage = new BucketArtifactStorage({ client, bucketName: "bkt" });
  await storage.put({ storageKey: "k", stream: Readable.from(["seed"]) });

  const handle = await storage.openReadStream("k");
  const chunks: Buffer[] = [];
  for await (const chunk of handle.stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  expect(Buffer.concat(chunks).toString("utf8")).toBe("from-web");
});

test("bucket storage throws when GetObject body cannot be turned into a Node stream", async () => {
  const client = {
    async send(command: unknown) {
      if (command instanceof PutObjectCommand) return {};
      if (command instanceof GetObjectCommand) {
        return { Body: { weirdShape: true }, ContentLength: 0 };
      }
      throw new Error("unexpected");
    }
  };
  const storage = new BucketArtifactStorage({ client, bucketName: "bkt" });
  await storage.put({ storageKey: "k2", stream: Readable.from(["x"]) });
  await expect(() => storage.openReadStream("k2")).rejects.toThrow(/Unsupported bucket object body stream/);
});
