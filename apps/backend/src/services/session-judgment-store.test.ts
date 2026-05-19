import { test, expect } from "vitest";

import type { Pool } from "../lib/db.js";
import { SessionJudgmentStore } from "./session-judgment-store.js";

class CaptureDatabase {
  lastQuery: { text: string; values: unknown[] } | null = null;

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
    this.lastQuery = { text, values };
    return { rows: [], rowCount: 0 };
  }

  async query(text: string, values: unknown[] = []) {
    return this._query(text, values);
  }
}

test("SessionJudgmentStore.listInflightForTenant filters by tenant_id in SQL — admin routes never see cross-tenant rows", async () => {
  const db = new CaptureDatabase();
  const store = new SessionJudgmentStore({} as Pool, db as unknown as Pool);

  await store.listInflightForTenant("tenant-A", 200);

  expect(db.lastQuery).toBeTruthy();
  expect(db.lastQuery.text.includes("FROM session_judgments")).toBeTruthy();
  expect(db.lastQuery.text.includes("status IN ('submitted', 'running')")).toBeTruthy();
  expect(db.lastQuery.text.includes("tenant_id = $2")).toBeTruthy();
  expect(db.lastQuery.values).toEqual([200, "tenant-A"]);
});

test("SessionJudgmentStore.listInflight (cross-tenant, worker-only) does NOT carry a tenant filter — distinct from listInflightForTenant", async () => {
  const db = new CaptureDatabase();
  const store = new SessionJudgmentStore({} as Pool, db as unknown as Pool);

  await store.listInflight(200);

  expect(db.lastQuery).toBeTruthy();
  expect(db.lastQuery.text.includes("tenant_id")).toBeFalsy();
  expect(db.lastQuery.values).toEqual([200]);
});
