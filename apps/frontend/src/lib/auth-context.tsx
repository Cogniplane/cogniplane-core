"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";

import { API_URL, refreshAccessToken, setAccessToken as setApiClientToken, setTokenRefresher } from "./api-client";
import { QueryProvider } from "./query-provider";

export type AuthUser = {
  userId: string;
  email: string;
  displayName: string;
  tenantId: string;
  tenantName?: string;
  tenantSlug?: string;
  role: "owner" | "admin" | "member";
};

type AuthContextValue = {
  user: AuthUser | null;
  accessToken: string | null;
  isLoading: boolean;
  login: (options?: { organization?: string }) => Promise<void>;
  logout: () => Promise<void>;
  refreshToken: () => Promise<string | null>;
  completeLogin: (token: string) => Promise<boolean>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

const DEV_USER_ID = process.env.NEXT_PUBLIC_DEV_USER_ID;
const DEV_TENANT_ID = process.env.NEXT_PUBLIC_DEV_TENANT_ID ?? "local-dev-tenant";

// `cogniplane_session_hint` is a UX-only hint read by middleware.ts to skip
// the /login flash for returning users on initial paint. It is NOT an
// authentication boundary — it's set from client JS and trivially
// spoofable. The real auth happens on the backend (refresh cookie + JWT)
// and inside AuthGuard (which calls /auth/me with the in-memory access
// token). See middleware.ts for the full reasoning.
//
// TTL is bounded by the backend refresh-cookie window so the hint expires
// roughly when a real session would; longer TTLs would only make the UX
// hint stale, never insecure.
const SESSION_HINT_COOKIE = "cogniplane_session_hint";
const SESSION_HINT_MAX_AGE_S = 7 * 24 * 60 * 60;

function setSessionHintCookie(): void {
  if (typeof document === "undefined") return;
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${SESSION_HINT_COOKIE}=1; Path=/; Max-Age=${SESSION_HINT_MAX_AGE_S}; SameSite=Lax${secure}`;
}

function clearSessionHintCookie(): void {
  if (typeof document === "undefined") return;
  document.cookie = `${SESSION_HINT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}

// A 403 from /auth/refresh is not by itself proof that the session is gone.
// The route rejects a cross-origin POST with `csrf_origin_mismatch` before it
// ever looks at the refresh cookie (auth.ts, passesCsrfOriginCheck), while a
// user removed from the tenant gets `not_a_member` at the same status. Only the
// second means the session is over.
const REFRESH_KEEPS_SESSION_CODES = new Set(["csrf_origin_mismatch"]);

async function readErrorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body?.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

// Whether a failed /auth/refresh means the session is really gone. A 5xx, a
// network drop or a timeout must leave the user signed in: AuthGuard redirects
// to /login the moment `user` goes null, so treating a gateway hiccup as a
// revocation signs people out mid-session. A 403 with no readable code (an
// intermediary rejecting the request, say) still counts as revoked — a 403 is
// an authorization refusal, and leaving a genuinely revoked session on screen
// is the worse of the two mistakes.
async function isSessionRevoked(response: Response): Promise<boolean> {
  if (response.status === 401) return true;
  if (response.status !== 403) return false;
  const code = await readErrorCode(response);
  return code === null || !REFRESH_KEEPS_SESSION_CODES.has(code);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [accessToken, setAccessTokenState] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const clearSession = useCallback(() => {
    setAccessTokenState(null);
    setApiClientToken(null);
    setUser(null);
    clearSessionHintCookie();
  }, []);

  const refreshToken = useCallback(async (): Promise<string | null> => {
    // In dev-headers mode there is no token — the backend reads identity from
    // X-Dev-User-Id / X-Dev-Tenant-Id headers injected by the API client.
    if (DEV_USER_ID) return null;

    let response: Response;
    try {
      response = await fetch(`${API_URL}/auth/refresh`, {
        method: "POST",
        credentials: "include"
      });
    } catch {
      // The network is down, not the session. Keep what we have.
      return null;
    }

    if (!response.ok) {
      if (await isSessionRevoked(response)) clearSession();
      return null;
    }

    // A malformed 200 would otherwise install `undefined` as the access token,
    // and every later request would send `Bearer undefined`.
    let accessToken: unknown;
    try {
      accessToken = ((await response.json()) as { accessToken?: unknown })?.accessToken;
    } catch {
      return null;
    }
    if (typeof accessToken !== "string" || accessToken.length === 0) return null;

    setAccessTokenState(accessToken);
    setApiClientToken(accessToken);
    setSessionHintCookie();
    return accessToken;
  }, [clearSession]);

  const fetchMe = useCallback(
    async (token: string): Promise<boolean> => {
      try {
        const response = await fetch(`${API_URL}/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
          credentials: "include"
        });

        if (!response.ok) {
          setUser(null);
          return false;
        }

        const data = (await response.json()) as AuthUser;
        setUser(data);
        return true;
      } catch {
        setUser(null);
        return false;
      }
    },
    []
  );

  const completeLogin = useCallback(
    async (token: string): Promise<boolean> => {
      setAccessTokenState(token);
      setApiClientToken(token);
      const ok = await fetchMe(token);
      if (ok) {
        setSessionHintCookie();
      } else {
        clearSessionHintCookie();
      }
      return ok;
    },
    [fetchMe]
  );

  useEffect(() => {
    // Dev-headers mode: synthesize a local user without any network calls.
    if (DEV_USER_ID) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setUser({
        userId: DEV_USER_ID,
        email: "dev@local",
        displayName: "Local Dev",
        tenantId: DEV_TENANT_ID,
        role: "owner"
      });
      setSessionHintCookie();
      setIsLoading(false);
      return;
    }

    setTokenRefresher(refreshToken);
    (async () => {
      // Use api-client's single-flight wrapper so a concurrent 401-retry from
      // a child component shares the same in-flight refresh. Calling
      // refreshToken() directly here would race against api-client's retry,
      // and both would send the same cogniplane_refresh cookie before rotation —
      // the backend then treats the second one as reuse and revokes the family.
      const token = await refreshAccessToken();
      if (token) {
        setAccessTokenState(token);
        setApiClientToken(token);
        const ok = await fetchMe(token);
        if (ok) {
          setSessionHintCookie();
        } else {
          clearSessionHintCookie();
        }
      }
      setIsLoading(false);
    })();
  }, [refreshToken, fetchMe]);

  const login = useCallback(
    async (options?: { organization?: string }) => {
      const params = new URLSearchParams();
      if (options?.organization) {
        params.set("organization", options.organization);
      }

      const response = await fetch(
        `${API_URL}/auth/login?${params.toString()}`,
        { credentials: "include" }
      );
      if (!response.ok) {
        throw new Error(`Sign-in is unavailable right now (${response.status}).`);
      }

      // A 502 from the gateway sends back an HTML error page, not JSON. Parsing
      // it unguarded surfaces an opaque SyntaxError, and reading `.url` off the
      // result navigated the browser to "/undefined".
      let data: { url?: unknown };
      try {
        data = (await response.json()) as { url?: unknown };
      } catch {
        throw new Error("Sign-in is unavailable right now.");
      }
      if (typeof data.url !== "string" || data.url.length === 0) {
        throw new Error("Sign-in is unavailable right now.");
      }
      window.location.href = data.url;
    },
    []
  );

  const logout = useCallback(async () => {
    await fetch(`${API_URL}/auth/logout`, {
      method: "POST",
      credentials: "include"
    });
    clearSession();
    // A hard document load, deliberately, not router.push("/login").
    // clearSession only drops React state and the in-memory API-client token;
    // a client-side navigation keeps the same JS context alive, so any module
    // singleton or cached query holding the old identity would survive into
    // the next sign-in. Reloading the document is what guarantees the tab
    // starts from nothing.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full reload drops in-memory auth state, see above
    window.location.href = "/login";
  }, [clearSession]);

  const value = useMemo(
    () => ({ user, accessToken, isLoading, login, logout, refreshToken, completeLogin }),
    [user, accessToken, isLoading, login, logout, refreshToken, completeLogin]
  );

  return (
    <AuthContext.Provider value={value}>
      <QueryProvider key={`${user?.userId ?? ""}:${user?.tenantId ?? ""}`}>
        {children}
      </QueryProvider>
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
