-- Indexes for foreign keys whose ON DELETE action the session purge and tenant
-- deletion fire. PostgreSQL runs one action query for each deleted parent row:
-- it deletes (CASCADE) or sets to NULL (SET NULL) the child rows where the
-- column equals the parent key. Without an index that starts with the column,
-- each of those queries reads the whole child table. An index that starts with
-- tenant_id does not serve it. SessionStore.cleanupExpired deletes the
-- messages and runtime_sessions of each purged session; the runtime delete
-- cascades to approvals, and the session delete cascades to artifacts. Tenant
-- deletion fires all of these actions, and the pii_scan_runs cascade too.
--
-- Nullable columns get a partial index WHERE column IS NOT NULL. The action
-- query compares the column with a strict operator, so the planner can use the
-- partial index. Most audit_events rows have no approval, and SET NULL moves a
-- row out of the index.
--
-- Duration and locks: docs/architecture/data.md#foreign-key-indexes. CREATE
-- INDEX lets reads continue, but INSERT, UPDATE and DELETE on the table wait
-- until this transaction commits, also while the later indexes build.
-- tool_events and audit_events have no size limit. The migration connection
-- has a 30-second statement timeout (lib/db.ts); this file raises it for its
-- own transaction only. The runner's 10-second lock_timeout still applies.
-- On a large install, build these indexes first with CREATE INDEX CONCURRENTLY
-- and the same names. IF NOT EXISTS then keeps them, and the check at the end
-- refuses an index that is not valid or has another definition.
SET LOCAL statement_timeout = '15min';

-- Parent: messages (ON DELETE SET NULL).
CREATE INDEX IF NOT EXISTS tool_events_message_id_idx
  ON tool_events (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tool_execution_contexts_message_id_idx
  ON tool_execution_contexts (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS resource_activations_message_id_idx
  ON resource_activations (message_id) WHERE message_id IS NOT NULL;

-- Parent: runtime_sessions (ON DELETE CASCADE). The columns are NOT NULL.
CREATE INDEX IF NOT EXISTS approvals_runtime_id_idx ON approvals (runtime_id);
CREATE INDEX IF NOT EXISTS tool_events_runtime_id_idx ON tool_events (runtime_id);
CREATE INDEX IF NOT EXISTS tool_execution_contexts_runtime_id_idx ON tool_execution_contexts (runtime_id);

-- Parent: approvals (ON DELETE SET NULL).
CREATE INDEX IF NOT EXISTS tool_events_approval_id_idx
  ON tool_events (approval_id) WHERE approval_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_events_approval_id_idx
  ON audit_events (approval_id) WHERE approval_id IS NOT NULL;

-- Parents: artifacts and pii_scan_runs (ON DELETE CASCADE). The columns are
-- NOT NULL. The existing indexes start with tenant_id.
CREATE INDEX IF NOT EXISTS artifact_download_tokens_artifact_id_idx ON artifact_download_tokens (artifact_id);
CREATE INDEX IF NOT EXISTS pii_scan_jobs_scan_run_id_idx ON pii_scan_jobs (scan_run_id);

-- IF NOT EXISTS also keeps an index that a failed CREATE INDEX CONCURRENTLY
-- left invalid. Stop instead, so that no foreign key stays without its index.
DO $$
DECLARE
  wrong text;
BEGIN
  SELECT string_agg(expected.index_name, ', ' ORDER BY expected.index_name) INTO wrong
  FROM (VALUES
    ('tool_events_message_id_idx', 'tool_events', 'message_id', true),
    ('tool_execution_contexts_message_id_idx', 'tool_execution_contexts', 'message_id', true),
    ('resource_activations_message_id_idx', 'resource_activations', 'message_id', true),
    ('approvals_runtime_id_idx', 'approvals', 'runtime_id', false),
    ('tool_events_runtime_id_idx', 'tool_events', 'runtime_id', false),
    ('tool_execution_contexts_runtime_id_idx', 'tool_execution_contexts', 'runtime_id', false),
    ('tool_events_approval_id_idx', 'tool_events', 'approval_id', true),
    ('audit_events_approval_id_idx', 'audit_events', 'approval_id', true),
    ('artifact_download_tokens_artifact_id_idx', 'artifact_download_tokens', 'artifact_id', false),
    ('pii_scan_jobs_scan_run_id_idx', 'pii_scan_jobs', 'scan_run_id', false)
  ) AS expected(index_name, table_name, column_name, partial)
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_am am ON am.oid = i.relam
    JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = ix.indkey[0]
    WHERE i.relname = expected.index_name
      AND i.relnamespace = 'public'::regnamespace
      AND ix.indrelid = format('public.%I', expected.table_name)::regclass
      AND a.attname = expected.column_name
      AND am.amname = 'btree'
      AND ix.indnkeyatts = 1 AND ix.indnatts = 1
      AND NOT ix.indisunique
      AND ix.indisvalid AND ix.indisready AND ix.indislive
      AND pg_get_expr(ix.indpred, ix.indrelid) IS NOT DISTINCT FROM
        CASE WHEN expected.partial THEN format('(%s IS NOT NULL)', expected.column_name) END
  );
  IF wrong IS NOT NULL THEN
    RAISE EXCEPTION 'Index % is not valid or has another definition. Drop it, then run the migration again.', wrong;
  END IF;
END
$$;
