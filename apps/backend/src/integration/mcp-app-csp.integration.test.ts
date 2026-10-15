import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";

import { withTenantScope } from "../lib/db.js";
import { AdminConfigError } from "../services/admin-config-error.js";
import type { AuditEventInput } from "../services/audit-event-store.js";
import { MAX_APPROVED_SOURCES_PER_SERVER, McpAppCspStore } from "../services/mcp/mcp-app-csp-store.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedTenant, seedUser } from "./support/fixtures.js";

const INSUFFICIENT_PRIVILEGE = "42501";
const CHECK_VIOLATION = "23514";
const store = () => new McpAppCspStore(appPool());
const serverId = () => `proxy-${randomUUID()}`;
const audit = (tenantId: string, userId: string): (() => AuditEventInput) => () => ({
  tenantId, sessionId: null, userId, type: "admin.mcp_server.widget_domain_approved", payload: {}
});
const rows = async (table: string, tenantId: string, server: string) =>
  (await superuserPool().query(`SELECT * FROM ${table} WHERE tenant_id = $1 AND server_id = $2`, [tenantId, server])).rows;

async function twoTenants() {
  const [first, second] = [await seedTenant(), await seedTenant()];
  return { first, second, admin: await seedUser() };
}

// Run against a real database with the application role, as production does.
// The unit tests cannot show that a policy or a check constraint rejects a row.
describe.skipIf(!adminDatabaseUrl())("MCP app widget domain approvals", () => {
  test("start empty: a server that nobody approved has no approved and no requested domain", async () => {
    const { first } = await twoTenants();
    const server = serverId();
    expect(await store().listApproved(first, server)).toEqual([]);
    expect(await store().listForAdmin(first, server)).toEqual({ serverId: server, approved: [], requested: [] });
  });

  test("keeps the approvals of two tenants apart, even for the same server ID", async () => {
    const { first, second, admin } = await twoTenants();
    const server = serverId();
    const entry = { directive: "connectDomains" as const, source: "https://api.vendor.com" };

    expect(await store().approve(first, server, entry, admin, audit(first, admin))).toBe(true);
    expect(await rows("admin_mcp_app_csp_approvals", first, server)).toHaveLength(1);

    expect(await store().listApproved(first, server)).toEqual([entry]);
    expect(await store().listApproved(second, server)).toEqual([]);
    expect((await store().listForAdmin(second, server)).approved).toEqual([]);

    // The second tenant cannot remove the first tenant's approval, whatever it sends.
    expect(await store().revoke(second, server, entry.directive, [entry.source], audit(second, admin))).toBe(false);
    expect(await rows("admin_mcp_app_csp_approvals", first, server)).toHaveLength(1);

    // An approval by the second tenant leaves the first tenant's set as it was.
    const other = { directive: "frameDomains" as const, source: "https://embed.vendor.com" };
    expect(await store().approve(second, server, other, admin, audit(second, admin))).toBe(true);
    expect(await store().listApproved(first, server)).toEqual([entry]);
    expect(await store().listApproved(second, server)).toEqual([other]);

    expect(await store().revoke(first, server, entry.directive, [entry.source], audit(first, admin))).toBe(true);
    expect(await store().listApproved(first, server)).toEqual([]);
    expect(await store().listApproved(second, server)).toEqual([other]);
  });

  test("keeps the requested domains of two tenants apart", async () => {
    const { first, second } = await twoTenants();
    const server = serverId();
    await store().recordRequested(first, server, [{ directive: "resourceDomains", source: "https://cdn.vendor.com" }]);
    expect((await store().listForAdmin(first, server)).requested).toHaveLength(1);
    expect((await store().listForAdmin(second, server)).requested).toEqual([]);
    expect(await rows("admin_mcp_app_csp_requests", second, server)).toEqual([]);
  });

  test("an approval is per source list: the same source in another list stays unapproved", async () => {
    const { first, admin } = await twoTenants();
    const server = serverId();
    await store().approve(first, server, { directive: "resourceDomains", source: "https://cdn.vendor.com" }, admin, audit(first, admin));
    expect(await store().listApproved(first, server)).toEqual([{ directive: "resourceDomains", source: "https://cdn.vendor.com" }]);
  });

  test("approval is idempotent and writes one audit event for one change", async () => {
    const { first, admin } = await twoTenants();
    const server = serverId();
    const entry = { directive: "connectDomains" as const, source: "https://api.vendor.com" };
    const events = async () => (await superuserPool().query(
      "SELECT count(*)::int AS total FROM audit_events WHERE tenant_id = $1 AND event_type = 'admin.mcp_server.widget_domain_approved'",
      [first]
    )).rows[0].total as number;
    const before = await events();
    expect(await store().approve(first, server, entry, admin, audit(first, admin))).toBe(true);
    expect(await store().approve(first, server, entry, admin, audit(first, admin))).toBe(false);
    expect(await events()).toBe(before + 1);
    expect(await store().listApproved(first, server)).toEqual([entry]);
  });

  test("a failed audit write rolls the approval back", async () => {
    const { first, admin } = await twoTenants();
    const server = serverId();
    const broken = () => { throw new Error("audit failed"); };
    await expect(store().approve(first, server, { directive: "connectDomains", source: "https://api.vendor.com" }, admin, broken))
      .rejects.toThrow("audit failed");
    expect(await rows("admin_mcp_app_csp_approvals", first, server)).toEqual([]);
  });

  test("refuses an approval above the limit and keeps the set as it was", async () => {
    const { first, admin } = await twoTenants();
    const server = serverId();
    const pool = superuserPool();
    await pool.query(
      `INSERT INTO admin_mcp_app_csp_approvals (tenant_id, server_id, directive, source, approved_by)
       SELECT $1, $2, 'connectDomains', 'https://h' || n || '.vendor.com', $3 FROM generate_series(1, $4) AS n`,
      [first, server, admin, MAX_APPROVED_SOURCES_PER_SERVER]
    );
    await expect(store().approve(first, server, { directive: "connectDomains", source: "https://extra.vendor.com" }, admin, audit(first, admin)))
      .rejects.toBeInstanceOf(AdminConfigError);
    expect(await rows("admin_mcp_app_csp_approvals", first, server)).toHaveLength(MAX_APPROVED_SOURCES_PER_SERVER);
    // An approval that already exists is still a success at the limit.
    expect(await store().approve(first, server, { directive: "connectDomains", source: "https://h1.vendor.com" }, admin, audit(first, admin)))
      .toBe(false);
  });

  test("keeps the requested list of one server small, and still updates a known source", async () => {
    const { first } = await twoTenants();
    const server = serverId();
    const batch = (from: number) => Array.from({ length: 25 }, (_, index) =>
      ({ directive: "resourceDomains" as const, source: `https://h${from + index}.vendor.com` }));
    for (let start = 0; start < 12 * 25; start += 25) await store().recordRequested(first, server, batch(start));
    expect(await rows("admin_mcp_app_csp_requests", first, server)).toHaveLength(200);
    await expect(store().recordRequested(first, server, batch(0))).resolves.toBeUndefined();
    expect(await rows("admin_mcp_app_csp_requests", first, server)).toHaveLength(200);
  });

  test("a source that is already known is touched at most once an hour", async () => {
    const { first } = await twoTenants();
    const server = serverId();
    const entry = { directive: "connectDomains" as const, source: "https://api.vendor.com" };
    await store().recordRequested(first, server, [entry]);
    const seenAt = async () => (await rows("admin_mcp_app_csp_requests", first, server))[0].last_seen_at as Date;
    const firstSeen = await seenAt();
    await store().recordRequested(first, server, [entry]);
    expect((await seenAt()).getTime()).toBe(firstSeen.getTime());
    await superuserPool().query(
      "UPDATE admin_mcp_app_csp_requests SET last_seen_at = now() - interval '2 hours' WHERE tenant_id = $1 AND server_id = $2",
      [first, server]
    );
    await store().recordRequested(first, server, [entry]);
    expect(Date.now() - (await seenAt()).getTime()).toBeLessThan(60 * 60 * 1000);
    expect(await rows("admin_mcp_app_csp_requests", first, server)).toHaveLength(1);
  });

  test("row security rejects a write for another tenant on both tables", async () => {
    const { first, second } = await twoTenants();
    const server = serverId();
    for (const statement of [
      `INSERT INTO admin_mcp_app_csp_approvals (tenant_id, server_id, directive, source, approved_by)
       VALUES ($1, $2, 'connectDomains', 'https://api.vendor.com', 'someone')`,
      `INSERT INTO admin_mcp_app_csp_requests (tenant_id, server_id, directive, source)
       VALUES ($1, $2, 'connectDomains', 'https://api.vendor.com')`
    ]) {
      await expect(withTenantScope(appPool(), first, (client) => client.query(statement, [second, server])))
        .rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    }
  });

  test("a query with no tenant scope sees no row on either table", async () => {
    const { first, admin } = await twoTenants();
    const server = serverId();
    await store().approve(first, server, { directive: "connectDomains", source: "https://api.vendor.com" }, admin, audit(first, admin));
    await store().recordRequested(first, server, [{ directive: "connectDomains", source: "https://api.vendor.com" }]);
    for (const table of ["admin_mcp_app_csp_approvals", "admin_mcp_app_csp_requests"]) {
      const result = await appPool().query(`SELECT * FROM ${table} WHERE server_id = $1`, [server]);
      expect(result.rows, table).toEqual([]);
    }
  });

  // The application checks every source before it writes one. These checks are
  // the last limit if the application is wrong: no delimiter, address, path or
  // plain http can be stored, whatever wrote the row.
  test.each([
    ["a space", "https://api.vendor.com 'unsafe-inline'", "connectDomains"],
    ["a semicolon", "https://api.vendor.com;frame-src *", "connectDomains"],
    ["a comma", "https://api.vendor.com,https://attacker.example.net", "connectDomains"],
    ["a path", "https://api.vendor.com/path", "connectDomains"],
    ["a user name", "https://user@api.vendor.com", "connectDomains"],
    ["an IPv6 address", "https://[::1]", "connectDomains"],
    ["plain http", "http://api.vendor.com", "connectDomains"],
    ["a capital letter", "https://API.vendor.com", "connectDomains"],
    ["a wildcard in the middle", "https://api.*.vendor.com", "connectDomains"],
    ["a wildcard for any port", "https://api.vendor.com:*", "connectDomains"],
    ["a web socket outside network requests", "wss://api.vendor.com", "resourceDomains"],
    ["an empty source", "", "connectDomains"]
  ])("the database refuses a source with %s on both tables", async (_name, source, directive) => {
    const { first } = await twoTenants();
    const server = serverId();
    for (const statement of [
      `INSERT INTO admin_mcp_app_csp_approvals (tenant_id, server_id, directive, source, approved_by)
       VALUES ($1, $2, $3, $4, 'someone')`,
      `INSERT INTO admin_mcp_app_csp_requests (tenant_id, server_id, directive, source)
       VALUES ($1, $2, $3, $4)`
    ]) {
      await expect(withTenantScope(appPool(), first, (client) => client.query(statement, [first, server, directive, source])))
        .rejects.toMatchObject({ code: CHECK_VIOLATION });
    }
  });

  test.each([
    ["an exact host", "https://api.vendor.com", "connectDomains"],
    ["a wildcard", "https://*.vendor.com", "resourceDomains"],
    ["a port", "https://api.vendor.com:8443", "frameDomains"],
    ["a web socket for network requests", "wss://live.vendor.com", "connectDomains"]
  ])("the database accepts %s", async (_name, source, directive) => {
    const { first } = await twoTenants();
    const server = serverId();
    await withTenantScope(appPool(), first, (client) => client.query(
      `INSERT INTO admin_mcp_app_csp_requests (tenant_id, server_id, directive, source) VALUES ($1, $2, $3, $4)`,
      [first, server, directive, source]
    ));
    expect(await rows("admin_mcp_app_csp_requests", first, server)).toHaveLength(1);
  });

  test("deleting a tenant removes its approvals and requests", async () => {
    const { first, admin } = await twoTenants();
    const server = serverId();
    // Seeded directly, so the tenant has no audit event to remove with it.
    await superuserPool().query(
      `INSERT INTO admin_mcp_app_csp_approvals (tenant_id, server_id, directive, source, approved_by)
       VALUES ($1, $2, 'connectDomains', 'https://api.vendor.com', $3)`,
      [first, server, admin]
    );
    await store().recordRequested(first, server, [{ directive: "connectDomains", source: "https://api.vendor.com" }]);
    await superuserPool().query("DELETE FROM tenants WHERE tenant_id = $1", [first]);
    expect(await rows("admin_mcp_app_csp_approvals", first, server)).toEqual([]);
    expect(await rows("admin_mcp_app_csp_requests", first, server)).toEqual([]);
  });
});
