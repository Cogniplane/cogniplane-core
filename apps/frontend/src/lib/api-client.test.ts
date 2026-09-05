import { DEFAULT_PII_PROTECTION } from "@cogniplane/shared-types";
import { describe, it, vi, beforeEach, expect, expectTypeOf } from "vitest";

import {
  ApiError,
  request,
  requestOptionalOn404,
  setAccessToken,
  setTokenRefresher,
  createApiHeaders,
  buildErrorMessage
} from "./api-client";
import {
  createAdminMcpServer,
  updateAdminMcpServer,
  getRuntimeConfig,
  getTenantDetails,
  updateTenantProviderKey
} from "./admin-api";
import { createScheduledJob, updateScheduledJob } from "./settings-api";

type FetchCall = { url: string; init: RequestInit | undefined };

describe("shared API request types", () => {
  it("keeps schema defaults optional for frontend callers", () => {
    type ScheduledInput = Parameters<typeof createScheduledJob>[0];
    type ScheduledUpdateInput = Parameters<typeof updateScheduledJob>[1];
    const minimal = {
      jobName: "Daily digest",
      cronExpression: "0 9 * * *",
      timeZone: "UTC",
      input: { prompt: "Summarize changes." }
    };

    expectTypeOf(minimal).toMatchTypeOf<ScheduledInput>();
    expectTypeOf(minimal).toMatchTypeOf<ScheduledUpdateInput>();
  });

  it("uses distinct MCP create and update inputs", () => {
    type CreateInput = Parameters<typeof createAdminMcpServer>[0];
    type UpdateInput = Parameters<typeof updateAdminMcpServer>[1];

    expectTypeOf<CreateInput>().toMatchTypeOf<{ serverId: string }>();
    expectTypeOf<Pick<UpdateInput, "serverId">>().toEqualTypeOf<{ serverId?: string }>();
  });
});

function stubFetch(responders: Array<() => Response>): {
  calls: FetchCall[];
  fetch: ReturnType<typeof vi.fn>;
} {
  const calls: FetchCall[] = [];
  let i = 0;
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const responder = responders[Math.min(i, responders.length - 1)];
    i += 1;
    return responder();
  });
  return { calls, fetch: fn };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("request: 401 → refresh → retry", () => {
  beforeEach(() => {
    setAccessToken(null);
    setTokenRefresher(async () => null);
  });

  it("retries with the refreshed token after a 401", async () => {
    setAccessToken("stale-token");
    setTokenRefresher(async () => {
      setAccessToken("fresh-token");
      return "fresh-token";
    });

    const { calls, fetch } = stubFetch([
      () => jsonResponse(401, { error: "unauthorized" }),
      () => jsonResponse(200, { ok: true })
    ]);
    // @ts-expect-error — stub
    global.fetch = fetch;

    const result = await request<{ ok: boolean }>("/test");

    expect(result).toEqual({ ok: true });
    expect(calls.length).toBe(2);

    const firstAuth = new Headers(calls[0].init?.headers).get("Authorization");
    const retryAuth = new Headers(calls[1].init?.headers).get("Authorization");
    expect(firstAuth).toBe("Bearer stale-token");
    expect(retryAuth).toBe("Bearer fresh-token");
  });

  it("does not retry when the refresher returns null", async () => {
    setAccessToken("stale-token");
    setTokenRefresher(async () => null);

    const { calls, fetch } = stubFetch([
      () => jsonResponse(401, { error: "unauthorized" })
    ]);
    // @ts-expect-error — stub
    global.fetch = fetch;

    await expect(() => request("/test")).rejects.toThrow();
    expect(calls.length).toBe(1);
  });

  it("returns undefined for a 204 No Content response", async () => {
    // A raw 204 Response has no body; request() must short-circuit before
    // calling response.json() (which would throw on an empty body).
    const { calls, fetch } = stubFetch([() => new Response(null, { status: 204 })]);
    // @ts-expect-error — stub
    global.fetch = fetch;

    const result = await request<void>("/no-content");

    expect(result).toBeUndefined();
    expect(calls.length).toBe(1);
  });

  it("throws on a non-401 error without refreshing or retrying", async () => {
    setAccessToken("stale-token");
    let refreshed = false;
    setTokenRefresher(async () => {
      refreshed = true;
      return "fresh-token";
    });

    const { calls, fetch } = stubFetch([
      () => jsonResponse(500, { error: "boom" })
    ]);
    // @ts-expect-error — stub
    global.fetch = fetch;

    await expect(() => request("/test")).rejects.toThrow("boom");
    // A 5xx flows straight to the throw: no refresh, single fetch.
    expect(refreshed).toBe(false);
    expect(calls.length).toBe(1);
  });

  it("throws an ApiError with structured request details", async () => {
    const { fetch } = stubFetch([
      () => jsonResponse(422, { error: "validation_error", message: "Invalid input" })
    ]);
    // @ts-expect-error — stub
    global.fetch = fetch;

    await expect(request("/items", { method: "POST" })).rejects.toMatchObject({
      name: "ApiError",
      status: 422,
      code: "validation_error",
      method: "POST",
      path: "/items",
      message: "Invalid input"
    });
  });

  it("throws an ApiError when the error response is not JSON", async () => {
    const { fetch } = stubFetch([
      () => new Response("<html>oops</html>", { status: 502 })
    ]);
    // @ts-expect-error — stub
    global.fetch = fetch;

    await expect(request("/unavailable")).rejects.toMatchObject({
      name: "ApiError",
      status: 502,
      message: "Request failed: 502"
    });
  });

  it("throws an ApiError for a JSON null error body", async () => {
    const { fetch } = stubFetch([() => jsonResponse(500, null)]);
    // @ts-expect-error — stub
    global.fetch = fetch;

    await expect(request("/null-error")).rejects.toMatchObject({
      name: "ApiError",
      status: 500,
      message: "Request failed: 500"
    });
  });
});

describe("requestOptionalOn404", () => {
  it("returns null for an HTTP 404 even when the message has no status", async () => {
    const { fetch } = stubFetch([() => jsonResponse(404, { message: "Route missing" })]);
    // @ts-expect-error — stub
    global.fetch = fetch;

    await expect(requestOptionalOn404("/missing")).resolves.toBeUndefined();
  });

  it("preserves a successful JSON null response", async () => {
    const { fetch } = stubFetch([() => jsonResponse(200, null)]);
    // @ts-expect-error — stub
    global.fetch = fetch;

    await expect(requestOptionalOn404("/nullable")).resolves.toBeNull();
  });

  it("rethrows non-404 ApiErrors", async () => {
    const { fetch } = stubFetch([() => jsonResponse(500, { message: "Route failed" })]);
    // @ts-expect-error — stub
    global.fetch = fetch;

    const result = requestOptionalOn404("/broken");
    await expect(result).rejects.toBeInstanceOf(ApiError);
    await expect(result).rejects.toMatchObject({ status: 500 });
  });
});

describe("createApiHeaders", () => {
  beforeEach(() => setAccessToken(null));

  it("overwrites a stale Authorization header supplied by the caller", () => {
    setAccessToken("fresh-token");
    const headers = createApiHeaders({ Authorization: "Bearer stale" });
    expect(headers.get("Authorization")).toBe("Bearer fresh-token");
  });
});

describe("buildErrorMessage", () => {
  it("decorates a quota message with scope and resource when limitType+scope+resource are all present", async () => {
    const response = jsonResponse(429, {
      message: "Quota exceeded",
      limitType: "messages",
      scope: "tenant",
      resource: "acme-corp"
    });

    await expect(buildErrorMessage(response)).resolves.toBe(
      "Quota exceeded (tenant acme-corp)"
    );
  });

  it("returns the plain message when the quota AND-guard is not fully satisfied", async () => {
    // resource missing → the `limitType && scope && resource` guard fails,
    // so the decoration is skipped and the bare message is returned.
    const response = jsonResponse(429, {
      message: "Quota exceeded",
      limitType: "messages",
      scope: "tenant"
    });

    await expect(buildErrorMessage(response)).resolves.toBe("Quota exceeded");
  });

  it("returns a plain message untouched when no quota fields are present", async () => {
    const response = jsonResponse(400, { message: "Something went wrong" });

    await expect(buildErrorMessage(response)).resolves.toBe("Something went wrong");
  });

  it("joins details[] entries, prefixing paths and defaulting a missing detail message", async () => {
    const response = jsonResponse(422, {
      details: [
        { path: "name", message: "Required" },
        { path: "email" }, // no message → "Invalid value" default
        { message: "Top-level problem" } // no path → message only
      ]
    });

    await expect(buildErrorMessage(response)).resolves.toBe(
      "name: Required\nemail: Invalid value\nTop-level problem"
    );
  });

  it("falls back to the error field when message and details are absent", async () => {
    const response = jsonResponse(403, { error: "Forbidden" });

    await expect(buildErrorMessage(response)).resolves.toBe("Forbidden");
  });

  it("uses the status-based fallback when the response body is not JSON", async () => {
    // A raw non-JSON body makes response.json() throw; the catch keeps the
    // status-based default message.
    const response = new Response("<html>oops</html>", {
      status: 502,
      headers: { "content-type": "text/html" }
    });

    await expect(buildErrorMessage(response)).resolves.toBe("Request failed: 502");
  });
});

describe("provider contracts", () => {
  it("reads tenant and runtime responses and updates keys without legacy aliases", async () => {
    const providerKeys = { anthropic: true, openai: false, google: false, openrouter: false, zai: false };
    const tenant = {
      tenantId: "t-1", tenantName: "Test", slug: "test", ssoProvider: null, plan: "pro",
      settings: {
        providerKeys, skillMarketplaceManifestUrl: null,
        piiProtection: DEFAULT_PII_PROTECTION,
        github: { configured: false }, microsoftOAuth: { configured: false }
      },
      createdAt: "2026-09-04T00:00:00Z", updatedAt: "2026-09-04T00:00:00Z"
    };
    const runtime = { e2bTemplateId: "template", platformProviders: ["openai"] };
    const fetch = vi.spyOn(global, "fetch")
      .mockReset()
      .mockResolvedValueOnce(jsonResponse(200, tenant))
      .mockResolvedValueOnce(jsonResponse(200, runtime))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, providerKeys }));
    try {
      expect((await getTenantDetails()).settings.providerKeys).toEqual(providerKeys);
      expect(await getRuntimeConfig()).toEqual(runtime);
      expect(await updateTenantProviderKey({ provider: "anthropic", apiKey: "" })).toEqual({ ok: true, providerKeys });
      expect(JSON.parse(String(fetch.mock.calls[2][1]?.body))).toEqual({ provider: "anthropic", apiKey: "" });
    } finally {
      fetch.mockRestore();
    }
  });
});
