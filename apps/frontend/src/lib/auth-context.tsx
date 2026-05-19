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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [accessToken, setAccessTokenState] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refreshToken = useCallback(async (): Promise<string | null> => {
    // In dev-headers mode there is no token — the backend reads identity from
    // X-Dev-User-Id / X-Dev-Tenant-Id headers injected by the API client.
    if (DEV_USER_ID) return null;

    try {
      const response = await fetch(`${API_URL}/auth/refresh`, {
        method: "POST",
        credentials: "include"
      });

      if (!response.ok) {
        setAccessTokenState(null);
        setApiClientToken(null);
        setUser(null);
        clearSessionHintCookie();
        return null;
      }

      const data = (await response.json()) as { accessToken: string };
      setAccessTokenState(data.accessToken);
      setApiClientToken(data.accessToken);
      setSessionHintCookie();
      return data.accessToken;
    } catch {
      setAccessTokenState(null);
      setApiClientToken(null);
      setUser(null);
      clearSessionHintCookie();
      return null;
    }
  }, []);

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
      const data = (await response.json()) as { url: string };
      window.location.href = data.url;
    },
    []
  );

  const logout = useCallback(async () => {
    await fetch(`${API_URL}/auth/logout`, {
      method: "POST",
      credentials: "include"
    });
    setAccessTokenState(null);
    setApiClientToken(null);
    setUser(null);
    clearSessionHintCookie();
    window.location.href = "/login";
  }, []);

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
