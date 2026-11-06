// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { toast } from "sonner";

import { __resetSessionGateForTests, API_URL, changeSession, createApiHeaders, getAccessToken, getSessionEpoch } from "./api-client";
import { AuthProvider, useAuth } from "./auth-context";
import { useAgentBehaviorDraftStore } from "../components/agent-behavior-draft-provider";
import { COMPOSER_DRAFT_STORAGE_KEY, saveComposerDraft } from "../components/composer-drafts.logic";
import { DRAFT_STORAGE_KEY, saveSessionDrafts } from "../components/generative-ui-drafts.logic";
import { buildDraft } from "../components/tenant-settings-form.logic";
import { makeTenantSettings } from "../test-helpers/tenant-settings";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

// vitest runs with globals:false, so RTL cannot auto-register its cleanup.
afterEach(cleanup);
// The API client keeps the session and its gate in module state.
beforeEach(() => {
  __resetSessionGateForTests();
});

type AuthApi = ReturnType<typeof useAuth>;
type DraftStore = NonNullable<ReturnType<typeof useAgentBehaviorDraftStore>>;

// Surfaces the context so a test can call refreshToken()/login() directly and
// read back what the provider decided about the session.
function Probe({ onReady, onDraftReady }: { onReady: (auth: AuthApi) => void; onDraftReady?: (store: DraftStore) => void }) {
  const auth = useAuth();
  const store = useAgentBehaviorDraftStore();
  onReady(auth);
  if (store) onDraftReady?.(store);
  return <div data-testid="user">{auth.user ? auth.user.email : "none"}</div>;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html" } });
}

const token = (label: string) => `header.${btoa(JSON.stringify({ sub: "u-1", tid: "t-1", label }))}.signature`;

const SIGNED_IN_USER = {
  userId: "u-1",
  email: "member@example.com",
  displayName: "Member",
  tenantId: "t-1",
  role: "member" as const
};

/**
 * Mounts the provider with a signed-in session already bootstrapped: the mount
 * effect's /auth/refresh + /auth/me both succeed. Returns the latest context
 * value plus the fetch mock, which is then re-programmed per test.
 */
async function renderSignedIn() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith(`${API_URL}/auth/refresh`)) {
      return jsonResponse(200, { accessToken: "tok-boot" });
    }
    if (url.startsWith(`${API_URL}/auth/me`)) {
      return jsonResponse(200, SIGNED_IN_USER);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  let auth: AuthApi | null = null;
  let draftStore: DraftStore | null = null;
  render(
    <AuthProvider>
      <Probe
        onDraftReady={(store) => { draftStore = store; }}
        onReady={(value) => {
          auth = value;
        }}
      />
    </AuthProvider>
  );

  await waitFor(() => expect(screen.getByTestId("user").textContent).toBe(SIGNED_IN_USER.email));
  fetchMock.mockReset();
  return { getAuth: () => auth as AuthApi, getDraftStore: () => draftStore as DraftStore, fetchMock };
}

describe("Agent behavior draft identity boundary", () => {
  it.each(["organization", "person", "revoked session"])("clears the draft after a change to %s", async (change) => {
    const { getAuth, getDraftStore, fetchMock } = await renderSignedIn();
    const baseline = makeTenantSettings({ tenantId: SIGNED_IN_USER.tenantId });
    const draft = { ...buildDraft(baseline), developerInstructions: "Unfinished organization instructions" };
    getDraftStore().write({ baseline, draft });
    expect(getDraftStore().read()?.draft.developerInstructions).toBe(draft.developerInstructions);

    if (change === "revoked session") {
      fetchMock.mockResolvedValue(jsonResponse(401, { error: "invalid_refresh_token" }));
      await act(async () => { await getAuth().refreshToken(); });
    } else {
      fetchMock.mockResolvedValue(jsonResponse(200, {
        ...SIGNED_IN_USER,
        ...(change === "organization" ? { tenantId: "t-2" } : { userId: "u-2" })
      }));
      await act(async () => { await getAuth().completeLogin("new-token"); });
    }
    expect(getDraftStore().read()).toBeNull();

    fetchMock.mockResolvedValue(jsonResponse(200, SIGNED_IN_USER));
    await act(async () => { await getAuth().completeLogin("back-to-first-identity"); });
    expect(getDraftStore().read()).toBeNull();
  });

  it("keeps the draft when refreshing the same signed-in session", async () => {
    const { getAuth, getDraftStore, fetchMock } = await renderSignedIn();
    const baseline = makeTenantSettings({ tenantId: SIGNED_IN_USER.tenantId });
    const draft = { ...buildDraft(baseline), developerInstructions: "Keep this draft" };
    getDraftStore().write({ baseline, draft });
    fetchMock.mockResolvedValue(jsonResponse(200, { accessToken: token("refreshed-token") }));
    await act(async () => { await getAuth().refreshToken(); });
    expect(getDraftStore().read()?.draft).toBe(draft);
  });
});

// Composer text and generated-view edits end with the signed-in session.
describe.each(["generated UI", "composer"])("%s draft identity boundary", (kind) => {
  const seed = () => kind === "composer" ? saveComposerDraft({ userId: SIGNED_IN_USER.userId, tenantId: SIGNED_IN_USER.tenantId },
    "s-1", { text: "Unsent words", written: null }) : saveSessionDrafts(window.sessionStorage, { userId: SIGNED_IN_USER.userId, tenantId: SIGNED_IN_USER.tenantId },
    "s-1", { form: { target: "side-panel", count: 1, digest: "d", values: { "/notes": "Unsent words" } } }, 1);
  const stored = () => window.sessionStorage.getItem(kind === "composer" ? COMPOSER_DRAFT_STORAGE_KEY : DRAFT_STORAGE_KEY);
  afterEach(() => window.sessionStorage.clear());

  it.each(["organization", "person", "revoked session"])("clears the drafts after a change to %s", async (change) => {
    const { getAuth, fetchMock } = await renderSignedIn();
    expect(seed()).toBe("ok");
    expect(stored()).toContain("Unsent words");

    if (change === "revoked session") {
      fetchMock.mockResolvedValue(jsonResponse(401, { error: "invalid_refresh_token" }));
      await act(async () => { await getAuth().refreshToken(); });
    } else {
      fetchMock.mockResolvedValue(jsonResponse(200, {
        ...SIGNED_IN_USER,
        ...(change === "organization" ? { tenantId: "t-2" } : { userId: "u-2" })
      }));
      await act(async () => { await getAuth().completeLogin("new-token"); });
    }
    expect(stored()).toBeNull();
  });

  it("clears the drafts at sign-out", async () => {
    Object.defineProperty(window, "location", { configurable: true, value: { href: "http://localhost:3000/", protocol: "http:" } });
    const { getAuth, fetchMock } = await renderSignedIn();
    seed();
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    await act(async () => { await getAuth().logout(); });
    expect(stored()).toBeNull();
  });

  it("keeps the drafts when sign-out fails, and when the same session refreshes", async () => {
    const { getAuth, fetchMock } = await renderSignedIn();
    seed();
    fetchMock.mockResolvedValue(jsonResponse(200, { accessToken: token("refreshed-token") }));
    await act(async () => { await getAuth().refreshToken(); });
    expect(stored()).toContain("Unsent words");

    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await act(async () => { await getAuth().logout(); });
    expect(stored()).toContain("Unsent words");
  });

  it.each([403, 429, 500])("keeps the drafts when sign-out answers %i", async (status) => {
    const { getAuth, fetchMock } = await renderSignedIn();
    seed();
    fetchMock.mockResolvedValue(jsonResponse(status, { error: "sign_out_failed" }));
    await act(async () => { await getAuth().logout(); });
    expect(stored()).toContain("Unsent words");
  });
});

it.each([false, true])("clears a saved composer draft when initial authentication is revoked, token present: %s", async (hasToken) => {
  saveComposerDraft({ userId: SIGNED_IN_USER.userId, tenantId: SIGNED_IN_USER.tenantId }, "s-1", { text: "Unsent words", written: null });
  if (hasToken) await changeSession(async () => ({ accessToken: token("initial") }), (answer) => answer.accessToken);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { error: "invalid_refresh_token" })));
  render(<AuthProvider><Probe onReady={() => {}} /></AuthProvider>);
  await waitFor(() => expect(window.sessionStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY)).toBeNull());
});

beforeEach(() => {
  document.cookie = "cogniplane_session_hint=1; Path=/";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AuthProvider.refreshToken — what counts as a revoked session", () => {
  it("signs the user out on 401", async () => {
    const { getAuth, fetchMock } = await renderSignedIn();
    fetchMock.mockResolvedValue(jsonResponse(401, { error: "invalid_refresh_token" }));

    await act(async () => {
      expect(await getAuth().refreshToken()).toBeNull();
    });

    expect(screen.getByTestId("user").textContent).toBe("none");
    expect(document.cookie).not.toContain("cogniplane_session_hint=1");
  });

  it("signs the user out on a 403 that means they lost membership", async () => {
    const { getAuth, fetchMock } = await renderSignedIn();
    fetchMock.mockResolvedValue(jsonResponse(403, { error: "not_a_member" }));

    await act(async () => {
      expect(await getAuth().refreshToken()).toBeNull();
    });

    expect(screen.getByTestId("user").textContent).toBe("none");
  });

  it("keeps the user signed in on a 403 from the CSRF origin check", async () => {
    // The route rejects on Origin before it reads the refresh cookie, so this
    // says nothing about whether the session is still valid.
    const { getAuth, fetchMock } = await renderSignedIn();
    fetchMock.mockResolvedValue(jsonResponse(403, { error: "csrf_origin_mismatch" }));

    await act(async () => {
      expect(await getAuth().refreshToken()).toBeNull();
    });

    expect(screen.getByTestId("user").textContent).toBe(SIGNED_IN_USER.email);
    expect(document.cookie).toContain("cogniplane_session_hint=1");
  });

  it("keeps the user signed in on a 502 from the gateway", async () => {
    const { getAuth, fetchMock } = await renderSignedIn();
    fetchMock.mockResolvedValue(textResponse(502, "<html>Bad gateway</html>"));

    await act(async () => {
      expect(await getAuth().refreshToken()).toBeNull();
    });

    expect(screen.getByTestId("user").textContent).toBe(SIGNED_IN_USER.email);
  });

  it("keeps the user signed in when the network throws", async () => {
    const { getAuth, fetchMock } = await renderSignedIn();
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await act(async () => {
      expect(await getAuth().refreshToken()).toBeNull();
    });

    expect(screen.getByTestId("user").textContent).toBe(SIGNED_IN_USER.email);
  });

  it("refuses a malformed 200 instead of installing `undefined` as the token", async () => {
    const { getAuth, fetchMock } = await renderSignedIn();
    fetchMock.mockResolvedValue(jsonResponse(200, { notTheToken: true }));

    await act(async () => {
      expect(await getAuth().refreshToken()).toBeNull();
    });

    // The old session survives; nothing installed a "Bearer undefined".
    expect(getAuth().accessToken).toBe("tok-boot");
    expect(screen.getByTestId("user").textContent).toBe(SIGNED_IN_USER.email);
  });

  it("installs the token from a well-formed 200", async () => {
    const { getAuth, fetchMock } = await renderSignedIn();
    fetchMock.mockResolvedValue(jsonResponse(200, { accessToken: token("tok-2") }));

    await act(async () => {
      expect(await getAuth().refreshToken()).toBe(token("tok-2"));
    });

    expect(getAuth().accessToken).toBe(token("tok-2"));
  });
});

describe("AuthProvider.completeLogin — a refused access token is not yet a lost session", () => {
  // /auth/me accepts only `valid`; /auth/refresh answers with `refresh`.
  function stubSession(fetchMock: ReturnType<typeof vi.fn>, valid: string, refresh: () => Response) {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(`${API_URL}/auth/refresh`)) return refresh();
      if (url.startsWith(`${API_URL}/auth/me`)) {
        return new Headers(init?.headers).get("Authorization") === `Bearer ${valid}`
          ? jsonResponse(200, SIGNED_IN_USER)
          : jsonResponse(401, { error: "invalid_token" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
  }
  const paths = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);

  it("refreshes once and keeps the user when /auth/me refuses an expired token", async () => {
    const { getAuth, fetchMock } = await renderSignedIn();
    stubSession(fetchMock, token("tok-fresh"), () => jsonResponse(200, { accessToken: token("tok-fresh") }));

    let ok: boolean | undefined;
    await act(async () => { ok = await getAuth().completeLogin("tok-expired"); });

    expect(ok).toBe(true);
    expect(screen.getByTestId("user").textContent).toBe(SIGNED_IN_USER.email);
    expect(paths(fetchMock)).toEqual(["/auth/me", "/auth/refresh", "/auth/me"]);
    // The refreshed token replaces the refused one, also for the API client.
    expect(getAuth().accessToken).toBe(token("tok-fresh"));
    expect(createApiHeaders().get("Authorization")).toBe(`Bearer ${token("tok-fresh")}`);
    expect(document.cookie).toContain("cogniplane_session_hint=1");
  });

  it("signs the user out when the refresh after a refused token fails", async () => {
    const { getAuth, fetchMock } = await renderSignedIn();
    stubSession(fetchMock, "tok-none", () => jsonResponse(401, { error: "invalid_refresh_token" }));

    let ok: boolean | undefined;
    await act(async () => { ok = await getAuth().completeLogin("tok-expired"); });

    expect(ok).toBe(false);
    expect(screen.getByTestId("user").textContent).toBe("none");
    expect(paths(fetchMock)).toEqual(["/auth/me", "/auth/refresh"]);
  });

  it("refreshes only once when /auth/me also refuses the refreshed token", async () => {
    const { getAuth, fetchMock } = await renderSignedIn();
    stubSession(fetchMock, "tok-none", () => jsonResponse(200, { accessToken: token("tok-also-refused") }));

    let ok: boolean | undefined;
    await act(async () => { ok = await getAuth().completeLogin("tok-expired"); });

    expect(ok).toBe(false);
    expect(screen.getByTestId("user").textContent).toBe("none");
    expect(paths(fetchMock)).toEqual(["/auth/me", "/auth/refresh", "/auth/me"]);
  });

  it("does not refresh when /auth/me fails for another reason", async () => {
    const { getAuth, fetchMock } = await renderSignedIn();
    fetchMock.mockResolvedValue(jsonResponse(500, { error: "internal" }));

    await act(async () => { await getAuth().completeLogin("tok-new"); });

    expect(paths(fetchMock)).toEqual(["/auth/me"]);
  });
});

describe("AuthProvider.adoptSession", () => {
  it("installs the token of a new session without loading the account again", async () => {
    const { getAuth, fetchMock } = await renderSignedIn();
    document.cookie = "cogniplane_session_hint=; Path=/; Max-Age=0";

    let adopted = false;
    act(() => { adopted = getAuth().adoptSession("tok-enrolled", { ...SIGNED_IN_USER, role: "admin" }); });

    expect(adopted).toBe(true);
    expect(getAuth().accessToken).toBe("tok-enrolled");
    expect(createApiHeaders().get("Authorization")).toBe("Bearer tok-enrolled");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("user").textContent).toBe(SIGNED_IN_USER.email);
    // The role comes from the answer of the account change.
    expect(getAuth().user?.role).toBe("admin");
    expect(document.cookie).toContain("cogniplane_session_hint=1");
  });

  it.each([
    ["another person", { userId: "u-2" }],
    ["another organization", { tenantId: "t-2" }]
  ])("does not take a session for %s", async (_name, change) => {
    const { getAuth } = await renderSignedIn();
    let adopted = true;
    act(() => { adopted = getAuth().adoptSession("tok-other", { ...SIGNED_IN_USER, ...change }); });

    expect(adopted).toBe(false);
    expect(getAuth().accessToken).toBe("tok-boot");
    expect(createApiHeaders().get("Authorization")).toBe("Bearer tok-boot");
    expect(getAuth().user).toEqual(SIGNED_IN_USER);
  });

  // The session-change call installs the token before its gate opens; the
  // epoch then tells whether that session is still the one in memory.
  async function installBySessionChange(token: string) {
    await act(async () => {
      await changeSession(async () => ({ accessToken: token }), (answer) => answer.accessToken);
    });
  }

  it("keeps the newer token of a refresh that renewed the installed session", async () => {
    const { getAuth, fetchMock } = await renderSignedIn();
    await installBySessionChange("tok-enrolled");
    fetchMock.mockResolvedValue(jsonResponse(200, { accessToken: token("tok-renewed") }));
    await act(async () => { expect(await getAuth().refreshToken()).toBe(token("tok-renewed")); });
    const epoch = getSessionEpoch();

    let adopted = false;
    act(() => { adopted = getAuth().adoptSession("tok-enrolled", { ...SIGNED_IN_USER, role: "admin" }); });

    expect(adopted).toBe(true);
    expect(getAuth().accessToken).toBe(token("tok-renewed"));
    expect(createApiHeaders().get("Authorization")).toBe(`Bearer ${token("tok-renewed")}`);
    expect(getSessionEpoch()).toBe(epoch);
    expect(getAuth().user?.role).toBe("admin");
  });

  it("does not take an installed session that a newer session replaced", async () => {
    const { getAuth, fetchMock } = await renderSignedIn();
    await installBySessionChange("tok-enrolled");
    fetchMock.mockResolvedValue(jsonResponse(200, SIGNED_IN_USER));
    await act(async () => { await getAuth().completeLogin("tok-newer"); });

    let adopted = true;
    act(() => { adopted = getAuth().adoptSession("tok-enrolled", SIGNED_IN_USER); });

    expect(adopted).toBe(false);
    expect(getAuth().accessToken).toBe("tok-newer");
    expect(createApiHeaders().get("Authorization")).toBe("Bearer tok-newer");
  });

  it("does not take a session after a sign-out that ran first", async () => {
    const { getAuth, fetchMock } = await renderSignedIn();
    // The session was revoked before the enrolment answer arrived.
    fetchMock.mockResolvedValue(jsonResponse(401, { error: "invalid_refresh_token" }));
    await act(async () => { await getAuth().refreshToken(); });
    expect(screen.getByTestId("user").textContent).toBe("none");

    let adopted = true;
    act(() => { adopted = getAuth().adoptSession("tok-late", SIGNED_IN_USER); });

    expect(adopted).toBe(false);
    expect(getAuth().accessToken).toBeNull();
    expect(createApiHeaders().get("Authorization")).toBeNull();
    expect(document.cookie).not.toContain("cogniplane_session_hint=1");
  });
});

// The writers go through the API client in order (api-client.ts, "The session
// token, in order"): an answer that started before a newer session must not
// replace it.
describe("AuthProvider — a late answer for an older session", () => {
  function pending() {
    let resolve!: (response: Response) => void;
    const promise = new Promise<Response>((done) => { resolve = done; });
    return { promise, resolve };
  }

  // A sign-in, or an account change that the Security page adopts.
  const NEWER_SESSIONS = [
    ["a sign-in", (auth: AuthApi) => auth.completeLogin("tok-new")],
    ["an adopted account change", async (auth: AuthApi) => auth.adoptSession("tok-new", SIGNED_IN_USER)]
  ] as const;

  it.each(NEWER_SESSIONS)("does not end the session of %s on a late 403 from an older refresh", async (_name, start) => {
    const { getAuth, fetchMock } = await renderSignedIn();
    const refresh = pending();
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(`${API_URL}/auth/refresh`)) return refresh.promise;
      if (url.startsWith(`${API_URL}/auth/me`)) return jsonResponse(200, SIGNED_IN_USER);
      throw new Error(`unexpected fetch: ${url}`);
    });

    let refreshed: Promise<string | null> | null = null;
    act(() => { refreshed = getAuth().refreshToken(); });
    await act(async () => { expect(await start(getAuth())).toBe(true); });

    // The older session's family ended: the backend refuses its cookie.
    await act(async () => {
      refresh.resolve(jsonResponse(403, { error: "session_revoked" }));
      expect(await refreshed).toBe("tok-new");
    });

    expect(screen.getByTestId("user").textContent).toBe(SIGNED_IN_USER.email);
    expect(getAuth().accessToken).toBe("tok-new");
    expect(createApiHeaders().get("Authorization")).toBe("Bearer tok-new");
    expect(document.cookie).toContain("cogniplane_session_hint=1");
  });

  it("does not replace a newer session with the token of a late older refresh", async () => {
    const { getAuth, fetchMock } = await renderSignedIn();
    const refresh = pending();
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(`${API_URL}/auth/refresh`)) return refresh.promise;
      if (url.startsWith(`${API_URL}/auth/me`)) return jsonResponse(200, SIGNED_IN_USER);
      throw new Error(`unexpected fetch: ${url}`);
    });

    let refreshed: Promise<string | null> | null = null;
    act(() => { refreshed = getAuth().refreshToken(); });
    await act(async () => { await getAuth().completeLogin("tok-new"); });
    await act(async () => {
      refresh.resolve(jsonResponse(200, { accessToken: "tok-old-session" }));
      expect(await refreshed).toBe("tok-new");
    });

    expect(getAuth().accessToken).toBe("tok-new");
    expect(createApiHeaders().get("Authorization")).toBe("Bearer tok-new");
  });

  it("does not take the person of a late /auth/me from an older sign-in", async () => {
    const { getAuth, fetchMock } = await renderSignedIn();
    const OTHER = { ...SIGNED_IN_USER, userId: "u-2", email: "other@example.com" };
    const older = pending();
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const bearer = new Headers(init?.headers).get("Authorization");
      if (bearer === "Bearer tok-older") return older.promise;
      if (bearer === "Bearer tok-newer") return jsonResponse(200, OTHER);
      throw new Error(`unexpected fetch: ${bearer}`);
    });

    let first: Promise<boolean> | null = null;
    act(() => { first = getAuth().completeLogin("tok-older"); });
    await act(async () => { expect(await getAuth().completeLogin("tok-newer")).toBe(true); });
    await act(async () => {
      older.resolve(jsonResponse(200, SIGNED_IN_USER));
      expect(await first).toBe(false);
    });

    expect(screen.getByTestId("user").textContent).toBe(OTHER.email);
    expect(getAuth().accessToken).toBe("tok-newer");
  });
});

describe("AuthProvider.login — never navigate to /undefined", () => {
  // jsdom refuses a real cross-document navigation, so capture the assignment
  // instead. `href` is the only member login() touches.
  let navigatedTo: string | null = null;

  beforeEach(() => {
    navigatedTo = null;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        set href(value: string) {
          navigatedTo = value;
        },
        get href() {
          return navigatedTo ?? "http://localhost:3000/";
        },
        protocol: "http:"
      }
    });
  });

  it("navigates to the authorization URL the backend returns", async () => {
    const { getAuth, fetchMock } = await renderSignedIn();
    fetchMock.mockResolvedValue(jsonResponse(200, { url: "https://workos.example/authorize" }));

    await act(async () => {
      await getAuth().login();
    });

    expect(navigatedTo).toBe("https://workos.example/authorize");
  });

  it("throws instead of navigating when the backend fails", async () => {
    const { getAuth, fetchMock } = await renderSignedIn();
    fetchMock.mockResolvedValue(textResponse(502, "<html>Bad gateway</html>"));

    await expect(getAuth().login()).rejects.toThrow(/unavailable/i);
    expect(navigatedTo).toBeNull();
  });

  it("throws instead of navigating when a 200 body is not JSON", async () => {
    const { getAuth, fetchMock } = await renderSignedIn();
    fetchMock.mockResolvedValue(textResponse(200, "<html>proxy interstitial</html>"));

    await expect(getAuth().login()).rejects.toThrow(/unavailable/i);
    expect(navigatedTo).toBeNull();
  });

  it("throws instead of navigating to /undefined when the url is missing", async () => {
    const { getAuth, fetchMock } = await renderSignedIn();
    fetchMock.mockResolvedValue(jsonResponse(200, {}));

    await expect(getAuth().login()).rejects.toThrow(/unavailable/i);
    expect(navigatedTo).toBeNull();
  });
});

// The backend refuses form posts on auth mutations (backend
// lib/browser-auth-origin.ts), so refresh and logout must send a JSON body.
describe("AuthProvider — refresh and logout are JSON posts", () => {
  beforeEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { href: "http://localhost:3000/", protocol: "http:" }
    });
  });

  function expectJsonPost(fetchMock: ReturnType<typeof vi.fn>, path: string) {
    const call = fetchMock.mock.calls.find(([input]) => String(input) === `${API_URL}${path}`);
    expect(call).toBeDefined();
    expect(call![1]).toMatchObject({
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
  }

  it("sends a JSON body on refresh", async () => {
    const { getAuth, fetchMock } = await renderSignedIn();
    fetchMock.mockResolvedValue(jsonResponse(200, { accessToken: "tok-next" }));

    await act(async () => { await getAuth().refreshToken(); });

    expectJsonPost(fetchMock, "/auth/refresh");
  });

  it("sends a JSON body on logout", async () => {
    const { getAuth, fetchMock } = await renderSignedIn();
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));

    await act(async () => { await getAuth().logout(); });

    expectJsonPost(fetchMock, "/auth/logout");
    expect(window.location.href).toBe("/login");
    expect(getAccessToken()).toBeNull();
    expect(screen.getByTestId("user").textContent).toBe("none");
  });

  it("keeps the session and shows an error when the sign-out request fails", async () => {
    const { getAuth, fetchMock } = await renderSignedIn();
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await act(async () => { await getAuth().logout(); });

    // The refresh cookie can still be valid, so the tab does not pretend to be signed out.
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Sign-out failed. Try again.");
    expect(window.location.href).toBe("http://localhost:3000/");
    expect(screen.getByTestId("user").textContent).toBe(SIGNED_IN_USER.email);
    expect(getAccessToken()).toBe("tok-boot");
  });

  // The backend keeps the refresh cookie when it refuses (403), limits (429)
  // or fails (5xx) the sign-out. A resolved fetch is not a sign-out.
  it.each([403, 429, 500, 503])("keeps the session and shows an error when the sign-out answers %i", async (status) => {
    const { getAuth, fetchMock } = await renderSignedIn();
    const epoch = getSessionEpoch();
    vi.mocked(toast.error).mockClear();
    fetchMock.mockResolvedValue(jsonResponse(status, { error: "sign_out_failed" }));

    await act(async () => { await getAuth().logout(); });

    expectJsonPost(fetchMock, "/auth/logout");
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Sign-out failed. Try again.");
    expect(window.location.href).toBe("http://localhost:3000/");
    expect(screen.getByTestId("user").textContent).toBe(SIGNED_IN_USER.email);
    expect(getAccessToken()).toBe("tok-boot");
    expect(getSessionEpoch()).toBe(epoch);
    expect(document.cookie).toContain("cogniplane_session_hint=1");
  });

  it("signs out when a retry after a failed sign-out succeeds", async () => {
    const { getAuth, fetchMock } = await renderSignedIn();
    fetchMock.mockResolvedValueOnce(jsonResponse(429, { error: "rate_limited" }));
    await act(async () => { await getAuth().logout(); });
    expect(getAccessToken()).toBe("tok-boot");

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    await act(async () => { await getAuth().logout(); });

    expect(fetchMock.mock.calls.filter(([input]) => String(input) === `${API_URL}/auth/logout`)).toHaveLength(2);
    expect(window.location.href).toBe("/login");
    expect(getAccessToken()).toBeNull();
    expect(screen.getByTestId("user").textContent).toBe("none");
  });
});
