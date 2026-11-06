import { Readable } from "node:stream";

import { ALLOWED_ARTIFACT_MIME_TYPES } from "../../../../apps/backend/src/lib/allowed-mime-types.js";
import type { ArtifactRecord } from "../../../../apps/backend/src/services/artifacts/artifact-store.js";
import type { UploadAdmission } from "../../../../apps/backend/src/services/artifacts/upload-admission.js";
import { safeJsonBody } from "../../../../apps/backend/src/services/managed-tools/types.js";
import type { MicrosoftConnectionService, MicrosoftRuntimeCredentials } from "./microsoft-connection-service.js";
import { assertValidGraphId } from "./graph-id-validation.js";
import { buildGraphHeaders } from "./graph-http.js";

type GraphDriveItem = Record<string, unknown>;

export type MicrosoftSiteEntry = {
  siteId: string;
  name: string | null;
  displayName: string | null;
  webUrl: string | null;
};

export type MicrosoftFileEntry = {
  itemId: string;
  driveId: string;
  parentId: string | null;
  siteId: string | null;
  name: string;
  webUrl: string | null;
  size: number | null;
  mimeType: string | null;
  isFolder: boolean;
  isFile: boolean;
  lastModifiedDateTime: string | null;
  path: string | null;
  source: "onedrive" | "sharepoint";
  summary: string | null;
};

export class MicrosoftConnectionRequiredError extends Error {
  constructor(message = "No Microsoft connection found. Connect your Microsoft account in settings.") {
    super(message);
  }
}

export class MicrosoftGraphRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail: Record<string, unknown> | null = null
  ) {
    super(message);
  }
}

export class MicrosoftUnsupportedImportError extends Error {
  constructor(message: string) {
    super(message);
  }
}

// The PII import scope of this overlay. `bootstrap` registers it. All three
// values are persisted (scan jobs, audit payloads, the tenant policy), so do
// not change them.
export const MICROSOFT_IMPORT_PII_SCOPE = {
  subjectKind: "microsoft_import",
  scopeKey: "microsoftImports",
  defaultOn: true
} as const;

export class MicrosoftImportBlockedError extends Error {
  readonly blockReason: string;
  readonly scanRunId: string;
  constructor(blockReason: string, scanRunId: string) {
    super(`Import blocked by organization policy (${blockReason}).`);
    this.blockReason = blockReason;
    this.scanRunId = scanRunId;
  }
}

export class MicrosoftImportTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Microsoft file exceeds the ${maxBytes}-byte import limit.`);
  }
}

export class MicrosoftImportPiiScanError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// Cap on redirect hops when downloading file content. Microsoft Graph `/content`
// answers with a single 302 to a short-lived, pre-authenticated download URL on a
// Microsoft-owned host; a handful of hops is generous headroom.
const MAX_CONTENT_REDIRECTS = 5;

// The `/content` download target is chosen entirely by an authenticated Graph
// response under the user's own token (not by any caller-supplied input), so the
// realistic threat is narrow. We still refuse to chase a redirect that downgrades
// to a non-HTTPS scheme — that is the one transition that could leak the response
// (or, with a bearer header attached, a token) onto the clear. IP pinning is
// deliberately NOT attempted: Microsoft serves content from rotating CDN/blob
// hosts, so a static IP/host allowlist would be brittle and break real downloads.
function assertHttpsRedirect(location: string, base: string): URL {
  const target = new URL(location, base);
  if (target.protocol !== "https:") {
    throw new MicrosoftGraphRequestError(
      `Refusing to follow non-HTTPS redirect to ${target.protocol}//${target.host}`,
      502
    );
  }
  return target;
}

function toOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value : null;
}

function toOptionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getParentReference(item: GraphDriveItem): Record<string, unknown> | null {
  const parentReference = item.parentReference;
  return parentReference && typeof parentReference === "object"
    ? (parentReference as Record<string, unknown>)
    : null;
}

function inferSource(siteId: string | null): "onedrive" | "sharepoint" {
  return siteId ? "sharepoint" : "onedrive";
}

// Graph metadata can omit or misstate the size, so count the bytes as they stream.
async function* limitBytes(source: AsyncIterable<Uint8Array>, maxBytes: number) {
  let total = 0;
  for await (const chunk of source) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new MicrosoftImportTooLargeError(maxBytes);
    yield chunk;
  }
}

function mapGraphDriveItem(item: GraphDriveItem, fallbackSiteId: string | null = null): MicrosoftFileEntry | null {
  if (!item || typeof item !== "object") {
    return null;
  }
  const itemId = toOptionalString(item.id);
  const name = toOptionalString(item.name);
  const parentReference = getParentReference(item);
  const driveId = toOptionalString(parentReference?.driveId);

  if (!itemId || !name || !driveId) {
    return null;
  }

  const fileInfo =
    item.file && typeof item.file === "object" ? (item.file as Record<string, unknown>) : null;
  const siteId = toOptionalString(parentReference?.siteId) ?? fallbackSiteId;
  const path = toOptionalString(parentReference?.path);

  return {
    itemId,
    driveId,
    parentId: toOptionalString(parentReference?.id),
    siteId,
    name,
    webUrl: toOptionalString(item.webUrl),
    size: toOptionalNumber(item.size),
    mimeType: toOptionalString(fileInfo?.mimeType),
    isFolder: Boolean(item.folder),
    isFile: Boolean(item.file),
    lastModifiedDateTime: toOptionalString(item.lastModifiedDateTime),
    path,
    source: inferSource(siteId),
    summary: null
  };
}

// Downloads file content from Graph, following redirects manually so we can
// refuse any hop that downgrades to a non-HTTPS scheme. The bearer token is sent
// only on the initial Graph request; Graph's redirect points at a pre-authenticated
// download URL, so we drop the Authorization header on subsequent hops to avoid
// leaking the token to the (separate) storage/CDN host.
export async function downloadGraphContent(
  fetchImpl: typeof fetch,
  initialUrl: string,
  token: string,
  signal?: AbortSignal
): Promise<Response> {
  let url = initialUrl;
  let attachToken = true;

  for (let hop = 0; hop <= MAX_CONTENT_REDIRECTS; hop += 1) {
    const response: Response = await fetchImpl(url, {
      headers: attachToken ? { Authorization: `Bearer ${token}` } : {},
      redirect: "manual",
      ...(signal ? { signal } : {})
    });

    const isRedirect = response.status >= 300 && response.status < 400;
    if (!isRedirect) {
      return response;
    }

    const location = response.headers.get("location");
    if (!location) {
      return response;
    }

    // A redirect body is never read. Release it before the next hop or a refusal.
    await response.body?.cancel().catch(() => undefined);
    url = assertHttpsRedirect(location, url).toString();
    // Only the first hop targets Graph; never forward the bearer token onward.
    attachToken = false;
  }

  throw new MicrosoftGraphRequestError(
    `Too many redirects while downloading Microsoft file content (>${MAX_CONTENT_REDIRECTS})`,
    502
  );
}

// Reads at most `maxBytes` of a response body and cancels the rest, so a large
// file is never held in memory in full.
export async function readBodyPrefix(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { bytes: concatBytes(chunks, total), truncated: false };
      const room = maxBytes - total;
      if (value.byteLength >= room) {
        chunks.push(value.subarray(0, room));
        // At the limit, stop now: a stalled remainder must not delay the prefix.
        // Bytes may remain, so report the prefix as truncated.
        return { bytes: concatBytes(chunks, maxBytes), truncated: true };
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function concatBytes(chunks: Uint8Array[], length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class MicrosoftFilesService {
  constructor(
    private readonly deps: {
      microsoftConnections: Pick<MicrosoftConnectionService, "getRuntimeCredentials">;
      uploadAdmission: Pick<UploadAdmission, "begin" | "admit">;
      maxImportBytes: number;
      fetchImpl?: typeof fetch;
    }
  ) {}

  private get fetchImpl(): typeof fetch {
    return this.deps.fetchImpl ?? fetch;
  }

  private async getCredentials(tenantId: string, userId: string,
    expectedAccountId?: string | null): Promise<MicrosoftRuntimeCredentials> {
    const creds = await this.deps.microsoftConnections.getRuntimeCredentials(tenantId, userId, expectedAccountId);
    if (!creds) {
      throw new MicrosoftConnectionRequiredError();
    }

    return creds;
  }

  private async graphJson<T>(
    creds: MicrosoftRuntimeCredentials,
    url: string,
    init?: RequestInit
  ): Promise<T> {
    const response = await this.fetchImpl(url, {
      ...init,
      headers: {
        ...buildGraphHeaders(creds.token),
        ...(init?.headers ?? {})
      }
    });

    if (!response.ok) {
      const detail = await safeJsonBody(response);
      throw new MicrosoftGraphRequestError(`Graph API error ${response.status}`, response.status, detail);
    }

    return (await response.json()) as T;
  }

  private downloadContent(initialUrl: string, token: string): Promise<Response> {
    return downloadGraphContent(this.fetchImpl, initialUrl, token);
  }

  async listSites(input: {
    tenantId: string;
    userId: string;
    // The account the agent turn recorded; omitted for a user's own request.
    expectedAccountId?: string | null;
    search?: string | null;
  }): Promise<MicrosoftSiteEntry[]> {
    const creds = await this.getCredentials(input.tenantId, input.userId, input.expectedAccountId);
    const search = input.search?.trim() ?? "";
    const url = search
      ? `https://graph.microsoft.com/v1.0/sites?search=${encodeURIComponent(search)}`
      : "https://graph.microsoft.com/v1.0/me/followedSites";

    const data = await this.graphJson<{ value?: Array<Record<string, unknown>> }>(creds, url);
    return (data.value ?? []).map((site) => ({
      siteId: String(site.id),
      name: toOptionalString(site.name),
      displayName: toOptionalString(site.displayName),
      webUrl: toOptionalString(site.webUrl)
    }));
  }

  async listFiles(input: {
    tenantId: string;
    userId: string;
    // The account the agent turn recorded; omitted for a user's own request.
    expectedAccountId?: string | null;
    siteId?: string | null;
    driveId?: string | null;
    folderId?: string | null;
  }): Promise<MicrosoftFileEntry[]> {
    const creds = await this.getCredentials(input.tenantId, input.userId, input.expectedAccountId);
    const siteId = input.siteId?.trim() ?? null;
    const driveId = input.driveId?.trim() ?? null;
    const folderId = input.folderId?.trim() ?? null;

    if (driveId) assertValidGraphId(driveId, "driveId");
    if (siteId) assertValidGraphId(siteId, "siteId");
    if (folderId) assertValidGraphId(folderId, "folderId");

    let url: string;
    if (driveId) {
      url = folderId
        ? `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${folderId}/children`
        : `https://graph.microsoft.com/v1.0/drives/${driveId}/root/children`;
    } else if (siteId) {
      url = folderId
        ? `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/items/${folderId}/children`
        : `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/root/children`;
    } else {
      url = folderId
        ? `https://graph.microsoft.com/v1.0/me/drive/items/${folderId}/children`
        : "https://graph.microsoft.com/v1.0/me/drive/root/children";
    }

    const data = await this.graphJson<{ value?: GraphDriveItem[] }>(creds, url);
    return (data.value ?? [])
      .map((item) => mapGraphDriveItem(item, siteId))
      .filter((item): item is MicrosoftFileEntry => item !== null);
  }

  async searchFiles(input: {
    tenantId: string;
    userId: string;
    // The account the agent turn recorded; omitted for a user's own request.
    expectedAccountId?: string | null;
    query: string;
    maxResults?: number;
  }): Promise<MicrosoftFileEntry[]> {
    const creds = await this.getCredentials(input.tenantId, input.userId, input.expectedAccountId);
    const maxResults = Math.max(1, Math.min(25, input.maxResults ?? 10));

    const data = await this.graphJson<{
      value?: Array<{
        hitsContainers?: Array<{
          hits?: Array<Record<string, unknown>>;
        }>;
      }>;
    }>(creds, "https://graph.microsoft.com/v1.0/search/query", {
      method: "POST",
      body: JSON.stringify({
        requests: [
          {
            entityTypes: ["driveItem"],
            query: { queryString: input.query },
            from: 0,
            size: maxResults
          }
        ]
      })
    });

    const hits = data.value?.[0]?.hitsContainers?.[0]?.hits ?? [];
    const results: Array<MicrosoftFileEntry | null> = hits.map((hit) => {
        const resource =
          hit.resource && typeof hit.resource === "object"
            ? (hit.resource as GraphDriveItem)
            : null;
        if (!resource) {
          return null;
        }

        const mapped = mapGraphDriveItem(resource);
        if (!mapped) {
          return null;
        }

        return {
          ...mapped,
          summary: toOptionalString(hit.summary)
        };
      });

    return results.filter((entry): entry is MicrosoftFileEntry => entry !== null);
  }

  async importFileToSession(input: {
    tenantId: string;
    userId: string;
    // The account the agent turn recorded; omitted for a user's own request.
    expectedAccountId?: string | null;
    sessionId: string;
    driveId: string;
    itemId: string;
    artifactName?: string | null;
    createdByType: ArtifactRecord["createdByType"];
    createdByRef?: string | null;
  }): Promise<ArtifactRecord> {
    assertValidGraphId(input.driveId, "driveId");
    assertValidGraphId(input.itemId, "itemId");
    // Check access before any Graph call.
    const ticket = await this.deps.uploadAdmission.begin(input);
    const creds = await this.getCredentials(input.tenantId, input.userId, input.expectedAccountId);

    const meta = await this.graphJson<GraphDriveItem>(
      creds,
      `https://graph.microsoft.com/v1.0/drives/${input.driveId}/items/${input.itemId}`
    );

    const name = input.artifactName?.trim() || toOptionalString(meta.name) || `microsoft-file-${input.itemId}`;
    const fileInfo =
      meta.file && typeof meta.file === "object" ? (meta.file as Record<string, unknown>) : null;
    const mimeType = toOptionalString(fileInfo?.mimeType) ?? "application/octet-stream";

    if (!ALLOWED_ARTIFACT_MIME_TYPES.has(mimeType)) {
      throw new MicrosoftUnsupportedImportError(`Unsupported artifact MIME type: ${mimeType}`);
    }
    if ((toOptionalNumber(meta.size) ?? 0) > this.deps.maxImportBytes) {
      throw new MicrosoftImportTooLargeError(this.deps.maxImportBytes);
    }

    const response = await this.downloadContent(
      `https://graph.microsoft.com/v1.0/drives/${input.driveId}/items/${input.itemId}/content`,
      creds.token
    );

    if (!response.ok || !response.body) {
      throw new MicrosoftGraphRequestError(
        `Failed to download Microsoft file content: ${response.status}`,
        response.status
      );
    }

    // Both storage backends discard partial bytes when the stream fails.
    const result = await this.deps.uploadAdmission.admit(ticket, {
      artifactName: name,
      mimeType,
      stream: Readable.from(limitBytes(Readable.fromWeb(response.body as never), this.deps.maxImportBytes)),
      source: MICROSOFT_IMPORT_PII_SCOPE.subjectKind,
      createdByType: input.createdByType,
      createdByRef: input.createdByRef ?? null,
      detail: {
        source: "microsoft",
        driveId: input.driveId,
        itemId: input.itemId,
        webUrl: toOptionalString(meta.webUrl)
      },
      auditPayload: { source: "microsoft", driveId: input.driveId, itemId: input.itemId }
    });
    if (result.kind === "blocked") {
      throw new MicrosoftImportBlockedError(result.blockReason, result.scanRunId);
    }
    if (result.kind === "scan_failed") {
      throw new MicrosoftImportPiiScanError(result.errorCode, result.errorMessage);
    }
    return result.artifact;
  }
}
