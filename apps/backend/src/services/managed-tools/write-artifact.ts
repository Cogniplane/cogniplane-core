import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { uuidv7 } from "../../lib/uuid.js";

import type { ArtifactStorage } from "../artifacts/artifact-storage.js";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import type { AuditEventStore } from "../audit-event-store.js";
import { allRequiredObjectSchema, withManagedToolErrorSchema, type ManagedToolDefinition } from "./types.js";

type WriteArtifactDeps = {
  artifacts: ArtifactStore;
  storage: ArtifactStorage;
  auditEvents: AuditEventStore;
  readRuntimeFile?: (sessionId: string, runtimeId: string, filePath: string) => Promise<Uint8Array>;
};

// ── MIME type inference ───────────────────────────────────────────────────────

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

export function inferMimeType(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return "text/plain";
  return MIME_BY_EXTENSION[filename.slice(dot).toLowerCase()] ?? "text/plain";
}

// ── Catalog entry (static metadata consumed by ./catalog) ────────────────────

export const WRITE_ARTIFACT_CATALOG: ReadonlyArray<{
  name: string;
  description: string;
  readOnly: boolean;
  inputSchema: Record<string, unknown>;
}> = [
  {
    name: "write_artifact",
    description:
      "Save a file as a session artifact so the user can view and download it from the Artifacts panel. Call this for every file you create. Provide either content (inline text) or filePath (workspace path to read the file from the sandbox).",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        toolContextId: { type: "string" },
        name: { type: "string", description: "Filename with extension (e.g. report.py, analysis.csv)" },
        content: {
          type: "string",
          description: "Complete file content as text. Use this OR filePath, not both."
        },
        filePath: {
          type: "string",
          description:
            "Workspace path to the file (e.g. ./output.png). The server reads the file directly from the sandbox. Use this OR content, not both."
        },
        mimeType: { type: "string", description: "MIME type. Inferred from extension if omitted." }
      },
      required: ["toolContextId", "name"],
      additionalProperties: false
    }
  }
];

// ── Tool definition ───────────────────────────────────────────────────────────

const MAX_FILE_BYTES = 10_000_000;

export function createWriteArtifactTool(deps: WriteArtifactDeps): ManagedToolDefinition[] {
  return [
    {
      ...WRITE_ARTIFACT_CATALOG[0], // write_artifact
      outputSchema: withManagedToolErrorSchema(
        allRequiredObjectSchema({
          artifactId: { type: "string" },
          artifactName: { type: "string" },
          mimeType: { type: "string" },
          fileSizeBytes: { type: "number" },
          status: { type: "string" }
        })
      ),
      handler: async ({ context, arguments: args }) => {
        const name = String(args.name ?? "").trim();
        if (!name) throw new Error("name is required.");

        const hasContent = args.content != null && String(args.content) !== "";
        const hasFilePath = args.filePath != null && String(args.filePath).trim() !== "";
        if (!hasContent && !hasFilePath) throw new Error("Either content or filePath is required.");
        if (hasContent && hasFilePath) throw new Error("Provide content or filePath, not both.");

        let contentBuffer: Buffer;
        if (hasFilePath) {
          if (!deps.readRuntimeFile) throw new Error("filePath is not supported on this runtime backend.");
          const filePath = String(args.filePath).trim();
          const bytes = await deps.readRuntimeFile(context.sessionId, context.runtimeId, filePath);
          contentBuffer = Buffer.from(bytes);
        } else {
          contentBuffer = Buffer.from(String(args.content), "utf-8");
        }

        if (contentBuffer.length === 0) throw new Error("File is empty.");
        if (contentBuffer.length > MAX_FILE_BYTES) {
          throw new Error(`File too large (${contentBuffer.length} bytes). Maximum is ${MAX_FILE_BYTES} bytes (10 MB).`);
        }

        const mimeType = args.mimeType ? String(args.mimeType) : inferMimeType(name);
        const checksumSha256 = createHash("sha256").update(contentBuffer).digest("hex");
        const safeExt = name.lastIndexOf(".") >= 0
          ? name.slice(name.lastIndexOf(".")).slice(0, 32).replace(/[^a-zA-Z0-9._-]/g, "")
          : "";
        const storageKey = `${context.userId}/${context.sessionId}/${uuidv7()}${safeExt}`;

        const stored = await deps.storage.put({ storageKey, stream: Readable.from([contentBuffer]) });

        const artifact = await deps.artifacts.create({
          tenantId: context.tenantId,
          artifactType: "generated",
          sessionId: context.sessionId,
          userId: context.userId,
          artifactName: name,
          mimeType,
          storageBackend: stored.storageBackend,
          storageKey: stored.storageKey,
          fileSizeBytes: stored.fileSizeBytes,
          checksumSha256,
          status: "ready",
          createdByType: "tool",
          createdByRef: context.messageId,
          detail: { source: "write_artifact" }
        });

        await deps.auditEvents.create({
          tenantId: context.tenantId,
          sessionId: context.sessionId,
          userId: context.userId,
          type: "artifact_generated",
          payload: {
            artifactId: artifact.artifactId,
            artifactType: artifact.artifactType,
            artifactName: artifact.artifactName,
            mimeType: artifact.mimeType,
            fileSizeBytes: artifact.fileSizeBytes,
            source: "write_artifact"
          }
        });

        return {
          artifactId: artifact.artifactId,
          artifactName: artifact.artifactName,
          mimeType: artifact.mimeType,
          fileSizeBytes: artifact.fileSizeBytes,
          status: artifact.status
        };
      }
    }
  ];
}
