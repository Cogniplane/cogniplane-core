// Local accounts against a real Postgres with the production roles
// (docs/ARCHITECTURE.md, "Authentication"): the one-home-tenant
// foreign keys, the account lifecycle through LocalAccountService, the
// serialisation of concurrent changes, the maintenance role's read-only
// access, owner recovery, and tenant deletion.

import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, test } from "vitest";

import { PasswordHasher } from "../lib/password-hash.js";
import {
  hashActionToken,
  LocalAccountError,
  LocalAccountService,
  markLocalIdentityRemoved,
  type RequestMeta
} from "../services/auth/local-account-service.js";
import { LocalMfaService } from "../services/auth/local-mfa-service.js";
import { RefreshTokenRotationService } from "../services/auth/refresh-token-rotation-service.js";
import { type StepUpAction, StepUpStore } from "../services/auth/step-up-store.js";
import { TENANT_MEMBERSHIP_LOCK_SQL } from "../services/member-authority.js";
import { FakeRefreshTokenRedis } from "../test-helpers/fake-refresh-token-redis.js";
import { TenantMemberStore } from "../services/tenant-member-store.js";
import { TenantOrgSettingsStore } from "../services/tenant-org-settings-store.js";
import { registerTenantRoutes } from "../routes/tenant.js";
import { registerLocalMemberRoutes } from "../routes/tenant-local-members.js";
import type { LocalAuth } from "../services/auth/local-auth.js";
import { withTenantScope } from "../lib/db.js";
import { bootstrapLocalTenant, operatorAccountService } from "../scripts/local-auth-commands-lib.js";
import { adminDatabaseUrl, appPool, maintenancePool, superuserPool } from "./support/database.js";
import { seedMembership, seedScheduledJob, seedTenant, seedUser } from "./support/fixtures.js";
import { IGNORE_SECURITY_CHANGE } from "../test-helpers/security-change.js";
import { withSecurityChange } from "../services/auth/security-change.js";
import { devDataRoutes } from "../test-helpers/data-routes.js";

const META: RequestMeta = { ipAddress: "203.0.113.9", userAgent: "integration" };
const ORIGIN = "https://app.test";
const PASSWORD = "purple elephants dance quietly";

function accounts() {
  return new LocalAccountService({ afterSecurityChange: IGNORE_SECURITY_CHANGE, db: appPool(), lookupDb: maintenancePool(), hasher: new PasswordHasher(4), frontendOrigin: ORIGIN });
}
const tokenOf = (url: string) => url.split("#token=")[1]!;
const email = () => `${randomUUID()}@example.test`;

async function localTenant() {
  return bootstrapLocalTenant(superuserPool(), ORIGIN, { tenantName: "Local tenant", ownerEmail: email(), ownerName: "Owner" });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LocalAccountError) return error.code;
    throw error;
  }
  return "ok";
}

describe.skipIf(!adminDatabaseUrl())("local accounts (migration 071)", () => {
  describe("one home tenant, kept by foreign keys", () => {
    test("a local user cannot join a second tenant, also with a NULL login path", async () => {
      const boot = await localTenant();
      const other = await seedTenant();
      for (const source of ["local", "workos", null]) {
        await expect(superuserPool().query(
          `INSERT INTO tenant_memberships (tenant_id, user_id, role, user_auth_source) VALUES ($1, $2, 'member', $3)`,
          [other, boot.userId, source]
        )).rejects.toMatchObject({ code: source === null ? "23502" : "23503" });
      }
    });

    test("two concurrent memberships for one local user: at most one is the home tenant", async () => {
      const boot = await localTenant();
      const others = [await seedTenant(), await seedTenant()];
      const results = await Promise.allSettled(others.map((tenantId) => superuserPool().query(
        `INSERT INTO tenant_memberships (tenant_id, user_id, role, user_auth_source) VALUES ($1, $2, 'member', 'local')`,
        [tenantId, boot.userId]
      )));
      expect(results.every((result) => result.status === "rejected")).toBe(true);
    });

    test("a user's login path cannot change while a local identity exists", async () => {
      const boot = await localTenant();
      await expect(superuserPool().query(`UPDATE users SET auth_source = 'workos' WHERE user_id = $1`, [boot.userId]))
        .rejects.toMatchObject({ code: "23503" });
    });

    test("WorkOS memberships are unaffected", async () => {
      const tenantId = await seedTenant();
      const userId = await seedUser();
      await seedMembership(tenantId, userId);
      const row = (await superuserPool().query(
        `SELECT user_auth_source, local_tenant_id FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, userId]
      )).rows[0];
      expect(row).toEqual({ user_auth_source: "workos", local_tenant_id: null });
    });
  });

  describe("lifecycle through LocalAccountService", () => {
    test("bootstrap, setup, sign-in, password change, manager reset, disable, enable", async () => {
      const service = accounts();
      const members = new TenantMemberStore(maintenancePool());
      const boot = await localTenant();
      const login = (await superuserPool().query(`SELECT login_type FROM tenants WHERE tenant_id = $1`, [boot.tenantId])).rows[0];
      expect(login).toEqual({ login_type: "local" });

      // An owner who never set a password cannot sign in or act.
      expect(await members.getActiveRole(boot.tenantId, boot.userId)).toBeNull();
      const ownerEmail = (await superuserPool().query(`SELECT email FROM users WHERE user_id = $1`, [boot.userId])).rows[0].email as string;
      expect(await codeOf(service.signInWithPassword(ownerEmail, PASSWORD, META))).toBe("invalid_credentials");

      // Setup: the link works once, sets the password, activates the account.
      const setup = await service.redeemLink("account_setup", tokenOf(boot.link.url), PASSWORD, META);
      expect(setup).toMatchObject({ tenantId: boot.tenantId, userId: boot.userId, role: "owner", securityVersion: 1 });
      expect(await codeOf(service.redeemLink("account_setup", tokenOf(boot.link.url), PASSWORD, META))).toBe("link_invalid");
      expect(await members.getActiveRole(boot.tenantId, boot.userId)).toBe("owner");

      // Sign-in: email case does not matter; a wrong password is the generic error.
      const signedIn = await service.signInWithPassword(ownerEmail.toUpperCase(), PASSWORD, META);
      expect(signedIn.securityVersion).toBe(1);
      expect(await codeOf(service.signInWithPassword(ownerEmail, "wrong passphrase entirely", META))).toBe("invalid_credentials");

      // Password change: new version; the old password stops working.
      const changed = await service.changeOwnPassword(boot.tenantId, boot.userId, PASSWORD, "a different long passphrase", 1, META);
      expect(changed.securityVersion).toBe(2);
      expect(await codeOf(service.signInWithPassword(ownerEmail, PASSWORD, META))).toBe("invalid_credentials");

      // A member, created by the owner, then reset by the owner.
      const created = await service.createMember({ tenantId: boot.tenantId, email: email(), displayName: "Member", role: "member", actorUserId: boot.userId, meta: META });
      await service.redeemLink("account_setup", tokenOf(created.link!.url), PASSWORD, META);
      const reset = await service.resetMemberPassword(boot.tenantId, created.userId, boot.userId, META);
      expect(reset.link!.purpose).toBe("password_reset");
      // A reset link changes the password only; the old one stays until then.
      const afterReset = await service.redeemLink("password_reset", tokenOf(reset.link!.url), "the brand new passphrase", META);
      expect(afterReset.securityVersion).toBe(3);

      // Disable: no sign-in, no runtime admission, jobs suspended.
      await seedScheduledJob({ tenantId: boot.tenantId, userId: created.userId });
      expect((await superuserPool().query(
        `SELECT 1 FROM scheduled_jobs WHERE tenant_id = $1 AND user_id = $2 AND enabled`, [boot.tenantId, created.userId]
      )).rowCount).toBe(1);
      await service.disableMember(boot.tenantId, created.userId, boot.userId, META);
      expect(await members.getActiveRole(boot.tenantId, created.userId)).toBeNull();
      const memberEmail = (await superuserPool().query(`SELECT email FROM users WHERE user_id = $1`, [created.userId])).rows[0].email as string;
      expect(await codeOf(service.signInWithPassword(memberEmail, "the brand new passphrase", META))).toBe("invalid_credentials");
      const enabledJobs = await superuserPool().query(
        `SELECT 1 FROM scheduled_jobs WHERE tenant_id = $1 AND user_id = $2 AND enabled`,
        [boot.tenantId, created.userId]
      );
      expect(enabledJobs.rowCount).toBe(0);

      // Enable: active again, with the same password.
      expect(await service.enableMember(boot.tenantId, created.userId, boot.userId, META)).toBe("active");
      expect((await service.signInWithPassword(memberEmail, "the brand new passphrase", META)).userId).toBe(created.userId);

      // The audit trail names every step, with no secret in a payload.
      const audit = await superuserPool().query(
        `SELECT event_type, payload::text AS payload FROM audit_events WHERE tenant_id = $1 ORDER BY id`,
        [boot.tenantId]
      );
      const types = audit.rows.map((row) => row.event_type);
      for (const type of [
        "tenant.member.created", "auth.account_setup_completed", "auth.login_succeeded", "auth.login_failed",
        "auth.password_changed", "tenant.member.password_reset", "auth.password_reset_completed",
        "tenant.member.disabled", "tenant.member.enabled"
      ]) {
        expect(types).toContain(type);
      }
      for (const row of audit.rows) {
        expect(row.payload).not.toMatch(/passphrase|argon2|token/i);
      }
    });

    test("an email any account holds is refused, of either login type", async () => {
      const service = accounts();
      const boot = await localTenant();
      const workosUser = await seedUser();
      const taken = (await superuserPool().query(`SELECT email FROM users WHERE user_id = $1`, [workosUser])).rows[0].email as string;
      expect(await codeOf(service.createMember({ tenantId: boot.tenantId, email: taken.toUpperCase(), displayName: null, role: "member", actorUserId: boot.userId, meta: META })))
        .toBe("email_in_use");
    });

    test("members cannot be created in a WorkOS tenant", async () => {
      const tenantId = await seedTenant();
      expect(await codeOf(accounts().createMember({ tenantId, email: email(), displayName: null, role: "member", actorUserId: "x", meta: META })))
        .toBe("wrong_login_type");
    });
  });

  describe("serialisation of concurrent changes", () => {
    test("two links for one account: only one redemption succeeds", async () => {
      const service = accounts();
      const boot = await localTenant();
      await service.redeemLink("account_setup", tokenOf(boot.link.url), PASSWORD, META);
      const created = await service.createMember({ tenantId: boot.tenantId, email: email(), displayName: null, role: "member", actorUserId: boot.userId, meta: META });
      await service.redeemLink("account_setup", tokenOf(created.link!.url), PASSWORD, META);

      // Two reset links at the same version, as if two managers clicked at once
      // and both inserts landed before either bump (seeded directly).
      const version = (await superuserPool().query(
        `SELECT security_version FROM local_identities WHERE user_id = $1`, [created.userId]
      )).rows[0].security_version as number;
      const raw = [randomUUID().replace(/-/g, "") + "abcdefghijk", randomUUID().replace(/-/g, "") + "lmnopqrstuv"];
      for (const token of raw) {
        await superuserPool().query(
          `INSERT INTO auth_action_tokens (token_hash, tenant_id, user_id, purpose, security_version, expires_at)
           VALUES ($1, $2, $3, 'password_reset', $4, now() + interval '1 hour')`,
          [hashActionToken(token), boot.tenantId, created.userId, version]
        );
      }
      const outcomes = await Promise.all(raw.map((token) => codeOf(service.redeemLink("password_reset", token, `${token} passphrase`, META))));
      expect(outcomes.sort()).toEqual(["link_invalid", "ok"]);
    });

    // Disable and redemption run at the same time. Whatever order the
    // identity lock gives them, the account must end disabled: a redemption
    // that completes first is followed by the disable, and one that waits
    // finds a newer version and fails.
    test("a reset racing a disable never leaves the account active", async () => {
      const service = accounts();
      const boot = await localTenant();
      await service.redeemLink("account_setup", tokenOf(boot.link.url), PASSWORD, META);
      for (let round = 0; round < 5; round += 1) {
        const created = await service.createMember({ tenantId: boot.tenantId, email: email(), displayName: null, role: "member", actorUserId: boot.userId, meta: META });
        await service.redeemLink("account_setup", tokenOf(created.link!.url), PASSWORD, META);
        const reset = await service.resetMemberPassword(boot.tenantId, created.userId, boot.userId, META);

        const [redeemed] = await Promise.all([
          codeOf(service.redeemLink("password_reset", tokenOf(reset.link!.url), "another long passphrase", META)),
          service.disableMember(boot.tenantId, created.userId, boot.userId, META)
        ]);

        expect(["ok", "link_invalid"]).toContain(redeemed);
        const status = (await superuserPool().query(`SELECT status FROM local_identities WHERE user_id = $1`, [created.userId])).rows[0].status;
        expect(status).toBe("disabled");
      }
    });
  });

  describe("manager rights under the identity lock", () => {
    async function ownerAndAdmin() {
      const service = accounts();
      const boot = await localTenant();
      await service.redeemLink("account_setup", tokenOf(boot.link.url), PASSWORD, META);
      const admin = await service.createMember({ tenantId: boot.tenantId, email: email(), displayName: null, role: "admin", actorUserId: boot.userId, meta: META });
      await service.redeemLink("account_setup", tokenOf(admin.link!.url), PASSWORD, META);
      const member = await service.createMember({ tenantId: boot.tenantId, email: email(), displayName: null, role: "member", actorUserId: boot.userId, meta: META });
      await service.redeemLink("account_setup", tokenOf(member.link!.url), PASSWORD, META);
      return { service, boot, adminId: admin.userId, memberId: member.userId };
    }

    type Actor = { userId: string; tenantId: string; role: "owner" | "admin" };

    /**
     * A live local session of the actor, at the actor's current security
     * version. The step-up store and the refresh families are the real
     * classes on a fake Redis; `stepUp` makes a token for one action, as
     * POST /auth/step-up does after the proof.
     */
    async function localSession(actor: Actor) {
      const securityVersion = (await superuserPool().query(
        `SELECT security_version FROM local_identities WHERE user_id = $1`, [actor.userId]
      )).rows[0].security_version as number;
      const redis = new FakeRefreshTokenRedis();
      const refreshTokens = new RefreshTokenRotationService(redis, 60);
      await refreshTokens.issue({ jti: "jti-1", familyId: "family-1" });
      const store = new StepUpStore(redis);
      const mfa = new LocalMfaService({ afterSecurityChange: IGNORE_SECURITY_CHANGE, db: appPool(), secret: "local-accounts-integration-secret-32-chars", issuer: "Cogniplane" });
      const stepUp = async (action: StepUpAction) => ({
        "x-step-up": (await store.create(
          { userId: actor.userId, tenantId: actor.tenantId, familyId: "family-1", securityVersion, action }, ["pwd"]
        )).token
      });
      const app = Fastify();
      app.addHook("preHandler", async (request) => {
        request.auth = {
          userId: actor.userId, tenantId: actor.tenantId, role: actor.role, isAdmin: true,
          session: { authSource: "local", familyId: "family-1", securityVersion }
        };
      });
      return { app, stepUp, stepUpServices: { stepUp: store, refreshTokens, mfa } };
    }

    async function roleRouteAs(actor: Actor) {
      const { app, stepUp, stepUpServices } = await localSession(actor);
      await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE,
        db: appPool(),
        tenantOrgSettings: new TenantOrgSettingsStore(appPool(), "local-accounts-integration-secret-32-chars"),
        localAuth: { accounts: accounts(), ...stepUpServices } as unknown as LocalAuth
      });
      await app.ready();
      return { app, stepUp };
    }

    async function memberRouteAs(service: LocalAccountService, actor: Actor) {
      const { app, stepUp, stepUpServices } = await localSession(actor);
      // POST /tenant/members uses the account service and step-up.
      await registerLocalMemberRoutes(app, { localAuth: { accounts: service, ...stepUpServices } as unknown as LocalAuth });
      await app.ready();
      return { app, stepUp };
    }

    async function roleOf(userId: string): Promise<string> {
      return (await superuserPool().query(`SELECT role FROM tenant_memberships WHERE user_id = $1`, [userId])).rows[0].role;
    }

    async function userCount(address: string): Promise<number> {
      const result = await superuserPool().query(`SELECT count(*)::int AS n FROM users WHERE email_key = lower($1)`, [address]);
      return result.rows[0].n as number;
    }

    // Bead q4w0.2: an owner that is not set up cannot be reset, resent a
    // link, enabled, demoted, or removed by anyone in the tenant. When its
    // setup link expires, only the operator can recover it.
    test("the service refuses to create an owner for a manager, and writes nothing", async () => {
      const { service, boot, adminId } = await ownerAndAdmin();
      const address = email();
      expect(await codeOf(service.createMember({ tenantId: boot.tenantId, email: address, displayName: null, role: "owner", actorUserId: boot.userId, meta: META })))
        .toBe("account_not_active");
      // The rights check comes first: an admin gets the rights refusal.
      expect(await codeOf(service.createMember({ tenantId: boot.tenantId, email: address, displayName: null, role: "owner", actorUserId: adminId, meta: META })))
        .toBe("only_owner_can_assign_owner");
      expect(await userCount(address)).toBe(0);
    });

    test("POST /tenant/members refuses a new owner with 409 and writes nothing", async () => {
      const { service, boot } = await ownerAndAdmin();
      const { app, stepUp } = await memberRouteAs(service, { userId: boot.userId, tenantId: boot.tenantId, role: "owner" });
      const address = email();
      try {
        const res = await app.inject({
          method: "POST", url: "/tenant/members", payload: { email: address, role: "owner" }, headers: await stepUp("member.create")
        });
        expect(res.statusCode).toBe(409);
        expect(res.json()).toEqual({ error: "account_not_active" });
        // Control: the same request for an admin succeeds.
        const admin = await app.inject({
          method: "POST", url: "/tenant/members", payload: { email: email(), role: "admin" }, headers: await stepUp("member.create")
        });
        expect(admin.statusCode).toBe(201);
      } finally {
        await app.close();
      }
      expect(await userCount(address)).toBe(0);
    });

    // Bead q4w0.6: with only an access token, an owner's session must not
    // create an account (its setup link would be the token holder's).
    test("POST /tenant/members without a step-up token creates no account", async () => {
      const { service, boot } = await ownerAndAdmin();
      const { app } = await memberRouteAs(service, { userId: boot.userId, tenantId: boot.tenantId, role: "owner" });
      const address = email();
      try {
        const res = await app.inject({ method: "POST", url: "/tenant/members", payload: { email: address, role: "admin" } });
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ error: "step_up_required" });
      } finally {
        await app.close();
      }
      expect(await userCount(address)).toBe(0);
    });

    test("PUT role without a step-up token leaves a local member's role as it was", async () => {
      const { boot, adminId } = await ownerAndAdmin();
      const { app } = await roleRouteAs({ userId: boot.userId, tenantId: boot.tenantId, role: "owner" });
      try {
        const res = await app.inject({ method: "PUT", url: `/tenant/members/${adminId}/role`, payload: { role: "owner" } });
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ error: "step_up_required" });
      } finally {
        await app.close();
      }
      expect(await roleOf(adminId)).toBe("admin");
    });

    test("the operator's bootstrap still creates an owner that is not set up", async () => {
      const boot = await localTenant();
      const row = (await superuserPool().query(
        `
          SELECT tm.role, li.status FROM tenant_memberships tm
          JOIN local_identities li ON li.tenant_id = tm.tenant_id AND li.user_id = tm.user_id
          WHERE tm.tenant_id = $1 AND tm.user_id = $2
        `,
        [boot.tenantId, boot.userId]
      )).rows[0];
      expect(row).toEqual({ role: "owner", status: "pending_setup" });
      expect(boot.link.purpose).toBe("account_setup");
    });

    test("an admin who finished setup can become an owner", async () => {
      const { service, boot } = await ownerAndAdmin();
      const created = await service.createMember({ tenantId: boot.tenantId, email: email(), displayName: null, role: "admin", actorUserId: boot.userId, meta: META });
      await service.redeemLink("account_setup", tokenOf(created.link!.url), PASSWORD, META);
      const { app, stepUp } = await roleRouteAs({ userId: boot.userId, tenantId: boot.tenantId, role: "owner" });
      try {
        const res = await app.inject({
          method: "PUT", url: `/tenant/members/${created.userId}/role`, payload: { role: "owner" }, headers: await stepUp("member.role_change")
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ user_id: created.userId, role: "owner" });
      } finally {
        await app.close();
      }
      const members = new TenantMemberStore(maintenancePool());
      expect(await members.getActiveRole(boot.tenantId, created.userId)).toBe("owner");
    });

    // The review finding: an admin's reset link for a member must not
    // become a way into an owner account after a promotion.
    test("a reset link issued before a promotion to owner is dead after it", async () => {
      const { service, boot, adminId, memberId } = await ownerAndAdmin();
      const link = await service.resetMemberPassword(boot.tenantId, memberId, adminId, META);

      const { app, stepUp } = await roleRouteAs({ userId: boot.userId, tenantId: boot.tenantId, role: "owner" });
      try {
        const promoted = await app.inject({
          method: "PUT", url: `/tenant/members/${memberId}/role`, payload: { role: "owner" }, headers: await stepUp("member.role_change")
        });
        expect(promoted.statusCode).toBe(200);
      } finally {
        await app.close();
      }

      expect(await codeOf(service.redeemLink("password_reset", tokenOf(link.link!.url), "the admin's chosen passphrase", META))).toBe("link_invalid");
    });

    test("rights are checked against the roles at the time of the change", async () => {
      const { service, boot, adminId, memberId } = await ownerAndAdmin();
      // Promoted after any check a route could have made.
      await superuserPool().query(`UPDATE tenant_memberships SET role = 'owner' WHERE user_id = $1`, [memberId]);
      for (const action of [
        () => service.resetMemberPassword(boot.tenantId, memberId, adminId, META),
        () => service.disableMember(boot.tenantId, memberId, adminId, META),
        () => service.revokeSessions(boot.tenantId, memberId, adminId, META)
      ]) {
        expect(await codeOf(action())).toBe("cannot_manage_owner");
      }
      // A manager demoted in the meantime has no rights left.
      const other = await service.createMember({ tenantId: boot.tenantId, email: email(), displayName: null, role: "member", actorUserId: boot.userId, meta: META });
      await superuserPool().query(`UPDATE tenant_memberships SET role = 'member' WHERE user_id = $1`, [adminId]);
      expect(await codeOf(service.disableMember(boot.tenantId, other.userId, adminId, META))).toBe("not_a_manager");
    });

    test("creation reads the creator's committed role", async () => {
      const { service, boot, adminId } = await ownerAndAdmin();
      expect(await codeOf(service.createMember({ tenantId: boot.tenantId, email: email(), displayName: null, role: "admin", actorUserId: adminId, meta: META })))
        .toBe("only_owner_can_assign_admin");
      await superuserPool().query(`UPDATE tenant_memberships SET role = 'member' WHERE user_id = $1`, [adminId]);
      expect(await codeOf(service.createMember({ tenantId: boot.tenantId, email: email(), displayName: null, role: "member", actorUserId: adminId, meta: META })))
        .toBe("not_a_manager");
    });

    test("an account that has not finished setup cannot become an owner", async () => {
      const { service, boot } = await ownerAndAdmin();
      const pending = await service.createMember({ tenantId: boot.tenantId, email: email(), displayName: null, role: "member", actorUserId: boot.userId, meta: META });
      const { app, stepUp } = await roleRouteAs({ userId: boot.userId, tenantId: boot.tenantId, role: "owner" });
      try {
        const res = await app.inject({
          method: "PUT", url: `/tenant/members/${pending.userId}/role`, payload: { role: "owner" }, headers: await stepUp("member.role_change")
        });
        expect(res.statusCode).toBe(409);
        expect(res.json()).toEqual({ error: "account_not_active" });
      } finally {
        await app.close();
      }
      // The setup link still works.
      expect((await service.redeemLink("account_setup", tokenOf(pending.link!.url), PASSWORD, META)).role).toBe("member");
    });

    // The round-3 review schedule: a change reads the caller's role, then a
    // demotion commits, then the change finishes with the old role. The tenant
    // membership lock, taken first by every manager change, forbids it. The
    // test holds that lock in a demotion that has not committed, starts the
    // admin's changes, waits until Postgres shows them blocked on the lock,
    // then commits the demotion.
    test("a demotion that holds the tenant lock wins over the admin's pending changes", async () => {
      const { service, boot, adminId, memberId } = await ownerAndAdmin();
      const demotion = await superuserPool().connect();
      try {
        await demotion.query("BEGIN");
        await demotion.query(TENANT_MEMBERSHIP_LOCK_SQL, [boot.tenantId]);
        await demotion.query(`UPDATE tenant_memberships SET role = 'member' WHERE tenant_id = $1 AND user_id = $2`, [boot.tenantId, adminId]);

        const pending = [
          codeOf(service.createMember({ tenantId: boot.tenantId, email: email(), displayName: null, role: "member", actorUserId: adminId, meta: META })),
          codeOf(service.resetMemberPassword(boot.tenantId, memberId, adminId, META)),
          codeOf(service.disableMember(boot.tenantId, memberId, adminId, META))
        ];
        for (let waited = 0; ; waited += 25) {
          const blocked = await superuserPool().query(
            `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`
          );
          if (blocked.rows[0].n >= pending.length) break;
          if (waited > 5000) throw new Error("the admin's changes never waited for the tenant lock");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        await demotion.query("COMMIT");

        expect(await Promise.all(pending)).toEqual(["not_a_manager", "not_a_manager", "not_a_manager"]);
      } finally {
        await demotion.query("ROLLBACK").catch(() => undefined);
        demotion.release();
      }
      const status = (await superuserPool().query(`SELECT status FROM local_identities WHERE user_id = $1`, [memberId])).rows[0].status;
      expect(status).toBe("active");
    });

    // The email locks are single-key `hashtext(...)` locks. The tenant lock is
    // a two-integer lock; Postgres keeps the two key spaces apart, so no hash
    // collision can make an email lock and a tenant lock the same lock.
    test("the tenant lock does not share keys with single-key locks", async () => {
      const tenantId = `tenant-${randomUUID()}`;
      const keys = (await superuserPool().query<{ ns: number; h: number }>(
        `SELECT hashtext('tenant_membership_changes') AS ns, hashtext($1) AS h`, [tenantId]
      )).rows[0]!;
      const holder = await superuserPool().connect();
      try {
        await holder.query("BEGIN");
        // The single-key locks an email key could map to: the tenant hash, and
        // the 64-bit value with the same bits as the two-integer pair.
        await holder.query("SELECT pg_advisory_xact_lock($1::bigint)", [keys.h]);
        await holder.query(
          "SELECT pg_advisory_xact_lock(($1::bigint << 32) | ($2::bigint & 4294967295))", [keys.ns, keys.h]
        );
        // The single key an earlier version of the tenant lock used.
        await holder.query("SELECT pg_advisory_xact_lock(hashtext('tenant_membership_changes:' || $1))", [tenantId]);
        const other = await superuserPool().connect();
        try {
          await other.query("BEGIN");
          const got = await other.query(
            `SELECT ${TENANT_MEMBERSHIP_LOCK_SQL.replace("SELECT pg_advisory_xact_lock", "pg_try_advisory_xact_lock")} AS got`,
            [tenantId]
          );
          expect(got.rows[0].got).toBe(true);
        } finally {
          await other.query("ROLLBACK");
          other.release();
        }
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
      }
    });

    test("a promotion racing a reset: never a live link for an owner held by the admin", async () => {
      for (let round = 0; round < 5; round += 1) {
        const { service, boot, adminId, memberId } = await ownerAndAdmin();
        const { app, stepUp } = await roleRouteAs({ userId: boot.userId, tenantId: boot.tenantId, role: "owner" });
        const headers = await stepUp("member.role_change");
        try {
          const [reset, promotion] = await Promise.allSettled([
            service.resetMemberPassword(boot.tenantId, memberId, adminId, META),
            app.inject({ method: "PUT", url: `/tenant/members/${memberId}/role`, payload: { role: "owner" }, headers })
          ]);
          expect(promotion.status === "fulfilled" ? [promotion.value.statusCode, promotion.value.body] : promotion).toEqual([200, expect.any(String)]);
          if (reset.status === "fulfilled") {
            expect(await codeOf(service.redeemLink("password_reset", tokenOf(reset.value.link!.url), "the admin's chosen passphrase", META)))
              .toBe("link_invalid");
          } else {
            expect(reset.reason).toMatchObject({ code: "cannot_manage_owner" });
          }
        } finally {
          await app.close();
        }
      }
    });
  });

  describe("roles and access", () => {
    test("the maintenance role reads the lookup tables but cannot write them", async () => {
      const boot = await localTenant();
      expect((await maintenancePool().query(`SELECT 1 FROM local_identities WHERE user_id = $1`, [boot.userId])).rowCount).toBe(1);
      expect((await maintenancePool().query(`SELECT 1 FROM auth_action_tokens WHERE user_id = $1`, [boot.userId])).rowCount).toBe(1);
      for (const statement of [
        `UPDATE local_identities SET status = 'active' WHERE user_id = $1`,
        `DELETE FROM auth_action_tokens WHERE user_id = $1`,
        `SELECT 1 FROM local_passwords WHERE user_id = $1`
      ]) {
        await expect(maintenancePool().query(statement, [boot.userId])).rejects.toMatchObject({ code: "42501" });
      }
    });

    test("the app role sees local rows only in their tenant's scope", async () => {
      const boot = await localTenant();
      const peer = await seedTenant();
      const count = (tenantId: string) => withTenantScope(appPool(), tenantId, async (client) =>
        (await client.query(`SELECT 1 FROM local_identities WHERE user_id = $1`, [boot.userId])).rowCount);
      expect(await count(boot.tenantId)).toBe(1);
      expect(await count(peer)).toBe(0);
    });
  });

  test("owner recovery: back to setup, no password, older sessions and links end", async () => {
    const service = accounts();
    const boot = await localTenant();
    await service.redeemLink("account_setup", tokenOf(boot.link.url), PASSWORD, META);
    const ownerEmail = (await superuserPool().query(`SELECT email FROM users WHERE user_id = $1`, [boot.userId])).rows[0].email as string;

    const recovered = await operatorAccountService(superuserPool(), ORIGIN).recoverOwner(boot.tenantId, ownerEmail.toUpperCase());

    expect(await codeOf(service.signInWithPassword(ownerEmail, PASSWORD, META))).toBe("invalid_credentials");
    const after = await service.redeemLink("account_setup", tokenOf(recovered.link.url), "a recovered long passphrase", META);
    expect(after.securityVersion).toBe(3);
    const audit = await superuserPool().query(
      `SELECT payload FROM audit_events WHERE tenant_id = $1 AND event_type = 'auth.owner_recovered'`,
      [boot.tenantId]
    );
    expect(audit.rows[0]?.payload).toMatchObject({ targetUserId: boot.userId, actor: "operator" });
  });

  test("member removal keeps the identity, marked removed, with no credentials", async () => {
    const service = accounts();
    const boot = await localTenant();
    const created = await service.createMember({ tenantId: boot.tenantId, email: email(), displayName: null, role: "member", actorUserId: boot.userId, meta: META });
    await service.redeemLink("account_setup", tokenOf(created.link!.url), PASSWORD, META);

    await withSecurityChange(appPool(), boot.tenantId, IGNORE_SECURITY_CHANGE, async (client, change) => {
      await markLocalIdentityRemoved(change, created.userId);
      await client.query(`DELETE FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2`, [boot.tenantId, created.userId]);
    });

    const rows = await superuserPool().query(
      `SELECT li.status,
              (SELECT count(*) FROM local_passwords lp WHERE lp.user_id = li.user_id)::int AS passwords,
              (SELECT count(*) FROM auth_action_tokens t WHERE t.user_id = li.user_id)::int AS links
       FROM local_identities li WHERE li.user_id = $1`,
      [created.userId]
    );
    expect(rows.rows[0]).toEqual({ status: "removed", passwords: 0, links: 0 });
  });
});
