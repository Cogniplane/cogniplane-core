import Fastify from "fastify";
import { describe, expect, test } from "vitest";

import { handleAppError } from "../../app.js";
import { clientSafeToolErrorMessage } from "../../lib/tool-call-error.js";
import {
  assertValidArtifactFilename,
  attachmentContentDisposition,
  InvalidArtifactFilenameError,
  safeDownloadFilename,
  validateArtifactFilename
} from "./artifact-filename.js";

describe("validateArtifactFilename", () => {
  test.each([
    "report.csv",
    "résumé 日本語.pdf",
    'say "hi".txt',
    // Separators are the download path's job, not a storage-time rejection.
    "dir/sub\\report.csv",
    // Bidi marks (not overrides) are normal in Hebrew and Arabic names.
    "\u200Fדוח.txt"
  ])("accepts %j", (name) => {
    expect(validateArtifactFilename(name)).toBeNull();
  });

  test("names NUL specifically", () => {
    expect(validateArtifactFilename("a\0b.txt")).toMatch(/NUL/);
  });

  test.each([
    ["a tab", "a\tb.txt"],
    ["a line feed", "a\nb.txt"],
    ["a carriage return", "a\rb.txt"],
    ["the last C0 control", "a\u001Fb.txt"],
    ["DEL", "a\u007Fb.txt"],
    ["the first C1 control", "a\u0080b.txt"],
    ["NEL", "a\u0085b.txt"],
    ["the last C1 control", "a\u009Fb.txt"]
  ])("rejects %s as a control character", (_label, name) => {
    expect(validateArtifactFilename(name)).toMatch(/control characters/);
  });

  test.each([
    ["an embedding start", "a\u202Ab.txt"],
    ["right-to-left override", "invoice\u202Etxt.exe"],
    ["an isolate start", "a\u2066b.txt"],
    ["an isolate end", "a\u2069b.txt"]
  ])("rejects %s", (_label, name) => {
    expect(validateArtifactFilename(name)).toMatch(/bidirectional/);
  });

  test("does not echo the rejected name", () => {
    expect(validateArtifactFilename("secret\0name.txt")).not.toContain("secret");
  });
});

describe("safeDownloadFilename", () => {
  test.each([
    ["a plain name", "report.csv", "report.csv"],
    ["a relative path", "../../etc/passwd", "passwd"],
    ["an absolute path", "/etc/shadow", "shadow"],
    ["a Windows path", "C:\\Users\\bob\\evil.exe", "evil.exe"],
    ["mixed separators", "a/b\\c/d.txt", "d.txt"],
    ["a trailing separator", "docs/", "docs"],
    ["a UNC path", "\\\\host\\share\\file.txt", "file.txt"],
    ["CRLF", "evil\r\nSet-Cookie: x=1.txt", "evilSet-Cookie: x=1.txt"],
    ["NUL", "a\0b.txt", "ab.txt"],
    ["C1 controls", "a\u0085b.txt", "ab.txt"],
    ["a bidi override", "invoice\u202Etxt.exe", "invoicetxt.exe"],
    ["quotes", 'say "hi".txt', 'say "hi".txt'],
    ["Unicode", "résumé 日本語.pdf", "résumé 日本語.pdf"],
    ["a dotfile", ".gitignore", ".gitignore"],
    ["surrounding whitespace", "  report.csv  ", "report.csv"],
    ["a lone surrogate", "a\uD800b.txt", "a\uFFFDb.txt"]
  ])("%s", (_label, input, expected) => {
    expect(safeDownloadFilename(input)).toBe(expected);
  });

  test.each([
    ["empty", ""],
    ["blank", "   "],
    ["only control characters", "\0\u0001"],
    ["one dot", "."],
    ["two dots", ".."],
    ["many dots", "....."],
    ["dot segments", "../.."],
    ["a path ending in a dot segment", "foo/.."],
    ["only separators", "///"]
  ])("replaces %s with the default name", (_label, input) => {
    expect(safeDownloadFilename(input)).toBe("download");
  });

  test("keeps a plain extension when the stem is only dots", () => {
    expect(safeDownloadFilename("..txt")).toBe("download.txt");
  });

  test("caps the length in UTF-8 bytes and keeps the extension", () => {
    const long = safeDownloadFilename(`${"a".repeat(400)}.pdf`);
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(255);
    expect(long.endsWith(".pdf")).toBe(true);
    expect(long.startsWith("aaaa")).toBe(true);
  });

  test("cuts multi-byte names on a character boundary", () => {
    const long = safeDownloadFilename(`${"日".repeat(200)}.pdf`);
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(255);
    expect(long.endsWith(".pdf")).toBe(true);
    expect(long).not.toContain("\uFFFD");
    expect(long).toMatch(/^日+\.pdf$/);
  });
});

// Pulls the two parameters out of a Content-Disposition value.
function parseDisposition(header: string) {
  const match = /^attachment; filename="([^"]*)"; filename\*=UTF-8''([^;\s]*)$/.exec(header);
  if (!match) throw new Error(`Unexpected Content-Disposition shape: ${header}`);
  return { ascii: match[1] as string, encoded: match[2] as string };
}

describe("attachmentContentDisposition", () => {
  const hostile = [
    "report.csv",
    "../../etc/passwd",
    "/etc/shadow",
    "C:\\Users\\bob\\evil.exe",
    "evil\r\nSet-Cookie: x=1.txt",
    'say "hi";.txt',
    "résumé 日本語.pdf",
    "it's (a) *test*.txt",
    "",
    "..",
    "a\0b.txt",
    "a\u202Eb.txt"
  ];

  test.each(hostile)("%j: both parameters describe the same safe name", (input) => {
    const header = attachmentContentDisposition(input);
    const safeName = safeDownloadFilename(input);
    const { ascii, encoded } = parseDisposition(header);

    // filename* carries the exact safe name; filename is its ASCII form.
    expect(decodeURIComponent(encoded)).toBe(safeName);
    expect(ascii).toBe(safeName.replace(/[^\x20-\x7e]|["\\;]/gu, "_"));
    // Nothing in the value can end the header or the quoted string early.
    expect(header).toMatch(/^[\x20-\x7e]+$/);
    expect(ascii).not.toMatch(/["\\;]/);
  });

  test("a plain ASCII name is identical in both parameters", () => {
    expect(attachmentContentDisposition("report.csv")).toBe(
      `attachment; filename="report.csv"; filename*=UTF-8''report.csv`
    );
  });

  test("a path is reduced to its basename in both parameters", () => {
    expect(attachmentContentDisposition("../../etc/passwd")).toBe(
      `attachment; filename="passwd"; filename*=UTF-8''passwd`
    );
    expect(attachmentContentDisposition("C:\\Users\\bob\\evil.exe")).toBe(
      `attachment; filename="evil.exe"; filename*=UTF-8''evil.exe`
    );
  });

  test("Unicode survives in filename* and degrades to underscores in filename", () => {
    expect(attachmentContentDisposition("日本語.pdf")).toBe(
      `attachment; filename="___.pdf"; filename*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E.pdf`
    );
  });

  test("percent-encodes the characters encodeURIComponent leaves bare", () => {
    const { encoded } = parseDisposition(attachmentContentDisposition("it's (a) *test*.txt"));
    expect(encoded).toBe("it%27s%20%28a%29%20%2Atest%2A.txt");
  });

  test("empty and dot-only names use the default name in both parameters", () => {
    for (const name of ["", ".."]) {
      expect(attachmentContentDisposition(name)).toBe(
        `attachment; filename="download"; filename*=UTF-8''download`
      );
    }
  });
});

describe("InvalidArtifactFilenameError", () => {
  test("assertValidArtifactFilename passes a valid name and throws the typed error for a bad one", () => {
    expect(() => assertValidArtifactFilename("report.csv")).not.toThrow();
    expect(() => assertValidArtifactFilename("a\0b.txt")).toThrow(InvalidArtifactFilenameError);
  });

  test("reaches a client as a 400 through the app error handler, as the Microsoft import route rethrows it", async () => {
    const app = Fastify({ logger: false });
    app.setErrorHandler(handleAppError);
    app.get("/import", async () => {
      assertValidArtifactFilename("a\0b.txt");
    });

    const response = await app.inject({ method: "GET", url: "/import" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "invalid_filename",
      message: "Artifact name must not contain NUL characters."
    });
    await app.close();
  });

  test("its message passes the tool gateway filter, so the model can fix the name", () => {
    const error = new InvalidArtifactFilenameError("Artifact name must not contain NUL characters.");

    expect(clientSafeToolErrorMessage(error, "Tool call failed.")).toBe(error.message);
  });
});
