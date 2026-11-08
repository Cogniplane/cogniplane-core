import { Readable } from "node:stream";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { ToolExecutionContext } from "../../../../apps/backend/src/services/auth/tool-execution-context-store.js";
import { createSharepointTools } from "./sharepoint-tools.js";

const fakeContext: ToolExecutionContext = {
  toolContextId: "ctx-1",
  tenantId: "tenant-1",
  sessionId: "session-1",
  userId: "user-1",
  runtimeId: "runtime-1",
  runtimePolicyId: "default",
  messageId: null,
  credentialEnvelope: {},
  metadata: {},
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  createdAt: new Date().toISOString()
};

const fakeCreds = {
  microsoftUserId: "user-1",
  email: "user@example.com",
  displayName: "Test User",
  token: "ms_faketoken",
  scopes: ["User.Read", "Files.ReadWrite.All", "Sites.ReadWrite.All", "offline_access"]
};

type SharepointToolDeps = Parameters<typeof createSharepointTools>[0];
type MicrosoftFilesDeps = NonNullable<SharepointToolDeps["microsoftFiles"]>;
type MaybePromise<T> = T | Promise<T>;

const deps: SharepointToolDeps = {
  microsoftConnections: {
    async getRuntimeCredentials() {
      return fakeCreds;
    }
  },
  storage: {
    async openReadStream() {
      throw new Error("not used");
    }
  }
};

const tools = createSharepointTools(deps);
const readTool = tools.find((t) => t.name === "sharepoint_read_file");
const uploadTool = tools.find((t) => t.name === "sharepoint_upload_file");
const folderTool = tools.find((t) => t.name === "sharepoint_create_folder");
if (!readTool || !uploadTool || !folderTool) {
  throw new Error("expected sharepoint tools to be defined");
}

let capturedUrls: string[] = [];
let capturedRequests: Request[] = [];
const originalFetch = globalThis.fetch;

function installFakeFetch(responseBody: Record<string, unknown> = {}, ok = true, status = 200) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    capturedUrls.push(
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    );
    capturedRequests.push(new Request(input, init));
    return Response.json(responseBody, { status: ok ? status : status >= 400 ? status : 500 });
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  capturedUrls = [];
  capturedRequests = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("sharepoint_read_file rejects driveId containing slashes", async () => {
  installFakeFetch();
  const result = await readTool.handler({
    context: fakeContext,
    arguments: { driveId: "me/drive/root:/Secret.docx:", itemId: "01ABC" }
  });
  expect(String(result.error ?? "")).toMatch(/Invalid driveId/i);
  expect(capturedUrls).toEqual([]);
});

test("sharepoint_read_file rejects driveId containing query separator", async () => {
  installFakeFetch();
  const result = await readTool.handler({
    context: fakeContext,
    arguments: { driveId: "drive?$select=secret", itemId: "01ABC" }
  });
  expect(String(result.error ?? "")).toMatch(/Invalid driveId/i);
  expect(capturedUrls).toEqual([]);
});

test("sharepoint_read_file rejects itemId containing colon", async () => {
  installFakeFetch();
  const result = await readTool.handler({
    context: fakeContext,
    arguments: { driveId: "b!validdrive123", itemId: "item:Secret.docx:" }
  });
  expect(String(result.error ?? "")).toMatch(/Invalid itemId/i);
  expect(capturedUrls).toEqual([]);
});

test("sharepoint_read_file constructs canonical URL on valid IDs", async () => {
  installFakeFetch({ name: "f.txt", file: { mimeType: "text/plain" }, size: 0 });
  await readTool.handler({
    context: fakeContext,
    arguments: { driveId: "b!AbCd-_1234", itemId: "01ABCDEF" }
  });
  expect(capturedUrls).toEqual([
    "https://graph.microsoft.com/v1.0/drives/b!AbCd-_1234/items/01ABCDEF",
    "https://graph.microsoft.com/v1.0/drives/b!AbCd-_1234/items/01ABCDEF/content"
  ]);
});

test("sharepoint_upload_file rejects malformed parentId", async () => {
  installFakeFetch();
  const result = await uploadTool.handler({
    context: fakeContext,
    arguments: { driveId: "b!AbCd", parentId: "../etc", filename: "x.txt", content: "hi" }
  });
  expect(String(result.error ?? "")).toMatch(/Invalid parentId/i);
  expect(capturedUrls).toEqual([]);
});

test("sharepoint_upload_file accepts 'root' parentId and encodes filename", async () => {
  installFakeFetch({ id: "i", name: "f", size: 2 });
  await uploadTool.handler({
    context: fakeContext,
    arguments: { driveId: "b!AbCd", parentId: "root", filename: "my file.txt", content: "hi" }
  });
  expect(capturedUrls).toEqual([
    "https://graph.microsoft.com/v1.0/drives/b!AbCd/items/root:/my%20file.txt:/content"
  ]);
});

test("sharepoint_create_folder rejects driveId with embedded slash", async () => {
  installFakeFetch();
  const result = await folderTool.handler({
    context: fakeContext,
    arguments: { driveId: "drive/items/x", parentId: "root", folderName: "f" }
  });
  expect(String(result.error ?? "")).toMatch(/Invalid driveId/i);
  expect(capturedUrls).toEqual([]);
});

test("sharepoint_create_folder constructs canonical URL on valid IDs", async () => {
  installFakeFetch({ id: "i", name: "f" });
  await folderTool.handler({
    context: fakeContext,
    arguments: { driveId: "b!AbCd", parentId: "01ABC", folderName: "New Folder" }
  });
  expect(capturedUrls).toEqual([
    "https://graph.microsoft.com/v1.0/drives/b!AbCd/items/01ABC/children"
  ]);
});

// ── Tools that depend on microsoftFiles ──────────────────────────────────────

const listSitesTool = tools.find((t) => t.name === "sharepoint_list_sites")!;
const listFilesTool = tools.find((t) => t.name === "sharepoint_list_files")!;
const searchTool = tools.find((t) => t.name === "sharepoint_search")!;
const importTool = tools.find((t) => t.name === "sharepoint_import_file_to_session")!;

test("sharepoint_list_sites returns error when microsoftFiles is not configured", async () => {
  const result = await listSitesTool.handler({ context: fakeContext, arguments: {} });
  expect(String(result.error ?? "")).toMatch(/file service is not available/i);
});

test("sharepoint_list_files returns error when microsoftFiles is not configured", async () => {
  const result = await listFilesTool.handler({ context: fakeContext, arguments: {} });
  expect(String(result.error ?? "")).toMatch(/file service is not available/i);
});

test("sharepoint_search returns error when microsoftFiles is not configured", async () => {
  const result = await searchTool.handler({
    context: fakeContext,
    arguments: { query: "x" }
  });
  expect(String(result.error ?? "")).toMatch(/file service is not available/i);
});

test("sharepoint_import_file_to_session returns error when microsoftFiles is not configured", async () => {
  const result = await importTool.handler({
    context: fakeContext,
    arguments: { driveId: "d", itemId: "i" }
  });
  expect(String(result.error ?? "")).toMatch(/file service is not available/i);
});

function makeMicrosoftFiles(opts: {
  listSites?: (
    input: Parameters<MicrosoftFilesDeps["listSites"]>[0]
  ) => MaybePromise<Awaited<ReturnType<MicrosoftFilesDeps["listSites"]>>>;
  listFiles?: (
    input: Parameters<MicrosoftFilesDeps["listFiles"]>[0]
  ) => MaybePromise<Awaited<ReturnType<MicrosoftFilesDeps["listFiles"]>>>;
  searchFiles?: (
    input: Parameters<MicrosoftFilesDeps["searchFiles"]>[0]
  ) => MaybePromise<Awaited<ReturnType<MicrosoftFilesDeps["searchFiles"]>>>;
  importFileToSession?: (
    input: Parameters<MicrosoftFilesDeps["importFileToSession"]>[0]
  ) => MaybePromise<Awaited<ReturnType<MicrosoftFilesDeps["importFileToSession"]>>>;
  throwOn?: "listSites" | "listFiles" | "searchFiles" | "importFileToSession";
} = {}): MicrosoftFilesDeps {
  return {
    async listSites(input) {
      if (opts.throwOn === "listSites") throw new Error("list sites failed");
      return (await opts.listSites?.(input)) ?? [];
    },
    async listFiles(input) {
      if (opts.throwOn === "listFiles") throw new Error("list files failed");
      return (await opts.listFiles?.(input)) ?? [];
    },
    async searchFiles(input) {
      if (opts.throwOn === "searchFiles") throw new Error("search failed");
      return (await opts.searchFiles?.(input)) ?? [];
    },
    async importFileToSession(input) {
      if (opts.throwOn === "importFileToSession") throw new Error("import failed");
      return (await opts.importFileToSession?.(input)) ?? {
        artifactId: "art-1",
        artifactName: "f.txt",
        mimeType: "text/plain",
        fileSizeBytes: 4,
        status: "ready",
        storageKey: "k/f.txt",
        detail: {}
      };
    }
  };
}

test("sharepoint_list_sites maps microsoftFiles.listSites results", async () => {
  const filesDeps = makeMicrosoftFiles({
    listSites: () => [
      { siteId: "s1", name: "Marketing", displayName: "Marketing", webUrl: "https://x" }
    ]
  });
  const t = createSharepointTools({
    ...deps,
    microsoftFiles: filesDeps
  }).find((x) => x.name === "sharepoint_list_sites")!;

  const result = await t.handler({
    context: fakeContext,
    arguments: { search: "marketing" }
  });
  expect(result).toEqual({
    sites: [{ siteId: "s1", name: "Marketing", displayName: "Marketing", webUrl: "https://x" }]
  });
});

test("sharepoint_list_sites returns error when files service throws", async () => {
  const filesDeps = makeMicrosoftFiles({ throwOn: "listSites" });
  const t = createSharepointTools({
    ...deps,
    microsoftFiles: filesDeps
  }).find((x) => x.name === "sharepoint_list_sites")!;

  const result = await t.handler({ context: fakeContext, arguments: {} });
  expect(String(result.error ?? "")).toMatch(/list sites failed/);
});

test("sharepoint_list_files maps results, including isFolder/isFile flags and parentReference", async () => {
  const filesDeps = makeMicrosoftFiles({
    listFiles: () => [
      {
        itemId: "i1",
        name: "f.txt",
        size: 5,
        lastModifiedDateTime: "2026-01-01",
        webUrl: "u",
        isFolder: false,
        isFile: true,
        mimeType: "text/plain",
        driveId: "d",
        parentId: "p",
        siteId: null
      }
    ]
  });
  const t = createSharepointTools({
    ...deps,
    microsoftFiles: filesDeps
  }).find((x) => x.name === "sharepoint_list_files")!;

  const result = (await t.handler({
    context: fakeContext,
    arguments: { siteId: "s", driveId: "d", folderId: "p" }
  })) as { items: Array<{ id: string; file: boolean; folder: unknown; parentReference: Record<string, unknown> }> };

  expect(result.items.length).toBe(1);
  expect(result.items[0].id).toBe("i1");
  expect(result.items[0].file).toBe(true);
  // folder=false coerces to undefined (omitted) since the source returns isFolder=false
  expect(result.items[0].folder).toBe(undefined);
  expect(result.items[0].parentReference).toEqual({ driveId: "d", id: "p", siteId: null });
});

test("sharepoint_list_files returns error on throw", async () => {
  const filesDeps = makeMicrosoftFiles({ throwOn: "listFiles" });
  const t = createSharepointTools({
    ...deps,
    microsoftFiles: filesDeps
  }).find((x) => x.name === "sharepoint_list_files")!;

  const result = await t.handler({ context: fakeContext, arguments: {} });
  expect(String(result.error ?? "")).toMatch(/list files failed/);
});

test("sharepoint_search maps results and clamps maxResults", async () => {
  const captured: Array<Parameters<MicrosoftFilesDeps["searchFiles"]>[0]> = [];
  const filesDeps = makeMicrosoftFiles({
    searchFiles(input) {
      captured.push(input);
      return [
        {
          itemId: "i1",
          name: "doc",
          webUrl: "u",
          lastModifiedDateTime: null,
          summary: "snippet",
          driveId: "d",
          parentId: "p",
          siteId: null
        }
      ];
    }
  });
  const t = createSharepointTools({
    ...deps,
    microsoftFiles: filesDeps
  }).find((x) => x.name === "sharepoint_search")!;

  // Out-of-range maxResults gets clamped to 25
  const result = (await t.handler({
    context: fakeContext,
    arguments: { query: "find me", maxResults: 9999 }
  })) as { results: Array<Record<string, unknown>> };

  expect(captured[0].maxResults).toBe(25);
  expect(result.results.length).toBe(1);
  expect(result.results[0].name).toBe("doc");
});

test("sharepoint_search defaults summary to null when missing", async () => {
  const filesDeps = makeMicrosoftFiles({
    searchFiles() {
      return [
        {
          itemId: "i1",
          name: "doc",
          webUrl: null,
          lastModifiedDateTime: null,
          driveId: "d",
          parentId: null,
          siteId: null
        }
      ];
    }
  });
  const t = createSharepointTools({
    ...deps,
    microsoftFiles: filesDeps
  }).find((x) => x.name === "sharepoint_search")!;
  const result = (await t.handler({
    context: fakeContext,
    arguments: { query: "x" }
  })) as { results: Array<{ summary: unknown }> };
  expect(result.results[0].summary).toBe(null);
});

test("sharepoint_search returns error on throw", async () => {
  const filesDeps = makeMicrosoftFiles({ throwOn: "searchFiles" });
  const t = createSharepointTools({
    ...deps,
    microsoftFiles: filesDeps
  }).find((x) => x.name === "sharepoint_search")!;

  const result = await t.handler({ context: fakeContext, arguments: { query: "q" } });
  expect(String(result.error ?? "")).toMatch(/search failed/);
});

test("sharepoint_import_file_to_session returns artifact summary on success", async () => {
  const filesDeps = makeMicrosoftFiles({
    importFileToSession: () => ({
      artifactId: "art-1",
      artifactName: "report.pdf",
      mimeType: "application/pdf",
      fileSizeBytes: 100,
      status: "ready",
      storageKey: "k",
      detail: {}
    })
  });
  const t = createSharepointTools({
    ...deps,
    microsoftFiles: filesDeps
  }).find(
    (x) => x.name === "sharepoint_import_file_to_session"
  )!;

  const result = await t.handler({
    context: fakeContext,
    arguments: { driveId: "d", itemId: "i", artifactName: "renamed.pdf" }
  });
  expect(result).toEqual({
    artifactId: "art-1",
    artifactName: "report.pdf",
    mimeType: "application/pdf",
    fileSizeBytes: 100,
    status: "ready"
  });
});

test("sharepoint_import_file_to_session returns error when import throws", async () => {
  const filesDeps = makeMicrosoftFiles({ throwOn: "importFileToSession" });
  const t = createSharepointTools({
    ...deps,
    microsoftFiles: filesDeps
  }).find(
    (x) => x.name === "sharepoint_import_file_to_session"
  )!;

  const result = await t.handler({
    context: fakeContext,
    arguments: { driveId: "d", itemId: "i" }
  });
  expect(String(result.error ?? "")).toMatch(/import failed/);
});

test.each([
  { name: "a pending scan", status: "pending", detail: {}, written: false },
  { name: "a blocked scan", status: "ready", detail: { pii: { status: "blocked" } }, written: false },
  { name: "a cleared scan", status: "ready", detail: { pii: { status: "scanned" } }, written: true },
] as const)("sharepoint_import_file_to_session writes the workspace copy only after $name", async ({ status, detail, written }) => {
  const writes: string[] = [];
  const t = createSharepointTools({
    ...deps,
    storage: { async openReadStream() { return { stream: Readable.from([Buffer.from("x")]), fileSizeBytes: 1 }; } },
    writeRuntimeFile: async (_sessionId, _runtimeId, filePath) => { writes.push(filePath); return filePath; },
    microsoftFiles: makeMicrosoftFiles({
      importFileToSession: () => ({
        artifactId: "0199aaaa-0000-7000-8000-000000000001",
        artifactName: "report.txt",
        mimeType: "text/plain",
        fileSizeBytes: 1,
        status,
        storageKey: "k",
        detail
      })
    })
  }).find((x) => x.name === "sharepoint_import_file_to_session")!;

  const result = await t.handler({ context: fakeContext, arguments: { driveId: "d", itemId: "i" } });
  expect(result.status).toBe(status);
  expect(writes).toEqual(written ? ["./artifacts/report_0199aaaa-0000-7000-8000-000000000001.txt"] : []);
});

// ── No-credentials paths for the direct-fetch tools ─────────────────────────

const noCredsDeps: SharepointToolDeps = {
  microsoftConnections: {
    async getRuntimeCredentials() {
      return null;
    }
  },
  storage: deps.storage
};

test("sharepoint_read_file returns error when there is no Microsoft connection", async () => {
  const t = createSharepointTools(noCredsDeps).find((x) => x.name === "sharepoint_read_file")!;
  const result = await t.handler({
    context: fakeContext,
    arguments: { driveId: "b!d", itemId: "01ABC" }
  });
  expect(String(result.error ?? "")).toMatch(/No Microsoft connection/);
});

test("sharepoint_upload_file returns error when there is no Microsoft connection", async () => {
  const t = createSharepointTools(noCredsDeps).find((x) => x.name === "sharepoint_upload_file")!;
  const result = await t.handler({
    context: fakeContext,
    arguments: { driveId: "b!d", parentId: "root", filename: "x", content: "y" }
  });
  expect(String(result.error ?? "")).toMatch(/No Microsoft connection/);
});

test.each(["sharepoint_upload_file", "sharepoint_create_folder"])(
  "%s refuses a connection with read scopes only, before any Graph call",
  async (name) => {
    const readOnlyDeps: SharepointToolDeps = {
      ...noCredsDeps,
      microsoftConnections: {
        async getRuntimeCredentials() {
          return { ...fakeCreds, scopes: ["User.Read", "Files.Read.All", "Sites.Read.All"] };
        }
      }
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const t = createSharepointTools(readOnlyDeps).find((x) => x.name === name)!;
    const result = await t.handler({
      context: fakeContext,
      arguments: { driveId: "b!d", parentId: "root", filename: "x", content: "y", folderName: "x" }
    });
    expect(String(result.error ?? "")).toMatch(/can only read/);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  }
);

test("sharepoint_create_folder returns error when there is no Microsoft connection", async () => {
  const t = createSharepointTools(noCredsDeps).find((x) => x.name === "sharepoint_create_folder")!;
  const result = await t.handler({
    context: fakeContext,
    arguments: { driveId: "b!d", parentId: "root", folderName: "x" }
  });
  expect(String(result.error ?? "")).toMatch(/No Microsoft connection/);
});

// ── sharepoint_read_file: response branches ─────────────────────────────────

test("sharepoint_read_file: meta fetch failure returns Graph API error", async () => {
  let call = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    capturedUrls.push(typeof input === "string" ? input : (input as URL).toString());
    call += 1;
    return {
      ok: false,
      status: 404,
      async json() {
        return { error: { message: "not found" } };
      },
      async text() {
        return JSON.stringify({ error: { message: "not found" } });
      }
    } as unknown as Response;
  }) as typeof globalThis.fetch;
  const result = await readTool.handler({
    context: fakeContext,
    arguments: { driveId: "b!d", itemId: "01ABC" }
  });
  expect(String(result.error ?? "")).toMatch(/Graph API error 404/);
  // Only one fetch happened (no /content).
  expect(call).toBe(1);
});

test("sharepoint_read_file: binary file returns metadata-only payload", async () => {
  installFakeFetch({
    name: "img.png",
    file: { mimeType: "image/png" },
    size: 4096,
    webUrl: "https://example/img"
  });
  const result = (await readTool.handler({
    context: fakeContext,
    arguments: { driveId: "b!d", itemId: "01ABC" }
  })) as Record<string, unknown>;
  expect(result.content).toBe(null);
  expect(result.name).toBe("img.png");
  expect(result.mimeType).toBe("image/png");
  expect(String(result.message ?? "")).toMatch(/Binary file/);
  // Only the meta call happened
  expect(capturedUrls.length).toBe(1);
});

test("sharepoint_read_file: text content longer than maxChars is truncated", async () => {
  // First call (meta) and second call (content) must be different responses.
  let call = 0;
  const longBody = "a".repeat(20);
  globalThis.fetch = (async (input: string | URL | Request) => {
    capturedUrls.push(typeof input === "string" ? input : (input as URL).toString());
    call += 1;
    if (call === 1) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { name: "f.txt", file: { mimeType: "text/plain" }, size: longBody.length };
        },
        async text() { return ""; }
      } as unknown as Response;
    }
    return new Response(longBody);
  }) as typeof globalThis.fetch;
  const result = (await readTool.handler({
    context: fakeContext,
    arguments: { driveId: "b!d", itemId: "01ABC", maxChars: 5 }
  })) as Record<string, unknown>;
  expect(result.truncated).toBe(true);
  expect(result.content).toBe("aaaaa");
});

function textFileFetch(content: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    if (calls.length === 1) return Response.json({ name: "f.txt", file: { mimeType: "text/plain" }, size: 10 });
    return content(url, init);
  }) as typeof globalThis.fetch;
  return calls;
}

test("sharepoint_read_file does not send the bearer token to the download host", async () => {
  const calls = textFileFetch((url) => url.startsWith("https://graph.microsoft.com/")
    ? new Response(null, { status: 302, headers: { location: "https://download.example.com/f.txt" } })
    : new Response("hello"));
  const result = (await readTool.handler({
    context: fakeContext,
    arguments: { driveId: "b!d", itemId: "01ABC" }
  })) as Record<string, unknown>;
  expect(result.content).toBe("hello");
  expect(calls.map((call) => call.url)).toEqual([
    "https://graph.microsoft.com/v1.0/drives/b!d/items/01ABC",
    "https://graph.microsoft.com/v1.0/drives/b!d/items/01ABC/content",
    "https://download.example.com/f.txt"
  ]);
  expect(new Headers(calls[1]!.init?.headers).get("authorization")).toMatch(/^Bearer /);
  expect(new Headers(calls[2]!.init?.headers).get("authorization")).toBeNull();
  // Every request carries the read deadline.
  for (const call of calls) expect(call.init?.signal).toBeInstanceOf(AbortSignal);
});

test("sharepoint_read_file refuses a redirect to plain HTTP", async () => {
  textFileFetch(() => new Response(null, { status: 302, headers: { location: "http://download.example.com/f.txt" } }));
  await expect(readTool.handler({
    context: fakeContext,
    arguments: { driveId: "b!d", itemId: "01ABC" }
  })).rejects.toThrow();
});

test("sharepoint_read_file stops reading a large file after the requested prefix", async () => {
  let pulled = 0;
  textFileFetch(() => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      // An endless body: the tool must cancel it instead of reading it all.
      controller.enqueue(new TextEncoder().encode("b".repeat(1024)));
    }
  })));
  const result = (await readTool.handler({
    context: fakeContext,
    arguments: { driveId: "b!d", itemId: "01ABC", maxChars: 10 }
  })) as Record<string, unknown>;
  expect(result).toMatchObject({ content: "b".repeat(10), truncated: true });
  expect(pulled).toBeLessThan(5);
});

test("sharepoint_read_file: content fetch failure surfaces a helpful error", async () => {
  let call = 0;
  globalThis.fetch = (async () => {
    call += 1;
    if (call === 1) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { name: "f.txt", file: { mimeType: "text/plain" }, size: 0 };
        }
      } as unknown as Response;
    }
    return { ok: false, status: 502 } as unknown as Response;
  }) as typeof globalThis.fetch;
  const result = await readTool.handler({
    context: fakeContext,
    arguments: { driveId: "b!d", itemId: "01ABC" }
  });
  expect(String(result.error ?? "")).toMatch(/Failed to download file content: 502/);
});

// ── sharepoint_upload_file: API error is surfaced ───────────────────────────

test("sharepoint_upload_file: API failure includes status and detail", async () => {
  installFakeFetch({ error: "boom" }, false, 400);
  const result = await uploadTool.handler({
    context: fakeContext,
    arguments: { driveId: "b!d", parentId: "root", filename: "x.txt", content: "hi" }
  });
  expect(String(result.error ?? "")).toMatch(/Graph API error 400/);
  expect(result.detail).toEqual({ error: "boom" });
});

test("sharepoint_upload_file: success returns mapped fields", async () => {
  installFakeFetch({
    id: "abc",
    name: "x.txt",
    size: 2,
    webUrl: "https://x",
    createdDateTime: "2026-01-01"
  });
  const result = await uploadTool.handler({
    context: fakeContext,
    arguments: { driveId: "b!d", parentId: "root", filename: "x.txt", content: "hi" }
  });
  expect(capturedRequests).toHaveLength(1);
  const request = capturedRequests[0]!;
  expect(request.url).toBe("https://graph.microsoft.com/v1.0/drives/b!d/items/root:/x.txt:/content");
  expect(request.method).toBe("PUT");
  expect(request.headers.get("authorization")).toBe(`Bearer ${fakeCreds.token}`);
  expect(request.headers.get("content-type")).toBe("text/plain");
  expect(await request.text()).toBe("hi");
  expect(result).toEqual({
    id: "abc",
    name: "x.txt",
    size: 2,
    webUrl: "https://x",
    createdDateTime: "2026-01-01"
  });
});

// ── sharepoint_create_folder: rejects malformed parentId, error+success branches

test("sharepoint_create_folder: rejects malformed parentId", async () => {
  installFakeFetch();
  const result = await folderTool.handler({
    context: fakeContext,
    arguments: { driveId: "b!d", parentId: "../etc", folderName: "x" }
  });
  expect(String(result.error ?? "")).toMatch(/Invalid parentId/);
  expect(capturedUrls).toEqual([]);
});

test("sharepoint_create_folder: API error returns status+detail", async () => {
  installFakeFetch({ msg: "no" }, false, 409);
  const result = await folderTool.handler({
    context: fakeContext,
    arguments: { driveId: "b!d", parentId: "01ABC", folderName: "x" }
  });
  expect(String(result.error ?? "")).toMatch(/Graph API error 409/);
});

test("sharepoint_create_folder: success returns mapped fields", async () => {
  installFakeFetch({
    id: "abc",
    name: "newdir",
    webUrl: "https://x",
    createdDateTime: "2026-01-01"
  });
  const result = await folderTool.handler({
    context: fakeContext,
    arguments: { driveId: "b!d", parentId: "01ABC", folderName: "newdir" }
  });
  expect(capturedRequests).toHaveLength(1);
  const request = capturedRequests[0]!;
  expect(request.url).toBe("https://graph.microsoft.com/v1.0/drives/b!d/items/01ABC/children");
  expect(request.method).toBe("POST");
  expect(request.headers.get("authorization")).toBe(`Bearer ${fakeCreds.token}`);
  expect(request.headers.get("content-type")).toBe("application/json");
  expect(await request.json()).toEqual({ name: "newdir", folder: {}, "@microsoft.graph.conflictBehavior": "fail" });
  expect(result).toEqual({
    id: "abc",
    name: "newdir",
    webUrl: "https://x",
    createdDateTime: "2026-01-01"
  });
});

test("sharepoint_read_file does not return a replacement character for a character cut at the byte limit", async () => {
  // BOM (3 bytes) + "é" (2 bytes): the 4-byte prefix for maxChars 1 cuts "é" in half.
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0xc3, 0xa9, 0x78, 0x78]);
  textFileFetch(() => new Response(bytes));
  const result = (await readTool.handler({
    context: fakeContext,
    arguments: { driveId: "b!d", itemId: "01ABC", maxChars: 1 }
  })) as Record<string, unknown>;
  expect(result.truncated).toBe(true);
  expect(String(result.content)).not.toContain("\uFFFD");
});
