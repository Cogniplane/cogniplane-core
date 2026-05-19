import { test, expect } from "vitest";

import type { Pool } from "../lib/db.js";
import { TenantMemberStore } from "./tenant-member-store.js";

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
  expect(db.lastQuery).toBeTruthy();
  expect(db.lastQuery.text.includes("FROM tenant_memberships")).toBeTruthy();
  expect(db.lastQuery.text.includes("WHERE tenant_id = $1")).toBeTruthy();
  expect(db.lastQuery.text.includes("AND user_id = $2")).toBeTruthy();
  expect(db.lastQuery.text.includes("LIMIT 1")).toBeTruthy();
  expect(db.lastQuery.values).toEqual(["tenant-1", "user-1"]);
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
