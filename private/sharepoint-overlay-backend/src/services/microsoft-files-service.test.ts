import { Readable } from "node:stream";
import { expect, test } from "vitest";

import type { ArtifactRecord, ArtifactStore } from "../../../../apps/backend/src/services/artifacts/artifact-store.js";
import type { AuditEventInput } from "../../../../apps/backend/src/services/audit-event-store.js";
import { SessionUploadAccessError } from "../../../../apps/backend/src/services/session-upload-access.js";
import { UploadAdmission } from "../../../../apps/backend/src/services/artifacts/upload-admission.js";
import {
  MicrosoftConnectionRequiredError,
  MicrosoftFilesService,
  MicrosoftGraphRequestError,
  MicrosoftImportBlockedError,
  MicrosoftImportPiiScanError,
  MicrosoftImportTooLargeError,
  MicrosoftUnsupportedImportError
} from "./microsoft-files-service.js";
import { downloadGraphContent, readBodyPrefix } from "./microsoft-files-service.js";
import { MicrosoftInvalidIdError } from "./graph-id-validation.js";

type AdmissionDeps = ConstructorParameters<typeof UploadAdmission>[0];
// Tests pass the stores; makeService wraps them in the real UploadAdmission.
type MicrosoftFilesDeps = Omit<ConstructorParameters<typeof MicrosoftFilesService>[0], "uploadAdmission"> &
  AdmissionDeps & { auditEvents: { create(input: AuditEventInput): Promise<void> } };

function makeService(deps: MicrosoftFilesDeps) {
  const { microsoftConnections, fetchImpl, maxImportBytes, auditEvents, artifacts, ...admissionDeps } = deps;
  return new MicrosoftFilesService({
    microsoftConnections,
    fetchImpl,
    maxImportBytes,
    uploadAdmission: new UploadAdmission({
      ...admissionDeps,
      artifacts: {
        // The store writes the audit event in the transaction of the row, so
        // a failed event fails the upload.
        async createUpload(input, audit) {
          const record = await artifacts.createUpload(input, audit);
          await auditEvents.create(audit(record));
          return record;
        },
        update: (...args) => artifacts.update(...args),
        getReadable: (...args) => artifacts.getReadable(...args)
      }
    })
  });
}
type ArtifactCreateInput = Parameters<ArtifactStore["create"]>[0];
type AuditCreateInput = AuditEventInput;

function makeArtifactRecord(
  input: ArtifactCreateInput,
  artifactId = "artifact-1"
): ArtifactRecord {
  const { tenantId: _tenantId, ...record } = input;
  return {
    ...record,
    artifactId,
    id: 1,
    sourceArtifactId: input.sourceArtifactId ?? null,
    createdByRef: input.createdByRef ?? null,
    detail: input.detail ?? {},
    createdAt: "now",
    updatedAt: "now"
  };
}

// Wraps a create-style fake into the upload-store surface the importer uses.
function artifactsFrom(
  create: (input: ArtifactCreateInput) => Promise<ArtifactRecord>
): MicrosoftFilesDeps["artifacts"] {
  const records = new Map<string, ArtifactRecord>();
  return {
    async createUpload({ expectedProjectId: _projectId, ...input }) {
      const record = await create({
        ...input,
        artifactType: "upload",
        createdByType: input.createdByType ?? "user",
        status: "pending"
      });
      records.set(record.artifactId, record);
      return record;
    },
    async update(_tenantId, artifactId, patch) {
      const record = records.get(artifactId);
      if (!record) return null;
      const updated = { ...record, ...patch };
      records.set(artifactId, updated);
      return updated;
    },
    async getReadable(_tenantId, artifactId) {
      return records.get(artifactId) ?? null;
    }
  };
}

const baseDeps = {
  sessions: { async requireUploadAccess() { return null; } },
  maxImportBytes: 1024 * 1024
};

function makeResponse(input: {
  status?: number;
  ok?: boolean;
  json?: unknown;
  text?: string;
  bodyText?: string;
}): Response {
  const body = input.bodyText ?? (input.json ? JSON.stringify(input.json) : input.text ?? "");
  return new Response(body, {
    status: input.status ?? (input.ok === false ? 500 : 200),
    headers: input.json ? { "Content-Type": "application/json" } : undefined
  });
}

test("MicrosoftFilesService.listFiles lists OneDrive root by default", async () => {
  const requested: string[] = [];
  const service = makeService({
    ...baseDeps,
    microsoftConnections: {
      async getRuntimeCredentials() {
        return {
          microsoftUserId: "ms-user-1",
          displayName: "Test User",
          email: "test@example.com",
          token: "token"
        };
      }
    },
    artifacts: stubArtifacts,
    storage: stubStorage,
    auditEvents: { async create() {} },
    fetchImpl: async (url) => {
      requested.push(String(url));
      return makeResponse({
        json: {
          value: [
            {
              id: "item-1",
              name: "Impot 2025.pdf",
              size: 2048,
              lastModifiedDateTime: "2026-04-09T00:00:00.000Z",
              webUrl: "https://example.com/file",
              file: { mimeType: "application/pdf" },
              parentReference: { driveId: "drive-1", path: "/drive/root:" }
            }
          ]
        }
      });
    }
  });

  const items = await service.listFiles({ tenantId: "tenant-1", userId: "user-1" });

  expect(requested[0]).toBe("https://graph.microsoft.com/v1.0/me/drive/root/children");
  expect(items.length).toBe(1);
  expect(items[0]?.itemId).toBe("item-1");
  expect(items[0]?.driveId).toBe("drive-1");
  expect(items[0]?.source).toBe("onedrive");
});

test("MicrosoftFilesService.searchFiles flattens search hits", async () => {
  const service = makeService({
    ...baseDeps,
    microsoftConnections: {
      async getRuntimeCredentials() {
        return {
          microsoftUserId: "ms-user-1",
          displayName: "Test User",
          email: "test@example.com",
          token: "token"
        };
      }
    },
    artifacts: stubArtifacts,
    storage: stubStorage,
    auditEvents: { async create() {} },
    fetchImpl: async () =>
      makeResponse({
        json: {
          value: [
            {
              hitsContainers: [
                {
                  hits: [
                    {
                      summary: "Tax document",
                      resource: {
                        id: "item-2",
                        name: "Impot 2025.pdf",
                        webUrl: "https://example.com/file",
                        lastModifiedDateTime: "2026-04-09T00:00:00.000Z",
                        file: { mimeType: "application/pdf" },
                        size: 5120,
                        parentReference: {
                          driveId: "drive-2",
                          siteId: "site-1",
                          path: "/sites/finance/Shared Documents"
                        }
                      }
                    }
                  ]
                }
              ]
            }
          ]
        }
      })
  });

  const results = await service.searchFiles({
    tenantId: "tenant-1",
    userId: "user-1",
    query: "impot 2025"
  });

  expect(results.length).toBe(1);
  expect(results[0]?.driveId).toBe("drive-2");
  expect(results[0]?.siteId).toBe("site-1");
  expect(results[0]?.summary).toBe("Tax document");
});

test("MicrosoftFilesService.importFileToSession stores the file as an artifact", async () => {
  const storedBodies: Buffer[] = [];
  const createdArtifacts: ArtifactCreateInput[] = [];
  const auditEvents: AuditCreateInput[] = [];
  const service = makeService({
    ...baseDeps,
    microsoftConnections: {
      async getRuntimeCredentials() {
        return {
          microsoftUserId: "ms-user-1",
          displayName: "Test User",
          email: "test@example.com",
          token: "token"
        };
      }
    },
    artifacts: artifactsFrom(async (input) => {
      createdArtifacts.push(input);
      return makeArtifactRecord(input);
    }),
    storage: {
      async delete() {},
      async put(input) {
        const chunks: Buffer[] = [];
        for await (const chunk of input.stream as Readable) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const body = Buffer.concat(chunks);
        storedBodies.push(body);
        return {
          storageBackend: "local" as const,
          storageKey: input.storageKey,
          fileSizeBytes: body.length,
          checksumSha256: "checksum"
        };
      }
    },
    auditEvents: {
      async create(input) {
        auditEvents.push(input);
      }
    },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/content")) {
        return makeResponse({ bodyText: "artifact body" });
      }

      return makeResponse({
        json: {
          id: "item-3",
          name: "notes.txt",
          webUrl: "https://example.com/notes",
          file: { mimeType: "text/plain" }
        }
      });
    }
  });

  const artifact = await service.importFileToSession({
    tenantId: "tenant-1",
    userId: "user-1",
    sessionId: "session-1",
    driveId: "drive-3",
    itemId: "item-3",
    createdByType: "user"
  });

  expect(artifact.artifactId).toBe("artifact-1");
  expect(storedBodies[0]?.toString("utf8")).toBe("artifact body");
  expect(createdArtifacts[0]?.mimeType).toBe("text/plain");
  expect(auditEvents).toHaveLength(1);
  expect(auditEvents[0]).toMatchObject({
    tenantId: "tenant-1",
    sessionId: "session-1",
    userId: "user-1",
    type: "artifact_uploaded",
    payload: { artifactId: "artifact-1", source: "microsoft", driveId: "drive-3", itemId: "item-3" }
  });
});

test("MicrosoftFilesService.listFiles rejects driveId containing slash before any HTTP call", async () => {
  let fetchCalled = false;
  const service = makeService({
    ...baseDeps,
    microsoftConnections: {
      async getRuntimeCredentials() {
        return { microsoftUserId: "u", displayName: null, email: null, token: "t" };
      }
    },
    artifacts: stubArtifacts,
    storage: stubStorage,
    auditEvents: { async create() {} },
    fetchImpl: async () => {
      fetchCalled = true;
      return makeResponse({ json: {} });
    }
  });

  await expect(() =>
    service.listFiles({
      tenantId: "tenant-1",
      userId: "user-1",
      driveId: "drive/items/secret"
    })
  ).rejects.toThrow(MicrosoftInvalidIdError);
  expect(fetchCalled, "fetch must not run when driveId is invalid").toBe(false);
});

test("MicrosoftFilesService.importFileToSession rejects malformed itemId before any HTTP call", async () => {
  let fetchCalled = false;
  const service = makeService({
    ...baseDeps,
    microsoftConnections: {
      async getRuntimeCredentials() {
        return { microsoftUserId: "u", displayName: null, email: null, token: "t" };
      }
    },
    artifacts: stubArtifacts,
    storage: stubStorage,
    auditEvents: { async create() {} },
    fetchImpl: async () => {
      fetchCalled = true;
      return makeResponse({ json: {} });
    }
  });

  await expect(() =>
    service.importFileToSession({
      tenantId: "tenant-1",
      userId: "user-1",
      sessionId: "session-1",
      driveId: "b!validdrive",
      itemId: "evil:Secret.docx:",
      createdByType: "tool"
    })
  ).rejects.toThrow(MicrosoftInvalidIdError);
  expect(fetchCalled, "fetch must not run when itemId is invalid").toBe(false);
});

test("MicrosoftFilesService throws when no Microsoft connection exists", async () => {
  const service = makeService({
    ...baseDeps,
    microsoftConnections: {
      async getRuntimeCredentials() {
        return null;
      }
    },
    artifacts: stubArtifacts,
    storage: stubStorage,
    auditEvents: { async create() {} }
  });

  await expect(() =>
    service.listSites({ tenantId: "tenant-1", userId: "user-1" })
  ).rejects.toThrow(MicrosoftConnectionRequiredError);
});

const fakeCreds = {
  microsoftUserId: "ms-user-1",
  displayName: "Test User",
  email: "test@example.com",
  token: "tk"
};

const credsDeps = {
  microsoftConnections: {
    async getRuntimeCredentials() {
      return fakeCreds;
    }
  }
};

const stubArtifacts = artifactsFrom(async () => { throw new Error("not used"); });
const stubStorage = { async put(): Promise<never> { throw new Error("not used"); }, async delete() {} };
const stubAudit = { async create() {} };

test("listSites with no search hits /me/followedSites and maps fields", async () => {
  const requested: string[] = [];
  const service = makeService({
    ...baseDeps,
    ...credsDeps,
    artifacts: stubArtifacts,
    storage: stubStorage,
    auditEvents: stubAudit,
    fetchImpl: async (url) => {
      requested.push(String(url));
      return makeResponse({
        json: {
          value: [
            { id: "s1", name: "MainSite", displayName: "Main", webUrl: "https://x" }
          ]
        }
      });
    }
  });
  const sites = await service.listSites({ tenantId: "t", userId: "u" });
  expect(requested[0]).toBe("https://graph.microsoft.com/v1.0/me/followedSites");
  expect(sites[0]?.siteId).toBe("s1");
  expect(sites[0]?.name).toBe("MainSite");
});

test("listSites with search uses /sites?search and url-encodes the query", async () => {
  const requested: string[] = [];
  const service = makeService({
    ...baseDeps,
    ...credsDeps,
    artifacts: stubArtifacts,
    storage: stubStorage,
    auditEvents: stubAudit,
    fetchImpl: async (url) => {
      requested.push(String(url));
      return makeResponse({ json: { value: [] } });
    }
  });
  await service.listSites({ tenantId: "t", userId: "u", search: "my docs" });
  expect(requested[0]).toBe("https://graph.microsoft.com/v1.0/sites?search=my%20docs");
});

test("listSites: a graph-level error becomes a MicrosoftGraphRequestError", async () => {
  const service = makeService({
    ...baseDeps,
    ...credsDeps,
    artifacts: stubArtifacts,
    storage: stubStorage,
    auditEvents: stubAudit,
    fetchImpl: async () =>
      makeResponse({ status: 401, json: { error: { code: "denied" } } })
  });
  await expect(() =>
    service.listSites({ tenantId: "t", userId: "u" })
  ).rejects.toSatisfy(
    (err: unknown) =>
      err instanceof MicrosoftGraphRequestError &&
      err.status === 401 &&
      /Graph API error 401/.test(err.message)
  );
});

test("listFiles: uses drives/{driveId}/root/children when only driveId is set", async () => {
  const requested: string[] = [];
  const service = makeService({
    ...baseDeps,
    ...credsDeps,
    artifacts: stubArtifacts,
    storage: stubStorage,
    auditEvents: stubAudit,
    fetchImpl: async (url) => {
      requested.push(String(url));
      return makeResponse({ json: { value: [] } });
    }
  });
  await service.listFiles({
    tenantId: "t",
    userId: "u",
    driveId: "b!drv"
  });
  expect(requested[0]).toBe("https://graph.microsoft.com/v1.0/drives/b!drv/root/children");
});

test("listFiles: drive + folder path", async () => {
  const requested: string[] = [];
  const service = makeService({
    ...baseDeps,
    ...credsDeps,
    artifacts: stubArtifacts,
    storage: stubStorage,
    auditEvents: stubAudit,
    fetchImpl: async (url) => {
      requested.push(String(url));
      return makeResponse({ json: { value: [] } });
    }
  });
  await service.listFiles({
    tenantId: "t",
    userId: "u",
    driveId: "b!drv",
    folderId: "01ABC"
  });
  expect(requested[0]).toBe("https://graph.microsoft.com/v1.0/drives/b!drv/items/01ABC/children");
});

test("listFiles: site-only path goes to /sites/{siteId}/drive/root/children", async () => {
  const requested: string[] = [];
  const service = makeService({
    ...baseDeps,
    ...credsDeps,
    artifacts: stubArtifacts,
    storage: stubStorage,
    auditEvents: stubAudit,
    fetchImpl: async (url) => {
      requested.push(String(url));
      return makeResponse({ json: { value: [] } });
    }
  });
  await service.listFiles({ tenantId: "t", userId: "u", siteId: "site-1" });
  expect(requested[0]).toBe("https://graph.microsoft.com/v1.0/sites/site-1/drive/root/children");
});

test("listFiles: site + folder path goes to /sites/{siteId}/drive/items/{folderId}/children", async () => {
  const requested: string[] = [];
  const service = makeService({
    ...baseDeps,
    ...credsDeps,
    artifacts: stubArtifacts,
    storage: stubStorage,
    auditEvents: stubAudit,
    fetchImpl: async (url) => {
      requested.push(String(url));
      return makeResponse({ json: { value: [] } });
    }
  });
  await service.listFiles({ tenantId: "t", userId: "u", siteId: "site-1", folderId: "01F" });
  expect(requested[0]).toBe("https://graph.microsoft.com/v1.0/sites/site-1/drive/items/01F/children");
});

test("listFiles: me-drive folder path goes to /me/drive/items/{folderId}/children", async () => {
  const requested: string[] = [];
  const service = makeService({
    ...baseDeps,
    ...credsDeps,
    artifacts: stubArtifacts,
    storage: stubStorage,
    auditEvents: stubAudit,
    fetchImpl: async (url) => {
      requested.push(String(url));
      return makeResponse({ json: { value: [] } });
    }
  });
  await service.listFiles({ tenantId: "t", userId: "u", folderId: "01F" });
  expect(requested[0]).toBe("https://graph.microsoft.com/v1.0/me/drive/items/01F/children");
});

test("listFiles: skips items missing required ids/name/driveId in the response", async () => {
  const service = makeService({
    ...baseDeps,
    ...credsDeps,
    artifacts: stubArtifacts,
    storage: stubStorage,
    auditEvents: stubAudit,
    fetchImpl: async () =>
      makeResponse({
        json: {
          value: [
            { id: "i1", name: "good", parentReference: { driveId: "d", siteId: "s" }, folder: {} },
            { name: "noid", parentReference: { driveId: "d" } },
            { id: "i2", name: "nodrive", parentReference: {} },
            null
          ]
        }
      })
  });
  const items = await service.listFiles({ tenantId: "t", userId: "u" });
  expect(items.length).toBe(1);
  expect(items[0].itemId).toBe("i1");
  expect(items[0].source).toBe("sharepoint");
  expect(items[0].isFolder).toBe(true);
  expect(items[0].isFile).toBe(false);
});

test("listFiles: missing data.value returns []", async () => {
  const service = makeService({
    ...baseDeps,
    ...credsDeps,
    artifacts: stubArtifacts,
    storage: stubStorage,
    auditEvents: stubAudit,
    fetchImpl: async () => makeResponse({ json: {} })
  });
  const items = await service.listFiles({ tenantId: "t", userId: "u" });
  expect(items).toEqual([]);
});

test("listFiles: when no parentReference.siteId, source falls back to onedrive (or fallback siteId)", async () => {
  const service = makeService({
    ...baseDeps,
    ...credsDeps,
    artifacts: stubArtifacts,
    storage: stubStorage,
    auditEvents: stubAudit,
    fetchImpl: async () =>
      makeResponse({
        json: {
          value: [
            { id: "i1", name: "x", parentReference: { driveId: "d" } }
          ]
        }
      })
  });
  // siteId argument is the fallback used by mapGraphDriveItem
  const items = await service.listFiles({ tenantId: "t", userId: "u", siteId: "fallback-site" });
  expect(items[0].siteId).toBe("fallback-site");
  expect(items[0].source).toBe("sharepoint");
});

test("searchFiles: clamps maxResults and posts the right body", async () => {
  let postBody: string | null = null;
  const service = makeService({
    ...baseDeps,
    ...credsDeps,
    artifacts: stubArtifacts,
    storage: stubStorage,
    auditEvents: stubAudit,
    fetchImpl: async (_url, init) => {
      postBody = typeof init?.body === "string" ? init.body : null;
      return makeResponse({ json: { value: [] } });
    }
  });
  await service.searchFiles({
    tenantId: "t",
    userId: "u",
    query: "q",
    maxResults: 999
  });
  const parsed = JSON.parse(postBody!);
  expect(parsed.requests[0].size).toBe(25);
  expect(parsed.requests[0].entityTypes).toEqual(["driveItem"]);
});

test("searchFiles: skips hits with no resource and hits with missing required fields", async () => {
  const service = makeService({
    ...baseDeps,
    ...credsDeps,
    artifacts: stubArtifacts,
    storage: stubStorage,
    auditEvents: stubAudit,
    fetchImpl: async () =>
      makeResponse({
        json: {
          value: [
            {
              hitsContainers: [
                {
                  hits: [
                    {
                      summary: "a",
                      resource: {
                        id: "i", name: "n", parentReference: { driveId: "d" }, file: {}
                      }
                    },
                    // resource not an object => null entry filtered
                    { summary: "b", resource: null },
                    // resource missing driveId => mapped null then filtered
                    { resource: { id: "i2", name: "n2", parentReference: {} } }
                  ]
                }
              ]
            }
          ]
        }
      })
  });
  const items = await service.searchFiles({ tenantId: "t", userId: "u", query: "x" });
  expect(items.length).toBe(1);
  expect(items[0].itemId).toBe("i");
});

test("searchFiles: when hitsContainers/hits are missing, returns []", async () => {
  const service = makeService({
    ...baseDeps,
    ...credsDeps,
    artifacts: stubArtifacts,
    storage: stubStorage,
    auditEvents: stubAudit,
    fetchImpl: async () =>
      makeResponse({ json: { value: [{}] } })
  });
  const items = await service.searchFiles({ tenantId: "t", userId: "u", query: "x" });
  expect(items).toEqual([]);
});

test("importFileToSession: rejects unsupported MIME types before downloading content", async () => {
  let downloadedBody = false;
  const service = makeService({
    ...baseDeps,
    ...credsDeps,
    artifacts: stubArtifacts,
    storage: {
      async delete() {},
      async put() {
        throw new Error("must not run");
      }
    },
    auditEvents: stubAudit,
    fetchImpl: async (url) => {
      if (String(url).endsWith("/content")) {
        downloadedBody = true;
        return makeResponse({ bodyText: "x" });
      }
      return makeResponse({
        json: {
          id: "i", name: "f.exe", file: { mimeType: "application/x-msdownload" }
        }
      });
    }
  });
  await expect(() =>
    service.importFileToSession({
      tenantId: "t",
      userId: "u",
      sessionId: "s",
      driveId: "b!d",
      itemId: "01ABC",
      createdByType: "user"
    })
  ).rejects.toThrow(MicrosoftUnsupportedImportError);
  expect(downloadedBody).toBe(false);
});

test("importFileToSession: a content-download failure raises MicrosoftGraphRequestError", async () => {
  const service = makeService({
    ...baseDeps,
    ...credsDeps,
    artifacts: stubArtifacts,
    storage: {
      async delete() {},
      async put() {
        throw new Error("must not run");
      }
    },
    auditEvents: stubAudit,
    fetchImpl: async (url) => {
      if (String(url).endsWith("/content")) {
        return new Response("err", { status: 502 });
      }
      return makeResponse({
        json: { id: "i", name: "f.txt", file: { mimeType: "text/plain" } }
      });
    }
  });
  await expect(() =>
    service.importFileToSession({
      tenantId: "t",
      userId: "u",
      sessionId: "s",
      driveId: "b!d",
      itemId: "01ABC",
      createdByType: "user"
    })
  ).rejects.toSatisfy(
    (err: unknown) => err instanceof MicrosoftGraphRequestError && err.status === 502
  );
});

test("importFileToSession: PII enqueuer 'allowed' result lets import succeed", async () => {
  const enqueueArgs: Array<Record<string, unknown>> = [];
  let createCalled = false;
  const service = makeService({
    ...baseDeps,
    ...credsDeps,
    artifacts: artifactsFrom(async (input) => {
      createCalled = true;
      return makeArtifactRecord(input, "a-1");
    }),
    storage: {
      async delete() {},
      async put(input) {
        for await (const _ of input.stream as Readable) {
          /* drained */
        }
        return {
          storageBackend: "local",
          storageKey: input.storageKey,
          fileSizeBytes: 4,
          checksumSha256: "k"
        };
      }
    },
    auditEvents: stubAudit,
    piiScanEnqueuer: {
      async enqueue(args) {
        enqueueArgs.push({ ...args });
        return { kind: "allowed", scanRunId: "run-1" };
      }
    },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/content")) {
        return makeResponse({ bodyText: "body" });
      }
      return makeResponse({
        json: { id: "i", name: "f.txt", file: { mimeType: "text/plain" } }
      });
    }
  });
  const a = await service.importFileToSession({
    tenantId: "t",
    userId: "u",
    sessionId: "s",
    driveId: "b!d",
    itemId: "01ABC",
    createdByType: "user"
  });
  expect(a.artifactId).toBe("a-1");
  expect(createCalled).toBe(true);
  expect(enqueueArgs[0].source).toBe("microsoft_import");
  // The frontend overlay selects its "Microsoft import" label with this
  // stored value. Do not change it without a data migration.
  expect(a.detail).toMatchObject({ source: "microsoft" });
});

test("importFileToSession: PII enqueuer 'blocked' raises MicrosoftImportBlockedError carrying reason+runId", async () => {
  const service = makeService({
    ...baseDeps,
    ...credsDeps,
    artifacts: artifactsFrom(async (input) => {
      return makeArtifactRecord(input, "a-1");
    }),
    storage: {
      async delete() {},
      async put(input) {
        for await (const _ of input.stream as Readable) {
          /* drained */
        }
        return {
          storageBackend: "local",
          storageKey: input.storageKey,
          fileSizeBytes: 1,
          checksumSha256: "k"
        };
      }
    },
    auditEvents: stubAudit,
    piiScanEnqueuer: {
      async enqueue() {
        return {
          kind: "blocked",
          blockReason: "pii_personal_phone",
          scanRunId: "run-99",
          findings: []
        };
      }
    },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/content")) return makeResponse({ bodyText: "x" });
      return makeResponse({ json: { id: "i", name: "f.txt", file: { mimeType: "text/plain" } } });
    }
  });
  await expect(() =>
    service.importFileToSession({
      tenantId: "t",
      userId: "u",
      sessionId: "s",
      driveId: "b!d",
      itemId: "01ABC",
      createdByType: "user"
    })
  ).rejects.toSatisfy(
    (err: unknown) =>
      err instanceof MicrosoftImportBlockedError &&
      err.blockReason === "pii_personal_phone" &&
      err.scanRunId === "run-99"
  );
});

test("importFileToSession: PII enqueuer 'failed' raises MicrosoftImportPiiScanError", async () => {
  const service = makeService({
    ...baseDeps,
    ...credsDeps,
    artifacts: artifactsFrom(async (input) => {
      return makeArtifactRecord(input, "a-1");
    }),
    storage: {
      async delete() {},
      async put(input) {
        for await (const _ of input.stream as Readable) {
          /* drained */
        }
        return {
          storageBackend: "local",
          storageKey: input.storageKey,
          fileSizeBytes: 1,
          checksumSha256: "k"
        };
      }
    },
    auditEvents: stubAudit,
    piiScanEnqueuer: {
      async enqueue() {
        return {
          kind: "failed",
          scanRunId: "run-1",
          errorCode: "scan-broken",
          errorMessage: "scan was broken"
        };
      }
    },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/content")) return makeResponse({ bodyText: "x" });
      return makeResponse({ json: { id: "i", name: "f.txt", file: { mimeType: "text/plain" } } });
    }
  });
  await expect(() =>
    service.importFileToSession({
      tenantId: "t",
      userId: "u",
      sessionId: "s",
      driveId: "b!d",
      itemId: "01ABC",
      createdByType: "user"
    })
  ).rejects.toSatisfy(
    (err: unknown) => err instanceof MicrosoftImportPiiScanError && err.code === "scan-broken"
  );
});

test("importFileToSession: falls back to default name when meta name and override are missing", async () => {
  const created: ArtifactCreateInput[] = [];
  const service = makeService({
    ...baseDeps,
    ...credsDeps,
    artifacts: artifactsFrom(async (input) => {
      created.push(input);
      return makeArtifactRecord(input, "a-1");
    }),
    storage: {
      async delete() {},
      async put(input) {
        for await (const _ of input.stream as Readable) {
          /* drained */
        }
        return {
          storageBackend: "local",
          storageKey: input.storageKey,
          fileSizeBytes: 1,
          checksumSha256: "k"
        };
      }
    },
    auditEvents: stubAudit,
    fetchImpl: async (url) => {
      if (String(url).endsWith("/content")) return makeResponse({ bodyText: "x" });
      return makeResponse({
        json: { id: "abc", file: { mimeType: "text/plain" } } // no name
      });
    }
  });
  await service.importFileToSession({
    tenantId: "t",
    userId: "u",
    sessionId: "s",
    driveId: "b!d",
    itemId: "abc-item",
    createdByType: "user"
  });
  expect(created[0].artifactName).toBe("microsoft-file-abc-item");
});

test("importFileToSession: missing file.mimeType defaults to application/octet-stream and is rejected", async () => {
  const service = makeService({
    ...baseDeps,
    ...credsDeps,
    artifacts: stubArtifacts,
    storage: stubStorage,
    auditEvents: stubAudit,
    fetchImpl: async (url) => {
      if (String(url).endsWith("/content")) return makeResponse({ bodyText: "x" });
      return makeResponse({ json: { id: "i", name: "f" } }); // no file.mimeType
    }
  });
  await expect(() =>
    service.importFileToSession({
      tenantId: "t",
      userId: "u",
      sessionId: "s",
      driveId: "b!d",
      itemId: "01ABC",
      createdByType: "user"
    })
  ).rejects.toThrow(MicrosoftUnsupportedImportError);
});

function importService(overrides: Partial<MicrosoftFilesDeps> & { meta?: Record<string, unknown>; body?: string } = {}) {
  const calls = { fetched: [] as string[], deleted: [] as string[], updated: [] as string[] };
  const { meta, body, ...deps } = overrides;
  const service = makeService({
    ...baseDeps,
    ...credsDeps,
    artifacts: artifactsFrom(async (input) => makeArtifactRecord(input, "a-1")),
    storage: {
      async delete(key) { calls.deleted.push(key); },
      async put(input) {
        let size = 0;
        for await (const chunk of input.stream as Readable) size += (chunk as Buffer).length;
        return { storageBackend: "local", storageKey: input.storageKey, fileSizeBytes: size, checksumSha256: "k" };
      }
    },
    auditEvents: stubAudit,
    fetchImpl: async (url) => {
      calls.fetched.push(String(url));
      if (String(url).endsWith("/content")) return makeResponse({ bodyText: body ?? "body" });
      return makeResponse({ json: meta ?? { id: "i", name: "f.txt", file: { mimeType: "text/plain" } } });
    },
    ...deps
  });
  const run = () => service.importFileToSession({
    tenantId: "t", userId: "u", sessionId: "s", driveId: "b!d", itemId: "01ABC", createdByType: "tool"
  });
  return { calls, run };
}

test("importFileToSession: checks current upload access before any Graph call", async () => {
  const { calls, run } = importService({
    sessions: { async requireUploadAccess() { throw new SessionUploadAccessError(); } }
  });
  await expect(run()).rejects.toThrow(SessionUploadAccessError);
  expect(calls.fetched).toEqual([]);
});

test("importFileToSession: deletes stored bytes when access is lost during the download", async () => {
  const { calls, run } = importService({
    artifacts: artifactsFrom(async () => { throw new SessionUploadAccessError(); })
  });
  await expect(run()).rejects.toThrow(SessionUploadAccessError);
  expect(calls.deleted).toHaveLength(1);
});

test("importFileToSession: deletes stored bytes and starts no scan when the upload audit fails", async () => {
  const failure = new Error("audit insert failed");
  let enqueued = 0;
  const { calls, run } = importService({
    auditEvents: { async create() { throw failure; } },
    piiScanEnqueuer: {
      async enqueue() {
        enqueued += 1;
        return { kind: "queued", scanRunId: "r", jobId: "j", mode: "detect" };
      }
    }
  });
  await expect(run()).rejects.toBe(failure);
  expect(calls.deleted).toHaveLength(1);
  expect(enqueued).toBe(0);
});

test("importFileToSession: a queued scan returns the artifact still pending", async () => {
  const { run } = importService({
    piiScanEnqueuer: {
      async enqueue() { return { kind: "queued", scanRunId: "r", jobId: "j", mode: "detect" }; }
    }
  });
  const artifact = await run();
  expect(artifact.status).toBe("pending");
  expect(artifact.createdByType).toBe("tool");
});

test("importFileToSession: marks the artifact ready only after an allowed verdict", async () => {
  const { run } = importService({
    piiScanEnqueuer: { async enqueue() { return { kind: "allowed", scanRunId: "r" }; } }
  });
  expect((await run()).status).toBe("ready");
});

test("importFileToSession: rejects oversized metadata before downloading", async () => {
  const { calls, run } = importService({
    meta: { id: "i", name: "f.txt", size: 2 * 1024 * 1024, file: { mimeType: "text/plain" } }
  });
  await expect(run()).rejects.toThrow(MicrosoftImportTooLargeError);
  expect(calls.fetched.some((url) => url.endsWith("/content"))).toBe(false);
});

test("importFileToSession: stops a download that streams past the limit", async () => {
  let created = false;
  const { run } = importService({
    maxImportBytes: 8,
    // Metadata claims a small file; the body is larger.
    meta: { id: "i", name: "f.txt", size: 4, file: { mimeType: "text/plain" } },
    body: "more than eight bytes",
    artifacts: artifactsFrom(async (input) => { created = true; return makeArtifactRecord(input); })
  });
  await expect(run()).rejects.toThrow(MicrosoftImportTooLargeError);
  expect(created).toBe(false);
});

test("readBodyPrefix returns at the byte limit without waiting for a stalled remainder", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([1, 2, 3, 4])); },
    // The remainder never arrives.
    pull() { return new Promise<void>(() => undefined); },
    cancel() { cancelled = true; }
  });

  const prefix = await readBodyPrefix(new Response(body), 4);

  expect([...prefix.bytes]).toEqual([1, 2, 3, 4]);
  expect(prefix.truncated).toBe(true);
  expect(cancelled).toBe(true);
});

test("readBodyPrefix cancels the rest of a longer body", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(1024)); },
    cancel() { cancelled = true; }
  });

  const prefix = await readBodyPrefix(new Response(body), 10);

  expect(prefix).toMatchObject({ truncated: true });
  expect(prefix.bytes.byteLength).toBe(10);
  expect(cancelled).toBe(true);
});

test("downloadGraphContent releases the body of each redirect it follows or refuses", async () => {
  const cancelled: string[] = [];
  const redirect = (name: string, location: string) => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("moved")); },
    cancel() { cancelled.push(name); }
  }), { status: 302, headers: { location } });
  const responses = [
    redirect("graph", "https://download.example.com/f"),
    redirect("download", "http://insecure.example.com/f")
  ];

  await expect(downloadGraphContent((async () => responses.shift()!) as typeof fetch,
    "https://graph.microsoft.com/v1.0/drives/d/items/i/content", "token")).rejects.toThrow();
  expect(cancelled).toEqual(["graph", "download"]);
});
