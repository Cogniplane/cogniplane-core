// @vitest-environment jsdom
//
// The real AuthProvider, AuthGuard, API client, and Settings › Sign-in &
// security page, against a small model of the backend session rules
// (apps/backend/src/routes/auth-session.ts). An access token lives 15
// minutes. The browser holds one refresh cookie; an answer changes it when the
// answer arrives, not when the server runs the call. /auth/refresh rotates the
// cookie of its family. A first second factor increases the security version,
// which ends every older session, and its answer sets the cookie of a new
// family. A refresh with the cookie of an older security version ends that
// family and answers 403. A refused refresh never deletes the cookie: another
// tab can have a newer one when the answer arrives. Only the network and the
// browser passkey ceremony are stubbed.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The provider reads this at load. Dev-headers mode would invent an owner.
vi.hoisted(() => { delete process.env.NEXT_PUBLIC_DEV_USER_ID; });
const router = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("../lib/passkey-browser", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  passkeysSupported: () => true,
  createPasskey: async () => ({ id: "cred-1", type: "public-key" })
}));

import SettingsSecurityPage from "../app/settings/security/page";
import { __resetSessionGateForTests, API_URL, createApiHeaders, refreshAccessToken, REFRESH_TIME_LIMIT_MS } from "../lib/api-client";
import { AuthProvider, useAuth } from "../lib/auth-context";
import { AuthGuard } from "../lib/auth-guard";
import { fetchMySecurity } from "../lib/local-auth-api";

const MINUTE = 60_000;
const ACCESS_TOKEN_LIFETIME = 15 * MINUTE;
const PERSON = { userId: "u-1", email: "person@example.test", displayName: "Person", tenantId: "t-1", role: "member", loginType: "local" };
const PASSKEY = { id: "cred-1", name: "Laptop", createdAt: "2026-10-01T00:00:00.000Z", lastUsedAt: null, backedUp: true };
const CODES = ["AAAA-BBBB-CCCC-DDDD"];
const FACTORS = [
  { factor: "authenticator app", done: "Your authenticator app is set up.", call: "POST /me/security/totp/confirm" },
  { factor: "passkey", done: "Your passkey is added.", call: "POST /me/security/passkeys/verify" }
] as const;
type Factor = (typeof FACTORS)[number]["factor"];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** `cookie` is the refresh cookie that the browser sent with the call. */
type Call = { method: string; path: string; token: string | null; cookie: string | null; status: number };
/** A Set-Cookie of the answer: a new refresh cookie, null to delete it, undefined for none. */
type Answer = { response: Response; setCookie?: string | null };

const STEP_UP_TOKEN = "step-up-1";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function installBackend() {
  const grants = new Map<string, { expiresAt: number; securityVersion: number }>();
  const calls: Call[] = [];
  const state = { securityVersion: 1, issued: 0, totpEnabled: false, passkeyCount: 0 };
  const families: Array<{ securityVersion: number; rotation: number; ended: boolean }> = [];
  // Holds the answer of the next call with this key until the test releases it.
  const holds = new Map<string, { sent: ReturnType<typeof deferred>; answer: ReturnType<typeof deferred> }>();

  const cookieOf = (id: number) => `rt-${id}-${families[id].rotation}`;
  const startFamily = () => {
    families.push({ securityVersion: state.securityVersion, rotation: 1, ended: false });
    return cookieOf(families.length - 1);
  };
  // The person signed in on an earlier visit: the browser has a refresh cookie.
  const jar: { refresh: string | null } = { refresh: startFamily() };

  const tokenAt = (n: number) => `header.${btoa(JSON.stringify({ sub: PERSON.userId, tid: PERSON.tenantId, n }))}.signature`;
  const issue = () => {
    const token = tokenAt(++state.issued);
    grants.set(token, { expiresAt: Date.now() + ACCESS_TOKEN_LIFETIME, securityVersion: state.securityVersion });
    return token;
  };
  const accepts = (token: string | null) => {
    const grant = token ? grants.get(token) : undefined;
    return grant !== undefined && Date.now() < grant.expiresAt && grant.securityVersion === state.securityVersion;
  };

  const completed = new Map<string, Answer>();
  const refresh = (cookie: string | null): Answer => {
    if (!cookie) return { response: json(401, { error: "missing_refresh_token" }) };
    const [, id, rotation] = /^rt-(\d+)-(\d+)$/.exec(cookie) ?? [];
    const family = families[Number(id)];
    if (!family) return { response: json(401, { error: "invalid_refresh_token" }) };
    // The membership decides first: a cookie of an older security version
    // ends its family for good. The refusals keep the cookie
    // (apps/backend/src/routes/auth-session.ts).
    if (family.securityVersion !== state.securityVersion) {
      family.ended = true;
      return { response: json(403, { error: "session_revoked" }) };
    }
    if (!family.ended && completed.has(cookie)) return completed.get(cookie)!;
    if (family.ended || Number(rotation) !== family.rotation) {
      family.ended = true;
      return { response: json(401, { error: "token_revoked" }) };
    }
    family.rotation += 1;
    const result = { response: json(200, { accessToken: issue() }), setCookie: cookieOf(Number(id)) };
    completed.set(cookie, { ...result, response: result.response.clone() });
    return result;
  };

  // A first second factor: every older session ends, and the answer sets the
  // refresh cookie of the new session.
  const newSession = (body: object): Answer => {
    state.securityVersion += 1;
    const setCookie = startFamily();
    return { response: json(200, { ...body, accessToken: issue(), user: PERSON, recoveryCodes: CODES }), setCookie };
  };

  const answer = (method: string, path: string, token: string | null, cookie: string | null, stepUp: string | null): Answer => {
    if (path === "/auth/refresh") return refresh(cookie);
    if (path === "/auth/logout") {
      const id = Number(/^rt-(\d+)-/.exec(cookie ?? "")?.[1]);
      if (families[id]) families[id].ended = true;
      return { response: json(200, {}), setCookie: null };
    }
    if (path === "/auth/config") return { response: json(200, { mode: "jwt", loginTypes: ["local"], passwordRecovery: false, passkeys: true }) };
    if (!accepts(token)) return { response: json(401, { error: "invalid_token" }) };
    switch (`${method} ${path}`) {
      case "GET /auth/me":
        return { response: json(200, PERSON) };
      case "GET /me/security":
        return { response: json(200, {
          loginType: "local",
          passwordChangedAt: null,
          totpEnabled: state.totpEnabled,
          passkeyCount: state.passkeyCount,
          recoveryCodesRemaining: state.totpEnabled || state.passkeyCount > 0 ? CODES.length : 0,
          mfaRequired: false
        }) };
      case "GET /me/security/passkeys":
        return { response: json(200, { passkeys: state.passkeyCount > 0 ? [PASSKEY] : [] }) };
      // A first factor needs a fresh proof: the password, with no factor yet.
      case "POST /auth/step-up":
        return { response: json(200, { stepUpToken: STEP_UP_TOKEN, expiresInSeconds: 300 }) };
      case "POST /me/security/totp/start":
        if (stepUp !== STEP_UP_TOKEN) return { response: json(403, { error: "step_up_required" }) };
        return { response: json(200, { secret: "JBSWY3DPEHPK3PXP", otpauthUri: "otpauth://totp/Cogniplane:person?secret=JBSWY3DPEHPK3PXP" }) };
      case "POST /me/security/totp/confirm":
        state.totpEnabled = true;
        return newSession({});
      case "POST /me/security/passkeys/options":
        if (stepUp !== STEP_UP_TOKEN) return { response: json(403, { error: "step_up_required" }) };
        return { response: json(200, { options: { challenge: "challenge" }, challengeId: "challenge-1" }) };
      case "POST /me/security/passkeys/verify":
        state.passkeyCount = 1;
        return newSession({ passkey: PASSKEY });
      default:
        return { response: json(404, { error: "unexpected_call", path }) };
    }
  };

  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = new URL(String(input)).pathname;
    const headers = new Headers(init?.headers);
    const token = headers.get("Authorization")?.replace(/^Bearer /, "") ?? null;
    // The browser sends the cookie that it has now; the server runs the call
    // at once.
    const cookie = jar.refresh;
    const { response, setCookie } = answer(method, path, token, cookie, headers.get("X-Step-Up"));
    calls.push({ method, path, token, cookie, status: response.status });
    const hold = holds.get(`${method} ${path}`);
    if (hold) {
      holds.delete(`${method} ${path}`);
      hold.sent.resolve();
      await new Promise<void>((resolve, reject) => {
        hold.answer.promise.then(resolve);
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }
    // The answer arrives: the browser applies its Set-Cookie.
    if (setCookie !== undefined) jar.refresh = setCookie;
    return response;
  }));

  return {
    calls,
    jar,
    lastIssued: () => tokenAt(state.issued),
    /** The refresh cookie that the newest session has now. */
    currentCookie: () => cookieOf(families.length - 1),
    replaceInOtherTab() { jar.refresh = startFamily(); },
    revokeInOtherTab(code: string) {
      if (code === "session_revoked") state.securityVersion += 1;
      else families[Number(/^rt-(\d+)-/.exec(jar.refresh ?? "")?.[1])].ended = true;
    },
    hold(key: string) {
      const hold = { sent: deferred(), answer: deferred() };
      holds.set(key, hold);
      return { sent: hold.sent.promise, release: hold.answer.resolve };
    }
  };
}

function SignedInAs() {
  const { user, logout } = useAuth();
  return <><p data-testid="user">{user?.email ?? "none"}</p><button onClick={() => void logout()}>Test sign out</button></>;
}

function mount() {
  render(
    <AuthProvider>
      <SignedInAs />
      <AuthGuard>
        <SettingsSecurityPage />
      </AuthGuard>
    </AuthProvider>
  );
}

/** Goes to the last step of a first factor. Returns the click that sends it. */
async function prepareFirstFactor(factor: Factor): Promise<() => void> {
  fireEvent.click(await screen.findByRole("button", { name: factor === "authenticator app" ? "Set up an authenticator app" : "Add a passkey" }));
  // A first factor asks for the password first.
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("Your password"), { target: { value: "my own password" } });
  const proceed = within(dialog).getByRole("button", { name: "Continue" });
  // The passkey is created and sent as soon as the password is confirmed.
  if (factor === "passkey") return () => fireEvent.click(proceed);
  fireEvent.click(proceed);
  fireEvent.change(await screen.findByLabelText("Code from the app"), { target: { value: "123456" } });
  return () => fireEvent.click(screen.getByRole("button", { name: "Turn on two-step verification" }));
}

async function addFirstFactor(factor: Factor) {
  (await prepareFirstFactor(factor))();
  expect((await screen.findByRole("list", { name: "Recovery codes" })).textContent).toContain(CODES[0]);
}

const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  __resetSessionGateForTests();
  router.replace.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  __resetSessionGateForTests();
  document.cookie = "cogniplane_session_hint=; Path=/; Max-Age=0";
});

describe("Settings › Sign-in & security, the session of a first second factor", () => {
  it.each(FACTORS)("keeps the person signed in after more than 15 minutes on the recovery codes of a new $factor", async ({ factor, done }) => {
    const backend = installBackend();
    mount();
    await addFirstFactor(factor);

    // The enrolment token expires while the person saves the codes.
    await wait(ACCESS_TOKEN_LIFETIME + MINUTE);
    const saved = backend.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "I saved my codes" }));

    expect(await screen.findByText(done)).toBeTruthy();
    // The page loads its state again; the session of the new factor gives a
    // fresh token for it.
    await waitFor(() => expect(backend.calls.slice(saved).some((call) => call.path === "/me/security" && call.status === 200)).toBe(true));
    expect(screen.getByTestId("user").textContent).toBe(PERSON.email);
    // The expired token gives one shared refresh, not one per request.
    expect(backend.calls.slice(saved).filter((call) => call.path === "/auth/refresh")).toHaveLength(1);
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Two-step verification" })).toBeTruthy();
  });

  it.each(FACTORS)("does not replace a token refreshed during the recovery codes of a new $factor", async ({ factor, done }) => {
    const backend = installBackend();
    mount();
    await addFirstFactor(factor);
    const enrolmentToken = backend.lastIssued();

    // Five minutes later, the API client refreshes the session.
    await wait(5 * MINUTE);
    let refreshed: string | null = null;
    await act(async () => { refreshed = await refreshAccessToken(); });
    expect(refreshed).not.toBeNull();
    expect(refreshed).not.toBe(enrolmentToken);

    // The enrolment token is still valid, but older.
    await wait(5 * MINUTE);
    const saved = backend.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "I saved my codes" }));

    expect(await screen.findByText(done)).toBeTruthy();
    await waitFor(() => expect(backend.calls.slice(saved).some((call) => call.path === "/me/security")).toBe(true));
    const after = backend.calls.slice(saved);
    expect(after.filter((call) => call.path === "/me/security").map((call) => call.token)).toEqual([refreshed]);
    expect(after.some((call) => call.token === enrolmentToken)).toBe(false);
    expect(createApiHeaders().get("Authorization")).toBe(`Bearer ${refreshed}`);
    expect(screen.getByTestId("user").textContent).toBe(PERSON.email);
  });
});

// The session-change gate (session-coordinator.ts, "The session token, in order").
describe("Settings › Sign-in & security, a refresh at the same time as a first second factor", () => {
  /** The person saves the codes after the enrolment token expired. */
  async function saveCodesLater(backend: ReturnType<typeof installBackend>, done: string) {
    await wait(ACCESS_TOKEN_LIFETIME + MINUTE);
    const saved = backend.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "I saved my codes" }));
    expect(await screen.findByText(done)).toBeTruthy();
    await waitFor(() => expect(backend.calls.slice(saved).some((call) => call.path === "/me/security" && call.status === 200)).toBe(true));
    expect(screen.getByTestId("user").textContent).toBe(PERSON.email);
    expect(router.replace).not.toHaveBeenCalled();
  }

  it.each(FACTORS)("does not send the old refresh cookie while a new $factor ends the older sessions", async ({ factor, done, call }) => {
    const backend = installBackend();
    mount();
    const submit = await prepareFirstFactor(factor);
    const oldCookie = backend.jar.refresh;

    // The server commits the enrolment, but its answer (and its new cookie)
    // has not arrived.
    const enrolment = backend.hold(call);
    // A refresh with the old cookie would end its family and delete the
    // cookie. Its answer would arrive after the enrolment answer.
    const lateRefresh = backend.hold("POST /auth/refresh");
    submit();
    await act(async () => { await enrolment.sent; });
    const start = backend.calls.length;

    // App-shell polling: the old access token is refused now, so the API
    // client wants a refresh.
    const poll = fetchMySecurity();
    await waitFor(() => expect(backend.calls.slice(start).some((c) => c.path === "/me/security" && c.status === 401)).toBe(true));
    await wait(50);
    expect(backend.calls.slice(start).filter((c) => c.path === "/auth/refresh")).toEqual([]);

    await act(async () => {
      enrolment.release();
      lateRefresh.release();
      await expect(poll).resolves.toMatchObject(factor === "passkey" ? { passkeyCount: 1 } : { totpEnabled: true });
    });

    // The refresh that waited took the token of the new session and sent
    // nothing: no cookie went out, the old one least of all.
    const after = backend.calls.slice(start);
    expect(after.filter((c) => c.path === "/auth/refresh")).toEqual([]);
    expect(backend.calls.some((c) => c.path === "/auth/refresh" && c.cookie === oldCookie && c.status === 403)).toBe(false);
    // The poll, and the page after the enrolment, use the new session's token.
    const [refused, ...retried] = after.filter((c) => c.path === "/me/security");
    expect(refused.status).toBe(401);
    expect(retried.length).toBeGreaterThan(0);
    expect(retried.every((c) => c.token === backend.lastIssued() && c.status === 200)).toBe(true);
    expect(backend.jar.refresh).toBe(backend.currentCookie());

    // The person stays signed in and keeps the codes.
    expect((await screen.findByRole("list", { name: "Recovery codes" })).textContent).toContain(CODES[0]);
    expect(screen.getByTestId("user").textContent).toBe(PERSON.email);
    expect(router.replace).not.toHaveBeenCalled();
    // The cookie of the new session still works.
    await saveCodesLater(backend, done);
  });

  it.each(FACTORS)("sends a new $factor only after the answer of a refresh on the wire", async ({ factor, done, call }) => {
    const backend = installBackend();
    mount();
    const submit = await prepareFirstFactor(factor);

    // A refresh is on the wire. Its answer rotates the cookie of the old
    // session. If it arrived after the enrolment answer, it would replace the
    // new session's cookie with one of the older security version.
    const refresh = backend.hold("POST /auth/refresh");
    let refreshed: Promise<string | null> | null = null;
    act(() => { refreshed = refreshAccessToken(); });
    await act(async () => { await refresh.sent; });

    const start = backend.calls.length;
    submit();
    if (factor === "passkey") {
      await waitFor(() => expect(backend.calls.slice(start).some((c) => c.path === "/me/security/passkeys/options")).toBe(true));
    }
    await wait(50);
    expect(backend.calls.slice(start).filter((c) => `${c.method} ${c.path}` === call)).toEqual([]);

    await act(async () => {
      refresh.release();
      await refreshed;
    });
    expect((await screen.findByRole("list", { name: "Recovery codes" })).textContent).toContain(CODES[0]);
    expect(backend.calls.slice(start).filter((c) => `${c.method} ${c.path}` === call).map((c) => c.status)).toEqual([200]);
    expect(backend.jar.refresh).toBe(backend.currentCookie());
    await saveCodesLater(backend, done);
  });

  // The gate is per tab. Another tab of the same browser has its own API
  // client, but the same cookie jar.
  it.each(FACTORS)("keeps the session of a new $factor when another tab refreshes with the old cookie", async ({ factor, done, call }) => {
    const backend = installBackend();
    mount();
    const submit = await prepareFirstFactor(factor);
    const oldCookie = backend.jar.refresh;

    const enrolment = backend.hold(call);
    submit();
    await act(async () => { await enrolment.sent; });

    // The other tab sends the cookie that the browser has now: the old one.
    // The server ends that family and answers 403, after this tab's answer.
    const otherTab = backend.hold("POST /auth/refresh");
    const otherRefresh = fetch(`${API_URL}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      credentials: "include"
    });
    await act(async () => { await otherTab.sent; });
    await act(async () => { enrolment.release(); });
    expect((await screen.findByRole("list", { name: "Recovery codes" })).textContent).toContain(CODES[0]);
    expect(backend.jar.refresh).toBe(backend.currentCookie());

    await act(async () => {
      otherTab.release();
      expect((await otherRefresh).status).toBe(403);
    });
    expect(backend.calls.filter((c) => c.path === "/auth/refresh" && c.cookie === oldCookie).map((c) => c.status)).toEqual([403]);
    // The 403 did not delete the new session's cookie.
    expect(backend.jar.refresh).toBe(backend.currentCookie());
    expect(screen.getByTestId("user").textContent).toBe(PERSON.email);
    await saveCodesLater(backend, done);
  });
});


describe("refresh recovery with the shared cookie jar", () => {
  it.each(["token_revoked", "session_revoked"])("retries %s with the newer cookie once", async (code) => {
    const backend = installBackend();
    mount();
    await waitFor(() => expect(screen.getByTestId("user").textContent).toBe(PERSON.email));
    backend.revokeInOtherTab(code);
    const held = backend.hold("POST /auth/refresh");
    const start = backend.calls.length;
    let refresh!: Promise<string | null>;
    act(() => { refresh = refreshAccessToken(); });
    await act(async () => { await held.sent; });
    backend.replaceInOtherTab();
    await act(async () => { held.release(); await refresh; });
    expect(backend.calls.slice(start).filter(c => c.path === "/auth/refresh").map(c => c.status)).toEqual([code === "token_revoked" ? 401 : 403, 200]);
    expect(screen.getByTestId("user").textContent).toBe(PERSON.email);
    expect(createApiHeaders().get("Authorization")).toBe(`Bearer ${backend.lastIssued()}`);
  });

  it.each(["token_revoked", "session_revoked"])("stops after a second %s refusal", async (code) => {
    const backend = installBackend();
    mount();
    await waitFor(() => expect(screen.getByTestId("user").textContent).toBe(PERSON.email));
    backend.revokeInOtherTab(code);
    const start = backend.calls.length;
    await act(async () => { await refreshAccessToken(); });
    expect(backend.calls.slice(start).filter(c => c.path === "/auth/refresh")).toHaveLength(2);
    expect(screen.getByTestId("user").textContent).toBe("none");
  });

  it("signs out while a refresh answer is held and drops its late cookie", async () => {
    const backend = installBackend();
    mount();
    await waitFor(() => expect(screen.getByTestId("user").textContent).toBe(PERSON.email));
    const start = backend.calls.length;
    const held = backend.hold("POST /auth/refresh");
    let refresh!: Promise<string | null>;
    act(() => { refresh = refreshAccessToken(); });
    await act(async () => { await held.sent; });
    fireEvent.click(screen.getByRole("button", { name: "Test sign out" }));
    await waitFor(() => expect(backend.jar.refresh).toBeNull());
    expect(backend.calls.slice(start).some(c => c.path === "/auth/logout")).toBe(true);
    await act(async () => { held.release(); await refresh; });
    expect(backend.jar.refresh).toBeNull();
    expect(screen.getByTestId("user").textContent).toBe("none");
  });

  it("retries a held refresh inside the server cache window", async () => {
    const backend = installBackend();
    mount();
    await waitFor(() => expect(screen.getByTestId("user").textContent).toBe(PERSON.email));
    const start = backend.calls.length;
    const held = backend.hold("POST /auth/refresh");
    let refresh!: Promise<string | null>;
    act(() => { refresh = refreshAccessToken(); });
    await act(async () => { await held.sent; });
    await wait(REFRESH_TIME_LIMIT_MS + 1);
    await act(async () => { await refresh; held.release(); });
    expect(backend.calls.slice(start).filter(c => c.path === "/auth/refresh").map(c => c.status)).toEqual([200, 200]);
    expect(screen.getByTestId("user").textContent).toBe(PERSON.email);
  });
});
