import { describe, it, expect } from "vitest";

import { isAuthError, shouldRetryQuery } from "./query-provider";
import { ApiError } from "./api-client";

describe("isAuthError", () => {
  it("uses the HTTP status when the server message has no status text", () => {
    expect(
      isAuthError(new ApiError({ status: 401, code: "token_expired", method: "GET", path: "/me", message: "Token expired" }))
    ).toBe(true);
  });

  it("returns false for non-auth errors", () => {
    expect(
      isAuthError(new ApiError({ status: 500, method: "GET", path: "/me", message: "Unauthorized" }))
    ).toBe(false);
    expect(isAuthError(new Error("Request failed: 401"))).toBe(false);
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

  it("never retries on a 401 ApiError", () => {
    expect(
      shouldRetryQuery(
        0,
        new ApiError({ status: 401, method: "GET", path: "/me", message: "Token expired" })
      )
    ).toBe(false);
  });
});
