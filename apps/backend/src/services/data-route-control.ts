import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import type { AuthMode, LoginType } from "../config.js";
import type { RequestLimitsInterface } from "./request-limits.js";
import { type LocalAuth, requireStepUpForAction } from "./auth/local-auth.js";
import { type OverlayStepUpAction, STEP_UP_ROUTES, type StepUpRoute } from "./auth/step-up-routes.js";
import type { StepUpAction } from "./auth/step-up-store.js";
import type { OwnerNoticeQueue } from "./mail/mail-outbox.js";
import type { DataSettingChange } from "./mail/setting-change-notices.js";
import { WeakerChangeError } from "./weaker-change-error.js";

// The checks of a data route: a tenant setting that changes where the
// tenant's data goes (docs/ARCHITECTURE.md, "Authentication"). With a stolen
// owner or admin access token, a changed provider key or MCP server address
// sends every user's prompts and data to another server, and the change
// stays after the victim's password change or "sign out everywhere". So:
//
// 1. Step-up. A local session gives a single-use step-up token for the
//    route's action, as for the account routes (requireStepUp). A WorkOS
//    session gives none: Cogniplane cannot ask WorkOS for a fresh proof, and
//    WorkOS owns that sign-in (the rule of a member role change). A session's
//    login path always equals its tenant's login type (auth-admission.ts), so
//    a local tenant never skips the check. dev-headers mode has no sessions
//    (development only).
// 2. Owner notice. Every change, from every kind of session, queues an email
//    to each owner of the tenant, in the change's transaction. For a WorkOS
//    session it is the only check. With email off, the change's audit event
//    is the only record, and startup logs a warning when WorkOS login is on.
//    The outbox combines the notices of one owner (mail-outbox.ts).
// 3. Rate limit. A data route outside /admin/ (the provider key, an
//    overlay's route) uses the admin limit too: the admin hook in app.ts
//    limits only /admin/ requests.
//
// The same checks protect a change that makes a control weaker for every
// user (Policy Center rules, PII protection) and a skill release, which
// gives instructions to every user's agent: a stolen token could otherwise
// open a blocked tool, send unmasked personal data to the model provider, or
// give the agent instructions that stay after the victim signs out.

/** Logged at startup when WorkOS tenants have no check at all on data routes. */
export const NO_OWNER_NOTICE_WARNING =
  "WorkOS login is on and email is off (SMTP_URL, MAIL_FROM): a change of a data setting by a WorkOS session " +
  "needs no step-up and sends no owner notice. Only the audit log records it. Set SMTP_URL and MAIL_FROM.";

export class DataRouteControl {
  constructor(
    private readonly deps: {
      authMode: AuthMode;
      loginTypes?: readonly LoginType[];
      /** Set when local login is on. */
      localAuth?: Pick<LocalAuth, "stepUp" | "refreshTokens" | "mfa">;
      /** Null when email is off. */
      ownerNotices: OwnerNoticeQueue | null;
      limits?: Pick<RequestLimitsInterface, "consumeRateLimit">;
      logger?: Pick<FastifyBaseLogger, "warn">;
    }
  ) {
    if (deps.loginTypes?.includes("workos") && !deps.ownerNotices) deps.logger?.warn(NO_OWNER_NOTICE_WARNING);
  }

  /**
   * Step-up for a data route in step-up-routes.ts. Writes the refusal (403,
   * with the action) and returns false when the request must stop.
   */
  requireStepUp(request: FastifyRequest, reply: FastifyReply, route: StepUpRoute): Promise<boolean> {
    return this.check(request, reply, STEP_UP_ROUTES[route]);
  }

  /** The same check for an overlay's data route, which the core list cannot name. */
  requireStepUpForOverlay(request: FastifyRequest, reply: FastifyReply, action: OverlayStepUpAction): Promise<boolean> {
    return this.check(request, reply, action);
  }

  /**
   * A route that needs step-up only when its change makes a control weaker
   * (Policy Center rules, PII protection). `write` classifies the change in
   * its own transaction, against the locked data, and throws
   * WeakerChangeError when the change is weaker and `allowWeaker` is false;
   * the transaction rolls back. Then this asks for step-up and calls `write`
   * again with `allowWeaker`. A classification against a copy read before
   * the transaction could let a weaker change skip step-up after a
   * concurrent change. Returns null when the step-up check refused the
   * request (the refusal is written).
   */
  async writeWithStepUpIfWeaker<T>(
    request: FastifyRequest,
    reply: FastifyReply,
    route: StepUpRoute,
    write: (allowWeaker: boolean) => Promise<T>
  ): Promise<{ saved: T } | null> {
    try {
      return { saved: await write(false) };
    } catch (error) {
      if (!(error instanceof WeakerChangeError)) throw error;
    }
    if (!(await this.requireStepUp(request, reply, route))) return null;
    return { saved: await write(true) };
  }

  /**
   * The owner notice of a change, for the change's audit event
   * (AuditEventInput.alsoInTransaction), so it commits with the change.
   * Undefined when email is off.
   */
  ownerNotice(request: FastifyRequest, change: DataSettingChange): ((client: PoolClient) => Promise<void>) | undefined {
    const queue = this.deps.ownerNotices;
    if (!queue) return undefined;
    const { tenantId, userId } = request.auth;
    return async (client) => {
      const reached = await queue.queueOwnerNotice(client, tenantId, { actorUserId: userId, change });
      if (reached === 0) {
        this.deps.logger?.warn({ tenantId, setting: change.setting },
          "A data setting changed, but no owner of the tenant has an email address: the notice reached nobody");
      }
    };
  }

  private async check(request: FastifyRequest, reply: FastifyReply, action: StepUpAction): Promise<boolean> {
    if (!(await this.withinRateLimit(request, reply))) return false;
    if (this.deps.authMode === "dev-headers") return true;
    if (request.auth.session?.authSource === "workos") return true;
    if (!this.deps.localAuth) {
      reply.code(403).send({ error: "step_up_required", action });
      return false;
    }
    return (await requireStepUpForAction(request, reply, this.deps.localAuth, action)) !== null;
  }

  /** The admin limit for a data route outside /admin/. Writes a 429 and returns false when it is used up. */
  private async withinRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    // The admin hook (app.ts) already counts every /admin/ request.
    if (!this.deps.limits || request.url.startsWith("/admin/")) return true;
    const limited = await this.deps.limits.consumeRateLimit({
      resource: "admin_query",
      userId: request.auth.userId,
      tenantId: request.auth.tenantId
    });
    if (!limited) return true;
    reply.code(429);
    reply.header("retry-after", Math.max(1, Math.ceil(limited.retryAfterMs / 1000)));
    reply.send(limited);
    return false;
  }
}
