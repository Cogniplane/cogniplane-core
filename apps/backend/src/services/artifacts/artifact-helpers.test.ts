import { Readable } from "node:stream";
import { test, expect } from "vitest";

import {
  isTextReadableArtifact,
  readArtifactExcerpt,
  readStreamAsBoundedText,
  readStreamAsText
} from "./artifact-helpers.js";

// isTextReadableArtifact

test("isTextReadableArtifact: text/* is readable", () => {
  expect(isTextReadableArtifact("text/plain")).toBe(true);
  expect(isTextReadableArtifact("text/markdown")).toBe(true);
});

test("isTextReadableArtifact: application/json is readable", () => {
  expect(isTextReadableArtifact("application/json")).toBe(true);
});

test("isTextReadableArtifact: image/png is not readable", () => {
  expect(isTextReadableArtifact("image/png")).toBe(false);
});

// readStreamAsText

test("readStreamAsText: respects maxChars", async () => {
  const stream = Readable.from([Buffer.from("hello world")]);
  const text = await readStreamAsText(stream, 5);
  expect(text).toBe("hello");
});

test("readStreamAsText: returns full content when shorter than max", async () => {
  const stream = Readable.from([Buffer.from("short")]);
  const text = await readStreamAsText(stream, 100);
  expect(text).toBe("short");
});

test("readStreamAsText: stops reading once budget is reached even with more chunks pending", async () => {
  const stream = Readable.from([Buffer.from("aaa"), Buffer.from("bbb")]);
  const text = await readStreamAsText(stream, 4);
  expect(text).toBe("aaab");
});

test("readStreamAsText: handles string-typed chunks too (some streams emit them)", async () => {
  const stream = Readable.from(["hello"]);
  const text = await readStreamAsText(stream, 100);
  expect(text).toBe("hello");
});

test("readStreamAsText: preserves UTF-8 code points split across chunks", async () => {
  const encoded = Buffer.from("before 😀 after", "utf8");
  const emojiStart = encoded.indexOf(Buffer.from("😀", "utf8"));
  const stream = Readable.from([
    encoded.subarray(0, emojiStart + 2),
    encoded.subarray(emojiStart + 2),
  ]);

  await expect(readStreamAsText(stream, 100)).resolves.toBe("before 😀 after");
});

test("readStreamAsText: does not split a UTF-16 surrogate at the character limit", async () => {
  const text = await readStreamAsText(Readable.from([Buffer.from("a😀")]), 2);
  expect(text).toBe("a😀");
  expect([...text]).toEqual(["a", "😀"]);
});

test("readStreamAsText: preserves replacement behavior for malformed trailing UTF-8", async () => {
  const text = await readStreamAsText(Readable.from([
    Buffer.from("abc"),
    Buffer.from([0xf0, 0x9f])
  ]), 100);
  expect(text).toBe("abc�");
});

test("readStreamAsBoundedText: reports overflow without splitting a code point", async () => {
  await expect(readStreamAsBoundedText(Readable.from([Buffer.from("ab😀def")]), 3))
    .resolves.toEqual({ text: "ab😀", truncated: true });
  await expect(readStreamAsBoundedText(Readable.from([Buffer.from("ab😀")]), 3))
    .resolves.toEqual({ text: "ab😀", truncated: false });
});

test("readStreamAsBoundedText: treats undecoded trailing bytes as overflow", async () => {
  await expect(readStreamAsBoundedText(Readable.from([
    Buffer.from("abc"),
    Buffer.from([0xf0, 0x9f])
  ]), 3)).resolves.toEqual({ text: "abc", truncated: true });
});

// readArtifactExcerpt

test("readArtifactExcerpt: opens via storage and applies the budget", async () => {
  const storage = {
    async openReadStream() {
      return {
        stream: Readable.from([Buffer.from("once upon a time")]),
        fileSizeBytes: 16
      };
    }
  };
  const text = await readArtifactExcerpt(storage, "k", 4);
  expect(text).toBe("once");
});
