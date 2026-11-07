// @vitest-environment jsdom
//
// The callback page inside the real AuthProvider. completeLogin sets the
// person, which changes the key of the provider's QueryProvider, so the page mounts again
// while the sign-in completes. The backend model refuses every exchange after
// the first, as the real one does: the first exchange clears the state cookie.

import { cleanup, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The provider reads this at load. Dev-headers mode would invent an owner.
vi.hoisted(() => { delete process.env.NEXT_PUBLIC_DEV_USER_ID; });
const navigation = vi.hoisted(() => ({ router: { replace: vi.fn() }, params: new URLSearchParams("code=code-1&state=state-1") }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation.router, useSearchParams: () => navigation.params }));

import AuthCallbackPage from "./page";
import { __resetSessionGateForTests } from "../../../lib/api-client";
import { __resetCodeExchangesForTests } from "../../../lib/auth-callback-exchange";
import { AuthProvider } from "../../../lib/auth-context";

const PERSON = { userId: "u-1", email: "person@example.test", displayName: "Person", tenantId: "t-1", role: "member" };
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Counts the mounts of the provider's children. */
let childMounts = 0;
function MountCounter() {
  useEffect(() => {
    childMounts += 1;
  }, []);
  return null;
}

beforeEach(() => {
  __resetSessionGateForTests();
  __resetCodeExchangesForTests();
  window.sessionStorage.clear();
  navigation.router.replace.mockClear();
  childMounts = 0;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  __resetSessionGateForTests();
});

describe("WorkOS callback page in the AuthProvider", () => {
  it("sends the code once and shows no error while the page mounts again", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = `${init?.method ?? "GET"} ${new URL(String(input)).pathname}`;
      calls.push(call);
      switch (call) {
        case "POST /auth/refresh":
          return json(401, { error: "missing_refresh_token" });
        case "POST /auth/callback":
          return calls.filter((sent) => sent === call).length === 1
            ? json(200, { accessToken: "tok-new" })
            : json(400, { error: "invalid_state" });
        case "GET /auth/me":
          return json(200, PERSON);
        default:
          return json(404, { error: "unexpected_call" });
      }
    }));
    const shown = new Set<string>();
    const observer = new MutationObserver(() => shown.add(document.body.textContent ?? ""));
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    render(
      <AuthProvider>
        <MountCounter />
        <AuthCallbackPage />
      </AuthProvider>
    );

    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/"));
    // Lets a second exchange, if one was sent, answer and render.
    await new Promise((resolve) => setTimeout(resolve, 20));
    observer.disconnect();
    // The page did mount again when the person was set.
    expect(childMounts).toBe(2);
    expect(calls.filter((call) => call === "POST /auth/callback")).toHaveLength(1);
    // The first page can navigate before React unmounts it, and the page
    // that mounts again then gets the same outcome: both go home.
    expect(navigation.router.replace.mock.calls.every(([path]) => path === "/")).toBe(true);
    expect([...shown].join("\n")).not.toMatch(/invalid_state|Authentication failed|Authentication request failed/);
  });
});
