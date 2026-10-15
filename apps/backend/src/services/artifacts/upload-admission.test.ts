import { Readable } from "node:stream";
import { describe, expect, test } from "vitest";

import { InvalidArtifactFilenameError } from "./artifact-filename.js";
import { UploadAdmission } from "./upload-admission.js";

function makeAdmission(opts: { createUploadThrows?: Error } = {}) {
  const calls = {
    put: [] as string[],
    delete: [] as string[],
    createUpload: [] as string[],
    audit: 0,
    enqueue: 0
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
      async createUpload(input: { artifactName: string }) {
        calls.createUpload.push(input.artifactName);
        if (opts.createUploadThrows) throw opts.createUploadThrows;
        lastName = input.artifactName;
        return record(input.artifactName);
      },
      async update() { return null; },
      async getReadable() { return record(lastName); }
    },
    storage: {
      async put(input: { storageKey: string; stream: AsyncIterable<Buffer> }) {
        calls.put.push(input.storageKey);
        let size = 0;
        for await (const chunk of input.stream) size += chunk.length;
        return { storageBackend: "local", storageKey: input.storageKey, fileSizeBytes: size, checksumSha256: "sum" };
      },
      async delete(storageKey: string) {
        calls.delete.push(storageKey);
      }
    },
    auditEvents: {
      async create() {
        calls.audit += 1;
      }
    },
    piiScanEnqueuer: {
      async enqueue() {
        calls.enqueue += 1;
        return { kind: "skipped" as const };
      }
    }
  } as never);
  const ticket = { tenantId: "t", sessionId: "s", userId: "u", expectedProjectId: null } as never;
  const admit = (artifactName: string, stream = Readable.from([Buffer.from("body")])) =>
    admission.admit(ticket, { artifactName, mimeType: "text/plain", stream, source: "upload" });
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
    expect(calls.audit).toBe(0);
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
