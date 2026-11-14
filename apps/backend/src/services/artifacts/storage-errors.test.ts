import { expect, test } from "vitest";

import { isTransientStorageError } from "./storage-errors.js";

test.each([
  ["a handler timeout", Object.assign(new Error("timeout"), { name: "TimeoutError" })],
  ["an abort", new DOMException("aborted", "AbortError")],
  ["a reset socket", Object.assign(new Error("reset"), { code: "ECONNRESET" })],
  ["a premature close of the body", Object.assign(new Error("closed"), { code: "ERR_STREAM_PREMATURE_CLOSE" })],
  ["S3 503", Object.assign(new Error("down"), { $metadata: { httpStatusCode: 503 } })],
  ["S3 SlowDown", Object.assign(new Error("slow"), { $metadata: { httpStatusCode: 429 } })],
  ["an SDK retryable error", Object.assign(new Error("throttled"), { $retryable: { throttling: true } })]
])("%s is transient", (_case, error) => {
  expect(isTransientStorageError(error)).toBe(true);
});

test.each([
  ["a missing key", Object.assign(new Error("missing"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } })],
  ["a refused request", Object.assign(new Error("denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } })],
  ["a missing local file", Object.assign(new Error("no file"), { code: "ENOENT" })],
  ["a plain error", new Error("bug")],
  ["a non-error", "text"],
  ["nothing", undefined]
])("%s is not transient", (_case, error) => {
  expect(isTransientStorageError(error)).toBe(false);
});
