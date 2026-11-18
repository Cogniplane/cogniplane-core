import { setTimeout as delay } from "node:timers/promises";
import type { PoolClient } from "pg";

import { type Pool, withTenantScope } from "../../lib/db.js";

export class StoredFileCommitUnknownError extends Error {
  constructor(cause: unknown) {
    super("Could not confirm whether the stored file was saved.", { cause });
    this.name = "StoredFileCommitUnknownError";
  }
}

/** Publish the database reference to bytes that the caller already stored. */
export async function withStoredFileTransaction<T>(
  db: Pool,
  tenantId: string,
  write: (client: PoolClient) => Promise<T>
): Promise<T> {
  let publication: { transactionId: string; result: T } | undefined;
  try {
    return await withTenantScope(db, tenantId, async (client) => {
      const result = await write(client);
      const { rows } = await client.query<{ xid: string }>("SELECT pg_current_xact_id()::text AS xid");
      publication = { transactionId: rows[0].xid, result };
      return result;
    });
  } catch (error) {
    if (!publication) throw error; // The transaction never reached COMMIT.

    // PostgreSQL can commit even if the client loses the reply. Check from
    // another transaction after withTenantScope releases the first client.
    for (const waitMs of [0, 100, 300, 600]) {
      if (waitMs) await delay(waitMs);
      const outcome = await db.query<{ status: string | null }>(
        "SELECT pg_xact_status($1::xid8) AS status", [publication.transactionId]
      ).catch(() => null);
      const status = outcome?.rows[0]?.status;
      if (status === "committed") return publication.result;
      if (status === "aborted") throw error;
      if (status !== "in progress") break;
    }
    // The transaction can still be running, or the database unavailable.
    // The caller must keep the bytes while their reference might commit.
    throw new StoredFileCommitUnknownError(error);
  }
}
