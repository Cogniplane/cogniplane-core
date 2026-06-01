import { test, expect } from "vitest";

import type { Pool } from "../../lib/db.js";

import { ArtifactCursorError, ArtifactStore } from "./artifact-store.js";

class CaptureDatabase {
  lastQuery: { text: string; values: unknown[] } | null = null;
  // Rows returned for the next non-bookkeeping query (lets list queries that
  // map results — like listForUser — exercise their post-processing).
  nextRows: Record<string, unknown>[] = [];

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
    return { rows: this.nextRows, rowCount: this.nextRows.length };
  }

  async query(text: string, values: unknown[] = []) {
    return this._query(text, values);
  }
}

function artifactRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    artifact_id: "artifact-1",
    session_id: "session-1",
    user_id: "user-1",
    artifact_type: "upload",
    source_artifact_id: null,
    artifact_name: "report.pdf",
    mime_type: "application/pdf",
    storage_backend: "local",
    storage_key: "user-1/session-1/report.pdf",
    file_size_bytes: 1234,
    checksum_sha256: "",
    status: "ready",
    created_by_type: "user",
    created_by_ref: null,
    detail_json: {},
    created_at: "2026-05-31T00:00:00.000Z",
    updated_at: "2026-05-31T00:00:00.000Z",
    ...overrides
  };
}

test("ArtifactStore.setPiiDetail binds the full PII detail as the JSON patch, scoped to tenant + artifact", async () => {
  const db = new CaptureDatabase();
  const store = new ArtifactStore(db as unknown as Pool);

  await store.setPiiDetail("test-tenant", "artifact-1", {
    status: "scanned",
    modeApplied: "detect",
    scanRunId: "scan-123",
    findingsCount: 2
  });

  expect(db.lastQuery).toBeTruthy();
  // Bound contract: $1 tenant, $2 artifact, $3 the serialized PII patch.
  expect(db.lastQuery.values[0]).toBe("test-tenant");
  expect(db.lastQuery.values[1]).toBe("artifact-1");
  const patch = JSON.parse(String(db.lastQuery.values[2]));
  expect(patch).toEqual({
    status: "scanned",
    modeApplied: "detect",
    scanRunId: "scan-123",
    findingsCount: 2
  });
});

test("ArtifactStore.setPiiDetail sends only the caller's partial fields as the patch (server-side merge owns the rest)", async () => {
  const db = new CaptureDatabase();
  const store = new ArtifactStore(db as unknown as Pool);

  await store.setPiiDetail("test-tenant", "artifact-1", { status: "transformed" });

  expect(db.lastQuery).toBeTruthy();
  // Only the field the caller passed is sent — the merge semantics live in the
  // DB, so the patch must not be padded with undefined keys that would clobber
  // previously-stored PII detail.
  const patch = JSON.parse(String(db.lastQuery.values[2]));
  expect(patch).toEqual({ status: "transformed" });
});

test("ArtifactStore.consumeDownloadToken binds [token, tenant, user, callerIsAdmin] and gates on token expiry", async () => {
  const db = new CaptureDatabase();
  const store = new ArtifactStore({} as Pool, db as unknown as Pool);

  await store.consumeDownloadToken({
    token: "tok-123",
    requesterTenantId: "test-tenant",
    requesterUserId: "user-1",
    callerIsAdmin: false
  });

  expect(db.lastQuery).toBeTruthy();
  // The exact bound contract is the observable signal a store-level fake can't
  // reproduce, so we pin it: token, tenant, user, callerIsAdmin (in order).
  expect(db.lastQuery.values).toEqual(["tok-123", "test-tenant", "user-1", false]);
  // Structural invariant with no fake equivalent: consume must reject expired
  // tokens in SQL so an expired token is never burned (the route surfaces
  // expiry as a repeatable 410). The expiry predicate is the ONLY way to assert
  // this against a query-capturing fake.
  expect(db.lastQuery.text.includes("expires_at > NOW()")).toBe(true);
});

test("ArtifactStore.peekDownloadToken is read-only and omits the expiry filter so the route can answer 410", async () => {
  const db = new CaptureDatabase();
  const store = new ArtifactStore({} as Pool, db as unknown as Pool);

  await store.peekDownloadToken({
    token: "tok-123",
    requesterTenantId: "test-tenant",
    requesterUserId: "user-1",
    callerIsAdmin: false
  });

  expect(db.lastQuery).toBeTruthy();
  expect(db.lastQuery.values).toEqual(["tok-123", "test-tenant", "user-1", false]);
  // Structural invariants with no DB-backed equivalent in a fake:
  // 1. Peek must NOT mutate the row — a failed storage read later cannot have
  //    already burned the token. The absence of an UPDATE / consumed_at write
  //    is the only observable proof against a query-capturing fake.
  expect(db.lastQuery.text.includes("UPDATE")).toBe(false);
  expect(db.lastQuery.text.includes("consumed_at = NOW()")).toBe(false);
  // 2. Peek deliberately omits the expiry filter (which consume includes) so an
  //    expired-but-unconsumed token still resolves and the route can answer 410.
  expect(db.lastQuery.text.includes("expires_at > NOW()")).toBe(false);
});

test("ArtifactStore.listForUser always scopes to tenant + user and excludes deleted/derived", async () => {
  const db = new CaptureDatabase();
  const store = new ArtifactStore(db as unknown as Pool);

  await store.listForUser("tenant-A", "user-1", {});

  expect(db.lastQuery).toBeTruthy();
  // tenant_id=$1, user_id=$2 are the isolation predicates (RLS is tenant-only).
  expect(db.lastQuery.values[0]).toBe("tenant-A");
  expect(db.lastQuery.values[1]).toBe("user-1");
  expect(db.lastQuery.text).toContain("tenant_id = $1");
  expect(db.lastQuery.text).toContain("user_id = $2");
  expect(db.lastQuery.text).toContain("status <> 'deleted'");
  expect(db.lastQuery.text).toContain("artifact_type <> 'derived'");
});

test("ArtifactStore.listForUser default sort is created_desc with id DESC tiebreaker", async () => {
  const db = new CaptureDatabase();
  const store = new ArtifactStore(db as unknown as Pool);

  await store.listForUser("tenant-A", "user-1", {});

  expect(db.lastQuery.text).toContain("ORDER BY created_at DESC, id DESC");
});

test("ArtifactStore.listForUser maps each sort to the correct ORDER BY", async () => {
  const cases: Array<[Parameters<ArtifactStore["listForUser"]>[2]["sort"], string]> = [
    ["created_asc", "ORDER BY created_at ASC, id ASC"],
    ["name_asc", "ORDER BY artifact_name ASC, id ASC"],
    ["name_desc", "ORDER BY artifact_name DESC, id DESC"],
    ["size_desc", "ORDER BY file_size_bytes DESC, id DESC"],
    ["size_asc", "ORDER BY file_size_bytes ASC, id ASC"]
  ];
  for (const [sort, expected] of cases) {
    const db = new CaptureDatabase();
    const store = new ArtifactStore(db as unknown as Pool);
    await store.listForUser("tenant-A", "user-1", { sort });
    expect(db.lastQuery.text).toContain(expected);
  }
});

test("ArtifactStore.listForUser fetches limit+1 rows and trims, emitting a cursor only when there is a next page", async () => {
  const db = new CaptureDatabase();
  // limit=2 → asks for 3; return 3 → hasMore.
  db.nextRows = [
    artifactRow({ id: 3, artifact_id: "a3", created_at: "2026-05-31T03:00:00.000Z" }),
    artifactRow({ id: 2, artifact_id: "a2", created_at: "2026-05-31T02:00:00.000Z" }),
    artifactRow({ id: 1, artifact_id: "a1", created_at: "2026-05-31T01:00:00.000Z" })
  ];
  const store = new ArtifactStore(db as unknown as Pool);

  const result = await store.listForUser("tenant-A", "user-1", { limit: 2 });

  // LIMIT bind is the last value and equals limit + 1.
  expect(db.lastQuery.values[db.lastQuery.values.length - 1]).toBe(3);
  expect(result.items).toHaveLength(2);
  expect(result.items.map((a) => a.artifactId)).toEqual(["a3", "a2"]);
  expect(result.nextCursor).toBeTruthy();
});

test("ArtifactStore.listForUser emits no cursor when the page is not full", async () => {
  const db = new CaptureDatabase();
  db.nextRows = [artifactRow({ id: 1 })];
  const store = new ArtifactStore(db as unknown as Pool);

  const result = await store.listForUser("tenant-A", "user-1", { limit: 50 });
  expect(result.nextCursor).toBeNull();
});

test("ArtifactStore.listForUser round-trips its own cursor and emits the keyset predicate", async () => {
  // Page 1 → mint a cursor.
  const db1 = new CaptureDatabase();
  db1.nextRows = [
    artifactRow({ id: 2, created_at: "2026-05-31T02:00:00.000Z" }),
    artifactRow({ id: 1, created_at: "2026-05-31T01:00:00.000Z" })
  ];
  const store1 = new ArtifactStore(db1 as unknown as Pool);
  const page1 = await store1.listForUser("tenant-A", "user-1", { limit: 1 });
  expect(page1.nextCursor).toBeTruthy();

  // Page 2 → feed the cursor back; it must decode and add the keyset predicate.
  const db2 = new CaptureDatabase();
  const store2 = new ArtifactStore(db2 as unknown as Pool);
  await store2.listForUser("tenant-A", "user-1", { limit: 1, cursor: page1.nextCursor! });

  expect(db2.lastQuery.text).toContain("(created_at, id) < ($");
  expect(db2.lastQuery.text).toContain("::timestamptz");
});

test("ArtifactStore.listForUser rejects a malformed cursor", async () => {
  const db = new CaptureDatabase();
  const store = new ArtifactStore(db as unknown as Pool);

  await expect(
    store.listForUser("tenant-A", "user-1", { cursor: "not-base64-json" })
  ).rejects.toBeInstanceOf(ArtifactCursorError);
});

test("ArtifactStore.listForUser rejects a tampered cursor whose key shape does not match the sort (no SQL 500)", async () => {
  // Hand-craft cursors with a valid sort/fv but a key of the wrong type for the
  // sort's SQL cast. These must be rejected at decode (→ 400), never reach the
  // `$key::timestamptz` / `::bigint` cast (→ would be a Postgres 500).
  const encode = (cursor: unknown) =>
    Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");

  // created_desc casts k::timestamptz — a non-date string must be rejected.
  const badTimestamp = encode({ k: "not-a-date", id: 1, sort: "created_desc", fv: "" });
  // size_desc casts k::bigint — a string (or non-integer) must be rejected.
  const badSize = encode({ k: "huge", id: 1, sort: "size_desc", fv: "" });
  // name_asc seeks on text — a numeric key is the wrong shape.
  const badName = encode({ k: 42, id: 1, sort: "name_asc", fv: "" });

  for (const [cursor, sort] of [
    [badTimestamp, "created_desc"],
    [badSize, "size_desc"],
    [badName, "name_asc"]
  ] as const) {
    const db = new CaptureDatabase();
    const store = new ArtifactStore(db as unknown as Pool);
    await expect(
      store.listForUser("tenant-A", "user-1", { sort, cursor })
    ).rejects.toBeInstanceOf(ArtifactCursorError);
    // The query must never run — rejection happens before any SQL is issued.
    expect(db.lastQuery).toBeNull();
  }
});

test("ArtifactStore.listForUser rejects a cursor minted under a different sort", async () => {
  const dbA = new CaptureDatabase();
  dbA.nextRows = [artifactRow({ id: 2 }), artifactRow({ id: 1 })];
  const storeA = new ArtifactStore(dbA as unknown as Pool);
  const page = await storeA.listForUser("tenant-A", "user-1", { limit: 1, sort: "created_desc" });

  const dbB = new CaptureDatabase();
  const storeB = new ArtifactStore(dbB as unknown as Pool);
  await expect(
    storeB.listForUser("tenant-A", "user-1", { sort: "name_asc", cursor: page.nextCursor! })
  ).rejects.toBeInstanceOf(ArtifactCursorError);
});

test("ArtifactStore.listForUser rejects a cursor minted under a different filter set", async () => {
  const dbA = new CaptureDatabase();
  dbA.nextRows = [artifactRow({ id: 2 }), artifactRow({ id: 1 })];
  const storeA = new ArtifactStore(dbA as unknown as Pool);
  const page = await storeA.listForUser("tenant-A", "user-1", { limit: 1, status: ["ready"] });

  const dbB = new CaptureDatabase();
  const storeB = new ArtifactStore(dbB as unknown as Pool);
  await expect(
    storeB.listForUser("tenant-A", "user-1", { status: ["failed"], cursor: page.nextCursor! })
  ).rejects.toBeInstanceOf(ArtifactCursorError);
});

test("ArtifactStore.listForUser escapes LIKE wildcards in q and binds an ILIKE param", async () => {
  const db = new CaptureDatabase();
  const store = new ArtifactStore(db as unknown as Pool);

  await store.listForUser("tenant-A", "user-1", { q: "50%_off" });

  expect(db.lastQuery.text).toContain("artifact_name ILIKE");
  // % and _ are escaped so they are treated literally, wrapped in %…%.
  expect(db.lastQuery.values).toContain("%50\\%\\_off%");
});

test("ArtifactStore.listForUser binds array filters as text[] ANY predicates", async () => {
  const db = new CaptureDatabase();
  const store = new ArtifactStore(db as unknown as Pool);

  await store.listForUser("tenant-A", "user-1", {
    artifactType: ["upload", "generated"],
    status: ["ready"]
  });

  expect(db.lastQuery.text).toContain("artifact_type = ANY($");
  expect(db.lastQuery.text).toContain("status = ANY($");
  expect(db.lastQuery.values).toContainEqual(["upload", "generated"]);
  expect(db.lastQuery.values).toContainEqual(["ready"]);
});

test("ArtifactStore.listForUser builds mimeClass SQL mirroring classifyMimeClass (text excludes code allowlist)", async () => {
  const db = new CaptureDatabase();
  const store = new ArtifactStore(db as unknown as Pool);

  await store.listForUser("tenant-A", "user-1", { mimeClass: ["image", "text"] });

  expect(db.lastQuery.text).toContain("mime_type ILIKE 'image/%'");
  // text/* but NOT the code allowlist.
  expect(db.lastQuery.text).toContain("mime_type ILIKE 'text/%' AND mime_type <> ALL($");
});
