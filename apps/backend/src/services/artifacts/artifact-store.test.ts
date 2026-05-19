import { test, expect } from "vitest";

import type { Pool } from "../../lib/db.js";

import { ArtifactStore } from "./artifact-store.js";

test("ArtifactStore.update rejects empty patches", async () => {
  const store = new ArtifactStore({} as Pool);

  await expect(store.update("test-tenant", "artifact-1", {})).rejects.toThrow(/requires at least one field to update/);
});

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
    if (
      text === "BEGIN" ||
      text === "COMMIT" ||
      text === "ROLLBACK" ||
      text.startsWith("SELECT set_config")
    ) {
      return { rows: [], rowCount: 0 };
    }
    this.lastQuery = { text, values };
    return { rows: [], rowCount: 1 };
  }

  async query(text: string, values: unknown[] = []) {
    return this._query(text, values);
  }
}

test("ArtifactStore.setPiiDetail issues jsonb_set merge under detail_json.pii", async () => {
  const db = new CaptureDatabase();
  const store = new ArtifactStore(db as unknown as Pool);

  await store.setPiiDetail("test-tenant", "artifact-1", {
    status: "scanned",
    modeApplied: "detect",
    scanRunId: "scan-123",
    findingsCount: 2
  });

  expect(db.lastQuery).toBeTruthy();
  expect(db.lastQuery.text.includes("UPDATE artifacts")).toBeTruthy();
  expect(db.lastQuery.text.includes("jsonb_set")).toBeTruthy();
  expect(db.lastQuery.text.includes("'{pii}'")).toBeTruthy();
  expect(db.lastQuery.values[0]).toBe("test-tenant");
  expect(db.lastQuery.values[1]).toBe("artifact-1");
  const patch = JSON.parse(String(db.lastQuery.values[2]));
  expect(patch.status).toBe("scanned");
  expect(patch.modeApplied).toBe("detect");
  expect(patch.scanRunId).toBe("scan-123");
  expect(patch.findingsCount).toBe(2);
});

test("ArtifactStore.setPiiDetail sends only the partial patch, preserving server-side merge semantics", async () => {
  const db = new CaptureDatabase();
  const store = new ArtifactStore(db as unknown as Pool);

  await store.setPiiDetail("test-tenant", "artifact-1", { status: "transformed" });

  expect(db.lastQuery).toBeTruthy();
  const patch = JSON.parse(String(db.lastQuery.values[2]));
  expect(Object.keys(patch)).toEqual(["status"]);
  expect(db.lastQuery.text.includes("COALESCE(detail_json->'pii', '{}'::jsonb) || $3::jsonb")).toBeTruthy();
});

test("ArtifactStore.consumeDownloadToken issues an UPDATE that gates on consumed_at IS NULL and matches the requester identity in SQL", async () => {
  const db = new CaptureDatabase();
  const store = new ArtifactStore({} as Pool, db as unknown as Pool);

  await store.consumeDownloadToken({
    token: "tok-123",
    requesterTenantId: "test-tenant",
    requesterUserId: "user-1",
    callerIsAdmin: false
  });

  expect(db.lastQuery).toBeTruthy();
  expect(db.lastQuery.text.includes("UPDATE artifact_download_tokens")).toBeTruthy();
  expect(db.lastQuery.text.includes("SET consumed_at = NOW()")).toBeTruthy();
  expect(db.lastQuery.text.includes("download.consumed_at IS NULL")).toBeTruthy();
  expect(db.lastQuery.text.includes("download.tenant_id = $2")).toBeTruthy();
  expect(db.lastQuery.text.includes("$4::boolean OR download.user_id = $3")).toBeTruthy();
  expect(db.lastQuery.text.includes("RETURNING")).toBeTruthy();
  expect(db.lastQuery.values).toEqual(["tok-123", "test-tenant", "user-1", false]);
});
