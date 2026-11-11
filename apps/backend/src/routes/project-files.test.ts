import Fastify from "fastify";
import { Readable } from "node:stream";
import { afterEach, describe, expect, onTestFinished, test, vi } from "vitest";

import { handleAppError } from "../app.js";
import { registerProjectFileRoutes } from "./project-files.js";
import { RequestLimitsUnavailableError } from "../services/redis-request-limits.js";
import { FakePool } from "../test-helpers/fake-pool.js";

const projectId = "0196f7ca-8d4b-7a70-9f3f-111111111111";
const fileId = "0196f7ca-8d4b-7a70-9f3f-222222222222";
const versionId = "0196f7ca-8d4b-7a70-9f3f-333333333333";

afterEach(() => {
  vi.restoreAllMocks();
});

const auth = { userId: "user-1", tenantId: "tenant-A", isAdmin: false, role: "member" } as const;

describe("project file route dependencies", () => {
  test("the routes use the injected project file store and build no store of their own", async () => {
    const list = vi.fn(async () => ({ files: [], folders: [], truncated: false }));
    const app = Fastify();
    onTestFinished(() => app.close());
    // A store built from app.db would send a query that this pool has no handler for.
    app.decorate("db", new FakePool().asPool());
    app.addHook("preHandler", async (request) => {
      request.auth = auth;
    });
    await registerProjectFileRoutes(app, {
      artifactStorage: {},
      artifactProcessor: {},
      limits: {},
      projectFiles: { list }
    } as never);

    const response = await app.inject({ method: "GET", url: `/projects/${projectId}/library` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ files: [], folders: [] });
    expect(list).toHaveBeenCalledExactlyOnceWith({ ...auth, projectId });
  });
});

async function download(name: string) {
  // The store's SQL is covered by the integration suite; this test is about the
  // header the route builds from the stored name.
  const content = vi.fn(async () => ({ name, mimeType: "text/plain", storageKey: "stored-key" }));
  const app = Fastify();
  app.decorate("db", new FakePool().asPool());
  app.addHook("preHandler", async (request) => {
    request.auth = auth;
  });
  await registerProjectFileRoutes(app, {
    artifactStorage: {
      async openReadStream() {
        return { stream: Readable.from([Buffer.from("BODY")]), fileSizeBytes: 4 };
      }
    },
    artifactProcessor: {},
    limits: {},
    projectFiles: { content }
  } as never);
  await app.ready();
  const response = await app.inject({
    method: "GET",
    url: `/projects/${projectId}/library/files/${fileId}/versions/${versionId}/content`
  });
  await app.close();
  return response;
}

describe("GET /projects/:projectId/library/files/:fileId/versions/:versionId/content", () => {
  test.each([
    ["a plain name", "notes.txt", `attachment; filename="notes.txt"; filename*=UTF-8''notes.txt`],
    ["a relative path", "../../etc/passwd", `attachment; filename="passwd"; filename*=UTF-8''passwd`],
    ["a Windows path", "C:\\Users\\bob\\evil.exe", `attachment; filename="evil.exe"; filename*=UTF-8''evil.exe`],
    ["quotes", 'say "hi".txt', `attachment; filename="say _hi_.txt"; filename*=UTF-8''say%20%22hi%22.txt`],
    ["Unicode", "日本語.txt", `attachment; filename="___.txt"; filename*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E.txt`],
    ["a dot-only name", "..", `attachment; filename="download"; filename*=UTF-8''download`]
  ])("sends the same safe name in both parameters for %s", async (_label, name, expected) => {
    const response = await download(name);

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("BODY");
    expect(response.headers["content-disposition"]).toBe(expected);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  test("a CRLF in a stored name cannot inject a header", async () => {
    const response = await download("evil\r\nX-Injected: yes.txt");

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-injected"]).toBeUndefined();
  });
});

describe("GET /projects/:projectId/library/files/:fileId/versions/:versionId/preview-text", () => {
  const url = `/projects/${projectId}/library/files/${fileId}/versions/${versionId}/preview-text`;

  async function preview(consumeRateLimit: () => Promise<unknown>) {
    // The store's SQL and access rules are covered by the integration suite.
    const content = vi.fn(async () => ({ name: "plan.pdf", mimeType: "application/pdf", storageKey: "stored-key" }));
    const extractArtifactText = vi.fn(async () => "PDF TEXT");
    const limits = { consumeRateLimit: vi.fn(consumeRateLimit) };
    const app = Fastify();
    onTestFinished(() => app.close());
    app.setErrorHandler(handleAppError);
    app.decorate("db", new FakePool().asPool());
    app.addHook("preHandler", async (request) => {
      request.auth = auth;
    });
    await registerProjectFileRoutes(app, {
      artifactStorage: {},
      artifactProcessor: { extractArtifactText },
      limits,
      projectFiles: { content }
    } as never);
    const response = await app.inject({ method: "GET", url });
    return { response, content, extractArtifactText, limits };
  }

  test("counts an allowed request once against the shared resource read limit, then checks access again after extraction", async () => {
    const { response, content, extractArtifactText, limits } = await preview(async () => null);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ text: "PDF TEXT" });
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(limits.consumeRateLimit).toHaveBeenCalledTimes(1);
    expect(limits.consumeRateLimit).toHaveBeenCalledWith({ resource: "resource_read", userId: "user-1", tenantId: "tenant-A" });
    expect(content).toHaveBeenCalledTimes(2);
    expect(extractArtifactText).toHaveBeenCalledTimes(1);
  });

  test("refuses over the limit before it reads the file or extracts text", async () => {
    const limited = {
      error: "limit_exceeded", limitType: "rate_limit", resource: "resource_read", scope: "tenant", limit: 100,
      retryAfterMs: 4_200, resetAt: new Date(0).toISOString(), message: "Tenant resource read rate limit exceeded."
    };
    const { response, content, extractArtifactText } = await preview(async () => limited);

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("5");
    expect(response.json()).toEqual(limited);
    expect(content).not.toHaveBeenCalled();
    expect(extractArtifactText).not.toHaveBeenCalled();
  });

  test("returns the request-limit 503 when the limit store is down, and reads nothing", async () => {
    const { response, content, extractArtifactText } = await preview(async () => {
      throw new RequestLimitsUnavailableError(new Error("private redis address"));
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("5");
    expect(response.json().error).toBe("request_limits_unavailable");
    expect(response.body).not.toContain("private redis");
    expect(content).not.toHaveBeenCalled();
    expect(extractArtifactText).not.toHaveBeenCalled();
  });
});
