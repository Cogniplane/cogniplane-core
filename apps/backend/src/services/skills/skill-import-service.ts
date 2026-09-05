import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { access, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import JSZip from "jszip";
import { fetch as undiciFetch, type RequestInit, type Response } from "undici";
import YAML from "yaml";

import type { AppConfig } from "../../config.js";
import { AdminConfigError } from "../admin-config-error.js";
import {
  assertDispatcherAwareFetch,
  isPrivateOrReservedHost,
  ssrfSafeAgent
} from "../../lib/url-validation.js";
import type {
  AdminSkillRecord,
  AdminSkillRevisionRecord
} from "../admin-config-records.js";
import type { SkillRevisionStore } from "./skill-revision-store.js";
import type { SkillBundleStorage } from "./skill-bundle-storage.js";
import {
  MAX_SKILL_BUNDLE_FILES,
  MAX_SKILL_BUNDLE_FILE_BYTES,
  MAX_SKILL_BUNDLE_TOTAL_BYTES
} from "./skill-bundle-limits.js";
import {
  validateSkillBundle,
  type SkillBundleValidationMessage
} from "./skill-bundle-validator.js";

function humanizeSkillName(bundleName: string): string {
  return bundleName
    .split(/[-_]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function assertArchiveWithinLimit(archiveBuffer: Buffer, maxBytes: number): void {
  if (archiveBuffer.byteLength > maxBytes) {
    throw new AdminConfigError(`Archive exceeds the maximum allowed size of ${maxBytes} bytes.`);
  }
}

/**
 * Download a response body with a hard byte cap.
 *
 * `response.arrayBuffer()` buffers the whole body first, so checking the size
 * afterwards is too late: a hostile or misconfigured GitHub-compatible host
 * serving a multi-GB zipball takes the process down before the check runs.
 * This aborts mid-download instead.
 */
async function readResponseWithLimit(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number
): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new AdminConfigError(
          `Archive exceeds the maximum allowed size of ${maxBytes} bytes.`
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks);
}

// jszip does not expose an entry's raw compressed bytes or its compression
// method through its public API, but it keeps both on the internal `_data`
// object it builds while parsing the central directory. `inflateEntryBounded`
// needs them, so this type names what we reach for. Pinned by
// `skill-import-service.test.ts`, which builds real archives — a jszip bump
// that reshapes these fails the suite rather than silently disabling the cap.
type ZipEntryWithMetadata = JSZip.JSZipObject & {
  _data?: {
    uncompressedSize?: number;
    compressedSize?: number;
    compressedContent?: Uint8Array;
    compression?: { magic?: string };
  };
};

function getUncompressedSize(entry: JSZip.JSZipObject): number | null {
  const value = (entry as ZipEntryWithMetadata)._data?.uncompressedSize;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function getCompressedSize(entry: JSZip.JSZipObject): number | null {
  const value = (entry as ZipEntryWithMetadata)._data?.compressedSize;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Zip compression method 0 (stored) — the bytes already are the content. */
const ZIP_METHOD_STORE_MAGIC = "\u0000\u0000";
/** Zip compression method 8 (deflate) — the only compressed method we accept. */
const ZIP_METHOD_DEFLATE_MAGIC = "\u0008\u0000";

/**
 * Largest expansion any single entry is allowed, as a multiple of the
 * compressed bytes actually present for it.
 *
 * Generous on purpose. This is not the memory bound — `maxOutputLength` below
 * is, and it is additionally floored by the caller's per-file byte cap. The
 * ratio only rejects the shape of a bomb with a message that explains itself.
 * Measured on real content: prose 2-3x, JSON about 10x, but a legitimately
 * repetitive generated file reaches ~175x, so a tight bound here would reject
 * honest bundles for no safety gain.
 */
const MAX_ZIP_COMPRESSION_RATIO = 1000;

/**
 * Inflate one zip entry with a hard cap on how many bytes may be ALLOCATED.
 *
 * This is the zip-bomb defense, and reaching it meant discarding two designs
 * that look like they work:
 *
 *  - **Trusting `uncompressedSize`.** It comes from the central directory,
 *    which whoever built the archive wrote. Checking a size — or a ratio —
 *    against it proves nothing: a bomb declares 64 bytes and passes every such
 *    check. jszip does compare the inflated length to it, but only on the
 *    stream's "end" event, i.e. after the entry is fully in memory. That
 *    comparison reports the OOM rather than preventing it.
 *
 *  - **Counting bytes off `entry.nodeStream()` and destroying at a cap.**
 *    Measured against jszip 3.10.1: with a 20 MB entry and a 1 KB cap the
 *    internal worker still produced all 20 MB after `destroy()`, and after
 *    `_helper.pause()` too. The Readable stops delivering; the decompression
 *    does not stop running. Streaming bounds what we retain, never what the
 *    process allocates — and allocation is what an OOM is about.
 *
 * So this bypasses jszip's inflater and drives zlib directly, where
 * `maxOutputLength` is enforced inside the decompressor: it throws
 * `ERR_BUFFER_TOO_LARGE` at the limit without allocating past it. Measured on
 * an archive declaring 64 bytes for 50 MB of content, this returns with an RSS
 * delta under 1 MB where `entry.async()` grew the process by the full amount.
 *
 * The budget is the smaller of the ratio allowance and the per-file byte cap,
 * so neither can be escaped by satisfying the other.
 */
function inflateEntryBounded(entry: JSZip.JSZipObject, maxFileBytes: number): Buffer {
  const data = (entry as ZipEntryWithMetadata)._data;
  const compressedContent = data?.compressedContent;
  const magic = data?.compression?.magic;
  const compressedSize = getCompressedSize(entry);

  if (!compressedContent || compressedSize === null || typeof magic !== "string") {
    // A jszip version that reshapes `_data` lands here. Refuse rather than
    // fall back to the unbounded path: an import failing loudly is a far
    // better outcome than the cap quietly ceasing to exist.
    throw new AdminConfigError(
      `Unable to read the compressed contents of zip entry: ${entry.name}`
    );
  }

  const raw = Buffer.from(
    compressedContent.buffer,
    compressedContent.byteOffset,
    compressedContent.byteLength
  );

  if (magic === ZIP_METHOD_STORE_MAGIC) {
    // Stored: no expansion is possible, the bytes are the content.
    if (raw.byteLength > maxFileBytes) {
      throw new AdminConfigError(
        `Zip entry ${entry.name} exceeds the maximum file size of ${maxFileBytes} bytes.`
      );
    }
    return Buffer.from(raw);
  }

  if (magic !== ZIP_METHOD_DEFLATE_MAGIC) {
    throw new AdminConfigError(
      `Zip entry ${entry.name} uses an unsupported compression method.`
    );
  }

  const maxOutputLength = Math.min(
    Math.max(compressedSize, 1) * MAX_ZIP_COMPRESSION_RATIO,
    maxFileBytes
  );

  try {
    return inflateRawSync(raw, { maxOutputLength });
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
      throw new AdminConfigError(
        `Zip entry ${entry.name} expands past the ${maxOutputLength}-byte limit allowed for its ${compressedSize} compressed bytes.`
      );
    }
    throw new AdminConfigError(`Zip entry ${entry.name} could not be decompressed.`);
  }
}

function formatValidationErrors(messages: SkillBundleValidationMessage[]): string {
  if (!messages.length) {
    return "Skill bundle validation failed.";
  }

  return messages
    .map((message) => `${message.path ?? "bundle"}: ${message.message}`)
    .join("\n");
}

async function extractZipArchive(archiveBuffer: Buffer, targetPath: string, maxTotalBytes: number): Promise<void> {
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(archiveBuffer);
  } catch {
    // JSZip rejects with a library error on malformed bytes; that's bad user
    // input, not a server fault — surface it as a 400, not an opaque 500.
    throw new AdminConfigError("Uploaded file is not a valid zip archive.");
  }
  let totalUncompressedBytes = 0;
  let fileCount = 0;
  const maxAllowedTotalBytes = Math.min(MAX_SKILL_BUNDLE_TOTAL_BYTES, maxTotalBytes);
  const maxFileBytes = Math.min(MAX_SKILL_BUNDLE_FILE_BYTES, maxAllowedTotalBytes);

  for (const entry of Object.values(archive.files)) {
    const normalizedPath = normalizeZipEntryPath(entry.name);
    if (!normalizedPath) {
      continue;
    }

    const absolutePath = path.join(targetPath, normalizedPath);
    if (!absolutePath.startsWith(`${targetPath}${path.sep}`) && absolutePath !== targetPath) {
      throw new AdminConfigError(`Unsafe zip entry path: ${entry.name}`);
    }

    if (entry.dir) {
      await mkdir(absolutePath, { recursive: true });
      continue;
    }

    fileCount += 1;
    if (fileCount > MAX_SKILL_BUNDLE_FILES) {
      throw new AdminConfigError(`Skill bundle archive exceeds the maximum file count of ${MAX_SKILL_BUNDLE_FILES}.`);
    }

    // A cheap pre-filter on the DECLARED size: it rejects an honestly
    // oversized archive without touching the compressed bytes. It proves
    // nothing about a bomb — the declared value is written by whoever built
    // the archive — so `inflateEntryBounded` is what actually holds the line.
    const uncompressedSize = getUncompressedSize(entry);
    if (uncompressedSize === null) {
      throw new AdminConfigError(`Unable to determine uncompressed size for zip entry: ${entry.name}`);
    }
    if (uncompressedSize > maxFileBytes) {
      throw new AdminConfigError(`Zip entry ${entry.name} exceeds the maximum file size of ${maxFileBytes} bytes.`);
    }

    await mkdir(path.dirname(absolutePath), { recursive: true });

    // The per-entry allocation budget is also floored by whatever is LEFT of
    // the archive-wide total, so a bomb cannot evade the total by splitting
    // itself across entries that are each individually within the cap.
    const remainingTotalBytes = maxAllowedTotalBytes - totalUncompressedBytes;
    const content = inflateEntryBounded(entry, Math.min(maxFileBytes, remainingTotalBytes));

    // Accumulate the ACTUAL inflated length. The declared value is never
    // summed: it is an input, and a bomb that claims 64 bytes per entry would
    // leave this counter at nothing regardless of what really landed on disk.
    totalUncompressedBytes += content.byteLength;
    if (totalUncompressedBytes > maxAllowedTotalBytes) {
      throw new AdminConfigError(`Skill bundle archive exceeds the maximum uncompressed size of ${maxAllowedTotalBytes} bytes.`);
    }

    await writeFile(absolutePath, content);
  }
}

function normalizeZipEntryPath(entryPath: string): string | null {
  const normalized = path.posix.normalize(entryPath.replace(/\\/g, "/"));
  if (!normalized || normalized === ".") {
    return null;
  }

  if (normalized.startsWith("/") || normalized.startsWith("../") || normalized === "..") {
    throw new AdminConfigError(`Unsafe zip entry path: ${entryPath}`);
  }

  return normalized;
}

function isIgnoredArchiveEntryName(entryName: string): boolean {
  return entryName === "__MACOSX" || entryName.startsWith(".");
}

async function locateArchiveRoot(extractedRoot: string): Promise<string> {
  const entries = await readdir(extractedRoot, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory() && !isIgnoredArchiveEntryName(entry.name))
    .map((entry) => entry.name);

  if (directories.length === 1) {
    return path.join(extractedRoot, directories[0]);
  }

  return extractedRoot;
}

async function findSkillBundleRoots(rootPath: string): Promise<string[]> {
  const candidates = new Set<string>();

  async function walk(currentPath: string): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (isIgnoredArchiveEntryName(entry.name)) {
          continue;
        }

        await walk(path.join(currentPath, entry.name));
        continue;
      }

      if (entry.isFile() && entry.name === "SKILL.md") {
        candidates.add(currentPath);
      }
    }
  }

  await walk(rootPath);
  return [...candidates].sort();
}

async function locateSingleSkillBundleRoot(extractedRoot: string): Promise<string> {
  const archiveRoot = await locateArchiveRoot(extractedRoot);
  const bundleRoots = await findSkillBundleRoots(archiveRoot);

  if (bundleRoots.length !== 1) {
    throw new AdminConfigError("Archive must contain exactly one skill bundle root with SKILL.md.");
  }

  return bundleRoots[0];
}

export function parseGitHubSkillSource(input: {
  githubUrl: string;
  ref?: string;
  subdirectory?: string;
}) {
  const url = new URL(input.githubUrl);
  if (url.hostname !== "github.com") {
    throw new AdminConfigError("Only github.com skill imports are currently supported.");
  }

  const pathParts = url.pathname.split("/").filter(Boolean);
  if (pathParts.length < 2) {
    throw new AdminConfigError("GitHub URL must include an owner and repository.");
  }

  const owner = pathParts[0];
  const repo = pathParts[1]?.replace(/\.git$/, "");
  let ref = input.ref?.trim() || undefined;
  let subdirectory = normalizeRelativeSubdirectory(input.subdirectory);

  if (pathParts.length > 2 && pathParts[2] !== "tree") {
    throw new AdminConfigError("GitHub URL must point to a repository root or tree path.");
  }

  if (pathParts[2] === "tree") {
    if (!pathParts[3]) {
      throw new AdminConfigError("GitHub tree URL must include a ref.");
    }

    ref = ref ?? pathParts[3];
    const treeSubdirectory = pathParts.slice(4).join("/");
    if (treeSubdirectory) {
      subdirectory = subdirectory ?? normalizeRelativeSubdirectory(treeSubdirectory);
    }
  }

  if (!owner || !repo) {
    throw new AdminConfigError("GitHub URL must include an owner and repository.");
  }

  return {
    githubUrl: input.githubUrl,
    owner,
    repo,
    ref,
    subdirectory
  };
}

function normalizeRelativeSubdirectory(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = path.posix.normalize(value.trim().replace(/^\/+|\/+$/g, ""));
  if (!normalized || normalized === ".") {
    return undefined;
  }

  if (normalized.startsWith("../") || normalized === ".." || path.posix.isAbsolute(normalized)) {
    throw new AdminConfigError("subdirectory must stay within the imported repository.");
  }

  return normalized;
}

export const MAX_GITHUB_REDIRECTS = 5;

/**
 * SSRF-safe fetch for admin-triggered GitHub imports. The default dispatcher
 * (`ssrfSafeAgent`) pins every outbound connection to a DNS-validated public IP,
 * closing the rebinding TOCTOU window. On top of that, redirects are followed
 * manually so each `Location` target is re-validated (scheme + private/reserved
 * host) before we connect — GitHub's zipball endpoint 302s to a presigned
 * codeload/S3 URL, and a compromised/malicious upstream could redirect into the
 * internal network. Must use undici's fetch directly: Node's global fetch
 * ignores the `dispatcher` option as of undici v8.
 */
function assertFetchableHttpsUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new AdminConfigError("GitHub import target is not a valid URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new AdminConfigError("GitHub import target must use the https:// scheme.");
  }
  if (isPrivateOrReservedHost(parsed.hostname)) {
    throw new AdminConfigError("GitHub import target resolves to a private or reserved address.");
  }
  return parsed;
}

export async function ssrfSafeGithubFetch(
  url: string,
  init: RequestInit,
  // Fetch used inside the manual-redirect loop. Defaults to undici's fetch
  // (Node's global fetch ignores the `dispatcher` option). Injectable so tests
  // can drive the real redirect/SSRF machinery with a fake.
  fetchFn: typeof undiciFetch = undiciFetch
): Promise<Response> {
  assertDispatcherAwareFetch(fetchFn);
  let currentUrl = assertFetchableHttpsUrl(url).toString();
  const headers = { ...(init.headers as Record<string, string> | undefined) };

  for (let hop = 0; hop <= MAX_GITHUB_REDIRECTS; hop += 1) {
    const response = await fetchFn(currentUrl, {
      ...init,
      headers,
      redirect: "manual",
      dispatcher: ssrfSafeAgent
    });

    if (response.status < 300 || response.status >= 400) {
      return response;
    }

    const location = response.headers.get("location");
    if (!location) {
      return response;
    }
    // Resolve relative redirects against the current URL, then re-validate.
    const next = assertFetchableHttpsUrl(new URL(location, currentUrl).toString());
    // Drop the Authorization header on cross-origin redirects so a token bound
    // to api.github.com is never replayed to a redirect-controlled host.
    if (next.origin !== new URL(currentUrl).origin) {
      delete headers.Authorization;
    }
    currentUrl = next.toString();
  }

  throw new AdminConfigError("GitHub import exceeded the maximum number of redirects.");
}

async function resolveGitHubDefaultBranch(
  source: ReturnType<typeof parseGitHubSkillSource>,
  fetchFn: typeof undiciFetch,
  githubToken?: string
): Promise<string> {
  const response = await ssrfSafeGithubFetch(
    `https://api.github.com/repos/${source.owner}/${source.repo}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "cogniplane-core",
        ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {})
      }
    },
    fetchFn
  );

  if (!response.ok) {
    throw new AdminConfigError(`Unable to resolve default branch for ${source.owner}/${source.repo}.`);
  }

  const payload = (await response.json()) as { default_branch?: string };
  if (!payload.default_branch) {
    throw new AdminConfigError(`Repository ${source.owner}/${source.repo} does not expose a default branch.`);
  }

  return payload.default_branch;
}

function buildGitHubZipballUrl(source: ReturnType<typeof parseGitHubSkillSource>, ref: string): string {
  return `https://api.github.com/repos/${source.owner}/${source.repo}/zipball/${encodeURIComponent(ref)}`;
}

async function resolveGitHubBundleSubdirectory(
  extractedRoot: string,
  subdirectory: string
): Promise<string> {
  const archiveRoot = await locateArchiveRoot(extractedRoot);
  const resolvedPath = path.join(archiveRoot, subdirectory);

  if (!resolvedPath.startsWith(`${archiveRoot}${path.sep}`) && resolvedPath !== archiveRoot) {
    throw new AdminConfigError("GitHub subdirectory resolves outside the repository archive.");
  }

  try {
    await access(resolvedPath);
  } catch {
    // A nonexistent subdirectory is bad user input (the URL/subdirectory the
    // admin typed), not a server fault — don't let the raw ENOENT become an
    // opaque 500.
    throw new AdminConfigError(
      `GitHub subdirectory "${subdirectory}" does not exist in the repository archive.`
    );
  }
  return resolvedPath;
}

function isSingleFileSkillBundle(
  bundle: NonNullable<Awaited<ReturnType<typeof validateSkillBundle>>["bundle"]>
): boolean {
  return bundle.files.length === 1 && bundle.files[0]?.path === "SKILL.md";
}

type SkillRevisionImporter = Pick<SkillRevisionStore, "importSkillBundle">;
type SkillBundleWriter = Pick<SkillBundleStorage, "storeBundle">;

function buildSkillImportPayload(input: {
  tenantId: string;
  validation: Awaited<ReturnType<typeof validateSkillBundle>> & {
    bundle: NonNullable<Awaited<ReturnType<typeof validateSkillBundle>>["bundle"]>;
  };
  bundleLocalPath: string;
  skillBundleStorage: SkillBundleWriter;
  sourceType: "zip" | "github";
  sourceLabel: string;
  createdBy: string;
  extraMetadata?: Record<string, unknown>;
}): Parameters<SkillRevisionImporter["importSkillBundle"]>[1] {
  const { validation } = input;
  // Auto-promote single-file zip/github bundles (SKILL.md only) to inline
  // storage: no bundle is uploaded and the SKILL.md body lives in
  // metadata.instructions. The skill becomes editable in the admin UI.
  const inline = isSingleFileSkillBundle(validation.bundle);
  return {
    skillId: validation.bundle.bundleName,
    skillName: humanizeSkillName(validation.bundle.bundleName),
    description: validation.bundle.description,
    instructions: validation.bundle.instructions,
    sourceType: input.sourceType,
    sourceLabel: input.sourceLabel,
    bundleName: validation.bundle.bundleName,
    bundleHash: validation.bundle.contentHash,
    validationStatus: validation.messages.length ? "validated_with_warnings" : "validated",
    validationMessages: validation.messages,
    metadata: {
      bundleName: validation.bundle.bundleName,
      description: validation.bundle.description,
      license: validation.bundle.license,
      compatibility: validation.bundle.compatibility,
      allowedTools: validation.bundle.allowedTools,
      metadata: validation.bundle.metadata,
      files: validation.bundle.files,
      ...input.extraMetadata
    },
    createdBy: input.createdBy,
    storeBundle: async ({ revisionNumber }) => {
      if (inline) {
        return { storageUri: null };
      }
      return input.skillBundleStorage.storeBundle({
        tenantId: input.tenantId,
        skillId: validation.bundle.bundleName,
        revisionNumber,
        bundleName: validation.bundle.bundleName,
        contentHash: validation.bundle.contentHash,
        sourcePath: input.bundleLocalPath
      });
    }
  };
}

async function validateSkillBundleOrThrow(bundleRootPath: string) {
  const validation = await validateSkillBundle(bundleRootPath);
  const blockingMessages = validation.messages.filter((message) => message.level === "error");
  if (!validation.bundle || blockingMessages.length) {
    throw new AdminConfigError(formatValidationErrors(blockingMessages));
  }

  return {
    ...validation,
    bundle: validation.bundle
  };
}

export async function importSkillBundleFromZip(input: {
  tenantId: string;
  config: AppConfig;
  skillRevisions: SkillRevisionImporter;
  skillBundleStorage: SkillBundleWriter;
  archiveBuffer: Buffer;
  originalFileName: string;
  actorUserId: string;
}): Promise<{ skill: AdminSkillRecord; revision: AdminSkillRevisionRecord }> {
  assertArchiveWithinLimit(input.archiveBuffer, input.config.ARTIFACT_MAX_UPLOAD_BYTES);
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-import-"));

  try {
    await extractZipArchive(input.archiveBuffer, tempRoot, input.config.ARTIFACT_MAX_UPLOAD_BYTES);
    const bundleRootPath = await locateSingleSkillBundleRoot(tempRoot);
    const validation = await validateSkillBundleOrThrow(bundleRootPath);

    return await input.skillRevisions.importSkillBundle(
      input.tenantId,
      buildSkillImportPayload({
        tenantId: input.tenantId,
        validation,
        bundleLocalPath: bundleRootPath,
        skillBundleStorage: input.skillBundleStorage,
        sourceType: "zip",
        sourceLabel: input.originalFileName,
        createdBy: input.actorUserId,
        extraMetadata: {
          importedFromFileName: input.originalFileName
        }
      })
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

const skillIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function buildInlineSkillMarkdown(input: {
  skillId: string;
  description: string;
  instructions: string;
}): string {
  // YAML.stringify handles all quoting cases (colons, leading special chars,
  // multi-line text). The validator we run immediately after parses the
  // result back, so any unrepresentable input fails fast at import time.
  const frontmatter = YAML.stringify({ name: input.skillId, description: input.description }).trimEnd();
  const body = input.instructions.endsWith("\n") ? input.instructions : `${input.instructions}\n`;
  return `---\n${frontmatter}\n---\n${body}`;
}

export async function importSkillBundleFromInline(input: {
  tenantId: string;
  skillRevisions: SkillRevisionImporter;
  skillId: string;
  skillName: string;
  description: string;
  instructions: string;
  actorUserId: string;
}): Promise<{ skill: AdminSkillRecord; revision: AdminSkillRevisionRecord }> {
  const skillId = input.skillId.trim();
  if (!skillIdPattern.test(skillId) || skillId.length > 64) {
    throw new AdminConfigError(
      "skillId must be 1-64 characters using lowercase letters, numbers, and single hyphens."
    );
  }
  if (!input.skillName.trim()) {
    throw new AdminConfigError("skillName is required.");
  }
  if (!input.description.trim()) {
    throw new AdminConfigError("description is required.");
  }
  if (!input.instructions.trim()) {
    throw new AdminConfigError("instructions is required.");
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-import-inline-"));
  try {
    const bundleRootPath = path.join(tempRoot, skillId);
    await mkdir(bundleRootPath, { recursive: true });
    const synthesized = buildInlineSkillMarkdown({
      skillId,
      description: input.description.trim(),
      instructions: input.instructions
    });
    await writeFile(path.join(bundleRootPath, "SKILL.md"), synthesized, "utf8");

    const validation = await validateSkillBundleOrThrow(bundleRootPath);
    const contentHash = createHash("sha256")
      .update("inline\0")
      .update(skillId)
      .update("\0")
      .update(synthesized)
      .digest("hex");

    return await input.skillRevisions.importSkillBundle(input.tenantId, {
      skillId,
      // Honor the user-supplied display name rather than the humanized id.
      skillName: input.skillName.trim(),
      description: validation.bundle.description,
      instructions: validation.bundle.instructions,
      sourceType: "inline",
      sourceLabel: "inline",
      bundleName: skillId,
      bundleHash: contentHash,
      validationStatus: validation.messages.length ? "validated_with_warnings" : "validated",
      validationMessages: validation.messages,
      metadata: {
        bundleName: skillId,
        description: validation.bundle.description,
        license: validation.bundle.license,
        compatibility: validation.bundle.compatibility,
        allowedTools: validation.bundle.allowedTools,
        metadata: validation.bundle.metadata,
        files: validation.bundle.files
      },
      createdBy: input.actorUserId,
      storeBundle: async () => ({ storageUri: null })
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export async function importSkillBundleFromGithub(input: {
  tenantId: string;
  config: AppConfig;
  skillRevisions: SkillRevisionImporter;
  skillBundleStorage: SkillBundleWriter;
  githubUrl: string;
  ref?: string;
  subdirectory?: string;
  actorUserId: string;
  githubToken?: string;
  fetchFn?: typeof undiciFetch;
}): Promise<{ skill: AdminSkillRecord; revision: AdminSkillRevisionRecord }> {
  const fetchFn = input.fetchFn ?? undiciFetch;
  const source = parseGitHubSkillSource({
    githubUrl: input.githubUrl,
    ref: input.ref,
    subdirectory: input.subdirectory
  });
  const resolvedRef = source.ref ?? (await resolveGitHubDefaultBranch(source, fetchFn, input.githubToken));
  const archiveUrl = buildGitHubZipballUrl(source, resolvedRef);
  const response = await ssrfSafeGithubFetch(
    archiveUrl,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "cogniplane-core",
        ...(input.githubToken ? { Authorization: `Bearer ${input.githubToken}` } : {})
      }
    },
    fetchFn
  );
  if (!response.ok) {
    throw new AdminConfigError(`GitHub archive download failed with status ${response.status}.`);
  }

  const archiveBuffer = await readResponseWithLimit(
    response.body as ReadableStream<Uint8Array> | null,
    input.config.ARTIFACT_MAX_UPLOAD_BYTES
  );
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cogniplane-skill-import-github-"));

  try {
    await extractZipArchive(archiveBuffer, tempRoot, input.config.ARTIFACT_MAX_UPLOAD_BYTES);
    const bundleRootPath = source.subdirectory
      ? await resolveGitHubBundleSubdirectory(tempRoot, source.subdirectory)
      : await locateSingleSkillBundleRoot(tempRoot);
    const validation = await validateSkillBundleOrThrow(bundleRootPath);

    return await input.skillRevisions.importSkillBundle(
      input.tenantId,
      buildSkillImportPayload({
        tenantId: input.tenantId,
        validation,
        bundleLocalPath: bundleRootPath,
        skillBundleStorage: input.skillBundleStorage,
        sourceType: "github",
        sourceLabel: `${source.owner}/${source.repo}@${resolvedRef}`,
        createdBy: input.actorUserId,
        extraMetadata: {
          github: {
            url: source.githubUrl,
            owner: source.owner,
            repo: source.repo,
            ref: resolvedRef,
            subdirectory: source.subdirectory
          }
        }
      })
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
