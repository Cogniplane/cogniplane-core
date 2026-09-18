import { isTextReadableArtifact, readStreamAsBoundedText } from "../artifacts/artifact-helpers.js";
import type { ArtifactStorage } from "../artifacts/artifact-storage.js";
import type {
  ProjectConflictMetadata,
  ProjectRuntimeFileSnapshot,
  ProjectFileStore
} from "../project-file-store.js";
import type { RequestLimitsInterface } from "../request-limits.js";
import { ToolCallError } from "../../lib/tool-call-error.js";
import { allRequiredObjectSchema, arraySchema, withManagedToolErrorSchema, type ManagedToolDefinition } from "./types.js";
import { inferMimeType } from "./write-artifact.js";

const MAX_READ_CHARS = 50_000;

export const PROJECT_TOOL_CATALOG = [
  {
    name: "project_list_files",
    description: "List project files in the stable snapshot for this interactive turn. Selected files are prioritized; truncated is true when the snapshot does not contain the whole library.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: { toolContextId: { type: "string" } },
      required: ["toolContextId"],
      additionalProperties: false
    }
  },
  {
    name: "project_read_file",
    description: "Read a text project file from the stable version captured when this interactive project turn started.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        toolContextId: { type: "string" },
        fileId: { type: "string" },
        maxChars: { type: "integer", minimum: 1, maximum: MAX_READ_CHARS }
      },
      required: ["toolContextId", "fileId"],
      additionalProperties: false
    }
  },
  {
    name: "project_get_conflict_context",
    description: "Read the immutable base, latest published, and proposed text versions for an explicitly selected project draft. This is read-only in every project mode; reconciliation requires read-write mode.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        toolContextId: { type: "string" },
        draftId: { type: "string" }
      },
      required: ["toolContextId", "draftId"],
      additionalProperties: false
    }
  },
  {
    name: "project_reconcile_conflict",
    description: "Create a new draft containing a reconciled text conflict. The original draft stays unchanged, and a person must promote the result.",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        toolContextId: { type: "string" },
        draftId: { type: "string" },
        content: { type: "string" }
      },
      required: ["toolContextId", "draftId", "content"],
      additionalProperties: false
    }
  },
  {
    name: "project_write_file",
    description: "Create a project draft during an interactive project turn. Read-write mode can propose an update with a target and base version; no agent call publishes, deletes, or changes folders.",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        toolContextId: { type: "string" },
        name: { type: "string" },
        content: { type: "string" },
        filePath: { type: "string" },
        mimeType: { type: "string" },
        folderId: { type: ["string", "null"] },
        targetFileId: { type: ["string", "null"] },
        baseVersionId: { type: ["string", "null"] }
      },
      required: ["toolContextId", "name"],
      additionalProperties: false
    }
  }
] as const;

type ProjectToolDeps = {
  projectFiles: Pick<ProjectFileStore, "readRuntimeSnapshotFile" | "createAgentDraftFromContent" | "readConflictContext" | "readConflictMetadata">;
  storage: Pick<ArtifactStorage, "openReadStream" | "put" | "delete">;
  readRuntimeFile?: (sessionId: string, runtimeId: string, filePath: string) => Promise<Uint8Array>;
  statRuntimeFile?: (sessionId: string, runtimeId: string, filePath: string) => Promise<{ sizeBytes: number }>;
  maxProjectFileBytes: number;
  limits?: Pick<RequestLimitsInterface, "consumeRateLimit" | "refundRateLimit">;
};

type ProjectContext = {
  projectId: string;
  agentFileMode: "read-only" | "create-only" | "read-write";
  snapshot: ProjectRuntimeFileSnapshot;
};

function projectContext(context: { metadata: Record<string, unknown> }): ProjectContext {
  const value = context.metadata.projectContext;
  if (!value || typeof value !== "object") throw new ToolCallError("This session is not connected to a project.");
  const project = value as Record<string, unknown>;
  if (typeof project.projectId !== "string" || !project.projectId) {
    throw new ToolCallError("The project file context is invalid.");
  }
  if (project.agentFileMode !== "read-only" && project.agentFileMode !== "create-only" && project.agentFileMode !== "read-write") {
    throw new ToolCallError("The project file mode is unavailable.");
  }
  const snapshot = project.snapshot;
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray((snapshot as Record<string, unknown>).files)) {
    throw new ToolCallError("The project file snapshot is unavailable.");
  }
  return {
    projectId: project.projectId,
    agentFileMode: project.agentFileMode,
    snapshot: snapshot as ProjectRuntimeFileSnapshot
  };
}

function actor(context: { tenantId: string; userId: string }, projectId: string) {
  return { tenantId: context.tenantId, userId: context.userId, projectId };
}

function catalogTool(name: string) {
  const tool = PROJECT_TOOL_CATALOG.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Unknown project tool catalog entry: ${name}`);
  return tool;
}

export function createProjectTools(deps: ProjectToolDeps): ManagedToolDefinition[] {
  return [
    {
      ...catalogTool("project_list_files"),
      outputSchema: allRequiredObjectSchema({
        truncated: { type: "boolean" },
        files: arraySchema(allRequiredObjectSchema({
          fileId: { type: "string" },
          name: { type: "string" },
          kind: { type: "string" },
          folderId: { type: ["string", "null"] },
          versionId: { type: "string" },
          versionNumber: { type: "integer" },
          mimeType: { type: "string" },
          selected: { type: "boolean" }
        }))
      }),
      handler: async ({ context }) => {
        const project = projectContext(context);
        return {
          truncated: project.snapshot.truncated === true,
          files: project.snapshot.files.map((file) => ({
            fileId: file.fileId,
            name: file.name,
            kind: file.kind,
            folderId: file.folderId,
            versionId: file.versionId,
            versionNumber: file.versionNumber,
            mimeType: file.mimeType,
            selected: file.selected === true
          }))
        };
      }
    },
    {
      ...catalogTool("project_read_file"),
      outputSchema: withManagedToolErrorSchema(allRequiredObjectSchema({
        fileId: { type: "string" },
        name: { type: "string" },
        versionId: { type: "string" },
        versionNumber: { type: "integer" },
        content: { type: "string" },
        truncated: { type: "boolean" }
      })),
      handler: async ({ context, arguments: args }) => {
        const project = projectContext(context);
        const fileId = String(args.fileId ?? "");
        if (!fileId) throw new ToolCallError("fileId is required.");
        const entry = project.snapshot.files.find((file) => file.fileId === fileId);
        if (!entry) throw new ToolCallError("The file is not available in this turn's project snapshot.");
        if (!isTextReadableArtifact(entry.mimeType)) {
          throw new ToolCallError("This project file is not a supported text format. Download it or use manual recovery.");
        }
        const content = await deps.projectFiles.readRuntimeSnapshotFile({
          actor: actor(context, project.projectId),
          snapshot: project.snapshot,
          fileId,
          sessionId: context.sessionId,
          messageId: context.messageId,
          storage: deps.storage
        });
        const maxChars = Math.max(1, Math.min(MAX_READ_CHARS, Number(args.maxChars ?? 10_000) || 10_000));
        // The bounded reader reports overflow separately, so a complete file
        // that exactly fills the requested budget is not marked truncated.
        const bounded = await readStreamAsBoundedText(content.stream.stream, maxChars);
        return {
          fileId,
          name: content.name,
          versionId: entry.versionId,
          versionNumber: entry.versionNumber,
          content: bounded.text,
          truncated: bounded.truncated
        };
      }
    },
    {
      ...catalogTool("project_get_conflict_context"),
      outputSchema: withManagedToolErrorSchema(allRequiredObjectSchema({
        draftId: { type: "string" },
        targetFileId: { type: "string" },
        name: { type: "string" },
        folderId: { type: ["string", "null"] },
        mimeType: { type: "string" },
        baseVersionId: { type: "string" },
        baseVersionNumber: { type: "integer" },
        latestVersionId: { type: "string" },
        latestVersionNumber: { type: "integer" },
        baseContent: { type: "string" },
        latestContent: { type: "string" },
        proposedContent: { type: "string" }
      })),
      handler: async ({ context, arguments: args }) => {
        const project = projectContext(context);
        const draftId = String(args.draftId ?? "");
        const selected = project.snapshot.files.find((file) => file.fileId === draftId);
        if (!selected || selected.kind !== "draft" || selected.selected !== true) {
          throw new ToolCallError("Select this project draft for the turn before resolving its conflict.");
        }
        const conflict = await deps.projectFiles.readConflictContext({
          actor: actor(context, project.projectId),
          draftId,
          sessionId: context.sessionId,
          messageId: context.messageId,
          storage: deps.storage
        });
        return conflict;
      }
    },
    {
      ...catalogTool("project_reconcile_conflict"),
      outputSchema: withManagedToolErrorSchema(allRequiredObjectSchema({
        draftId: { type: "string" },
        name: { type: "string" },
        targetFileId: { type: "string" },
        baseVersionId: { type: "string" },
        status: { type: "string", enum: ["draft"] }
      })),
      handler: async ({ context, arguments: args }) => {
        const project = projectContext(context);
        if (project.agentFileMode !== "read-write") {
          throw new ToolCallError("Conflict resolution requires read-write project agent mode.");
        }
        const content = String(args.content ?? "");
        if (!content.length) throw new ToolCallError("content is required.");
        const contentBytes = new TextEncoder().encode(content);
        if (contentBytes.length > deps.maxProjectFileBytes) {
          throw new ToolCallError("The reconciled draft exceeds the configured project-file size limit.");
        }
        const draftId = String(args.draftId ?? "");
        const selected = project.snapshot.files.find((file) => file.fileId === draftId);
        if (!selected || selected.kind !== "draft" || selected.selected !== true) {
          throw new ToolCallError("Select this project draft for the turn before resolving its conflict.");
        }
        const conflict: ProjectConflictMetadata = await deps.projectFiles.readConflictMetadata({
          actor: actor(context, project.projectId),
          draftId,
          sessionId: context.sessionId,
          messageId: context.messageId
        });
        const rateLimitInput = {
          resource: "project_file_write" as const,
          userId: context.userId,
          tenantId: context.tenantId
        };
        const limitError = await deps.limits?.consumeRateLimit(rateLimitInput);
        if (limitError) throw new ToolCallError(limitError.message);
        const charged = Boolean(deps.limits);
        try {
          const draft = await deps.projectFiles.createAgentDraftFromContent({
            actor: actor(context, project.projectId),
            name: conflict.name,
            folderId: conflict.folderId,
            targetFileId: conflict.targetFileId,
            baseVersionId: conflict.latestVersionId,
            mimeType: conflict.mimeType,
            content: contentBytes,
            storage: deps.storage,
            maxBytes: deps.maxProjectFileBytes,
            createdByType: "agent"
          });
          return {
            draftId: draft.fileId,
            name: draft.name,
            targetFileId: draft.targetFileId,
            baseVersionId: draft.baseVersionId,
            status: "draft"
          };
        } catch (error) {
          if (charged) await deps.limits?.refundRateLimit?.(rateLimitInput);
          throw error;
        }
      }
    },
    {
      ...catalogTool("project_write_file"),
      outputSchema: withManagedToolErrorSchema(allRequiredObjectSchema({
        draftId: { type: "string" },
        name: { type: "string" },
        targetFileId: { type: ["string", "null"] },
        baseVersionId: { type: ["string", "null"] },
        status: { type: "string", enum: ["draft"] }
      })),
      handler: async ({ context, arguments: args }) => {
        const project = projectContext(context);
        if (project.agentFileMode === "read-only") {
          throw new ToolCallError("This project's agent file mode is read-only.");
        }
        const name = String(args.name ?? "").trim();
        if (!name) throw new ToolCallError("name is required.");
        const hasContent = args.content !== undefined && args.content !== null;
        const hasFilePath = typeof args.filePath === "string" && args.filePath.trim().length > 0;
        if (!hasContent && !hasFilePath) throw new ToolCallError("Either content or filePath is required.");
        if (hasContent && hasFilePath) throw new ToolCallError("Provide content or filePath, not both.");
        let bytes: Uint8Array;
        if (hasFilePath) {
          if (!deps.readRuntimeFile) throw new ToolCallError("filePath is not supported on this runtime.");
          const filePath = String(args.filePath).trim();
          const stat = await deps.statRuntimeFile?.(context.sessionId, context.runtimeId, filePath);
          if (stat && stat.sizeBytes > deps.maxProjectFileBytes) throw new ToolCallError("The project draft exceeds the configured project-file size limit.");
          bytes = await deps.readRuntimeFile(context.sessionId, context.runtimeId, filePath);
        } else {
          bytes = new TextEncoder().encode(String(args.content));
        }
        const targetFileId = args.targetFileId == null ? null : String(args.targetFileId);
        const baseVersionId = args.baseVersionId == null ? null : String(args.baseVersionId);
        if ((targetFileId === null) !== (baseVersionId === null)) {
          throw new ToolCallError("targetFileId and baseVersionId must be provided together.");
        }
        if (bytes.length === 0) throw new ToolCallError("The project draft cannot be empty.");
        if (bytes.length > deps.maxProjectFileBytes) {
          throw new ToolCallError("The project draft exceeds the configured project-file size limit.");
        }
        const rateLimitInput = {
          resource: "project_file_write" as const,
          userId: context.userId,
          tenantId: context.tenantId
        };
        const limitError = await deps.limits?.consumeRateLimit(rateLimitInput);
        if (limitError) throw new ToolCallError(limitError.message);
        const charged = Boolean(deps.limits);
        try {
          const draft = await deps.projectFiles.createAgentDraftFromContent({
            actor: actor(context, project.projectId),
            name,
            folderId: args.folderId == null ? null : String(args.folderId),
            targetFileId,
            baseVersionId,
            mimeType: args.mimeType ? String(args.mimeType) : inferMimeType(name),
            content: bytes,
            storage: deps.storage,
            maxBytes: deps.maxProjectFileBytes,
            createdByType: "agent"
          });
          return {
            draftId: draft.fileId,
            name: draft.name,
            targetFileId: draft.targetFileId,
            baseVersionId: draft.baseVersionId,
            status: "draft"
          };
        } catch (error) {
          if (charged) await deps.limits?.refundRateLimit?.(rateLimitInput);
          throw error;
        }
      }
    }
  ];
}
