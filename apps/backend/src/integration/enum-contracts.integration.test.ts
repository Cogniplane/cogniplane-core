import { describe, expect, test } from "vitest";
import {
  MessageFeedbackRatingSchema,
  PolicyEnforcementModeSchema,
  ProjectAgentFileModeSchema,
  ProjectApprovalModeSchema,
  SessionSchema,
  WEB_SEARCH_MODES
} from "@cogniplane/shared-types";
import { adminDatabaseUrl, superuserPool } from "./support/database.js";

// Compare the live migrated database with the public contracts, not SQL source
// fragments. Keep this list explicit: some DB enums intentionally have a wider
// domain than a request schema, and those should not claim exact parity.
const contracts = [
  { table: "sessions", column: "status", values: SessionSchema.shape.status.options },
  { table: "projects", column: "approval_mode", values: ProjectApprovalModeSchema.options },
  { table: "projects", column: "agent_file_mode", values: ProjectAgentFileModeSchema.options },
  { table: "messages", column: "feedback_rating", values: MessageFeedbackRatingSchema.options },
  { table: "tenant_settings", column: "policy_enforcement_mode", values: PolicyEnforcementModeSchema.options },
  { table: "tenant_settings", column: "web_search_mode", values: WEB_SEARCH_MODES }
];

describe.skipIf(!adminDatabaseUrl())("database enum contracts", () => {
  test.each(contracts)("$table.$column matches the shared enum", async ({ table, column, values }) => {
    const { rows } = await superuserPool().query<{ definition: string }>(`
      SELECT pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND c.conkey = ARRAY[a.attnum]
      WHERE c.conrelid = $1::regclass AND c.contype = 'c' AND a.attname = $2
    `, [`public.${table}`, column]);
    expect(rows, "Expected one single-column CHECK constraint").toHaveLength(1);
    // Fail if the constraint changes to a different expression. Extracting all
    // quoted strings from an arbitrary CHECK would miss an added OR condition.
    const prefix = `CHECK ((${column} = ANY (ARRAY[`;
    const suffix = "])))";
    expect(rows[0].definition.startsWith(prefix)).toBe(true);
    expect(rows[0].definition.endsWith(suffix)).toBe(true);
    const members = rows[0].definition.slice(prefix.length, -suffix.length);
    expect(members).toMatch(/^'(?:[^']|'')*'::text(?:, '(?:[^']|'')*'::text)*$/);
    const databaseValues = [...members.matchAll(/'((?:[^']|'')*)'::text/g)].map(match => match[1].replaceAll("''", "'"));
    expect(databaseValues.sort()).toEqual([...values].sort());
  });
});
