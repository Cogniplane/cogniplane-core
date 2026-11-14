// Postgres persistence for the Deep Agents runtime.
//
// ── Tenant-isolation boundary (read before touching) ────────────────────────
// The LangGraph checkpointer tables are keyed by thread_id ONLY: no tenant
// column, no RLS, and the saver has its own pg Pool, so reads do not run in
// withTenantScope. Isolation is enforced at the APP layer:
//   - thread_id IS the session id, and
//   - every entry point that reaches the checkpointer (messages route,
//     approvals route, scheduler) first resolves the session through auth
//     middleware + the tenant-scoped `sessions` table (RLS-forced), so a
//     tenant can never name another tenant's thread.
// This is deliberately weaker than RLS but acceptable because the
// checkpointer is unreachable except through those routes.
//
// ── Write fence ─────────────────────────────────────────────────────────────
// A turn writes checkpoints only while its execution holds the session lease.
// Each run passes its execution in `configurable` (CHECKPOINT_FENCE_KEY), and
// LangGraph copies the run's `configurable` into the config of every `put` and
// `putWrites`, also for subgraphs. The write transaction first locks the lease
// row of that execution (lockExecutionForCheckpointWrite), so the lease cannot
// change hands while the write runs. A write with no fence fails.
//
// ── DDL ownership ────────────────────────────────────────────────────────────
// The tables live in their own schema (below) so the library's generic names
// (checkpoints, checkpoint_blobs, checkpoint_writes, checkpoint_migrations)
// can't collide with app tables. DDL runs from `migrate.ts` (superuser) via
// `setupDeepAgentsCheckpointer` — PostgresSaver.setup() is idempotent and
// tracks its own internal migrations, so library upgrades that add DDL are
// applied on the next `pnpm db:migrate`, never at serve time. migrate.ts then
// grants app_user DML on the schema; the runtime saver connects as app_user.

import { BaseCheckpointSaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

import type { Pool, PoolClient } from "pg";

import { createOperationalPool, type PoolErrorLogger } from "../../lib/db.js";
import { lockExecutionForCheckpointWrite, type CheckpointWriteFence } from "../session-execution-store.js";

export const DEEP_AGENTS_CHECKPOINT_SCHEMA = "deep_agents";

/**
 * Checkpoint puts/putWrites run once per superstep per active session, so
 * this pool — not pg's anonymous default of 10 — is the concurrency ceiling
 * for graph persistence across ALL sessions on the instance. Sized to the
 * app's other pools; named so `pg_stat_activity` attributes its connections.
 */
const CHECKPOINTER_POOL_MAX = 20;

/** The `configurable` key that carries the CheckpointWriteFence of a run. */
export const CHECKPOINT_FENCE_KEY = "cogniplane_checkpoint_fence";

type SaverConfig = Parameters<BaseCheckpointSaver["put"]>[0];

function fenceOf(config: SaverConfig): CheckpointWriteFence {
  const configurable = config.configurable ?? {};
  const fence = configurable[CHECKPOINT_FENCE_KEY] as Partial<CheckpointWriteFence> | undefined;
  const fields = [fence?.tenantId, fence?.sessionId, fence?.userId, fence?.executionId, fence?.ownerId, fence?.runtimeId];
  if (!fence || fields.some((field) => typeof field !== "string" || field === ""))
    throw new Error("A checkpoint write has no execution fence.");
  // thread_id is the session id. A fence of one session cannot cover another thread.
  if (configurable.thread_id !== fence.sessionId)
    throw new Error("A checkpoint write names a thread that is not the session of its execution.");
  return fence as CheckpointWriteFence;
}

/**
 * A client that runs the fence check right after BEGIN, in the same
 * transaction, and refuses any other statement outside that transaction.
 * PostgresSaver 1.1.2 runs `put` and `putWrites` as BEGIN, the writes, COMMIT
 * on one client. If a later version writes another way, its writes fail here
 * and are not left unfenced.
 */
function fencedClient(client: PoolClient, fence: CheckpointWriteFence): PoolClient {
  let fenced = false;
  const query = async (text: unknown, values?: unknown[]) => {
    if (text === "BEGIN") {
      await client.query("BEGIN");
      await lockExecutionForCheckpointWrite(client, fence);
      fenced = true;
      return { rows: [], rowCount: 0 };
    }
    if (text === "COMMIT" || text === "ROLLBACK") {
      fenced = false;
      return client.query(text);
    }
    if (!fenced) throw new Error("A checkpoint write ran outside its fenced transaction.");
    return client.query(text as string, values);
  };
  return { query, release: (error?: Error | boolean) => client.release(error) } as unknown as PoolClient;
}

function fencedPool(pool: Pool, fence: CheckpointWriteFence): Pool {
  return {
    connect: async () => fencedClient(await pool.connect(), fence),
    query: () => Promise.reject(new Error("A checkpoint write must run in a fenced transaction.")),
    end: () => Promise.reject(new Error("Only the shared saver closes the checkpoint pool."))
  } as unknown as Pool;
}

/**
 * The runtime saver. Reads, `deleteThread` and `end` use the shared pool
 * directly. Each `put` and `putWrites` runs through a PostgresSaver over a
 * pool view that is bound to the fence of that write, so the fence check and
 * the write commit in one transaction.
 *
 * `deleteThread` has no fence: session and tenant deletion call it after the
 * session row is gone. Deleting the session also deletes its lease row, which
 * waits for a write in progress, and a later write finds no lease and fails.
 */
export class ExecutionFencedCheckpointSaver extends BaseCheckpointSaver {
  private readonly reader: PostgresSaver;

  constructor(private readonly pool: Pool) {
    super();
    this.reader = new PostgresSaver(pool, this.serde, { schema: DEEP_AGENTS_CHECKPOINT_SCHEMA });
  }

  getTuple(...args: Parameters<BaseCheckpointSaver["getTuple"]>) { return this.reader.getTuple(...args); }
  list(...args: Parameters<BaseCheckpointSaver["list"]>) { return this.reader.list(...args); }
  getNextVersion(...args: Parameters<BaseCheckpointSaver["getNextVersion"]>) { return this.reader.getNextVersion(...args); }
  deleteThread(threadId: string) { return this.reader.deleteThread(threadId); }
  end() { return this.reader.end(); }

  async put(...args: Parameters<BaseCheckpointSaver["put"]>) { return this.writer(args[0]).put(...args); }
  async putWrites(...args: Parameters<PostgresSaver["putWrites"]>) { return this.writer(args[0]).putWrites(...args); }

  private writer(config: SaverConfig): PostgresSaver {
    return new PostgresSaver(fencedPool(this.pool, fenceOf(config)), this.serde, { schema: DEEP_AGENTS_CHECKPOINT_SCHEMA });
  }
}

/**
 * Runtime checkpointer (app_user connection). Call `.end()` on shutdown; it
 * closes the pool. Assumes `setupDeepAgentsCheckpointer` already ran via
 * migrations.
 *
 * The pool stays separate from the app pool, with its own name and size, but
 * it gets the same operational limits: without them, a stalled connection or
 * statement could hold a turn's checkpoint write with no bound. It also gets
 * the same `error` listener, so a dropped idle connection does not stop the
 * process.
 */
export function createDeepAgentsCheckpointer(databaseUrl: string, logger?: PoolErrorLogger): ExecutionFencedCheckpointSaver {
  const pool = createOperationalPool({
    connectionString: databaseUrl,
    applicationName: "cogniplane-deep-agents-checkpointer",
    max: CHECKPOINTER_POOL_MAX
  }, logger);
  return new ExecutionFencedCheckpointSaver(pool);
}

/**
 * Migration-time DDL: creates the schema + checkpointer tables and applies
 * the library's internal migrations. Must run on a superuser connection
 * (migrate.ts), mirroring how the SQL migrations run. This saver builds its
 * own short-lived pool without the operational limits; it is not a serving
 * pool.
 */
export async function setupDeepAgentsCheckpointer(migrationDatabaseUrl: string): Promise<void> {
  const saver = PostgresSaver.fromConnString(migrationDatabaseUrl, {
    schema: DEEP_AGENTS_CHECKPOINT_SCHEMA
  });
  try {
    await saver.setup();
  } finally {
    await saver.end();
  }
}
