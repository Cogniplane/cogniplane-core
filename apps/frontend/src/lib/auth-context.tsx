"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode
} from "react";

import {
  API_URL,
  changeSession,
  getAccessToken,
  getSessionEpoch,
  installedSessionEpoch,
  refreshAccessToken,
  replaceSession,
  setTokenRefresher,
  subscribeAccessToken
} from "./api-client";
import type { SessionUser } from "@cogniplane/shared-types";
import { toast } from "sonner";
import { QueryProvider } from "./query-provider";
import { AgentBehaviorDraftProvider } from "../components/agent-behavior-draft-provider";
import { clearComposerDrafts } from "../components/composer-drafts.logic";
import { clearGenerativeUiDrafts } from "../components/generative-ui-drafts.logic";

export type AuthUser = {
  userId: string;
  email: string;
  displayName: string;
  tenantId: string;
  tenantName?: string;
  tenantSlug?: string;
  role: "owner" | "admin" | "member";
  /** How this tenant's members sign in. Local tenants get the account tools. */
  loginType?: "workos" | "local";
};

type AuthContextValue = {
  user: AuthUser | null;
  accessToken: string | null;
  isLoading: boolean;
  login: (options?: { organization?: string }) => Promise<void>;
  logout: () => Promise<void>;
  refreshToken: () => Promise<string | null>;
  completeLogin: (token: string, expectedEpoch?: number) => Promise<boolean>;
  adoptSession: (token: string, sessionUser: SessionUser) => boolean;
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
function isSessionRevoked(status: number, code: string | null): boolean {
  if (status === 401) return true;
  if (status !== 403) return false;
  return code === null || !REFRESH_KEEPS_SESSION_CODES.has(code);
}

// Refusals of a cookie that another tab can have replaced while this refresh
// ran. All tabs share the cookie jar, and the server does not delete the
// cookie on a refusal (auth-session.ts in the backend). For example, a new
// sign-in or a first second factor in another tab ends the older session and
// puts its new cookie in the jar. So the refresh is sent once more: a newer
// cookie renews the session, and a dead cookie is refused again.
const REFRESH_AGAIN_CODES = new Set(["token_revoked", "session_revoked"]);

type RefreshAnswer =
  | { kind: "token"; token: string }
  | { kind: "revoked"; code: string | null }
  /** The session is not known to be gone (network, 5xx, a malformed 200). */
  | { kind: "kept" };

async function postRefresh(signal: AbortSignal): Promise<RefreshAnswer> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}/auth/refresh`, {
      method: "POST",
      // A JSON body: the backend refuses form posts on auth mutations, so a
      // hostile page cannot forge this request (backend browser-auth-origin.ts).
      headers: { "Content-Type": "application/json" },
      body: "{}",
      credentials: "include",
      signal
    });
  } catch {
    // The network is down (or the call was aborted), not the session.
    return { kind: "kept" };
  }

  if (!response.ok) {
    const code = response.status === 401 || response.status === 403 ? await readErrorCode(response) : null;
    return isSessionRevoked(response.status, code) ? { kind: "revoked", code } : { kind: "kept" };
  }

  // A malformed 200 would otherwise install `undefined` as the access token,
  // and every later request would send `Bearer undefined`.
  let accessToken: unknown;
  try {
    accessToken = ((await response.json()) as { accessToken?: unknown })?.accessToken;
  } catch {
    return { kind: "kept" };
  }
  if (typeof accessToken !== "string" || accessToken.length === 0) return { kind: "kept" };
  return { kind: "token", token: accessToken };
}

/**
 * Reads the person and organization for refresh identity comparisons. This
 * does not verify the signature; the backend checks every token. An unreadable
 * token gives no identity.
 */
function tokenIdentity(token: string): Pick<AuthUser, "userId" | "tenantId"> | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const claims = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as { sub?: unknown; tid?: unknown };
    return typeof claims.sub === "string" && typeof claims.tid === "string"
      ? { userId: claims.sub, tenantId: claims.tid } : null;
  } catch {
    return null;
  }
}

function isTokenFor(token: string, person: Pick<AuthUser, "userId" | "tenantId">): boolean {
  const identity = tokenIdentity(token);
  return identity?.userId === person.userId && identity.tenantId === person.tenantId;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<AuthUser | null>(null);
  // The signed-in person at this moment. adoptSession reads it, so a sign-out
  // that ran first is seen before the next render.
  const userRef = useRef<AuthUser | null>(null);
  // The displayed person belongs to this epoch until /auth/me loads a new one.
  const userEpochRef = useRef(getSessionEpoch());
  const setUser = useCallback((next: AuthUser | null) => {
    // Composer drafts and edits in generated UI end with that person. The
    // check runs here, so a sign-out, a revoked session and a change of person
    // all clear them, and no draft reaches the next person of this tab.
    const previous = userRef.current;
    if (previous && (!next || previous.userId !== next.userId || previous.tenantId !== next.tenantId)) {
      clearGenerativeUiDrafts();
      clearComposerDrafts();
    }
    userRef.current = next;
    userEpochRef.current = getSessionEpoch();
    setUserState(next);
  }, []);
  // The API client holds the token and is its one writer. Its session
  // coordinator orders the writes (session-coordinator.ts, "The session token,
  // in order"). The writers below start or end a session there, and each async
  // answer applies only in the session epoch of its start. Thus a late answer
  // for an older session cannot replace a newer one.
  const accessToken = useSyncExternalStore(subscribeAccessToken, getAccessToken, () => null);
  const [isLoading, setIsLoading] = useState(true);

  const clearSession = useCallback(() => {
    replaceSession(null);
    // There can be a token before the first person lookup completes.
    if (!userRef.current) {
      clearGenerativeUiDrafts();
      clearComposerDrafts();
    }
    setUser(null);
    clearSessionHintCookie();
  }, [setUser]);

  // The token refresher of the API client. Call it through refreshAccessToken
  // only: that call waits for the session-change gate, is shared, and has a
  // time limit. After `signal` aborts, it changes nothing.
  const sendRefresh = useCallback(async (signal: AbortSignal): Promise<string | null> => {
    // In dev-headers mode there is no token — the backend reads identity from
    // X-Dev-User-Id / X-Dev-Tenant-Id headers injected by the API client.
    if (DEV_USER_ID) return null;

    const epoch = getSessionEpoch();
    // A session change installs its token before /auth/me finishes. Bind the
    // pending identity to that epoch, rather than the previous displayed user.
    // A provider remount has no displayed user but retains the installed token.
    // Capture it before the request so the response cannot choose its identity.
    const person = userEpochRef.current === epoch && userRef.current ? userRef.current
      : tokenIdentity(getAccessToken() ?? "") ?? userRef.current;
    let answer = await postRefresh(signal);
    if (answer.kind === "revoked" && answer.code !== null && REFRESH_AGAIN_CODES.has(answer.code) && !signal.aborted) {
      // Once only: a second refusal ends the session below.
      answer = await postRefresh(signal);
    }
    if (signal.aborted || getSessionEpoch() !== epoch) return null;
    // Compare every success with the current person, including timeout retries.
    if (answer.kind === "token" && person && !isTokenFor(answer.token, person)) {
      answer = { kind: "revoked", code: null };
    }

    if (answer.kind === "revoked") {
      // A refusal for an older session must not end a newer one, which a
      // sign-in or an account change started while this refresh ran.
      if (getSessionEpoch() === epoch) {
        // A refused initial refresh has no session to end. Do not invalidate
        // a callback that is waiting for that refresh to finish.
        if (userRef.current || getAccessToken()) clearSession();
        else {
          clearGenerativeUiDrafts();
          clearComposerDrafts();
          clearSessionHintCookie();
        }
      }
      return null;
    }
    if (answer.kind === "kept") return null;

    // The API client installs the token, unless the epoch changed.
    if (getSessionEpoch() === epoch) setSessionHintCookie();
    return answer.token;
  }, [clearSession]);

  // Loads the person of `token`. The answer applies only while the session
  // epoch is still `epoch`; a refresh in between does not change it.
  const fetchMe = useCallback(
    async (token: string, epoch: number): Promise<boolean> => {
      const requestMe = (bearer: string) =>
        fetch(`${API_URL}/auth/me`, {
          headers: { Authorization: `Bearer ${bearer}` },
          credentials: "include"
        });
      try {
        let response = await requestMe(token);

        // A 401 can come from an expired or replaced access token while the
        // refresh cookie is still valid. Try one refresh before the user is
        // cleared. Use the shared single-flight refresh, so this request and
        // an api-client retry do not send the same refresh cookie twice. The
        // refresh does not call fetchMe, so this cannot loop.
        if (response.status === 401) {
          const refreshed = await refreshAccessToken();
          if (refreshed) response = await requestMe(refreshed);
        }

        if (!response.ok) {
          if (getSessionEpoch() === epoch) setUser(null);
          return false;
        }

        const data = (await response.json()) as AuthUser;
        if (getSessionEpoch() !== epoch) return false;
        setUser(data);
        return true;
      } catch {
        if (getSessionEpoch() === epoch) setUser(null);
        return false;
      }
    },
    [setUser]
  );

  const completeLogin = useCallback(
    async (token: string, expectedEpoch?: number): Promise<boolean> => {
      // Callback tokens are already installed under the gate.
      if (expectedEpoch !== undefined && getSessionEpoch() !== expectedEpoch) return false;
      const epoch = expectedEpoch ?? replaceSession(token);
      const ok = await fetchMe(token, epoch);
      if (getSessionEpoch() === epoch) {
        if (ok) {
          setSessionHintCookie();
        } else {
          clearSessionHintCookie();
        }
      }
      return ok;
    },
    [fetchMe]
  );

  // Takes the new session that an account change started for the person who
  // is signed in now. For example, a first second factor ends every older
  // session. The account does not load again, so a failed load cannot sign
  // the person out; the answer's person updates the role and name. Nothing
  // changes when no person is signed in (a sign-out ran first) or when the
  // answer is for another person or organization. Returns whether it took
  // the session.
  const adoptSession = useCallback((token: string, sessionUser: SessionUser): boolean => {
    const current = userRef.current;
    if (!current || current.userId !== sessionUser.userId || current.tenantId !== sessionUser.tenantId) {
      return false;
    }
    // A session-change call installs its token before the gate opens
    // (local-auth-api.ts). Its epoch then tells whether that session is still
    // the one in memory. A refresh since then renews it in the same epoch, and
    // the newer token stays. A newer session came first when the epoch
    // changed: nothing changes. A direct call installs the token here.
    const installed = installedSessionEpoch(token);
    if (installed === null) replaceSession(token);
    else if (installed !== getSessionEpoch()) return false;
    setSessionHintCookie();
    setUser({ ...current, email: sessionUser.email, displayName: sessionUser.displayName, role: sessionUser.role });
    return true;
  }, [setUser]);

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

    setTokenRefresher(sendRefresh);
    (async () => {
      // Use api-client's single-flight wrapper so a concurrent 401-retry from
      // a child component shares the same in-flight refresh. Calling
      // sendRefresh() directly here would race against api-client's retry,
      // and both would send the same cogniplane_refresh cookie before rotation —
      // the backend then treats the second one as reuse and revokes the family.
      const token = await refreshAccessToken();
      // A callback can install a session while this provider waits at the
      // gate, including after a provider remount. Bootstrap the returned
      // current token in its installed epoch, not the epoch before the wait.
      const epoch = getSessionEpoch();
      if (token && token === getAccessToken()) {
        const ok = await fetchMe(token, epoch);
        if (getSessionEpoch() === epoch) {
          if (ok) {
            setSessionHintCookie();
          } else {
            clearSessionHintCookie();
          }
        }
      }
      setIsLoading(false);
    })();
  }, [sendRefresh, fetchMe, setUser]);

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
    // The answer deletes the refresh cookie. Hold the gate, so that no refresh
    // sends the cookie at the same time, and end the session in memory before
    // the gate opens. A refresh on the wire is stopped, not awaited: on a
    // shared computer, a hung refresh must not keep the person signed in.
    try {
      await changeSession(
        async (_request, signal) => {
          const response = await fetch(`${API_URL}/auth/logout`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
            credentials: "include",
            signal
          });
          // A refused or failed sign-out (403, 429, 5xx) keeps the refresh
          // cookie. Throw, so that changeSession keeps the session in memory.
          if (!response.ok) throw new Error(`Sign-out failed (${response.status}).`);
          return response;
        },
        () => null,
        { stopRefresh: true }
      );
    } catch {
      // Keep the session on screen: the refresh cookie can still be valid, and
      // on a shared computer the next person must not boot into it.
      toast.error("Sign-out failed. Try again.");
      return;
    }
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

  // The shared refresh, which waits for the session-change gate.
  const refreshToken = refreshAccessToken;
  const value = useMemo(
    () => ({ user, accessToken, isLoading, login, logout, refreshToken, completeLogin, adoptSession }),
    [user, accessToken, isLoading, login, logout, refreshToken, completeLogin, adoptSession]
  );

  return (
    <AuthContext.Provider value={value}>
      <QueryProvider key={`${user?.userId ?? ""}:${user?.tenantId ?? ""}`}>
        <AgentBehaviorDraftProvider>{children}</AgentBehaviorDraftProvider>
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
