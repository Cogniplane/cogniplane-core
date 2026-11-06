// @vitest-environment jsdom
//
// Every frontend call whose answer sets or deletes the refresh cookie holds
// the session-change gate (api-client.ts, changeSession), and its fetch has
// the signal of the gate's time limit. The rows are the backend routes that
// set or delete the cookie (apps/backend/src/routes/auth*.ts), except
// /auth/refresh itself.

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The provider reads this at load. Dev-headers mode would invent an owner.
vi.hoisted(() => { delete process.env.NEXT_PUBLIC_DEV_USER_ID; });
const gate = vi.hoisted(() => ({ held: 0 }));
const navigation = vi.hoisted(() => ({ router: { replace: vi.fn() }, params: new URLSearchParams("code=code-1&state=state-1") }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation.router, useSearchParams: () => navigation.params }));
vi.mock("./passkey-browser", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createPasskey: async () => ({ id: "cred-1", type: "public-key" }),
  assertWithPasskey: async () => ({ id: "cred-1", type: "public-key" })
}));
vi.mock("./api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api-client")>();
  return {
    ...actual,
    // Counts the time in which `send` runs, inside the real gate.
    changeSession: vi.fn((...[send, install]: Parameters<typeof actual.changeSession>) =>
      actual.changeSession(async (request, signal) => {
        gate.held += 1;
        try {
          return await send(request, signal);
        } finally {
          gate.held -= 1;
        }
      }, install)
    )
  };
});

import AuthCallbackPage from "../app/auth/callback/page";
import { __resetSessionGateForTests, changeSession, getAccessToken, setAccessToken } from "./api-client";
import { __resetCodeExchangesForTests } from "./auth-callback-exchange";
import { AuthProvider, useAuth } from "./auth-context";
import {
  addMyPasskey,
  changeMyPassword,
  completeAccountSetup,
  confirmMyTotp,
  confirmSignInEnrollment,
  enrollPasskeyInSignIn,
  removeMyPasskey,
  removeMyTotp,
  signInWithPasskey,
  signInWithPassword,
  signOutEverywhere,
  submitPasskeySecondFactor,
  submitTotpCode
} from "./local-auth-api";

const USER = { userId: "u-1", email: "person@example.test", displayName: "Person", tenantId: "t-1", role: "member" };
const SESSION = { accessToken: "tok-new", user: USER };
const PASSKEY = { id: "cred-1", name: "Laptop", createdAt: "2026-10-01T00:00:00.000Z", lastUsedAt: null, backedUp: true };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Sent = { call: string; gated: boolean; signal: boolean };
let sent: Sent[] = [];

function answer(call: string): Response {
  if (call.endsWith("/options")) return json(200, { options: { challenge: "challenge" }, challengeId: "challenge-1" });
  switch (call) {
    case "POST /auth/refresh":
      return json(401, { error: "missing_refresh_token" });
    case "GET /auth/me":
      return json(200, USER);
    case "POST /auth/callback":
      return json(200, { accessToken: "tok-new" });
    case "POST /me/security/passkeys/verify":
      return json(200, { passkey: PASSKEY, ...SESSION, recoveryCodes: ["AAAA"] });
    case "POST /auth/local/enroll/totp/confirm":
    case "POST /auth/local/enroll/passkey/verify":
    case "POST /me/security/totp/confirm":
      return json(200, { ...SESSION, recoveryCodes: ["AAAA"] });
    case "POST /me/security/sessions/revoke":
    case "POST /auth/logout":
      return json(200, { ok: true });
    default:
      return json(200, SESSION);
  }
}

type AuthApi = ReturnType<typeof useAuth>;
let auth: AuthApi | null = null;
function Probe({ onReady }: { onReady: (value: AuthApi) => void }) {
  onReady(useAuth());
  return null;
}

async function signedOutProvider(children: React.ReactNode) {
  render(<AuthProvider><Probe onReady={(value) => { auth = value; }} />{children}</AuthProvider>);
  // The boot refresh finds no session.
  await waitFor(() => expect(auth?.isLoading).toBe(false));
}

type Row = {
  name: string;
  /** The call whose answer sets or deletes the refresh cookie. */
  call: string;
  run: () => Promise<unknown>;
  /** The token in memory after the call. */
  token: string | null;
};

const ROWS: Row[] = [
  { name: "password sign-in", call: "POST /auth/local/login", run: () => signInWithPassword("person@example.test", "password"), token: "tok-old" },
  { name: "account setup link", call: "POST /auth/local/setup", run: () => completeAccountSetup("link-1", "password"), token: "tok-old" },
  { name: "authenticator code at sign-in", call: "POST /auth/local/mfa/totp", run: () => submitTotpCode("123456"), token: "tok-old" },
  { name: "authenticator enrolment at sign-in", call: "POST /auth/local/enroll/totp/confirm", run: () => confirmSignInEnrollment("123456"), token: "tok-old" },
  { name: "passwordless passkey sign-in", call: "POST /auth/passkey/login/verify", run: () => signInWithPasskey(), token: "tok-old" },
  { name: "passkey second factor at sign-in", call: "POST /auth/local/mfa/passkey/verify", run: () => submitPasskeySecondFactor(), token: "tok-old" },
  { name: "passkey enrolment at sign-in", call: "POST /auth/local/enroll/passkey/verify", run: () => enrollPasskeyInSignIn(), token: "tok-old" },
  { name: "password change", call: "POST /me/security/password", run: () => changeMyPassword("old", "new password here"), token: "tok-new" },
  { name: "authenticator app confirm", call: "POST /me/security/totp/confirm", run: () => confirmMyTotp("123456"), token: "tok-new" },
  { name: "authenticator app removal", call: "DELETE /me/security/totp", run: () => removeMyTotp("step-up-1"), token: "tok-new" },
  { name: "first passkey", call: "POST /me/security/passkeys/verify", run: () => addMyPasskey("Laptop", "step-up-1"), token: "tok-new" },
  { name: "passkey removal", call: "DELETE /me/security/passkeys/cred-1", run: () => removeMyPasskey("cred-1", "step-up-1"), token: "tok-new" },
  { name: "sign out everywhere", call: "POST /me/security/sessions/revoke", run: () => signOutEverywhere(), token: null },
  {
    name: "logout",
    call: "POST /auth/logout",
    run: async () => {
      await signedOutProvider(null);
      await act(async () => { await auth!.logout(); });
    },
    token: null
  },
  {
    name: "WorkOS callback",
    call: "POST /auth/callback",
    run: async () => {
      setAccessToken(null);
      await signedOutProvider(<AuthCallbackPage />);
      await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/"));
    },
    token: "tok-new"
  }
];

beforeEach(() => {
  __resetSessionGateForTests();
  __resetCodeExchangesForTests();
  window.sessionStorage.clear();
  setAccessToken("tok-old");
  sent = [];
  auth = null;
  vi.mocked(changeSession).mockClear();
  navigation.router.replace.mockClear();
  Object.defineProperty(window, "location", { configurable: true, value: { href: "http://localhost:3000/", protocol: "http:" } });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = `${init?.method ?? "GET"} ${new URL(String(input)).pathname}`;
    sent.push({ call, gated: gate.held > 0, signal: init?.signal instanceof AbortSignal });
    return answer(call);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  __resetSessionGateForTests();
});

describe("calls that set or delete the refresh cookie", () => {
  it("has one row for each of the 15 calls", () => {
    expect(new Set(ROWS.map((row) => row.call)).size).toBe(15);
  });

  it.each(ROWS)("$name holds the session-change gate", async ({ call, run, token }) => {
    await run();

    const changes = sent.filter((request) => request.call === call);
    // Also the WorkOS callback, whose page mounts again when the person is
    // set: its single-use code is sent once.
    expect(changes).toHaveLength(1);
    expect(changes.every((request) => request.gated && request.signal)).toBe(true);
    expect(changeSession).toHaveBeenCalledTimes(1);
    // Only that call holds the gate: options, /auth/me and refreshes do not.
    expect(sent.filter((request) => request.call !== call).every((request) => !request.gated)).toBe(true);
    expect(getAccessToken()).toBe(token);
  });
});
