import { Pool, type PoolClient } from "pg";

import type { AppConfig } from "../config.js";

export { Pool } from "pg";

export async function withTransaction<T>(
  db: Pool,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function createDatabase(config: AppConfig): Pool {
  return new Pool({
    connectionString: config.DATABASE_URL
  });
}

export async function withTenantScope<T>(
  db: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function ensureUser(db: Pool, userId: string): Promise<void> {
  await db.query(
    `
      INSERT INTO users (user_id)
      VALUES ($1)
      ON CONFLICT (user_id) DO NOTHING
    `,
    [userId]
  );
}
