// Schema-shape guard: every tenant table has RLS turned on, and its policies
// name the right GUC.
//
// This is the test that satisfies the acceptance criterion "adding a tenant
// table without an RLS policy fails CI", and it does so with no knowledge of
// any table's columns — it reads the live catalog, so a table added tomorrow is
// covered the moment its migration lands.
//
// What it does NOT prove, so nobody reads green here as full coverage:
// a policy can name the right GUC and still be wrong. A permissive
// `USING (true)` added alongside a correct policy ORs with it and lets
// everything through; `OR true` or `<>` inside the expression passes a
// substring check too. Actual row-visibility behaviour is
// `rls-isolation.integration.test.ts`, and that covers the seeded tables only.

import { describe, expect, test } from "vitest";

import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";

/**
 * Tables that legitimately have no `tenant_id`. Keep this as the ONE list:
 * adding a global table is then a single deliberate edit here, and anything
 * else missing a tenant column fails.
 *
 *  - `users`      — identities are global; tenant scoping lives in
 *                   `tenant_memberships`.
 *  - `platform_events` — platform-wide telemetry, deliberately not per-tenant.
 *  - `schema_migrations` — created by the migration runner, not a domain table.
 */
const GLOBAL_TABLES = new Set(["users", "platform_events", "schema_migrations"]);

type TableRow = {
  table_name: string;
  has_tenant_id: boolean;
  row_security: boolean;
  force_row_security: boolean;
};

describe.skipIf(!adminDatabaseUrl())("RLS catalog", () => {
  async function loadTables(): Promise<TableRow[]> {
    const { rows } = await superuserPool().query<TableRow>(`
      SELECT
        c.relname AS table_name,
        EXISTS (
          SELECT 1 FROM information_schema.columns col
          WHERE col.table_schema = 'public'
            AND col.table_name = c.relname
            AND col.column_name = 'tenant_id'
        ) AS has_tenant_id,
        c.relrowsecurity AS row_security,
        c.relforcerowsecurity AS force_row_security
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
      ORDER BY c.relname
    `);
    return rows;
  }

  // No "the schema has more than N tables" guard here. A migration failure
  // throws inside globalSetup, so the suite never reaches these tests, and the
  // exact global-table assertion below already fails on an empty schema. A
  // magic number would just need editing every time a table is added.

  test("every table with a tenant_id column has RLS enabled AND forced", async () => {
    const tables = await loadTables();
    const tenantTables = tables.filter((row) => row.has_tenant_id);

    const missing = tenantTables
      .filter((row) => !row.row_security || !row.force_row_security)
      .map((row) => {
        const gaps: string[] = [];
        if (!row.row_security) gaps.push("ENABLE ROW LEVEL SECURITY");
        if (!row.force_row_security) gaps.push("FORCE ROW LEVEL SECURITY");
        return `${row.table_name} (missing: ${gaps.join(", ")})`;
      });

    expect(
      missing,
      "A table with a tenant_id column has no Row-Level Security. RLS is the " +
        "tenant-isolation boundary, so add both statements in the table's migration:\n" +
        missing.map((entry) => `  ALTER TABLE public.${entry}`).join("\n")
    ).toEqual([]);
  });

  test("the tenant-less tables are exactly the documented global set", async () => {
    const tables = await loadTables();
    const actualGlobal = tables.filter((row) => !row.has_tenant_id).map((row) => row.table_name);

    expect(
      [...actualGlobal].sort(),
      "A table has no tenant_id column. Either add one (almost always the right " +
        "answer) or add it to GLOBAL_TABLES in this file with a comment saying " +
        "why it is platform-wide."
    ).toEqual([...GLOBAL_TABLES].sort());
  });

  test("no tenant-less table has RLS enabled", async () => {
    const tables = await loadTables();
    // RLS on a table with no tenant column cannot isolate anything, and its
    // policies would have to reference a column that does not exist. If this
    // fires, the table probably wants a tenant_id rather than a policy.
    const wrong = tables
      .filter((row) => !row.has_tenant_id && row.row_security)
      .map((row) => row.table_name);

    expect(wrong).toEqual([]);
  });

  test("every tenant table has a policy referencing app.current_tenant_id", async () => {
    const tables = await loadTables();
    const tenantTables = tables.filter((row) => row.has_tenant_id).map((row) => row.table_name);

    const { rows: policies } = await superuserPool().query<{
      tablename: string;
      policyname: string;
      qual: string | null;
      with_check: string | null;
    }>(`SELECT tablename, policyname, qual, with_check FROM pg_policies WHERE schemaname = 'public'`);

    const GUC = "current_setting('app.current_tenant_id'";
    const tablesWithGucPolicy = new Set(
      policies
        .filter((row) => `${row.qual ?? ""}${row.with_check ?? ""}`.includes(GUC))
        .map((row) => row.tablename)
    );

    const missing = tenantTables.filter((table) => !tablesWithGucPolicy.has(table));

    expect(
      missing,
      "A tenant table has RLS enabled but no policy referencing " +
        "current_setting('app.current_tenant_id'). Enabled-with-no-matching-policy " +
        "denies everything, and a policy naming a DIFFERENT GUC silently denies " +
        "everything too, because withTenantScope only ever sets this one."
    ).toEqual([]);
  });

  test("the app pool's role does not bypass RLS", async () => {
    // The boot assertion in app.ts only runs in workos mode, so nothing else
    // proves the role that CI and `make dev` create is actually RLS-bound. A
    // BYPASSRLS app role makes every isolation test in this suite vacuous.
    const { rows } = await appPool().query<{ bypassrls: boolean; superuser: boolean }>(
      "SELECT rolbypassrls AS bypassrls, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user"
    );
    expect(rows[0]).toEqual({ bypassrls: false, superuser: false });
  });

  test("the superuser pool's role does bypass RLS", async () => {
    // The mirror assertion. Fixtures and the cross-tenant sweep tests depend on
    // this pool seeing every tenant's rows; if it were RLS-bound, those tests
    // would fail confusingly rather than pointing at the pool.
    const { rows } = await superuserPool().query<{ bypassrls: boolean; superuser: boolean }>(
      "SELECT rolbypassrls AS bypassrls, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user"
    );
    expect(rows[0]?.bypassrls || rows[0]?.superuser).toBe(true);
  });
});
