import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";

import type { AppConfig } from "../../config.js";

export type StoredArtifact = {
  storageBackend: "local" | "bucket";
  storageKey: string;
  fileSizeBytes: number;
  checksumSha256: string;
};

export type ArtifactReadHandle = {
  stream: NodeJS.ReadableStream;
  fileSizeBytes: number;
};

export interface ArtifactStorage {
  readonly backend: "local" | "bucket";
  put(input: { storageKey: string; stream: Readable }): Promise<StoredArtifact>;
  openReadStream(storageKey: string): Promise<ArtifactReadHandle>;
}

type BucketClient = Pick<S3Client, "send">;

function createDigestTransform(onChunk: (size: number, chunk: Buffer) => void): Transform {
  return new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      onChunk(buffer.length, buffer);
      callback(null, buffer);
    }
  });
}

function resolveStoragePath(root: string, storageKey: string): string {
  const resolved = path.resolve(root, storageKey);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Invalid storage key.");
  }

  return resolved;
}

function resolveBucketKey(prefix: string, storageKey: string): string {
  const normalizedKey = storageKey.replace(/^\/+/, "");
  const normalizedPrefix = prefix.trim().replace(/^\/+|\/+$/g, "");
  return normalizedPrefix ? `${normalizedPrefix}/${normalizedKey}` : normalizedKey;
}

function toNodeReadableStream(body: unknown): NodeJS.ReadableStream {
  if (body && typeof body === "object" && "pipe" in body && typeof body.pipe === "function") {
    return body as NodeJS.ReadableStream;
  }

  if (
    body &&
    typeof body === "object" &&
    "transformToWebStream" in body &&
    typeof body.transformToWebStream === "function"
  ) {
    return Readable.fromWeb(
      (body as { transformToWebStream(): ReadableStream }).transformToWebStream() as NodeReadableStream
    );
  }

  throw new Error("Unsupported bucket object body stream.");
}

async function readStreamAsBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

export class LocalArtifactStorage implements ArtifactStorage {
  readonly backend = "local" as const;

  constructor(private readonly root: string) {}

  async put(input: { storageKey: string; stream: Readable }): Promise<StoredArtifact> {
    const targetPath = resolveStoragePath(this.root, input.storageKey);
    await mkdir(path.dirname(targetPath), { recursive: true });

    let fileSizeBytes = 0;
    const hash = createHash("sha256");
    const digest = createDigestTransform((size, chunk) => {
      fileSizeBytes += size;
      hash.update(chunk);
    });

    try {
      await pipeline(input.stream, digest, createWriteStream(targetPath, { flags: "wx" }));
    } catch (error) {
      await rm(targetPath, { force: true });
      throw error;
    }

    return {
      storageBackend: this.backend,
      storageKey: input.storageKey,
      fileSizeBytes,
      checksumSha256: hash.digest("hex")
    };
  }

  async openReadStream(storageKey: string): Promise<ArtifactReadHandle> {
    const targetPath = resolveStoragePath(this.root, storageKey);
    const info = await stat(targetPath);
    return {
      stream: createReadStream(targetPath),
      fileSizeBytes: info.size
    };
  }
}

export class BucketArtifactStorage implements ArtifactStorage {
  readonly backend = "bucket" as const;

  constructor(
    private readonly deps: {
      client: BucketClient;
      bucketName: string;
      keyPrefix?: string;
    }
  ) {}

  async put(input: { storageKey: string; stream: Readable }): Promise<StoredArtifact> {
    const key = resolveBucketKey(this.deps.keyPrefix ?? "", input.storageKey);
    const body = await readStreamAsBuffer(input.stream);
    const fileSizeBytes = body.length;
    const checksumSha256 = createHash("sha256").update(body).digest("hex");

    await this.deps.client.send(
      new PutObjectCommand({
        Bucket: this.deps.bucketName,
        Key: key,
        Body: body,
        ContentLength: fileSizeBytes
      })
    );

    return {
      storageBackend: this.backend,
      storageKey: input.storageKey,
      fileSizeBytes,
      checksumSha256
    };
  }

  async openReadStream(storageKey: string): Promise<ArtifactReadHandle> {
    const key = resolveBucketKey(this.deps.keyPrefix ?? "", storageKey);
    const response = await this.deps.client.send(
      new GetObjectCommand({
        Bucket: this.deps.bucketName,
        Key: key
      })
    );

    if (!response.Body) {
      throw new Error("Bucket object response was missing a body.");
    }

    return {
      stream: toNodeReadableStream(response.Body),
      fileSizeBytes: Number(response.ContentLength ?? 0)
    };
  }
}

export function createArtifactStorage(config: AppConfig): ArtifactStorage {
  if (config.ARTIFACT_STORAGE_BACKEND === "local") {
    return new LocalArtifactStorage(config.ARTIFACT_STORAGE_ROOT);
  }

  const client = new S3Client({
    region: config.ARTIFACT_BUCKET_REGION,
    endpoint: config.ARTIFACT_BUCKET_ENDPOINT,
    forcePathStyle: config.ARTIFACT_BUCKET_FORCE_PATH_STYLE,
    credentials: config.ARTIFACT_BUCKET_ACCESS_KEY_ID
      ? {
          accessKeyId: config.ARTIFACT_BUCKET_ACCESS_KEY_ID,
          secretAccessKey: config.ARTIFACT_BUCKET_SECRET_ACCESS_KEY as string,
          sessionToken: config.ARTIFACT_BUCKET_SESSION_TOKEN
        }
      : undefined
  });

  return new BucketArtifactStorage({
    client,
    bucketName: config.ARTIFACT_BUCKET_NAME as string,
    keyPrefix: config.ARTIFACT_BUCKET_PREFIX
  });
}
