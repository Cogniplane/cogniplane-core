// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { API_URL } from "./api-client";
import { AuthProvider, useAuth } from "./auth-context";

// vitest runs with globals:false, so RTL cannot auto-register its cleanup.
afterEach(cleanup);

type AuthApi = ReturnType<typeof useAuth>;

// Surfaces the context so a test can call refreshToken()/login() directly and
// read back what the provider decided about the session.
function Probe({ onReady }: { onReady: (auth: AuthApi) => void }) {
  const auth = useAuth();
  onReady(auth);
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
  render(
    <AuthProvider>
      <Probe
        onReady={(value) => {
          auth = value;
        }}
      />
    </AuthProvider>
  );

  await waitFor(() => expect(screen.getByTestId("user").textContent).toBe(SIGNED_IN_USER.email));
  fetchMock.mockReset();
  return { getAuth: () => auth as AuthApi, fetchMock };
}

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
    fetchMock.mockResolvedValue(jsonResponse(200, { accessToken: "tok-2" }));

    await act(async () => {
      expect(await getAuth().refreshToken()).toBe("tok-2");
    });

    expect(getAuth().accessToken).toBe("tok-2");
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
