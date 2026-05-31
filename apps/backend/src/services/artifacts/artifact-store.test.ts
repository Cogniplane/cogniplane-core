import { test, expect } from "vitest";

import type { Pool } from "../../lib/db.js";

import { ArtifactStore } from "./artifact-store.js";

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
