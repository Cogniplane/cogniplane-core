// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { API_URL } from "../../../lib/api-client";

const routerReplace = vi.hoisted(() => vi.fn());
const searchParams = vi.hoisted(() => new URLSearchParams({ code: "wc-1", state: "st-1" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: routerReplace }),
  useSearchParams: () => searchParams
}));

const completeLogin = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../../../lib/auth-context", () => ({
  useAuth: () => ({ completeLogin, login: vi.fn() })
}));

import AuthCallbackPage from "./page";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  routerReplace.mockClear();
  completeLogin.mockClear();
});

describe("auth callback page", () => {
  it("exchanges the authorization code exactly once under StrictMode", async () => {
    // A WorkOS code is single-use. StrictMode replays the mount effect, so
    // without a latch the second exchange fails and the page reports
    // "Authentication failed" on a sign-in that actually worked.
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ accessToken: "tok-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <StrictMode>
        <AuthCallbackPage />
      </StrictMode>
    );

    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith("/"));

    const exchanges = fetchMock.mock.calls.filter(([input]) =>
      String(input).startsWith(`${API_URL}/auth/callback`)
    );
    expect(exchanges).toHaveLength(1);
    expect(completeLogin).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Authentication failed/i)).toBeNull();
  });
});
