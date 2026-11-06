// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { API_URL } from "../../../lib/api-client";
import { __resetCodeExchangesForTests, exchangeCodeOnce } from "../../../lib/auth-callback-exchange";

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
  // Each test is a new tab that has not used the code.
  __resetCodeExchangesForTests();
  window.sessionStorage.clear();
});

const signedIn = () => new Response(JSON.stringify({ accessToken: "tok-1" }), { status: 200, headers: { "Content-Type": "application/json" } });
// The first exchange cleared the state cookie, so a second one is refused.
const usedCode = () => new Response(JSON.stringify({ error: "invalid_state" }), { status: 400, headers: { "Content-Type": "application/json" } });
const exchangesOf = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(([input]) => String(input).startsWith(`${API_URL}/auth/callback`));

/** Records every text that the page showed, also for a moment only. */
function recordShownText() {
  const shown = new Set<string>();
  const observer = new MutationObserver(() => shown.add(document.body.textContent ?? ""));
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  return { shown: () => [...shown].join("\n"), stop: () => observer.disconnect() };
}

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
    expect(completeLogin).toHaveBeenCalledExactlyOnceWith("tok-1", expect.any(Number));
    expect(screen.queryByText(/Authentication failed/i)).toBeNull();
    // Only the page that is still mounted navigates.
    expect(routerReplace).toHaveBeenCalledTimes(1);
  });

  // The AuthProvider mounts the page again when completeLogin sets the
  // person (Beads issue q4w0.14).
  it("shares the exchange with a page that mounts again during the sign-in, with no error shown", async () => {
    const fetchMock = vi.fn(async (): Promise<Response> => (exchangesOf(fetchMock).length > 1 ? usedCode() : signedIn()));
    vi.stubGlobal("fetch", fetchMock);
    let finishLogin!: (ok: boolean) => void;
    completeLogin.mockImplementation(() => new Promise<boolean>((resolve) => { finishLogin = resolve; }));
    const text = recordShownText();

    const first = render(<AuthCallbackPage />);
    await waitFor(() => expect(completeLogin).toHaveBeenCalledTimes(1));
    first.unmount();
    render(<AuthCallbackPage />);
    await act(async () => { finishLogin(true); });

    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith("/"));
    text.stop();
    expect(exchangesOf(fetchMock)).toHaveLength(1);
    expect(completeLogin).toHaveBeenCalledTimes(1);
    expect(routerReplace).toHaveBeenCalledTimes(1);
    expect(text.shown()).not.toMatch(/invalid_state|Authentication failed|Authentication request failed/);
  });

  it.each([
    ["after a reload during the exchange", false],
    ["when history shows the page again after the sign-in", true]
  ])("does not send the code again in a new page load of the tab %s", async (_name, firstEnded) => {
    const fetchMock = vi.fn(async (): Promise<Response> => (exchangesOf(fetchMock).length > 1 ? usedCode() : signedIn()));
    vi.stubGlobal("fetch", fetchMock);
    if (!firstEnded) completeLogin.mockImplementation(() => new Promise<boolean>(() => {}));
    render(<AuthCallbackPage />);
    await waitFor(() => expect(completeLogin).toHaveBeenCalledTimes(1));
    if (firstEnded) await waitFor(() => expect(routerReplace).toHaveBeenCalledTimes(1));
    cleanup();
    routerReplace.mockClear();

    // A new document: the module state is gone, sessionStorage stays.
    __resetCodeExchangesForTests();
    const text = recordShownText();
    render(<AuthCallbackPage />);

    await waitFor(() => expect(routerReplace).toHaveBeenCalledExactlyOnceWith("/"));
    text.stop();
    expect(exchangesOf(fetchMock)).toHaveLength(1);
    expect(text.shown()).not.toMatch(/invalid_state|Authentication failed|Authentication request failed/);
  });

  it("exchanges a new code of the same tab", async () => {
    const fetchMock = vi.fn(async () => signedIn());
    vi.stubGlobal("fetch", fetchMock);
    window.sessionStorage.setItem("cogniplane_used_auth_code", "an-older-code");

    render(<AuthCallbackPage />);

    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith("/"));
    expect(exchangesOf(fetchMock)).toHaveLength(1);
    expect(completeLogin).toHaveBeenCalledExactlyOnceWith("tok-1", expect.any(Number));
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
    // The other choice waits; the chosen one keeps focus with aria-disabled and ignores repeats.
    expect(alpha.hasAttribute("disabled")).toBe(true);
    expect(beta.hasAttribute("disabled")).toBe(false);
    expect(beta.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(beta);
    fireEvent.click(alpha);
    expect(login).toHaveBeenCalledTimes(1);
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it.each([
    ["no_organization", "Ask your administrator to invite you."],
    ["wrong_login_type", "sign in with your password"]
  ])("explains a %s failure that a new sign-in does not fix", async (code, text) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: code }), { status: 403 })));
    render(<AuthCallbackPage />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(text);
    expect(alert.textContent).not.toMatch(/start a new sign-in/i);
  });

  it("shows a bootstrap error without navigating after a successful code exchange", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ accessToken: "tok-1" }))));
    completeLogin.mockResolvedValue(false);
    render(<AuthCallbackPage />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/start a new sign-in/i);
    // The reason stays visible, so the user and support can see why it failed.
    expect(alert.textContent).toContain("Authentication succeeded but user bootstrap failed");
    expect(completeLogin).toHaveBeenCalledExactlyOnceWith("tok-1", expect.any(Number));
    expect(routerReplace).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Back to sign-in" }).getAttribute("href")).toBe("/login");
  });
});


it("keeps older codes used after another sign-in and a document reload", async () => {
  const fetchMock = vi.fn(async () => signedIn());
  vi.stubGlobal("fetch", fetchMock);
  await exchangeCodeOnce("old-code", "state", completeLogin);
  await exchangeCodeOnce("new-code", "state", completeLogin);
  __resetCodeExchangesForTests();
  expect(await exchangeCodeOnce("old-code", "state", completeLogin)).toEqual({ kind: "already_used" });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("announces a rejected organization restart and retries login without exchanging the consumed code", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "organization_selection_required", organizations: [{ id: "synthetic-org-a", name: "Sample Alpha" }, { id: "synthetic-org-b", name: "Sample Beta" }] }), { status: 409 }));
  vi.stubGlobal("fetch", fetchMock);
  login.mockRejectedValueOnce(new Error("Synthetic unavailable")).mockImplementation(() => new Promise(() => {}));
  render(<AuthCallbackPage />);
  const alpha = await screen.findByRole("button", { name: /Sample Alpha/ });
  alpha.focus();
  fireEvent.click(alpha);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toMatch(/could not start.*try again/i);
  // The failure sits beside the chosen organization, which keeps focus.
  expect(alpha.getAttribute("aria-describedby")).toBe(alert.id);
  expect(alpha.closest("li")?.contains(alert)).toBe(true);
  expect(document.activeElement).toBe(alpha);
  const beta = screen.getByRole("button", { name: /Sample Beta/ });
  expect(beta.hasAttribute("disabled")).toBe(false);
  fireEvent.click(beta);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("status").textContent).toMatch(/selected organization/i);
  expect(beta.getAttribute("aria-busy")).toBe("true");
  expect(login).toHaveBeenNthCalledWith(1, { organization: "synthetic-org-a" });
  expect(login).toHaveBeenNthCalledWith(2, { organization: "synthetic-org-b" });
  expect(exchangesOf(fetchMock)).toHaveLength(1);
  expect(completeLogin).not.toHaveBeenCalled();
});
