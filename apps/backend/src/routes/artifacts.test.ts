import Fastify from "fastify";
import { test, expect } from "vitest";

import { registerArtifactRoutes } from "./artifacts.js";
import { ArtifactCursorError } from "../services/artifacts/artifact-store.js";
import { InMemoryAuditEventStore } from "../test-helpers/in-memory-audit-events.js";

type FakeTokenRow = {
  token: string;
  tenantId: string;
  artifactId: string;
  sessionId: string;
  userId: string;
  storageBackend: "local";
  storageKey: string;
  fileName: string;
  contentType: string;
  expiresAt: string;
  createdAt: string;
  consumedAt: string | null;
};

function makeRow(overrides: Partial<FakeTokenRow> = {}): FakeTokenRow {
  const now = Date.now();
  return {
    token: "tok-1",
    tenantId: "tenant-A",
    artifactId: "artifact-1",
    sessionId: "session-1",
    userId: "user-1",
    storageBackend: "local",
    storageKey: "tenant-A/artifact-1.bin",
    fileName: "report.bin",
    contentType: "application/octet-stream",
    expiresAt: new Date(now + 60_000).toISOString(),
    createdAt: new Date(now).toISOString(),
    consumedAt: null,
    ...overrides
  };
}

function toRecord(row: FakeTokenRow) {
  return {
    token: row.token,
    tenantId: row.tenantId,
    artifactId: row.artifactId,
    sessionId: row.sessionId,
    userId: row.userId,
    storageBackend: row.storageBackend,
    storageKey: row.storageKey,
    fileName: row.fileName,
    contentType: row.contentType,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt
  };
}

function buildApp(opts: {
  initialRows: FakeTokenRow[];
  auth: { userId: string; tenantId: string; role: "owner" | "admin" | "member" };
  openReadStream?: () => Promise<{ stream: unknown; fileSizeBytes: number }>;
}) {
  const rows = new Map(opts.initialRows.map((row) => [row.token, row]));
  const audit = new InMemoryAuditEventStore();

  const stores = {
    sessions: { async getOwned() { return null; } },
    messages: { async getOwned() { return null; } },
    artifacts: {
      async getOwned() { return null; },
      async create() { throw new Error("not used"); },
      async listBySession() { return []; },
      async createDownloadToken() { throw new Error("not used"); },
      // Mirrors the SQL gating: unknown token, already-consumed, cross-tenant,
      // and wrong-user all match no rows. Does NOT consume and does NOT filter
      // on expiry (the route turns expiry into a 410).
      async peekDownloadToken(input: {
        token: string;
        requesterTenantId: string;
        requesterUserId: string;
        callerIsAdmin: boolean;
      }) {
        const row = rows.get(input.token);
        if (!row) return null;
        if (row.consumedAt !== null) return null;
        if (row.tenantId !== input.requesterTenantId) return null;
        if (!input.callerIsAdmin && row.userId !== input.requesterUserId) return null;
        return toRecord(row);
      },
      // Same gating as peek plus the single-use flip and `expires_at > NOW()`
      // predicate — an expired token is never consumed.
      async consumeDownloadToken(input: {
        token: string;
        requesterTenantId: string;
        requesterUserId: string;
        callerIsAdmin: boolean;
      }) {
        const row = rows.get(input.token);
        if (!row) return null;
        if (row.consumedAt !== null) return null;
        if (row.tenantId !== input.requesterTenantId) return null;
        if (!input.callerIsAdmin && row.userId !== input.requesterUserId) return null;
        if (new Date(row.expiresAt).getTime() <= Date.now()) return null;
        row.consumedAt = new Date().toISOString();
        return toRecord(row);
      }
    },
    auditEvents: audit,
    storage: {
      openReadStream:
        opts.openReadStream ??
        (async () => {
          const { Readable } = await import("node:stream");
          return { stream: Readable.from([Buffer.from("PAYLOAD")]), fileSizeBytes: 7 };
        })
    },
    processor: { async extractArtifactText() { return null; } }
  };

  const app = Fastify();
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: opts.auth.userId,
      tenantId: opts.auth.tenantId,
      isAdmin: opts.auth.role !== "member",
      role: opts.auth.role
    };
  });
  return { app, stores, audit, rows };
}

test("GET /downloads/:token streams once, then returns 404 on replay (single-use)", async () => {
  const { app, stores } = buildApp({
    initialRows: [makeRow()],
    auth: { userId: "user-1", tenantId: "tenant-A", role: "member" }
  });
  await registerArtifactRoutes(app, stores as never);
  await app.ready();

  const first = await app.inject({ method: "GET", url: "/downloads/tok-1" });
  expect(first.statusCode).toBe(200);
  expect(first.body).toBe("PAYLOAD");

  const second = await app.inject({ method: "GET", url: "/downloads/tok-1" });
  expect(second.statusCode).toBe(404);
  expect(second.json().error).toBe("download_not_found");

  await app.close();
});

test("GET /downloads/:token returns 404 when caller's tenant does not match the token's tenant — and does NOT consume the token", async () => {
  const { app, stores, rows } = buildApp({
    initialRows: [makeRow({ tenantId: "tenant-A" })],
    auth: { userId: "attacker", tenantId: "tenant-B", role: "member" }
  });
  await registerArtifactRoutes(app, stores as never);
  await app.ready();

  const response = await app.inject({ method: "GET", url: "/downloads/tok-1" });
  expect(response.statusCode).toBe(404);
  expect(response.json().error).toBe("download_not_found");
  // Token must remain unconsumed so the legitimate owner can still use it.
  expect(rows.get("tok-1")?.consumedAt).toBeNull();

  await app.close();
});

test("GET /downloads/:token returns 404 for a same-tenant different-user caller — and does NOT consume the token", async () => {
  // Same tenant, but the caller is a non-admin peer who does not own the token.
  // SQL identity gating must hide it (404) without burning the single-use flag,
  // so the rightful owner can still download.
  const { app, stores, rows } = buildApp({
    initialRows: [makeRow({ tenantId: "tenant-A", userId: "user-1" })],
    auth: { userId: "user-2", tenantId: "tenant-A", role: "member" }
  });
  await registerArtifactRoutes(app, stores as never);
  await app.ready();

  const response = await app.inject({ method: "GET", url: "/downloads/tok-1" });
  expect(response.statusCode).toBe(404);
  expect(response.json().error).toBe("download_not_found");
  expect(rows.get("tok-1")?.consumedAt).toBeNull();

  await app.close();
});

test("GET /downloads/:token lets an admin in the same tenant download a peer's token (admin bypass)", async () => {
  // Admin-minted tokens carry the artifact OWNER's user_id, not the admin's.
  // role=admin sets callerIsAdmin=true, which skips the user-equality check so
  // the admin can resolve and consume the token.
  const { app, stores, rows } = buildApp({
    initialRows: [makeRow({ tenantId: "tenant-A", userId: "user-1" })],
    auth: { userId: "admin-user", tenantId: "tenant-A", role: "admin" }
  });
  await registerArtifactRoutes(app, stores as never);
  await app.ready();

  const response = await app.inject({ method: "GET", url: "/downloads/tok-1" });
  expect(response.statusCode).toBe(200);
  expect(response.body).toBe("PAYLOAD");
  // The bypass path still consumes the token exactly once.
  expect(rows.get("tok-1")?.consumedAt).not.toBeNull();

  await app.close();
});

test("GET /downloads/:token returns 410 when the token has expired — and does NOT consume it (repeatable)", async () => {
  const expired = makeRow({ expiresAt: new Date(Date.now() - 10_000).toISOString() });
  const { app, stores, rows } = buildApp({
    initialRows: [expired],
    auth: { userId: "user-1", tenantId: "tenant-A", role: "member" }
  });
  await registerArtifactRoutes(app, stores as never);
  await app.ready();

  const first = await app.inject({ method: "GET", url: "/downloads/tok-1" });
  expect(first.statusCode).toBe(410);
  expect(first.json().error).toBe("download_expired");
  // Expiry is surfaced without spending the token, so the 410 is repeatable.
  expect(rows.get("tok-1")?.consumedAt).toBeNull();

  const second = await app.inject({ method: "GET", url: "/downloads/tok-1" });
  expect(second.statusCode).toBe(410);

  await app.close();
});

test("GET /downloads/:token does NOT consume the token when the storage read fails — so a retry can still download", async () => {
  let calls = 0;
  const { app, stores, rows } = buildApp({
    initialRows: [makeRow()],
    auth: { userId: "user-1", tenantId: "tenant-A", role: "member" },
    openReadStream: async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("transient S3 error");
      }
      const { Readable } = await import("node:stream");
      return { stream: Readable.from([Buffer.from("PAYLOAD")]), fileSizeBytes: 7 };
    }
  });
  await registerArtifactRoutes(app, stores as never);
  await app.ready();

  const failed = await app.inject({ method: "GET", url: "/downloads/tok-1" });
  expect(failed.statusCode).toBe(500);
  // The single-use flag must survive a failed storage read.
  expect(rows.get("tok-1")?.consumedAt).toBeNull();

  // The retry succeeds and consumes the token exactly once.
  const ok = await app.inject({ method: "GET", url: "/downloads/tok-1" });
  expect(ok.statusCode).toBe(200);
  expect(ok.body).toBe("PAYLOAD");
  expect(rows.get("tok-1")?.consumedAt).not.toBeNull();

  await app.close();
});

test("GET /downloads/:token destroys the opened stream when the single-use consume race is lost", async () => {
  let destroyed = false;
  const { app, stores } = buildApp({
    initialRows: [makeRow()],
    auth: { userId: "user-1", tenantId: "tenant-A", role: "member" },
    // We open the stream BEFORE consuming; on a lost race it must be destroyed
    // so an S3/HTTP body isn't left dangling.
    openReadStream: async () => ({
      stream: { destroy: () => { destroyed = true; } },
      fileSizeBytes: 7
    })
  });
  // Simulate a concurrent request consuming the token first: peek still
  // succeeds, but consume finds no pending row.
  stores.artifacts.consumeDownloadToken = async () => null;

  await registerArtifactRoutes(app, stores as never);
  await app.ready();

  const res = await app.inject({ method: "GET", url: "/downloads/tok-1" });
  expect(res.statusCode).toBe(404);
  expect(res.json().error).toBe("download_not_found");
  expect(destroyed).toBe(true);

  await app.close();
});

// ── GET /artifacts (cross-session browser) ───────────────────────────────────

type BrowseArtifact = {
  artifactId: string;
  userId: string;
  artifactType: "upload" | "generated" | "derived";
  status: string;
  artifactName: string;
};

function buildBrowseApp(opts: {
  artifacts: BrowseArtifact[];
  auth: { userId: string; tenantId: string };
  onListForUser?: (tenantId: string, userId: string, listOpts: Record<string, unknown>) => unknown;
}) {
  const stores = {
    sessions: { async getOwned() { return null; } },
    messages: { async getOwned() { return null; } },
    artifacts: {
      async getOwned() { return null; },
      async create() { throw new Error("not used"); },
      async listBySession() { return []; },
      async createDownloadToken() { throw new Error("not used"); },
      async peekDownloadToken() { return null; },
      async consumeDownloadToken() { return null; },
      // Realistic-enough fake: honors user isolation + derived exclusion and
      // returns a {items,nextCursor} shape so the route wiring is exercised.
      async listForUser(
        tenantId: string,
        userId: string,
        listOpts: Record<string, unknown>
      ) {
        if (opts.onListForUser) {
          return opts.onListForUser(tenantId, userId, listOpts);
        }
        const items = opts.artifacts
          .filter((a) => a.userId === userId)
          .filter((a) => a.artifactType !== "derived")
          .filter((a) => a.status !== "deleted");
        return { items, nextCursor: null };
      }
    },
    auditEvents: new InMemoryAuditEventStore(),
    storage: { async openReadStream() { return { stream: null, fileSizeBytes: 0 }; } },
    processor: { async extractArtifactText() { return null; } }
  };

  const app = Fastify();
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: opts.auth.userId,
      tenantId: opts.auth.tenantId,
      isAdmin: false,
      role: "member"
    };
  });
  return { app, stores };
}

test("GET /artifacts returns the caller's own artifacts and excludes others' / derived", async () => {
  const { app, stores } = buildBrowseApp({
    auth: { userId: "user-1", tenantId: "tenant-A" },
    artifacts: [
      { artifactId: "a1", userId: "user-1", artifactType: "upload", status: "ready", artifactName: "mine.pdf" },
      { artifactId: "a2", userId: "user-2", artifactType: "upload", status: "ready", artifactName: "theirs.pdf" },
      { artifactId: "a3", userId: "user-1", artifactType: "derived", status: "ready", artifactName: "shadow.txt" }
    ]
  });
  await registerArtifactRoutes(app, stores as never);
  await app.ready();

  const res = await app.inject({ method: "GET", url: "/artifacts" });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.items.map((a: BrowseArtifact) => a.artifactId)).toEqual(["a1"]);
  expect(body.nextCursor).toBeNull();

  await app.close();
});

test("GET /artifacts forwards parsed filters/sort/limit to the store", async () => {
  let captured: Record<string, unknown> | null = null;
  const { app, stores } = buildBrowseApp({
    auth: { userId: "user-1", tenantId: "tenant-A" },
    artifacts: [],
    onListForUser: (_t, _u, listOpts) => {
      captured = listOpts;
      return { items: [], nextCursor: null };
    }
  });
  await registerArtifactRoutes(app, stores as never);
  await app.ready();

  const res = await app.inject({
    method: "GET",
    url: "/artifacts?q=report&type=upload&type=generated&status=ready&mimeClass=pdf&sort=name_asc&limit=10"
  });
  expect(res.statusCode).toBe(200);
  expect(captured).toEqual({
    q: "report",
    artifactType: ["upload", "generated"],
    status: ["ready"],
    mimeClass: ["pdf"],
    sort: "name_asc",
    limit: 10,
    cursor: undefined
  });

  await app.close();
});

test("GET /artifacts returns 400 on an invalid sort value", async () => {
  const { app, stores } = buildBrowseApp({
    auth: { userId: "user-1", tenantId: "tenant-A" },
    artifacts: []
  });
  await registerArtifactRoutes(app, stores as never);
  await app.ready();

  const res = await app.inject({ method: "GET", url: "/artifacts?sort=bogus" });
  expect(res.statusCode).toBe(400);

  await app.close();
});

test("GET /artifacts returns 400 when the store rejects a malformed cursor", async () => {
  const { app, stores } = buildBrowseApp({
    auth: { userId: "user-1", tenantId: "tenant-A" },
    artifacts: [],
    onListForUser: () => {
      throw new ArtifactCursorError("malformed_cursor");
    }
  });
  await registerArtifactRoutes(app, stores as never);
  await app.ready();

  const res = await app.inject({ method: "GET", url: "/artifacts?cursor=garbage" });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toBe("malformed_cursor");

  await app.close();
});

test("GET /artifacts returns 400 when the store rejects a sort/filter-mismatched cursor", async () => {
  const { app, stores } = buildBrowseApp({
    auth: { userId: "user-1", tenantId: "tenant-A" },
    artifacts: [],
    onListForUser: () => {
      throw new ArtifactCursorError("cursor_sort_filter_mismatch");
    }
  });
  await registerArtifactRoutes(app, stores as never);
  await app.ready();

  const res = await app.inject({ method: "GET", url: "/artifacts?cursor=valid-but-stale" });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toBe("cursor_sort_filter_mismatch");

  await app.close();
});
