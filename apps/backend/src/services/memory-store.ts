// Long-term agent memory store (agent_memories table).
//
// Tenant-scoped via withTenantScope (RLS) like every other store; per-user
// namespacing via the (tenant_id, user_id, slug) uniqueness. Consumed by the
// memory managed tools (services/managed-tools/memory-tools.ts), by the
// per-turn memory data context (services/memory-workspace-section.ts) and by
// the user's settings routes (routes/memories.ts).
//
// Every write records its provenance (migration 068). The agent path needs the
// proof of the user's approval; the settings path records the user as author.
// Rows written before that migration read back as "unverified".

import { createHash } from "node:crypto";

import {
  MEMORY_CONTENT_MAX_LENGTH,
  MEMORY_NAME_PATTERN,
  type MemoryProvenance
} from "@cogniplane/shared-types";

import { escapeLikePattern, type Pool, withTenantScope } from "../lib/db.js";
import { isoTimestamp, isoTimestampOrNull } from "../lib/db-mappers.js";
import { uuidv7 } from "../lib/uuid.js";

export type MemoryRecord = {
  memoryId: string;
  userId: string;
  slug: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  version: number;
  provenance: MemoryProvenance;
  sourceSessionId: string | null;
  approvedAt: string | null;
};

export const MEMORY_SLUG_PATTERN = MEMORY_NAME_PATTERN;
export const MAX_MEMORY_CONTENT_LENGTH = MEMORY_CONTENT_MAX_LENGTH;
export const MAX_MEMORY_SEARCH_LIMIT = 50;
/** The settings list shows this many memories at most, newest first. */
export const MAX_MEMORY_LIST_LIMIT = 200;

/** The text that a stored memory holds, as the approval compared it. */
export function memoryContentSha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Thrown when the memory changed after the approval or edit that started the write. */
export class MemoryConflictError extends Error {
  constructor(readonly slug: string) {
    super(`Memory "${slug}" changed after the text was shown.`);
    this.name = "MemoryConflictError";
  }
}

export class MemoryNotFoundError extends Error {
  constructor(readonly slug: string) {
    super(`Memory "${slug}" was not found.`);
    this.name = "MemoryNotFoundError";
  }
}

/**
 * The proof that the user approved the saved text. Only the server builds it,
 * from a verified approval row. Nothing the model sends can fill it.
 */
export type AgentApprovedProvenance = {
  sourceSessionId: string;
  approvedByUserId: string;
  approvalId: string;
  approvedAt: string;
};

export type MemorySaveInput = {
  slug: string;
  content: string;
  metadata?: Record<string, unknown>;
  provenance: AgentApprovedProvenance;
  /**
   * What the approval showed as the text that this write replaces.
   * `undefined` skips the check. `null` means no memory existed. A hash means
   * that exact text. Any other state throws {@link MemoryConflictError}.
   */
  expectedPreviousContentSha256?: string | null;
};

function mapMemory(row: Record<string, unknown>): MemoryRecord {
  return {
    memoryId: String(row.memory_id),
    userId: String(row.user_id),
    slug: String(row.slug),
    content: String(row.content),
    metadata:
      row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {},
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
    version: Number(row.version),
    provenance:
      row.provenance === "agent_approved" || row.provenance === "user_authored"
        ? row.provenance
        : "unverified",
    sourceSessionId: row.source_session_id ? String(row.source_session_id) : null,
    approvedAt: isoTimestampOrNull(row.approved_at)
  };
}

const MEMORY_COLUMNS =
  "memory_id, user_id, slug, content, metadata, created_at, updated_at, version, provenance, source_session_id, approved_at";

function assertValidSlug(slug: string): void {
  if (!MEMORY_SLUG_PATTERN.test(slug)) {
    throw new Error(
      "Memory slug must be lowercase alphanumeric with dashes/underscores (max 128 chars)."
    );
  }
}

function assertValidContent(content: string): void {
  if (!content.trim()) {
    throw new Error("Memory content must not be empty.");
  }
  if (content.length > MAX_MEMORY_CONTENT_LENGTH) {
    throw new Error(`Memory content exceeds ${MAX_MEMORY_CONTENT_LENGTH} characters.`);
  }
}

export class MemoryStore {
  constructor(private readonly db: Pool) {}

  /**
   * Upsert by (tenant, user, slug) on the agent path. Saving an existing slug
   * replaces its content. The write records the approval that authorized it.
   */
  async save(tenantId: string, userId: string, input: MemorySaveInput): Promise<MemoryRecord> {
    assertValidSlug(input.slug);
    assertValidContent(input.content);

    const { provenance, expectedPreviousContentSha256: expected } = input;
    const insertValues = [
      uuidv7(), tenantId, userId, input.slug, input.content, JSON.stringify(input.metadata ?? {}),
      provenance.sourceSessionId, provenance.approvedByUserId, provenance.approvalId, provenance.approvedAt
    ];
    const insertSql = `
      INSERT INTO agent_memories (
        memory_id, tenant_id, user_id, slug, content, metadata,
        provenance, source_session_id, approved_by_user_id, approval_id, approved_at
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'agent_approved', $7, $8, $9, $10)
    `;

    return withTenantScope(this.db, tenantId, async (client) => {
      if (expected === null) {
        // No memory existed when the user was asked. A row that appeared since is a conflict.
        const created = await client.query(
          `${insertSql} ON CONFLICT (tenant_id, user_id, slug) DO NOTHING RETURNING ${MEMORY_COLUMNS}`,
          insertValues
        );
        if (!created.rows[0]) throw new MemoryConflictError(input.slug);
        return mapMemory(created.rows[0]);
      }
      if (expected !== undefined) {
        // Lock the row so the text compared is the text replaced.
        const current = await client.query(
          `SELECT content FROM agent_memories WHERE tenant_id = $1 AND user_id = $2 AND slug = $3 FOR UPDATE`,
          [tenantId, userId, input.slug]
        );
        const row = current.rows[0];
        if (!row || memoryContentSha256(String(row.content)) !== expected) {
          throw new MemoryConflictError(input.slug);
        }
      }
      const saved = await client.query(
        `${insertSql}
          ON CONFLICT (tenant_id, user_id, slug) DO UPDATE
          SET content = EXCLUDED.content,
              metadata = EXCLUDED.metadata,
              provenance = EXCLUDED.provenance,
              source_session_id = EXCLUDED.source_session_id,
              approved_by_user_id = EXCLUDED.approved_by_user_id,
              approval_id = EXCLUDED.approval_id,
              approved_at = EXCLUDED.approved_at,
              version = agent_memories.version + 1,
              updated_at = NOW()
          RETURNING ${MEMORY_COLUMNS}`,
        insertValues
      );
      return mapMemory(saved.rows[0]);
    });
  }

  async get(tenantId: string, userId: string, slug: string): Promise<MemoryRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const found = await client.query(
        `SELECT ${MEMORY_COLUMNS} FROM agent_memories WHERE tenant_id = $1 AND user_id = $2 AND slug = $3`,
        [tenantId, userId, slug]
      );
      return found.rows[0] ? mapMemory(found.rows[0]) : null;
    });
  }

  /**
   * Case-insensitive substring search over slug + content, most recently
   * updated first. An empty query lists recent memories.
   */
  async search(
    tenantId: string,
    userId: string,
    options: { query?: string; limit?: number } = {}
  ): Promise<MemoryRecord[]> {
    // Floor + NaN-guard before clamping: the limit reaches a Postgres LIMIT
    // bind parameter, which rejects non-integer values.
    const limit = Math.max(
      1,
      Math.min(MAX_MEMORY_SEARCH_LIMIT, Math.floor(Number(options.limit ?? 10)) || 10)
    );
    const query = options.query?.trim() ?? "";

    return withTenantScope(this.db, tenantId, async (client) => {
      const params: unknown[] = [tenantId, userId];
      let matchClause = "";
      if (query) {
        params.push(`%${escapeLikePattern(query)}%`);
        matchClause = `AND (slug ILIKE $${params.length} OR content ILIKE $${params.length})`;
      }
      params.push(limit);
      const found = await client.query(
        `
          SELECT ${MEMORY_COLUMNS}
          FROM agent_memories
          WHERE tenant_id = $1 AND user_id = $2
            ${matchClause}
          ORDER BY updated_at DESC
          LIMIT $${params.length}
        `,
        params
      );
      return found.rows.map(mapMemory);
    });
  }

  /** The user's own memories for the settings view: most recent first, with the full count. */
  async list(
    tenantId: string,
    userId: string,
    options: { limit?: number } = {}
  ): Promise<{ memories: MemoryRecord[]; total: number }> {
    const limit = Math.max(
      1,
      Math.min(MAX_MEMORY_LIST_LIMIT, Math.floor(Number(options.limit ?? MAX_MEMORY_LIST_LIMIT)) || MAX_MEMORY_LIST_LIMIT)
    );
    return withTenantScope(this.db, tenantId, async (client) => {
      const found = await client.query(
        `
          SELECT ${MEMORY_COLUMNS}
          FROM agent_memories
          WHERE tenant_id = $1 AND user_id = $2
          ORDER BY updated_at DESC, memory_id DESC
          LIMIT $3
        `,
        [tenantId, userId, limit]
      );
      const counted = await client.query(
        `SELECT COUNT(*)::int AS total FROM agent_memories WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, userId]
      );
      return { memories: found.rows.map(mapMemory), total: Number(counted.rows[0]?.total ?? 0) };
    });
  }

  /**
   * The user replaces the text of one of their own memories. The write records
   * the user as its author. `expectedVersion` is the version the user saw, so a
   * newer text cannot be overwritten unseen.
   */
  async updateByUser(
    tenantId: string,
    userId: string,
    memoryId: string,
    input: { content: string; expectedVersion: number }
  ): Promise<MemoryRecord> {
    assertValidContent(input.content);
    return withTenantScope(this.db, tenantId, async (client) => {
      const updated = await client.query(
        `
          UPDATE agent_memories
          SET content = $4,
              provenance = 'user_authored',
              source_session_id = NULL,
              approved_by_user_id = $2,
              approval_id = NULL,
              approved_at = NOW(),
              version = version + 1,
              updated_at = NOW()
          WHERE tenant_id = $1 AND user_id = $2 AND memory_id = $3 AND version = $5
          RETURNING ${MEMORY_COLUMNS}
        `,
        [tenantId, userId, memoryId, input.content, input.expectedVersion]
      );
      if (updated.rows[0]) return mapMemory(updated.rows[0]);
      const exists = await client.query(
        `SELECT slug FROM agent_memories WHERE tenant_id = $1 AND user_id = $2 AND memory_id = $3`,
        [tenantId, userId, memoryId]
      );
      const slug = String(exists.rows[0]?.slug ?? memoryId);
      throw exists.rows[0] ? new MemoryConflictError(slug) : new MemoryNotFoundError(slug);
    });
  }

  /** The user deletes one of their own memories. Returns its name, or null when they have none with that id. */
  async removeById(tenantId: string, userId: string, memoryId: string): Promise<{ slug: string } | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const removal = await client.query(
        `
          DELETE FROM agent_memories
          WHERE tenant_id = $1 AND user_id = $2 AND memory_id = $3
          RETURNING slug
        `,
        [tenantId, userId, memoryId]
      );
      return removal.rows[0] ? { slug: String(removal.rows[0].slug) } : null;
    });
  }

  async remove(tenantId: string, userId: string, slug: string): Promise<boolean> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const removal = await client.query(
        `
          DELETE FROM agent_memories
          WHERE tenant_id = $1 AND user_id = $2 AND slug = $3
        `,
        [tenantId, userId, slug]
      );
      return (removal.rowCount ?? 0) > 0;
    });
  }
}
