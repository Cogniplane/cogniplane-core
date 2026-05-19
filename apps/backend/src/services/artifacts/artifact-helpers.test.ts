import { Readable } from "node:stream";
import { test, expect } from "vitest";

import {
  isTextReadableArtifact,
  readArtifactExcerpt,
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

// readArtifactExcerpt

test("readArtifactExcerpt: opens via storage and applies the budget", async () => {
  const storage = {
    async openReadStream() {
      return {
        stream: Readable.from([Buffer.from("once upon a time")]),
        contentType: "text/plain",
        sizeBytes: 16
      };
    }
  };
  const text = await readArtifactExcerpt(storage, "k", 4);
  expect(text).toBe("once");
});
