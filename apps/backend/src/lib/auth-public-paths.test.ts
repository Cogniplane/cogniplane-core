import { test, expect } from "vitest";

import { isPublicAuthPath } from "./auth-public-paths.js";

const ALLOWLIST: ReadonlySet<string> = new Set([
  "/auth/login",
  "/auth/callback",
  "/integrations/example/callback"
]);

test("isPublicAuthPath accepts an exact path match", () => {
  expect(isPublicAuthPath("/auth/login", ALLOWLIST)).toBe(true);
  expect(isPublicAuthPath("/integrations/example/callback", ALLOWLIST)).toBe(true);
});

test("isPublicAuthPath strips the query string before matching", () => {
  expect(isPublicAuthPath("/auth/login?next=/admin", ALLOWLIST)).toBe(true);
  expect(isPublicAuthPath("/integrations/example/callback?code=abc&state=xyz", ALLOWLIST)).toBe(true);
});

test("isPublicAuthPath rejects prefix-smuggling attempts", () => {
  // These all "startsWith" an allowlisted prefix but are not the allowlisted path.
  for (const url of [
    "/auth/login.attack",
    "/auth/loginextra",
    "/auth/login/admin",
    "/integrations/example/callbackXYZ",
    "/integrations/example/callback/secret",
    "/auth/callback-spoof"
  ]) {
    expect(isPublicAuthPath(url, ALLOWLIST)).toBe(false);
  }
});

test("isPublicAuthPath rejects paths not on the allowlist", () => {
  expect(isPublicAuthPath("/auth/me", ALLOWLIST)).toBe(false);
  expect(isPublicAuthPath("/admin/users", ALLOWLIST)).toBe(false);
  expect(isPublicAuthPath("/", ALLOWLIST)).toBe(false);
});
