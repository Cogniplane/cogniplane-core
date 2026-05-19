import { test, expect } from "vitest";

import { sanitizeUrl } from "./sanitize-url.js";

test("sanitizeUrl: passes through URLs with no query string", () => {
  expect(sanitizeUrl("/mcp/managed")).toBe("/mcp/managed");
  expect(sanitizeUrl("/auth/me")).toBe("/auth/me");
});

test("sanitizeUrl: redacts the runtime token query param", () => {
  expect(sanitizeUrl("/mcp/managed?token=rt_verysecret")).toBe("/mcp/managed?token=REDACTED");
});

test("sanitizeUrl: redacts sensitive params while preserving non-sensitive ones", () => {
  expect(sanitizeUrl("/mcp/managed?serverId=foo&token=rt_secret&toolContextId=ctx_abc")).toBe("/mcp/managed?serverId=foo&token=REDACTED&toolContextId=ctx_abc");
});

test("sanitizeUrl: redacts multiple known-sensitive params", () => {
  expect(sanitizeUrl("/foo?accessToken=a&refreshToken=b&apiKey=c&api_key=d")).toBe("/foo?accessToken=REDACTED&refreshToken=REDACTED&apiKey=REDACTED&api_key=REDACTED");
});

test("sanitizeUrl: leaves case-sensitive param names alone (token vs TOKEN)", () => {
  // conservative: only redact the exact keys we know about
  expect(sanitizeUrl("/foo?TOKEN=secret")).toBe("/foo?TOKEN=secret");
});

test("sanitizeUrl: trailing '?' with empty query is returned unchanged", () => {
  expect(sanitizeUrl("/foo?")).toBe("/foo?");
});

test("sanitizeUrl: bare key without '=' is preserved (and redacted if sensitive)", () => {
  expect(sanitizeUrl("/foo?orphan")).toBe("/foo?orphan");
  expect(sanitizeUrl("/foo?token")).toBe("/foo?token=REDACTED");
});
