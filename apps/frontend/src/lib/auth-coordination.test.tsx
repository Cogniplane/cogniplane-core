// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./auth-context";
import { __resetSessionGateForTests, changeSession, getAccessToken, replaceSession, REFRESH_TIME_LIMIT_MS, SESSION_CHANGE_TIME_LIMIT_MS } from "./api-client";
import { __resetCodeExchangesForTests, exchangeCodeOnce } from "./auth-callback-exchange";

vi.hoisted(() => { delete process.env.NEXT_PUBLIC_DEV_USER_ID; });
const A = { userId: "person-a", tenantId: "tenant-a", email: "a@example.test", displayName: "A", role: "member" as const };
const B = { ...A, userId: "person-b", email: "b@example.test" };
const jwt = (person = A) => `header.${btoa(JSON.stringify({ sub: person.userId, tid: person.tenantId }))}.signature`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
let auth: ReturnType<typeof useAuth>;
function Probe({ onReady }: { onReady: (value: ReturnType<typeof useAuth>) => void }) { onReady(useAuth()); return null; }
async function signedIn() {
  const fetcher = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input) => String(input).endsWith("/me") ? json(A) : json({ accessToken: jwt() }));
  vi.stubGlobal("fetch", fetcher);
  render(<AuthProvider><Probe onReady={(value) => { auth = value; }} /></AuthProvider>);
  await waitFor(() => expect(auth.user?.userId).toBe(A.userId));
  fetcher.mockReset();
  return fetcher;
}
beforeEach(() => { __resetSessionGateForTests(); __resetCodeExchangesForTests(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// This fake applies a cookie at header delivery. Its JSON body is independent
// and can even settle after abort. It models timing, not browser networking.
function delayedBody(cookieJar: { value: string }, cookie: string) {
  const body = deferred<unknown>();
  cookieJar.value = cookie;
  return { body, response: { ok: true, status: 200, json: () => body.promise } as Response };
}

it.each(["sign-in", "sign-out"])("keeps the newer %s when a callback body is late", async (action) => {
  const fetcher = await signedIn();
  const jar = { value: "A" };
  const pending = delayedBody(jar, "callback-cookie");
  let signal!: AbortSignal;
  fetcher.mockImplementation(async (_url, init) => { signal = init!.signal as AbortSignal; return pending.response; });
  let callback!: Promise<unknown>;
  await act(async () => { callback = exchangeCodeOnce("late-code", "state", auth.completeLogin); });
  await waitFor(() => expect(signal).toBeDefined());
  let newer!: Promise<unknown>;
  await act(async () => {
    newer = changeSession(async () => { jar.value = action === "sign-in" ? "B" : ""; return null; }, () => action === "sign-in" ? jwt(B) : null, { stopRefresh: action === "sign-out" });
    if (action === "sign-in") pending.body.resolve({ accessToken: jwt() });
    await newer;
  });
  if (action === "sign-out") {
    expect(signal.aborted).toBe(true);
    await act(async () => { pending.body.resolve({ accessToken: jwt() }); });
  }
  await act(async () => { await callback; });
  expect(getAccessToken()).toBe(action === "sign-in" ? jwt(B) : null);
  expect(jar.value).toBe(action === "sign-in" ? "B" : "");
});

it("rejects callback completion after a direct intervening epoch change", async () => {
  const fetcher = await signedIn();
  const pending = delayedBody({ value: "" }, "callback");
  fetcher.mockResolvedValue(pending.response);
  const complete = vi.fn(auth.completeLogin);
  const callback = exchangeCodeOnce("epoch-code", "state", complete);
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  act(() => { replaceSession(jwt(B)); });
  await act(async () => { pending.body.resolve({ accessToken: jwt() }); await callback; });
  expect(complete).not.toHaveBeenCalled();
  expect(getAccessToken()).toBe(jwt(B));
});

it("does not let a completed callback bootstrap restart a newer epoch", async () => {
  const fetcher = await signedIn();
  const oldComplete = auth.completeLogin;
  const callbackEpoch = replaceSession(jwt());
  act(() => { replaceSession(jwt(B)); });
  await act(async () => { expect(await oldComplete(jwt(), callbackEpoch)).toBe(false); });
  expect(fetcher).not.toHaveBeenCalled();
  expect(getAccessToken()).toBe(jwt(B));
});

it("times out a callback body and ignores its late result", async () => {
  const fetcher = await signedIn();
  const pending = delayedBody({ value: "" }, "callback");
  fetcher.mockResolvedValue(pending.response);
  vi.useFakeTimers();
  const callback = exchangeCodeOnce("timeout-code", "state", auth.completeLogin);
  // Web Crypto completes outside the fake timer queue.
  await act(async () => { await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce()); });
  await act(async () => { await vi.advanceTimersByTimeAsync(SESSION_CHANGE_TIME_LIMIT_MS); await callback; });
  act(() => { replaceSession(jwt(B)); });
  await act(async () => { pending.body.resolve({ accessToken: jwt() }); });
  expect(getAccessToken()).toBe(jwt(B));
});

it.each([B, { ...A, tenantId: "tenant-b" }, { ...B, tenantId: "tenant-b" }])("rejects every successful refresh for $userId/$tenantId after a timeout", async (other) => {
  const fetcher = await signedIn();
  const pending = delayedBody({ value: "" }, "rotated-A");
  fetcher.mockResolvedValueOnce(pending.response).mockResolvedValueOnce(json({ accessToken: jwt(other) }));
  vi.useFakeTimers();
  let refresh!: Promise<string | null>;
  await act(async () => { refresh = auth.refreshToken(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(REFRESH_TIME_LIMIT_MS); expect(await refresh).toBeNull(); });
  expect(auth.user).toBeNull();
  expect(getAccessToken()).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
  await act(async () => { pending.body.resolve({ accessToken: jwt() }); });
  expect(getAccessToken()).toBeNull();
});

it("signs out with the cookie delivered by refresh headers while its body hangs", async () => {
  const fetcher = await signedIn();
  const jar = { value: "old-cookie" };
  const body = deferred<unknown>();
  const cookies: string[] = [];
  fetcher.mockImplementation(async (url) => {
    if (String(url).endsWith("/refresh")) {
      cookies.push(jar.value);
      jar.value = "rotated-cookie";
      return { ok: true, json: () => body.promise } as Response;
    }
    cookies.push(jar.value);
    jar.value = "";
    return json({});
  });
  let refresh!: Promise<string | null>;
  await act(async () => { refresh = auth.refreshToken(); });
  expect(jar.value).toBe("rotated-cookie");
  await act(async () => { await auth.logout(); expect(await refresh).toBeNull(); });
  expect(cookies).toEqual(["old-cookie", "rotated-cookie"]);
  await act(async () => { body.resolve({ accessToken: jwt() }); });
  expect(getAccessToken()).toBeNull();
  expect(jar.value).toBe("");
});

it("stores only a SHA-256 code digest and keeps replay protection after reload", async () => {
  const code = "unspent-sensitive-authorization-code";
  const fetcher = vi.fn(async () => json({ accessToken: "token" }));
  vi.stubGlobal("fetch", fetcher);
  await exchangeCodeOnce(code, "state", async () => true);
  const storage = JSON.stringify(Object.entries(sessionStorage));
  expect(storage).not.toContain(code);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code))), (b) => b.toString(16).padStart(2, "0")).join("");
  expect(sessionStorage.getItem(`cogniplane_used_auth_code:${digest}`)).toBe("1");
  __resetCodeExchangesForTests();
  expect(await exchangeCodeOnce(code, "state", async () => true)).toEqual({ kind: "already_used" });
  expect(fetcher).toHaveBeenCalledOnce();
});

it("fails closed without storing or sending the code if crypto fails", async () => {
  vi.stubGlobal("crypto", { subtle: { digest: vi.fn().mockRejectedValue(new Error("unavailable")) } });
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  expect((await exchangeCodeOnce("secret-code", "state", async () => true)).kind).toBe("failed");
  expect(fetcher).not.toHaveBeenCalled();
  expect(sessionStorage.length).toBe(0);
});

it.each(["direct", "revoked-cookie"])("checks both person and tenant on %s refresh successes", async (path) => {
  const fetcher = await signedIn();
  if (path === "revoked-cookie") fetcher.mockResolvedValueOnce(json({ error: "session_revoked" }, 401));
  fetcher.mockResolvedValueOnce(json({ accessToken: jwt(B) }));
  await act(async () => { expect(await auth.refreshToken()).toBeNull(); });
  expect(auth.user).toBeNull();
  expect(getAccessToken()).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(path === "direct" ? 1 : 2);
});

it("retries a revoked cookie only once and accepts the same identity", async () => {
  const fetcher = await signedIn();
  fetcher.mockResolvedValueOnce(json({ error: "token_revoked" }, 401)).mockResolvedValueOnce(json({ accessToken: jwt() }));
  await act(async () => { expect(await auth.refreshToken()).toBe(jwt()); });
  expect(auth.user?.userId).toBe(A.userId);
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockReset().mockResolvedValue(json({ error: "token_revoked" }, 401));
  await act(async () => { expect(await auth.refreshToken()).toBeNull(); });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("ignores a stale refresh without clearing the newer person or token", async () => {
  const fetcher = await signedIn();
  const body = deferred<unknown>();
  fetcher.mockResolvedValueOnce({ ok: true, json: () => body.promise } as Response).mockResolvedValue(json(B));
  let refresh!: Promise<string | null>;
  await act(async () => { refresh = auth.refreshToken(); });
  const staleComplete = auth.completeLogin;
  await act(async () => { await staleComplete(jwt(B)); });
  await act(async () => { body.resolve({ accessToken: jwt() }); await refresh; });
  expect(auth.user?.userId).toBe(B.userId);
  expect(getAccessToken()).toBe(jwt(B));
});

it("cancels a callback queued behind refresh before sign-out can be delayed", async () => {
  const fetcher = await signedIn();
  fetcher.mockImplementation(() => new Promise<Response>(() => {}));
  let refresh!: Promise<string | null>;
  await act(async () => { refresh = auth.refreshToken(); });
  const callback = exchangeCodeOnce("queued-code", "state", auth.completeLogin);
  // Wait for the digest without letting the active refresh finish.
  await new Promise((done) => setTimeout(done, 20));
  fetcher.mockResolvedValue(json({}));
  await act(async () => { await auth.logout(); await refresh; await callback; });
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/callback"))).toBe(false);
  expect(getAccessToken()).toBeNull();
});

it("bootstraps the installed callback session after the whole AuthProvider remounts", async () => {
  const fetcher = await signedIn();
  const pending = delayedBody({ value: "" }, "callback");
  fetcher.mockImplementation(async (url) => String(url).endsWith("/callback") ? pending.response : String(url).endsWith("/me") ? json(A) : json({ accessToken: jwt() }));
  const callback = exchangeCodeOnce("remount-code", "state", auth.completeLogin);
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  cleanup();
  render(<AuthProvider><Probe onReady={(value) => { auth = value; }} /></AuthProvider>);
  await act(async () => { pending.body.resolve({ accessToken: jwt() }); await callback; });
  await waitFor(() => expect(auth.user?.userId).toBe(A.userId));
  expect(getAccessToken()).toBe(jwt());
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/callback"))).toHaveLength(1);
});

it("holds refresh until the callback body has been parsed and its token installed", async () => {
  const fetcher = await signedIn();
  const pending = delayedBody({ value: "" }, "callback");
  fetcher.mockImplementation(async (url) => String(url).endsWith("/callback") ? pending.response : json(A));
  const callback = exchangeCodeOnce("gate-code", "state", auth.completeLogin);
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  let refresh!: Promise<string | null>;
  await act(async () => { refresh = auth.refreshToken(); });
  expect(fetcher).toHaveBeenCalledOnce();
  await act(async () => { pending.body.resolve({ accessToken: jwt() }); await callback; expect(await refresh).toBe(jwt()); });
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/refresh"))).toBe(false);
});


it("does not run the installer of a stale session-change result", async () => {
  const install = vi.fn(() => jwt());
  await act(async () => {
    await changeSession(async () => {
      queueMicrotask(() => { replaceSession(jwt(B)); });
      return { accessToken: jwt() };
    }, install);
  });
  expect(install).not.toHaveBeenCalled();
  expect(getAccessToken()).toBe(jwt(B));
});

it("does not send a callback if the initiating epoch changed during hashing", async () => {
  const fetcher = await signedIn();
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("hash-race-code"));
  const hashing = deferred<ArrayBuffer>();
  vi.spyOn(crypto.subtle, "digest").mockReturnValueOnce(hashing.promise);
  const callback = exchangeCodeOnce("hash-race-code", "state", auth.completeLogin);
  act(() => { replaceSession(jwt(B)); });
  await act(async () => { hashing.resolve(bytes); expect((await callback).kind).toBe("failed"); });
  expect(fetcher).not.toHaveBeenCalled();
  expect(getAccessToken()).toBe(jwt(B));
});

it.each([B, { ...A, tenantId: "tenant-b" }, { ...B, tenantId: "tenant-b" }])("refreshes the pending callback identity $userId/$tenantId before user bootstrap finishes", async (person) => {
  const fetcher = await signedIn();
  const me = deferred<Response>();
  fetcher.mockImplementation(async (url) => String(url).endsWith("/me") ? me.promise : json({ accessToken: jwt(person) }));
  let callback!: ReturnType<typeof exchangeCodeOnce>;
  await act(async () => { callback = exchangeCodeOnce("bootstrap-code", "state", auth.completeLogin); });
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/me"))).toBe(true));
  expect(auth.user?.userId).toBe(A.userId);
  expect(getAccessToken()).toBe(jwt(person));
  await act(async () => { expect(await auth.refreshToken()).toBe(jwt(person)); });
  await act(async () => { me.resolve(json(person)); expect((await callback).kind).toBe("signed_in"); });
  expect(auth.user).toEqual(person);
  expect(getAccessToken()).toBe(jwt(person));
});

it("rejects a refresh for the former person during callback bootstrap", async () => {
  const fetcher = await signedIn();
  const me = deferred<Response>();
  fetcher.mockImplementation(async (url) => String(url).endsWith("/me") ? me.promise : json({ accessToken: jwt(B) }));
  const callback = exchangeCodeOnce("bootstrap-mismatch", "state", auth.completeLogin);
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/me"))).toBe(true));
  fetcher.mockResolvedValue(json({ accessToken: jwt(A) }));
  await act(async () => { expect(await auth.refreshToken()).toBeNull(); });
  await act(async () => { me.resolve(json(B)); expect((await callback).kind).toBe("failed"); });
  expect(auth.user).toBeNull();
  expect(getAccessToken()).toBeNull();
});

it("keeps sign-out when callback user bootstrap finishes late", async () => {
  const fetcher = await signedIn();
  const me = deferred<Response>();
  fetcher.mockImplementation(async (url) => String(url).endsWith("/me") ? me.promise : json({ accessToken: jwt(B) }));
  const callback = exchangeCodeOnce("bootstrap-logout", "state", auth.completeLogin);
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/me"))).toBe(true));
  fetcher.mockResolvedValue(json({}));
  await act(async () => { await auth.logout(); });
  await act(async () => { me.resolve(json(B)); expect((await callback).kind).toBe("failed"); });
  expect(auth.user).toBeNull();
  expect(getAccessToken()).toBeNull();
});

it.each([A, B, { ...B, tenantId: "tenant-b" }])("checks the installed callback identity after provider remount against $userId/$tenantId", async (refreshed) => {
  const fetcher = await signedIn();
  const firstMe = deferred<Response>();
  let meCalls = 0;
  fetcher.mockImplementation(async (url) => {
    if (String(url).endsWith("/callback")) return json({ accessToken: jwt(B) });
    if (String(url).endsWith("/refresh")) return json({ accessToken: jwt(refreshed) });
    meCalls++;
    return meCalls === 1 ? firstMe.promise : json(refreshed);
  });
  let callback!: ReturnType<typeof exchangeCodeOnce>;
  await act(async () => { callback = exchangeCodeOnce("bootstrap-remount-identity", "state", auth.completeLogin); });
  await waitFor(() => expect(meCalls).toBe(1));
  expect(getAccessToken()).toBe(jwt(B));
  cleanup();
  render(<AuthProvider><Probe onReady={(value) => { auth = value; }} /></AuthProvider>);
  await waitFor(() => expect(auth.isLoading).toBe(false));
  const accepted = refreshed.userId === B.userId && refreshed.tenantId === B.tenantId;
  expect(auth.user).toEqual(accepted ? B : null);
  expect(getAccessToken()).toBe(accepted ? jwt(B) : null);
  await act(async () => { firstMe.resolve(json(B)); await callback; });
  expect(auth.user).toEqual(accepted ? B : null);
  expect(getAccessToken()).toBe(accepted ? jwt(B) : null);
});
