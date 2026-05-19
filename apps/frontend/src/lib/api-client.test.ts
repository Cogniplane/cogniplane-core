import { describe, it, vi, beforeEach, expect } from "vitest";

import {
  request,
  setAccessToken,
  setTokenRefresher,
  createApiHeaders
} from "./api-client";

type FetchCall = { url: string; init: RequestInit | undefined };

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
});

describe("createApiHeaders", () => {
  beforeEach(() => setAccessToken(null));

  it("overwrites a stale Authorization header supplied by the caller", () => {
    setAccessToken("fresh-token");
    const headers = createApiHeaders({ Authorization: "Bearer stale" });
    expect(headers.get("Authorization")).toBe("Bearer fresh-token");
  });
});
