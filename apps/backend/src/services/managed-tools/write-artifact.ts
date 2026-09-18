import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { uuidv7 } from "../../lib/uuid.js";

import type { ArtifactStorage } from "../artifacts/artifact-storage.js";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import type { AuditEventStore } from "../audit-event-store.js";
import { ProjectFileError, type ProjectFileStore } from "../project-file-store.js";
import type { RequestLimitsInterface } from "../request-limits.js";
import { ToolCallError } from "../../lib/tool-call-error.js";
import { strictObjectSchema, withManagedToolErrorSchema, type ManagedToolDefinition } from "./types.js";

type WriteArtifactDeps = {
  artifacts: Pick<ArtifactStore, "createGenerated">;
  storage: Pick<ArtifactStorage, "put" | "openReadStream" | "delete">;
  auditEvents: Pick<AuditEventStore, "create">;
  readRuntimeFile?: (sessionId: string, runtimeId: string, filePath: string) => Promise<Uint8Array>;
  statRuntimeFile?: (
    sessionId: string,
    runtimeId: string,
    filePath: string
  ) => Promise<{ sizeBytes: number }>;
  artifactMaxBytes: number;
  limits?: Pick<RequestLimitsInterface, "consumeRateLimit" | "refundRateLimit">;
  projectFiles?: Pick<ProjectFileStore, "createAgentDraftFromContent">;
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
      "Save a file as a session artifact so the user can view and download it from the Artifacts panel. Call this for every file you create. In a project turn with create-only or read-write agent file mode, this also creates a project draft for human review; use project_write_file for an intentional project-file update. Provide either content (inline text) or filePath (workspace path to read the file from the sandbox).",
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

export function createWriteArtifactTool(deps: WriteArtifactDeps): ManagedToolDefinition[] {
  return [
    {
      ...WRITE_ARTIFACT_CATALOG[0], // write_artifact
      outputSchema: withManagedToolErrorSchema(
        strictObjectSchema({
          artifactId: { type: "string" },
          artifactName: { type: "string" },
          mimeType: { type: "string" },
          fileSizeBytes: { type: "number" },
          status: { type: "string" },
          projectDraftId: { type: ["string", "null"] },
          projectDraftError: { type: ["string", "null"] }
        }, [
          "artifactId",
          "artifactName",
          "mimeType",
          "fileSizeBytes",
          "status",
          "projectDraftId",
          "projectDraftError"
        ])
      ),
      handler: async ({ context, arguments: args }) => {
        const name = String(args.name ?? "").trim();
        if (!name) throw new ToolCallError("name is required.");

        const hasContent = args.content != null && String(args.content) !== "";
        const hasFilePath = args.filePath != null && String(args.filePath).trim() !== "";
        if (!hasContent && !hasFilePath) throw new ToolCallError("Either content or filePath is required.");
        if (hasContent && hasFilePath) throw new ToolCallError("Provide content or filePath, not both.");

        let contentBuffer: Buffer;
        if (hasFilePath) {
          if (!deps.readRuntimeFile) throw new ToolCallError("filePath is not supported on this runtime backend.");
          const filePath = String(args.filePath).trim();
          // Probe the size BEFORE buffering the file into backend memory —
          // an oversized sandbox file must not be read just to be rejected.
          if (deps.statRuntimeFile) {
            const { sizeBytes } = await deps.statRuntimeFile(context.sessionId, context.runtimeId, filePath);
            if (sizeBytes > deps.artifactMaxBytes) {
              throw new ToolCallError(`File too large (${sizeBytes} bytes). Maximum is ${deps.artifactMaxBytes} bytes.`);
            }
          }
          const bytes = await deps.readRuntimeFile(context.sessionId, context.runtimeId, filePath);
          contentBuffer = Buffer.from(bytes);
        } else {
          contentBuffer = Buffer.from(String(args.content), "utf-8");
        }

        if (contentBuffer.length === 0) throw new ToolCallError("File is empty.");
        if (contentBuffer.length > deps.artifactMaxBytes) {
          throw new ToolCallError(`File too large (${contentBuffer.length} bytes). Maximum is ${deps.artifactMaxBytes} bytes.`);
        }

        const mimeType = args.mimeType ? String(args.mimeType) : inferMimeType(name);
        const checksumSha256 = createHash("sha256").update(contentBuffer).digest("hex");
        const safeExt = name.lastIndexOf(".") >= 0
          ? name.slice(name.lastIndexOf(".")).slice(0, 32).replace(/[^a-zA-Z0-9._-]/g, "")
          : "";
        const storageKey = `${context.userId}/${context.sessionId}/${uuidv7()}${safeExt}`;

        const stored = await deps.storage.put({ storageKey, stream: Readable.from([contentBuffer]) });

        let artifact;
        try {
          artifact = await deps.artifacts.createGenerated({
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
        } catch (error) {
          // The object is not recoverable by artifact GC until its database row
          // exists. Remove it when the transaction rejects, preserving the
          // original authorization/database error for the caller.
          await deps.storage.delete(stored.storageKey).catch(() => undefined);
          throw error;
        }

        let projectDraftId: string | null = null;
        let projectDraftError: string | null = null;
        const projectContext = context.metadata.projectContext;
        const project = projectContext && typeof projectContext === "object"
          ? projectContext as { projectId?: unknown; agentFileMode?: unknown; snapshot?: unknown }
          : null;
        const runtimePolicy = context.metadata.runtimePolicy;
        const enabledToolIds = runtimePolicy && typeof runtimePolicy === "object"
          ? (runtimePolicy as { enabledToolIds?: unknown }).enabledToolIds
          : null;
        const projectWriteEnabled = Array.isArray(enabledToolIds) && enabledToolIds.includes("project_write_file");
        if (deps.projectFiles && project?.projectId &&
            projectWriteEnabled &&
            (project.agentFileMode === "create-only" || project.agentFileMode === "read-write")) {
          const rateLimitInput = {
            resource: "project_file_write" as const,
            userId: context.userId,
            tenantId: context.tenantId
          };
          let projectWriteRateCharged = false;
          try {
            const limitError = await deps.limits?.consumeRateLimit(rateLimitInput);
            if (limitError) {
              projectDraftError = limitError.message;
            } else {
              projectWriteRateCharged = Boolean(deps.limits);
              const snapshot = project.snapshot && typeof project.snapshot === "object"
                ? project.snapshot as { files?: unknown }
                : null;
              const target = project.agentFileMode === "read-write" && snapshot && Array.isArray(snapshot.files)
                ? snapshot.files.find((entry): entry is { fileId: string; versionId: string; name: string; folderId: string | null; kind: string } =>
                    Boolean(entry) && typeof entry === "object" &&
                    (entry as Record<string, unknown>).kind === "published" &&
                    (entry as Record<string, unknown>).folderId === null &&
                    typeof (entry as Record<string, unknown>).fileId === "string" &&
                    typeof (entry as Record<string, unknown>).versionId === "string" &&
                    typeof (entry as Record<string, unknown>).name === "string" &&
                    (entry as Record<string, string>).name.toLowerCase() === name.toLowerCase())
                : undefined;
              const draft = await deps.projectFiles.createAgentDraftFromContent({
                actor: {
                  tenantId: context.tenantId,
                  userId: context.userId,
                  projectId: String(project.projectId)
                },
                name,
                folderId: null,
                targetFileId: target?.fileId ?? null,
                baseVersionId: target?.versionId ?? null,
                mimeType,
                content: new Uint8Array(contentBuffer),
                storage: deps.storage,
                maxBytes: deps.artifactMaxBytes,
                createdByType: "agent",
                stored
              });
              projectDraftId = draft.fileId;
            }
          } catch (error) {
            if (projectWriteRateCharged) {
              const refund = deps.limits?.refundRateLimit?.(rateLimitInput);
              if (refund) await refund.catch(() => undefined);
            }
            // The session artifact is already committed. Preserve that useful
            // result and tell the model why the optional project copy failed.
            projectDraftError = error instanceof ProjectFileError
              ? error.message
              : "The session artifact was saved, but the project draft could not be created.";
          }
        }

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
          status: artifact.status,
          projectDraftId,
          projectDraftError
        };
      }
    }
  ];
}
