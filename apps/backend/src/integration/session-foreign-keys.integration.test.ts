import { describe, expect, test } from "vitest";

import { adminDatabaseUrl, superuserPool } from "./support/database.js";

const EXPECTED_SESSION_CHILDREN = [
  "approvals",
  "artifact_download_tokens",
  "artifacts",
  "audit_events",
  "message_tool_results",
  "messages",
  "resource_activations",
  "runtime_sessions",
  "scheduled_job_runs",
  "session_executions",
  "tool_events",
  "tool_execution_contexts"
] as const;

type SessionForeignKeyRow = {
  table_name: string;
  child_columns: string[];
  parent_columns: string[];
};

describe.skipIf(!adminDatabaseUrl())("session foreign keys", () => {
  test("every session child binds tenant_id and session_id together", async () => {
    const { rows } = await superuserPool().query<SessionForeignKeyRow>(`
      SELECT
        child.relname AS table_name,
        array_agg(child_column.attname::text ORDER BY child_key.ordinality) AS child_columns,
        array_agg(parent_column.attname::text ORDER BY child_key.ordinality) AS parent_columns
      FROM pg_constraint constraint_row
      JOIN pg_class child ON child.oid = constraint_row.conrelid
      JOIN pg_class parent ON parent.oid = constraint_row.confrelid
      JOIN unnest(constraint_row.conkey) WITH ORDINALITY AS child_key(attnum, ordinality)
        ON TRUE
      JOIN unnest(constraint_row.confkey) WITH ORDINALITY AS parent_key(attnum, ordinality)
        ON parent_key.ordinality = child_key.ordinality
      JOIN pg_attribute child_column
        ON child_column.attrelid = child.oid AND child_column.attnum = child_key.attnum
      JOIN pg_attribute parent_column
        ON parent_column.attrelid = parent.oid AND parent_column.attnum = parent_key.attnum
      WHERE constraint_row.contype = 'f'
        AND parent.relname = 'sessions'
      GROUP BY child.relname, constraint_row.oid
      ORDER BY child.relname
    `);

    expect(rows.map((row) => row.table_name)).toEqual([...EXPECTED_SESSION_CHILDREN]);
    for (const row of rows) {
      expect(row.child_columns, row.table_name).toEqual(["tenant_id", "session_id"]);
      expect(row.parent_columns, row.table_name).toEqual(["tenant_id", "session_id"]);
    }
  });
});
