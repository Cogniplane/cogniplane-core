import {
  AuthConfigResponseSchema,
  AuthSessionResponseSchema,
  EnrollmentCompleteResponseSchema,
  LocalSignInResponseSchema,
  NextStepResponseSchema,
  RecoveryCodesResponseSchema,
  TenantSecuritySettingsSchema,
  TotpEnrollmentResponseSchema,
  type EnrollmentCompleteResponse,
  type LocalSignInResponse,
  type MfaPolicy,
  type NextStepResponse,
  type TotpEnrollmentResponse,
  CreateLocalMemberResponseSchema,
  MemberLinkResponseSchema,
  ResendMemberLinkResponseSchema,
  type EmailedLink,
  type MemberLinkResponse,
  MemberStatusResponseSchema,
  MySecurityResponseSchema,
  MyPasskeyAddedResponseSchema,
  PasskeyListResponseSchema,
  PasskeyOptionsResponseSchema,
  PasskeySummarySchema,
  StepUpResponseSchema,
  type MyPasskeyAddedResponse,
  type PasskeySummary,
  type AuthConfigResponse,
  type AuthSessionResponse,
  type CreateLocalMemberRequest,
  type CreateLocalMemberResponse,
  type LocalAccountStatus,
  type MySecurityResponse,
  type StepUpAction
} from "@cogniplane/shared-types";

import { API_URL, ApiError, changeSession, request } from "./api-client";
import { assertWithPasskey, createPasskey, PasskeyCeremonyError } from "./passkey-browser";

// Client for local accounts (docs/architecture/local-accounts.md).
// Sign-in, setup, and reset run before a session exists: they use plain fetch
// with credentials, so the backend can set the refresh cookie. Everything else
// goes through the authenticated API client.
//
// A call whose answer sets or deletes the refresh cookie holds the
// session-change gate of the API client while it runs (changeSession), so
// that no refresh sends the old cookie at the same time. An account change
// that answers with a new session installs its token before the gate opens.
// A sign-in does not: completeLogin installs it, after the person loads.

/** A failed local-auth call: the backend's error code and HTTP status. */
export class LocalAuthError extends Error {
  constructor(readonly code: string, readonly status: number, readonly retryAfterSeconds: number | null = null) {
    super(code);
    this.name = "LocalAuthError";
  }
}

/** A public sign-in step whose answer can start a session. */
function postPublicSessionChange(path: string, body?: unknown): Promise<unknown> {
  return changeSession((_request, signal) => postPublic(path, body, signal));
}

/**
 * An account change of the signed-in person that ends this session and
 * answers with a new one. The parsed answer's token goes in before the gate
 * opens.
 */
function requestNewSession<T extends { accessToken?: string }>(
  path: string,
  init: RequestInit,
  schema: { parse: (raw: unknown) => T }
): Promise<T> {
  return changeSession(async (gated) => schema.parse(await gated<unknown>(path, init)), (result) => result.accessToken);
}

async function postPublic(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body ?? {}),
      signal
    });
  } catch {
    throw new LocalAuthError("network_error", 0);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const code = typeof (payload as { error?: unknown } | null)?.error === "string"
      ? (payload as { error: string }).error
      : "request_failed";
    const retryAfter = Number(response.headers.get("retry-after"));
    throw new LocalAuthError(code, response.status, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null);
  }
  return payload;
}

/** Which login types this installation offers. Public in every mode. */
export async function fetchAuthConfig(): Promise<AuthConfigResponse> {
  const response = await fetch(`${API_URL}/auth/config`, { credentials: "include" });
  if (!response.ok) throw new LocalAuthError("config_unavailable", response.status);
  return AuthConfigResponseSchema.parse(await response.json());
}

/** A session, or the next sign-in step (second factor or enrolment). */
export function isNextStep(result: LocalSignInResponse): result is NextStepResponse {
  return "next" in result;
}

export async function signInWithPassword(email: string, password: string): Promise<LocalSignInResponse> {
  return LocalSignInResponseSchema.parse(await postPublicSessionChange("/auth/local/login", { email, password }));
}

/** Sets the first password from a setup link: a session, or an enrolment step. */
export async function completeAccountSetup(token: string, password: string): Promise<LocalSignInResponse> {
  return LocalSignInResponseSchema.parse(await postPublicSessionChange("/auth/local/setup", { token, password }));
}

// ---- Sign-in steps after the password (the browser holds the flow cookie) ----

export async function submitTotpCode(code: string): Promise<AuthSessionResponse> {
  return AuthSessionResponseSchema.parse(await postPublicSessionChange("/auth/local/mfa/totp", { code }));
}

/** A recovery code: the next step is always a new enrolment. */
export async function submitRecoveryCode(code: string): Promise<NextStepResponse> {
  return NextStepResponseSchema.parse(await postPublic("/auth/local/mfa/recovery", { code }));
}

export async function startSignInEnrollment(): Promise<TotpEnrollmentResponse> {
  return TotpEnrollmentResponseSchema.parse(await postPublic("/auth/local/enroll/totp/start"));
}

export async function confirmSignInEnrollment(code: string): Promise<EnrollmentCompleteResponse> {
  return EnrollmentCompleteResponseSchema.parse(await postPublicSessionChange("/auth/local/enroll/totp/confirm", { code }));
}

// ---- Passkeys before a session (the browser holds the challenge cookie) ----

/** Passwordless sign-in: the browser offers the passkeys it has for this site. */
export async function signInWithPasskey(): Promise<AuthSessionResponse> {
  const { options } = PasskeyOptionsResponseSchema.parse(await postPublic("/auth/passkey/login/options"));
  const credential = await assertWithPasskey(options);
  return AuthSessionResponseSchema.parse(await postPublicSessionChange("/auth/passkey/login/verify", { credential }));
}

/** The second step after the password, with one of the account's passkeys. */
export async function submitPasskeySecondFactor(): Promise<AuthSessionResponse> {
  const { options } = PasskeyOptionsResponseSchema.parse(await postPublic("/auth/local/mfa/passkey/options"));
  const credential = await assertWithPasskey(options);
  return AuthSessionResponseSchema.parse(await postPublicSessionChange("/auth/local/mfa/passkey/verify", { credential }));
}

/** A passkey as the factor that the sign-in asks to enrol. */
export async function enrollPasskeyInSignIn(name?: string): Promise<EnrollmentCompleteResponse> {
  const { options } = PasskeyOptionsResponseSchema.parse(await postPublic("/auth/local/enroll/passkey/options"));
  const credential = await createPasskey(options);
  return EnrollmentCompleteResponseSchema.parse(
    await postPublicSessionChange("/auth/local/enroll/passkey/verify", { credential, ...(name ? { name } : {}) })
  );
}

/**
 * "Forgot password": asks for a reset link by email. The backend answers the
 * same for every address, so success says nothing about an account.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  await postPublic("/auth/local/password/forgot", { email });
}

/** Sets a new password from a reset link. No session: the user signs in after. */
export async function completePasswordReset(token: string, password: string): Promise<void> {
  await postPublic("/auth/local/password/reset", { token, password });
}

/**
 * The proof for step-up: the password, or (strong) a code from the
 * authenticator app or one of the account's passkeys.
 */
export type StepUpProof = { password: string } | { totpCode: string } | { passkey: true };

export async function stepUp(action: StepUpAction, proof: StepUpProof): Promise<string> {
  if ("passkey" in proof) {
    const begin = PasskeyOptionsResponseSchema.parse(
      await request<unknown>("/auth/step-up/passkey/options", { method: "POST", body: JSON.stringify({ action }) })
    );
    const credential = await assertWithPasskey(begin.options);
    const raw = await request<unknown>("/auth/step-up/passkey", {
      method: "POST",
      body: JSON.stringify({ action, challengeId: begin.challengeId, credential })
    });
    return StepUpResponseSchema.parse(raw).stepUpToken;
  }
  const raw = await request<unknown>("/auth/step-up", { method: "POST", body: JSON.stringify({ action, ...proof }) });
  return StepUpResponseSchema.parse(raw).stepUpToken;
}

const withStepUp = (token?: string) => (token ? { headers: { "X-Step-Up": token } } : {});

export async function fetchMySecurity(): Promise<MySecurityResponse> {
  return MySecurityResponseSchema.parse(await request<unknown>("/me/security"));
}

/**
 * Changes the password; every session ends and this one is replaced. An
 * account with an authenticator also needs a strong step-up token.
 */
export function changeMyPassword(currentPassword: string, newPassword: string, stepUpToken?: string): Promise<AuthSessionResponse> {
  return requestNewSession("/me/security/password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword }),
    ...withStepUp(stepUpToken)
  }, AuthSessionResponseSchema);
}

/**
 * Starts adding or replacing the authenticator app. It needs a step-up token
 * (`self.totp_replace`): from the password when the account has no second
 * factor, from a second factor when it has one.
 */
export async function startMyTotp(stepUpToken: string): Promise<TotpEnrollmentResponse> {
  const raw = await request<unknown>("/me/security/totp/start", { method: "POST", body: "{}", ...withStepUp(stepUpToken) });
  return TotpEnrollmentResponseSchema.parse(raw);
}

/** Confirms the app; every session ends and this one is replaced. */
export function confirmMyTotp(code: string): Promise<EnrollmentCompleteResponse> {
  return requestNewSession("/me/security/totp/confirm", { method: "POST", body: JSON.stringify({ code }) }, EnrollmentCompleteResponseSchema);
}

export function removeMyTotp(stepUpToken: string): Promise<AuthSessionResponse> {
  return requestNewSession("/me/security/totp", { method: "DELETE", ...withStepUp(stepUpToken) }, AuthSessionResponseSchema);
}

export async function regenerateMyRecoveryCodes(stepUpToken: string): Promise<string[]> {
  const raw = await request<unknown>("/me/security/recovery-codes", { method: "POST", body: "{}", ...withStepUp(stepUpToken) });
  return RecoveryCodesResponseSchema.parse(raw).recoveryCodes;
}

export async function listMyPasskeys(): Promise<PasskeySummary[]> {
  return PasskeyListResponseSchema.parse(await request<unknown>("/me/security/passkeys")).passkeys;
}

/**
 * Adds a passkey to this account. It needs a step-up token
 * (`self.passkey_add`): from the password when the account has no second
 * factor, from a second factor when it has one. A first second factor also
 * returns a new session and recovery codes.
 */
export async function addMyPasskey(name: string, stepUpToken: string): Promise<MyPasskeyAddedResponse> {
  const begin = PasskeyOptionsResponseSchema.parse(
    await request<unknown>("/me/security/passkeys/options", { method: "POST", body: "{}", ...withStepUp(stepUpToken) })
  );
  const credential = await createPasskey(begin.options);
  // Only a first second factor answers with a new session.
  return requestNewSession("/me/security/passkeys/verify", {
    method: "POST",
    body: JSON.stringify({ challengeId: begin.challengeId, credential, name })
  }, MyPasskeyAddedResponseSchema);
}

const passkeyPath = (id: string) => `/me/security/passkeys/${encodeURIComponent(id)}`;

export async function renameMyPasskey(id: string, name: string): Promise<PasskeySummary> {
  return PasskeySummarySchema.parse(await request<unknown>(passkeyPath(id), { method: "PATCH", body: JSON.stringify({ name }) }));
}

/** Removes a passkey; every session ends and this one is replaced. */
export function removeMyPasskey(id: string, stepUpToken: string): Promise<AuthSessionResponse> {
  return requestNewSession(passkeyPath(id), { method: "DELETE", ...withStepUp(stepUpToken) }, AuthSessionResponseSchema);
}

/**
 * Ends every session of the account, this one too. The answer deletes the
 * refresh cookie, so the session in memory ends before the gate opens. Like
 * a sign-out, it stops a refresh on the wire instead of waiting for it.
 */
export async function signOutEverywhere(): Promise<void> {
  await changeSession(
    (gated) => gated<unknown>("/me/security/sessions/revoke", { method: "POST", body: "{}" }),
    () => null,
    { stopRefresh: true }
  );
}

/** Needs the manager's step-up token (`member.create`). */
export async function createLocalMember(input: CreateLocalMemberRequest, stepUpToken: string): Promise<CreateLocalMemberResponse> {
  const raw = await request<unknown>("/tenant/members", { method: "POST", body: JSON.stringify(input), ...withStepUp(stepUpToken) });
  return CreateLocalMemberResponseSchema.parse(raw);
}

const memberPath = (userId: string, action: string) => `/tenant/members/${encodeURIComponent(userId)}/${action}`;

/** The link goes to the person by email (email on), or to the manager to pass on. */
export async function resetMemberPassword(userId: string, stepUpToken: string): Promise<MemberLinkResponse> {
  const raw = await request<unknown>(memberPath(userId, "password-reset"), {
    method: "POST",
    body: "{}",
    headers: { "X-Step-Up": stepUpToken }
  });
  return MemberLinkResponseSchema.parse(raw);
}

/** Email on only: emails the person a new link. No step-up; the manager never sees the link. */
export async function resendMemberLink(userId: string): Promise<EmailedLink> {
  const raw = await request<unknown>(memberPath(userId, "link/resend"), { method: "POST", body: "{}" });
  return ResendMemberLinkResponseSchema.parse(raw).email;
}

export async function disableMember(userId: string, stepUpToken: string): Promise<void> {
  await request<unknown>(memberPath(userId, "disable"), { method: "POST", body: "{}", headers: { "X-Step-Up": stepUpToken } });
}

export async function enableMember(userId: string, stepUpToken: string): Promise<LocalAccountStatus> {
  const raw = await request<unknown>(memberPath(userId, "enable"), { method: "POST", body: "{}", ...withStepUp(stepUpToken) });
  return MemberStatusResponseSchema.parse(raw).status;
}

export async function resetMemberMfa(userId: string, stepUpToken: string): Promise<void> {
  await request<unknown>(memberPath(userId, "mfa-reset"), { method: "POST", body: "{}", headers: { "X-Step-Up": stepUpToken } });
}

export async function fetchTenantMfaPolicy(): Promise<MfaPolicy> {
  return TenantSecuritySettingsSchema.parse(await request<unknown>("/tenant/settings/security")).mfaPolicy;
}

/** A weaker policy needs an owner's strong step-up token. */
export async function saveTenantMfaPolicy(mfaPolicy: MfaPolicy, stepUpToken?: string): Promise<MfaPolicy> {
  const raw = await request<unknown>("/tenant/settings/security", {
    method: "PUT",
    body: JSON.stringify({ mfaPolicy }),
    ...withStepUp(stepUpToken)
  });
  return TenantSecuritySettingsSchema.parse(raw).mfaPolicy;
}

export async function signOutMember(userId: string): Promise<void> {
  await request<unknown>(memberPath(userId, "sessions/revoke"), { method: "POST", body: "{}" });
}

/**
 * The backend refused the step-up token (a missing, used, or expired one, or
 * a password where a second factor is needed). A new proof can fix it.
 */
export function isStepUpRefusal(error: unknown): boolean {
  const code = localAuthErrorCode(error);
  return code === "step_up_required" || code === "strong_step_up_required";
}

/** The backend error code of a failed call, from either client path. */
export function localAuthErrorCode(error: unknown): string | null {
  if (error instanceof LocalAuthError) return error.code;
  if (error instanceof PasskeyCeremonyError) return error.code;
  if (error instanceof ApiError) return error.code ?? null;
  return null;
}

const MESSAGES: Record<string, string> = {
  invalid_credentials: "The email or password is not correct.",
  too_many_attempts: "Too many attempts. Wait a moment, then try again.",
  busy: "Sign-in is busy. Try again in a moment.",
  rate_limiter_unavailable: "Sign-in is unavailable right now. Try again in a moment.",
  link_invalid: "This link is not valid any more, or it was already used. Ask for a new one.",
  limit_exceeded: "Too many requests from this network. Wait a moment, then try again.",
  email_off: "This organization does not send email. Use \u201cReset password\u201d to get a link to pass on.",
  link_sent_recently: "A link was sent less than a minute ago. Wait a moment, then try again.",
  no_email_address: "This account has no email address, so no link can be sent to it.",
  password_too_short: "Use at least 15 characters.",
  password_too_long: "Use at most 128 characters.",
  password_too_common: "This password is too common. Choose another one.",
  password_contains_email: "Do not use your email address in your password.",
  email_in_use: "An account with this email address already exists.",
  email_invalid: "Enter a valid email address.",
  wrong_login_type: "Your organization does not use local accounts.",
  step_up_required: "Confirm your password again, then repeat the action.",
  cannot_manage_owner: "Nobody can change an owner's account here.",
  only_owner_can_manage_admin: "Only an owner can do this for an administrator.",
  only_owner_can_assign_admin: "Only an owner can add an administrator.",
  only_owner_can_assign_owner: "Only an owner can add an owner.",
  account_not_active: "A new person cannot be an owner. Make them an owner after they set up their account.",
  account_state_conflict: "The account changed. Reload the page and try again.",
  concurrent_change: "The account changed. Reload the page and try again.",
  csrf_origin_mismatch: "This page cannot sign you in. Open the app from its own address.",
  invalid_code: "That code is not correct, or it was already used. Try the next code from your app.",
  sign_in_expired: "This sign-in took too long. Start again.",
  session_changed: "Your account changed. Sign in again.",
  enrollment_not_started: "The setup took too long. Start again to get a new QR code.",
  mfa_required: "Your organization requires two-step verification, so you cannot turn it off.",
  no_second_factor: "Set up an authenticator app or a passkey first.",
  strong_step_up_required: "Confirm with your authenticator app or a passkey.",
  passkey_not_accepted: "This passkey was not accepted. Try again, or use another way to sign in.",
  passkey_exists: "This passkey is already on your account.",
  passkey_limit: "Your account has the maximum number of passkeys. Remove one first.",
  passkey_not_found: "This passkey is not on your account any more.",
  passkey_cancelled: "The passkey request was cancelled or took too long. Try again.",
  passkey_unsupported: "This browser cannot use passkeys.",
  ceremony_expired: "This took too long. Try again.",
  policy_changed: "Someone changed this rule a moment ago. Check it and save again.",
  only_owner_can_weaken_policy: "Only an owner can make the two-step verification rule weaker.",
  network_error: "The server cannot be reached. Check your connection and try again."
};

export function localAuthMessage(error: unknown, fallback: string): string {
  const code = localAuthErrorCode(error);
  return (code && MESSAGES[code]) || fallback;
}
