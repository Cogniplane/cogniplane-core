import Fastify from "fastify";
import { describe, expect, test, vi } from "vitest";

import { LocalAccountError } from "../services/auth/local-account-service.js";
import type { LocalAuth } from "../services/auth/local-auth.js";
import { RefreshTokenRotationService } from "../services/auth/refresh-token-rotation-service.js";
import { type StepUpAction, StepUpStore } from "../services/auth/step-up-store.js";
import type { TenantMembershipRole } from "../services/tenant-member-store.js";
import { FakeRefreshTokenRedis } from "../test-helpers/fake-refresh-token-redis.js";
import { registerLocalMemberRoutes } from "./tenant-local-members.js";

// Manager rights and step-up on local accounts. LocalAccountService is faked;
// its SQL runs against real Postgres in the integration suite.

const LINK = { url: "https://app.test/auth/setup#token=x", expiresAt: "2026-10-29T00:00:00.000Z", purpose: "account_setup" };

type SessionAuth = { authSource: "local" | "workos"; familyId?: string; securityVersion?: number };
const LOCAL_SESSION: SessionAuth = { authSource: "local", familyId: "family-1", securityVersion: 2 };

async function buildHarness(
  actor: { userId: string; role: TenantMembershipRole },
  targetRole: TenantMembershipRole = "member",
  session: SessionAuth = LOCAL_SESSION
) {
  const redis = new FakeRefreshTokenRedis();
  const refreshTokens = new RefreshTokenRotationService(redis, 60);
  await refreshTokens.issue({ jti: "jti-1", familyId: "family-1" });
  const stepUp = new StepUpStore(redis);
  const accounts = {
    getMemberState: vi.fn(async () => ({ role: targetRole, status: "active" })),
    createMember: vi.fn(async () => ({ userId: "new-user", link: LINK, email: null })),
    resetMemberPassword: vi.fn(async (): Promise<object> => ({ link: { ...LINK, purpose: "password_reset" }, email: null })),
    resendMemberLink: vi.fn(async () => ({ to: "target@example.com", expiresAt: LINK.expiresAt, purpose: "account_setup" })),
    disableMember: vi.fn(async () => undefined),
    enableMember: vi.fn(async () => "active"),
    revokeSessions: vi.fn(async () => undefined)
  };
  const mfa = {
    hasSecondFactor: vi.fn(async () => false),
    resetMemberFactors: vi.fn(async () => undefined),
    getPolicy: vi.fn(async () => "optional"),
    setPolicy: vi.fn(async () => ({ previous: "optional" }))
  };
  const app = Fastify();
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: actor.userId, tenantId: "tenant-1", role: actor.role, isAdmin: actor.role !== "member",
      session
    };
  });
  await registerLocalMemberRoutes(app, {
    localAuth: { accounts, stepUp, refreshTokens, mfa } as unknown as LocalAuth
  });
  const proof = async (
    action: StepUpAction,
    binding: Partial<{ userId: string; familyId: string; securityVersion: number }> = {},
    amr: Array<"pwd" | "otp"> = ["pwd"]
  ) =>
    (await stepUp.create({ userId: actor.userId, tenantId: "tenant-1", familyId: "family-1", securityVersion: 2, action, ...binding }, amr)).token;
  return { app, accounts, mfa, refreshTokens, proof };
}

const OWNER = { userId: "owner-1", role: "owner" as const };
const ADMIN = { userId: "admin-1", role: "admin" as const };

describe("POST /tenant/members", () => {
  const create = async (harness: Awaited<ReturnType<typeof buildHarness>>, role: TenantMembershipRole, token?: string) =>
    harness.app.inject({
      method: "POST", url: "/tenant/members", payload: { email: "new@example.com", role },
      headers: { "x-step-up": token ?? await harness.proof("member.create") }
    });

  test("an admin creates a member and gets the setup link once", async () => {
    const harness = await buildHarness(ADMIN);
    const { accounts } = harness;
    const res = await create(harness, "member");
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ userId: "new-user", link: LINK, email: null });
    expect(accounts.createMember).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-1", role: "member", actorUserId: "admin-1", actorVersion: 2 }));
  });

  test.each([
    ["admin", "only_owner_can_assign_admin"],
    ["owner", "only_owner_can_assign_owner"]
  ] as const)("an admin cannot create an %s", async (role, error) => {
    const { app, accounts } = await buildHarness(ADMIN);
    const res = await app.inject({ method: "POST", url: "/tenant/members", payload: { email: "new@example.com", role } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error });
    expect(accounts.createMember).not.toHaveBeenCalled();
  });

  test("an owner creates an admin", async () => {
    expect((await create(await buildHarness(OWNER), "admin")).statusCode).toBe(201);
  });

  // With email off the answer carries the setup link, and with email on the
  // link goes to the address in the body: an access token alone must not
  // create an account that outlives the victim's password change.
  test("a local manager without a step-up token gets 403 and nothing is created", async () => {
    const { app, accounts } = await buildHarness(OWNER);
    const res = await app.inject({ method: "POST", url: "/tenant/members", payload: { email: "new@example.com", role: "admin" } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "step_up_required" });
    expect(accounts.createMember).not.toHaveBeenCalled();
  });

  test.each([
    ["for another action", "member.role_change", {}],
    ["from another session family", "member.create", { familyId: "family-2" }],
    ["from an older security version", "member.create", { securityVersion: 1 }]
  ] as const)("refuses a step-up token %s", async (_case, action, binding) => {
    const harness = await buildHarness(OWNER);
    const res = await create(harness, "member", await harness.proof(action, binding));
    expect(res.json()).toMatchObject({ error: "step_up_required" });
    expect(harness.accounts.createMember).not.toHaveBeenCalled();
  });

  test("a manager with a second factor needs a strong step-up", async () => {
    const harness = await buildHarness(OWNER);
    harness.mfa.hasSecondFactor.mockResolvedValue(true);
    expect((await create(harness, "member")).json()).toMatchObject({ error: "strong_step_up_required" });
    expect(harness.accounts.createMember).not.toHaveBeenCalled();
    expect((await create(harness, "member", await harness.proof("member.create", {}, ["otp"]))).statusCode).toBe(201);
  });

  // A WorkOS session cannot give a step-up, and a WorkOS tenant has no local
  // accounts: the route refuses before the service.
  test("a WorkOS manager gets step_up_required and nothing is created", async () => {
    const { app, accounts } = await buildHarness(OWNER, "member", { authSource: "workos", familyId: "family-1" });
    const res = await app.inject({
      method: "POST", url: "/tenant/members", payload: { email: "new@example.com", role: "member" }, headers: { "x-step-up": "t".repeat(43) }
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "step_up_required" });
    expect(accounts.createMember).not.toHaveBeenCalled();
  });

  // The service refuses an owner that is not set up (member-authority.ts,
  // ownerRoleRefusal); the integration suite runs that refusal against Postgres.
  test("an owner's request for a new owner gets the service refusal as 409", async () => {
    const harness = await buildHarness(OWNER);
    const { accounts } = harness;
    accounts.createMember.mockRejectedValue(new LocalAccountError("account_not_active"));
    const res = await create(harness, "owner");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "account_not_active" });
    expect(accounts.createMember).toHaveBeenCalledWith(expect.objectContaining({ role: "owner", actorUserId: "owner-1" }));
  });

  test("a member cannot create anyone", async () => {
    const { app, accounts } = await buildHarness({ userId: "member-1", role: "member" });
    const res = await app.inject({ method: "POST", url: "/tenant/members", payload: { email: "new@example.com", role: "member" } });
    expect(res.statusCode).toBe(403);
    expect(accounts.createMember).not.toHaveBeenCalled();
  });

  test.each(["email_in_use", "wrong_login_type", "email_invalid"] as const)("passes the service refusal %s through", async (code) => {
    const harness = await buildHarness(ADMIN);
    harness.accounts.createMember.mockRejectedValue(new LocalAccountError(code));
    expect((await create(harness, "member")).json()).toEqual({ error: code });
  });
});

describe("manager rights on a target", () => {
  test.each([
    ["themselves", ADMIN, "admin-1", "member", 400, "cannot_manage_self"],
    ["an owner", OWNER, "target", "owner", 403, "cannot_manage_owner"],
    ["an admin, as an admin", ADMIN, "target", "admin", 403, "only_owner_can_manage_admin"]
  ] as const)("refuses an action on %s", async (_case, actor, target, targetRole, status, error) => {
    const { app, accounts } = await buildHarness(actor, targetRole);
    const res = await app.inject({ method: "POST", url: `/tenant/members/${target}/sessions/revoke` });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ error });
    expect(accounts.revokeSessions).not.toHaveBeenCalled();
  });

  test("an owner may act on an admin", async () => {
    const { app, accounts } = await buildHarness(OWNER, "admin");
    const res = await app.inject({ method: "POST", url: "/tenant/members/target/sessions/revoke" });
    expect(res.statusCode).toBe(200);
    expect(accounts.revokeSessions).toHaveBeenCalledWith("tenant-1", "target", { userId: "owner-1", securityVersion: 2 }, expect.any(Object));
  });

  test("an unknown member is 404", async () => {
    const { app, accounts } = await buildHarness(ADMIN);
    accounts.getMemberState.mockResolvedValue(null as never);
    expect((await app.inject({ method: "POST", url: "/tenant/members/ghost/enable" })).statusCode).toBe(404);
  });
});

describe("step-up for password reset, disable, and enable", () => {
  test.each(["password-reset", "disable"] as const)("%s needs a step-up token", async (action) => {
    const { app, accounts } = await buildHarness(ADMIN);
    const res = await app.inject({ method: "POST", url: `/tenant/members/target/${action}` });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "step_up_required" });
    expect(accounts.resetMemberPassword).not.toHaveBeenCalled();
    expect(accounts.disableMember).not.toHaveBeenCalled();
  });

  test("password reset returns the link once, and the token is spent", async () => {
    const { app, accounts, proof } = await buildHarness(ADMIN);
    const token = await proof("member.password_reset");
    const first = await app.inject({ method: "POST", url: "/tenant/members/target/password-reset", headers: { "x-step-up": token } });
    expect(first.statusCode).toBe(200);
    expect(first.json().link.purpose).toBe("password_reset");
    const replay = await app.inject({ method: "POST", url: "/tenant/members/target/password-reset", headers: { "x-step-up": token } });
    expect(replay.statusCode).toBe(403);
    expect(accounts.resetMemberPassword).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["for another action", "member.disable", {}],
    ["from an older security version", "member.password_reset", { securityVersion: 1 }],
    ["from another session family", "member.password_reset", { familyId: "family-2" }]
  ] as const)("refuses a token %s", async (_case, action, binding) => {
    const { app, accounts, proof } = await buildHarness(ADMIN);
    const token = await proof(action, binding);
    const res = await app.inject({ method: "POST", url: "/tenant/members/target/password-reset", headers: { "x-step-up": token } });
    expect(res.statusCode).toBe(403);
    expect(accounts.resetMemberPassword).not.toHaveBeenCalled();
  });

  test("refuses a valid token after the session family was revoked (logout)", async () => {
    const { app, accounts, proof, refreshTokens } = await buildHarness(ADMIN);
    const token = await proof("member.password_reset");
    await refreshTokens.revoke("family-1");
    const res = await app.inject({ method: "POST", url: "/tenant/members/target/password-reset", headers: { "x-step-up": token } });
    expect(res.statusCode).toBe(403);
    expect(accounts.resetMemberPassword).not.toHaveBeenCalled();
  });

  // The service stops the member's runtimes after its commit
  // (security-change.ts); security-change-sites.integration.test.ts checks it.
  test("disable runs the service with the manager's session", async () => {
    const { app, accounts, proof } = await buildHarness(ADMIN);
    const res = await app.inject({ method: "POST", url: "/tenant/members/target/disable", headers: { "x-step-up": await proof("member.disable") } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "disabled" });
    expect(accounts.disableMember).toHaveBeenCalledWith("tenant-1", "target", { userId: "admin-1", securityVersion: 2 }, expect.any(Object));
  });

  // The account's password works again: enable gives sign-in back.
  test("enable needs a step-up token", async () => {
    const { app, accounts, proof } = await buildHarness(ADMIN);
    const refused = await app.inject({ method: "POST", url: "/tenant/members/target/enable" });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: "step_up_required" });
    expect(accounts.enableMember).not.toHaveBeenCalled();
    const res = await app.inject({ method: "POST", url: "/tenant/members/target/enable", headers: { "x-step-up": await proof("member.enable") } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "active" });
  });
});

describe("second factors: manager reset and the tenant policy", () => {
  test("a member's factor reset needs step-up, then calls the service", async () => {
    const { app, mfa, proof } = await buildHarness(ADMIN);
    expect((await app.inject({ method: "POST", url: "/tenant/members/target/mfa-reset" })).statusCode).toBe(403);
    const res = await app.inject({ method: "POST", url: "/tenant/members/target/mfa-reset", headers: { "x-step-up": await proof("member.mfa_reset") } });
    expect(res.statusCode).toBe(200);
    expect(mfa.resetMemberFactors).toHaveBeenCalledWith("tenant-1", "target", { userId: "admin-1", securityVersion: 2 }, expect.any(Object));
  });

  test("a manager with a second factor needs a strong step-up", async () => {
    const { app, mfa, accounts, proof } = await buildHarness(ADMIN);
    mfa.hasSecondFactor.mockResolvedValue(true);
    const weak = await app.inject({ method: "POST", url: "/tenant/members/target/disable", headers: { "x-step-up": await proof("member.disable") } });
    expect(weak.json()).toMatchObject({ error: "strong_step_up_required" });
    expect(accounts.disableMember).not.toHaveBeenCalled();
    const strong = await app.inject({
      method: "POST", url: "/tenant/members/target/disable", headers: { "x-step-up": await proof("member.disable", {}, ["otp"]) }
    });
    expect(strong.statusCode).toBe(200);
  });

  test("any manager makes the policy stricter without step-up", async () => {
    const { app, mfa } = await buildHarness(ADMIN);
    const res = await app.inject({ method: "PUT", url: "/tenant/settings/security", payload: { mfaPolicy: "required_for_admins" } });
    expect(res.statusCode).toBe(200);
    expect(mfa.setPolicy).toHaveBeenCalledWith("tenant-1", { userId: "admin-1", securityVersion: 2 }, "required_for_admins", expect.any(Object), { stepUpVerified: false });
  });

  test("only an owner, with step-up, makes the policy weaker", async () => {
    const admin = await buildHarness(ADMIN);
    admin.mfa.getPolicy.mockResolvedValue("required_for_all");
    expect((await admin.app.inject({ method: "PUT", url: "/tenant/settings/security", payload: { mfaPolicy: "optional" } })).json())
      .toEqual({ error: "only_owner_can_weaken_policy" });

    const owner = await buildHarness(OWNER);
    owner.mfa.getPolicy.mockResolvedValue("required_for_all");
    expect((await owner.app.inject({ method: "PUT", url: "/tenant/settings/security", payload: { mfaPolicy: "optional" } })).json())
      .toMatchObject({ error: "step_up_required" });
    const res = await owner.app.inject({
      method: "PUT", url: "/tenant/settings/security", payload: { mfaPolicy: "optional" },
      headers: { "x-step-up": await owner.proof("tenant.mfa_policy") }
    });
    expect(res.statusCode).toBe(200);
    // The service checks the weakening again under the tenant lock.
    expect(owner.mfa.setPolicy).toHaveBeenCalledWith("tenant-1", { userId: "owner-1", securityVersion: 2 }, "optional", expect.any(Object), { stepUpVerified: true });
  });

  test("a policy that changed before the lock is refused, not weakened without step-up", async () => {
    const { app, mfa } = await buildHarness(OWNER);
    mfa.setPolicy.mockRejectedValue(new LocalAccountError("policy_changed"));
    const res = await app.inject({ method: "PUT", url: "/tenant/settings/security", payload: { mfaPolicy: "optional" } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "policy_changed" });
  });

  test("an unknown policy is refused", async () => {
    const { app } = await buildHarness(OWNER);
    expect((await app.inject({ method: "PUT", url: "/tenant/settings/security", payload: { mfaPolicy: "sometimes" } })).statusCode).toBe(400);
  });
});

describe("POST /tenant/members/:userId/link/resend", () => {
  test("a manager sends a new link by email without step-up and sees only where it went", async () => {
    const { app, accounts } = await buildHarness(ADMIN);
    const res = await app.inject({ method: "POST", url: "/tenant/members/target/link/resend" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ email: { to: "target@example.com", expiresAt: LINK.expiresAt, purpose: "account_setup" } });
    expect(res.body).not.toContain("#token=");
    expect(accounts.resendMemberLink).toHaveBeenCalledWith("tenant-1", "target", { userId: "admin-1", securityVersion: 2 }, expect.any(Object));
  });

  test("the manager rules apply: no member, no owner target, not oneself", async () => {
    for (const [actor, targetRole, url, status] of [
      [{ userId: "member-1", role: "member" as const }, "member", "/tenant/members/target/link/resend", 403],
      [ADMIN, "owner", "/tenant/members/target/link/resend", 403],
      [ADMIN, "member", "/tenant/members/admin-1/link/resend", 400]
    ] as const) {
      const { app, accounts } = await buildHarness(actor, targetRole);
      const res = await app.inject({ method: "POST", url });
      expect(res.statusCode, `${actor.role} -> ${targetRole}`).toBe(status);
      expect(accounts.resendMemberLink).not.toHaveBeenCalled();
    }
  });

  test.each([
    ["link_sent_recently", 429],
    ["email_off", 409],
    ["account_state_conflict", 409]
  ] as const)("answers the service's %s", async (code, status) => {
    const { app, accounts } = await buildHarness(ADMIN);
    accounts.resendMemberLink.mockRejectedValue(new LocalAccountError(code));
    const res = await app.inject({ method: "POST", url: "/tenant/members/target/link/resend" });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ error: code });
  });
});

describe("links by email", () => {
  test("with email on, reset answers where the link went and never the link", async () => {
    const { app, accounts, proof } = await buildHarness(ADMIN);
    accounts.resetMemberPassword.mockResolvedValue({ link: null, email: { to: "target@example.com", expiresAt: LINK.expiresAt, purpose: "password_reset" } });
    const res = await app.inject({ method: "POST", url: "/tenant/members/target/password-reset", headers: { "x-step-up": await proof("member.password_reset") } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ link: null, email: { to: "target@example.com", expiresAt: LINK.expiresAt, purpose: "password_reset" } });
  });
});
