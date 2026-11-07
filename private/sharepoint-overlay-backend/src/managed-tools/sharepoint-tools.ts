import path from "node:path";

import { isArtifactPiiEligible, type ArtifactRecord } from "../../../../apps/backend/src/services/artifacts/artifact-store.js";
import type { ArtifactStorage } from "../../../../apps/backend/src/services/artifacts/artifact-storage.js";
import type { MicrosoftConnectionService } from "../services/microsoft-connection-service.js";
import type {
  MicrosoftFileEntry,
  MicrosoftFilesService,
  MicrosoftSiteEntry
} from "../services/microsoft-files-service.js";
import { downloadGraphContent, readBodyPrefix } from "../services/microsoft-files-service.js";
import { isValidGraphId } from "../services/graph-id-validation.js";
import { buildGraphHeaders } from "../services/graph-http.js";
import {
  allRequiredObjectSchema,
  arraySchema,
  nullableNumberSchema,
  nullableStringSchema,
  safeJsonBody,
  strictObjectSchema,
  withManagedToolErrorSchema,
  type ManagedToolDefinition
} from "../../../../apps/backend/src/services/managed-tools/types.js";
import { boundIntegrationAccount } from "../../../../apps/backend/src/services/integrations/integration-account-binding.js";

const SHAREPOINT_READ_TIMEOUT_MS = 30_000;

type SharepointMicrosoftFiles = {
  listSites(
    input: Parameters<MicrosoftFilesService["listSites"]>[0]
  ): Promise<MicrosoftSiteEntry[]>;
  listFiles(
    input: Parameters<MicrosoftFilesService["listFiles"]>[0]
  ): Promise<
    Array<
      Pick<
        MicrosoftFileEntry,
        | "itemId"
        | "name"
        | "size"
        | "lastModifiedDateTime"
        | "webUrl"
        | "isFolder"
        | "isFile"
        | "mimeType"
        | "driveId"
        | "parentId"
        | "siteId"
      >
    >
  >;
  searchFiles(
    input: Parameters<MicrosoftFilesService["searchFiles"]>[0]
  ): Promise<
    Array<
      Pick<
        MicrosoftFileEntry,
        "itemId" | "name" | "webUrl" | "lastModifiedDateTime" | "driveId" | "parentId" | "siteId"
      > & { summary?: string | null }
    >
  >;
  importFileToSession(
    input: Parameters<MicrosoftFilesService["importFileToSession"]>[0]
  ): Promise<
    Pick<
      ArtifactRecord,
      "artifactId" | "artifactName" | "mimeType" | "fileSizeBytes" | "status" | "storageKey" | "detail"
    >
  >;
};

type SharepointToolDeps = {
  microsoftConnections: Pick<MicrosoftConnectionService, "getRuntimeCredentials">;
  microsoftFiles?: SharepointMicrosoftFiles;
  storage: Pick<ArtifactStorage, "openReadStream">;
  writeRuntimeFile?: (
    sessionId: string,
    runtimeId: string,
    filePath: string,
    data: Uint8Array | ArrayBuffer | string
  ) => Promise<string>;
};

const parentReferenceSchema = allRequiredObjectSchema({
  driveId: nullableStringSchema,
  id: nullableStringSchema,
  siteId: nullableStringSchema
});

const fileItemSchema = strictObjectSchema(
  {
    id: { type: "string" },
    name: { type: "string" },
    size: nullableNumberSchema,
    lastModifiedDateTime: nullableStringSchema,
    webUrl: nullableStringSchema,
    folder: { type: "boolean" },
    file: { type: "boolean" },
    mimeType: nullableStringSchema,
    parentReference: parentReferenceSchema
  },
  ["id", "name", "size", "lastModifiedDateTime", "webUrl", "mimeType", "parentReference"]
);

// ── Catalog entries (static metadata consumed by ./catalog) ──────────────────

export const SHAREPOINT_TOOL_CATALOG: ReadonlyArray<{
  name: string;
  description: string;
  readOnly: boolean;
  inputSchema: Record<string, unknown>;
}> = [
  {
    name: "sharepoint_list_sites",
    description: "List SharePoint sites the user follows, or search sites by name. Returns site IDs, names, and URLs.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        toolContextId: { type: "string" },
        search: { type: "string", description: "Search term to find sites by name. Omit to list followed sites." }
      },
      required: ["toolContextId"],
      additionalProperties: false
    }
  },
  {
    name: "sharepoint_list_files",
    description:
      "List files and folders in a SharePoint document library or the user's OneDrive. Use siteId for SharePoint, omit for OneDrive.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        toolContextId: { type: "string" },
        siteId: { type: "string", description: "SharePoint site ID. Omit to use the user's OneDrive." },
        folderId: { type: "string", description: "Folder item ID to list contents of. Omit for root." },
        driveId: { type: "string", description: "Drive ID. Omit to use the default document library." }
      },
      required: ["toolContextId"],
      additionalProperties: false
    }
  },
  {
    name: "sharepoint_read_file",
    description:
      "Read the text content of a file from SharePoint or OneDrive. Works with text, CSV, markdown, and other text-based files. Returns metadata only for binary files.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        toolContextId: { type: "string" },
        driveId: { type: "string", description: "Drive ID containing the file" },
        itemId: { type: "string", description: "Item ID of the file to read" },
        maxChars: {
          type: "integer",
          minimum: 1,
          maximum: 50000,
          description: "Maximum characters to return (default: 10000)"
        }
      },
      required: ["toolContextId", "driveId", "itemId"],
      additionalProperties: false
    }
  },
  {
    name: "sharepoint_search",
    description:
      "Search across all SharePoint sites and OneDrive files the user has access to. Returns matching documents with snippets.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        toolContextId: { type: "string" },
        query: { type: "string", description: "Search query" },
        maxResults: {
          type: "integer",
          minimum: 1,
          maximum: 25,
          description: "Maximum results to return (default: 10)"
        }
      },
      required: ["toolContextId", "query"],
      additionalProperties: false
    }
  },
  {
    name: "sharepoint_upload_file",
    description: "Upload or create a file in a SharePoint document library or OneDrive folder. Max 4MB.",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        toolContextId: { type: "string" },
        driveId: { type: "string", description: "Drive ID" },
        parentId: { type: "string", description: "Parent folder item ID. Use 'root' for the root folder." },
        filename: { type: "string", description: "File name to create" },
        content: { type: "string", description: "File content (UTF-8 text)" }
      },
      required: ["toolContextId", "driveId", "parentId", "filename", "content"],
      additionalProperties: false
    }
  },
  {
    name: "sharepoint_create_folder",
    description: "Create a folder in a SharePoint document library or OneDrive.",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        toolContextId: { type: "string" },
        driveId: { type: "string", description: "Drive ID" },
        parentId: { type: "string", description: "Parent folder item ID. Use 'root' for the root folder." },
        folderName: { type: "string", description: "Name for the new folder" }
      },
      required: ["toolContextId", "driveId", "parentId", "folderName"],
      additionalProperties: false
    }
  },
  {
    name: "sharepoint_import_file_to_session",
    description:
      "Import a file from SharePoint or OneDrive into the current session as a session artifact so it can be selected later in the chat workspace.",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        toolContextId: { type: "string" },
        driveId: { type: "string", description: "Drive ID containing the file" },
        itemId: { type: "string", description: "Item ID of the file to import" },
        artifactName: { type: "string", description: "Optional name for the imported session artifact" }
      },
      required: ["toolContextId", "driveId", "itemId"],
      additionalProperties: false
    }
  }
];

const TEXT_MIME_PREFIXES = [
  "text/",
  "application/json",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/x-yaml",
  "application/sql"
];

export function createSharepointTools(deps: SharepointToolDeps): ManagedToolDefinition[] {
  return [
    {
      ...SHAREPOINT_TOOL_CATALOG[0], // sharepoint_list_sites
      outputSchema: withManagedToolErrorSchema(
        allRequiredObjectSchema({
          sites: arraySchema(
            allRequiredObjectSchema({
              siteId: { type: "string" },
              name: nullableStringSchema,
              displayName: nullableStringSchema,
              webUrl: nullableStringSchema
            })
          )
        })
      ),
      handler: async ({ context, arguments: args }) => {
        if (!deps.microsoftFiles) return { error: "Microsoft file service is not available." };
        try {
          return {
            sites: await deps.microsoftFiles.listSites({
              tenantId: context.tenantId,
              userId: context.userId,
              expectedAccountId: boundIntegrationAccount(context.metadata, "microsoft"),
              search: args.search ? String(args.search) : null
            })
          };
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      }
    },

    {
      ...SHAREPOINT_TOOL_CATALOG[1], // sharepoint_list_files
      outputSchema: withManagedToolErrorSchema(
        allRequiredObjectSchema({ items: arraySchema(fileItemSchema) })
      ),
      handler: async ({ context, arguments: args }) => {
        if (!deps.microsoftFiles) return { error: "Microsoft file service is not available." };
        try {
          const items = await deps.microsoftFiles.listFiles({
            tenantId: context.tenantId,
            userId: context.userId,
            expectedAccountId: boundIntegrationAccount(context.metadata, "microsoft"),
            siteId: args.siteId ? String(args.siteId) : null,
            driveId: args.driveId ? String(args.driveId) : null,
            folderId: args.folderId ? String(args.folderId) : null
          });
          return {
            items: items.map((item) => ({
              id: item.itemId,
              name: item.name,
              size: item.size,
              lastModifiedDateTime: item.lastModifiedDateTime,
              webUrl: item.webUrl,
              folder: item.isFolder || undefined,
              file: item.isFile || undefined,
              mimeType: item.mimeType,
              parentReference: { driveId: item.driveId, id: item.parentId, siteId: item.siteId }
            }))
          };
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      }
    },

    {
      ...SHAREPOINT_TOOL_CATALOG[2], // sharepoint_read_file
      outputSchema: withManagedToolErrorSchema(
        strictObjectSchema(
          {
            name: { type: "string" },
            mimeType: nullableStringSchema,
            size: nullableNumberSchema,
            content: { type: ["string", "null"] },
            truncated: { type: "boolean" },
            message: { type: "string" },
            webUrl: nullableStringSchema
          },
          ["name", "mimeType", "size", "content"]
        )
      ),
      handler: async ({ context, arguments: args }) => {
        const creds = await deps.microsoftConnections.getRuntimeCredentials(context.tenantId, context.userId,
          boundIntegrationAccount(context.metadata, "microsoft"));
        if (!creds) return { error: "No Microsoft connection found. Connect your Microsoft account in settings." };

        const driveId = String(args.driveId);
        const itemId = String(args.itemId);
        if (!isValidGraphId(driveId)) return { error: "Invalid driveId. Must contain only alphanumeric characters and !,._-" };
        if (!isValidGraphId(itemId)) return { error: "Invalid itemId. Must contain only alphanumeric characters and !,._-" };
        const maxChars = Math.max(1, Math.min(50_000, Number(args.maxChars ?? 10_000) || 10_000));

        // One deadline for the metadata and the content requests.
        const signal = AbortSignal.timeout(SHAREPOINT_READ_TIMEOUT_MS);
        const metaRes = await fetch(
          `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}`,
          { headers: buildGraphHeaders(creds.token), signal }
        );
        if (!metaRes.ok) {
          return { error: `Graph API error ${metaRes.status}`, detail: await safeJsonBody(metaRes) };
        }

        const meta = (await metaRes.json()) as Record<string, unknown>;
        const mimeType = (meta.file as Record<string, unknown> | undefined)?.mimeType as string | undefined;
        const name = meta.name as string;
        const size = meta.size as number;
        const isTextReadable = mimeType && TEXT_MIME_PREFIXES.some((p) => mimeType.startsWith(p));

        if (!isTextReadable) {
          return {
            name,
            mimeType: mimeType ?? "unknown",
            size,
            content: null,
            message: "Binary file — content not readable as text. Use the webUrl to access it directly.",
            webUrl: meta.webUrl
          };
        }

        // The bearer token goes only to Graph, never to the download host it redirects to.
        const contentRes = await downloadGraphContent(
          fetch,
          `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/content`,
          creds.token,
          signal
        );
        if (!contentRes.ok) {
          return { error: `Failed to download file content: ${contentRes.status}` };
        }

        // A UTF-8 character has at most 4 bytes, so this prefix holds maxChars characters.
        const prefix = await readBodyPrefix(contentRes, maxChars * 4);
        // A streaming decode keeps a character cut at the byte limit out of the
        // text, instead of turning it into U+FFFD.
        const text = new TextDecoder().decode(prefix.bytes, { stream: prefix.truncated });
        const truncated = prefix.truncated || text.length > maxChars;
        return { name, mimeType, size, content: truncated ? text.slice(0, maxChars) : text, truncated };
      }
    },

    {
      ...SHAREPOINT_TOOL_CATALOG[3], // sharepoint_search
      outputSchema: withManagedToolErrorSchema(
        allRequiredObjectSchema({
          results: arraySchema(
            allRequiredObjectSchema({
              name: { type: "string" },
              webUrl: nullableStringSchema,
              lastModifiedDateTime: nullableStringSchema,
              summary: nullableStringSchema,
              resource: allRequiredObjectSchema({
                id: { type: "string" },
                parentReference: parentReferenceSchema
              })
            })
          )
        })
      ),
      handler: async ({ context, arguments: args }) => {
        if (!deps.microsoftFiles) return { error: "Microsoft file service is not available." };
        try {
          const results = await deps.microsoftFiles.searchFiles({
            tenantId: context.tenantId,
            userId: context.userId,
            expectedAccountId: boundIntegrationAccount(context.metadata, "microsoft"),
            query: String(args.query),
            maxResults: Math.max(1, Math.min(25, Number(args.maxResults ?? 10) || 10))
          });
          return {
            results: results.map((result) => ({
              name: result.name,
              webUrl: result.webUrl,
              lastModifiedDateTime: result.lastModifiedDateTime,
              summary: result.summary ?? null,
              resource: {
                id: result.itemId,
                parentReference: { driveId: result.driveId, id: result.parentId, siteId: result.siteId }
              }
            }))
          };
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      }
    },

    {
      ...SHAREPOINT_TOOL_CATALOG[4], // sharepoint_upload_file
      outputSchema: withManagedToolErrorSchema(
        strictObjectSchema(
          {
            id: { type: "string" },
            name: { type: "string" },
            size: nullableNumberSchema,
            webUrl: nullableStringSchema,
            createdDateTime: nullableStringSchema
          },
          ["id", "name"]
        )
      ),
      handler: async ({ context, arguments: args }) => {
        const creds = await deps.microsoftConnections.getRuntimeCredentials(context.tenantId, context.userId,
          boundIntegrationAccount(context.metadata, "microsoft"));
        if (!creds) return { error: "No Microsoft connection found. Connect your Microsoft account in settings." };

        const driveId = String(args.driveId);
        const parentId = String(args.parentId);
        const filename = String(args.filename);
        const content = String(args.content);
        if (!isValidGraphId(driveId)) return { error: "Invalid driveId. Must contain only alphanumeric characters and !,._-" };
        if (!isValidGraphId(parentId)) return { error: "Invalid parentId. Must contain only alphanumeric characters and !,._-" };

        const res = await fetch(
          `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${parentId}:/${encodeURIComponent(filename)}:/content`,
          {
            method: "PUT",
            headers: { Authorization: `Bearer ${creds.token}`, "Content-Type": "text/plain" },
            body: content
          }
        );

        const data = await safeJsonBody(res);
        if (!res.ok) return { error: `Graph API error ${res.status}`, detail: data };

        return { id: data.id, name: data.name, size: data.size, webUrl: data.webUrl, createdDateTime: data.createdDateTime };
      }
    },

    {
      ...SHAREPOINT_TOOL_CATALOG[5], // sharepoint_create_folder
      outputSchema: withManagedToolErrorSchema(
        strictObjectSchema(
          {
            id: { type: "string" },
            name: { type: "string" },
            webUrl: nullableStringSchema,
            createdDateTime: nullableStringSchema
          },
          ["id", "name"]
        )
      ),
      handler: async ({ context, arguments: args }) => {
        const creds = await deps.microsoftConnections.getRuntimeCredentials(context.tenantId, context.userId,
          boundIntegrationAccount(context.metadata, "microsoft"));
        if (!creds) return { error: "No Microsoft connection found. Connect your Microsoft account in settings." };

        const driveId = String(args.driveId);
        const parentId = String(args.parentId);
        const folderName = String(args.folderName);
        if (!isValidGraphId(driveId)) return { error: "Invalid driveId. Must contain only alphanumeric characters and !,._-" };
        if (!isValidGraphId(parentId)) return { error: "Invalid parentId. Must contain only alphanumeric characters and !,._-" };

        const res = await fetch(
          `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${parentId}/children`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${creds.token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ name: folderName, folder: {}, "@microsoft.graph.conflictBehavior": "fail" })
          }
        );

        const data = await safeJsonBody(res);
        if (!res.ok) return { error: `Graph API error ${res.status}`, detail: data };

        return { id: data.id, name: data.name, webUrl: data.webUrl, createdDateTime: data.createdDateTime };
      }
    },

    {
      ...SHAREPOINT_TOOL_CATALOG[6], // sharepoint_import_file_to_session
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
        if (!deps.microsoftFiles) return { error: "Microsoft file service is not available." };
        try {
          const artifact = await deps.microsoftFiles.importFileToSession({
            tenantId: context.tenantId,
            userId: context.userId,
            expectedAccountId: boundIntegrationAccount(context.metadata, "microsoft"),
            sessionId: context.sessionId,
            driveId: String(args.driveId),
            itemId: String(args.itemId),
            artifactName: args.artifactName ? String(args.artifactName) : null,
            createdByType: "tool",
            createdByRef: context.messageId
          });

          // Best-effort: write to sandbox workspace so the agent can read it natively.
          // Skip files over 10 MB to avoid OOM, and files the PII scan has not cleared.
          if (
            deps.writeRuntimeFile &&
            deps.storage &&
            artifact.fileSizeBytes <= 10 * 1024 * 1024 &&
            isArtifactPiiEligible(artifact)
          ) {
            try {
              const handle = await deps.storage.openReadStream(artifact.storageKey);
              const chunks: Uint8Array[] = [];
              for await (const chunk of handle.stream) {
                chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
              }
              const fileData = Buffer.concat(chunks);
              const safeName = path.basename(artifact.artifactName) || artifact.artifactName;
              const ext = path.extname(safeName);
              const stem = safeName.slice(0, safeName.length - ext.length);
              await deps.writeRuntimeFile(
                context.sessionId,
                context.runtimeId,
                // The full ID: a UUIDv7 prefix is a timestamp, not unique.
                `./artifacts/${stem}_${artifact.artifactId}${ext}`,
                fileData
              );
            } catch {
              // Non-fatal: file is still in S3 artifacts
            }
          }

          return {
            artifactId: artifact.artifactId,
            artifactName: artifact.artifactName,
            mimeType: artifact.mimeType,
            fileSizeBytes: artifact.fileSizeBytes,
            status: artifact.status
          };
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      }
    }
  ];
}
