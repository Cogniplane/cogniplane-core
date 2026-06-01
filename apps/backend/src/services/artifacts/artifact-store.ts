import { randomBytes } from "node:crypto";
import { uuidv7 } from "../../lib/uuid.js";

import { type Pool, withTenantScope } from "../../lib/db.js";

export type ArtifactPiiDetail = {
  status?: "pending" | "scanning" | "scanned" | "blocked" | "transformed" | "failed";
  modeApplied?: "off" | "detect" | "block" | "transform";
  scanRunId?: string;
  summaryText?: string;
  findingsCount?: number;
  blockReason?: string;
};

export type ArtifactDetail = {
  pii?: ArtifactPiiDetail;
  [key: string]: unknown;
};

export type ArtifactRecord = {
  id: number;
  artifactId: string;
  sessionId: string;
  userId: string;
  artifactType: "upload" | "derived" | "generated";
  sourceArtifactId: string | null;
  artifactName: string;
  mimeType: string;
  storageBackend: "local" | "bucket";
  storageKey: string;
  fileSizeBytes: number;
  checksumSha256: string;
  status: "pending" | "processing" | "ready" | "failed" | "deleted";
  createdByType: "user" | "tool" | "job" | "system";
  createdByRef: string | null;
  detail: ArtifactDetail;
  createdAt: string;
  updatedAt: string;
};

export type ArtifactDownloadTokenRecord = {
  token: string;
  tenantId: string;
  artifactId: string;
  sessionId: string;
  userId: string;
  storageBackend: "local" | "bucket";
  storageKey: string;
  fileName: string;
  contentType: string;
  expiresAt: string;
  createdAt: string;
};

function mapArtifact(row: Record<string, unknown>): ArtifactRecord {
  return {
    id: Number(row.id),
    artifactId: String(row.artifact_id),
    sessionId: String(row.session_id),
    userId: String(row.user_id),
    artifactType:
      row.artifact_type === "derived" || row.artifact_type === "generated"
        ? row.artifact_type
        : "upload",
    sourceArtifactId: row.source_artifact_id ? String(row.source_artifact_id) : null,
    artifactName: String(row.artifact_name),
    mimeType: String(row.mime_type),
    storageBackend: row.storage_backend === "bucket" ? "bucket" : "local",
    storageKey: String(row.storage_key),
    fileSizeBytes: Number(row.file_size_bytes ?? 0),
    checksumSha256: String(row.checksum_sha256 ?? ""),
    status:
      row.status === "processing" ||
      row.status === "ready" ||
      row.status === "failed" ||
      row.status === "deleted"
        ? row.status
        : "pending",
    createdByType:
      row.created_by_type === "tool" ||
      row.created_by_type === "job" ||
      row.created_by_type === "system"
        ? row.created_by_type
        : "user",
    createdByRef: row.created_by_ref ? String(row.created_by_ref) : null,
    detail:
      row.detail_json && typeof row.detail_json === "object"
        ? (row.detail_json as ArtifactDetail)
        : {},
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString()
  };
}

const ARTIFACT_COLUMNS = `
  id,
  artifact_id,
  session_id,
  user_id,
  artifact_type,
  source_artifact_id,
  artifact_name,
  mime_type,
  storage_backend,
  storage_key,
  file_size_bytes,
  checksum_sha256,
  status,
  created_by_type,
  created_by_ref,
  detail_json,
  created_at,
  updated_at
`.trim();

// Columns projected by both the peek and consume download-token queries.
const DOWNLOAD_TOKEN_COLUMNS = `
  download.token,
  download.tenant_id,
  download.artifact_id,
  download.session_id,
  download.user_id,
  download.storage_backend,
  download.storage_key,
  download.file_name,
  download.content_type,
  download.expires_at,
  download.created_at
`.trim();

// Identity + artifact-state gating shared by peek and consume so the two
// paths can never diverge. Placeholders: $1 token, $2 tenant, $3 user, $4
// callerIsAdmin. Deliberately does NOT filter on `expires_at` — expiry is
// surfaced to the caller as a distinct 410 rather than collapsed into a 404,
// and an expired token must never be consumed (so the 410 stays repeatable).
const DOWNLOAD_TOKEN_GATING = `
  download.token = $1
  AND download.tenant_id = $2
  AND ($4::boolean OR download.user_id = $3)
  AND download.consumed_at IS NULL
  AND artifact.tenant_id   = download.tenant_id
  AND artifact.artifact_id = download.artifact_id
  AND artifact.user_id     = download.user_id
  AND artifact.status     <> 'deleted'
  AND (artifact.artifact_type = 'upload' OR artifact.status = 'ready')
`.trim();

function mapDownloadToken(row: Record<string, unknown>): ArtifactDownloadTokenRecord {
  return {
    token: String(row.token),
    tenantId: String(row.tenant_id),
    artifactId: String(row.artifact_id),
    sessionId: String(row.session_id),
    userId: String(row.user_id),
    storageBackend: row.storage_backend === "bucket" ? "bucket" : "local",
    storageKey: String(row.storage_key),
    fileName: String(row.file_name),
    contentType: String(row.content_type),
    expiresAt: new Date(String(row.expires_at)).toISOString(),
    createdAt: new Date(String(row.created_at)).toISOString()
  };
}

// ── Cross-session browser query helpers ──────────────────────────────────────

export type ArtifactSortKey =
  | "created_desc"
  | "created_asc"
  | "name_asc"
  | "name_desc"
  | "size_desc"
  | "size_asc";

export type ArtifactMimeClass = "image" | "pdf" | "text" | "code" | "other";

export type ArtifactListOptions = {
  q?: string;
  artifactType?: ("upload" | "generated")[];
  status?: ("pending" | "processing" | "ready" | "failed")[];
  mimeClass?: ArtifactMimeClass[];
  sort?: ArtifactSortKey;
  limit?: number;
  cursor?: string;
};

export class ArtifactCursorError extends Error {
  constructor(public readonly reason: "malformed_cursor" | "cursor_sort_filter_mismatch") {
    super(reason);
    this.name = "ArtifactCursorError";
  }
}

type ArtifactCursor = { k: string | number; id: number; sort: ArtifactSortKey; fv: string };

// Per-sort SQL: which column the keyset seeks on, the tuple comparator, the
// full ORDER BY (column then id, same direction, total order), and how the
// bound key param is cast so the row-tuple comparison is type-correct.
const ARTIFACT_SORT_ORDER: Record<
  ArtifactSortKey,
  { column: string; comparator: "<" | ">"; orderBy: string; castKey: (param: string) => string }
> = {
  created_desc: {
    column: "created_at",
    comparator: "<",
    orderBy: "created_at DESC, id DESC",
    castKey: (p) => `${p}::timestamptz`
  },
  created_asc: {
    column: "created_at",
    comparator: ">",
    orderBy: "created_at ASC, id ASC",
    castKey: (p) => `${p}::timestamptz`
  },
  name_asc: {
    column: "artifact_name",
    comparator: ">",
    orderBy: "artifact_name ASC, id ASC",
    castKey: (p) => `${p}::text`
  },
  name_desc: {
    column: "artifact_name",
    comparator: "<",
    orderBy: "artifact_name DESC, id DESC",
    castKey: (p) => `${p}::text`
  },
  size_desc: {
    column: "file_size_bytes",
    comparator: "<",
    orderBy: "file_size_bytes DESC, id DESC",
    castKey: (p) => `${p}::bigint`
  },
  size_asc: {
    column: "file_size_bytes",
    comparator: ">",
    orderBy: "file_size_bytes ASC, id ASC",
    castKey: (p) => `${p}::bigint`
  }
};

function cursorKeyForRow(sort: ArtifactSortKey, row: ArtifactRecord): string | number {
  switch (sort) {
    case "created_desc":
    case "created_asc":
      return row.createdAt;
    case "name_asc":
    case "name_desc":
      return row.artifactName;
    case "size_desc":
    case "size_asc":
      return row.fileSizeBytes;
  }
}

function encodeArtifactCursor(cursor: ArtifactCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

// Validate that the cursor key `k` is shaped for the column the sort seeks on.
// Without this, a tampered cursor (valid `sort`/`fv`, garbage `k`) would reach
// the SQL cast (`$key::timestamptz` / `::bigint`) and surface as a Postgres 500
// instead of the intended 400 malformed-cursor response.
function isValidCursorKeyForSort(sort: ArtifactSortKey, k: unknown): boolean {
  switch (sort) {
    case "created_desc":
    case "created_asc":
      // Must cast cleanly to timestamptz.
      return typeof k === "string" && !Number.isNaN(Date.parse(k));
    case "size_desc":
    case "size_asc":
      // Must cast cleanly to bigint (whole, finite number).
      return typeof k === "number" && Number.isInteger(k);
    case "name_asc":
    case "name_desc":
      return typeof k === "string";
  }
}

function decodeArtifactCursor(raw: string): ArtifactCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("k" in parsed) ||
      !("id" in parsed) ||
      !("sort" in parsed) ||
      !("fv" in parsed)
    ) {
      return null;
    }
    const c = parsed as Record<string, unknown>;
    if (
      (typeof c.k !== "string" && typeof c.k !== "number") ||
      typeof c.id !== "number" ||
      !Number.isInteger(c.id) ||
      typeof c.sort !== "string" ||
      typeof c.fv !== "string" ||
      !(c.sort in ARTIFACT_SORT_ORDER)
    ) {
      return null;
    }
    const sort = c.sort as ArtifactSortKey;
    // The key must match the shape the sort's SQL cast expects, else a tampered
    // cursor would 500 at the cast rather than 400 here.
    if (!isValidCursorKeyForSort(sort, c.k)) {
      return null;
    }
    return { k: c.k, id: c.id, sort, fv: c.fv };
  } catch {
    return null;
  }
}

// Stable fingerprint of the FILTER set (not sort/limit/cursor). A cursor is
// only valid against the same filters that produced it; this binds them.
function computeFilterFingerprint(opts: ArtifactListOptions): string {
  const norm = {
    q: opts.q ?? null,
    type: opts.artifactType ? [...opts.artifactType].sort() : null,
    status: opts.status ? [...opts.status].sort() : null,
    mimeClass: opts.mimeClass ? [...opts.mimeClass].sort() : null
  };
  return Buffer.from(JSON.stringify(norm), "utf8").toString("base64url");
}

function escapeLike(value: string): string {
  // Escape LIKE wildcards so a user's literal % or _ doesn't widen the match.
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// SQL clauses for one mime class. MUST mirror classifyMimeClass() in
// @cogniplane/shared-types exactly: code = an explicit allowlist; text =
// any other text/*; other = none of the known classes. Pushes bound params
// onto `values` and returns the OR-able clause fragments.
const CODE_MIME_TYPES = [
  "application/json",
  "text/javascript",
  "text/x-python",
  "text/x-typescript",
  "application/x-sh",
  "text/html"
];

function mimeClassSqlClauses(cls: ArtifactMimeClass, values: unknown[]): string[] {
  switch (cls) {
    case "image":
      return ["mime_type ILIKE 'image/%'"];
    case "pdf":
      return ["mime_type = 'application/pdf'"];
    case "code": {
      values.push(CODE_MIME_TYPES);
      return [`mime_type = ANY($${values.length}::text[])`];
    }
    case "text": {
      // text/* that is NOT one of the code allowlist entries.
      values.push(CODE_MIME_TYPES);
      return [`(mime_type ILIKE 'text/%' AND mime_type <> ALL($${values.length}::text[]))`];
    }
    case "other": {
      // Anything that is not image/*, not pdf, and not text/* (code is a
      // subset of text/* or the json/sh extras, all caught below).
      values.push([...CODE_MIME_TYPES]);
      return [
        `(mime_type NOT ILIKE 'image/%' AND mime_type <> 'application/pdf' ` +
          `AND mime_type NOT ILIKE 'text/%' AND mime_type <> ALL($${values.length}::text[]))`
      ];
    }
  }
}

export class ArtifactStore {
  constructor(
    private readonly db: Pool,
    private readonly privilegedDb: Pool = db
  ) {}

  async create(input: {
    tenantId: string;
    artifactType: ArtifactRecord["artifactType"];
    sessionId: string;
    userId: string;
    sourceArtifactId?: string | null;
    artifactName: string;
    mimeType: string;
    storageBackend: ArtifactRecord["storageBackend"];
    storageKey: string;
    fileSizeBytes: number;
    checksumSha256: string;
    status: ArtifactRecord["status"];
    createdByType: ArtifactRecord["createdByType"];
    createdByRef?: string | null;
    detail?: ArtifactDetail;
  }): Promise<ArtifactRecord> {
    const artifactId = uuidv7();
    return withTenantScope(this.db, input.tenantId, async (client) => {
      const insertedArtifact = await client.query(
        `
          INSERT INTO artifacts (
            artifact_id,
            tenant_id,
            session_id,
            user_id,
            artifact_type,
            source_artifact_id,
            artifact_name,
            mime_type,
            storage_backend,
            storage_key,
            file_size_bytes,
            checksum_sha256,
            status,
            created_by_type,
            created_by_ref,
            detail_json
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)
          RETURNING ${ARTIFACT_COLUMNS}
        `,
        [
          artifactId,
          input.tenantId,
          input.sessionId,
          input.userId,
          input.artifactType,
          input.sourceArtifactId ?? null,
          input.artifactName,
          input.mimeType,
          input.storageBackend,
          input.storageKey,
          input.fileSizeBytes,
          input.checksumSha256,
          input.status,
          input.createdByType,
          input.createdByRef ?? null,
          JSON.stringify(input.detail ?? {})
        ]
      );
      return mapArtifact(insertedArtifact.rows[0]);
    });
  }

  async listBySession(tenantId: string, sessionId: string, userId: string): Promise<ArtifactRecord[]> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const artifactRows = await client.query(
        `
          SELECT ${ARTIFACT_COLUMNS}
          FROM artifacts
          WHERE tenant_id = $1 AND session_id = $2 AND user_id = $3 AND status <> 'deleted'
          ORDER BY created_at ASC, id ASC
        `,
        [tenantId, sessionId, userId]
      );
      return artifactRows.rows.map(mapArtifact);
    });
  }

  // Cross-session, single-user artifact listing for the artifact browser.
  // Keyset-paginated (NOT offset) so deep pages stay cheap. User isolation is
  // by the explicit `user_id = $2` predicate — RLS here is tenant-only.
  // `derived` artifacts are excluded by design (internal, non-user-facing).
  async listForUser(
    tenantId: string,
    userId: string,
    opts: ArtifactListOptions
  ): Promise<{ items: ArtifactRecord[]; nextCursor: string | null }> {
    const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
    const sort: ArtifactSortKey = opts.sort ?? "created_desc";
    const filterFingerprint = computeFilterFingerprint(opts);

    const cursor = opts.cursor ? decodeArtifactCursor(opts.cursor) : null;
    if (opts.cursor && !cursor) {
      throw new ArtifactCursorError("malformed_cursor");
    }
    if (cursor && (cursor.sort !== sort || cursor.fv !== filterFingerprint)) {
      // A cursor minted under a different sort/filter set must not silently
      // page a mismatched query — the keyset predicate would be meaningless.
      throw new ArtifactCursorError("cursor_sort_filter_mismatch");
    }

    const values: unknown[] = [tenantId, userId];
    const conditions: string[] = [
      "tenant_id = $1",
      "user_id = $2",
      "status <> 'deleted'",
      "artifact_type <> 'derived'"
    ];

    if (opts.q) {
      values.push(`%${escapeLike(opts.q)}%`);
      conditions.push(`artifact_name ILIKE $${values.length}`);
    }
    if (opts.artifactType && opts.artifactType.length > 0) {
      values.push(opts.artifactType);
      conditions.push(`artifact_type = ANY($${values.length}::text[])`);
    }
    if (opts.status && opts.status.length > 0) {
      values.push(opts.status);
      conditions.push(`status = ANY($${values.length}::text[])`);
    }
    if (opts.mimeClass && opts.mimeClass.length > 0) {
      const clauses: string[] = [];
      for (const cls of opts.mimeClass) {
        clauses.push(...mimeClassSqlClauses(cls, values));
      }
      if (clauses.length > 0) {
        conditions.push(`(${clauses.join(" OR ")})`);
      }
    }

    const order = ARTIFACT_SORT_ORDER[sort];
    if (cursor) {
      // Keyset predicate: (sortCol, id) <comparator> (cursorKey, cursorId).
      // The row tuple comparison gives a clean, index-friendly seek.
      values.push(cursor.k, cursor.id);
      const keyParam = `$${values.length - 1}`;
      const idParam = `$${values.length}`;
      conditions.push(
        `(${order.column}, id) ${order.comparator} (${order.castKey(keyParam)}, ${idParam}::bigint)`
      );
    }

    return withTenantScope(this.db, tenantId, async (client) => {
      const rows = await client.query(
        `
          SELECT ${ARTIFACT_COLUMNS}
          FROM artifacts
          WHERE ${conditions.join(" AND ")}
          ORDER BY ${order.orderBy}
          LIMIT $${values.length + 1}
        `,
        [...values, limit + 1]
      );

      const mapped = rows.rows.map(mapArtifact);
      const hasMore = mapped.length > limit;
      const items = hasMore ? mapped.slice(0, limit) : mapped;
      const last = items[items.length - 1];
      const nextCursor =
        hasMore && last
          ? encodeArtifactCursor({
              k: cursorKeyForRow(sort, last),
              id: last.id,
              sort,
              fv: filterFingerprint
            })
          : null;

      return { items, nextCursor };
    });
  }

  async getOwned(tenantId: string, artifactId: string, userId: string): Promise<ArtifactRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const artifactRows = await client.query(
        `
          SELECT ${ARTIFACT_COLUMNS}
          FROM artifacts
          WHERE tenant_id = $1 AND artifact_id = $2 AND user_id = $3
          LIMIT 1
        `,
        [tenantId, artifactId, userId]
      );
      return artifactRows.rows[0] ? mapArtifact(artifactRows.rows[0]) : null;
    });
  }

  /**
   * Retrieves an artifact by ID within a tenant scope.
   * Intended for background processing paths that already know the tenant.
   */
  async get(tenantId: string, artifactId: string): Promise<ArtifactRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const artifactRows = await client.query(
        `SELECT ${ARTIFACT_COLUMNS} FROM artifacts WHERE tenant_id = $1 AND artifact_id = $2 LIMIT 1`,
        [tenantId, artifactId]
      );
      return artifactRows.rows[0] ? mapArtifact(artifactRows.rows[0]) : null;
    });
  }

  async findLatestReadableDerived(
    tenantId: string,
    sourceArtifactId: string,
    userId: string
  ): Promise<ArtifactRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const derivedRows = await client.query(
        `
          SELECT ${ARTIFACT_COLUMNS}
          FROM artifacts
          WHERE
            tenant_id = $1
            AND source_artifact_id = $2
            AND user_id = $3
            AND status = 'ready'
            AND mime_type LIKE 'text/%'
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `,
        [tenantId, sourceArtifactId, userId]
      );
      return derivedRows.rows[0] ? mapArtifact(derivedRows.rows[0]) : null;
    });
  }

  // Status is the only mutable column here; `detail_json` is owned exclusively
  // by setPiiDetail() (which merges, rather than clobbering, the JSONB).
  async update(
    tenantId: string,
    artifactId: string,
    input: { status: ArtifactRecord["status"] }
  ): Promise<ArtifactRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const updatedArtifact = await client.query(
        `
          UPDATE artifacts
          SET status = $3, updated_at = NOW()
          WHERE tenant_id = $1 AND artifact_id = $2
          RETURNING ${ARTIFACT_COLUMNS}
        `,
        [tenantId, artifactId, input.status]
      );
      return updatedArtifact.rows[0] ? mapArtifact(updatedArtifact.rows[0]) : null;
    });
  }

  async setPiiDetail(
    tenantId: string,
    artifactId: string,
    pii: ArtifactPiiDetail
  ): Promise<void> {
    await withTenantScope(this.db, tenantId, async (client) => {
      await client.query(
        `
          UPDATE artifacts
          SET detail_json = jsonb_set(
                COALESCE(detail_json, '{}'::jsonb),
                '{pii}',
                COALESCE(detail_json->'pii', '{}'::jsonb) || $3::jsonb,
                true
              ),
              updated_at = NOW()
          WHERE tenant_id = $1 AND artifact_id = $2
        `,
        [tenantId, artifactId, JSON.stringify(pii)]
      );
    });
  }

  async listPendingProcessingUploads(tenantId: string): Promise<ArtifactRecord[]> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const pendingUploadRows = await client.query(
        `
          SELECT ${ARTIFACT_COLUMNS}
          FROM artifacts
          WHERE
            tenant_id = $1
            AND artifact_type = 'upload'
            AND mime_type = 'application/pdf'
            AND status IN ('pending', 'processing')
          ORDER BY created_at ASC, id ASC
        `,
        [tenantId]
      );
      return pendingUploadRows.rows.map(mapArtifact);
    });
  }

  async createDownloadToken(input: {
    tenantId: string;
    artifactId: string;
    sessionId: string;
    userId: string;
    storageBackend: ArtifactRecord["storageBackend"];
    storageKey: string;
    fileName: string;
    contentType: string;
    ttlMs: number;
  }): Promise<ArtifactDownloadTokenRecord> {
    const token = randomBytes(24).toString("hex");
    return withTenantScope(this.db, input.tenantId, async (client) => {
      const insertedToken = await client.query(
        `
          INSERT INTO artifact_download_tokens (
            token,
            tenant_id,
            artifact_id,
            session_id,
            user_id,
            storage_backend,
            storage_key,
            file_name,
            content_type,
            expires_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW() + ($10::text || ' milliseconds')::interval)
          RETURNING
            token,
            tenant_id,
            artifact_id,
            session_id,
            user_id,
            storage_backend,
            storage_key,
            file_name,
            content_type,
            expires_at,
            created_at
        `,
        [
          token,
          input.tenantId,
          input.artifactId,
          input.sessionId,
          input.userId,
          input.storageBackend,
          input.storageKey,
          input.fileName,
          input.contentType,
          String(input.ttlMs)
        ]
      );
      return mapDownloadToken(insertedToken.rows[0]);
    });
  }

  // Non-consuming lookup used by GET /downloads/:token to validate the token
  // and open the storage stream BEFORE committing the single-use consume.
  // This keeps a transient storage read failure from permanently burning the
  // token (the consume only happens once the stream is in hand), and lets the
  // route distinguish expired-but-unconsumed (→ 410, repeatable) from
  // not-found (→ 404). Returns null on the same conditions as consume:
  // unknown token, wrong tenant/user, already-consumed, or unreadable artifact.
  // Does NOT filter on expiry — an expired token still resolves here so the
  // route can answer 410.
  //
  // Caller-identity gating happens in SQL so an unauthorized request can never
  // observe a peer's token. When `callerIsAdmin` is true the user-equality
  // check is skipped — admin-minted tokens (POST /admin/artifacts/:id/download-token)
  // carry the artifact OWNER's user_id, not the admin's, because the
  // persistence layer joins on (tenant_id, artifact_id, user_id).
  async peekDownloadToken(input: {
    token: string;
    requesterTenantId: string;
    requesterUserId: string;
    callerIsAdmin: boolean;
  }): Promise<ArtifactDownloadTokenRecord | null> {
    const tokenRows = await this.privilegedDb.query(
      `
        SELECT ${DOWNLOAD_TOKEN_COLUMNS}
          FROM artifact_download_tokens AS download
          JOIN artifacts AS artifact
            ON artifact.tenant_id = download.tenant_id
         WHERE ${DOWNLOAD_TOKEN_GATING}
      `,
      [input.token, input.requesterTenantId, input.requesterUserId, input.callerIsAdmin]
    );
    return tokenRows.rows[0] ? mapDownloadToken(tokenRows.rows[0]) : null;
  }

  // Single-use: flips `consumed_at` atomically so a leaked token cannot be
  // replayed for the full TTL. The first call wins and returns the row;
  // subsequent calls match no rows and return null. The `expires_at > NOW()`
  // predicate means an expired token is never consumed — the route surfaces
  // expiry via peek (→ 410) before reaching here.
  //
  // Caller-identity gating is identical to `peekDownloadToken`; see that
  // method for why an unauthorized request never burns the token.
  async consumeDownloadToken(input: {
    token: string;
    requesterTenantId: string;
    requesterUserId: string;
    callerIsAdmin: boolean;
  }): Promise<ArtifactDownloadTokenRecord | null> {
    const tokenRows = await this.privilegedDb.query(
      `
        UPDATE artifact_download_tokens AS download
           SET consumed_at = NOW()
          FROM artifacts AS artifact
         WHERE ${DOWNLOAD_TOKEN_GATING}
           AND download.expires_at > NOW()
        RETURNING ${DOWNLOAD_TOKEN_COLUMNS}
      `,
      [input.token, input.requesterTenantId, input.requesterUserId, input.callerIsAdmin]
    );
    return tokenRows.rows[0] ? mapDownloadToken(tokenRows.rows[0]) : null;
  }
}
