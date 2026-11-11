// Referencing-column indexes for the foreign keys that session purge and
// tenant deletion fire. PostgreSQL runs one referential-action query for each
// deleted parent row (`DELETE FROM ONLY child WHERE $1 = col` or `UPDATE ONLY
// child SET col = NULL WHERE $1 = col`). Without an index that starts with
// `col`, each of those queries reads the whole child table. An index that
// starts with tenant_id does not serve a lookup by `col` alone. See
// docs/architecture/data.md#foreign-key-indexes and issue #40.

import { randomUUID } from "node:crypto";

import { describe, expect, test, vi } from "vitest";

import { SessionStore } from "../services/session-store.js";
import { adminDatabaseUrl, appPool, maintenancePool, superuserPool } from "./support/database.js";
import {
  seedApproval,
  seedArtifact,
  seedDownloadToken,
  seedMessage,
  seedPiiScanJob,
  seedPiiScanRun,
  seedRuntimeSession,
  seedSession,
  seedTenant,
  seedUser
} from "./support/fixtures.js";
import { withStagedDatabase } from "./support/staged-migrations.js";

type ActionForeignKey = {
  table: string;
  column: string;
  parent: string;
  /** pg_constraint.confdeltype: c = CASCADE, n = SET NULL. */
  onDelete: "c" | "n";
  nullable: boolean;
};

const ACTION_FOREIGN_KEYS: readonly ActionForeignKey[] = [
  { table: "approvals", column: "runtime_id", parent: "runtime_sessions", onDelete: "c", nullable: false },
  { table: "artifact_download_tokens", column: "artifact_id", parent: "artifacts", onDelete: "c", nullable: false },
  { table: "audit_events", column: "approval_id", parent: "approvals", onDelete: "n", nullable: true },
  { table: "pii_scan_jobs", column: "scan_run_id", parent: "pii_scan_runs", onDelete: "c", nullable: false },
  { table: "resource_activations", column: "message_id", parent: "messages", onDelete: "n", nullable: true },
  { table: "tool_events", column: "approval_id", parent: "approvals", onDelete: "n", nullable: true },
  { table: "tool_events", column: "message_id", parent: "messages", onDelete: "n", nullable: true },
  { table: "tool_events", column: "runtime_id", parent: "runtime_sessions", onDelete: "c", nullable: false },
  { table: "tool_execution_contexts", column: "message_id", parent: "messages", onDelete: "n", nullable: true },
  { table: "tool_execution_contexts", column: "runtime_id", parent: "runtime_sessions", onDelete: "c", nullable: false }
];

type CatalogRow = {
  table_name: string;
  column_name: string;
  not_null: boolean;
  foreign_keys: Array<{ parent: string; onDelete: string; keyColumns: number }>;
  leading_indexes: Array<{ name: string; method: string; predicate: string | null }>;
};

function id(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

/** One session with a row in every table that references its messages, runtime and approval. */
async function seedSessionGraph(tenantId: string, userId: string, sessionId?: string) {
  const db = superuserPool();
  const session = sessionId ?? (await seedSession(tenantId, userId));
  const message = await seedMessage(tenantId, userId, session);
  const otherMessage = await seedMessage(tenantId, userId, session);
  const runtime = await seedRuntimeSession(tenantId, userId, session);
  const approval = await seedApproval({ tenantId, userId, sessionId: session, runtimeId: runtime });
  const toolEvent = await db.query<{ id: string }>(
    `INSERT INTO tool_events
       (tenant_id, session_id, user_id, message_id, runtime_id, approval_id,
        tool_call_id, kind, title, phase, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'tool', 'Run tool', 'completed', 'completed')
     RETURNING id`,
    [tenantId, session, userId, message, runtime, approval, id("call")]
  );
  const toolContext = id("toolctx");
  await db.query(
    `INSERT INTO tool_execution_contexts
       (tool_context_id, tenant_id, session_id, user_id, runtime_id, message_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '10 minutes')`,
    [toolContext, tenantId, session, userId, runtime, message]
  );
  const activation = await db.query<{ id: string }>(
    `INSERT INTO resource_activations
       (tenant_id, session_id, message_id, resource_type, resource_id, event_type)
     VALUES ($1, $2, $3, 'skill', 'integration-skill', 'invoked')
     RETURNING id`,
    [tenantId, session, message]
  );
  const auditEvent = await db.query<{ id: string }>(
    `INSERT INTO audit_events (tenant_id, session_id, user_id, approval_id, event_type)
     VALUES ($1, $2, $3, $4, 'approval_resolved')
     RETURNING id`,
    [tenantId, session, userId, approval]
  );
  const artifact = await seedArtifact(tenantId, userId, session);
  const downloadToken = await seedDownloadToken({ tenantId, userId, sessionId: session, artifactId: artifact });
  return {
    tenantId,
    session,
    message,
    otherMessage,
    runtime,
    approval,
    toolEventId: toolEvent.rows[0]!.id,
    toolContext,
    activationId: activation.rows[0]!.id,
    auditEventId: auditEvent.rows[0]!.id,
    artifact,
    downloadToken
  };
}

type SessionGraph = Awaited<ReturnType<typeof seedSessionGraph>>;

/** The foreign-key values that each referencing row of a session graph holds now. */
async function readReferences(graph: SessionGraph) {
  const db = superuserPool();
  const one = async (sql: string, params: unknown[]) => (await db.query(sql, params)).rows[0] ?? null;
  return {
    toolEvent: await one(
      "SELECT message_id, runtime_id, approval_id FROM tool_events WHERE id = $1",
      [graph.toolEventId]
    ),
    toolContext: await one(
      "SELECT message_id, runtime_id FROM tool_execution_contexts WHERE tool_context_id = $1",
      [graph.toolContext]
    ),
    activation: await one("SELECT message_id FROM resource_activations WHERE id = $1", [graph.activationId]),
    approval: await one("SELECT runtime_id FROM approvals WHERE approval_id = $1", [graph.approval]),
    auditEvent: await one(
      "SELECT tenant_id, session_id, approval_id FROM audit_events WHERE id = $1",
      [graph.auditEventId]
    ),
    downloadToken: await one(
      "SELECT artifact_id FROM artifact_download_tokens WHERE token = $1",
      [graph.downloadToken]
    )
  };
}

function intactReferences(graph: SessionGraph) {
  return {
    toolEvent: { message_id: graph.message, runtime_id: graph.runtime, approval_id: graph.approval },
    toolContext: { message_id: graph.message, runtime_id: graph.runtime },
    activation: { message_id: graph.message },
    approval: { runtime_id: graph.runtime },
    auditEvent: { tenant_id: graph.tenantId, session_id: graph.session, approval_id: graph.approval },
    downloadToken: { artifact_id: graph.artifact }
  };
}

describe.skipIf(!adminDatabaseUrl())("foreign-key referencing indexes", () => {
  test("each purge foreign key keeps its action and has one valid index that starts with its column", async () => {
    const { rows } = await superuserPool().query<CatalogRow>(
      `
        SELECT
          wanted.table_name,
          wanted.column_name,
          a.attnotnull AS not_null,
          COALESCE((
            SELECT json_agg(json_build_object(
                     'parent', parent.relname,
                     'onDelete', con.confdeltype,
                     'keyColumns', cardinality(con.conkey))
                   ORDER BY con.conname)
            FROM pg_constraint con
            JOIN pg_class parent ON parent.oid = con.confrelid
            WHERE con.contype = 'f' AND con.conrelid = c.oid AND a.attnum = ANY (con.conkey)
              AND parent.relname <> 'tenants'
          ), '[]') AS foreign_keys,
          COALESCE((
            SELECT json_agg(json_build_object(
                     'name', i.relname,
                     'method', am.amname,
                     'predicate', pg_get_expr(ix.indpred, ix.indrelid))
                   ORDER BY i.relname)
            FROM pg_index ix
            JOIN pg_class i ON i.oid = ix.indexrelid
            JOIN pg_am am ON am.oid = i.relam
            WHERE ix.indrelid = c.oid AND ix.indkey[0] = a.attnum
              AND ix.indisvalid AND ix.indisready AND ix.indislive
          ), '[]') AS leading_indexes
        FROM unnest($1::text[], $2::text[]) AS wanted(table_name, column_name)
        JOIN pg_class c ON c.relname = wanted.table_name AND c.relnamespace = 'public'::regnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = wanted.column_name AND NOT a.attisdropped
      `,
      [ACTION_FOREIGN_KEYS.map((fk) => fk.table), ACTION_FOREIGN_KEYS.map((fk) => fk.column)]
    );

    // One comparison for all keys, so a failure lists every missing index.
    const actual = Object.fromEntries(
      rows.map((row) => [
        `${row.table_name}.${row.column_name}`,
        { notNull: row.not_null, foreignKeys: row.foreign_keys, leadingIndexes: row.leading_indexes }
      ])
    );
    const expected = Object.fromEntries(
      ACTION_FOREIGN_KEYS.map((fk) => [
        `${fk.table}.${fk.column}`,
        {
          notNull: !fk.nullable,
          foreignKeys: [{ parent: fk.parent, onDelete: fk.onDelete, keyColumns: 1 }],
          // A partial index on `col IS NOT NULL` serves the action query: its
          // `$1 = col` uses a strict operator, so PostgreSQL proves the
          // predicate. NULL rows never match an action, and SET NULL moves
          // rows out of the index.
          leadingIndexes: [
            {
              name: `${fk.table}_${fk.column}_idx`,
              method: "btree",
              predicate: fk.nullable ? `(${fk.column} IS NOT NULL)` : null
            }
          ]
        }
      ])
    );
    expect(actual).toEqual(expected);
  });

  test("session purge removes a trashed session's rows, keeps its audit row, and leaves other sessions alone", async () => {
    const tenant = await seedTenant();
    const otherTenant = await seedTenant();
    const user = await seedUser();
    const otherUser = await seedUser();
    const trashed = await seedSessionGraph(tenant, user);
    const sameTenantLive = await seedSessionGraph(tenant, user);
    const otherTenantLive = await seedSessionGraph(otherTenant, otherUser);
    await superuserPool().query(
      "UPDATE sessions SET status = 'deleted', deleted_at = NOW() - INTERVAL '31 days' WHERE session_id = $1",
      [trashed.session]
    );

    const store = new SessionStore(appPool(), maintenancePool());
    const storageDelete = vi.fn(async () => undefined);
    const purgeRuntime = vi.fn(async () => undefined);
    const result = await store.cleanupExpired({ delete: storageDelete }, { purgeRuntime });

    expect(result.deletedSessions).toBeGreaterThanOrEqual(1);
    expect(purgeRuntime).toHaveBeenCalledWith({ tenantId: tenant, sessionId: trashed.session, userId: user });
    expect(await readReferences(trashed)).toEqual({
      toolEvent: null,
      toolContext: null,
      activation: null,
      approval: null,
      // Audit rows are append-only history: the purge clears the references
      // to the purged session and approval and keeps the row in its tenant.
      auditEvent: { tenant_id: tenant, session_id: null, approval_id: null },
      downloadToken: null
    });
    for (const table of ["messages", "runtime_sessions", "approvals", "artifacts"]) {
      const remaining = await superuserPool().query(`SELECT 1 FROM ${table} WHERE session_id = $1`, [trashed.session]);
      expect(remaining.rowCount, table).toBe(0);
    }
    expect(await readReferences(sameTenantLive)).toEqual(intactReferences(sameTenantLive));
    expect(await readReferences(otherTenantLive)).toEqual(intactReferences(otherTenantLive));
  });

  test("deleting one parent row changes only the rows that reference it", async () => {
    const tenant = await seedTenant();
    const otherTenant = await seedTenant();
    const user = await seedUser();
    const otherUser = await seedUser();
    const target = await seedSessionGraph(tenant, user);
    // A second graph in the same session: siblings that must keep their references.
    const sibling = await seedSessionGraph(tenant, user, target.session);
    const otherTenantGraph = await seedSessionGraph(otherTenant, otherUser);
    const db = superuserPool();

    // SET NULL from messages: the referencing rows stay, without the message.
    await db.query("DELETE FROM messages WHERE message_id = $1", [target.message]);
    expect(await readReferences(target)).toMatchObject({
      toolEvent: { message_id: null, runtime_id: target.runtime, approval_id: target.approval },
      toolContext: { message_id: null, runtime_id: target.runtime },
      activation: { message_id: null }
    });

    // SET NULL from approvals: tool and audit history stay, without the approval.
    await db.query("DELETE FROM approvals WHERE approval_id = $1", [target.approval]);
    expect(await readReferences(target)).toMatchObject({
      toolEvent: { message_id: null, runtime_id: target.runtime, approval_id: null },
      approval: null,
      auditEvent: { tenant_id: tenant, session_id: target.session, approval_id: null }
    });

    // CASCADE from runtime_sessions, artifacts and pii_scan_runs.
    const scanRun = await seedPiiScanRun({ tenantId: tenant, userId: user, sessionId: target.session });
    const siblingScanRun = await seedPiiScanRun({ tenantId: tenant, userId: user, sessionId: target.session });
    const scanJob = await seedPiiScanJob({ tenantId: tenant, userId: user, sessionId: target.session, scanRunId: scanRun });
    const siblingScanJob = await seedPiiScanJob({
      tenantId: tenant,
      userId: user,
      sessionId: target.session,
      scanRunId: siblingScanRun
    });
    await db.query("DELETE FROM runtime_sessions WHERE runtime_id = $1", [target.runtime]);
    await db.query("DELETE FROM artifacts WHERE artifact_id = $1", [target.artifact]);
    await db.query("DELETE FROM pii_scan_runs WHERE scan_run_id = $1", [scanRun]);
    expect(await readReferences(target)).toEqual({
      toolEvent: null,
      toolContext: null,
      activation: { message_id: null },
      approval: null,
      auditEvent: { tenant_id: tenant, session_id: target.session, approval_id: null },
      downloadToken: null
    });
    expect((await db.query("SELECT 1 FROM pii_scan_jobs WHERE job_id = $1", [scanJob])).rowCount).toBe(0);
    expect((await db.query("SELECT scan_run_id FROM pii_scan_jobs WHERE job_id = $1", [siblingScanJob])).rows).toEqual([
      { scan_run_id: siblingScanRun }
    ]);

    expect(await readReferences(sibling)).toEqual(intactReferences(sibling));
    expect(await readReferences(otherTenantGraph)).toEqual(intactReferences(otherTenantGraph));
    // Other files sweep queued PII jobs by status; leave none behind.
    await db.query("DELETE FROM pii_scan_runs WHERE scan_run_id = $1", [siblingScanRun]);
  });

  test("migration 089 keeps a valid index built in advance and refuses an invalid or different one", async () => {
    await withStagedDatabase(async ({ db, migrate }) => {
      const is089 = (file: string) => file.startsWith("089_");
      const indexOid = async (name: string) =>
        (await db.query<{ oid: string | null }>("SELECT to_regclass($1)::oid AS oid", [`public.${name}`])).rows[0]!.oid;
      const applied089 = async () =>
        (await db.query("SELECT 1 FROM schema_migrations WHERE version LIKE '089\\_%'")).rowCount;

      await migrate((file) => Number.parseInt(file, 10) < 89);
      await db.query("INSERT INTO tenants (tenant_id, tenant_name, slug) VALUES ('t', 'Test', 'fk-index-migration')");
      await db.query("INSERT INTO users (user_id, email) VALUES ('u', 'fk-index-migration@example.test')");
      await db.query("INSERT INTO sessions (session_id, tenant_id, user_id, session_name) VALUES ('s', 't', 'u', 'Test')");
      await db.query(`INSERT INTO messages (message_id, tenant_id, session_id, user_id, role, status)
        VALUES ('m', 't', 's', 'u', 'assistant', 'complete')`);
      await db.query(`INSERT INTO runtime_sessions
        (session_id, tenant_id, user_id, runtime_id, workspace_path, runtime_version)
        VALUES ('s', 't', 'u', 'r', '/tmp/test', 'test')`);
      // Two tool events of one message: existing rows that the build must index.
      await db.query(`INSERT INTO tool_events
        (tenant_id, session_id, user_id, message_id, runtime_id, tool_call_id, kind, title, phase, status)
        VALUES ('t', 's', 'u', 'm', 'r', 'c1', 'tool', 'Tool', 'completed', 'completed'),
               ('t', 's', 'u', 'm', 'r', 'c2', 'tool', 'Tool', 'completed', 'completed')`);

      // Same column and predicate, but another access method.
      await db.query("CREATE INDEX audit_events_approval_id_idx ON audit_events USING hash (approval_id) WHERE approval_id IS NOT NULL");
      await expect(migrate(is089)).rejects.toThrow(
        "Index audit_events_approval_id_idx is not valid or has another definition"
      );
      expect(await applied089()).toBe(0);
      await db.query("DROP INDEX audit_events_approval_id_idx");

      // Same name, no partial predicate.
      await db.query("CREATE INDEX audit_events_approval_id_idx ON audit_events (approval_id)");
      await expect(migrate(is089)).rejects.toThrow(
        "Index audit_events_approval_id_idx is not valid or has another definition"
      );
      expect(await applied089()).toBe(0);
      expect(await indexOid("tool_events_runtime_id_idx")).toBeNull();
      await db.query("DROP INDEX audit_events_approval_id_idx");

      // A failed concurrent build leaves an invalid index with the name.
      await expect(
        db.query(`CREATE UNIQUE INDEX CONCURRENTLY tool_events_message_id_idx
          ON tool_events (message_id) WHERE message_id IS NOT NULL`)
      ).rejects.toThrow(/could not create unique index/);
      expect(await indexOid("tool_events_message_id_idx")).not.toBeNull();
      await expect(migrate(is089)).rejects.toThrow(
        "Index tool_events_message_id_idx is not valid or has another definition"
      );
      expect(await applied089()).toBe(0);
      await db.query("DROP INDEX tool_events_message_id_idx");

      // A valid index built in advance stays; the migration builds the others.
      await db.query(`CREATE INDEX CONCURRENTLY tool_events_message_id_idx
        ON tool_events (message_id) WHERE message_id IS NOT NULL`);
      const builtInAdvance = await indexOid("tool_events_message_id_idx");
      await migrate(is089);
      expect(await applied089()).toBe(1);
      expect(await indexOid("tool_events_message_id_idx")).toBe(builtInAdvance);
      for (const fk of ACTION_FOREIGN_KEYS) {
        expect(await indexOid(`${fk.table}_${fk.column}_idx`), fk.table).not.toBeNull();
      }
    });
  }, 120_000);
});
