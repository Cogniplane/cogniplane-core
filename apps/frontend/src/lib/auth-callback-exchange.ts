"use client";

import { API_URL, changeSession, getSessionEpoch } from "./api-client";

export type OrganizationOption = { id: string; name: string };

/** The result of the WorkOS code exchange of the callback page. */
export type CallbackOutcome =
  | { kind: "signed_in" }
  /** This tab sent the code in an earlier page load: it is used. */
  | { kind: "already_used" }
  | { kind: "select_organization"; organizations: OrganizationOption[] }
  | { kind: "failed"; message: string };

// A WorkOS authorization code is single-use. The callback page can mount more
// than once for one code: StrictMode runs its effect twice; the AuthProvider
// mounts its children again when completeLogin sets the person (the key of
// its QueryProvider); and back, forward, or a reload show the page again.
// A second exchange fails (the first one cleared the state cookie), and the
// page would show its error on a sign-in that worked. So one exchange runs
// per code. The page instances of one document share it, and a later
// document of the same tab finds its digest in sessionStorage and does not
// send it again.
const exchanges = new Map<string, Promise<CallbackOutcome>>();
// Keep each used code digest for this tab, including older history entries.
const USED_CODE_KEY = "cogniplane_used_auth_code";

function wasUsedInThisTab(digest: string): boolean {
  try {
    return window.sessionStorage.getItem(`${USED_CODE_KEY}:${digest}`) === "1";
  } catch {
    return false;
  }
}

function markUsed(digest: string): void {
  try {
    window.sessionStorage.setItem(`${USED_CODE_KEY}:${digest}`, "1");
  } catch {
    // Without storage, only the instances of this document share the exchange.
  }
}

/**
 * Exchanges `code` for a session once in this tab. Every later call for the
 * same code gets the outcome of the first, also while it runs.
 */
export async function exchangeCodeOnce(
  code: string,
  state: string,
  completeLogin: (token: string, expectedEpoch?: number) => Promise<boolean>
): Promise<CallbackOutcome> {
  const epoch = getSessionEpoch();
  try {
    // Neither the document map nor persistent keys retain the credential.
    // Crypto failure sends no credential and writes no marker.
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
    const digest = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const known = exchanges.get(digest);
    if (known) return known;
    const outcome: Promise<CallbackOutcome> = wasUsedInThisTab(digest)
      ? Promise.resolve({ kind: "already_used" })
      : exchange(code, state, completeLogin, digest, epoch);
    exchanges.set(digest, outcome);
    return outcome;
  } catch {
    return { kind: "failed", message: "Authentication request failed" };
  }
}

async function exchange(
  code: string,
  state: string,
  completeLogin: (token: string, expectedEpoch?: number) => Promise<boolean>,
  digest: string,
  epoch: number
): Promise<CallbackOutcome> {
  // Before the request: a page load during the call must not send it again.
  markUsed(digest);
  try {
    let installedEpoch: number | undefined;
    const { response, data } = await changeSession(async (_request, signal) => {
      if (getSessionEpoch() !== epoch) throw new Error("Session changed");
      const response = await fetch(`${API_URL}/auth/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ code, state }),
        signal
      });
      const data = await response.json() as { accessToken?: string; error?: string; organizations?: OrganizationOption[] };
      if (signal.aborted || getSessionEpoch() !== epoch) throw new Error("Session changed");
      return { response, data };
    }, ({ response, data }) => {
      if (!response.ok || typeof data.accessToken !== "string" || !data.accessToken) return undefined;
      installedEpoch = getSessionEpoch() + 1;
      return data.accessToken;
    }, { interruptible: true });
    if (!response.ok) {
      if (response.status === 409 && data.error === "organization_selection_required" && data.organizations?.length) {
        return { kind: "select_organization", organizations: data.organizations };
      }
      return { kind: "failed", message: data.error ?? "Authentication failed" };
    }
    if (installedEpoch === undefined || !(await completeLogin(data.accessToken!, installedEpoch))) {
      return { kind: "failed", message: "Authentication succeeded but user bootstrap failed" };
    }
    return { kind: "signed_in" };
  } catch {
    return { kind: "failed", message: "Authentication request failed" };
  }
}

/** Only for tests: forgets the exchanges of this document, as a new page load does. */
export function __resetCodeExchangesForTests(): void {
  exchanges.clear();
}
