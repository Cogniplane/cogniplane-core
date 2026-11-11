import { Readable } from "node:stream";
import { describe, expect, test } from "vitest";

import { InvalidArtifactFilenameError } from "./artifact-filename.js";
import { UploadAdmission } from "./upload-admission.js";

type AuditInput = { tenantId: string; sessionId: string | null; userId: string; type: string; payload: Record<string, unknown> };

function makeAdmission(opts: { createUploadThrows?: Error; auditThrows?: Error } = {}) {
  const calls = {
    put: [] as string[],
    delete: [] as string[],
    createUpload: [] as string[],
    rowKeys: [] as string[],
    audits: [] as AuditInput[],
    enqueue: 0,
    update: 0,
    order: [] as string[]
  };
  const record = (artifactName: string) => ({
    artifactId: "artifact-1",
    artifactType: "upload",
    artifactName,
    mimeType: "text/plain",
    fileSizeBytes: 4,
    storageKey: "stored-key",
    status: "ready",
    detail: {}
  });
  let lastName = "";
  const admission = new UploadAdmission({
    sessions: { async requireUploadAccess() { return null; } },
    artifacts: {
      // The store writes the event in the transaction of the row: when the
      // event fails, the row does not commit and createUpload rejects.
      async createUpload(
        input: { artifactName: string; storageKey: string },
        audit: (artifact: ReturnType<typeof record>) => AuditInput
      ) {
        calls.createUpload.push(input.artifactName);
        calls.rowKeys.push(input.storageKey);
        calls.order.push("createUpload");
        if (opts.createUploadThrows) throw opts.createUploadThrows;
        const created = record(input.artifactName);
        const event = audit(created);
        if (opts.auditThrows) throw opts.auditThrows;
        calls.audits.push(event);
        calls.order.push("audit");
        lastName = input.artifactName;
        return created;
      },
      async update() {
        calls.update += 1;
        return null;
      },
      async getReadable() { return record(lastName); }
    },
    storage: {
      async put(input: { storageKey: string; stream: AsyncIterable<Buffer> }) {
        calls.put.push(input.storageKey);
        calls.order.push("put");
        let size = 0;
        for await (const chunk of input.stream) size += chunk.length;
        return { storageBackend: "local", storageKey: input.storageKey, fileSizeBytes: size, checksumSha256: "sum" };
      },
      async delete(storageKey: string) {
        calls.delete.push(storageKey);
      }
    },
    piiScanEnqueuer: {
      async enqueue() {
        calls.enqueue += 1;
        calls.order.push("enqueue");
        return { kind: "skipped" as const };
      }
    }
  } as never);
  const ticket = { tenantId: "t", sessionId: "s", userId: "u", expectedProjectId: null } as never;
  const admit = (
    artifactName: string,
    stream = Readable.from([Buffer.from("body")]),
    auditPayload?: Record<string, unknown>
  ) => admission.admit(ticket, { artifactName, mimeType: "text/plain", stream, source: "upload", auditPayload });
  return { calls, admit };
}

describe("UploadAdmission.admit file name validation", () => {
  test("admits a valid name (positive control)", async () => {
    const { calls, admit } = makeAdmission();

    const result = await admit("notes.txt");

    expect(result.kind).toBe("admitted");
    expect(calls.put).toHaveLength(1);
    expect(calls.createUpload).toEqual(["notes.txt"]);
  });

  test.each([
    ["NUL", "a\0b.txt"],
    ["a control character", "a\nb.txt"],
    ["a bidirectional override", "invoice‮txt.exe"]
  ])("rejects a name with %s with a typed error before anything is stored", async (_label, name) => {
    const { calls, admit } = makeAdmission();
    const stream = Readable.from([Buffer.from("body")]);

    const error = await admit(name, stream).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InvalidArtifactFilenameError);
    expect(error).toMatchObject({ code: "invalid_filename", statusCode: 400 });
    expect((error as Error).message).not.toContain("invoice");
    expect(calls.put).toEqual([]);
    expect(calls.createUpload).toEqual([]);
    expect(calls.delete).toEqual([]);
    expect(calls.audits).toEqual([]);
    expect(calls.enqueue).toBe(0);
    // Nothing will read the source, so it is released.
    expect(stream.destroyed).toBe(true);
  });

  test("does not relabel an unrelated database error as an invalid name", async () => {
    const failure = new Error("connection terminated");
    const { calls, admit } = makeAdmission({ createUploadThrows: failure });

    const error = await admit("notes.txt").catch((caught: unknown) => caught);

    expect(error).toBe(failure);
    expect(error).not.toBeInstanceOf(InvalidArtifactFilenameError);
    // The stored object is still cleaned up.
    expect(calls.delete).toEqual(calls.put);
  });
});

describe("UploadAdmission.admit storage key", () => {
  test("stores the object under the ticket's tenant, user and session, and records that key", async () => {
    const { calls, admit } = makeAdmission();

    await admit("notes.txt");

    expect(calls.put).toHaveLength(1);
    expect(calls.put[0]).toMatch(/^t\/u\/s\/[0-9a-f-]{36}\.txt$/);
    expect(calls.rowKeys).toEqual(calls.put);
  });
});

describe("UploadAdmission.admit audit event", () => {
  test("writes one artifact_uploaded event with the row, then starts one scan", async () => {
    const { calls, admit } = makeAdmission();

    const result = await admit("notes.txt", undefined, { source: "graph", driveId: "drive-1" });

    expect(result.kind).toBe("admitted");
    expect(calls.audits).toEqual([{
      tenantId: "t",
      sessionId: "s",
      userId: "u",
      type: "artifact_uploaded",
      payload: {
        artifactId: "artifact-1",
        artifactType: "upload",
        artifactName: "notes.txt",
        mimeType: "text/plain",
        fileSizeBytes: 4,
        source: "graph",
        driveId: "drive-1"
      }
    }]);
    expect(calls.order).toEqual(["put", "createUpload", "audit", "enqueue"]);
    expect(calls.delete).toEqual([]);
  });

  test("deletes the stored bytes and starts no scan when the audit event fails", async () => {
    const failure = new Error("audit insert failed");
    const { calls, admit } = makeAdmission({ auditThrows: failure });

    const error = await admit("notes.txt").catch((caught: unknown) => caught);

    expect(error).toBe(failure);
    expect(calls.put).toHaveLength(1);
    expect(calls.delete).toEqual(calls.put);
    expect(calls.audits).toEqual([]);
    expect(calls.enqueue).toBe(0);
    expect(calls.update).toBe(0);
  });
});
