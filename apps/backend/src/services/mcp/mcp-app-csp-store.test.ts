import { expect, it } from "vitest";

import { FakePool } from "../../test-helpers/fake-pool.js";
import { AdminConfigError } from "../admin-config-error.js";
import type { AuditEventInput } from "../audit-event-store.js";
import { MAX_APPROVED_SOURCES_PER_SERVER, McpAppCspStore } from "./mcp-app-csp-store.js";

const audit = (): AuditEventInput => ({
  tenantId: "tenant-a", sessionId: null, userId: "admin-a",
  type: "admin.mcp_server.widget_domain_approved", payload: { serverId: "research" }
});

function setup(options: { approvedCount?: number; inserted?: number; deleted?: number } = {}) {
  const pool = new FakePool()
    .onQuery("SELECT count(*) AS total FROM admin_mcp_app_csp_approvals", () =>
      ({ rows: [{ total: String(options.approvedCount ?? 0) }], rowCount: 1 }))
    .onQuery("INSERT INTO admin_mcp_app_csp_approvals", () =>
      ({ rows: [], rowCount: options.inserted ?? 1 }))
    .onQuery("DELETE FROM admin_mcp_app_csp_approvals", () =>
      ({ rows: [], rowCount: options.deleted ?? 1 }))
    .onQuery("INSERT INTO audit_events", () => ({ rows: [], rowCount: 1 }))
    .onQuery("INSERT INTO admin_mcp_app_csp_requests", () => ({ rows: [], rowCount: 1 }))
    .onQuery("FROM admin_mcp_app_csp_approvals", () => ({
      rows: [{ directive: "connectDomains", source: "https://api.example.com", approved_by: "admin-a",
        approved_at: new Date("2026-10-14T10:00:00.000Z") }],
      rowCount: 1
    }))
    .onQuery("FROM admin_mcp_app_csp_requests", () => ({
      rows: [{ directive: "resourceDomains", source: "https://cdn.example.com",
        first_seen_at: new Date("2026-10-13T10:00:00.000Z"), last_seen_at: "2026-10-14T09:00:00.000Z" }],
      rowCount: 1
    }));
  return { pool, store: new McpAppCspStore(pool.asPool()) };
}

const tenantScope = (pool: FakePool) => pool.queries.filter((query) => query.text.includes("set_config"));
const sql = (pool: FakePool, text: string) => pool.queries.find((query) => query.text.includes(text));

it("reads the approved sources of one server in the tenant's scope", async () => {
  const { pool, store } = setup();
  expect(await store.listApproved("tenant-a", "research")).toEqual([
    { directive: "connectDomains", source: "https://api.example.com" }
  ]);
  expect(tenantScope(pool)[0]?.values).toEqual(["tenant-a"]);
  expect(sql(pool, "FROM admin_mcp_app_csp_approvals")?.values).toEqual(["tenant-a", "research"]);
  // The predicate is in the statement, not only in the row security policy.
  expect(sql(pool, "FROM admin_mcp_app_csp_approvals")?.text).toContain("tenant_id = $1 AND server_id = $2");
});

it("lists approved and requested sources for the administrator with ISO dates", async () => {
  const { store } = setup();
  expect(await store.listForAdmin("tenant-a", "research")).toEqual({
    serverId: "research",
    approved: [{ directive: "connectDomains", source: "https://api.example.com", approvedBy: "admin-a",
      approvedAt: "2026-10-14T10:00:00.000Z" }],
    requested: [{ directive: "resourceDomains", source: "https://cdn.example.com",
      firstSeenAt: "2026-10-13T10:00:00.000Z", lastSeenAt: "2026-10-14T09:00:00.000Z" }]
  });
});

it("records requested sources once per statement and writes nothing for an empty declaration", async () => {
  const { pool, store } = setup();
  await store.recordRequested("tenant-a", "research", []);
  expect(pool.queries).toHaveLength(0);
  await store.recordRequested("tenant-a", "research", [
    { directive: "connectDomains", source: "https://api.example.com" },
    { directive: "resourceDomains", source: "https://cdn.example.com" }
  ]);
  const write = sql(pool, "INSERT INTO admin_mcp_app_csp_requests");
  expect(write?.values).toEqual([
    "tenant-a", "research", ["connectDomains", "resourceDomains"],
    ["https://api.example.com", "https://cdn.example.com"], 200
  ]);
  // A source that is already known stays a write of its time, and at most once an hour.
  expect(write?.text).toContain("ON CONFLICT (tenant_id, server_id, directive, source)");
  expect(write?.text).toContain("interval '1 hour'");
  // A new source is refused once the server has too many.
  expect(write?.text).toContain("count(*)");
});

it("approves a source and writes the audit event in the same transaction", async () => {
  const { pool, store } = setup();
  const changed = await store.approve("tenant-a", "research",
    { directive: "connectDomains", source: "https://api.example.com" }, "admin-a", audit);
  expect(changed).toBe(true);
  expect(sql(pool, "INSERT INTO admin_mcp_app_csp_approvals")?.values)
    .toEqual(["tenant-a", "research", "connectDomains", "https://api.example.com", "admin-a"]);
  const order = pool.queries.map((query) => query.text.trim().split(/\s+/).slice(0, 3).join(" "));
  expect(order.filter((entry) => entry === "BEGIN" || entry === "COMMIT")).toEqual(["BEGIN", "COMMIT"]);
  expect(order.indexOf("INSERT INTO audit_events")).toBeGreaterThan(order.indexOf("INSERT INTO admin_mcp_app_csp_approvals"));
  expect(order.indexOf("INSERT INTO audit_events")).toBeLessThan(order.indexOf("COMMIT"));
});

it("does not write an audit event when the source was already approved", async () => {
  const { pool, store } = setup({ inserted: 0, approvedCount: MAX_APPROVED_SOURCES_PER_SERVER });
  expect(await store.approve("tenant-a", "research",
    { directive: "connectDomains", source: "https://api.example.com" }, "admin-a", audit)).toBe(false);
  expect(sql(pool, "INSERT INTO audit_events")).toBeUndefined();
});

it("refuses a new approval above the limit and keeps no audit event", async () => {
  const { pool, store } = setup({ approvedCount: MAX_APPROVED_SOURCES_PER_SERVER });
  await expect(store.approve("tenant-a", "research",
    { directive: "connectDomains", source: "https://api.example.com" }, "admin-a", audit))
    .rejects.toBeInstanceOf(AdminConfigError);
  expect(sql(pool, "INSERT INTO audit_events")).toBeUndefined();
  expect(pool.queries.some((query) => query.text.trim() === "ROLLBACK")).toBe(true);
});

it("removes an approval by any given spelling and audits only a real removal", async () => {
  const removed = setup();
  expect(await removed.store.revoke("tenant-a", "research", "connectDomains",
    ["https://api.example.com", "HTTPS://API.example.com"], audit)).toBe(true);
  expect(sql(removed.pool, "DELETE FROM admin_mcp_app_csp_approvals")?.values)
    .toEqual(["tenant-a", "research", "connectDomains", ["https://api.example.com", "HTTPS://API.example.com"]]);
  expect(sql(removed.pool, "INSERT INTO audit_events")).toBeDefined();

  const missing = setup({ deleted: 0 });
  expect(await missing.store.revoke("tenant-a", "research", "connectDomains", ["https://api.example.com"], audit)).toBe(false);
  expect(sql(missing.pool, "INSERT INTO audit_events")).toBeUndefined();
});
