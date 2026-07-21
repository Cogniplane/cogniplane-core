// Long-term agent memory store (agent_memories table).
//
// Tenant-scoped via withTenantScope (RLS) like every other store; per-user
// namespacing via the (tenant_id, user_id, slug) uniqueness. Consumed by the
// memory managed tools (services/managed-tools/memory-tools.ts) and by the
// workspace renderers, which inject recent memories at session start.

import { escapeLikePattern, type Pool, withTenantScope } from "../lib/db.js";
import { isoTimestamp } from "../lib/db-mappers.js";
import { uuidv7 } from "../lib/uuid.js";

export type MemoryRecord = {
  memoryId: string;
  userId: string;
  slug: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export const MEMORY_SLUG_PATTERN = /^[a-z0-9][a-z0-9-_]{0,127}$/;
export const MAX_MEMORY_CONTENT_LENGTH = 8_000;
export const MAX_MEMORY_SEARCH_LIMIT = 50;

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
    updatedAt: isoTimestamp(row.updated_at)
  };
}

const MEMORY_COLUMNS = "memory_id, user_id, slug, content, metadata, created_at, updated_at";

export class MemoryStore {
  constructor(private readonly db: Pool) {}

  /** Upsert by (tenant, user, slug) — saving an existing slug replaces its content. */
  async save(
    tenantId: string,
    userId: string,
    input: { slug: string; content: string; metadata?: Record<string, unknown> }
  ): Promise<MemoryRecord> {
    if (!MEMORY_SLUG_PATTERN.test(input.slug)) {
      throw new Error(
        "Memory slug must be lowercase alphanumeric with dashes/underscores (max 128 chars)."
      );
    }
    if (!input.content.trim()) {
      throw new Error("Memory content must not be empty.");
    }
    if (input.content.length > MAX_MEMORY_CONTENT_LENGTH) {
      throw new Error(`Memory content exceeds ${MAX_MEMORY_CONTENT_LENGTH} characters.`);
    }

    const memoryId = uuidv7();
    return withTenantScope(this.db, tenantId, async (client) => {
      const saved = await client.query(
        `
          INSERT INTO agent_memories (memory_id, tenant_id, user_id, slug, content, metadata)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb)
          ON CONFLICT (tenant_id, user_id, slug) DO UPDATE
          SET content = EXCLUDED.content,
              metadata = EXCLUDED.metadata,
              updated_at = NOW()
          RETURNING ${MEMORY_COLUMNS}
        `,
        [memoryId, tenantId, userId, input.slug, input.content, JSON.stringify(input.metadata ?? {})]
      );
      return mapMemory(saved.rows[0]);
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
