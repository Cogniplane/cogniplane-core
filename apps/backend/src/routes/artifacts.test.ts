import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { describe, test, expect } from "vitest";

import { registerArtifactRoutes } from "./artifacts.js";
import { ArtifactCursorError } from "../services/artifacts/artifact-store.js";
import { FakePool } from "../test-helpers/fake-pool.js";
import { InMemoryAuditEventStore } from "../test-helpers/in-memory-audit-events.js";
import { createTestConfig } from "../test-helpers/test-config.js";

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
    sessions: { async getOwned() { return null; }, async getReadable() { return null; } },
    messages: { async getOwned() { return null; } },
    artifacts: {
      async getReadable() { return null; },
      async create() { throw new Error("not used"); },
      async listBySession() { return []; },
      async createDownloadToken() { throw new Error("not used"); },
      // Mirrors the SQL gating: unknown and already-consumed tokens match no
      // rows. Does NOT consume and does NOT filter on expiry (the route turns
      // expiry into a 410).
      async peekDownloadToken(input: { token: string }) {
        const row = rows.get(input.token);
        if (!row) return null;
        if (row.consumedAt !== null) return null;
        return toRecord(row);
      },
      // Same gating as peek plus the single-use flip and `expires_at > NOW()`
      // predicate — an expired token is never consumed.
      async consumeDownloadToken(input: { token: string }) {
        const row = rows.get(input.token);
        if (!row) return null;
        if (row.consumedAt !== null) return null;
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

test("GET /downloads/:token takes identity from the token, not from request.auth", async () => {
  // The route is public: browser navigations and <img> tags cannot send the
  // Bearer header. Whatever the auth hook set, the audit event names the token
  // user, and the SQL gate checks that user's current session access.
  const { app, stores, rows, audit } = buildApp({
    initialRows: [makeRow({ tenantId: "tenant-A", userId: "user-1" })],
    auth: { userId: "someone-else", tenantId: "tenant-B", role: "member" }
  });
  await registerArtifactRoutes(app, stores as never);
  await app.ready();

  const response = await app.inject({ method: "GET", url: "/downloads/tok-1" });
  expect(response.statusCode).toBe(200);
  expect(response.body).toBe("PAYLOAD");
  expect(rows.get("tok-1")?.consumedAt).not.toBeNull();
  const event = audit.events.find((entry) => entry.type === "artifact_downloaded");
  expect(event?.userId).toBe("user-1");
  expect(event?.payload).toEqual({ artifactId: "artifact-1", fileName: expect.any(String) });

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

test("GET /downloads/:token still streams the file when the audit write fails — the consumed token is not burned", async () => {
  const { app, stores, audit } = buildApp({
    initialRows: [makeRow()],
    auth: { userId: "user-1", tenantId: "tenant-A", role: "member" }
  });
  // The audit write runs AFTER consumeDownloadToken; if its failure escaped,
  // the client would get a 500 with the single-use token already spent.
  audit.create = async () => {
    throw new Error("audit table unavailable");
  };
  await registerArtifactRoutes(app, stores as never);
  await app.ready();

  const response = await app.inject({ method: "GET", url: "/downloads/tok-1" });
  expect(response.statusCode).toBe(200);
  expect(response.body).toBe("PAYLOAD");

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
    sessions: { async getOwned() { return null; }, async getReadable() { return null; } },
    messages: { async getOwned() { return null; } },
    artifacts: {
      async getReadable() { return null; },
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

// ── GET /downloads/:token (Content-Disposition) ──────────────────────────────

describe("GET /downloads/:token Content-Disposition", () => {
  async function downloadHeader(fileName: string) {
    const { app, stores } = buildApp({
      initialRows: [makeRow({ fileName })],
      auth: { userId: "user-1", tenantId: "tenant-A", role: "member" }
    });
    await registerArtifactRoutes(app, stores as never);
    await app.ready();
    const response = await app.inject({ method: "GET", url: "/downloads/tok-1" });
    await app.close();
    return response;
  }

  test.each([
    ["a relative path", "../../etc/passwd", `attachment; filename="passwd"; filename*=UTF-8''passwd`],
    ["an absolute path", "/etc/shadow", `attachment; filename="shadow"; filename*=UTF-8''shadow`],
    ["a Windows path", "C:\\Users\\bob\\evil.exe", `attachment; filename="evil.exe"; filename*=UTF-8''evil.exe`],
    ["quotes", 'say "hi".txt', `attachment; filename="say _hi_.txt"; filename*=UTF-8''say%20%22hi%22.txt`],
    ["Unicode", "日本語.pdf", `attachment; filename="___.pdf"; filename*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E.pdf`],
    ["an empty name", "", `attachment; filename="download"; filename*=UTF-8''download`],
    ["a dot-only name", "..", `attachment; filename="download"; filename*=UTF-8''download`]
  ])("names the same safe file in both parameters for %s", async (_label, fileName, expected) => {
    const response = await downloadHeader(fileName);

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-disposition"]).toBe(expected);
  });

  test("a CRLF in a stored name cannot inject a header", async () => {
    const response = await downloadHeader("evil\r\nX-Injected: yes.txt");

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-injected"]).toBeUndefined();
    expect(response.headers["content-disposition"]).toBe(
      `attachment; filename="evilX-Injected: yes.txt"; filename*=UTF-8''evilX-Injected%3A%20yes.txt`
    );
  });
});

// ── POST /artifacts/:artifactId/download-token (PII eligibility) ─────────────

describe("POST /artifacts/:artifactId/download-token", () => {
  const artifactId = "0196f7ca-8d4b-7a70-9f3f-111111111111";

  async function issue(artifact: { status: string; detail: Record<string, unknown> }) {
    const issued: unknown[] = [];
    const stores = {
      sessions: { async requireUploadAccess() { return null; }, async getReadable() { return null; } },
      artifacts: {
        async getReadable() {
          return {
            artifactId,
            sessionId: "session-1",
            storageBackend: "local",
            storageKey: "user-1/session-1/report.txt",
            artifactName: "report.txt",
            mimeType: "text/plain",
            ...artifact
          };
        },
        async createDownloadToken(input: unknown) {
          issued.push(input);
          return { token: "tok-new", expiresAt: new Date(Date.now() + 60_000).toISOString() };
        }
      },
      auditEvents: new InMemoryAuditEventStore(),
      storage: {},
      processor: {},
      limits: { async consumeRateLimit() { return null; } }
    };
    const app = Fastify();
    app.decorate("config", createTestConfig());
    app.addHook("preHandler", async (request) => {
      request.auth = { userId: "user-1", tenantId: "tenant-A", isAdmin: false, role: "member" };
    });
    await registerArtifactRoutes(app, stores as never);
    await app.ready();
    const response = await app.inject({ method: "POST", url: `/artifacts/${artifactId}/download-token` });
    await app.close();
    return { response, issued };
  }

  test.each(["blocked", "pending", "scanning"])(
    "refuses a ready artifact whose PII verdict is %s",
    async (piiStatus) => {
      // The status column says ready; only the PII verdict says otherwise.
      const { response, issued } = await issue({ status: "ready", detail: { pii: { status: piiStatus } } });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("artifact_not_ready");
      expect(issued).toEqual([]);
    }
  );

  test.each([
    ["a detect-only verdict with findings", { pii: { status: "scanned", modeApplied: "detect", findingsCount: 4 } }],
    ["a transformed verdict", { pii: { status: "transformed" } }],
    ["no verdict", {}]
  ])("issues a token for a ready artifact with %s", async (_label, detail) => {
    const { response, issued } = await issue({ status: "ready", detail });

    expect(response.statusCode).toBe(200);
    expect(response.json().download.url).toBe("/downloads/tok-new");
    expect(issued).toHaveLength(1);
  });

  test("refuses an artifact that is not ready, whatever its PII verdict", async () => {
    const { response, issued } = await issue({ status: "pending", detail: { pii: { status: "scanned" } } });

    expect(response.statusCode).toBe(409);
    expect(issued).toEqual([]);
  });
});

// ── GET /artifacts/:artifactId/preview-text (PII eligibility) ────────────────

describe("GET /artifacts/:artifactId/preview-text", () => {
  const artifactId = "0196f7ca-8d4b-7a70-9f3f-333333333333";

  type Version = { status: string; detail: Record<string, unknown> };

  // `reads` are what getReadable returns on each call: the first read gates the
  // request, the second is the re-check after extraction.
  async function preview(reads: Version[]) {
    let extractions = 0;
    let readCount = 0;
    const stores = {
      sessions: { async requireUploadAccess() { return null; }, async getReadable() { return null; } },
      artifacts: {
        async getReadable() {
          const version = reads[Math.min(readCount, reads.length - 1)] as Version;
          readCount += 1;
          return { artifactId, mimeType: "application/pdf", ...version };
        }
      },
      auditEvents: new InMemoryAuditEventStore(),
      storage: {},
      processor: {
        async extractArtifactText() {
          extractions += 1;
          return "EXTRACTED TEXT";
        }
      },
      limits: { async consumeRateLimit() { return null; } }
    };
    const app = Fastify();
    app.decorate("config", createTestConfig());
    app.addHook("preHandler", async (request) => {
      request.auth = { userId: "user-1", tenantId: "tenant-A", isAdmin: false, role: "member" };
    });
    await registerArtifactRoutes(app, stores as never);
    await app.ready();
    const response = await app.inject({ method: "GET", url: `/artifacts/${artifactId}/preview-text` });
    await app.close();
    return { response, extractions: () => extractions };
  }

  const ready = (detail: Record<string, unknown>): Version => ({ status: "ready", detail });

  test.each(["blocked", "pending", "scanning"])(
    "withholds the text of a ready artifact whose PII verdict is %s, without extracting it",
    async (piiStatus) => {
      const { response, extractions } = await preview([ready({ pii: { status: piiStatus } })]);

      expect(response.statusCode).toBe(422);
      expect(response.json().error).toBe("artifact_not_ready");
      expect(response.body).not.toContain("EXTRACTED TEXT");
      expect(extractions()).toBe(0);
    }
  );

  test("withholds the text when a block lands while it is being extracted", async () => {
    const { response, extractions } = await preview([
      ready({}),
      ready({ pii: { status: "blocked" } })
    ]);

    expect(extractions()).toBe(1);
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe("artifact_not_ready");
    expect(response.body).not.toContain("EXTRACTED TEXT");
  });

  test.each([
    ["a detect-only verdict with findings", { pii: { status: "scanned", modeApplied: "detect", findingsCount: 4 } }],
    ["no verdict", {}]
  ])("returns the text of a ready artifact with %s", async (_label, detail) => {
    const { response } = await preview([ready(detail)]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ text: "EXTRACTED TEXT" });
  });

  test("still refuses an artifact that is not ready", async () => {
    const { response, extractions } = await preview([{ status: "pending", detail: {} }]);

    expect(response.statusCode).toBe(422);
    expect(extractions()).toBe(0);
  });
});

// ── POST /artifacts (file name validation) ───────────────────────────────────

describe("POST /artifacts file name validation", () => {
  const sessionId = "0196f7ca-8d4b-7a70-9f3f-222222222222";
  const boundary = "----cogniplane-upload-boundary";

  // Raw bytes, so a NUL really reaches the multipart parser.
  function multipartBody(input: { fields?: Record<string, string>; filename: string; content?: string }) {
    const chunks: Buffer[] = [];
    for (const [name, value] of Object.entries({ sessionId, ...input.fields })) {
      chunks.push(
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`),
        Buffer.from(value),
        Buffer.from("\r\n")
      );
    }
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${input.filename}"\r\n` +
          "Content-Type: text/plain\r\n\r\n"
      ),
      Buffer.from(input.content ?? "artifact body"),
      Buffer.from(`\r\n--${boundary}--\r\n`)
    );
    return Buffer.concat(chunks);
  }

  async function buildUploadApp(maxUploadBytes?: number) {
    const calls = {
      requireUploadAccess: 0,
      put: [] as string[],
      createUpload: [] as Array<{ artifactName: string }>
    };
    const record = (artifactName: string) => ({
      artifactId: "artifact-1",
      sessionId,
      userId: "user-1",
      artifactType: "upload",
      artifactName,
      mimeType: "text/plain",
      status: "pending",
      detail: {}
    });
    let lastName = "";
    const stores = {
      sessions: {
        async requireUploadAccess() {
          calls.requireUploadAccess += 1;
          return null;
        },
        async getReadable() { return null; }
      },
      artifacts: {
        async createUpload(input: { artifactName: string }) {
          calls.createUpload.push({ artifactName: input.artifactName });
          lastName = input.artifactName;
          return record(input.artifactName);
        },
        async update() { return null; },
        async getReadable() { return record(lastName); }
      },
      auditEvents: new InMemoryAuditEventStore(),
      storage: {
        async put(input: { storageKey: string; stream: AsyncIterable<Buffer> }) {
          calls.put.push(input.storageKey);
          let size = 0;
          for await (const chunk of input.stream) size += chunk.length;
          return { storageBackend: "local", storageKey: input.storageKey, fileSizeBytes: size, checksumSha256: "sum" };
        },
        async delete() {}
      },
      processor: {},
      limits: { async consumeRateLimit() { return null; } }
    };
    const config = createTestConfig(maxUploadBytes ? { ARTIFACT_MAX_UPLOAD_BYTES: maxUploadBytes } : {});
    const app = Fastify();
    app.decorate("config", config);
    app.decorate("db", new FakePool().onQuery(/INSERT INTO users/, () => ({ rows: [], rowCount: 1 })).asPool());
    await app.register(multipart, { limits: { fileSize: config.ARTIFACT_MAX_UPLOAD_BYTES, files: 1 } });
    app.addHook("preHandler", async (request) => {
      request.auth = { userId: "user-1", tenantId: "tenant-A", isAdmin: false, role: "member" };
    });
    await registerArtifactRoutes(app, stores as never);
    await app.ready();
    const upload = (body: Buffer) =>
      app.inject({
        method: "POST",
        url: "/artifacts",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: body
      });
    return { app, calls, upload };
  }

  test("stores an upload with a valid name (positive control)", async () => {
    const { app, calls, upload } = await buildUploadApp();

    const response = await upload(multipartBody({ filename: "notes.txt" }));

    expect(response.statusCode).toBe(201);
    expect(calls.put).toHaveLength(1);
    expect(calls.createUpload).toEqual([{ artifactName: "notes.txt" }]);
    await app.close();
  });

  test.each([
    ["NUL", "a\0b.txt"],
    ["a control character", "a\tb.txt"],
    ["a C1 control character", "a\u0085b.txt"],
    ["a bidirectional override", "invoice\u202Etxt.exe"]
  ])("rejects a custom name field with %s before storing anything", async (_label, name) => {
    const { app, calls, upload } = await buildUploadApp();

    const response = await upload(multipartBody({ fields: { name }, filename: "notes.txt" }));

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_filename");
    expect(response.body).not.toContain("invoice");
    expect(calls.put).toEqual([]);
    expect(calls.createUpload).toEqual([]);
    expect(calls.requireUploadAccess).toBe(0);
    await app.close();
  });

  test("rejects a NUL in the multipart filename before storing anything", async () => {
    const { app, calls, upload } = await buildUploadApp();

    const response = await upload(multipartBody({ filename: "no\0tes.txt" }));

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_filename");
    expect(response.json().message).toMatch(/NUL/);
    expect(calls.put).toEqual([]);
    expect(calls.createUpload).toEqual([]);
    expect(calls.requireUploadAccess).toBe(0);
    await app.close();
  });

  test("keeps serving uploads after refusing a bad name", async () => {
    const { app, calls, upload } = await buildUploadApp();

    expect((await upload(multipartBody({ filename: "no\0tes.txt" }))).statusCode).toBe(400);
    const next = await upload(multipartBody({ filename: "notes.txt" }));

    expect(next.statusCode).toBe(201);
    expect(calls.put).toHaveLength(1);
    await app.close();
  });

  test("still enforces the upload size limit before the name check", async () => {
    const { app, calls, upload } = await buildUploadApp(8);

    const response = await upload(multipartBody({ filename: "no\0tes.txt", content: "far more than eight bytes" }));

    expect(response.statusCode).toBe(413);
    expect(response.json().error).toBe("artifact_too_large");
    expect(calls.put).toEqual([]);
    await app.close();
  });
});
