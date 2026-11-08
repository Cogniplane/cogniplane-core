import type { FastifyReply, FastifyRequest } from "fastify";

import { type AppConfig, arePasskeysEnabled, isMailEnabled } from "../../config.js";
import type { Pool } from "../../lib/db.js";
import type { AuthMethod } from "../../lib/jwt.js";
import { PasswordHasher } from "../../lib/password-hash.js";
import { MailOutbox } from "../mail/mail-outbox.js";
import { LocalAccountService } from "./local-account-service.js";
import { LocalMfaService } from "./local-mfa-service.js";
import { LocalPasskeyService } from "./local-passkey-service.js";
import { LoginFlowStore } from "./login-flow-store.js";
import { PasskeyChallengeStore } from "./passkey-challenge-store.js";
import { type LoginThrottle, RedisLoginThrottle } from "./login-throttle.js";
import type { RefreshTokenRotationService } from "./refresh-token-rotation-service.js";
import type { AfterSecurityChange } from "./security-change.js";
import { STEP_UP_ROUTES, type StepUpRoute } from "./step-up-routes.js";
import { type StepUpAction, StepUpStore } from "./step-up-store.js";

/** Everything local login needs, built once per app. */
export type LocalAuth = {
  accounts: LocalAccountService;
  mfa: LocalMfaService;
  /** Null when passkeys are off (no WEBAUTHN_RP_ID). */
  passkeys: LocalPasskeyService | null;
  challenges: PasskeyChallengeStore;
  flows: LoginFlowStore;
  hasher: PasswordHasher;
  throttle: LoginThrottle;
  stepUp: StepUpStore;
  refreshTokens: RefreshTokenRotationService;
};

type LocalAuthRedis = ConstructorParameters<typeof RedisLoginThrottle>[0] &
  ConstructorParameters<typeof StepUpStore>[0] &
  ConstructorParameters<typeof LoginFlowStore>[0] &
  ConstructorParameters<typeof PasskeyChallengeStore>[0];

export function buildLocalAuth(input: {
  config: AppConfig;
  /** app_user pool. */
  db: Pool;
  /** Maintenance pool, for the lookups before the tenant is known. */
  lookupDb: Pool;
  redis: LocalAuthRedis;
  refreshTokens: RefreshTokenRotationService;
  /** After the commit of a new security version: stops the account's active work. */
  afterSecurityChange: AfterSecurityChange;
}): LocalAuth {
  const hasher = new PasswordHasher(input.config.LOCAL_AUTH_HASH_CONCURRENCY);
  // Without email, no notice is queued: there is nothing to send it with.
  const notices = isMailEnabled(input.config) ? new MailOutbox({ secret: input.config.DATA_ENCRYPTION_SECRET }) : null;
  return {
    hasher,
    accounts: new LocalAccountService({
      db: input.db,
      lookupDb: input.lookupDb,
      hasher,
      frontendOrigin: input.config.API_ORIGIN,
      notices,
      afterSecurityChange: input.afterSecurityChange
    }),
    mfa: new LocalMfaService({
      db: input.db, secret: input.config.DATA_ENCRYPTION_SECRET, issuer: "Cogniplane", notices,
      afterSecurityChange: input.afterSecurityChange
    }),
    passkeys: arePasskeysEnabled(input.config)
      ? new LocalPasskeyService({
          db: input.db,
          lookupDb: input.lookupDb,
          secret: input.config.DATA_ENCRYPTION_SECRET,
          rpId: input.config.WEBAUTHN_RP_ID!,
          rpName: input.config.WEBAUTHN_RP_NAME,
          origin: input.config.API_ORIGIN,
          notices,
          afterSecurityChange: input.afterSecurityChange
        })
      : null,
    challenges: new PasskeyChallengeStore(input.redis),
    flows: new LoginFlowStore(input.redis),
    throttle: new RedisLoginThrottle(input.redis, input.config.DATA_ENCRYPTION_SECRET),
    stepUp: new StepUpStore(input.redis),
    refreshTokens: input.refreshTokens
  };
}

/**
 * Consumes the step-up token in the X-Step-Up header for the action of this
 * route (step-up-routes.ts). It must belong to this user, tenant, session
 * family, and security version, and the session family must still be active
 * (a logout ends it). When the account has a second factor (an authenticator
 * app or a passkey), the proof must have used one (strong step-up): a stolen
 * password and session must not change credentials. Returns the proof's
 * methods. Writes a 403 `step_up_required` or `strong_step_up_required`,
 * with the action, and returns null otherwise. A session that is not local
 * (WorkOS) always gets `step_up_required`. See docs/architecture/local-accounts.md.
 */
export async function requireStepUp(
  request: FastifyRequest,
  reply: FastifyReply,
  localAuth: Pick<LocalAuth, "stepUp" | "refreshTokens" | "mfa">,
  route: StepUpRoute
): Promise<AuthMethod[] | null> {
  return requireStepUpForAction(request, reply, localAuth, STEP_UP_ROUTES[route]);
}

/**
 * The same check for an action that has no route in step-up-routes.ts: an
 * action that an overlay's route gives (OVERLAY_STEP_UP_ACTIONS).
 */
export async function requireStepUpForAction(
  request: FastifyRequest,
  reply: FastifyReply,
  localAuth: Pick<LocalAuth, "stepUp" | "refreshTokens" | "mfa">,
  action: StepUpAction
): Promise<AuthMethod[] | null> {
  const session = request.auth.session;
  const familyId = session?.familyId;
  const securityVersion = session?.securityVersion;
  if (session?.authSource !== "local" || !familyId || securityVersion === undefined) {
    reply.code(403).send({ error: "step_up_required", action });
    return null;
  }
  const amr = await localAuth.stepUp.consume(request.headers["x-step-up"], {
    userId: request.auth.userId,
    tenantId: request.auth.tenantId,
    familyId,
    securityVersion,
    action
  });
  if (!amr || !(await localAuth.refreshTokens.isActive(familyId))) {
    reply.code(403).send({ error: "step_up_required", action });
    return null;
  }
  if (!isStrongProof(amr) && (await localAuth.mfa.hasSecondFactor(request.auth.tenantId, request.auth.userId))) {
    reply.code(403).send({ error: "strong_step_up_required", action });
    return null;
  }
  return amr;
}

/** A proof that used a second factor. */
export function isStrongProof(amr: readonly AuthMethod[]): boolean {
  return amr.includes("otp") || amr.includes("pkey");
}
