import { test, expect } from "vitest";

import {
  isTokenExpired,
  parseScopes,
  shouldRefreshToken,
  toIsoFromNow
} from "./github-token-lifecycle.js";

// parseScopes

test("parseScopes: undefined → []", () => {
  expect(parseScopes(undefined)).toEqual([]);
});

test("parseScopes: empty string → []", () => {
  expect(parseScopes("")).toEqual([]);
});

test("parseScopes: comma-separated values are trimmed and filtered", () => {
  expect(parseScopes("repo, user:email,, write:packages ")).toEqual(["repo", "user:email", "write:packages"]);
});

// toIsoFromNow

test("toIsoFromNow: undefined → null", () => {
  expect(toIsoFromNow(undefined)).toBe(null);
});

test("toIsoFromNow: zero or negative → null", () => {
  expect(toIsoFromNow(0)).toBe(null);
  expect(toIsoFromNow(-1)).toBe(null);
});

test("toIsoFromNow: NaN/Infinity → null", () => {
  expect(toIsoFromNow(Number.NaN)).toBe(null);
  expect(toIsoFromNow(Number.POSITIVE_INFINITY)).toBe(null);
});

test("toIsoFromNow: positive seconds → ISO string in the future", () => {
  const before = Date.now();
  const iso = toIsoFromNow(60);
  expect(iso).toBeTruthy();
  const t = new Date(iso!).getTime();
  expect(t >= before + 60_000 - 100).toBe(true);
  expect(t <= before + 60_000 + 1_000).toBe(true);
});

// shouldRefreshToken

test("shouldRefreshToken: null → false", () => {
  expect(shouldRefreshToken(null)).toBe(false);
});

test("shouldRefreshToken: malformed timestamp → false", () => {
  expect(shouldRefreshToken("not-a-date")).toBe(false);
});

test("shouldRefreshToken: expiry far in the future → false", () => {
  const future = new Date(Date.now() + 60 * 60_000).toISOString();
  expect(shouldRefreshToken(future)).toBe(false);
});

test("shouldRefreshToken: expiry within skew window (5 min) → true", () => {
  const soon = new Date(Date.now() + 60_000).toISOString();
  expect(shouldRefreshToken(soon)).toBe(true);
});

test("shouldRefreshToken: already expired → true", () => {
  const past = new Date(Date.now() - 1_000).toISOString();
  expect(shouldRefreshToken(past)).toBe(true);
});

// isTokenExpired

test("isTokenExpired: null → false (no recorded expiry means not expired)", () => {
  expect(isTokenExpired(null)).toBe(false);
});

test("isTokenExpired: malformed timestamp → false", () => {
  expect(isTokenExpired("garbage")).toBe(false);
});

test("isTokenExpired: future timestamp → false", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  expect(isTokenExpired(future)).toBe(false);
});

test("isTokenExpired: past timestamp → true", () => {
  const past = new Date(Date.now() - 1_000).toISOString();
  expect(isTokenExpired(past)).toBe(true);
});
