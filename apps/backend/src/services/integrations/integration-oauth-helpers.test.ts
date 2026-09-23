import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { test, expect } from "vitest";

import { registerGithubOAuthRoutes } from "./github/github-oauth-routes.js";
import {
  createOAuthBrowserBinding,
  mapOAuthProviderError,
  oauthBrowserBindingMatches,
  toIsoFromNow
} from "./integration-oauth-helpers.js";

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

// Browser binding

test("createOAuthBrowserBinding scopes an httpOnly cookie to the callback path", () => {
  const https = createOAuthBrowserBinding(
    "github",
    "https://api.example.com/auth/github/user/callback",
    600
  );
  expect(https.cookie.name).toBe("cogniplane_oauth_bind_github");
  expect(https.cookie.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(https.cookie.options).toEqual({
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: "/auth/github/user/callback",
    maxAge: 600
  });
  // The state carries only the hash, never the cookie value.
  expect(https.nonceHash).not.toBe(https.cookie.value);

  const local = createOAuthBrowserBinding("notion", "http://localhost:3001/integrations/notion/callback", 600);
  expect(local.cookie.options).toMatchObject({ secure: false, sameSite: "lax" });
});

test("oauthBrowserBindingMatches requires the nonce that produced the hash", () => {
  const binding = createOAuthBrowserBinding("github", "https://api.example.com/cb", 600);
  const other = createOAuthBrowserBinding("github", "https://api.example.com/cb", 600);
  expect(oauthBrowserBindingMatches(binding.nonceHash, binding.cookie.value)).toBe(true);
  expect(oauthBrowserBindingMatches(binding.nonceHash, other.cookie.value)).toBe(false);
  expect(oauthBrowserBindingMatches(binding.nonceHash, null)).toBe(false);
  expect(oauthBrowserBindingMatches(binding.nonceHash, "")).toBe(false);
  expect(oauthBrowserBindingMatches(undefined, binding.cookie.value)).toBe(false);
  expect(oauthBrowserBindingMatches("short", binding.cookie.value)).toBe(false);
});

test("callback route passes the binding cookie to the service and clears it", async () => {
  const received: Array<string | null | undefined> = [];
  const app = Fastify();
  await app.register(cookie);
  registerGithubOAuthRoutes(app, {
    async completeAuthorization(input) {
      received.push(input.browserNonce);
      return "/settings/github";
    }
  });

  try {
    const withCookie = await app.inject({
      url: "/auth/github/user/callback?code=c&state=s",
      cookies: { cogniplane_oauth_bind_github: "nonce-1" }
    });
    const withoutCookie = await app.inject({ url: "/auth/github/user/callback?code=c&state=s" });

    expect(received).toEqual(["nonce-1", null]);
    const cleared = withCookie.cookies.find((c) => c.name === "cogniplane_oauth_bind_github");
    expect(cleared).toMatchObject({ value: "", path: "/auth/github/user/callback" });
    expect(withoutCookie.statusCode).toBe(302);
  } finally {
    await app.close();
  }
});
