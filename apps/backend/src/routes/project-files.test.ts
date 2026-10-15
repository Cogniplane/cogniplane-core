import Fastify from "fastify";
import { Readable } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";

import { registerProjectFileRoutes } from "./project-files.js";
import { ProjectFileStore } from "../services/project-file-store.js";
import { FakePool } from "../test-helpers/fake-pool.js";

const projectId = "0196f7ca-8d4b-7a70-9f3f-111111111111";
const fileId = "0196f7ca-8d4b-7a70-9f3f-222222222222";
const versionId = "0196f7ca-8d4b-7a70-9f3f-333333333333";

afterEach(() => {
  vi.restoreAllMocks();
});

async function download(name: string) {
  // The store's SQL is covered by the integration suite; this test is about the
  // header the route builds from the stored name.
  vi.spyOn(ProjectFileStore.prototype, "content").mockResolvedValue({
    name,
    mimeType: "text/plain",
    storageKey: "stored-key"
  } as never);
  const app = Fastify();
  app.decorate("db", new FakePool().asPool());
  app.addHook("preHandler", async (request) => {
    request.auth = { userId: "user-1", tenantId: "tenant-A", isAdmin: false, role: "member" };
  });
  await registerProjectFileRoutes(app, {
    artifactStorage: {
      async openReadStream() {
        return { stream: Readable.from([Buffer.from("BODY")]), fileSizeBytes: 4 };
      }
    },
    artifactProcessor: {},
    limits: {}
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
