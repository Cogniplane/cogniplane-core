import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { Readable } from "node:stream";
import { uuidv7 } from "../../lib/uuid.js";

import type { ArtifactStorage } from "./artifact-storage.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { AuditEventStore } from "../audit-event-store.js";

// Extensions swept from the workspace after each turn.
// Dotfiles and hidden directories are always excluded.
const SWEEP_EXTENSIONS = new Set([
  ".py", ".js", ".ts", ".jsx", ".tsx",
  ".html", ".htm", ".css",
  ".md", ".txt", ".csv", ".tsv",
  ".json", ".sh", ".yaml", ".yml",
  ".sql", ".xml",
  ".png", ".jpg", ".jpeg", ".gif", ".webp"
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  ".py":   "text/x-python",
  ".js":   "text/javascript",
  ".ts":   "text/x-typescript",
  ".jsx":  "text/javascript",
  ".tsx":  "text/x-typescript",
  ".html": "text/html",
  ".htm":  "text/html",
  ".css":  "text/css",
  ".md":   "text/markdown",
  ".txt":  "text/plain",
  ".csv":  "text/csv",
  ".tsv":  "text/tab-separated-values",
  ".json": "application/json",
  ".sh":   "application/x-sh",
  ".yaml": "application/yaml",
  ".yml":  "application/yaml",
  ".sql":  "application/sql",
  ".xml":  "application/xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".webp": "image/webp"
};

// Directories relative to workspacePath that are never swept.
const EXCLUDED_DIR_NAMES = new Set([".codex", ".framework", "node_modules", ".git", "artifacts"]);
const EXCLUDED_FILE_NAMES = new Set(["AGENTS.md"]);

async function collectWorkspaceFiles(workspacePath: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }

    for (const name of names) {
      if (name.startsWith(".")) continue;
      if (dir === workspacePath && EXCLUDED_FILE_NAMES.has(name)) continue;

      const fullPath = join(dir, name);
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(fullPath);
      } catch {
        continue;
      }

      if (info.isDirectory()) {
        // Only exclude top-level special dirs
        if (dir === workspacePath && EXCLUDED_DIR_NAMES.has(name)) continue;
        await walk(fullPath);
      } else if (info.isFile()) {
        const ext = extname(name).toLowerCase();
        if (SWEEP_EXTENSIONS.has(ext)) {
          results.push(fullPath);
        }
      }
    }
  }

  await walk(workspacePath);
  return results;
}

// Returns a name not present in `taken`, disambiguating collisions as
// `base (1).ext`, `base (2).ext`, … (the suffix lands before the extension so
// the file type stays obvious). The chosen name is added to `taken` so callers
// can reserve it atomically within a single sweep before yielding to await.
function reserveUniqueName(fileName: string, taken: Set<string>): string {
  if (!taken.has(fileName)) {
    taken.add(fileName);
    return fileName;
  }

  const ext = extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  for (let n = 1; ; n += 1) {
    const candidate = `${base} (${n})${ext}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

/**
 * Captures newly generated files in the runtime workspace into the
 * `artifacts` table after a turn completes. Does NOT delete files from the
 * workspace — the workspace persists across turns by design (see CLAUDE.md
 * "Workspace sync"). Behavior:
 *
 * - Invoked fire-and-forget after `response.completed` is queued (errors
 *   are logged at the call site; never block the user-visible response).
 * - Walks `workspacePath`, skipping dotfiles, `EXCLUDED_DIR_NAMES`
 *   (`.codex`, `.framework`, `node_modules`, `.git`, `artifacts`), and
 *   files in `EXCLUDED_FILE_NAMES` (`AGENTS.md`).
 * - Only files with extensions in `SWEEP_EXTENSIONS` are considered.
 * - Idempotent by workspace SOURCE PATH (`detail.workspacePath`): a file
 *   already captured by a prior sweep is skipped. A newly generated file whose
 *   name collides with an existing artifact (e.g. an upload) is captured under
 *   a disambiguated name (`report (1).txt`) rather than silently dropped.
 * - Size cap: 500KB text, 5MB images. Empty and over-cap files are skipped.
 * - Each registered artifact is `artifactType: "generated"`,
 *   `createdByType: "system"`, `createdByRef: "workspace-sweep"` and emits
 *   an `artifact_generated` audit event with `source: "workspace-sweep"`.
 *   Those wire strings are part of the analytics contract and intentionally
 *   retain the legacy "sweep" terminology even though the function captures
 *   rather than removes.
 */
export async function captureWorkspaceArtifacts(input: {
  tenantId: string;
  sessionId: string;
  userId: string;
  workspacePath: string;
  artifacts: ArtifactStore;
  storage: ArtifactStorage;
  auditEvents: AuditEventStore;
}): Promise<void> {
  const [files, existingArtifacts] = await Promise.all([
    collectWorkspaceFiles(input.workspacePath),
    input.artifacts.listBySession(input.tenantId, input.sessionId, input.userId)
  ]);

  // Idempotency is keyed on the workspace SOURCE PATH, not the artifact name:
  // a generated file is "already captured" only if a prior sweep registered
  // that exact path (recorded in `detail.workspacePath`). Keying on name would
  // wrongly drop a generated file whose name collides with an upload, and would
  // also re-disambiguate the same file on every sweep.
  const capturedPaths = new Set(
    existingArtifacts
      .filter((a) => a.artifactType === "generated")
      .map((a) => a.detail.workspacePath)
      .filter((p): p is string => typeof p === "string")
  );

  // Names already taken (uploads, derived, and previously-captured generated
  // files). A new capture whose filename collides is DISAMBIGUATED rather than
  // dropped. Shared and mutated across the sweep so two new files with the same
  // base name in one run also get distinct names.
  const takenNames = new Set(existingArtifacts.map((a) => a.artifactName));

  await Promise.all(
    files.map(async (filePath) => {
      const fileName = filePath.split("/").pop()!;
      // Already captured this exact file in a prior sweep — idempotent skip.
      if (capturedPaths.has(filePath)) return;

      // Reserve a collision-free name SYNCHRONOUSLY (before any await) so two
      // concurrent files with the same base name in one sweep cannot both
      // claim it. `reserveUniqueName` mutates `takenNames` in place.
      const artifactName = reserveUniqueName(fileName, takenNames);

      let content: Buffer;
      let fileSize: number;
      try {
        content = await readFile(filePath);
        fileSize = (await stat(filePath)).size;
      } catch {
        return; // file disappeared between scan and read — skip
      }

      const ext = extname(fileName).toLowerCase();
      const mimeType = MIME_BY_EXTENSION[ext] ?? "text/plain";
      const maxBytes = mimeType.startsWith("image/") ? 5_000_000 : 500_000;
      if (fileSize === 0 || fileSize > maxBytes) return;
      const checksumSha256 = createHash("sha256").update(content).digest("hex");
      const safeExt = ext.slice(0, 32).replace(/[^a-zA-Z0-9._-]/g, "");
      const storageKey = `${input.userId}/${input.sessionId}/${uuidv7()}${safeExt}`;

      let stored: Awaited<ReturnType<typeof input.storage.put>>;
      try {
        stored = await input.storage.put({
          storageKey,
          stream: Readable.from([content])
        });
      } catch {
        return;
      }

      const artifact = await input.artifacts.create({
        tenantId: input.tenantId,
        artifactType: "generated",
        sessionId: input.sessionId,
        userId: input.userId,
        artifactName,
        mimeType,
        storageBackend: stored.storageBackend,
        storageKey: stored.storageKey,
        fileSizeBytes: stored.fileSizeBytes,
        checksumSha256,
        status: "ready",
        createdByType: "system",
        createdByRef: "workspace-sweep",
        detail: { source: "workspace-sweep", workspacePath: filePath }
      });

      await input.auditEvents.create({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        userId: input.userId,
        type: "artifact_generated",
        payload: {
          artifactId: artifact.artifactId,
          artifactType: artifact.artifactType,
          artifactName: artifact.artifactName,
          mimeType: artifact.mimeType,
          fileSizeBytes: artifact.fileSizeBytes,
          source: "workspace-sweep"
        }
      });
    })
  );
}
