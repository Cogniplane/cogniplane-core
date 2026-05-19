import { access, cp, mkdir, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { uuidv7 } from "../../lib/uuid.js";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import * as tar from "tar";

import type { AppConfig } from "../../config.js";

export type StoreBundleInput = {
  tenantId: string;
  skillId: string;
  revisionNumber: number;
  bundleName: string;
  contentHash: string;
  sourcePath: string;
};

export type StoreBundleResult = {
  storageUri: string;
};

export type InstallBundleInput = {
  storageUri: string;
  destinationPath: string;
};

export interface SkillBundleStorage {
  readonly backend: "local" | "bucket";
  storeBundle(input: StoreBundleInput): Promise<StoreBundleResult>;
  installBundle(input: InstallBundleInput): Promise<void>;
  materializeBundle(storageUri: string): Promise<{ localPath: string }>;
  deleteBundle(storageUri: string): Promise<void>;
}

type BucketClient = Pick<S3Client, "send">;

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function parseFileUri(storageUri: string): string {
  if (!storageUri.startsWith("file://")) {
    throw new Error(
      `Expected a file:// storage URI, got ${storageUri}. Check SKILL_BUNDLE_STORAGE_BACKEND.`
    );
  }
  return storageUri.slice("file://".length);
}

type ParsedS3Uri = { bucketName: string; key: string };

function parseS3Uri(storageUri: string): ParsedS3Uri {
  if (!storageUri.startsWith("s3://")) {
    throw new Error(
      `Expected an s3:// storage URI, got ${storageUri}. Check SKILL_BUNDLE_STORAGE_BACKEND.`
    );
  }

  const withoutScheme = storageUri.slice("s3://".length);
  const firstSlash = withoutScheme.indexOf("/");
  if (firstSlash <= 0 || firstSlash === withoutScheme.length - 1) {
    throw new Error(`Malformed s3 URI: ${storageUri}`);
  }

  return {
    bucketName: withoutScheme.slice(0, firstSlash),
    key: withoutScheme.slice(firstSlash + 1)
  };
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

export class LocalSkillBundleStorage implements SkillBundleStorage {
  readonly backend = "local" as const;

  constructor(private readonly rootPath: string) {}

  async storeBundle(input: StoreBundleInput): Promise<StoreBundleResult> {
    const bundlePath = path.join(this.rootPath, input.bundleName, input.contentHash);
    if (await pathExists(bundlePath)) {
      return { storageUri: `file://${bundlePath}` };
    }

    const parentPath = path.dirname(bundlePath);
    const tempPath = path.join(parentPath, `${input.contentHash}.tmp-${uuidv7()}`);
    await mkdir(parentPath, { recursive: true });

    try {
      await cp(input.sourcePath, tempPath, { recursive: true });
      await rename(tempPath, bundlePath);
    } catch (error) {
      await rm(tempPath, { recursive: true, force: true });
      if (await pathExists(bundlePath)) {
        return { storageUri: `file://${bundlePath}` };
      }
      throw error;
    }

    return { storageUri: `file://${bundlePath}` };
  }

  async installBundle(input: InstallBundleInput): Promise<void> {
    const sourcePath = parseFileUri(input.storageUri);
    await rm(input.destinationPath, { recursive: true, force: true });
    await mkdir(path.dirname(input.destinationPath), { recursive: true });
    await cp(sourcePath, input.destinationPath, { recursive: true });
  }

  async materializeBundle(storageUri: string): Promise<{ localPath: string }> {
    const localPath = parseFileUri(storageUri);
    if (!(await pathExists(localPath))) {
      throw new Error(`Skill bundle not found on disk: ${localPath}`);
    }
    return { localPath };
  }

  async deleteBundle(storageUri: string): Promise<void> {
    const bundlePath = parseFileUri(storageUri);
    await rm(bundlePath, { recursive: true, force: true });
  }
}

export type BucketUploader = (input: {
  bucketName: string;
  key: string;
  body: Readable;
  contentType: string;
}) => Promise<void>;

// Default uploader pipes the body to S3 via lib-storage's multipart upload so
// memory stays bounded by the multipart part size, not by the full body.
function defaultBucketUploader(client: BucketClient): BucketUploader {
  return async ({ bucketName, key, body, contentType }) => {
    const upload = new Upload({
      client: client as unknown as S3Client, // Upload requires full S3Client; BucketClient satisfies at runtime
      params: {
        Bucket: bucketName,
        Key: key,
        Body: body,
        ContentType: contentType
      }
    });
    await upload.done();
  };
}

export class BucketSkillBundleStorage implements SkillBundleStorage {
  readonly backend = "bucket" as const;

  private readonly uploader: BucketUploader;

  constructor(
    private readonly deps: {
      client: BucketClient;
      bucketName: string;
      keyPrefix?: string;
      cacheRoot: string;
      // Overridable for tests. Defaults to `lib-storage`'s streaming upload
      // against the real S3Client.
      uploader?: BucketUploader;
    }
  ) {
    this.uploader = deps.uploader ?? defaultBucketUploader(deps.client);
  }

  private buildObjectKey(input: Pick<StoreBundleInput, "tenantId" | "skillId" | "revisionNumber" | "contentHash">): string {
    const prefix = (this.deps.keyPrefix ?? "").trim().replace(/^\/+|\/+$/g, "");
    const baseSegments = [
      "skills",
      encodeURIComponent(input.tenantId),
      encodeURIComponent(input.skillId),
      `${input.revisionNumber}-${input.contentHash}.tar.gz`
    ];
    return prefix ? `${prefix}/${baseSegments.join("/")}` : baseSegments.join("/");
  }

  async storeBundle(input: StoreBundleInput): Promise<StoreBundleResult> {
    const key = this.buildObjectKey(input);

    const tarStream = tar.create(
      {
        cwd: input.sourcePath,
        gzip: true,
        portable: true
      },
      ["."]
    );

    // `tar.create` returns a Minipass stream, which lib-storage's Upload
    // rejects as an unsupported body type. Wrap it in a Node Readable so
    // multipart streaming works without buffering the whole tarball.
    const body = Readable.from(tarStream as Iterable<Buffer>);

    await this.uploader({
      bucketName: this.deps.bucketName,
      key,
      body,
      contentType: "application/gzip"
    });

    return { storageUri: `s3://${this.deps.bucketName}/${key}` };
  }

  private cachePathFor(bucketName: string, key: string): string {
    // Cache layout mirrors the S3 key. Include the bucket name as a segment
    // so two buckets with overlapping relative layouts do not collide in the
    // same local cache (for example after an env-var bucket rename).
    const normalizedPrefix = (this.deps.keyPrefix ?? "").trim().replace(/^\/+|\/+$/g, "");
    const withoutPrefix =
      normalizedPrefix && key.startsWith(`${normalizedPrefix}/`)
        ? key.slice(normalizedPrefix.length + 1)
        : key;
    // Strip the trailing `.tar.gz` so the cache dir name is just `<rev>-<hash>`.
    const withoutSuffix = withoutPrefix.replace(/\.tar\.gz$/, "");
    return path.join(this.deps.cacheRoot, bucketName, withoutSuffix);
  }

  async materializeBundle(storageUri: string): Promise<{ localPath: string }> {
    // Route by the bucket embedded in the persisted URI rather than gating on
    // the currently-configured bucket name. A deployment that later changes
    // `SKILL_BUNDLE_BUCKET_NAME` should still be able to read (and clean up)
    // revisions that were imported before the rename.
    const parsed = parseS3Uri(storageUri);

    const cachePath = this.cachePathFor(parsed.bucketName, parsed.key);
    if (await pathExists(cachePath)) {
      return { localPath: cachePath };
    }

    const response = await this.deps.client.send(
      new GetObjectCommand({
        Bucket: parsed.bucketName,
        Key: parsed.key
      })
    );

    if (!response.Body) {
      throw new Error(`S3 response for ${storageUri} was missing a body.`);
    }

    const tempPath = `${cachePath}.tmp-${uuidv7()}`;
    await mkdir(tempPath, { recursive: true });

    try {
      await pipeline(
        toNodeReadableStream(response.Body),
        tar.extract({
          cwd: tempPath,
          gzip: true,
          strict: true,
          // Reject anything that isn't a regular file or directory. Symlinks
          // and hardlinks could redirect subsequent writes outside the cache
          // dir; device/FIFO entries are never legitimate in a skill bundle.
          // The upload-time validator already rejects these in the source
          // tree — this is the runtime defense for tarballs that bypass the
          // upload path (e.g. direct S3 writes or a replayed object).
          filter: (_path, entry) => {
            const type = (entry as { type?: string }).type;
            return type === "File" || type === "Directory";
          }
        })
      );
      try {
        await rename(tempPath, cachePath);
      } catch (renameError) {
        // If another concurrent caller finished first, accept their result.
        if (await pathExists(cachePath)) {
          await rm(tempPath, { recursive: true, force: true });
        } else {
          throw renameError;
        }
      }
    } catch (error) {
      await rm(tempPath, { recursive: true, force: true });
      throw error;
    }

    return { localPath: cachePath };
  }

  async installBundle(input: InstallBundleInput): Promise<void> {
    const { localPath } = await this.materializeBundle(input.storageUri);
    await rm(input.destinationPath, { recursive: true, force: true });
    await mkdir(path.dirname(input.destinationPath), { recursive: true });
    await cp(localPath, input.destinationPath, { recursive: true });
  }

  async deleteBundle(storageUri: string): Promise<void> {
    const parsed = parseS3Uri(storageUri);
    await this.deps.client.send(
      new DeleteObjectCommand({
        Bucket: parsed.bucketName,
        Key: parsed.key
      })
    );

    const cachePath = this.cachePathFor(parsed.bucketName, parsed.key);
    await rm(cachePath, { recursive: true, force: true });
  }
}

/**
 * Routes bundle operations to the right backend based on the persisted
 * `storageUri` scheme. A deployment that flips `SKILL_BUNDLE_STORAGE_BACKEND`
 * from `local` to `bucket` (or rolls back) must keep honoring revisions
 * imported under the previous backend, so read/delete paths dispatch by URI
 * rather than by env. Writes always use the configured primary backend.
 */
export class CompositeSkillBundleStorage implements SkillBundleStorage {
  readonly backend: "local" | "bucket";

  constructor(
    private readonly deps: {
      primary: SkillBundleStorage;
      local: LocalSkillBundleStorage;
      bucket?: BucketSkillBundleStorage;
    }
  ) {
    this.backend = deps.primary.backend;
  }

  private routeForUri(storageUri: string): SkillBundleStorage {
    if (storageUri.startsWith("file://")) {
      return this.deps.local;
    }
    if (storageUri.startsWith("s3://")) {
      if (!this.deps.bucket) {
        throw new Error(
          `Skill bundle storage URI ${storageUri} requires the bucket backend, ` +
            `but SKILL_BUNDLE_STORAGE_BACKEND is not configured for bucket mode.`
        );
      }
      return this.deps.bucket;
    }
    throw new Error(`Unsupported skill bundle storage URI scheme: ${storageUri}`);
  }

  async storeBundle(input: StoreBundleInput): Promise<StoreBundleResult> {
    return this.deps.primary.storeBundle(input);
  }

  async installBundle(input: InstallBundleInput): Promise<void> {
    return this.routeForUri(input.storageUri).installBundle(input);
  }

  async materializeBundle(storageUri: string): Promise<{ localPath: string }> {
    return this.routeForUri(storageUri).materializeBundle(storageUri);
  }

  async deleteBundle(storageUri: string): Promise<void> {
    return this.routeForUri(storageUri).deleteBundle(storageUri);
  }
}

export function createSkillBundleStorage(config: AppConfig): SkillBundleStorage {
  const local = new LocalSkillBundleStorage(config.SKILL_BUNDLE_STORAGE_ROOT);

  if (config.SKILL_BUNDLE_STORAGE_BACKEND === "local") {
    // No bucket configured — only file:// URIs are reachable. A rollback from
    // bucket mode will surface a clear error on s3:// revisions instead of
    // silently returning stale cache or ENOENT.
    return new CompositeSkillBundleStorage({ primary: local, local });
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

  const bucket = new BucketSkillBundleStorage({
    client,
    bucketName: config.SKILL_BUNDLE_BUCKET_NAME as string,
    keyPrefix: config.SKILL_BUNDLE_BUCKET_PREFIX,
    cacheRoot: config.SKILL_BUNDLE_CACHE_ROOT
  });

  return new CompositeSkillBundleStorage({ primary: bucket, local, bucket });
}

export function defaultSkillBundleCacheRoot(): string {
  return path.join(os.tmpdir(), "cogniplane-skill-cache");
}
