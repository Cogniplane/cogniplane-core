import { z } from "zod";

// Contracts for local accounts and the shared session routes
// (docs/architecture/local-accounts.md).

/** NIST SP 800-63B-4 minimum when the password is the only factor. */
export const PASSWORD_MIN_LENGTH = 15;
export const PASSWORD_MAX_LENGTH = 128;
/** Longest input the backend reads as a password; longer is refused before hashing. */
export const PASSWORD_INPUT_MAX_LENGTH = 1024;

export const LoginTypeSchema = z.enum(["workos", "local"]);
export type LoginType = z.infer<typeof LoginTypeSchema>;

export const LocalAccountStatusSchema = z.enum(["pending_setup", "active", "disabled", "removed"]);
export type LocalAccountStatus = z.infer<typeof LocalAccountStatusSchema>;

/** GET /auth/config — public in every mode. */
export const AuthConfigResponseSchema = z.object({
  mode: z.enum(["jwt", "dev-headers"]),
  loginTypes: z.array(LoginTypeSchema),
  /** Self-service "forgot password" by email: local login with SMTP set. */
  passwordRecovery: z.boolean(),
  passkeys: z.boolean()
});
export type AuthConfigResponse = z.infer<typeof AuthConfigResponseSchema>;

const PasswordInputSchema = z.string().min(1).max(PASSWORD_INPUT_MAX_LENGTH);

export const LocalLoginRequestSchema = z.object({
  email: z.string().min(1).max(320),
  password: PasswordInputSchema
});
export type LocalLoginRequest = z.infer<typeof LocalLoginRequestSchema>;

export const SessionUserSchema = z.object({
  userId: z.string(),
  email: z.string(),
  displayName: z.string(),
  tenantId: z.string(),
  role: z.enum(["owner", "admin", "member"])
});
export type SessionUser = z.infer<typeof SessionUserSchema>;

/** Answer of every route that starts a session. */
export const AuthSessionResponseSchema = z.object({
  accessToken: z.string(),
  user: SessionUserSchema
});
export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>;

/** A sign-in step is still due: the second factor, or a forced enrolment. */
export const NextStepResponseSchema = z.object({
  next: z.enum(["mfa", "enroll"]),
  methods: z.array(z.enum(["totp", "passkey", "recovery_code"])).optional()
});
export type NextStepResponse = z.infer<typeof NextStepResponseSchema>;

/** POST /auth/local/login and POST /auth/local/setup. */
export const LocalSignInResponseSchema = z.union([AuthSessionResponseSchema, NextStepResponseSchema]);
export type LocalSignInResponse = z.infer<typeof LocalSignInResponseSchema>;

/** POST /auth/local/mfa/totp, /auth/local/mfa/recovery, /auth/local/enroll/totp/confirm, /me/security/totp/confirm. */
export const SecondFactorCodeRequestSchema = z.object({ code: z.string().min(6).max(32) });
export type SecondFactorCodeRequest = z.infer<typeof SecondFactorCodeRequestSchema>;

/** The secret to add to an authenticator app, as text and as a QR-code link. */
export const TotpEnrollmentResponseSchema = z.object({ secret: z.string(), otpauthUri: z.string() });
export type TotpEnrollmentResponse = z.infer<typeof TotpEnrollmentResponseSchema>;

/** A confirmed enrolment: a new session and the new recovery codes, shown once. */
export const EnrollmentCompleteResponseSchema = AuthSessionResponseSchema.extend({
  recoveryCodes: z.array(z.string())
});
export type EnrollmentCompleteResponse = z.infer<typeof EnrollmentCompleteResponseSchema>;

export const RecoveryCodesResponseSchema = z.object({ recoveryCodes: z.array(z.string()) });
export type RecoveryCodesResponse = z.infer<typeof RecoveryCodesResponseSchema>;

export const MfaPolicySchema = z.enum(["optional", "required_for_admins", "required_for_all"]);
export type MfaPolicy = z.infer<typeof MfaPolicySchema>;

/** GET and PUT /tenant/settings/security (local tenants). */
export const TenantSecuritySettingsSchema = z.object({ mfaPolicy: MfaPolicySchema });
export type TenantSecuritySettings = z.infer<typeof TenantSecuritySettingsSchema>;

/** POST /auth/local/setup and POST /auth/local/password/reset. */
export const LinkRedeemRequestSchema = z.object({
  token: z.string().min(1).max(128),
  password: PasswordInputSchema
});
export type LinkRedeemRequest = z.infer<typeof LinkRedeemRequestSchema>;

/**
 * POST /auth/local/password/forgot. Always answers 202 `{ ok: true }`, for
 * every address, so the answer tells nothing about accounts.
 */
export const ForgotPasswordRequestSchema = z.object({
  email: z.string().min(1).max(320)
});
export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordRequestSchema>;

/**
 * The actions that need step-up. The backend's list of step-up routes
 * (services/auth/step-up-routes.ts) gives each route one of them. The
 * actions from `tenant.provider_key` to `integration.overlay_settings` are
 * tenant settings that change where the tenant's data goes;
 * `integration.overlay_settings` belongs to a route that an optional overlay
 * adds. The `policy.*` and `tenant.pii_settings` actions are changes that
 * make a control weaker; the `skill.*` actions release a skill to users, and
 * `tenant.skill_marketplace` sets where skills are imported from.
 */
export const StepUpActionSchema = z.enum([
  "member.create",
  "member.role_change",
  "member.password_reset",
  "member.disable",
  "member.enable",
  "member.remove",
  "member.mfa_reset",
  "tenant.mfa_policy",
  "self.password_change",
  "self.totp_replace",
  "self.totp_remove",
  "self.recovery_codes",
  "self.passkey_add",
  "self.passkey_remove",
  "tenant.provider_key",
  "tenant.settings",
  "mcp_server.create",
  "mcp_server.update",
  "mcp_server.setup_create",
  "mcp_server.setup_update",
  "mcp_server.inherited_audience",
  "mcp_server.widget_domain",
  "integration.update",
  "integration.overlay_settings",
  "policy.rule_create",
  "policy.rule_update",
  "policy.rule_delete",
  "policy.rule_order",
  "tenant.pii_settings",
  "tenant.skill_marketplace",
  "skill.revision_activate",
  "skill.publish",
  "skill.submission_release",
  "skill.project_release"
]);
export type StepUpAction = z.infer<typeof StepUpActionSchema>;

/**
 * The 403 answer of a route that needs step-up. `action` names the step-up
 * action to prove; the client gets a token for it (POST /auth/step-up) and
 * sends the same request again with the token in the X-Step-Up header.
 * `strong_step_up_required`: the account has a second factor, and the proof
 * must use it.
 */
export const StepUpRefusalSchema = z.object({
  error: z.enum(["step_up_required", "strong_step_up_required"]),
  action: StepUpActionSchema
});
export type StepUpRefusal = z.infer<typeof StepUpRefusalSchema>;

/**
 * POST /auth/step-up. The answer's token goes in the X-Step-Up header of one
 * request. The proof is the password or a code from the authenticator app;
 * an account with a second factor must use the code (strong step-up).
 */
export const StepUpRequestSchema = z.union([
  z.object({ action: StepUpActionSchema, password: PasswordInputSchema }).strict(),
  z.object({ action: StepUpActionSchema, totpCode: z.string().min(6).max(12) }).strict()
]);
export type StepUpRequest = z.infer<typeof StepUpRequestSchema>;

// ---- Passkeys (WebAuthn) ----
// The ceremony's JSON, as @simplewebauthn/browser produces it. The backend
// library checks the content; these schemas only bound the shape and size.

const B64 = z.string().max(16_384);

export const PasskeyRegistrationCredentialSchema = z.object({
  id: z.string().min(1).max(1_024),
  rawId: z.string().min(1).max(1_024),
  type: z.literal("public-key"),
  response: z.object({
    clientDataJSON: B64,
    attestationObject: B64,
    authenticatorData: B64.optional(),
    transports: z.array(z.string().max(32)).max(10).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: B64.optional()
  }),
  authenticatorAttachment: z.string().max(32).optional(),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({})
});
export type PasskeyRegistrationCredential = z.infer<typeof PasskeyRegistrationCredentialSchema>;

export const PasskeyAssertionCredentialSchema = z.object({
  id: z.string().min(1).max(1_024),
  rawId: z.string().min(1).max(1_024),
  type: z.literal("public-key"),
  response: z.object({
    clientDataJSON: B64,
    authenticatorData: B64,
    signature: B64,
    userHandle: z.string().max(1_024).optional()
  }),
  authenticatorAttachment: z.string().max(32).optional(),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({})
});
export type PasskeyAssertionCredential = z.infer<typeof PasskeyAssertionCredentialSchema>;

const PasskeyNameSchema = z.string().trim().min(1).max(64);

/**
 * Options for the browser's WebAuthn call (`optionsJSON` of
 * @simplewebauthn/browser), plus the id of the challenge record when the
 * caller must send it back (signed-in routes; the public routes use a cookie).
 */
export const PasskeyOptionsResponseSchema = z.object({
  options: z.record(z.string(), z.unknown()),
  challengeId: z.string().optional()
});
export type PasskeyOptionsResponse = z.infer<typeof PasskeyOptionsResponseSchema>;

/** POST /auth/passkey/login/verify (passwordless) and POST /auth/local/mfa/passkey/verify (second factor). */
export const PasskeyLoginVerifyRequestSchema = z.object({ credential: PasskeyAssertionCredentialSchema });
export type PasskeyLoginVerifyRequest = z.infer<typeof PasskeyLoginVerifyRequestSchema>;

/** POST /auth/local/enroll/passkey/verify (sign-in enrolment). */
export const PasskeyEnrollVerifyRequestSchema = z.object({
  credential: PasskeyRegistrationCredentialSchema,
  name: PasskeyNameSchema.optional()
});
export type PasskeyEnrollVerifyRequest = z.infer<typeof PasskeyEnrollVerifyRequestSchema>;

/** POST /me/security/passkeys/verify. */
export const MyPasskeyVerifyRequestSchema = PasskeyEnrollVerifyRequestSchema.extend({ challengeId: z.string().min(1).max(128) });
export type MyPasskeyVerifyRequest = z.infer<typeof MyPasskeyVerifyRequestSchema>;

export const PasskeySummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  /** Synced across devices (for example by a password manager). */
  backedUp: z.boolean()
});
export type PasskeySummary = z.infer<typeof PasskeySummarySchema>;

/** GET /me/security/passkeys. */
export const PasskeyListResponseSchema = z.object({ passkeys: z.array(PasskeySummarySchema) });
export type PasskeyListResponse = z.infer<typeof PasskeyListResponseSchema>;

/**
 * POST /me/security/passkeys/verify. A first second factor also starts a new
 * session (older ones end) and returns recovery codes, shown once.
 */
export const MyPasskeyAddedResponseSchema = z.object({
  passkey: PasskeySummarySchema,
  accessToken: z.string().optional(),
  user: SessionUserSchema.optional(),
  recoveryCodes: z.array(z.string()).optional()
});
export type MyPasskeyAddedResponse = z.infer<typeof MyPasskeyAddedResponseSchema>;

/** PATCH /me/security/passkeys/:id. */
export const PasskeyRenameRequestSchema = z.object({ name: PasskeyNameSchema });
export type PasskeyRenameRequest = z.infer<typeof PasskeyRenameRequestSchema>;

/** POST /auth/step-up/passkey/options. */
export const PasskeyStepUpOptionsRequestSchema = z.object({ action: StepUpActionSchema });
export type PasskeyStepUpOptionsRequest = z.infer<typeof PasskeyStepUpOptionsRequestSchema>;

/** POST /auth/step-up/passkey: answers StepUpResponse. */
export const PasskeyStepUpRequestSchema = z.object({
  action: StepUpActionSchema,
  challengeId: z.string().min(1).max(128),
  credential: PasskeyAssertionCredentialSchema
});
export type PasskeyStepUpRequest = z.infer<typeof PasskeyStepUpRequestSchema>;

export const StepUpResponseSchema = z.object({
  stepUpToken: z.string(),
  expiresInSeconds: z.number().int()
});
export type StepUpResponse = z.infer<typeof StepUpResponseSchema>;

/** GET /me/security. */
export const MySecurityResponseSchema = z.object({
  loginType: LoginTypeSchema,
  passwordChangedAt: z.string().nullable(),
  totpEnabled: z.boolean().default(false),
  passkeyCount: z.number().int().default(0),
  recoveryCodesRemaining: z.number().int().default(0),
  /** The tenant policy or a manager reset asks this account for a second factor. */
  mfaRequired: z.boolean().default(false)
});
export type MySecurityResponse = z.infer<typeof MySecurityResponseSchema>;

/** POST /me/security/password. Answers AuthSessionResponse: a new session. */
export const PasswordChangeRequestSchema = z.object({
  currentPassword: PasswordInputSchema,
  newPassword: PasswordInputSchema
});
export type PasswordChangeRequest = z.infer<typeof PasswordChangeRequestSchema>;

export const IssuedLinkSchema = z.object({
  url: z.string(),
  expiresAt: z.string(),
  purpose: z.enum(["account_setup", "password_reset"])
});
export type IssuedLink = z.infer<typeof IssuedLinkSchema>;

/** POST /tenant/members (local tenants only). */
export const CreateLocalMemberRequestSchema = z.object({
  email: z.string().min(3).max(320),
  displayName: z.string().trim().max(200).optional(),
  role: z.enum(["owner", "admin", "member"])
});
export type CreateLocalMemberRequest = z.infer<typeof CreateLocalMemberRequestSchema>;

/** A link sent to the person by email. The manager never sees the link itself. */
export const EmailedLinkSchema = z.object({
  to: z.string(),
  expiresAt: z.string(),
  purpose: z.enum(["account_setup", "password_reset"])
});
export type EmailedLink = z.infer<typeof EmailedLinkSchema>;

/**
 * Exactly one of the two is set: with email on, the link goes to the person
 * (`email`); with email off, the manager gets it to send (`link`).
 */
const LinkDeliveryFields = {
  link: IssuedLinkSchema.nullable(),
  email: EmailedLinkSchema.nullable()
};

export const CreateLocalMemberResponseSchema = z.object({
  userId: z.string(),
  ...LinkDeliveryFields
});
export type CreateLocalMemberResponse = z.infer<typeof CreateLocalMemberResponseSchema>;

/** POST /tenant/members/:userId/password-reset. */
export const MemberLinkResponseSchema = z.object(LinkDeliveryFields);
export type MemberLinkResponse = z.infer<typeof MemberLinkResponseSchema>;

/** POST /tenant/members/:userId/link/resend (email on only). */
export const ResendMemberLinkResponseSchema = z.object({ email: EmailedLinkSchema });
export type ResendMemberLinkResponse = z.infer<typeof ResendMemberLinkResponseSchema>;

/** The latest email that carried a link to a local account, for managers. */
export const LinkEmailStatusSchema = z.object({
  purpose: z.enum(["account_setup", "password_reset"]),
  status: z.enum(["queued", "sending", "sent", "failed", "expired"]),
  updatedAt: z.string(),
  /** A short error code from the last attempt (never server text), or null. */
  error: z.string().nullable()
});
export type LinkEmailStatus = z.infer<typeof LinkEmailStatusSchema>;

/** POST /tenant/members/:userId/enable. */
export const MemberStatusResponseSchema = z.object({ status: LocalAccountStatusSchema });
export type MemberStatusResponse = z.infer<typeof MemberStatusResponseSchema>;
