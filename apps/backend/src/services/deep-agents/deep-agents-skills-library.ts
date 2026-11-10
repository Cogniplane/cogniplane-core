import { hasSkillInstructions } from "../capability-selection.js";
// Read-only skills library for the Deep Agents runtime.
//
// The library serves enabled skills to the agent as files under /skills/. The
// native deepagents skills middleware surfaces them with progressive
// disclosure: only name/description/path reach the system prompt. The model
// reads the full SKILL.md on demand with read_file. The library also serves the
// bundle companion files with each skill. A bounded process-wide cache
// (SkillCompanionCache) holds one copy of each bundle's companion files for all
// sessions; each build generates SKILL.md again from the current revision.
//
// The library is deliberately NOT staged into the E2B sandbox: it is an
// in-memory backend routed at /skills/ by a CompositeBackend in
// deep-agents-graph.ts, so chat-only sessions stay sandbox-free (laziness
// preserved) and skill content cannot be mutated by the model. The tradeoff:
// `execute` shell commands see the real sandbox filesystem and therefore
// cannot see /skills/ — the workspace note in the graph steers the model to
// the file tools for skill content.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { StateBackend } from "deepagents";
import type {
  BackendProtocolV2,
  EditResult,
  FileUploadResponse,
  WriteResult
} from "deepagents";
import type { FastifyBaseLogger } from "fastify";

import type { RuntimeSkillDefinition } from "../admin-config-records.js";
import type { SkillBundleStorage } from "../skills/skill-bundle-storage.js";

/** Route prefix the CompositeBackend mounts the library under. */
export const SKILLS_LIBRARY_PREFIX = "/skills/";

/**
 * FileData v2 shape (deepagents backends/protocol.ts) — declared structurally
 * so deep-agents-types.ts can reference it without importing the library.
 */
export type SkillsLibraryFileData = {
  content: string | Uint8Array;
  mimeType: string;
  created_at: string;
  modified_at: string;
};

export type SkillsLibraryFiles = Record<string, SkillsLibraryFileData>;

/**
 * Companion files larger than this are skipped with a warning — mirrors the
 * library's MAX_SKILL_FILE_SIZE cap for SKILL.md (10MB).
 */
const MAX_COMPANION_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Limits of the process-wide companion cache. A stored bundle is at most
 * MAX_SKILL_BUNDLE_TOTAL_BYTES (25MB), so the byte limit holds two of the
 * largest bundles.
 */
const COMPANION_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const COMPANION_CACHE_MAX_ENTRIES = 256;

/** Agent Skills spec: names are max 64 chars. */
const MAX_SKILL_SLUG_LENGTH = 64;

/**
 * Mirrors the mime semantics of deepagents' getMimeType/isTextMimeType (the
 * helpers are not exported from the package root): text-ish extensions get a
 * text mime so grep/read treat them as text; everything else is served as
 * binary bytes.
 */
const TEXT_MIME_BY_EXTENSION: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".html": "text/html",
  ".css": "text/css",
  ".xml": "text/xml",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/plain",
  ".ini": "text/plain",
  ".sh": "text/x-shellscript",
  ".py": "text/x-python",
  ".sql": "text/plain",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".cjs": "application/javascript",
  ".ts": "text/plain",
  ".tsx": "text/plain",
  ".jsx": "text/plain",
  ".json": "application/json",
  ".svg": "image/svg+xml"
};

const BINARY_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation"
};

function mimeTypeFor(filePath: string): { mimeType: string; isText: boolean } {
  const ext = path.extname(filePath).toLowerCase();
  const textMime = TEXT_MIME_BY_EXTENSION[ext];
  if (textMime) return { mimeType: textMime, isText: true };
  return { mimeType: BINARY_MIME_BY_EXTENSION[ext] ?? "application/octet-stream", isText: false };
}

/**
 * Agent Skills spec slug: lowercase alphanumeric with single hyphens, no
 * leading/trailing hyphen, max 64 chars, and it must match the skill's
 * directory name (the deepagents loader warns loudly on mismatch, so the
 * generated SKILL.md frontmatter uses the slug as `name` and carries the
 * human-readable name in `metadata.displayName`).
 */
export function slugifySkillName(name: string, fallback: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SKILL_SLUG_LENGTH)
    .replace(/-+$/, "");
  return slug || fallback;
}

/** YAML-safe single-line scalar via JSON string escaping (valid YAML). */
function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function buildSkillMarkdown(slug: string, skill: RuntimeSkillDefinition): string {
  // The middleware requires non-empty name + description in frontmatter and
  // truncates descriptions past 1024 chars with a console warning —
  // pre-truncate to keep runtime logs clean.
  const description = (skill.description?.trim() || `Skill: ${skill.name}`).slice(0, 1024);
  const lines = [
    "---",
    `name: ${yamlScalar(slug)}`,
    `description: ${yamlScalar(description)}`,
    "metadata:",
    `  displayName: ${yamlScalar(skill.name)}`,
    `  skillId: ${yamlScalar(skill.id)}`,
    "---",
    "",
    skill.instructions.trim(),
    ""
  ];
  return lines.join("\n");
}

async function collectBundleFiles(
  rootPath: string,
  relativeDir = ""
): Promise<Array<{ relativePath: string; absolutePath: string }>> {
  const entries = await readdir(path.join(rootPath, relativeDir), { withFileTypes: true });
  const collected: Array<{ relativePath: string; absolutePath: string }> = [];
  for (const entry of entries) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      collected.push(...(await collectBundleFiles(rootPath, relativePath)));
    } else if (entry.isFile()) {
      collected.push({ relativePath, absolutePath: path.join(rootPath, relativePath) });
    }
    // Symlinks and other entry kinds are skipped: bundle content is
    // user-uploaded, and a symlink could point outside the materialized dir.
  }
  return collected;
}

type CompanionFile = {
  relativePath: string;
  mimeType: string;
  /** Shared by every session that serves the bundle. Nothing changes it. */
  content: string | Uint8Array;
};

type CompanionSet = { files: readonly CompanionFile[]; bytes: number };

type CacheSlot = { load: Promise<CompanionSet>; bytes: number };

/**
 * Bounded LRU cache of bundle companion files, shared by the session builds of
 * the process. The key is the storage backend instance and the full storage
 * URI. Both URI layouts hold the tenant id and the content hash, and the
 * storage does not write different bytes under an existing URI, so one key
 * names the same bytes.
 *
 * Concurrent builds of one bundle share one load. A failed load is removed at
 * once, so the next build tries again. Eviction removes only the cache's
 * reference: a session that already serves the bytes keeps them until the
 * session ends, and the next build that needs the bundle reads it again.
 */
export class SkillCompanionCache {
  private readonly slots = new Map<string, CacheSlot>();
  private readonly storageIds = new WeakMap<object, number>();
  private nextStorageId = 1;
  private cachedBytes = 0;

  constructor(private readonly limits: { maxBytes: number; maxEntries: number }) {}

  stats(): { entries: number; bytes: number } {
    return { entries: this.slots.size, bytes: this.cachedBytes };
  }

  get(storage: object, storageUri: string, load: () => Promise<CompanionSet>): Promise<CompanionSet> {
    const key = `${this.storageId(storage)}:${storageUri}`;
    const cached = this.slots.get(key);
    if (cached) {
      // Map order is the LRU order: move the hit to the end.
      this.slots.delete(key);
      this.slots.set(key, cached);
      return cached.load;
    }
    const slot: CacheSlot = { load: load(), bytes: 0 };
    this.slots.set(key, slot);
    this.evict();
    slot.load.then(
      (set) => this.settle(key, slot, set),
      () => {
        if (this.slots.get(key) === slot) this.slots.delete(key);
      }
    );
    return slot.load;
  }

  private storageId(storage: object): number {
    let id = this.storageIds.get(storage);
    if (id === undefined) {
      id = this.nextStorageId;
      this.nextStorageId += 1;
      this.storageIds.set(storage, id);
    }
    return id;
  }

  private settle(key: string, slot: CacheSlot, set: CompanionSet): void {
    // The slot was evicted while it loaded: its builds use the result, but the
    // cache does not keep it.
    if (this.slots.get(key) !== slot) return;
    if (set.bytes > this.limits.maxBytes) {
      this.slots.delete(key);
      return;
    }
    slot.bytes = set.bytes;
    this.cachedBytes += set.bytes;
    this.evict();
  }

  private evict(): void {
    for (const [key, slot] of this.slots) {
      if (this.slots.size <= this.limits.maxEntries && this.cachedBytes <= this.limits.maxBytes) return;
      this.slots.delete(key);
      this.cachedBytes -= slot.bytes;
    }
  }
}

const processCompanionCache = new SkillCompanionCache({
  maxBytes: COMPANION_CACHE_MAX_BYTES,
  maxEntries: COMPANION_CACHE_MAX_ENTRIES
});

/**
 * A plain Uint8Array over the bytes that readFile returned. readFile gives a
 * regular file its own exactly sized buffer; copy only when the Buffer is a
 * view into a larger allocation, so the cache holds no bytes it does not count.
 */
function ownedBytes(data: Buffer): Uint8Array {
  return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
    ? new Uint8Array(data.buffer, 0, data.byteLength)
    : new Uint8Array(data);
}

async function loadCompanions(
  localPath: string,
  skillId: string,
  logger: FastifyBaseLogger
): Promise<CompanionSet> {
  const files: CompanionFile[] = [];
  let bytes = 0;
  for (const companion of await collectBundleFiles(localPath)) {
    // The generated SKILL.md is canonical (revision instructions can be
    // edited after import); the bundle's own copy is not served.
    if (companion.relativePath === "SKILL.md") continue;
    const data = await readFile(companion.absolutePath);
    if (data.byteLength > MAX_COMPANION_FILE_BYTES) {
      logger.warn(
        { skillId, file: companion.relativePath, sizeBytes: data.byteLength },
        "Skill bundle companion file exceeds size cap; skipped from skills library"
      );
      continue;
    }
    const { mimeType, isText } = mimeTypeFor(companion.relativePath);
    files.push({
      relativePath: companion.relativePath,
      mimeType,
      content: isText ? data.toString("utf8") : ownedBytes(data)
    });
    bytes += data.byteLength;
  }
  return { files, bytes };
}

/**
 * Builds the /skills/ library file map for a session from the compiled skill
 * definitions. Layout (paths are keys WITHOUT the /skills/ mount prefix —
 * the CompositeBackend strips/re-adds it):
 *
 *   /<slug>/SKILL.md          generated from name/description/instructions
 *                             (the revision metadata is the source of truth,
 *                             not the bundle's original SKILL.md)
 *   /<slug>/<companion...>    bundle companion files, when the skill has a
 *                             bundle and a storage backend is provided
 *
 * Each build makes new file records. Companion content comes from the
 * companion cache and is shared with other sessions.
 *
 * Per-skill failures degrade (companions skipped, SKILL.md still served);
 * the build never throws for one bad bundle.
 */
export async function buildSkillsLibraryFiles(input: {
  skills: RuntimeSkillDefinition[];
  bundles?: Pick<SkillBundleStorage, "materializeBundle"> | null;
  logger: FastifyBaseLogger;
  /** Defaults to the process-wide cache. */
  companionCache?: SkillCompanionCache;
}): Promise<SkillsLibraryFiles> {
  const { skills, bundles, logger, companionCache = processCompanionCache } = input;
  const files: SkillsLibraryFiles = {};
  const now = new Date().toISOString();
  const usedSlugs = new Set<string>();

  for (const skill of skills) {
    if (!hasSkillInstructions(skill.instructions)) {
      logger.warn({ skillId: skill.id }, "Skill has no instructions; excluded from skills library");
      continue;
    }
    let slug = slugifySkillName(skill.name, `skill-${slugifySkillName(skill.id, "unnamed")}`);
    for (let n = 2; usedSlugs.has(slug); n += 1) {
      slug = `${slug.slice(0, MAX_SKILL_SLUG_LENGTH - `-${n}`.length)}-${n}`;
    }
    usedSlugs.add(slug);

    files[`/${slug}/SKILL.md`] = {
      content: buildSkillMarkdown(slug, skill),
      mimeType: "text/markdown",
      created_at: now,
      modified_at: now
    };

    const storageUri = skill.bundleStorageUri;
    if (!storageUri || !bundles) continue;
    try {
      // Resolve the bundle on every build, also on a cache hit: the storage
      // repeats its containment checks, and a deleted bundle stops serving.
      const { localPath } = await bundles.materializeBundle(storageUri);
      const companions = await companionCache.get(bundles, storageUri, () =>
        loadCompanions(localPath, skill.id, logger)
      );
      for (const companion of companions.files) {
        files[`/${slug}/${companion.relativePath}`] = {
          content: companion.content,
          mimeType: companion.mimeType,
          created_at: now,
          modified_at: now
        };
      }
    } catch (err) {
      logger.warn(
        { err, skillId: skill.id, bundleStorageUri: skill.bundleStorageUri },
        "Failed to materialize skill bundle; serving SKILL.md without companion files"
      );
    }
  }

  return files;
}

const SKILLS_READ_ONLY_MESSAGE =
  "The skills library under /skills/ is read-only. Write files to the workspace instead.";

/**
 * Read-only BackendProtocolV2 over the prebuilt file map. Reads delegate to a
 * legacy-mode StateBackend (pure reads from the injected record — no LangGraph
 * context needed); mutations return protocol errors so the model gets a clear
 * message instead of silently-diverging writes.
 *
 * StateBackend returns the stored Uint8Array itself. Those bytes are shared
 * with the companion cache and other sessions, so the reads return a copy: a
 * caller that changes or transfers the bytes cannot change the library.
 */
export function createSkillsLibraryBackend(files: SkillsLibraryFiles): BackendProtocolV2 {
  const delegate = new StateBackend({ state: { files } });
  const unshared = <T>(filePath: string, content: T): T =>
    content instanceof Uint8Array && content === files[filePath]?.content
      ? (content.slice() as T)
      : content;
  return {
    ls: (dirPath: string) => delegate.ls(dirPath),
    read: (filePath: string, offset?: number, limit?: number) => {
      const result = delegate.read(filePath, offset, limit);
      return result.content === undefined
        ? result
        : { ...result, content: unshared(filePath, result.content) };
    },
    readRaw: (filePath: string) => {
      const result = delegate.readRaw(filePath);
      const stored = files[filePath];
      return stored && result.data?.content instanceof Uint8Array && result.data.content === stored.content
        ? { ...result, data: { ...stored, content: result.data.content.slice() } }
        : result;
    },
    grep: (pattern: string, searchPath?: string | null, glob?: string | null) =>
      delegate.grep(pattern, searchPath ?? "/", glob ?? null),
    glob: (pattern: string, searchPath?: string) => delegate.glob(pattern, searchPath ?? "/"),
    write: (): WriteResult => ({ error: SKILLS_READ_ONLY_MESSAGE }),
    edit: (): EditResult => ({ error: SKILLS_READ_ONLY_MESSAGE }),
    downloadFiles: (paths: string[]) =>
      delegate.downloadFiles(paths).map((response) => ({
        ...response,
        content: unshared(response.path, response.content)
      })),
    uploadFiles: (uploads: Array<[string, Uint8Array]>): FileUploadResponse[] =>
      uploads.map(([uploadPath]) => ({ path: uploadPath, error: "permission_denied" }))
  };
}
