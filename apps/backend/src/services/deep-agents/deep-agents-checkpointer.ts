// Postgres persistence for the Deep Agents runtime (bead im5e.3).
//
// ── Tenant-isolation boundary (read before touching) ────────────────────────
// The LangGraph checkpointer tables are keyed by thread_id ONLY: no tenant
// column, no RLS, and PostgresSaver manages its own pg Pool, so it does not
// participate in withTenantScope. Isolation is enforced at the APP layer:
//   - thread_id IS the session id, and
//   - every entry point that reaches the checkpointer (messages route,
//     approvals route, scheduler) first resolves the session through auth
//     middleware + the tenant-scoped `sessions` table (RLS-forced), so a
//     tenant can never name another tenant's thread.
// This is deliberately weaker than RLS but acceptable because the
// checkpointer is unreachable except through those routes. A saver subclass
// on tenant-scoped connections + RLS policies on these tables is a possible
// follow-up hardening.
//
// ── DDL ownership ────────────────────────────────────────────────────────────
// The tables live in their own schema (below) so the library's generic names
// (checkpoints, checkpoint_blobs, checkpoint_writes, checkpoint_migrations)
// can't collide with app tables. DDL runs from `migrate.ts` (superuser) via
// `setupDeepAgentsCheckpointer` — PostgresSaver.setup() is idempotent and
// tracks its own internal migrations, so library upgrades that add DDL are
// applied on the next `pnpm db:migrate`, never at serve time. migrate.ts then
// grants app_user DML on the schema; the runtime saver connects as app_user.

import pg from "pg";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

export const DEEP_AGENTS_CHECKPOINT_SCHEMA = "deep_agents";

/**
 * Checkpoint puts/putWrites run once per superstep per active session, so
 * this pool — not pg's anonymous default of 10 — is the concurrency ceiling
 * for graph persistence across ALL sessions on the instance. Sized to the
 * app's other pools; named so `pg_stat_activity` attributes its connections.
 */
const CHECKPOINTER_POOL_MAX = 20;

/**
 * Runtime checkpointer (app_user connection). Call `.end()` on shutdown —
 * PostgresSaver.end() closes the injected pool. Assumes
 * `setupDeepAgentsCheckpointer` already ran via migrations.
 */
export function createDeepAgentsCheckpointer(databaseUrl: string): PostgresSaver {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: CHECKPOINTER_POOL_MAX,
    application_name: "cogniplane-deep-agents-checkpointer"
  });
  return new PostgresSaver(pool, undefined, {
    schema: DEEP_AGENTS_CHECKPOINT_SCHEMA
  });
}

/**
 * Migration-time DDL: creates the schema + checkpointer tables and applies
 * the library's internal migrations. Must run on a superuser connection
 * (migrate.ts), mirroring how the SQL migrations run.
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
