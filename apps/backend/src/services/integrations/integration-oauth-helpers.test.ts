import { test, expect } from "vitest";

import { mapOAuthProviderError, toIsoFromNow } from "./integration-oauth-helpers.js";

test("mapOAuthProviderError returns only fixed public reason codes", () => {
  expect(mapOAuthProviderError("access_denied")).toBe("access_denied");
  expect(mapOAuthProviderError("temporarily_unavailable")).toBe("provider_unavailable");
  expect(mapOAuthProviderError("server_error")).toBe("provider_unavailable");
  expect(mapOAuthProviderError("upstream detail containing user data")).toBe("provider_error");
  expect(mapOAuthProviderError(undefined)).toBe("provider_error");
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
