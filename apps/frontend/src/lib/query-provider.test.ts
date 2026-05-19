import { describe, it, expect } from "vitest";

import { isAuthError, shouldRetryQuery } from "./query-provider";

describe("isAuthError", () => {
  it("recognizes 401 in the message", () => {
    expect(isAuthError(new Error("Request failed: 401"))).toBe(true);
  });

  it("recognizes the word unauthorized", () => {
    expect(isAuthError(new Error("Unauthorized — token expired"))).toBe(true);
  });

  it("returns false for non-auth errors", () => {
    expect(isAuthError(new Error("Request failed: 500"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isAuthError("nope")).toBe(false);
    expect(isAuthError(null)).toBe(false);
  });
});

describe("shouldRetryQuery", () => {
  it("retries up to twice for non-auth errors", () => {
    const err = new Error("boom");
    expect(shouldRetryQuery(0, err)).toBe(true);
    expect(shouldRetryQuery(1, err)).toBe(true);
    expect(shouldRetryQuery(2, err)).toBe(false);
  });

  it("never retries on 401 — the api-client handles refresh and retry once", () => {
    expect(shouldRetryQuery(0, new Error("Request failed: 401"))).toBe(false);
  });
});
