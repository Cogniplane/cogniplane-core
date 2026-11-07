import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { CreateLocalMemberRequestSchema, TenantSecuritySettingsSchema } from "@cogniplane/shared-types";

import { requireRole } from "../lib/rbac.js";
import { parseRequestInput } from "../lib/route-validation.js";
import { LocalAccountError, managerMayAct, type RequestMeta } from "../services/auth/local-account-service.js";
import { type LocalAuth, requireStepUp } from "../services/auth/local-auth.js";
import { MFA_POLICIES } from "../services/auth/local-mfa-service.js";

// Manager actions on local accounts (docs/ARCHITECTURE.md, "Authentication").
// Same rights as the role routes in tenant.ts: owner and admin manage; nobody
// acts on themselves; nobody acts on an owner; only an owner acts on an admin
// or creates an admin. Nobody creates an owner here: a new account is not
// active yet, so the service refuses it (account_not_active, 409), and an
// owner promotes the person after setup. Every action that gives sign-in to
// an account or ends it needs step-up (services/auth/step-up-routes.ts):
// create, password reset, disable, enable, and second-factor reset. With
// email off, the manager gets the new account's setup link, and with email on
// it goes to the address the manager typed: a stolen access token alone must
// not create an account that outlives the victim's password change. Every
// action writes an audit event in its own transaction (LocalAccountService).
// With email on, setup and reset links go to the person by email, and the
// manager sees only where they went.

const memberParamsSchema = z.object({
  userId: z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9-_]*$/)
});

function requestMeta(request: FastifyRequest): RequestMeta {
  return { ipAddress: request.ip, userAgent: request.headers["user-agent"] ?? null };
}

function sendServiceError(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof LocalAccountError) {
    reply.code(error.status).send({ error: error.code });
    return true;
  }
  return false;
}

/**
 * The caller, with the security version of a local session: a change of the
 * caller's own account (a new factor, a new password) after the session's
 * checks refuses the action under the tenant lock (member-authority.ts).
 */
function managerActor(request: FastifyRequest) {
  return { userId: request.auth.userId, securityVersion: request.auth.session?.securityVersion };
}

export async function registerLocalMemberRoutes(
  app: FastifyInstance,
  { localAuth }: { localAuth: LocalAuth }
): Promise<void> {
  const { accounts } = localAuth;

  /**
   * Checks the manager's rights on the target. Writes the refusal and returns
   * null when the request must stop.
   */
  async function resolveTarget(request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    if (!requireRole(request, reply, "owner", "admin")) return null;
    const params = parseRequestInput(reply, memberParamsSchema, request.params);
    if (!params.ok) {
      reply.send(params.response);
      return null;
    }
    const targetUserId = params.value.userId;
    const target = await accounts.getMemberState(request.auth.tenantId, targetUserId);
    if (!target) {
      reply.code(404).send({ error: "member_not_found" });
      return null;
    }
    const refusal = managerMayAct(request.auth, { userId: targetUserId, role: target.role });
    if (refusal) {
      reply.code(refusal === "cannot_manage_self" ? 400 : 403).send({ error: refusal });
      return null;
    }
    return targetUserId;
  }

  app.post("/tenant/members", async (request, reply) => {
    if (!requireRole(request, reply, "owner", "admin")) return;
    const body = parseRequestInput(reply, CreateLocalMemberRequestSchema, request.body);
    if (!body.ok) return body.response;
    // Same rule as role changes: an admin who could mint admins could
    // entrench accomplices the owner cannot remove in one action.
    if (body.value.role !== "member" && request.auth.role !== "owner") {
      return reply.code(403).send({ error: body.value.role === "owner" ? "only_owner_can_assign_owner" : "only_owner_can_assign_admin" });
    }
    // The new account is always local, so this always needs step-up. A
    // WorkOS session cannot give one; a WorkOS tenant has no local accounts.
    if (!(await requireStepUp(request, reply, localAuth, "POST /tenant/members"))) return reply;
    try {
      const created = await accounts.createMember({
        tenantId: request.auth.tenantId,
        email: body.value.email,
        displayName: body.value.displayName || null,
        role: body.value.role,
        actorUserId: request.auth.userId,
        actorVersion: request.auth.session?.securityVersion,
        meta: requestMeta(request)
      });
      return reply.code(201).send(created);
    } catch (error) {
      if (sendServiceError(reply, error)) return reply;
      throw error;
    }
  });

  app.post("/tenant/members/:userId/password-reset", async (request, reply) => {
    const targetUserId = await resolveTarget(request, reply);
    if (!targetUserId) return reply;
    if (!(await requireStepUp(request, reply, localAuth, "POST /tenant/members/:userId/password-reset"))) return reply;
    try {
      const delivery = await accounts.resetMemberPassword(request.auth.tenantId, targetUserId, managerActor(request), requestMeta(request));
      return reply.send(delivery);
    } catch (error) {
      if (sendServiceError(reply, error)) return reply;
      throw error;
    }
  });

  // Email on only: a new link by email, for a lost or late one. No step-up:
  // it changes no session, and the manager never sees the link.
  app.post("/tenant/members/:userId/link/resend", async (request, reply) => {
    const targetUserId = await resolveTarget(request, reply);
    if (!targetUserId) return reply;
    try {
      const email = await accounts.resendMemberLink(request.auth.tenantId, targetUserId, managerActor(request), requestMeta(request));
      return reply.send({ email });
    } catch (error) {
      if (sendServiceError(reply, error)) return reply;
      throw error;
    }
  });

  app.post("/tenant/members/:userId/disable", async (request, reply) => {
    const targetUserId = await resolveTarget(request, reply);
    if (!targetUserId) return reply;
    if (!(await requireStepUp(request, reply, localAuth, "POST /tenant/members/:userId/disable"))) return reply;
    // After the commit, the service stops the member's active work
    // (services/auth/security-change.ts).
    try {
      await accounts.disableMember(request.auth.tenantId, targetUserId, managerActor(request), requestMeta(request));
    } catch (error) {
      if (sendServiceError(reply, error)) return reply;
      throw error;
    }
    return reply.send({ status: "disabled" });
  });

  // The account's password works again, so this gives sign-in back: it
  // needs step-up, as disable does.
  app.post("/tenant/members/:userId/enable", async (request, reply) => {
    const targetUserId = await resolveTarget(request, reply);
    if (!targetUserId) return reply;
    if (!(await requireStepUp(request, reply, localAuth, "POST /tenant/members/:userId/enable"))) return reply;
    try {
      const status = await accounts.enableMember(request.auth.tenantId, targetUserId, managerActor(request), requestMeta(request));
      return reply.send({ status });
    } catch (error) {
      if (sendServiceError(reply, error)) return reply;
      throw error;
    }
  });

  // Lost phone and no recovery codes: the member's second factors go, every
  // session ends, and the next sign-in enrols a new authenticator.
  app.post("/tenant/members/:userId/mfa-reset", async (request, reply) => {
    const targetUserId = await resolveTarget(request, reply);
    if (!targetUserId) return reply;
    if (!(await requireStepUp(request, reply, localAuth, "POST /tenant/members/:userId/mfa-reset"))) return reply;
    try {
      await localAuth.mfa.resetMemberFactors(request.auth.tenantId, targetUserId, managerActor(request), requestMeta(request));
      return reply.send({ ok: true });
    } catch (error) {
      if (sendServiceError(reply, error)) return reply;
      throw error;
    }
  });

  // The tenant's MFA policy. Any manager makes it stricter; only an owner,
  // with step-up, makes it weaker.
  app.get("/tenant/settings/security", async (request, reply) => {
    if (!requireRole(request, reply, "owner", "admin")) return;
    return reply.send({ mfaPolicy: await localAuth.mfa.getPolicy(request.auth.tenantId) });
  });

  app.put("/tenant/settings/security", async (request, reply) => {
    if (!requireRole(request, reply, "owner", "admin")) return;
    const body = parseRequestInput(reply, TenantSecuritySettingsSchema, request.body);
    if (!body.ok) return body.response;
    const { tenantId } = request.auth;
    const current = await localAuth.mfa.getPolicy(tenantId);
    // A first check; the service checks again under the tenant lock.
    const weaker = MFA_POLICIES.indexOf(body.value.mfaPolicy) < MFA_POLICIES.indexOf(current);
    if (weaker) {
      if (request.auth.role !== "owner") return reply.code(403).send({ error: "only_owner_can_weaken_policy" });
      if (!(await requireStepUp(request, reply, localAuth, "PUT /tenant/settings/security"))) return reply;
    }
    try {
      await localAuth.mfa.setPolicy(tenantId, managerActor(request), body.value.mfaPolicy, requestMeta(request), { stepUpVerified: weaker });
      return reply.send({ mfaPolicy: body.value.mfaPolicy });
    } catch (error) {
      if (sendServiceError(reply, error)) return reply;
      throw error;
    }
  });

  app.post("/tenant/members/:userId/sessions/revoke", async (request, reply) => {
    const targetUserId = await resolveTarget(request, reply);
    if (!targetUserId) return reply;
    try {
      await accounts.revokeSessions(request.auth.tenantId, targetUserId, managerActor(request), requestMeta(request));
      return reply.send({ ok: true });
    } catch (error) {
      if (sendServiceError(reply, error)) return reply;
      throw error;
    }
  });
}
