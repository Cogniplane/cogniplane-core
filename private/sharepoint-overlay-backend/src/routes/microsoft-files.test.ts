import { expect, onTestFinished, test, vi } from "vitest";

import Fastify from "fastify";

import {
  MicrosoftConnectionRequiredError,
  MicrosoftGraphRequestError,
  MicrosoftImportBlockedError,
  MicrosoftImportPiiScanError,
  MicrosoftImportTooLargeError,
  MicrosoftUnsupportedImportError
} from "../services/microsoft-files-service.js";
import { MicrosoftInvalidIdError } from "../services/graph-id-validation.js";
import { ProjectAccessError } from "../../../../apps/backend/src/services/project-access.js";
import { SessionUploadAccessError } from "../../../../apps/backend/src/services/session-upload-access.js";

import { registerMicrosoftFileRoutes, replyForMicrosoftError } from "./microsoft-files.js";

function fakeReply(): {
  statusCode: number | null;
  reply: import("fastify").FastifyReply;
} {
  let captured: number | null = null;
  const reply = {
    code(n: number) {
      captured = n;
      return reply;
    }
  } as unknown as import("fastify").FastifyReply;
  return {
    get statusCode() {
      return captured;
    },
    reply
  };
}

test("replyForMicrosoftError: invalid id → 400", () => {
  const r = fakeReply();
  const out = replyForMicrosoftError(r.reply, new MicrosoftInvalidIdError("driveId"));
  expect(r.statusCode).toBe(400);
  expect((out as Record<string, unknown>).error).toBe("invalid_microsoft_id");
});

test("replyForMicrosoftError: connection required → 404", () => {
  const r = fakeReply();
  const out = replyForMicrosoftError(r.reply, new MicrosoftConnectionRequiredError());
  expect(r.statusCode).toBe(404);
  expect((out as Record<string, unknown>).error).toBe("microsoft_connection_not_found");
});

test("replyForMicrosoftError: unsupported MIME → 415", () => {
  const r = fakeReply();
  const out = replyForMicrosoftError(r.reply, new MicrosoftUnsupportedImportError("nope"));
  expect(r.statusCode).toBe(415);
  expect((out as Record<string, unknown>).error).toBe("unsupported_media_type");
});

test("replyForMicrosoftError: graph error 404 → 404 not found", () => {
  const r = fakeReply();
  const out = replyForMicrosoftError(r.reply, new MicrosoftGraphRequestError("not found", 404, { x: 1 }));
  expect(r.statusCode).toBe(404);
  expect((out as Record<string, unknown>).error).toBe("microsoft_item_not_found");
});

test("replyForMicrosoftError: graph error other status → 502", () => {
  const r = fakeReply();
  const out = replyForMicrosoftError(r.reply, new MicrosoftGraphRequestError("svc down", 503));
  expect(r.statusCode).toBe(502);
  expect((out as Record<string, unknown>).error).toBe("microsoft_graph_error");
});

test("replyForMicrosoftError: import blocked → 422 with reason+runId", () => {
  const r = fakeReply();
  const out = replyForMicrosoftError(
    r.reply,
    new MicrosoftImportBlockedError("pii_email", "run-1")
  );
  expect(r.statusCode).toBe(422);
  const body = out as Record<string, unknown>;
  expect(body.error).toBe("pii_block");
  expect(body.blockReason).toBe("pii_email");
  expect(body.scanRunId).toBe("run-1");
});

test("replyForMicrosoftError: PII scan error → 503 with code", () => {
  const r = fakeReply();
  const out = replyForMicrosoftError(
    r.reply,
    new MicrosoftImportPiiScanError("scan-broken", "scan-broke")
  );
  expect(r.statusCode).toBe(503);
  expect((out as Record<string, unknown>).error).toBe("scan-broken");
});

test.each(["unsupported_mime", "pdf_extraction_failed"])(
  "replyForMicrosoftError: a permanent PII rejection (%s) → 422 with its message",
  (code) => {
    const r = fakeReply();
    const out = replyForMicrosoftError(
      r.reply,
      new MicrosoftImportPiiScanError(code, "PII protection cannot scan this file.")
    );
    expect(r.statusCode).toBe(422);
    expect(out).toEqual({ error: code, message: "PII protection cannot scan this file." });
  }
);

test("replyForMicrosoftError: unknown error type re-throws", () => {
  const r = fakeReply();
  expect(() => replyForMicrosoftError(r.reply, new Error("unhandled"))).toThrow();
});

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

/** The tenant toggles of Microsoft 365 with Reads on. */
async function readsOn() {
  return { tenantEnabled: true, tenantReadsEnabled: true, tenantWritesEnabled: false, platformConfigured: true };
}

test("GET /integrations/microsoft/files/search returns search results", async () => {
  const app = Fastify();
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: "user-1",
      tenantId: "tenant-1",
      isAdmin: true,
      role: "owner"
    };
  });

  await registerMicrosoftFileRoutes(app, {
    loadIntegrationEnablement: readsOn,
    microsoftFiles: {
      async listSites() {
        return [];
      },
      async listFiles() {
        return [];
      },
      async searchFiles() {
        return [
          {
            itemId: "item-1",
            driveId: "drive-1",
            parentId: null,
            siteId: "site-1",
            name: "Impot 2025.pdf",
            webUrl: "https://example.com/file",
            size: 1024,
            mimeType: "application/pdf",
            isFolder: false,
            isFile: true,
            lastModifiedDateTime: null,
            path: "/sites/finance/Shared Documents",
            source: "sharepoint" as const,
            summary: "Tax return"
          }
        ];
      },
      async importFileToSession() {
        throw new Error("not used");
      }
    }
  });

  onTestFinished(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: "GET",
    url: "/integrations/microsoft/files/search?q=impot"
  });

  expect(response.statusCode).toBe(200);
  expect(response.json().results[0].name).toBe("Impot 2025.pdf");
});

test("POST /sessions/:sessionId/import-microsoft-file imports a file into the session", async () => {
  const app = Fastify();
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: "user-1",
      tenantId: "tenant-1",
      isAdmin: true,
      role: "owner"
    };
  });

  const importFileToSession = vi.fn(async () => ({
    artifactId: "artifact-1",
    id: 1,
    sessionId: SESSION_ID,
    userId: "user-1",
    artifactType: "upload" as const,
    sourceArtifactId: null,
    artifactName: "Impot 2025.pdf",
    mimeType: "application/pdf",
    storageBackend: "local" as const,
    storageKey: "user-1/session/file.pdf",
    fileSizeBytes: 1024,
    checksumSha256: "checksum",
    status: "ready" as const,
    createdByType: "user" as const,
    createdByRef: null,
    detail: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }));
  await registerMicrosoftFileRoutes(app, {
    loadIntegrationEnablement: readsOn,
    microsoftFiles: {
      listSites: async () => [], listFiles: async () => [], searchFiles: async () => [],
      importFileToSession,
    },
  });

  onTestFinished(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: "POST",
    url: `/sessions/${SESSION_ID}/import-microsoft-file`,
    headers: {
      "content-type": "application/json"
    },
    payload: {
      driveId: "drive-1",
      itemId: "item-1",
      artifactName: "Selected report.pdf"
    }
  });

  expect(importFileToSession).toHaveBeenCalledWith({
    tenantId: "tenant-1", userId: "user-1", sessionId: SESSION_ID,
    driveId: "drive-1", itemId: "item-1", artifactName: "Selected report.pdf",
    createdByType: "user",
  });
  expect(response.statusCode).toBe(201);
  expect(response.json().artifact.artifactId).toBe("artifact-1");
});

test.each([
  { name: "a session the user cannot upload to", error: new SessionUploadAccessError(), status: 404, code: "session_not_found" },
  { name: "a project where the user is no longer an editor", error: new ProjectAccessError("project_forbidden", "No access."), status: 403, code: "project_forbidden" },
  { name: "an oversized file", error: new MicrosoftImportTooLargeError(10), status: 413, code: "artifact_too_large" },
])("Microsoft import maps $name to $status", async ({ error, status, code }) => {
  const app = Fastify();
  onTestFinished(() => app.close());
  app.addHook("preHandler", async (request) => {
    request.auth = { tenantId: "tenant-1", userId: "user-1", isAdmin: false, role: "member" };
  });
  await registerMicrosoftFileRoutes(app, {
    loadIntegrationEnablement: readsOn,
    microsoftFiles: {
      listSites: async () => [], listFiles: async () => [], searchFiles: async () => [],
      importFileToSession: async () => { throw error; },
    },
  });
  const response = await app.inject({ method: "POST", url: `/sessions/${SESSION_ID}/import-microsoft-file`,
    payload: { driveId: "drive-1", itemId: "item-1" } });
  expect(response.statusCode).toBe(status);
  expect(response.json().error).toBe(code);
});

test("POST /sessions/:sessionId/import-microsoft-file applies the upload rate limit before the import", async () => {
  const app = Fastify();
  app.addHook("preHandler", async (request) => {
    request.auth = { userId: "user-1", tenantId: "tenant-1", isAdmin: false, role: "member" };
  });
  const limited: unknown[] = [];
  let imports = 0;
  await registerMicrosoftFileRoutes(app, {
    loadIntegrationEnablement: readsOn,
    microsoftFiles: {
      async listSites() { return []; },
      async listFiles() { return []; },
      async searchFiles() { return []; },
      async importFileToSession() { imports += 1; throw new Error("not reached"); }
    },
    limits: {
      async consumeRateLimit(input) {
        limited.push(input);
        return { error: "rate_limited", message: "Too many uploads.", retryAfterMs: 2_500 } as never;
      }
    }
  });
  onTestFinished(async () => { await app.close(); });

  const response = await app.inject({
    method: "POST",
    url: "/sessions/11111111-1111-4111-8111-111111111111/import-microsoft-file",
    payload: { driveId: "b!d", itemId: "01ABC" }
  });

  expect(response.statusCode).toBe(429);
  expect(response.headers["retry-after"]).toBe("3");
  expect(limited).toEqual([{ resource: "artifact_upload", userId: "user-1", tenantId: "tenant-1" }]);
  expect(imports).toBe(0);
});

test.each([
  ["GET", "/integrations/microsoft/sites", undefined],
  ["GET", "/integrations/microsoft/files", undefined],
  ["GET", "/integrations/microsoft/files/search?q=report", undefined],
  ["POST", `/sessions/${SESSION_ID}/import-microsoft-file`, { driveId: "drive-1", itemId: "item-1" }]
] as const)("%s %s answers 403 when the tenant turned Microsoft 365 reads off", async (method, url, payload) => {
  const app = Fastify();
  app.addHook("preHandler", async (request) => {
    request.auth = { userId: "user-1", tenantId: "tenant-1", isAdmin: false, role: "member" };
  });
  const loadIntegrationEnablement = vi.fn(async () => ({
    tenantEnabled: true, tenantReadsEnabled: false, tenantWritesEnabled: true, platformConfigured: true
  }));
  const used = vi.fn(async () => { throw new Error("the service must not be called"); });
  const consumeRateLimit = vi.fn(async () => null);
  await registerMicrosoftFileRoutes(app, {
    loadIntegrationEnablement,
    limits: { consumeRateLimit },
    microsoftFiles: { listSites: used, listFiles: used, searchFiles: used, importFileToSession: used }
  });
  onTestFinished(async () => {
    await app.close();
  });

  const response = await app.inject({ method, url, ...(payload ? { payload } : {}) });

  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({ error: "microsoft_integration_disabled" });
  expect(loadIntegrationEnablement).toHaveBeenCalledWith("tenant-1", "microsoft");
  expect(used).not.toHaveBeenCalled();
  // A refused import spends no upload quota.
  expect(consumeRateLimit).not.toHaveBeenCalled();
});
