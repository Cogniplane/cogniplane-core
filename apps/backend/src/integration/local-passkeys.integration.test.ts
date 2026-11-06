// Passkeys of local accounts against a real Postgres with the production
// roles and the real WebAuthn checks (@simplewebauthn/server), fed by a
// software authenticator: registration, passwordless sign-in through the
// maintenance lookup, the second factor, origin and RP id binding, user
// verification, the signature counter, the user handle, and removal rules.

import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";

import { base32Decode, totpCode, totpStep } from "../lib/totp.js";
import { PasswordHasher } from "../lib/password-hash.js";
import { LocalAccountError, LocalAccountService, type RequestMeta } from "../services/auth/local-account-service.js";
import { LocalMfaService } from "../services/auth/local-mfa-service.js";
import { LocalPasskeyService } from "../services/auth/local-passkey-service.js";
import { bootstrapLocalTenant } from "../scripts/local-auth-commands-lib.js";
import { SoftAuthenticator } from "../test-helpers/soft-authenticator.js";
import { adminDatabaseUrl, appPool, maintenancePool, superuserPool } from "./support/database.js";
import { IGNORE_SECURITY_CHANGE } from "../test-helpers/security-change.js";

const META: RequestMeta = { ipAddress: null, userAgent: "integration" };
const SECRET = "local-passkeys-integration-secret-at-least-32";
const PASSWORD = "purple elephants dance quietly";
const SITE = { origin: "https://app.example.test", rpId: "app.example.test" };
const tokenOf = (url: string) => url.split("#token=")[1]!;

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LocalAccountError) return error.code;
    throw error;
  }
  return "ok";
}

function services() {
  return {
    accounts: new LocalAccountService({ afterSecurityChange: IGNORE_SECURITY_CHANGE, db: appPool(), lookupDb: maintenancePool(), hasher: new PasswordHasher(4), frontendOrigin: SITE.origin }),
    mfa: new LocalMfaService({ afterSecurityChange: IGNORE_SECURITY_CHANGE, db: appPool(), secret: SECRET, issuer: "Cogniplane" }),
    passkeys: new LocalPasskeyService({ afterSecurityChange: IGNORE_SECURITY_CHANGE,
      db: appPool(), lookupDb: maintenancePool(), secret: SECRET, rpId: SITE.rpId, rpName: "Cogniplane", origin: SITE.origin
    })
  };
}

async function versionOf(userId: string): Promise<number> {
  return (await superuserPool().query(`SELECT security_version FROM local_identities WHERE user_id = $1`, [userId])).rows[0].security_version;
}

/** A local tenant with an active owner and an active member. */
async function tenant() {
  const { accounts } = services();
  const boot = await bootstrapLocalTenant(superuserPool(), SITE.origin, { tenantName: "Passkeys", ownerEmail: `${randomUUID()}@example.test`, ownerName: null });
  await accounts.redeemLink("account_setup", tokenOf(boot.link.url), PASSWORD, META);
  const member = await accounts.createMember({ tenantId: boot.tenantId, email: `${randomUUID()}@example.test`, displayName: null, role: "member", actorUserId: boot.userId, meta: META });
  await accounts.redeemLink("account_setup", tokenOf(member.link!.url), PASSWORD, META);
  return { tenantId: boot.tenantId, ownerId: boot.userId, memberId: member.userId };
}

/** Registers a passkey for the user with the authenticator. */
async function addPasskey(passkeys: LocalPasskeyService, tenantId: string, userId: string, authenticator = new SoftAuthenticator(SITE)) {
  const options = await passkeys.registrationOptions(tenantId, userId, await versionOf(userId));
  const result = await passkeys.register({
    tenantId, userId, credential: authenticator.register(options), expectedChallenge: options.challenge,
    expectedVersion: await versionOf(userId), name: undefined, meta: META
  });
  return { authenticator, result };
}

describe.skipIf(!adminDatabaseUrl())("local passkeys (migration 073)", () => {
  test("a first passkey: stored, recovery codes, a new version; a second one changes no session", async () => {
    const t = await tenant();
    const { passkeys, mfa } = services();
    const before = await versionOf(t.memberId);

    const first = await addPasskey(passkeys, t.tenantId, t.memberId);
    expect(first.result.recoveryCodes).toHaveLength(10);
    expect(first.result.identity.securityVersion).toBe(before + 1);
    expect(first.result.passkey).toMatchObject({ id: first.authenticator.id, name: "Passkey 1", lastUsedAt: null });

    const second = await addPasskey(passkeys, t.tenantId, t.memberId);
    expect(second.result.recoveryCodes).toBeNull();
    expect(await versionOf(t.memberId)).toBe(before + 1);
    expect(await mfa.factorState(t.tenantId, t.memberId)).toMatchObject({ passkeyCount: 2, recoveryCodesRemaining: 10 });
    expect(await mfa.hasSecondFactor(t.tenantId, t.memberId)).toBe(true);
  });

  test("passwordless sign-in finds the account by credential id and checks the user handle", async () => {
    const t = await tenant();
    const { passkeys } = services();
    const { authenticator } = await addPasskey(passkeys, t.tenantId, t.memberId);

    const options = await passkeys.authenticationOptions();
    expect(options.allowCredentials ?? []).toEqual([]);
    const identity = await passkeys.verifyAssertion({ credential: authenticator.assert(options.challenge), expectedChallenge: options.challenge, meta: META });
    expect(identity).toMatchObject({ tenantId: t.tenantId, userId: t.memberId });
    const row = (await superuserPool().query(`SELECT counter, last_used_at FROM user_passkeys WHERE credential_id = $1`, [authenticator.id])).rows[0];
    expect(Number(row.counter)).toBe(1);
    expect(row.last_used_at).not.toBeNull();

    // A user handle of another account, or none, is refused.
    const again = await passkeys.authenticationOptions();
    const wrongHandle = Buffer.from(t.ownerId, "utf8").toString("base64url");
    expect(await codeOf(passkeys.verifyAssertion({ credential: authenticator.assert(again.challenge, { userHandle: wrongHandle }), expectedChallenge: again.challenge, meta: META })))
      .toBe("passkey_not_accepted");
    expect(await codeOf(passkeys.verifyAssertion({ credential: authenticator.assert(again.challenge, { userHandle: null }), expectedChallenge: again.challenge, meta: META })))
      .toBe("passkey_not_accepted");
  });

  test.each([
    ["another origin", { origin: "https://evil.example.test" }],
    ["another RP id", { rpId: "evil.example.test" }],
    ["no user verification", { userVerified: false }],
    ["another challenge", { challenge: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }],
    ["a registration answer", { type: "webauthn.create" }]
  ])("an assertion with %s is refused", async (_label, overrides) => {
    const t = await tenant();
    const { passkeys } = services();
    const { authenticator } = await addPasskey(passkeys, t.tenantId, t.memberId);
    const options = await passkeys.authenticationOptions();
    expect(await codeOf(passkeys.verifyAssertion({ credential: authenticator.assert(options.challenge, overrides), expectedChallenge: options.challenge, meta: META })))
      .toBe("passkey_not_accepted");
  });

  test.each([
    ["another origin", { origin: "https://evil.example.test" }],
    ["another RP id", { rpId: "evil.example.test" }],
    ["no user verification", { userVerified: false }]
  ])("a registration with %s is refused and stores nothing", async (_label, overrides) => {
    const t = await tenant();
    const { passkeys, mfa } = services();
    const options = await passkeys.registrationOptions(t.tenantId, t.memberId, await versionOf(t.memberId));
    const result = passkeys.register({
      tenantId: t.tenantId, userId: t.memberId, credential: new SoftAuthenticator(SITE).register(options, overrides),
      expectedChallenge: options.challenge, expectedVersion: await versionOf(t.memberId), name: "x", meta: META
    });
    expect(await codeOf(result)).toBe("passkey_not_accepted");
    expect((await mfa.factorState(t.tenantId, t.memberId)).passkeyCount).toBe(0);
  });

  test("the signature counter must move forward; a synced passkey keeps 0", async () => {
    const t = await tenant();
    const { passkeys } = services();
    const { authenticator } = await addPasskey(passkeys, t.tenantId, t.memberId, new SoftAuthenticator(SITE, 5));
    let options = await passkeys.authenticationOptions();
    await passkeys.verifyAssertion({ credential: authenticator.assert(options.challenge), expectedChallenge: options.challenge, meta: META });
    // A cloned authenticator replays an older counter.
    authenticator.setCounter(3);
    options = await passkeys.authenticationOptions();
    expect(await codeOf(passkeys.verifyAssertion({ credential: authenticator.assert(options.challenge), expectedChallenge: options.challenge, meta: META })))
      .toBe("passkey_not_accepted");

    const synced = (await addPasskey(passkeys, t.tenantId, t.ownerId, new SoftAuthenticator(SITE, 0, true))).authenticator;
    for (let i = 0; i < 2; i += 1) {
      options = await passkeys.authenticationOptions();
      await expect(passkeys.verifyAssertion({ credential: synced.assert(options.challenge), expectedChallenge: options.challenge, meta: META }))
        .resolves.toMatchObject({ userId: t.ownerId });
    }
  });

  test("as a second factor, only the expected account's passkey at its version works", async () => {
    const t = await tenant();
    const { passkeys } = services();
    const owner = await addPasskey(passkeys, t.tenantId, t.ownerId);
    await addPasskey(passkeys, t.tenantId, t.memberId);
    const expected = { tenantId: t.tenantId, userId: t.memberId, securityVersion: await versionOf(t.memberId) };

    const options = await passkeys.authenticationOptions(expected);
    expect(options.allowCredentials).toHaveLength(1);
    // The owner's passkey cannot answer the member's second step.
    expect(await codeOf(passkeys.verifyAssertion({ credential: owner.authenticator.assert(options.challenge), expectedChallenge: options.challenge, expected, meta: META })))
      .toBe("passkey_not_accepted");
    // A flow from an older version must start again.
    expect(await codeOf(passkeys.verifyAssertion({
      credential: owner.authenticator.assert(options.challenge), expectedChallenge: options.challenge,
      expected: { tenantId: t.tenantId, userId: t.ownerId, securityVersion: (await versionOf(t.ownerId)) - 1 }, meta: META
    }))).toBe("session_changed");
  });

  test("a disabled account cannot sign in with its passkey", async () => {
    const t = await tenant();
    const { passkeys, accounts } = services();
    const { authenticator } = await addPasskey(passkeys, t.tenantId, t.memberId);
    await accounts.disableMember(t.tenantId, t.memberId, t.ownerId, META);
    const options = await passkeys.authenticationOptions();
    expect(await codeOf(passkeys.verifyAssertion({ credential: authenticator.assert(options.challenge), expectedChallenge: options.challenge, meta: META })))
      .toBe("passkey_not_accepted");
  });

  test("removal: the last factor under a required policy is refused; with another factor left, the codes stay", async () => {
    const t = await tenant();
    const { passkeys, mfa } = services();
    const first = await addPasskey(passkeys, t.tenantId, t.ownerId);
    await superuserPool().query(`UPDATE tenants SET mfa_policy = 'required_for_admins' WHERE tenant_id = $1`, [t.tenantId]);
    expect(await codeOf(passkeys.remove(t.tenantId, t.ownerId, first.authenticator.id, await versionOf(t.ownerId), META))).toBe("mfa_required");
    expect((await mfa.factorState(t.tenantId, t.ownerId)).passkeyCount).toBe(1);

    // An authenticator app as well: then the passkey can go, and the codes stay.
    const now = Date.now();
    const started = await mfa.startTotpEnrollment(t.tenantId, t.ownerId, await versionOf(t.ownerId));
    await mfa.confirmTotpEnrollment(t.tenantId, t.ownerId, totpCode(base32Decode(started.secret), totpStep(now)), await versionOf(t.ownerId), META);
    const removed = await passkeys.remove(t.tenantId, t.ownerId, first.authenticator.id, await versionOf(t.ownerId), META);
    expect(removed.factorsLeft).toBe(true);
    expect(await mfa.factorState(t.tenantId, t.ownerId)).toMatchObject({ totpEnabled: true, passkeyCount: 0, recoveryCodesRemaining: 10 });

    // Turning off the app while a passkey remains also keeps the codes.
    await addPasskey(passkeys, t.tenantId, t.ownerId);
    const off = await mfa.removeOwnTotp(t.tenantId, t.ownerId, await versionOf(t.ownerId), META);
    expect(off.factorsLeft).toBe(true);
    expect(await mfa.factorState(t.tenantId, t.ownerId)).toMatchObject({ totpEnabled: false, passkeyCount: 1, recoveryCodesRemaining: 10 });
  });

  test("the last factor removed under an optional policy takes the recovery codes with it", async () => {
    const t = await tenant();
    const { passkeys, mfa } = services();
    const { authenticator } = await addPasskey(passkeys, t.tenantId, t.memberId);
    const removed = await passkeys.remove(t.tenantId, t.memberId, authenticator.id, await versionOf(t.memberId), META);
    expect(removed.factorsLeft).toBe(false);
    expect(await mfa.factorState(t.tenantId, t.memberId)).toMatchObject({ passkeyCount: 0, recoveryCodesRemaining: 0 });
  });

  test("a stricter policy spares members with a passkey; a manager reset removes passkeys", async () => {
    const t = await tenant();
    const { passkeys, mfa } = services();
    await addPasskey(passkeys, t.tenantId, t.memberId);
    const before = await versionOf(t.memberId);
    await mfa.setPolicy(t.tenantId, t.ownerId, "required_for_all", META, { stepUpVerified: false });
    expect(await versionOf(t.memberId)).toBe(before);

    await mfa.resetMemberFactors(t.tenantId, t.memberId, t.ownerId, META);
    expect(await mfa.factorState(t.tenantId, t.memberId)).toMatchObject({ passkeyCount: 0, mfaRequired: true });
  });

  test("one credential cannot be registered twice; the maintenance role cannot write passkeys", async () => {
    const t = await tenant();
    const { passkeys } = services();
    const { authenticator } = await addPasskey(passkeys, t.tenantId, t.memberId);
    const options = await passkeys.registrationOptions(t.tenantId, t.ownerId, await versionOf(t.ownerId));
    expect(options.excludeCredentials ?? []).toEqual([]);
    expect(await codeOf(passkeys.register({
      tenantId: t.tenantId, userId: t.ownerId, credential: authenticator.register(options), expectedChallenge: options.challenge,
      expectedVersion: await versionOf(t.ownerId), name: undefined, meta: META
    }))).toBe("passkey_exists");
    await expect(maintenancePool().query(`DELETE FROM user_passkeys WHERE credential_id = $1`, [authenticator.id])).rejects.toThrow(/permission denied/);
  });

  test("a recovery enrolment spends the checked code, and is refused once the codes changed", async () => {
    const t = await tenant();
    const { passkeys, mfa } = services();
    const first = await addPasskey(passkeys, t.tenantId, t.memberId);
    const codes = first.result.recoveryCodes!;
    const enrolWith = async (codeHash: string) => {
      const version = await versionOf(t.memberId);
      const options = await passkeys.registrationOptions(t.tenantId, t.memberId, version);
      return passkeys.register({
        tenantId: t.tenantId, userId: t.memberId, credential: new SoftAuthenticator(SITE).register(options),
        expectedChallenge: options.challenge, expectedVersion: version, name: undefined, recoveryCodeHash: codeHash, meta: META
      });
    };

    const checked = await mfa.checkRecoveryCode(t.tenantId, t.memberId, codes[0]!, await versionOf(t.memberId));
    const recovered = await enrolWith(checked.codeHash);
    expect(recovered.recoveryCodes).toHaveLength(10);
    expect(recovered.recoveryCodes).not.toContain(codes[0]);

    // A code checked before the codes were replaced cannot enrol afterwards.
    const stale = await mfa.checkRecoveryCode(t.tenantId, t.memberId, recovered.recoveryCodes![0]!, await versionOf(t.memberId));
    await mfa.regenerateRecoveryCodes(t.tenantId, t.memberId, await versionOf(t.memberId), META);
    expect(await codeOf(enrolWith(stale.codeHash))).toBe("invalid_code");
    expect((await mfa.factorState(t.tenantId, t.memberId)).passkeyCount).toBe(2);
  });
});
