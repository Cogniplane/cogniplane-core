import type { Pool } from "../lib/db.js";

export type PlatformEventRecord = {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export class PlatformEventStore {
  constructor(private readonly db: Pool) {}

  async create(input: {
    type: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query(
        `INSERT INTO platform_events (event_type, payload) VALUES ($1, $2::jsonb)`,
        [input.type, JSON.stringify(input.payload)]
      );
    } finally {
      client.release();
    }
  }

  async listByType(
    eventType: string,
    options: { since?: Date; limit?: number } = {}
  ): Promise<PlatformEventRecord[]> {
    const client = await this.db.connect();
    try {
      const result = await client.query(
        `
          SELECT id, event_type, payload, created_at
          FROM platform_events
          WHERE event_type = $1 AND ($2::timestamptz IS NULL OR created_at >= $2)
          ORDER BY created_at DESC
          LIMIT $3
        `,
        [eventType, options.since ?? null, options.limit ?? 200]
      );
      return result.rows.map((row) => ({
        id: String(row.id),
        eventType: String(row.event_type),
        payload: (row.payload as Record<string, unknown>) ?? {},
        createdAt: new Date(String(row.created_at)).toISOString()
      }));
    } finally {
      client.release();
    }
  }
}
