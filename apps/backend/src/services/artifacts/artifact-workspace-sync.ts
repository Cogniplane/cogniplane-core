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
 * share the same name, subsequent ones get a short artifact-ID suffix to
 * avoid overwriting each other.
 */
function uniqueWorkspacePath(artifact: ArtifactRecord, usedNames: Set<string>): string {
  const safe = safeFileName(artifact.artifactName);
  if (!usedNames.has(safe)) {
    usedNames.add(safe);
    return `./artifacts/${safe}`;
  }
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  const shortId = artifact.artifactId.slice(0, 8);
  const deduped = `${stem}_${shortId}${ext}`;
  usedNames.add(deduped);
  return `./artifacts/${deduped}`;
}

// Note: if the agent creates `./artifacts` as a symlink during a prior turn,
// subsequent syncs will follow the symlink. Codex sandbox mode (workspace-write)
// prevents symlinks outside the workspace, so this is intra-workspace only.
// The writeRuntimeFile path check ensures the resolved path stays in the
// workspace regardless.
export async function syncArtifactsToWorkspace(input: {
  sessionId: string;
  scopedArtifacts: ArtifactRecord[];
  storage: ArtifactStorage;
  writeRuntimeFile: (sessionId: string, filePath: string, data: Uint8Array | string) => Promise<string>;
}): Promise<SyncedArtifact[]> {
  const { sessionId, scopedArtifacts, storage, writeRuntimeFile } = input;
  const usedNames = new Set<string>();
  const results: SyncedArtifact[] = [];

  // Process artifacts sequentially to avoid buffering all files in memory
  // at once. With 10 artifacts at up to 25 MB each, concurrent loads could
  // allocate hundreds of MB.
  for (const artifact of scopedArtifacts) {
    const workspacePath = uniqueWorkspacePath(artifact, usedNames);

    // Skip files that exceed the per-file size cap.
    if (artifact.fileSizeBytes > MAX_SYNC_FILE_BYTES) {
      results.push({ artifact, workspacePath, synced: false });
      continue;
    }

    try {
      const handle = await storage.openReadStream(artifact.storageKey);
      const chunks: Uint8Array[] = [];
      for await (const chunk of handle.stream) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      const fileData = Buffer.concat(chunks);
      await writeRuntimeFile(sessionId, workspacePath, fileData);
      results.push({ artifact, workspacePath, synced: true });
    } catch {
      results.push({ artifact, workspacePath, synced: false });
    }
  }

  return results;
}
