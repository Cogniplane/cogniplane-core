// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { API_URL } from "../../../lib/api-client";

const routerReplace = vi.hoisted(() => vi.fn());
const searchParams = vi.hoisted(() => new URLSearchParams({ code: "wc-1", state: "st-1" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: routerReplace }),
  useSearchParams: () => searchParams
}));

const login = vi.hoisted(() => vi.fn());
const completeLogin = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../../../lib/auth-context", () => ({
  useAuth: () => ({ completeLogin, login })
}));

import AuthCallbackPage from "./page";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  routerReplace.mockClear();
  completeLogin.mockReset().mockResolvedValue(true);
  login.mockReset();
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
    expect(exchanges[0]?.[1]).toMatchObject({ method: "POST", credentials: "include" });
    expect(JSON.parse(exchanges[0]?.[1]?.body as string)).toEqual({ code: "wc-1", state: "st-1" });
    expect(completeLogin).toHaveBeenCalledExactlyOnceWith("tok-1");
    expect(screen.queryByText(/Authentication failed/i)).toBeNull();
  });

  it("restarts login with the organization selected after a 409", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "organization_selection_required",
      organizations: [{ id: "org-a", name: "Alpha" }, { id: "org-b", name: "Beta" }]
    }), { status: 409 })));
    login.mockImplementation(() => new Promise(() => {}));
    render(<AuthCallbackPage />);

    const alpha = await screen.findByRole("button", { name: /Alpha/ });
    const beta = screen.getByRole("button", { name: /Beta/ });
    expect(completeLogin).not.toHaveBeenCalled();
    fireEvent.click(beta);

    expect(login).toHaveBeenCalledExactlyOnceWith({ organization: "org-b" });
    expect(alpha.hasAttribute("disabled")).toBe(true);
    expect(beta.hasAttribute("disabled")).toBe(true);
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it("shows a bootstrap error without navigating after a successful code exchange", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ accessToken: "tok-1" }))));
    completeLogin.mockResolvedValue(false);
    render(<AuthCallbackPage />);

    await screen.findByText("Authentication succeeded but user bootstrap failed");
    expect(completeLogin).toHaveBeenCalledExactlyOnceWith("tok-1");
    expect(routerReplace).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Back to login" }).getAttribute("href")).toBe("/login");
  });
});
