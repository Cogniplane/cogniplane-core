import { DEFAULT_PII_PROTECTION } from "@cogniplane/shared-types";
import { describe, it, vi, beforeEach, expect, expectTypeOf } from "vitest";

import {
  __resetSessionGateForTests,
  ApiError,
  changeSession,
  getAccessToken,
  getSessionEpoch,
  refreshAccessToken,
  replaceSession,
  request,
  requestOptionalOn404,
  REFRESH_TIME_LIMIT_MS,
  SESSION_CHANGE_TIME_LIMIT_MS,
  SessionChangeTimeoutError,
  setAccessToken,
  setStepUpPrompt,
  setTokenRefresher,
  StepUpCancelledError,
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

// The API client keeps the session and its gate in module state.
beforeEach(() => {
  __resetSessionGateForTests();
});

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Lets every pending promise chain run. */
const settle = () => new Promise<void>((done) => { setTimeout(done, 0); });

// A call whose answer sets or deletes the refresh cookie holds the gate; a
// refresh never sends the cookie while such a call runs.
describe("the session-change gate", () => {
  beforeEach(() => {
    setAccessToken(null);
    setTokenRefresher(async () => null);
  });

  it("holds a refresh until the session change ends, then uses its token and sends nothing", async () => {
    setAccessToken("old-session");
    const refresher = vi.fn(async () => "renewed");
    setTokenRefresher(refresher);
    const answer = deferred<{ accessToken: string }>();

    const change = changeSession(() => answer.promise, (result) => result.accessToken);
    const refreshed = refreshAccessToken();
    await settle();
    expect(refresher).not.toHaveBeenCalled();

    answer.resolve({ accessToken: "new-session" });
    await change;
    expect(await refreshed).toBe("new-session");
    expect(refresher).not.toHaveBeenCalled();
    expect(getAccessToken()).toBe("new-session");
  });

  it("sends the held refresh after a session change that failed", async () => {
    setAccessToken("old-session");
    const refresher = vi.fn(async () => "renewed");
    setTokenRefresher(refresher);
    const answer = deferred<void>();

    const change = changeSession(() => answer.promise.then(() => { throw new Error("refused"); }));
    const refreshed = refreshAccessToken();
    answer.resolve();
    await expect(change).rejects.toThrow("refused");
    expect(await refreshed).toBe("renewed");
    expect(refresher).toHaveBeenCalledTimes(1);
  });

  it("starts a session change only after the answer of the refresh on the wire", async () => {
    const answer = deferred<string | null>();
    setTokenRefresher(() => answer.promise);
    const send = vi.fn(async () => undefined);

    const refreshed = refreshAccessToken();
    const change = changeSession(send);
    await settle();
    expect(send).not.toHaveBeenCalled();

    answer.resolve("renewed");
    await change;
    expect(send).toHaveBeenCalledTimes(1);
    expect(await refreshed).toBe("renewed");
  });

  it("runs session changes one at a time", async () => {
    const first = deferred<void>();
    const second = vi.fn(async () => undefined);

    const changes = [changeSession(() => first.promise), changeSession(second)];
    await settle();
    expect(second).not.toHaveBeenCalled();

    first.resolve();
    await Promise.all(changes);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("refreshes at once on a 401 inside a session change, then sends the change again", async () => {
    setAccessToken("expired");
    setTokenRefresher(async () => "renewed");
    const { calls, fetch } = stubFetch([
      () => jsonResponse(401, { error: "invalid_token" }),
      () => jsonResponse(200, { accessToken: "new-session" })
    ]);
    // @ts-expect-error — stub
    global.fetch = fetch;

    const result = await changeSession(
      (gated) => gated<{ accessToken: string }>("/me/security/password", { method: "POST", body: "{}" }),
      (answer) => answer.accessToken
    );

    expect(result).toEqual({ accessToken: "new-session" });
    expect(calls.map((call) => new Headers(call.init?.headers).get("Authorization"))).toEqual(["Bearer expired", "Bearer renewed"]);
    expect(getAccessToken()).toBe("new-session");
  });

  it("does not install the answer when the session ended during the call", async () => {
    setAccessToken("current");
    const answer = deferred<{ accessToken: string }>();

    const change = changeSession(() => answer.promise, (result) => result.accessToken);
    await settle();
    // A sign-out came first.
    replaceSession(null);
    answer.resolve({ accessToken: "late" });
    await change;
    expect(getAccessToken()).toBeNull();
  });

  it("opens the gate when a session change does not answer in its time limit", async () => {
    vi.useFakeTimers();
    try {
      setAccessToken("old-session");
      const refresher = vi.fn(async () => "renewed");
      setTokenRefresher(refresher);
      let signal: AbortSignal | null = null;

      const change = changeSession((_request, limit) => {
        signal = limit;
        return new Promise<never>(() => {});
      }, () => "never");
      const settled = change.catch((error: unknown) => error);
      const refreshed = refreshAccessToken();

      await vi.advanceTimersByTimeAsync(SESSION_CHANGE_TIME_LIMIT_MS - 1);
      expect(refresher).not.toHaveBeenCalled();
      expect(signal!.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(await settled).toBeInstanceOf(SessionChangeTimeoutError);
      // The fetch is aborted before its answer, so its Set-Cookie does not apply.
      expect(signal!.aborted).toBe(true);
      expect(await refreshed).toBe("renewed");
      expect(refresher).toHaveBeenCalledTimes(1);
      expect(getAccessToken()).toBe("renewed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts the fetch of a gated request at the time limit or when the caller aborts", async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      // @ts-expect-error — stub
      global.fetch = vi.fn((_url: string, init?: RequestInit) => {
        signals.push(init!.signal!);
        return new Promise<never>((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason));
        });
      });

      const timedOut = changeSession((gated) => gated("/me/security/password", { method: "POST", body: "{}" })).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(SESSION_CHANGE_TIME_LIMIT_MS);
      expect(await timedOut).toBeInstanceOf(SessionChangeTimeoutError);
      expect(signals[0].aborted).toBe(true);

      const caller = new AbortController();
      const cancelled = changeSession((gated) => gated("/me/security/password", { method: "POST", body: "{}", signal: caller.signal })).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      caller.abort(new Error("the person cancelled"));
      expect(await cancelled).toEqual(new Error("the person cancelled"));
      expect(signals[1].aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails at once when a session change starts inside the send of another", async () => {
    const refresher = vi.fn(async () => "renewed");
    setTokenRefresher(refresher);

    await expect(changeSession(() => changeSession(async () => "inner"))).rejects.toThrow(/inside a session change/);
    // The gate is open again: a refresh is sent at once.
    expect(await refreshAccessToken()).toBe("renewed");
  });

  it("opens the gate and installs nothing when the refresh after a 401 in the gate fails", async () => {
    setAccessToken("expired");
    const refresher = vi.fn(async () => null);
    setTokenRefresher(refresher);
    const { calls, fetch } = stubFetch([() => jsonResponse(401, { error: "invalid_token" })]);
    // @ts-expect-error — stub
    global.fetch = fetch;
    const epoch = getSessionEpoch();

    const change = changeSession(
      (gated) => gated<{ accessToken: string }>("/me/security/password", { method: "POST", body: "{}" }),
      (answer) => answer.accessToken
    );
    const held = refreshAccessToken();

    await expect(change).rejects.toMatchObject({ status: 401 });
    // No retry without a token, and nothing went in.
    expect(calls).toHaveLength(1);
    expect(getAccessToken()).toBe("expired");
    expect(getSessionEpoch()).toBe(epoch);
    // The held refresh was sent after the gate opened.
    expect(await held).toBeNull();
    expect(refresher).toHaveBeenCalledTimes(2);
  });

  it("the test reset opens a held gate and forgets the session", async () => {
    vi.useFakeTimers();
    try {
      setAccessToken("current");
      void changeSession(() => new Promise<never>(() => {})).catch(() => undefined);
      __resetSessionGateForTests();
      const refresher = vi.fn(async () => "renewed");
      setTokenRefresher(refresher);

      expect(getAccessToken()).toBeNull();
      expect(await refreshAccessToken()).toBe("renewed");
      expect(refresher).toHaveBeenCalledTimes(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("keeps a newer session when the refresh of an older one answers late", async () => {
    setAccessToken("old-session");
    const answer = deferred<string | null>();
    setTokenRefresher(() => answer.promise);

    const refreshed = refreshAccessToken();
    replaceSession("new-session");
    answer.resolve("renewed-old-session");
    expect(await refreshed).toBe("new-session");
    expect(getAccessToken()).toBe("new-session");
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
        github: { configured: false }
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

  it("reads a tenant response that has settings this schema does not name", async () => {
    // An older backend can send more settings. The frontend must accept them.
    const tenant = {
      tenantId: "t-1", tenantName: "Test", slug: "test", ssoProvider: null, plan: "pro",
      settings: {
        providerKeys: { anthropic: true, openai: false, google: false, openrouter: false, zai: false },
        skillMarketplaceManifestUrl: null,
        piiProtection: DEFAULT_PII_PROTECTION,
        github: { configured: true },
        legacyIntegration: { configured: false }
      },
      createdAt: "2026-09-04T00:00:00Z", updatedAt: "2026-09-04T00:00:00Z"
    };
    const fetch = vi.spyOn(global, "fetch").mockReset().mockResolvedValueOnce(jsonResponse(200, tenant));
    try {
      const details = await getTenantDetails();
      expect(details.settings.github.configured).toBe(true);
      expect(details.settings).toMatchObject({ legacyIntegration: { configured: false } });
    } finally {
      fetch.mockRestore();
    }
  });
});

// A sensitive change (for example a setting that changes where data goes)
// gets a 403 that names a step-up action. The request layer asks for a fresh
// proof once and sends the same request again with the single-use token.
describe("request: 403 step_up_required → proof → the same request once more", () => {
  const REFUSAL = { error: "step_up_required", action: "tenant.settings" };

  beforeEach(() => {
    setAccessToken("token");
    setStepUpPrompt(null);
  });

  it("asks for the named action and resends the same request with the token in X-Step-Up", async () => {
    const { calls, fetch } = stubFetch([() => jsonResponse(403, REFUSAL), () => jsonResponse(200, { ok: true })]);
    // @ts-expect-error — stub
    global.fetch = fetch;
    const prompt = vi.fn(async (_action: string, resend: (token: string) => Promise<Response>) => resend("step-up-1"));
    setStepUpPrompt(prompt);

    const body = JSON.stringify({ showEffortSelector: true });
    const result = await request<{ ok: boolean }>("/admin/tenant-settings", { method: "PUT", body });

    expect(result).toEqual({ ok: true });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0]![0]).toBe("tenant.settings");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe(calls[0]!.url);
    expect(calls[1]!.init?.method).toBe("PUT");
    expect(calls[1]!.init?.body).toBe(body);
    expect(new Headers(calls[0]!.init?.headers).get("X-Step-Up")).toBeNull();
    expect(new Headers(calls[1]!.init?.headers).get("X-Step-Up")).toBe("step-up-1");
    expect(new Headers(calls[1]!.init?.headers).get("Authorization")).toBe("Bearer token");
  });

  it("returns the resent request's error to the caller", async () => {
    const { fetch } = stubFetch([() => jsonResponse(403, REFUSAL), () => jsonResponse(409, { error: "settings_conflict", message: "Reload." })]);
    // @ts-expect-error — stub
    global.fetch = fetch;
    setStepUpPrompt(async (_action, resend) => resend("step-up-1"));

    await expect(request("/admin/tenant-settings", { method: "PUT", body: "{}" })).rejects.toMatchObject({ status: 409, code: "settings_conflict" });
  });

  it("does not send the request again when the user cancels", async () => {
    const { calls, fetch } = stubFetch([() => jsonResponse(403, REFUSAL)]);
    // @ts-expect-error — stub
    global.fetch = fetch;
    setStepUpPrompt(async () => { throw new StepUpCancelledError(); });

    const error = await request("/admin/tenant-settings", { method: "PUT", body: "{}" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: "step_up_cancelled" });
    expect(calls).toHaveLength(1);
  });

  // A call in changeSession holds the session gate: a prompt there would
  // stop every refresh until the person answers.
  it("a session change does not ask; its caller handles step-up", async () => {
    __resetSessionGateForTests();
    const { calls, fetch } = stubFetch([() => jsonResponse(403, REFUSAL)]);
    // @ts-expect-error — stub
    global.fetch = fetch;
    const prompt = vi.fn();
    setStepUpPrompt(prompt);

    await expect(changeSession((send) => send("/me/security/password", { method: "POST", body: "{}" })))
      .rejects.toMatchObject({ status: 403, code: "step_up_required" });
    expect(prompt).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it("leaves the refusal to the caller when no prompt is mounted, when the request had a token, or when no action is named", async () => {
    const prompt = vi.fn();
    for (const [response, init, promptSet] of [
      [jsonResponse(403, REFUSAL), { method: "PUT" }, false],
      [jsonResponse(403, REFUSAL), { method: "PUT", headers: { "X-Step-Up": "own-token" } }, true],
      [jsonResponse(403, { error: "step_up_required" }), { method: "PUT" }, true],
      [jsonResponse(403, { error: "forbidden", action: "tenant.settings" }), { method: "PUT" }, true]
    ] as const) {
      setStepUpPrompt(promptSet ? prompt : null);
      const { calls, fetch } = stubFetch([() => response]);
      // @ts-expect-error — stub
      global.fetch = fetch;
      await expect(request("/admin/tenant-settings", init)).rejects.toBeInstanceOf(ApiError);
      expect(calls).toHaveLength(1);
    }
    expect(prompt).not.toHaveBeenCalled();
  });
});


describe("refresh deadlines", () => {
  it("releases a session change after two hung attempts and ignores late tokens", async () => {
    vi.useFakeTimers();
    try {
      expect(2 * REFRESH_TIME_LIMIT_MS).toBeLessThan(60_000);
      const late = deferred<string | null>();
      const signals: AbortSignal[] = [];
      setTokenRefresher((signal) => { signals.push(signal); return late.promise; });
      const refresh = refreshAccessToken();
      await vi.advanceTimersByTimeAsync(0);
      const send = vi.fn(async () => ({ accessToken: "new-session" }));
      const change = changeSession(send, result => result.accessToken);
      await vi.advanceTimersByTimeAsync(REFRESH_TIME_LIMIT_MS);
      expect(signals).toHaveLength(2);
      expect(signals[0].aborted).toBe(true);
      expect(send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(REFRESH_TIME_LIMIT_MS);
      await change;
      await refresh;
      expect(signals[1].aborted).toBe(true);
      expect(send).toHaveBeenCalledOnce();
      late.resolve("late-old-token");
      await vi.advanceTimersByTimeAsync(0);
      expect(getAccessToken()).toBe("new-session");
    } finally { vi.useRealTimers(); }
  });
});
