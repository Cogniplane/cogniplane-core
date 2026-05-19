import Fastify from "fastify";
import { test, expect } from "vitest";

import { registerArtifactRoutes } from "./artifacts.js";
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

function buildApp(opts: {
  initialRows: FakeTokenRow[];
  auth: { userId: string; tenantId: string; role: "owner" | "admin" | "member" };
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
        row.consumedAt = new Date().toISOString();
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
    },
    auditEvents: audit,
    storage: {
      async openReadStream() {
        const { Readable } = await import("node:stream");
        return { stream: Readable.from([Buffer.from("PAYLOAD")]), fileSizeBytes: 7 };
      }
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

test("GET /downloads/:token returns 410 when the token has expired", async () => {
  const expired = makeRow({ expiresAt: new Date(Date.now() - 10_000).toISOString() });
  const { app, stores } = buildApp({
    initialRows: [expired],
    auth: { userId: "user-1", tenantId: "tenant-A", role: "member" }
  });
  await registerArtifactRoutes(app, stores as never);
  await app.ready();

  const response = await app.inject({ method: "GET", url: "/downloads/tok-1" });
  expect(response.statusCode).toBe(410);
  expect(response.json().error).toBe("download_expired");

  await app.close();
});
