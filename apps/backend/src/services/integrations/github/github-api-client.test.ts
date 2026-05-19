import { test, expect } from "vitest";

import {
  buildGithubApiHeaders,
  exchangeUserAuthorizationCode,
  fetchUserProfile,
  refreshUserAccessToken,
  selectGithubEmail
} from "./github-api-client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function stubFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return impl(url, init);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    }
  };
}

const cfg = {
  GITHUB_OAUTH_CLIENT_ID: "id",
  GITHUB_OAUTH_CLIENT_SECRET: "secret",
  GITHUB_OAUTH_REDIRECT_URI: "https://x/cb"
} as never;

// buildGithubApiHeaders

test("buildGithubApiHeaders: includes auth + accept + version", () => {
  const headers = buildGithubApiHeaders("tok") as Record<string, string>;
  expect(headers.Authorization).toBe("Bearer tok");
  expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
  expect(headers.Accept).toMatch(/github\+json/);
});

// exchangeUserAuthorizationCode

test("exchangeUserAuthorizationCode: returns payload with access_token on success", async () => {
  const stub = stubFetch(() => jsonResponse({ access_token: "u-tok", token_type: "bearer", scope: "repo" }));
  try {
    const r = await exchangeUserAuthorizationCode(cfg, "code-123");
    expect(r.access_token).toBe("u-tok");
    const body = JSON.parse(String(stub.calls[0].init?.body));
    expect(body.code).toBe("code-123");
    expect(body.client_id).toBe("id");
  } finally {
    stub.restore();
  }
});

test("exchangeUserAuthorizationCode: throws with error_description when present", async () => {
  const stub = stubFetch(() =>
    jsonResponse({ error: "invalid_code", error_description: "code expired" }, 400)
  );
  try {
    await expect(() => exchangeUserAuthorizationCode(cfg, "x")).rejects.toThrow(/code expired/);
  } finally {
    stub.restore();
  }
});

test("exchangeUserAuthorizationCode: throws with error code when no description", async () => {
  const stub = stubFetch(() => jsonResponse({ error: "invalid_grant" }, 400));
  try {
    await expect(() => exchangeUserAuthorizationCode(cfg, "x")).rejects.toThrow(/invalid_grant/);
  } finally {
    stub.restore();
  }
});

test("exchangeUserAuthorizationCode: throws fallback message when payload is empty", async () => {
  const stub = stubFetch(() => jsonResponse({}, 400));
  try {
    await expect(() => exchangeUserAuthorizationCode(cfg, "x")).rejects.toThrow(/github_token_exchange_failed/);
  } finally {
    stub.restore();
  }
});

test("exchangeUserAuthorizationCode: 200 but no access_token still throws", async () => {
  const stub = stubFetch(() => jsonResponse({ scope: "repo" }, 200));
  try {
    await expect(() => exchangeUserAuthorizationCode(cfg, "x")).rejects.toThrow(/github_token_exchange_failed/);
  } finally {
    stub.restore();
  }
});

// refreshUserAccessToken

test("refreshUserAccessToken: returns payload on success", async () => {
  const stub = stubFetch(() => jsonResponse({ access_token: "new-tok", token_type: "bearer" }));
  try {
    const r = await refreshUserAccessToken(cfg, "rt");
    expect(r?.access_token).toBe("new-tok");
    const body = JSON.parse(String(stub.calls[0].init?.body));
    expect(body.grant_type).toBe("refresh_token");
  } finally {
    stub.restore();
  }
});

test("refreshUserAccessToken: returns null when API returns non-2xx", async () => {
  const stub = stubFetch(() => jsonResponse({ error: "bad_token" }, 401));
  try {
    const r = await refreshUserAccessToken(cfg, "rt");
    expect(r).toBe(null);
  } finally {
    stub.restore();
  }
});

test("refreshUserAccessToken: returns null when access_token absent", async () => {
  const stub = stubFetch(() => jsonResponse({ scope: "repo" }, 200));
  try {
    const r = await refreshUserAccessToken(cfg, "rt");
    expect(r).toBe(null);
  } finally {
    stub.restore();
  }
});

// selectGithubEmail

test("selectGithubEmail: returns null when API errors", async () => {
  const stub = stubFetch(() => new Response("err", { status: 500 }));
  try {
    expect(await selectGithubEmail("tok")).toBe(null);
  } finally {
    stub.restore();
  }
});

test("selectGithubEmail: prefers primary+verified", async () => {
  const stub = stubFetch(() =>
    jsonResponse([
      { email: "alt@example.com", verified: true, primary: false },
      { email: "main@example.com", verified: true, primary: true }
    ])
  );
  try {
    expect(await selectGithubEmail("tok")).toBe("main@example.com");
  } finally {
    stub.restore();
  }
});

test("selectGithubEmail: falls back to first verified when no primary+verified", async () => {
  const stub = stubFetch(() =>
    jsonResponse([
      { email: "first@example.com", verified: false, primary: true },
      { email: "second@example.com", verified: true, primary: false }
    ])
  );
  try {
    expect(await selectGithubEmail("tok")).toBe("second@example.com");
  } finally {
    stub.restore();
  }
});

test("selectGithubEmail: falls back to first entry when none verified", async () => {
  const stub = stubFetch(() =>
    jsonResponse([
      { email: "any@example.com", verified: false, primary: false },
      { email: "second@example.com", verified: false, primary: false }
    ])
  );
  try {
    expect(await selectGithubEmail("tok")).toBe("any@example.com");
  } finally {
    stub.restore();
  }
});

test("selectGithubEmail: empty list → null", async () => {
  const stub = stubFetch(() => jsonResponse([]));
  try {
    expect(await selectGithubEmail("tok")).toBe(null);
  } finally {
    stub.restore();
  }
});

// fetchUserProfile

test("fetchUserProfile: returns parsed user", async () => {
  const stub = stubFetch(() =>
    jsonResponse({ id: 1, login: "lo", name: "n", email: "e", avatar_url: "a" })
  );
  try {
    const r = await fetchUserProfile("tok");
    expect(r.login).toBe("lo");
  } finally {
    stub.restore();
  }
});

test("fetchUserProfile: throws on non-2xx", async () => {
  const stub = stubFetch(() => new Response("no", { status: 401 }));
  try {
    await expect(() => fetchUserProfile("tok")).rejects.toThrow(/github_user_fetch_failed/);
  } finally {
    stub.restore();
  }
});
