import { describe, expect, test } from "vitest";

import { FakePool } from "../test-helpers/fake-pool.js";
import { buildDefaultTenantSettingsInput, TenantSettingsStore } from "./tenant-settings-store.js";

// Unit tests for the approved sandbox hosts (VULN-13). The fake answers the
// statements of the upsert from the values it binds, and reads the INSERT back
// by column name, so a value in the wrong column fails here. Row-level security
// and the real column are proven against Postgres by the integration suite.

type Row = Record<string, unknown>;

const JSON_COLUMNS = new Set([
  "enabled_tool_ids", "enabled_mcp_server_ids", "enabled_providers", "enabled_model_ids",
  "model_default_efforts", "approved_sandbox_egress_domains"
]);

/** Pairs each column of the INSERT with the value bound to it, as the database would see it. */
function boundColumns(sql: string, values: unknown[]): Row {
  const columns = /INSERT INTO tenant_settings \(([^)]*)\)/.exec(sql)![1]!.split(",").map((name) => name.trim());
  const tuple = /VALUES \((.*)\)\s*ON CONFLICT/s.exec(sql)![1]!.split(",").map((entry) => entry.trim());
  expect(tuple).toHaveLength(columns.length);
  const row: Row = {};
  columns.forEach((name, index) => {
    const entry = tuple[index]!;
    const placeholder = /^\$(\d+)/.exec(entry);
    const value = placeholder ? values[Number(placeholder[1]) - 1] : entry === "NOW()" ? "2026-10-14T00:00:00.000Z" : Number(entry);
    // pg returns a parsed value for a jsonb column.
    row[name] = JSON_COLUMNS.has(name) && typeof value === "string" ? JSON.parse(value) : value;
  });
  return row;
}

function makeStore(existing: Row | null) {
  const inserts: Row[] = [];
  const statements: string[] = [];
  const pool = new FakePool()
    .onQuery("FOR UPDATE", () => (existing ? { rows: [existing], rowCount: 1 } : { rows: [], rowCount: 0 }))
    .onQuery("INSERT INTO tenant_settings", (sql, values) => {
      const row = boundColumns(sql, values);
      inserts.push(row);
      statements.push(sql);
      return { rows: [row], rowCount: 1 };
    })
    .onQuery("SELECT * FROM tenant_settings", () => (existing ? { rows: [existing], rowCount: 1 } : { rows: [], rowCount: 0 }));
  return { store: new TenantSettingsStore(pool.asPool()), inserts, statements };
}

function savedRow(overrides: Row = {}): Row {
  return {
    tenant_id: "tenant-a", show_effort_selector: false, web_search_mode: "disabled", approval_policy: "on-request",
    approval_reviewer: "user", allow_command_execution: false, auto_approve_read_only_tools: true,
    policy_enforcement_mode: "monitor", developer_instructions: null, enabled_tool_ids: [], enabled_mcp_server_ids: [],
    enabled_providers: ["anthropic"], enabled_model_ids: null, default_model_id: null, model_default_efforts: {},
    approved_sandbox_egress_domains: [], version: 3, config_hash: "saved-hash", updated_at: "2026-10-01T00:00:00.000Z",
    ...overrides
  };
}

describe("approved sandbox hosts in the tenant settings store", () => {
  test("a new tenant approves no host: the sandbox has no network", async () => {
    expect(buildDefaultTenantSettingsInput().approvedSandboxEgressDomains).toEqual([]);
    const { store, inserts } = makeStore(null);

    const saved = await store.upsert("tenant-a", {});

    expect(inserts[0]!.approved_sandbox_egress_domains).toEqual([]);
    expect(saved.approvedSandboxEgressDomains).toEqual([]);
  });

  test("saves the list in its own column, sorted and without duplicates", async () => {
    const { store, inserts } = makeStore(savedRow());

    const saved = await store.upsert("tenant-a", {
      approvedSandboxEgressDomains: ["pypi.org", "*.example.com", "pypi.org", "files.pythonhosted.org"]
    });

    expect(inserts[0]!.approved_sandbox_egress_domains).toEqual(["*.example.com", "files.pythonhosted.org", "pypi.org"]);
    expect(saved.approvedSandboxEgressDomains).toEqual(["*.example.com", "files.pythonhosted.org", "pypi.org"]);
  });

  test("updates the list of an existing row: every inserted column is also set on conflict", async () => {
    // The fake only answers the INSERT, so a column missing from the ON CONFLICT
    // list would save on a new tenant and silently not save on an existing one.
    const { store, statements } = makeStore(savedRow());
    await store.upsert("tenant-a", { approvedSandboxEgressDomains: ["pypi.org"] });

    const sql = statements[0]!;
    const inserted = /INSERT INTO tenant_settings \(([^)]*)\)/.exec(sql)![1]!.split(",").map((name) => name.trim());
    const updated = new Set([...sql.slice(sql.indexOf("DO UPDATE SET")).matchAll(/^\s*(\w+) = /gm)].map((match) => match[1]));
    expect(inserted).toContain("approved_sandbox_egress_domains");
    expect(inserted.filter((name) => name !== "tenant_id" && !updated.has(name))).toEqual([]);
  });

  test("keeps the saved list when an update does not carry it, and clears it on an empty list", async () => {
    const existing = savedRow({ approved_sandbox_egress_domains: ["pypi.org"] });
    const kept = await makeStore(existing).store.upsert("tenant-a", { showEffortSelector: true });
    expect(kept.approvedSandboxEgressDomains).toEqual(["pypi.org"]);

    const cleared = await makeStore(existing).store.upsert("tenant-a", { approvedSandboxEgressDomains: [] });
    expect(cleared.approvedSandboxEgressDomains).toEqual([]);
  });

  test("a change of the list changes the config hash, so cached sessions refresh", async () => {
    const hashOf = async (domains: string[]) =>
      (await makeStore(savedRow()).store.upsert("tenant-a", { approvedSandboxEgressDomains: domains })).configHash;

    const empty = await hashOf([]);
    const one = await hashOf(["pypi.org"]);
    expect(one).not.toBe(empty);
    // The same hosts in another order are the same settings.
    expect(await hashOf(["b.example.com", "a.example.com"])).toBe(await hashOf(["a.example.com", "b.example.com"]));
  });

  test("reads the saved list sorted, and keeps only text entries", async () => {
    const { store } = makeStore(savedRow({ approved_sandbox_egress_domains: ["pypi.org", 7, null, "*.example.com", "pypi.org"] }));

    expect((await store.get("tenant-a"))!.approvedSandboxEgressDomains).toEqual(["*.example.com", "pypi.org"]);
  });

  test.each([
    ["null", null],
    ["a string", "pypi.org"],
    ["an object", { host: "pypi.org" }]
  ])("reads %s in the column as no hosts, which is the strictest policy", async (_label, stored) => {
    const { store } = makeStore(savedRow({ approved_sandbox_egress_domains: stored }));

    expect((await store.get("tenant-a"))!.approvedSandboxEgressDomains).toEqual([]);
  });
});
