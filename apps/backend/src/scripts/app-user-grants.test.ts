import type { PoolClient } from "pg";
import { expect, test } from "vitest";

import { ensureAppUserRole } from "./migrate-lib.js";

function client(failOn?: string) {
  const queries: string[] = [];
  return {
    queries,
    connection: {
      async query(sql: string) {
        queries.push(sql);
        if (failOn && sql.includes(failOn)) throw new Error("grant failed");
        return { rows: [] };
      }
    } as unknown as PoolClient
  };
}

test("application grants replace obsolete privileges in one transaction", async () => {
  const { connection, queries } = client();
  await ensureAppUserRole(connection, "secret'quoted", "test_app");
  expect(queries[0]).toBe("BEGIN");
  expect(queries[1]).toBe("SET LOCAL standard_conforming_strings = on");
  expect(queries.at(-1)).toBe("COMMIT");
  expect(queries.find(sql => sql.includes("CREATE ROLE"))).toContain("secret''quoted");
  const grants = queries.filter(sql => sql.startsWith("GRANT"));
  expect(queries).toContain("REVOKE ALL ON ALL TABLES IN SCHEMA public, deep_agents FROM test_app");
  expect(queries).toContain("REVOKE ALL ON ALL SEQUENCES IN SCHEMA public, deep_agents FROM test_app");
  expect(queries).toContain("REVOKE ALL ON SCHEMA public, deep_agents FROM test_app");
  expect(grants.every(sql => !/ALL TABLES|ALL SEQUENCES|TRUNCATE|REFERENCES|TRIGGER|CREATE/.test(sql))).toBe(true);
  expect(grants.join("\n")).not.toMatch(/schema_migrations|checkpoint_migrations|tenant_deletion_/);
  expect(queries.indexOf(grants[0]!)).toBeGreaterThan(queries.findIndex(sql => sql.startsWith("REVOKE ALL ON SCHEMA")));
});

test("a failed application grant rolls back the reset and password change", async () => {
  const { connection, queries } = client("GRANT USAGE ON SEQUENCE");
  await expect(ensureAppUserRole(connection, "secret")).rejects.toThrow("grant failed");
  expect(queries.at(-1)).toBe("ROLLBACK");
  expect(queries).not.toContain("COMMIT");
});

test("unsafe role names fail before any database operation", async () => {
  const { connection, queries } = client();
  await expect(ensureAppUserRole(connection, "secret", "app; DROP ROLE postgres")).rejects.toThrow();
  expect(queries).toEqual([]);
});
