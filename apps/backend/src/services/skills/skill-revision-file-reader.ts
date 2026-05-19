import { stat, readFile } from "node:fs/promises";
import path from "node:path";

import type { AdminSkillRevisionRecord } from "../admin-config-records.js";
import type { SkillBundleStorage } from "./skill-bundle-storage.js";

export const SKILL_FILE_PREVIEW_LIMIT_BYTES = 1_048_576;

export type SkillFilePreview =
  | {
      kind: "ok";
      filePath: string;
      sizeBytes: number;
      encoding: "utf8" | "base64";
      content: string;
      contentType: string;
    }
  | { kind: "not_found" }
  | { kind: "too_large"; sizeBytes: number; limitBytes: number };

const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".py": "text/x-python",
  ".ts": "text/x-typescript",
  ".tsx": "text/x-typescript",
  ".js": "text/javascript",
  ".jsx": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".json": "application/json",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/plain",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".sh": "application/x-sh",
  ".bash": "application/x-sh",
  ".txt": "text/plain",
  ".sql": "text/plain",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml"
};

function contentTypeFromExtension(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_CONTENT_TYPES[ext] ?? "application/octet-stream";
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  for (const byte of sample) {
    if (byte === 0) return true;
  }
  return false;
}

function getManifestPaths(revision: AdminSkillRevisionRecord): Set<string> {
  const files = revision.metadata.files;
  if (!Array.isArray(files)) return new Set();

  const paths = new Set<string>();
  for (const entry of files) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as { path?: unknown }).path === "string"
    ) {
      paths.add((entry as { path: string }).path);
    }
  }
  return paths;
}

export async function readSkillRevisionFile(input: {
  revision: AdminSkillRevisionRecord;
  requestedPath: string;
  limitBytes?: number;
  skillBundleStorage: SkillBundleStorage;
}): Promise<SkillFilePreview> {
  const limitBytes = input.limitBytes ?? SKILL_FILE_PREVIEW_LIMIT_BYTES;
  const bundleStorageUri = input.revision.bundleStorageUri;

  // Inline skills (single-file SKILL.md, edited in-app) have no bundle on
  // disk; SKILL.md content lives in metadata.instructions.
  if (!bundleStorageUri) {
    if (input.requestedPath !== "SKILL.md") {
      return { kind: "not_found" };
    }
    const instructions = input.revision.metadata.instructions;
    if (typeof instructions !== "string") {
      return { kind: "not_found" };
    }
    const buffer = Buffer.from(instructions, "utf8");
    if (buffer.byteLength > limitBytes) {
      return { kind: "too_large", sizeBytes: buffer.byteLength, limitBytes };
    }
    return {
      kind: "ok",
      filePath: "SKILL.md",
      sizeBytes: buffer.byteLength,
      encoding: "utf8",
      content: instructions,
      contentType: "text/markdown"
    };
  }

  const manifestPaths = getManifestPaths(input.revision);
  if (!manifestPaths.has(input.requestedPath)) {
    return { kind: "not_found" };
  }

  let localPath: string;
  try {
    const materialized = await input.skillBundleStorage.materializeBundle(bundleStorageUri);
    localPath = materialized.localPath;
  } catch {
    return { kind: "not_found" };
  }

  const resolvedRoot = path.resolve(localPath);
  const resolvedTarget = path.resolve(resolvedRoot, input.requestedPath);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    return { kind: "not_found" };
  }

  let stats;
  try {
    stats = await stat(resolvedTarget);
  } catch {
    return { kind: "not_found" };
  }

  if (!stats.isFile()) {
    return { kind: "not_found" };
  }

  if (stats.size > limitBytes) {
    return { kind: "too_large", sizeBytes: stats.size, limitBytes };
  }

  const buffer = await readFile(resolvedTarget);
  const contentType = contentTypeFromExtension(input.requestedPath);
  const isImage = contentType.startsWith("image/");
  const encoding: "utf8" | "base64" = isImage || looksBinary(buffer) ? "base64" : "utf8";

  return {
    kind: "ok",
    filePath: input.requestedPath,
    sizeBytes: stats.size,
    encoding,
    content: encoding === "utf8" ? buffer.toString("utf8") : buffer.toString("base64"),
    contentType
  };
}
