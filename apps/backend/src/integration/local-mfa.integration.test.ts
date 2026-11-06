// Second factors of local accounts against a real Postgres with the
// production roles: enrolment, single use of TOTP steps and recovery codes
// (also under concurrency), the tenant policy, and the manager reset.

import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";

import { PasswordHasher } from "../lib/password-hash.js";
import { base32Decode, totpCode, totpStep } from "../lib/totp.js";
import { LocalAccountError, LocalAccountService, type RequestMeta } from "../services/auth/local-account-service.js";
import { LocalMfaService } from "../services/auth/local-mfa-service.js";
import { lockTenantMembership } from "../services/member-authority.js";
import { bootstrapLocalTenant } from "../scripts/local-auth-commands-lib.js";
import { adminDatabaseUrl, appPool, maintenancePool, superuserPool } from "./support/database.js";
import { IGNORE_SECURITY_CHANGE } from "../test-helpers/security-change.js";
import { withSecurityChange } from "../services/auth/security-change.js";

const META: RequestMeta = { ipAddress: null, userAgent: "integration" };
const SECRET = "local-mfa-integration-secret-at-least-32-chars";
const PASSWORD = "purple elephants dance quietly";
const tokenOf = (url: string) => url.split("#token=")[1]!;
const NO_STEP_UP = { stepUpVerified: false };
const STEPPED_UP = { stepUpVerified: true };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves to "pending" when the promise has not settled after `ms`. */
async function settledWithin(promise: Promise<unknown>, ms: number): Promise<"settled" | "pending"> {
  return Promise.race([promise.then(() => "settled" as const, () => "settled" as const), pause(ms).then(() => "pending" as const)]);
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

function services(now: () => number = Date.now) {
  return {
    accounts: new LocalAccountService({ afterSecurityChange: IGNORE_SECURITY_CHANGE, db: appPool(), lookupDb: maintenancePool(), hasher: new PasswordHasher(4), frontendOrigin: "https://app.test" }),
    mfa: new LocalMfaService({ afterSecurityChange: IGNORE_SECURITY_CHANGE, db: appPool(), secret: SECRET, issuer: "Cogniplane", now })
  };
}

async function versionOf(userId: string): Promise<number> {
  return (await superuserPool().query(`SELECT security_version FROM local_identities WHERE user_id = $1`, [userId])).rows[0].security_version;
}

/** A local tenant with an active owner and an active member. */
async function tenant() {
  const { accounts } = services();
  const boot = await bootstrapLocalTenant(superuserPool(), "https://app.test", { tenantName: "MFA", ownerEmail: `${randomUUID()}@example.test`, ownerName: null });
  await accounts.redeemLink("account_setup", tokenOf(boot.link.url), PASSWORD, META);
  const member = await accounts.createMember({ tenantId: boot.tenantId, email: `${randomUUID()}@example.test`, displayName: null, role: "member", actorUserId: boot.userId, meta: META });
  await accounts.redeemLink("account_setup", tokenOf(member.link!.url), PASSWORD, META);
  return { tenantId: boot.tenantId, ownerId: boot.userId, memberId: member.userId };
}

/** Enrols an authenticator for the user; returns its secret and the codes. */
async function enrol(mfa: LocalMfaService, tenantId: string, userId: string, nowMs: number) {
  const started = await mfa.startTotpEnrollment(tenantId, userId, await versionOf(userId));
  const code = totpCode(base32Decode(started.secret), totpStep(nowMs));
  const done = await mfa.confirmTotpEnrollment(tenantId, userId, code, await versionOf(userId), META);
  return { secret: started.secret, recoveryCodes: done.recoveryCodes, securityVersion: done.identity.securityVersion };
}

describe.skipIf(!adminDatabaseUrl())("local second factors (migration 072)", () => {
  test("enrolment: an encrypted secret, ten hashed codes, a new version, the reset flag cleared", async () => {
    const t = await tenant();
    await superuserPool().query(`UPDATE local_identities SET mfa_enrollment_required = true WHERE user_id = $1`, [t.memberId]);
    const before = await versionOf(t.memberId);
    const now = Date.now();
    const { mfa } = services(() => now);

    const { secret, recoveryCodes, securityVersion } = await enrol(mfa, t.tenantId, t.memberId, now);

    expect(securityVersion).toBe(before + 1);
    expect(recoveryCodes).toHaveLength(10);
    const row = (await superuserPool().query(
      `SELECT f.secret_encrypted, f.confirmed_at, f.pending_secret_encrypted, li.mfa_enrollment_required
       FROM user_totp_factors f JOIN local_identities li USING (tenant_id, user_id) WHERE f.user_id = $1`,
      [t.memberId]
    )).rows[0];
    expect(row.confirmed_at).not.toBeNull();
    expect(row.pending_secret_encrypted).toBeNull();
    expect(row.secret_encrypted).not.toContain(secret);
    expect(row.mfa_enrollment_required).toBe(false);
    const stored = await superuserPool().query(`SELECT code_hash FROM user_recovery_codes WHERE user_id = $1`, [t.memberId]);
    expect(stored.rowCount).toBe(10);
    for (const { code_hash } of stored.rows) expect(recoveryCodes.join()).not.toContain(code_hash);
    expect(await mfa.factorState(t.tenantId, t.memberId)).toEqual({ totpEnabled: true, passkeyCount: 0, recoveryCodesRemaining: 10, mfaRequired: false });
  });

  test("a TOTP step works once, also when two requests send it at the same time", async () => {
    const t = await tenant();
    let now = Date.now();
    const { mfa } = services(() => now);
    const { secret } = await enrol(mfa, t.tenantId, t.memberId, now);
    const version = await versionOf(t.memberId);

    // The enrolment spent this step; the next one works once.
    now += 30_000;
    const code = totpCode(base32Decode(secret), totpStep(now));
    const outcomes = await Promise.all([
      codeOf(mfa.verifyTotp(t.tenantId, t.memberId, code, version)),
      codeOf(mfa.verifyTotp(t.tenantId, t.memberId, code, version))
    ]);
    expect(outcomes.sort()).toEqual(["invalid_code", "ok"]);
    // An older step after a newer one is a replay too.
    const older = totpCode(base32Decode(secret), totpStep(now) - 1);
    expect(await codeOf(mfa.verifyTotp(t.tenantId, t.memberId, older, version))).toBe("invalid_code");
    // A flow or session from an older version cannot use a code.
    now += 30_000;
    expect(await codeOf(mfa.verifyTotp(t.tenantId, t.memberId, totpCode(base32Decode(secret), totpStep(now)), version - 1))).toBe("session_changed");
  });

  test("a recovery code is checked in any typed form, and an enrolment spends it once, also at the same time", async () => {
    const t = await tenant();
    const now = Date.now();
    const { mfa } = services(() => now);
    const { secret, recoveryCodes } = await enrol(mfa, t.tenantId, t.memberId, now);
    const version = await versionOf(t.memberId);
    const typed = recoveryCodes[0]!.toLowerCase().replace(/-/g, " ");

    // Checking spends nothing.
    const checked = await mfa.checkRecoveryCode(t.tenantId, t.memberId, typed, version);
    expect((await mfa.factorState(t.tenantId, t.memberId)).recoveryCodesRemaining).toBe(10);
    expect(await codeOf(mfa.checkRecoveryCode(t.tenantId, t.memberId, "AAAA-BBBB-CCCC-DDDD", version))).toBe("invalid_code");

    // Two enrolments that carry the same checked code: one wins.
    const started = await mfa.startTotpEnrollment(t.tenantId, t.memberId, version);
    const code = totpCode(base32Decode(started.secret), totpStep(now + 30_000));
    const later = services(() => now + 30_000).mfa;
    const outcomes = await Promise.all([
      codeOf(later.confirmTotpEnrollment(t.tenantId, t.memberId, code, version, META, { recoveryCodeHash: checked.codeHash })),
      codeOf(later.confirmTotpEnrollment(t.tenantId, t.memberId, code, version, META, { recoveryCodeHash: checked.codeHash }))
    ]);
    expect(outcomes).toContain("ok");
    expect(outcomes.filter((outcome) => outcome === "ok")).toHaveLength(1);
    expect(secret).not.toBe(started.secret);
  });

  test("a TOTP recovery enrolment is refused once the codes changed after the check", async () => {
    const t = await tenant();
    const now = Date.now();
    const { mfa } = services(() => now);
    const { recoveryCodes } = await enrol(mfa, t.tenantId, t.memberId, now);
    const checked = await mfa.checkRecoveryCode(t.tenantId, t.memberId, recoveryCodes[0]!, await versionOf(t.memberId));
    await mfa.regenerateRecoveryCodes(t.tenantId, t.memberId, await versionOf(t.memberId), META);
    const version = await versionOf(t.memberId);
    const started = await mfa.startTotpEnrollment(t.tenantId, t.memberId, version);
    const later = services(() => now + 30_000).mfa;
    const code = totpCode(base32Decode(started.secret), totpStep(now + 30_000));
    expect(await codeOf(later.confirmTotpEnrollment(t.tenantId, t.memberId, code, version, META, { recoveryCodeHash: checked.codeHash })))
      .toBe("invalid_code");
  });

  test("an enrolment whose session cannot start rolls back: no factor, no spent code, no new version", async () => {
    const t = await tenant();
    const now = Date.now();
    const { mfa } = services(() => now);
    const { recoveryCodes } = await enrol(mfa, t.tenantId, t.memberId, now);
    const version = await versionOf(t.memberId);
    const checked = await mfa.checkRecoveryCode(t.tenantId, t.memberId, recoveryCodes[0]!, version);
    const started = await mfa.startTotpEnrollment(t.tenantId, t.memberId, version);
    const later = services(() => now + 30_000).mfa;
    const code = totpCode(base32Decode(started.secret), totpStep(now + 30_000));

    const failing = later.confirmTotpEnrollment(t.tenantId, t.memberId, code, version, META, {
      recoveryCodeHash: checked.codeHash,
      beforeCommit: async () => { throw new Error("refresh store down"); }
    });
    await expect(failing).rejects.toThrow("refresh store down");
    expect(await versionOf(t.memberId)).toBe(version);
    const used = await superuserPool().query(`SELECT count(*)::int AS n FROM user_recovery_codes WHERE user_id = $1 AND used_at IS NOT NULL`, [t.memberId]);
    expect(used.rows[0].n).toBe(0);
    const pending = await superuserPool().query(`SELECT pending_secret_encrypted FROM user_totp_factors WHERE user_id = $1`, [t.memberId]);
    expect(pending.rows[0].pending_secret_encrypted).not.toBeNull();
  });

  test("the policy keeps a covered account from removing its factor", async () => {
    const t = await tenant();
    const now = Date.now();
    const { mfa } = services(() => now);
    await enrol(mfa, t.tenantId, t.ownerId, now);
    await mfa.setPolicy(t.tenantId, t.ownerId, "required_for_admins", META, NO_STEP_UP);
    expect(await codeOf(mfa.removeOwnTotp(t.tenantId, t.ownerId, await versionOf(t.ownerId), META))).toBe("mfa_required");

    await enrol(mfa, t.tenantId, t.memberId, now);
    const removed = await mfa.removeOwnTotp(t.tenantId, t.memberId, await versionOf(t.memberId), META);
    expect(removed.identity.securityVersion).toBe(await versionOf(t.memberId));
    expect(removed.factorsLeft).toBe(false);
    expect(await mfa.factorState(t.tenantId, t.memberId)).toMatchObject({ totpEnabled: false, recoveryCodesRemaining: 0 });
  });

  test("a stricter policy ends the sessions of covered members without a factor, and only those", async () => {
    const t = await tenant();
    const now = Date.now();
    const { mfa, accounts } = services(() => now);
    const admin = await accounts.createMember({ tenantId: t.tenantId, email: `${randomUUID()}@example.test`, displayName: null, role: "admin", actorUserId: t.ownerId, meta: META });
    await accounts.redeemLink("account_setup", tokenOf(admin.link!.url), PASSWORD, META);
    await enrol(mfa, t.tenantId, t.ownerId, now);
    const before = { owner: await versionOf(t.ownerId), admin: await versionOf(admin.userId), member: await versionOf(t.memberId) };

    await mfa.setPolicy(t.tenantId, t.ownerId, "required_for_admins", META, NO_STEP_UP);

    expect(await versionOf(t.ownerId)).toBe(before.owner);
    expect(await versionOf(admin.userId)).toBe(before.admin + 1);
    expect(await versionOf(t.memberId)).toBe(before.member);
    expect((await mfa.factorState(t.tenantId, admin.userId)).mfaRequired).toBe(true);

    // Only an owner makes it weaker again.
    expect(await codeOf(mfa.setPolicy(t.tenantId, admin.userId, "optional", META, STEPPED_UP))).toBe("only_owner_can_weaken_policy");
    await mfa.setPolicy(t.tenantId, t.ownerId, "optional", META, STEPPED_UP);
  });

  test("a promotion into the covered group ends the member's sessions when it has no factor", async () => {
    const t = await tenant();
    const { mfa } = services();
    await superuserPool().query(`UPDATE tenants SET mfa_policy = 'required_for_admins' WHERE tenant_id = $1`, [t.tenantId]);
    const before = await versionOf(t.memberId);
    // As the role route does: the role update, then the policy check.
    await withSecurityChange(appPool(), t.tenantId, IGNORE_SECURITY_CHANGE, async (client, change) => {
      await client.query(`UPDATE tenant_memberships SET role = 'admin' WHERE tenant_id = $1 AND user_id = $2`, [t.tenantId, t.memberId]);
      await LocalMfaService.applyPolicyToRoleChange(change, t.memberId, "member", "admin");
    });
    expect(await versionOf(t.memberId)).toBe(before + 1);
    expect((await mfa.factorState(t.tenantId, t.memberId)).mfaRequired).toBe(true);
  });

  test("a manager's factor reset: factors gone, enrolment required, sessions ended, rights checked", async () => {
    const t = await tenant();
    const now = Date.now();
    const { mfa } = services(() => now);
    await enrol(mfa, t.tenantId, t.memberId, now);
    const before = await versionOf(t.memberId);

    await mfa.resetMemberFactors(t.tenantId, t.memberId, t.ownerId, META);

    expect(await versionOf(t.memberId)).toBe(before + 1);
    expect(await mfa.factorState(t.tenantId, t.memberId)).toEqual({ totpEnabled: false, passkeyCount: 0, recoveryCodesRemaining: 0, mfaRequired: true });
    // A member cannot reset anyone; nobody resets an owner.
    expect(await codeOf(mfa.resetMemberFactors(t.tenantId, t.ownerId, t.memberId, META))).toBe("not_a_manager");
  });

  test("a password change from a session older than a new factor is refused", async () => {
    const t = await tenant();
    const now = Date.now();
    const { mfa, accounts } = services(() => now);
    // The session's version, read before the factor is confirmed (the
    // password change was waiting on its hash).
    const sessionVersion = await versionOf(t.memberId);
    await enrol(mfa, t.tenantId, t.memberId, now);
    const hashOf = async () =>
      (await superuserPool().query(`SELECT password_hash FROM local_passwords WHERE user_id = $1`, [t.memberId])).rows[0].password_hash;
    const before = await hashOf();

    expect(await codeOf(accounts.changeOwnPassword(t.tenantId, t.memberId, PASSWORD, "a different long passphrase", sessionVersion, META)))
      .toBe("session_changed");
    expect(await hashOf()).toBe(before);
  });

  test("a weaker policy needs the route's step-up, checked against the policy under the lock", async () => {
    const t = await tenant();
    const { mfa } = services();
    // The route read 'optional' and saw no weakening, so it asked for no
    // step-up; another manager made the policy stricter before the lock.
    await mfa.setPolicy(t.tenantId, t.ownerId, "required_for_all", META, NO_STEP_UP);
    expect(await codeOf(mfa.setPolicy(t.tenantId, t.ownerId, "optional", META, NO_STEP_UP))).toBe("policy_changed");
    expect(await mfa.getPolicy(t.tenantId)).toBe("required_for_all");
    await mfa.setPolicy(t.tenantId, t.ownerId, "optional", META, STEPPED_UP);
    expect(await mfa.getPolicy(t.tenantId)).toBe("optional");
  });

  test("a factor removal waits for a policy change in progress, then sees the new policy", async () => {
    const t = await tenant();
    const now = Date.now();
    const { mfa } = services(() => now);
    await enrol(mfa, t.tenantId, t.memberId, now);
    const version = await versionOf(t.memberId);

    // A policy change holds the tenant lock and has not committed yet.
    const holder = await superuserPool().connect();
    try {
      await holder.query("BEGIN");
      await lockTenantMembership(holder, t.tenantId);
      await holder.query(`UPDATE tenants SET mfa_policy = 'required_for_all' WHERE tenant_id = $1`, [t.tenantId]);

      const removal = codeOf(mfa.removeOwnTotp(t.tenantId, t.memberId, version, META));
      expect(await settledWithin(removal, 300)).toBe("pending");
      await holder.query("COMMIT");
      expect(await removal).toBe("mfa_required");
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
    expect((await mfa.factorState(t.tenantId, t.memberId)).totpEnabled).toBe(true);
  });

  test("a stricter policy and an enrolment that holds the identity do not deadlock", async () => {
    const t = await tenant();
    const { mfa } = services();
    // As startTotpEnrollment does: the identity lock, then a factor row whose
    // foreign key to tenants needs a key-share lock on the tenant row.
    const enrolment = await superuserPool().connect();
    try {
      await enrolment.query("BEGIN");
      await enrolment.query(`SELECT 1 FROM local_identities WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE`, [t.tenantId, t.memberId]);
      // The policy change reaches the member's identity and waits for it.
      const policy = codeOf(mfa.setPolicy(t.tenantId, t.ownerId, "required_for_all", META, NO_STEP_UP));
      expect(await settledWithin(policy, 300)).toBe("pending");
      await enrolment.query(
        `INSERT INTO user_totp_factors (tenant_id, user_id, pending_secret_encrypted, pending_created_at) VALUES ($1, $2, 'x', now())`,
        [t.tenantId, t.memberId]
      );
      await enrolment.query("COMMIT");
      expect(await policy).toBe("ok");
    } finally {
      await enrolment.query("ROLLBACK").catch(() => undefined);
      enrolment.release();
    }
    expect(await mfa.getPolicy(t.tenantId)).toBe("required_for_all");
  });

  test("a manager action from a session older than the manager's account is refused", async () => {
    const t = await tenant();
    const now = Date.now();
    const { mfa } = services(() => now);
    // The owner's session was made before the owner's first factor.
    const sessionVersion = await versionOf(t.ownerId);
    await enrol(mfa, t.tenantId, t.ownerId, now);
    const actor = { userId: t.ownerId, securityVersion: sessionVersion };
    expect(await codeOf(mfa.resetMemberFactors(t.tenantId, t.memberId, actor, META))).toBe("not_a_manager");
    expect(await codeOf(mfa.setPolicy(t.tenantId, actor, "required_for_all", META, NO_STEP_UP))).toBe("not_a_manager");
    // The current session's version works.
    await expect(mfa.setPolicy(t.tenantId, { userId: t.ownerId, securityVersion: await versionOf(t.ownerId) }, "required_for_all", META, NO_STEP_UP))
      .resolves.toEqual({ previous: "optional" });
  });

  test("a manager action waits for an uncommitted change of the manager's account, then sees it", async () => {
    const t = await tenant();
    const { accounts } = services();
    const actor = { userId: t.ownerId, securityVersion: await versionOf(t.ownerId) };
    const holder = await superuserPool().connect();
    try {
      // The owner's own change (for example a first factor) is in progress.
      await holder.query("BEGIN");
      await holder.query(`UPDATE local_identities SET security_version = security_version + 1 WHERE user_id = $1`, [t.ownerId]);
      const action = codeOf(accounts.disableMember(t.tenantId, t.memberId, actor, META));
      expect(await settledWithin(action, 300)).toBe("pending");
      await holder.query("COMMIT");
      expect(await action).toBe("not_a_manager");
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
    expect((await superuserPool().query(`SELECT status FROM local_identities WHERE user_id = $1`, [t.memberId])).rows[0].status).toBe("active");
  });

  test("a pending enrolment older than 15 minutes must be started again", async () => {
    const t = await tenant();
    let now = Date.now();
    const { mfa } = services(() => now);
    const started = await mfa.startTotpEnrollment(t.tenantId, t.memberId, await versionOf(t.memberId));
    now += 16 * 60_000;
    const code = totpCode(base32Decode(started.secret), totpStep(now));
    expect(await codeOf(mfa.confirmTotpEnrollment(t.tenantId, t.memberId, code, await versionOf(t.memberId), META))).toBe("enrollment_not_started");
  });

  // Migration 079. A self-service enrolment is bound to the session family
  // that started it (after its step-up). Another session of the account, for
  // example one from a stolen access token, cannot confirm it, even with a
  // correct code. A sign-in enrolment (no family) and a self-service one
  // never confirm each other's secret.
  test("only the session family that started an enrolment can confirm it", async () => {
    const t = await tenant();
    const now = Date.now();
    const { mfa } = services(() => now);
    const version = await versionOf(t.memberId);
    const started = await mfa.startTotpEnrollment(t.tenantId, t.memberId, version, { familyId: "family-a" });
    const stored = await superuserPool().query(`SELECT pending_family_id FROM user_totp_factors WHERE user_id = $1`, [t.memberId]);
    expect(stored.rows[0].pending_family_id).toBe("family-a");
    const code = totpCode(base32Decode(started.secret), totpStep(now));

    for (const familyId of ["family-b", undefined]) {
      expect(await codeOf(mfa.confirmTotpEnrollment(t.tenantId, t.memberId, code, version, META, { familyId }))).toBe("enrollment_not_started");
    }
    // Nothing changed: no factor, same version, the pending secret is still there.
    const after = await superuserPool().query(
      `SELECT confirmed_at, pending_secret_encrypted FROM user_totp_factors WHERE user_id = $1`, [t.memberId]
    );
    expect(after.rows[0].confirmed_at).toBeNull();
    expect(after.rows[0].pending_secret_encrypted).not.toBeNull();
    expect(await versionOf(t.memberId)).toBe(version);

    await mfa.confirmTotpEnrollment(t.tenantId, t.memberId, code, version, META, { familyId: "family-a" });
    const done = await superuserPool().query(
      `SELECT confirmed_at, pending_family_id FROM user_totp_factors WHERE user_id = $1`, [t.memberId]
    );
    expect(done.rows[0].confirmed_at).not.toBeNull();
    expect(done.rows[0].pending_family_id).toBeNull();
  });

  test("a session cannot confirm the secret of a sign-in enrolment", async () => {
    const t = await tenant();
    const now = Date.now();
    const { mfa } = services(() => now);
    const version = await versionOf(t.memberId);
    const started = await mfa.startTotpEnrollment(t.tenantId, t.memberId, version);
    const code = totpCode(base32Decode(started.secret), totpStep(now));
    expect(await codeOf(mfa.confirmTotpEnrollment(t.tenantId, t.memberId, code, version, META, { familyId: "family-a" })))
      .toBe("enrollment_not_started");
    // The sign-in path still works.
    expect(await codeOf(mfa.confirmTotpEnrollment(t.tenantId, t.memberId, code, version, META))).toBe("ok");
  });

  test("a new start in another family replaces the binding", async () => {
    const t = await tenant();
    const now = Date.now();
    const { mfa } = services(() => now);
    const version = await versionOf(t.memberId);
    await mfa.startTotpEnrollment(t.tenantId, t.memberId, version, { familyId: "family-a" });
    const restarted = await mfa.startTotpEnrollment(t.tenantId, t.memberId, version, { familyId: "family-b" });
    const code = totpCode(base32Decode(restarted.secret), totpStep(now));
    expect(await codeOf(mfa.confirmTotpEnrollment(t.tenantId, t.memberId, code, version, META, { familyId: "family-a" })))
      .toBe("enrollment_not_started");
    expect(await codeOf(mfa.confirmTotpEnrollment(t.tenantId, t.memberId, code, version, META, { familyId: "family-b" }))).toBe("ok");
  });
});
