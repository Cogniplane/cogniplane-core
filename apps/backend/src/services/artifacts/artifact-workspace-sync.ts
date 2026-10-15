import path from "node:path";

import type { ArtifactRecord } from "./artifact-store.js";
import type { ArtifactStorage } from "./artifact-storage.js";

export type SyncedArtifact = {
  artifact: ArtifactRecord;
  workspacePath: string;
  synced: boolean;
};

// Skip syncing individual files larger than 10 MB to avoid OOM under
// concurrent artifact loads. The file is still available via the fallback
// text-extraction path in buildArtifactTurnInputs.
const MAX_SYNC_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Strip directory components and path traversal sequences from an artifact
 * name so it can be used safely as a filename under `./artifacts/`.
 */
function safeFileName(artifactName: string): string {
  const base = path.basename(artifactName);
  if (!base || base === "." || base === "..") {
    return "unnamed";
  }
  return base;
}

/**
 * Build a unique workspace path for an artifact. When multiple artifacts
 * share the same name, subsequent ones get the full artifact-ID suffix. A
 * UUIDv7 prefix is a timestamp, so a short prefix is not unique.
 */
function uniqueWorkspacePath(artifact: ArtifactRecord, usedNames: Set<string>): string {
  const safe = safeFileName(artifact.artifactName);
  if (!usedNames.has(safe)) {
    usedNames.add(safe);
    return `./artifacts/${safe}`;
  }
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  let deduped = `${stem}_${artifact.artifactId}${ext}`;
  // A user file can already have this name.
  for (let n = 2; usedNames.has(deduped); n++) deduped = `${stem}_${artifact.artifactId}_${n}${ext}`;
  usedNames.add(deduped);
  return `./artifacts/${deduped}`;
}

// Note: if the agent creates `./artifacts` as a symlink during a prior turn,
// subsequent syncs will follow the symlink. The writeRuntimeFile path check
// ensures the resolved path stays in the workspace regardless.
export async function syncArtifactsToWorkspace(input: {
  sessionId: string;
  scopedArtifacts: ArtifactRecord[];
  storage: Pick<ArtifactStorage, "openReadStream">;
  signal?: AbortSignal;
  writeRuntimeFile: (sessionId: string, filePath: string, data: Uint8Array | string) => Promise<string>;
}): Promise<SyncedArtifact[]> {
  const { sessionId, scopedArtifacts, storage, signal, writeRuntimeFile } = input;
  const usedNames = new Set<string>();
  const results: SyncedArtifact[] = [];

  // Process artifacts sequentially to avoid buffering all files in memory
  // at once. With 10 artifacts at up to 25 MB each, concurrent loads could
  // allocate hundreds of MB.
  for (const artifact of scopedArtifacts) {
    if (signal?.aborted) break;
    const workspacePath = uniqueWorkspacePath(artifact, usedNames);

    // Skip files that exceed the per-file size cap.
    if (artifact.fileSizeBytes > MAX_SYNC_FILE_BYTES) {
      results.push({ artifact, workspacePath, synced: false });
      continue;
    }

    try {
      const handle = await storage.openReadStream(artifact.storageKey, { signal });
      const abortStream = () => {
        if ("destroy" in handle.stream && typeof handle.stream.destroy === "function") {
          handle.stream.destroy();
        }
      };
      signal?.addEventListener("abort", abortStream, { once: true });
      const chunks: Uint8Array[] = [];
      try {
        for await (const chunk of handle.stream) {
          signal?.throwIfAborted();
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        }
      } finally {
        signal?.removeEventListener("abort", abortStream);
      }
      signal?.throwIfAborted();
      const fileData = Buffer.concat(chunks);
      await writeRuntimeFile(sessionId, workspacePath, fileData);
      results.push({ artifact, workspacePath, synced: true });
    } catch {
      if (signal?.aborted) break;
      results.push({ artifact, workspacePath, synced: false });
    }
  }

  return results;
}
