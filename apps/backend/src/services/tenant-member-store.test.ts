import { test, expect } from "vitest";

import type { Pool } from "../lib/db.js";
import { PrivilegedAuthStateLookup, TenantMemberStore, type TenantAuthState } from "./tenant-member-store.js";

class CaptureDatabase {
  lastQuery: { text: string; values: unknown[] } | null = null;
  rows: Record<string, unknown>[] = [];

  async connect() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      async query(text: string, values: unknown[] = []) {
        return self._query(text, values);
      },
      async release() {}
    };
  }

  _query(text: string, values: unknown[] = []) {
    if (
      text === "BEGIN" ||
      text === "COMMIT" ||
      text === "ROLLBACK" ||
      text.startsWith("SELECT set_config")
    ) {
      return { rows: [], rowCount: 0 };
    }
    this.lastQuery = { text, values };
    return { rows: this.rows, rowCount: this.rows.length };
  }

  async query(text: string, values: unknown[] = []) {
    return this._query(text, values);
  }
}

test("TenantMemberStore.getRole issues a tenant_id + user_id SELECT and returns the role", async () => {
  const db = new CaptureDatabase();
  db.rows = [{ role: "owner" }];
  const store = new TenantMemberStore(db as unknown as Pool);

  const role = await store.getRole("tenant-1", "user-1");

  expect(role).toBe("owner");
  const query = db.lastQuery;
  if (!query) throw new Error("Expected getRole to query tenant memberships.");
  expect(query.text.includes("FROM tenant_memberships")).toBeTruthy();
  expect(query.text.includes("WHERE tenant_id = $1")).toBeTruthy();
  expect(query.text.includes("AND user_id = $2")).toBeTruthy();
  expect(query.text.includes("LIMIT 1")).toBeTruthy();
  expect(query.values).toEqual(["tenant-1", "user-1"]);
});

test("TenantMemberStore.getRole returns null when no membership row exists", async () => {
  const db = new CaptureDatabase();
  db.rows = [];
  const store = new TenantMemberStore(db as unknown as Pool);

  const role = await store.getRole("tenant-1", "user-1");
  expect(role).toBeNull();
});

test("TenantMemberStore.getRole returns null on an unknown role string — defends against accidental privilege escalation", async () => {
  const db = new CaptureDatabase();
  db.rows = [{ role: "superadmin" }];
  const store = new TenantMemberStore(db as unknown as Pool);

  const role = await store.getRole("tenant-1", "user-1");
  expect(role).toBeNull();
});

test("TenantMemberStore.getRole accepts the three valid roles unchanged", async () => {
  const db = new CaptureDatabase();
  const store = new TenantMemberStore(db as unknown as Pool);

  for (const expected of ["owner", "admin", "member"] as const) {
    db.rows = [{ role: expected }];
    expect(await store.getRole("t", "u")).toBe(expected);
  }
});

test("TenantMemberStore.isUserBetaTester returns false when no membership row exists", async () => {
  const db = new CaptureDatabase();
  db.rows = [];
  const store = new TenantMemberStore(db as unknown as Pool);

  const isBeta = await store.isUserBetaTester("tenant-1", "user-1");
  expect(isBeta).toBe(false);
  expect(db.lastQuery?.text.includes("FROM tenant_memberships")).toBe(true);
  expect(db.lastQuery?.values).toEqual(["tenant-1", "user-1"]);
});

test("TenantMemberStore.isUserBetaTester returns is_beta_tester boolean from row", async () => {
  const db = new CaptureDatabase();
  const store = new TenantMemberStore(db as unknown as Pool);

  db.rows = [{ is_beta_tester: true }];
  expect(await store.isUserBetaTester("tenant-1", "user-1")).toBe(true);

  db.rows = [{ is_beta_tester: false }];
  expect(await store.isUserBetaTester("tenant-1", "user-1")).toBe(false);
});

/** Records every statement, and whether it went through `pool.query` or a checked-out client. */
class StatementLog {
  statements: { via: "pool" | "client"; text: string; values: unknown[] }[] = [];
  connects = 0;
  rows: Record<string, unknown>[] = [];

  private run(via: "pool" | "client", text: string, values: unknown[]) {
    this.statements.push({ via, text: text.trim(), values });
    const rows = text.includes("FROM tenant_memberships tm") ? this.rows : [];
    return { rows, rowCount: rows.length };
  }

  async query(text: string, values: unknown[] = []) {
    return this.run("pool", text, values);
  }

  async connect() {
    this.connects++;
    return {
      query: async (text: string, values: unknown[] = []) => this.run("client", text, values),
      release() {}
    };
  }
}

const WORKOS_ADMIN = { role: "admin", login_type: "workos", auth_source: "workos", local_status: null, security_version: null };

test("PrivilegedAuthStateLookup sends one SELECT on the pool, with the tenant and user as parameters", async () => {
  const db = new StatementLog();
  db.rows = [WORKOS_ADMIN];

  const state = await new PrivilegedAuthStateLookup(db as unknown as Pool).getAuthState("tenant-1", "user-1");

  expect(state).toEqual({ role: "admin", loginType: "workos", authSource: "workos", localStatus: null, securityVersion: null });
  // No checked-out client, so no BEGIN, set_config or COMMIT.
  expect(db.connects).toBe(0);
  expect(db.statements).toHaveLength(1);
  const [statement] = db.statements;
  expect(statement!.via).toBe("pool");
  expect(statement!.text).toMatch(/^SELECT tm\.role, t\.login_type, u\.auth_source/);
  expect(statement!.text).toContain("WHERE tm.tenant_id = $1");
  expect(statement!.text).toContain("AND tm.user_id = $2");
  expect(statement!.values).toEqual(["tenant-1", "user-1"]);
  expect(statement!.text).not.toMatch(/tenant-1|user-1/);
});

test("TenantMemberStore.getAuthState keeps the tenant scope: BEGIN, set_config, SELECT, COMMIT", async () => {
  const db = new StatementLog();
  db.rows = [WORKOS_ADMIN];

  await new TenantMemberStore(db as unknown as Pool).getAuthState("tenant-1", "user-1");

  expect(db.statements.map(({ via, text, values }) => ({ via, text: text.split("\n")[0], values }))).toEqual([
    { via: "client", text: "BEGIN", values: [] },
    { via: "client", text: "SELECT set_config('app.current_tenant_id', $1, true)", values: ["tenant-1"] },
    { via: "client", text: "SELECT tm.role, t.login_type, u.auth_source, li.status AS local_status, li.security_version,", values: ["tenant-1", "user-1"] },
    { via: "client", text: "COMMIT", values: [] }
  ]);
});

// Both reads share one SQL text and one mapping, so they must agree on
// every row, including the rows that refuse the token.
test.each<[string, Record<string, unknown> | null, TenantAuthState | null]>([
  ["a WorkOS member", WORKOS_ADMIN,
    { role: "admin", loginType: "workos", authSource: "workos", localStatus: null, securityVersion: null }],
  ["an active local account",
    { role: "member", login_type: "local", auth_source: "local", local_status: "active", security_version: 3 },
    { role: "member", loginType: "local", authSource: "local", localStatus: "active", securityVersion: 3 }],
  ["a disabled local account",
    { role: "owner", login_type: "local", auth_source: "local", local_status: "disabled", security_version: 4 },
    { role: "owner", loginType: "local", authSource: "local", localStatus: "disabled", securityVersion: 4 }],
  ["a local member without a local identity",
    { role: "member", login_type: "local", auth_source: "local", local_status: null, security_version: null }, null],
  ["a local member without a security version",
    { role: "member", login_type: "local", auth_source: "local", local_status: "active", security_version: null }, null],
  ["an unknown role", { ...WORKOS_ADMIN, role: "superadmin" }, null],
  ["an unknown tenant login type", { ...WORKOS_ADMIN, login_type: "saml" }, null],
  ["an unknown user login path", { ...WORKOS_ADMIN, auth_source: "saml" }, null],
  ["no membership row", null, null]
])("PrivilegedAuthStateLookup and TenantMemberStore map %s the same way", async (_case, row, expected) => {
  const db = new StatementLog();
  db.rows = row ? [row] : [];

  const privileged = await new PrivilegedAuthStateLookup(db as unknown as Pool).getAuthState("t", "u");
  const scoped = await new TenantMemberStore(db as unknown as Pool).getAuthState("t", "u");

  expect(privileged).toEqual(expected);
  expect(scoped).toEqual(expected);
});
