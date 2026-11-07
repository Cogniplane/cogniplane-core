// Every place that changes a security version must stop the account's active
// work after the commit (services/auth/security-change.ts). SECURITY_CHANGE_SITES lists the places,
// and security-change-sites.test.ts checks that list against the source. The
// table below is typed by the list, so a new site does not compile until it
// has a case here.
//
// Each case runs the production service or route against real Postgres and
// checks three things: the after-commit handler gets the changed accounts,
// once; the version moved; and a tool context that the account had before the
// change is refused (the gateway's lookup, on every replica).

import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, onTestFinished, test, vi } from "vitest";

import { PasswordHasher } from "../lib/password-hash.js";
import { base32Decode, totpCode, totpStep } from "../lib/totp.js";
import { registerTenantRoutes } from "../routes/tenant.js";
import { bootstrapLocalTenant } from "../scripts/local-auth-commands-lib.js";
import { LocalAccountError, LocalAccountService, type RequestMeta } from "../services/auth/local-account-service.js";
import type { LocalAuth } from "../services/auth/local-auth.js";
import { LocalMfaService } from "../services/auth/local-mfa-service.js";
import { LocalPasskeyService } from "../services/auth/local-passkey-service.js";
import { type AfterSecurityChange, stopActiveWork } from "../services/auth/security-change.js";
import { ToolExecutionContextStore } from "../services/auth/tool-execution-context-store.js";
import { TenantOrgSettingsStore } from "../services/tenant-org-settings-store.js";
import { recordSecurityChanges, SECURITY_CHANGE_SITES, type SecurityChangeSite } from "../test-helpers/security-change.js";
import { SoftAuthenticator } from "../test-helpers/soft-authenticator.js";
import { testRuntimePolicy } from "../test-helpers/test-runtime-policy.js";
import { adminDatabaseUrl, appPool, maintenancePool, superuserPool } from "./support/database.js";
import { seedRuntimeSession, seedSession } from "./support/fixtures.js";
import { devDataRoutes } from "../test-helpers/data-routes.js";

const META: RequestMeta = { ipAddress: null, userAgent: "integration" };
const SECRET = "security-change-sites-secret-at-least-32-chars";
const PASSWORD = "purple elephants dance quietly";
const SITE = { origin: "https://app.example.test", rpId: "app.example.test" };
const NOW = Date.now();
const tokenOf = (url: string) => url.split("#token=")[1]!;

function services(afterSecurityChange: AfterSecurityChange) {
  return {
    accounts: new LocalAccountService({
      db: appPool(), lookupDb: maintenancePool(), hasher: new PasswordHasher(4), frontendOrigin: SITE.origin, afterSecurityChange
    }),
    mfa: new LocalMfaService({ db: appPool(), secret: SECRET, issuer: "Cogniplane", afterSecurityChange, now: () => NOW }),
    passkeys: new LocalPasskeyService({
      db: appPool(), lookupDb: maintenancePool(), secret: SECRET, rpId: SITE.rpId, rpName: "Cogniplane", origin: SITE.origin,
      afterSecurityChange
    }),
    afterSecurityChange
  };
}
type Services = ReturnType<typeof services>;

async function versionOf(userId: string): Promise<number> {
  return (await superuserPool().query(`SELECT security_version FROM local_identities WHERE user_id = $1`, [userId])).rows[0].security_version;
}

type Fixture = { tenantId: string; ownerId: string; ownerEmail: string; memberId: string };

/** A local tenant with an active owner and an active member, both without a second factor. */
async function fixture(): Promise<Fixture> {
  const { accounts } = services(async () => {});
  const ownerEmail = `${randomUUID()}@example.test`;
  const boot = await bootstrapLocalTenant(superuserPool(), SITE.origin, { tenantName: "Security changes", ownerEmail, ownerName: null });
  await accounts.redeemLink("account_setup", tokenOf(boot.link.url), PASSWORD, META);
  const member = await accounts.createMember({
    tenantId: boot.tenantId, email: `${randomUUID()}@example.test`, displayName: null, role: "member", actorUserId: boot.userId, meta: META
  });
  await accounts.redeemLink("account_setup", tokenOf(member.link!.url), PASSWORD, META);
  return { tenantId: boot.tenantId, ownerId: boot.userId, ownerEmail, memberId: member.userId };
}

/** A turn of the account that started at its version now (a scheduled turn: no execution lease needed). */
async function liveContext(tenantId: string, userId: string): Promise<string> {
  const sessionId = await seedSession(tenantId, userId);
  const runtimeId = await seedRuntimeSession(tenantId, userId, sessionId);
  const store = new ToolExecutionContextStore(appPool());
  const context = await store.create({
    tenantId, sessionId, userId, runtimeId, runtimePolicyId: testRuntimePolicy.id, messageId: null,
    metadata: { runtimePolicy: testRuntimePolicy, turnContext: "scheduled" },
    ownerSecurityVersion: await versionOf(userId),
    ttlMs: 300_000
  });
  expect(await store.get(tenantId, context.toolContextId)).not.toBeNull();
  return context.toolContextId;
}

/** The tenant routes, called by the owner's local session, with a step-up that passes. */
async function tenantRoutes(t: Fixture, afterSecurityChange: AfterSecurityChange) {
  const app = Fastify();
  const ownerVersion = await versionOf(t.ownerId);
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: t.ownerId, tenantId: t.tenantId, role: "owner", isAdmin: true,
      session: { authSource: "local", familyId: "family-1", securityVersion: ownerVersion }
    };
  });
  const stepUp = {
    stepUp: { consume: async () => ["pwd"] },
    refreshTokens: { isActive: async () => true },
    mfa: { hasSecondFactor: async () => false }
  } as unknown as LocalAuth;
  await registerTenantRoutes(app, {
    db: appPool(), tenantOrgSettings: new TenantOrgSettingsStore(appPool(), SECRET), afterSecurityChange, localAuth: stepUp,
    dataRoutes: devDataRoutes()
  });
  await app.ready();
  onTestFinished(() => app.close());
  return app;
}

async function enrolTotp(s: Services, t: Fixture) {
  const started = await s.mfa.startTotpEnrollment(t.tenantId, t.memberId, await versionOf(t.memberId));
  const code = totpCode(base32Decode(started.secret), totpStep(NOW));
  return { confirm: async () => s.mfa.confirmTotpEnrollment(t.tenantId, t.memberId, code, await versionOf(t.memberId), META) };
}

async function startPasskey(s: Services, t: Fixture) {
  const authenticator = new SoftAuthenticator(SITE);
  const options = await s.passkeys.registrationOptions(t.tenantId, t.memberId, await versionOf(t.memberId));
  return {
    authenticator,
    register: async () => s.passkeys.register({
      tenantId: t.tenantId, userId: t.memberId, credential: authenticator.register(options), expectedChallenge: options.challenge,
      expectedVersion: await versionOf(t.memberId), name: undefined, meta: META
    })
  };
}

/** Each site: prepare, then the change (`act`) and the accounts it changes. */
type Case = (t: Fixture, s: Services) => Promise<{ act: () => Promise<unknown>; changed: string[] }>;

const CASES: Record<SecurityChangeSite, Case> = {
  "LocalAccountService.redeemLink": async (t, s) => {
    const created = await s.accounts.createMember({
      tenantId: t.tenantId, email: `${randomUUID()}@example.test`, displayName: null, role: "member", actorUserId: t.ownerId, meta: META
    });
    return { changed: [created.userId], act: () => s.accounts.redeemLink("account_setup", tokenOf(created.link!.url), PASSWORD, META) };
  },
  "LocalAccountService.changeOwnPassword": async (t, s) => ({
    changed: [t.memberId],
    act: async () => s.accounts.changeOwnPassword(t.tenantId, t.memberId, PASSWORD, "a different long passphrase", await versionOf(t.memberId), META)
  }),
  "LocalAccountService.revokeSessions": async (t, s) => ({
    changed: [t.memberId], act: () => s.accounts.revokeSessions(t.tenantId, t.memberId, t.memberId, META)
  }),
  "LocalAccountService.recoverOwner": async (t, s) => ({
    changed: [t.ownerId], act: () => s.accounts.recoverOwner(t.tenantId, t.ownerEmail)
  }),
  "LocalAccountService.resetMemberPassword": async (t, s) => ({
    changed: [t.memberId], act: () => s.accounts.resetMemberPassword(t.tenantId, t.memberId, t.ownerId, META)
  }),
  "LocalAccountService.disableMember": async (t, s) => ({
    changed: [t.memberId], act: () => s.accounts.disableMember(t.tenantId, t.memberId, t.ownerId, META)
  }),
  "LocalAccountService.enableMember": async (t, s) => {
    await s.accounts.disableMember(t.tenantId, t.memberId, t.ownerId, META);
    return { changed: [t.memberId], act: () => s.accounts.enableMember(t.tenantId, t.memberId, t.ownerId, META) };
  },
  "LocalMfaService.confirmTotpEnrollment": async (t, s) => {
    const { confirm } = await enrolTotp(s, t);
    return { changed: [t.memberId], act: confirm };
  },
  "LocalMfaService.removeOwnTotp": async (t, s) => {
    await (await enrolTotp(s, t)).confirm();
    return { changed: [t.memberId], act: async () => s.mfa.removeOwnTotp(t.tenantId, t.memberId, await versionOf(t.memberId), META) };
  },
  "LocalMfaService.resetMemberFactors": async (t, s) => ({
    changed: [t.memberId], act: () => s.mfa.resetMemberFactors(t.tenantId, t.memberId, t.ownerId, META)
  }),
  // A stricter rule changes every active account that it now covers and that has no second factor.
  "LocalMfaService.setPolicy": async (t, s) => ({
    changed: [t.ownerId, t.memberId],
    act: () => s.mfa.setPolicy(t.tenantId, t.ownerId, "required_for_all", META, { stepUpVerified: false })
  }),
  "LocalPasskeyService.register": async (t, s) => {
    const { register } = await startPasskey(s, t);
    return { changed: [t.memberId], act: register };
  },
  "LocalPasskeyService.remove": async (t, s) => {
    const { authenticator, register } = await startPasskey(s, t);
    await register();
    return {
      changed: [t.memberId],
      act: async () => s.passkeys.remove(t.tenantId, t.memberId, authenticator.id, await versionOf(t.memberId), META)
    };
  },
  // A promotion into the group that the MFA rule covers, of a member with no second factor.
  "PUT /tenant/members/:userId/role": async (t, s) => {
    await superuserPool().query(`UPDATE tenants SET mfa_policy = 'required_for_admins' WHERE tenant_id = $1`, [t.tenantId]);
    const app = await tenantRoutes(t, s.afterSecurityChange);
    return {
      changed: [t.memberId],
      act: async () => {
        const response = await app.inject({ method: "PUT", url: `/tenant/members/${t.memberId}/role`, payload: { role: "admin" } });
        expect(response.statusCode, response.body).toBe(200);
      }
    };
  },
  "DELETE /tenant/members/:userId": async (t, s) => {
    const app = await tenantRoutes(t, s.afterSecurityChange);
    return {
      changed: [t.memberId],
      act: async () => {
        const response = await app.inject({ method: "DELETE", url: `/tenant/members/${t.memberId}` });
        expect(response.statusCode, response.body).toBe(200);
      }
    };
  }
};

describe.skipIf(!adminDatabaseUrl())("every security change stops the account's active work", () => {
  test("the table has one case for each listed site", () => {
    expect(Object.keys(CASES).sort()).toEqual([...SECURITY_CHANGE_SITES].sort());
  });

  test.each([...SECURITY_CHANGE_SITES])("%s", async (site) => {
    const t = await fixture();
    const recorder = recordSecurityChanges();
    const s = services(recorder.after);
    const { act, changed } = await CASES[site](t, s);
    const before = new Map(await Promise.all(changed.map(async (userId) => [userId, await versionOf(userId)] as const)));
    const contexts = await Promise.all(changed.map((userId) => liveContext(t.tenantId, userId)));
    recorder.calls.length = 0;

    await act();

    expect(recorder.calls).toEqual([{ tenantId: t.tenantId, userIds: [...changed].sort() }]);
    for (const userId of changed) expect(await versionOf(userId)).toBeGreaterThan(before.get(userId)!);
    const store = new ToolExecutionContextStore(appPool());
    for (const toolContextId of contexts) {
      expect(await store.get(t.tenantId, toolContextId)).toBeNull();
      // The runtime loop of each turn, on every replica, stops it with this reason.
      expect(await store.liveness(t.tenantId, toolContextId)).toBe("security_change");
    }
  });

  test("a refused change stops nothing", async () => {
    const t = await fixture();
    const recorder = recordSecurityChanges();
    const s = services(recorder.after);
    const stale = (await versionOf(t.memberId)) - 1;
    await expect(s.accounts.changeOwnPassword(t.tenantId, t.memberId, PASSWORD, "a different long passphrase", stale, META))
      .rejects.toEqual(new LocalAccountError("session_changed"));
    expect(recorder.calls).toEqual([]);
  });
});

describe.skipIf(!adminDatabaseUrl())("a failure to stop the runtimes", () => {
  test("does not undo the security change, and the caller gets its result", async () => {
    const t = await fixture();
    const logger = { error: vi.fn(), info: vi.fn() };
    const unreachable = new Error("runtime did not stop");
    const s = services(stopActiveWork({
      runtimes: { invalidateRuntimesForUser: async () => { throw unreachable; } },
      logger
    }));
    const before = await versionOf(t.memberId);
    const context = await liveContext(t.tenantId, t.memberId);

    // A password change returns the identity of the new session.
    const identity = await s.accounts.changeOwnPassword(t.tenantId, t.memberId, PASSWORD, "a different long passphrase", before, META);

    expect(identity.securityVersion).toBe(before + 1);
    expect(await versionOf(t.memberId)).toBe(before + 1);
    expect(logger.error).toHaveBeenCalledWith(
      { err: unreachable, tenantId: t.tenantId, userId: t.memberId }, expect.stringContaining("failed to stop")
    );
    // The gateway still refuses the older turn.
    expect(await new ToolExecutionContextStore(appPool()).get(t.tenantId, context)).toBeNull();

    // A removal through the route commits too.
    const app = await tenantRoutes(t, s.afterSecurityChange);
    const removed = await app.inject({ method: "DELETE", url: `/tenant/members/${t.memberId}` });
    expect(removed.statusCode, removed.body).toBe(200);
    expect((await superuserPool().query(`SELECT 1 FROM tenant_memberships WHERE user_id = $1`, [t.memberId])).rowCount).toBe(0);
    expect(logger.error).toHaveBeenCalledTimes(2);
  });
});
