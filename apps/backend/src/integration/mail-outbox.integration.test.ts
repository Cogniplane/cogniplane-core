// Email for local accounts against a real Postgres with the production
// roles: security notices are written in the same transaction as the change
// (and vanish with its rollback), they are encrypted at rest, and the outbox
// worker on the maintenance pool sends each message once, retries, expires,
// recovers the claims of a stopped process, and purges. RLS and grants too.

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { decrypt } from "../lib/crypto-utils.js";
import { withTenantScope } from "../lib/db.js";
import { PasswordHasher } from "../lib/password-hash.js";
import { base32Decode, totpCode, totpStep } from "../lib/totp.js";
import { LocalAccountError, LocalAccountService, type RequestMeta } from "../services/auth/local-account-service.js";
import { LocalMfaService } from "../services/auth/local-mfa-service.js";
import { LocalPasskeyService } from "../services/auth/local-passkey-service.js";
import { encryptMail, MailOutbox } from "../services/mail/mail-outbox.js";
import { MailOutboxWorker } from "../services/mail/mail-outbox-worker.js";
import { classifySendError, type MailSender, type OutgoingMail, SmtpMailSender } from "../services/mail/mail-sender.js";
import { parseSmtpUrl } from "../lib/smtp-settings.js";
import { bootstrapLocalTenant } from "../scripts/local-auth-commands-lib.js";
import { TenantMemberStore } from "../services/tenant-member-store.js";
import { SoftAuthenticator } from "../test-helpers/soft-authenticator.js";
import { adminDatabaseUrl, appPool, maintenancePool, superuserPool } from "./support/database.js";
import { IGNORE_SECURITY_CHANGE } from "../test-helpers/security-change.js";

const META: RequestMeta = { ipAddress: null, userAgent: "integration" };
const SECRET = "mail-outbox-integration-secret-at-least-32-chars";
const PASSWORD = "purple elephants dance quietly";
const NEW_PASSWORD = "seven orange kites drift slowly";
const SITE = { origin: "https://app.example.test", rpId: "app.example.test" };
const tokenOf = (url: string) => url.split("#token=")[1]!;
const quietLogger = { info: () => {}, warn: () => {}, error: () => {} };

function services() {
  const notices = new MailOutbox({ secret: SECRET });
  return {
    accounts: new LocalAccountService({ afterSecurityChange: IGNORE_SECURITY_CHANGE,
      db: appPool(), lookupDb: maintenancePool(), hasher: new PasswordHasher(4), frontendOrigin: SITE.origin, notices
    }),
    mfa: new LocalMfaService({ afterSecurityChange: IGNORE_SECURITY_CHANGE, db: appPool(), secret: SECRET, issuer: "Cogniplane", notices }),
    passkeys: new LocalPasskeyService({ afterSecurityChange: IGNORE_SECURITY_CHANGE,
      db: appPool(), lookupDb: maintenancePool(), secret: SECRET, rpId: SITE.rpId, rpName: "Cogniplane", origin: SITE.origin, notices
    })
  };
}

async function versionOf(userId: string): Promise<number> {
  return (await superuserPool().query(`SELECT security_version FROM local_identities WHERE user_id = $1`, [userId])).rows[0].security_version;
}

/** Without email: a manager gets the link to pass on. */
function plainAccounts() {
  return new LocalAccountService({ afterSecurityChange: IGNORE_SECURITY_CHANGE, db: appPool(), lookupDb: maintenancePool(), hasher: new PasswordHasher(4), frontendOrigin: SITE.origin });
}

/**
 * A local tenant with an active owner and an active member, set up without
 * email (so the outbox starts empty). Setup itself sends no notice.
 */
async function tenant(name = "Acme Mail") {
  const accounts = plainAccounts();
  const boot = await bootstrapLocalTenant(superuserPool(), SITE.origin, { tenantName: name, ownerEmail: `${randomUUID()}@example.test`, ownerName: "Olive Owner" });
  await accounts.redeemLink("account_setup", tokenOf(boot.link.url), PASSWORD, META);
  const memberEmail = `${randomUUID()}@example.test`;
  const member = await accounts.createMember({ tenantId: boot.tenantId, email: memberEmail, displayName: "Max Member", role: "member", actorUserId: boot.userId, meta: META });
  await accounts.redeemLink("account_setup", tokenOf(member.link!.url), PASSWORD, META);
  return { tenantId: boot.tenantId, ownerId: boot.userId, memberId: member.userId, memberEmail };
}

type OutboxRow = {
  email_id: string; kind: string; status: string; message_encrypted: string | null; attempts: number;
  last_error: string | null; sent_at: Date | null; claim_token: string | null; next_attempt_at: Date;
};

async function outboxOf(userId: string): Promise<OutboxRow[]> {
  return (await superuserPool().query<OutboxRow>(
    `SELECT email_id, kind, status, message_encrypted, attempts, last_error, sent_at, claim_token, next_attempt_at
     FROM email_outbox WHERE user_id = $1 ORDER BY created_at, email_id`,
    [userId]
  )).rows;
}

function mailOf(row: OutboxRow): OutgoingMail {
  return JSON.parse(decrypt(row.message_encrypted!, SECRET)) as OutgoingMail;
}

/** The one-time link in a queued link email. */
function linkIn(row: OutboxRow): string {
  return /https:\/\/\S+#token=[A-Za-z0-9_-]{43}/.exec(mailOf(row).text)![0];
}

/** A sender that records each message; `fail` makes it throw instead. */
class FakeSender implements MailSender {
  sent: OutgoingMail[] = [];
  fail: ((mail: OutgoingMail) => unknown) | null = null;
  gate: Promise<void> | null = null;

  async send(mail: OutgoingMail): Promise<void> {
    if (this.gate) await this.gate;
    const error = this.fail?.(mail);
    if (error) throw error;
    this.sent.push(mail);
  }

  close(): void {}
}

function worker(sender: MailSender) {
  return new MailOutboxWorker({ db: maintenancePool(), sender, secret: SECRET, logger: quietLogger });
}

describe.skipIf(!adminDatabaseUrl())("email outbox (migration 074)", () => {
  // The worker serves every tenant, so each test starts from an empty outbox.
  // Integration files run one at a time (vitest.integration.config.ts).
  beforeEach(async () => {
    await superuserPool().query(`DELETE FROM email_outbox`);
  });
  afterEach(async () => {
    await superuserPool().query(`DELETE FROM email_outbox`);
  });

  test("a password change queues one encrypted notice in its transaction; account setup queues none", async () => {
    const t = await tenant();
    expect(await outboxOf(t.memberId)).toEqual([]);

    const { accounts } = services();
    await accounts.changeOwnPassword(t.tenantId, t.memberId, PASSWORD, NEW_PASSWORD, await versionOf(t.memberId), META);

    const rows = await outboxOf(t.memberId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "password_changed", status: "queued", attempts: 0 });
    // Encrypted at rest: neither the address nor the text is readable.
    expect(rows[0]!.message_encrypted).not.toContain(t.memberEmail);
    expect(rows[0]!.message_encrypted).not.toContain("password");
    const mail = mailOf(rows[0]!);
    expect(mail.to).toBe(t.memberEmail);
    expect(mail.subject).toBe("Acme Mail: Your password was changed");
    expect(mail.text).toContain("Hello Max Member,");
    expect(mail.text).not.toMatch(/https?:\/\//);
  });

  test("a change that rolls back leaves no notice", async () => {
    const t = await tenant();
    const { accounts } = services();
    // The session's version is old: the change is refused after the notice
    // code would have run, and the whole transaction rolls back.
    const stale = (await versionOf(t.memberId)) - 1;
    await expect(accounts.changeOwnPassword(t.tenantId, t.memberId, PASSWORD, NEW_PASSWORD, stale, META))
      .rejects.toMatchObject({ code: "session_changed" });
    // A notice queued in a transaction that then fails goes with it.
    const outbox = new MailOutbox({ secret: SECRET });
    await expect(withTenantScope(appPool(), t.tenantId, async (client) => {
      await outbox.queue(client, t.tenantId, t.memberId, { kind: "password_changed" });
      throw new LocalAccountError("concurrent_change");
    })).rejects.toBeInstanceOf(LocalAccountError);
    expect(await outboxOf(t.memberId)).toEqual([]);
  });

  test("each security change queues its notice", async () => {
    const t = await tenant();
    const { accounts, mfa, passkeys } = services();

    // A manager reset: the link goes to the member by email, not to the manager.
    const reset = await accounts.resetMemberPassword(t.tenantId, t.memberId, t.ownerId, META);
    expect(reset.link).toBeNull();
    expect(reset.email).toMatchObject({ to: t.memberEmail, purpose: "password_reset" });
    await accounts.redeemLink("password_reset", tokenOf(linkIn((await outboxOf(t.memberId))[0]!)), NEW_PASSWORD, META);

    // An authenticator app, added then removed.
    const now = Date.now();
    const started = await mfa.startTotpEnrollment(t.tenantId, t.memberId, await versionOf(t.memberId));
    await mfa.confirmTotpEnrollment(t.tenantId, t.memberId, totpCode(base32Decode(started.secret), totpStep(now)), await versionOf(t.memberId), META);
    await mfa.removeOwnTotp(t.tenantId, t.memberId, await versionOf(t.memberId), META);

    // A passkey, added then removed.
    const authenticator = new SoftAuthenticator(SITE);
    const options = await passkeys.registrationOptions(t.tenantId, t.memberId, await versionOf(t.memberId));
    await passkeys.register({
      tenantId: t.tenantId, userId: t.memberId, credential: authenticator.register(options), expectedChallenge: options.challenge,
      expectedVersion: await versionOf(t.memberId), name: undefined, meta: META
    });
    await passkeys.remove(t.tenantId, t.memberId, authenticator.id, await versionOf(t.memberId), META);

    // A manager reset of the second factors: a notice only when one was removed.
    await mfa.resetMemberFactors(t.tenantId, t.memberId, t.ownerId, META);
    const second = new SoftAuthenticator(SITE);
    const again = await passkeys.registrationOptions(t.tenantId, t.memberId, await versionOf(t.memberId));
    await passkeys.register({
      tenantId: t.tenantId, userId: t.memberId, credential: second.register(again), expectedChallenge: again.challenge,
      expectedVersion: await versionOf(t.memberId), name: undefined, meta: META
    });
    await mfa.resetMemberFactors(t.tenantId, t.memberId, t.ownerId, META);

    const rows = await outboxOf(t.memberId);
    expect(rows.map((row) => row.kind)).toEqual([
      "password_reset_link",
      "admin_password_reset",
      "password_changed",
      "factor_added",
      "factor_removed",
      "factor_added",
      "factor_removed",
      "factor_added",
      "admin_factors_reset"
    ]);
    expect(rows.map((row) => mailOf(row).subject)).toEqual([
      "Acme Mail: Your administrator reset your password",
      "Acme Mail: An administrator reset your password",
      "Acme Mail: Your password was changed",
      "Acme Mail: A two-step verification method was added",
      "Acme Mail: A two-step verification method was removed",
      "Acme Mail: A two-step verification method was added",
      "Acme Mail: A two-step verification method was removed",
      "Acme Mail: A two-step verification method was added",
      "Acme Mail: An administrator removed your two-step verification"
    ]);
    expect(mailOf(rows[0]!).text).toContain("You were signed out on all devices.");
    expect(mailOf(rows[1]!).text).not.toContain("#token=");
    expect(mailOf(rows[3]!).text).toContain("An authenticator app was added");
    expect(mailOf(rows[6]!).text).toContain("A passkey was removed");
    // The manager gets nothing.
    expect(await outboxOf(t.ownerId)).toEqual([]);
  });

  test("an account not set up yet gets setup emails, from creation and from a manager's new link", async () => {
    const t = await tenant();
    const { accounts } = services();
    const email = `${randomUUID()}@example.test`;
    const pending = await accounts.createMember({
      tenantId: t.tenantId, email, displayName: "Pat", role: "member", actorUserId: t.ownerId, meta: META
    });
    expect(pending.link).toBeNull();
    expect(pending.email).toMatchObject({ to: email, purpose: "account_setup" });
    // A new setup link right away would only flood the inbox.
    await expect(accounts.resetMemberPassword(t.tenantId, pending.userId, t.ownerId, META)).rejects.toMatchObject({ code: "link_sent_recently" });
    await superuserPool().query(`UPDATE email_outbox SET created_at = now() - interval '2 minutes' WHERE user_id = $1`, [pending.userId]);
    const again = await accounts.resetMemberPassword(t.tenantId, pending.userId, t.ownerId, META);
    expect(again).toMatchObject({ link: null, email: { to: email, purpose: "account_setup" } });

    const rows = await outboxOf(pending.userId);
    expect(rows.map((row) => row.kind)).toEqual(["account_setup_link", "account_setup_link"]);
    expect(mailOf(rows[1]!).subject).toBe("Acme Mail: Set up your account");
    expect(mailOf(rows[1]!).text).toContain(`made an account for you (${email})`);
    // Only the newer link works; the first email will not be sent.
    await expect(accounts.redeemLink("account_setup", tokenOf(linkIn(rows[0]!)), PASSWORD, META)).rejects.toMatchObject({ code: "link_invalid" });
    await accounts.redeemLink("account_setup", tokenOf(linkIn(rows[1]!)), PASSWORD, META);
  });

  test("the worker sends a message once and clears its text", async () => {
    const t = await tenant();
    const { accounts } = services();
    await accounts.changeOwnPassword(t.tenantId, t.memberId, PASSWORD, NEW_PASSWORD, await versionOf(t.memberId), META);
    const sender = new FakeSender();

    await worker(sender).tick();
    await worker(sender).tick();

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]).toMatchObject({ to: t.memberEmail, subject: "Acme Mail: Your password was changed" });
    const [row] = await outboxOf(t.memberId);
    expect(row).toMatchObject({ status: "sent", attempts: 1, message_encrypted: null, claim_token: null, last_error: null });
    expect(row!.sent_at).not.toBeNull();
  });

  test("a temporary failure retries later; a refused recipient fails at once; each keeps only a code", async () => {
    const t = await tenant();
    const { accounts } = services();
    await accounts.changeOwnPassword(t.tenantId, t.memberId, PASSWORD, NEW_PASSWORD, await versionOf(t.memberId), META);
    const sender = new FakeSender();
    sender.fail = () => Object.assign(new Error(`connect ECONNREFUSED for ${t.memberEmail}`), { code: "ECONNECTION" });

    await worker(sender).tick();
    let [row] = await outboxOf(t.memberId);
    expect(row).toMatchObject({ status: "queued", attempts: 1, last_error: "ECONNECTION", claim_token: null });
    expect(row!.message_encrypted).not.toBeNull();
    expect(row!.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 30_000);

    // Not due yet: the next pass leaves it.
    await worker(sender).tick();
    expect((await outboxOf(t.memberId))[0]!.attempts).toBe(1);

    // Due again; this time the server refuses the recipient for good.
    await superuserPool().query(`UPDATE email_outbox SET next_attempt_at = now() WHERE user_id = $1`, [t.memberId]);
    sender.fail = () => Object.assign(new Error(`550 5.1.1 <${t.memberEmail}> unknown`), { code: "EENVELOPE", responseCode: 550 });
    await worker(sender).tick();
    [row] = await outboxOf(t.memberId);
    expect(row).toMatchObject({ status: "failed", attempts: 2, last_error: "EENVELOPE 550", message_encrypted: null });

    // The last attempt fails a temporary error too.
    await accounts.resetMemberPassword(t.tenantId, t.memberId, t.ownerId, META);
    await superuserPool().query(`UPDATE email_outbox SET attempts = 9 WHERE user_id = $1 AND status = 'queued'`, [t.memberId]);
    sender.fail = () => Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    await worker(sender).tick();
    const last = (await outboxOf(t.memberId)).find((candidate) => candidate.kind === "password_reset_link");
    expect(last).toMatchObject({ status: "failed", attempts: 10, last_error: "ETIMEDOUT", message_encrypted: null });
    expect(sender.sent).toEqual([]);
  });

  test("a queued message past its expiry is not sent", async () => {
    const t = await tenant();
    const { accounts } = services();
    await accounts.changeOwnPassword(t.tenantId, t.memberId, PASSWORD, NEW_PASSWORD, await versionOf(t.memberId), META);
    await superuserPool().query(`UPDATE email_outbox SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [t.memberId]);
    const sender = new FakeSender();

    await worker(sender).tick();

    expect(sender.sent).toEqual([]);
    expect((await outboxOf(t.memberId))[0]).toMatchObject({ status: "expired", message_encrypted: null });
  });

  test("two workers at the same time send each message once", async () => {
    const t = await tenant();
    for (let i = 0; i < 15; i++) {
      await withTenantScope(appPool(), t.tenantId, (client) => new MailOutbox({ secret: SECRET }).queue(client, t.tenantId, t.memberId, { kind: "password_changed" }));
    }
    expect(await outboxOf(t.memberId)).toHaveLength(15);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const first = new FakeSender();
    const second = new FakeSender();
    first.gate = gate;
    second.gate = gate;

    const passes = Promise.all([worker(first).tick(), worker(second).tick()]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    open();
    await passes;
    // Batches of ten: one more pass sends what is left.
    await worker(first).tick();

    expect(first.sent.length + second.sent.length).toBe(15);
    const rows = await outboxOf(t.memberId);
    expect(rows.every((row) => row.status === "sent" && row.attempts === 1)).toBe(true);
    expect(second.sent.length).toBeGreaterThan(0);
  });

  test("a row another claimer holds is skipped, not waited for", async () => {
    const t = await tenant();
    const outbox = new MailOutbox({ secret: SECRET });
    for (let i = 0; i < 3; i++) {
      await withTenantScope(appPool(), t.tenantId, (client) => outbox.queue(client, t.tenantId, t.memberId, { kind: "password_changed" }));
    }
    const [held] = await outboxOf(t.memberId);
    const other = await superuserPool().connect();
    try {
      // Another process is in the middle of claiming this row.
      await other.query("BEGIN");
      await other.query(`SELECT 1 FROM email_outbox WHERE tenant_id = $1 AND email_id = $2 FOR UPDATE`, [t.tenantId, held!.email_id]);
      const sender = new FakeSender();
      const pass = worker(sender).tick().then(() => "done" as const);
      const outcome = await Promise.race([pass, new Promise((resolve) => setTimeout(() => resolve("blocked"), 3_000))]);
      expect(outcome).toBe("done");
      expect(sender.sent).toHaveLength(2);
    } finally {
      await other.query("ROLLBACK");
      other.release();
    }
    expect((await outboxOf(t.memberId)).map((row) => row.status)).toEqual(["queued", "sent", "sent"]);
  });

  test("the claim of a stopped process expires and is sent again; the old claimer cannot finish the row", async () => {
    const t = await tenant();
    const { accounts } = services();
    await accounts.changeOwnPassword(t.tenantId, t.memberId, PASSWORD, NEW_PASSWORD, await versionOf(t.memberId), META);
    let open!: () => void;
    const slow = new FakeSender();
    slow.gate = new Promise<void>((resolve) => { open = resolve; });

    // The first process claims the message and hangs in the send.
    const stuck = worker(slow).tick();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await outboxOf(t.memberId))[0]).toMatchObject({ status: "sending", attempts: 1 });

    // Its lease runs out. Another process takes the row back and fails to send.
    await superuserPool().query(`UPDATE email_outbox SET claimed_at = now() - interval '11 minutes' WHERE user_id = $1`, [t.memberId]);
    const other = new FakeSender();
    other.fail = () => Object.assign(new Error("down"), { code: "ECONNECTION" });
    await worker(other).tick();
    expect((await outboxOf(t.memberId))[0]).toMatchObject({ status: "queued", attempts: 2, last_error: "ECONNECTION" });

    // The first process wakes up: its claim is gone, so its "sent" changes nothing.
    open();
    await stuck;
    expect(slow.sent).toHaveLength(1);
    expect((await outboxOf(t.memberId))[0]).toMatchObject({ status: "queued", attempts: 2 });
  });

  test("finished rows are purged after 30 days; a message that cannot be decrypted fails", async () => {
    const t = await tenant();
    const { accounts } = services();
    await accounts.changeOwnPassword(t.tenantId, t.memberId, PASSWORD, NEW_PASSWORD, await versionOf(t.memberId), META);
    await withTenantScope(appPool(), t.tenantId, (client) => new MailOutbox({ secret: "another-secret-that-is-at-least-32-chars-long" })
      .queue(client, t.tenantId, t.memberId, { kind: "password_changed" }));
    const sender = new FakeSender();
    await worker(sender).tick();
    const rows = await outboxOf(t.memberId);
    expect(rows.map((row) => [row.status, row.last_error])).toEqual([["sent", null], ["failed", "DECRYPT_FAILED"]]);
    expect(sender.sent).toHaveLength(1);

    await superuserPool().query(`UPDATE email_outbox SET updated_at = now() - interval '31 days' WHERE email_id = $1`, [rows[0]!.email_id]);
    await worker(sender).tick();
    expect((await outboxOf(t.memberId)).map((row) => row.email_id)).toEqual([rows[1]!.email_id]);
  });

  test("a stored address with list syntax is not sent anywhere", async () => {
    const t = await tenant();
    // Written before the stricter parseEmail, or by hand: the sender refuses it.
    await superuserPool().query(`UPDATE users SET email = 'alice<attacker@example.test>' WHERE user_id = $1`, [t.memberId]);
    await withTenantScope(appPool(), t.tenantId, (client) => new MailOutbox({ secret: SECRET }).queue(client, t.tenantId, t.memberId, { kind: "password_changed" }));
    const transport = { sendMail: vi.fn(), close: () => {} };
    const sender = new SmtpMailSender(parseSmtpUrl("smtps://smtp.example.test", false), { name: null, address: "no-reply@example.test" }, transport as never);

    await worker(sender).tick();

    expect(transport.sendMail).not.toHaveBeenCalled();
    expect((await outboxOf(t.memberId))[0]).toMatchObject({ status: "failed", last_error: "BAD_ADDRESS", message_encrypted: null });
  });

  test("the purge deletes a backlog larger than one pass over the next passes", async () => {
    const t = await tenant();
    const insertFinished = (count: number) => superuserPool().query(
      `INSERT INTO email_outbox (tenant_id, email_id, user_id, kind, status, expires_at, created_at, updated_at)
       SELECT $1, gen_random_uuid()::text, $2, 'password_changed', 'sent', now(), now() - interval '40 days', now() - interval '31 days'
       FROM generate_series(1, $3::int)`,
      [t.tenantId, t.memberId, count]
    );
    const remaining = async () => Number((await superuserPool().query(`SELECT count(*) FROM email_outbox WHERE user_id = $1`, [t.memberId])).rows[0].count);
    await insertFinished(10_600);
    // A recent finished row stays.
    await insertFinished(1);
    await superuserPool().query(
      `UPDATE email_outbox SET updated_at = now() WHERE email_id = (SELECT email_id FROM email_outbox WHERE user_id = $1 LIMIT 1)`,
      [t.memberId]
    );
    const purger = worker(new FakeSender());

    await purger.tick();
    expect(await remaining()).toBe(601);
    await purger.tick();
    expect(await remaining()).toBe(1);
  });

  test("with email off, the worker still expires and purges, and sends nothing", async () => {
    const t = await tenant();
    const outbox = new MailOutbox({ secret: SECRET });
    for (let i = 0; i < 3; i++) {
      await withTenantScope(appPool(), t.tenantId, (client) => outbox.queue(client, t.tenantId, t.memberId, { kind: "password_changed" }));
    }
    const [late, old, waiting] = await outboxOf(t.memberId);
    await superuserPool().query(`UPDATE email_outbox SET expires_at = now() - interval '1 second' WHERE email_id = $1`, [late!.email_id]);
    await superuserPool().query(
      `UPDATE email_outbox SET status = 'sent', message_encrypted = NULL, updated_at = now() - interval '31 days' WHERE email_id = $1`,
      [old!.email_id]
    );

    await new MailOutboxWorker({ db: maintenancePool(), sender: null, secret: SECRET, logger: quietLogger }).tick();

    const rows = await outboxOf(t.memberId);
    expect(rows.map((row) => [row.email_id, row.status, row.message_encrypted === null, row.attempts])).toEqual([
      [late!.email_id, "expired", true, 0],
      [waiting!.email_id, "queued", false, 0]
    ]);
  });

  test("stop() ends a pass between messages; the unsent claims go back to the queue", async () => {
    const t = await tenant();
    const outbox = new MailOutbox({ secret: SECRET });
    for (let i = 0; i < 3; i++) {
      await withTenantScope(appPool(), t.tenantId, (client) => outbox.queue(client, t.tenantId, t.memberId, { kind: "password_changed" }));
    }
    let open!: () => void;
    const sender = new FakeSender();
    sender.gate = new Promise<void>((resolve) => { open = resolve; });
    const shuttingDown = worker(sender);

    const pass = shuttingDown.tick();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await outboxOf(t.memberId)).every((row) => row.status === "sending")).toBe(true);
    shuttingDown.stop();
    expect(await shuttingDown.drain(50)).toBe(false);
    open();
    await pass;

    expect(sender.sent).toHaveLength(1);
    const rows = await outboxOf(t.memberId);
    expect(rows.map((row) => row.status).sort()).toEqual(["queued", "queued", "sent"]);
    expect(rows.filter((row) => row.status === "queued").every((row) => row.attempts === 0 && row.claim_token === null)).toBe(true);
    // A stopped worker starts no new pass.
    await shuttingDown.tick();
    expect(sender.sent).toHaveLength(1);
  });

  test("RLS: app_user sees and writes only its tenant's messages", async () => {
    const a = await tenant("Tenant A");
    const b = await tenant("Tenant B");
    const { accounts } = services();
    await accounts.changeOwnPassword(a.tenantId, a.memberId, PASSWORD, NEW_PASSWORD, await versionOf(a.memberId), META);

    const seenFromB = await withTenantScope(appPool(), b.tenantId, async (client) =>
      (await client.query(`SELECT 1 FROM email_outbox WHERE user_id = $1`, [a.memberId])).rowCount);
    expect(seenFromB).toBe(0);
    await expect(withTenantScope(appPool(), b.tenantId, (client) => client.query(
      `INSERT INTO email_outbox (tenant_id, email_id, user_id, kind, message_encrypted, expires_at)
       VALUES ($1, $2, $3, 'password_changed', 'x', now() + interval '1 hour')`,
      [a.tenantId, randomUUID(), a.memberId]
    ))).rejects.toMatchObject({ code: "42501" });
  });

  test("grants: the maintenance role reads, updates, and deletes messages, and cannot write new ones", async () => {
    const t = await tenant();
    const client = await maintenancePool().connect();
    try {
      await client.query("BEGIN");
      await expect(client.query(
        `INSERT INTO email_outbox (tenant_id, email_id, user_id, kind, message_encrypted, expires_at)
         VALUES ($1, $2, $3, 'password_changed', 'x', now() + interval '1 hour')`,
        [t.tenantId, randomUUID(), t.memberId]
      )).rejects.toMatchObject({ code: "42501" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    const privileges = (await maintenancePool().query(`
      SELECT has_table_privilege(current_user, 'public.email_outbox', 'SELECT') AS s,
             has_table_privilege(current_user, 'public.email_outbox', 'UPDATE') AS u,
             has_table_privilege(current_user, 'public.email_outbox', 'DELETE') AS d
    `)).rows[0];
    expect(privileges).toEqual({ s: true, u: true, d: true });
  });
});

/** A WorkOS tenant with one owner and `count` queued owner notices that became due `minutesAgo` minutes ago. */
async function noticeBacklog(count: number, minutesAgo: number): Promise<string> {
  const tenantId = `backlog-${randomUUID()}`;
  const ownerId = `owner-${randomUUID()}`;
  const db = superuserPool();
  await db.query(`INSERT INTO tenants (tenant_id, tenant_name, slug) VALUES ($1, 'Backlog', $1)`, [tenantId]);
  await db.query(`INSERT INTO users (user_id, email, auth_source) VALUES ($1, $2, 'workos')`, [ownerId, `${randomUUID()}@example.test`]);
  await db.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`, [tenantId, ownerId]);
  for (let i = 0; i < count; i += 1) {
    const mail = { to: `${ownerId}@example.test`, subject: `notice ${tenantId} ${i}`, text: "x", html: "<p>x</p>" };
    await db.query(
      `INSERT INTO email_outbox (tenant_id, email_id, user_id, kind, message_encrypted, expires_at, next_attempt_at, created_at)
       VALUES ($1, $2, $3, 'tenant_setting_changed', $4, now() + interval '1 day', now() - ($5::int * interval '1 minute'),
               now() - ($5::int * interval '1 minute'))`,
      [tenantId, randomUUID(), ownerId, encryptMail(mail, SECRET), minutesAgo]
    );
  }
  return tenantId;
}

// One tenant's notices (for example after all its members became owners)
// must not keep other tenants' email waiting: a reset link expires in 30
// minutes.
describe.skipIf(!adminDatabaseUrl())("email outbox: order of sending", () => {
  beforeEach(async () => {
    await superuserPool().query(`DELETE FROM email_outbox`);
  });
  afterEach(async () => {
    await superuserPool().query(`DELETE FROM email_outbox`);
  });

  test("a backlog of notices does not delay a reset link: link emails go first", async () => {
    // More tenants with older notices than one pass sends: taking turns
    // alone would send their first notices before the newer link.
    for (let i = 0; i < 12; i += 1) await noticeBacklog(3, 30);
    const t = await tenant();
    const { accounts } = services();
    await accounts.resetMemberPassword(t.tenantId, t.memberId, t.ownerId, META);

    const sender = new FakeSender();
    await worker(sender).tick();

    // One pass sends 10 messages: the reset link is one of them, before older notices.
    expect(sender.sent).toHaveLength(10);
    expect(sender.sent.filter((mail) => /#token=/.test(mail.text)).map((mail) => mail.to)).toEqual([t.memberEmail]);
  });

  test("tenants take turns: one tenant's backlog does not hold the notices of another", async () => {
    const busy = await noticeBacklog(30, 30);
    const quiet = await noticeBacklog(2, 1);

    const sender = new FakeSender();
    await worker(sender).tick();

    expect(sender.sent).toHaveLength(10);
    expect(sender.sent.filter((mail) => mail.subject.includes(quiet))).toHaveLength(2);
    expect(sender.sent.filter((mail) => mail.subject.includes(busy))).toHaveLength(8);
  });
});

describe.skipIf(!adminDatabaseUrl())("forgot password (feature 4b)", () => {
  beforeEach(async () => {
    await superuserPool().query(`DELETE FROM email_outbox`);
  });

  async function openLinks(userId: string) {
    return (await superuserPool().query<{ token_hash: string; created_by: string | null; security_version: number; expires_at: Date; created_at: Date }>(
      `SELECT token_hash, created_by, security_version, expires_at, created_at FROM auth_action_tokens
       WHERE user_id = $1 AND purpose = 'password_reset' AND used_at IS NULL`,
      [userId]
    )).rows;
  }

  test("an active account gets a 30-minute link by email; no session ends; an older reset link ends", async () => {
    const t = await tenant();
    const { accounts } = services();
    await accounts.resetMemberPassword(t.tenantId, t.memberId, t.ownerId, META);
    const managerLink = linkIn((await outboxOf(t.memberId))[0]!);
    await superuserPool().query(`DELETE FROM email_outbox`);
    const version = await versionOf(t.memberId);

    expect(await accounts.requestPasswordReset(`  ${t.memberEmail.toUpperCase()} `, META)).toBe("sent");

    expect(await versionOf(t.memberId)).toBe(version);
    const links = await openLinks(t.memberId);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ created_by: null, security_version: version });
    const ttl = links[0]!.expires_at.getTime() - links[0]!.created_at.getTime();
    expect(ttl).toBeGreaterThan(29 * 60_000);
    expect(ttl).toBeLessThanOrEqual(30 * 60_000 + 1_000);

    const [row] = await outboxOf(t.memberId);
    expect(row).toMatchObject({ kind: "password_reset_link", status: "queued" });
    const expiry = (await superuserPool().query(`SELECT expires_at FROM email_outbox WHERE email_id = $1`, [row!.email_id])).rows[0].expires_at as Date;
    expect(Math.abs(expiry.getTime() - links[0]!.expires_at.getTime())).toBeLessThan(1_000);
    // The raw token is only in the encrypted message.
    expect(row!.message_encrypted).not.toContain("#token=");
    const mail = mailOf(row!);
    expect(mail.to).toBe(t.memberEmail);
    expect(mail.subject).toBe("Acme Mail: Reset your password");
    const url = /https:\/\/\S+#token=[A-Za-z0-9_-]{43}/.exec(mail.text)![0];
    expect(url.startsWith(`${SITE.origin}/auth/reset-password#token=`)).toBe(true);
    expect(mail.html).toContain(`href="${url}"`);
    const audit = await superuserPool().query(`SELECT 1 FROM audit_events WHERE user_id = $1 AND event_type = 'auth.password_reset_requested'`, [t.memberId]);
    expect(audit.rowCount).toBe(1);

    // The manager's older link no longer works; the emailed one does, once.
    await expect(accounts.redeemLink("password_reset", tokenOf(managerLink), NEW_PASSWORD, META)).rejects.toMatchObject({ code: "link_invalid" });
    await accounts.redeemLink("password_reset", tokenOf(url), NEW_PASSWORD, META);
    await expect(accounts.redeemLink("password_reset", tokenOf(url), PASSWORD, META)).rejects.toMatchObject({ code: "link_invalid" });
    expect((await outboxOf(t.memberId)).map((r) => r.kind)).toEqual(["password_reset_link", "password_changed"]);
  });

  test("one email per account per 5 minutes; the next one replaces the link", async () => {
    const t = await tenant();
    const { accounts } = services();
    expect(await accounts.requestPasswordReset(t.memberEmail, META)).toBe("sent");
    const first = await openLinks(t.memberId);
    expect(await accounts.requestPasswordReset(t.memberEmail, META)).toBe("cooldown");
    expect(await openLinks(t.memberId)).toEqual(first);
    expect(await outboxOf(t.memberId)).toHaveLength(1);

    await superuserPool().query(`UPDATE email_outbox SET created_at = now() - interval '6 minutes' WHERE user_id = $1`, [t.memberId]);
    expect(await accounts.requestPasswordReset(t.memberEmail, META)).toBe("sent");
    const second = await openLinks(t.memberId);
    expect(second).toHaveLength(1);
    expect(second[0]!.token_hash).not.toBe(first[0]!.token_hash);
    expect(await outboxOf(t.memberId)).toHaveLength(2);
  });

  test("an email whose link was replaced, used, or ended by a security change is not sent", async () => {
    const t = await tenant();
    const { accounts } = services();
    expect(await accounts.requestPasswordReset(t.memberEmail, META)).toBe("sent");
    // The relay is down: the first email waits for a retry.
    const down = new FakeSender();
    down.fail = () => Object.assign(new Error("down"), { code: "ECONNECTION" });
    await worker(down).tick();
    expect((await outboxOf(t.memberId))[0]).toMatchObject({ status: "queued", attempts: 1 });

    // A second request after the cooldown replaces the link.
    await superuserPool().query(`UPDATE email_outbox SET created_at = now() - interval '6 minutes' WHERE user_id = $1`, [t.memberId]);
    expect(await accounts.requestPasswordReset(t.memberEmail, META)).toBe("sent");
    await superuserPool().query(`UPDATE email_outbox SET next_attempt_at = now() WHERE user_id = $1`, [t.memberId]);

    const up = new FakeSender();
    await worker(up).tick();
    // Only the email with the working link went out; the old one expired unsent.
    expect(up.sent).toHaveLength(1);
    const working = (await openLinks(t.memberId))[0]!;
    expect(up.sent[0]!.text).toContain("#token=");
    const rows = await outboxOf(t.memberId);
    expect(rows.map((row) => [row.status, row.message_encrypted === null])).toEqual([["expired", true], ["sent", true]]);
    expect(working).toBeDefined();

    // A security change (sign out everywhere) ends the version of a waiting link email too.
    await superuserPool().query(`UPDATE email_outbox SET created_at = now() - interval '6 minutes' WHERE user_id = $1`, [t.memberId]);
    expect(await accounts.requestPasswordReset(t.memberEmail, META)).toBe("sent");
    await accounts.revokeSessions(t.tenantId, t.memberId, t.memberId, META);
    await worker(up).tick();
    expect(up.sent).toHaveLength(1);
    expect((await outboxOf(t.memberId)).at(-1)).toMatchObject({ status: "expired", message_encrypted: null });
  });

  test("a link that ends while an earlier send of the batch is slow is not sent", async () => {
    const a = await tenant();
    const b = await tenant();
    const { accounts } = services();
    expect(await accounts.requestPasswordReset(a.memberEmail, META)).toBe("sent");
    expect(await accounts.requestPasswordReset(b.memberEmail, META)).toBe("sent");
    // A's email is first in the batch.
    await superuserPool().query(`UPDATE email_outbox SET next_attempt_at = now() - interval '1 minute' WHERE user_id = $1`, [a.memberId]);
    let open!: () => void;
    const slow = new FakeSender();
    slow.gate = new Promise<void>((resolve) => { open = resolve; });

    const pass = worker(slow).tick();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await outboxOf(b.memberId))[0]).toMatchObject({ status: "sending" });
    // While A's send hangs, B signs out everywhere: B's emailed link ends.
    await accounts.revokeSessions(b.tenantId, b.memberId, b.memberId, META);
    open();
    await pass;

    expect(slow.sent.map((mail) => mail.to)).toEqual([a.memberEmail]);
    expect((await outboxOf(b.memberId))[0]).toMatchObject({ status: "expired", message_encrypted: null, claim_token: null });
  });

  test("the cooldown starts when the email is queued, not when the request began waiting", async () => {
    const t = await tenant();
    const { accounts } = services();
    const holder = await superuserPool().connect();
    let released: Date;
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT 1 FROM local_identities WHERE user_id = $1 FOR UPDATE`, [t.memberId]);
      const request = accounts.requestPasswordReset(t.memberEmail, META);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      released = (await holder.query<{ now: Date }>(`SELECT clock_timestamp() AS now`)).rows[0]!.now;
      await holder.query("COMMIT");
      expect(await request).toBe("sent");
    } finally {
      holder.release();
    }
    const created = (await superuserPool().query<{ created_at: Date }>(`SELECT created_at FROM email_outbox WHERE user_id = $1`, [t.memberId])).rows[0]!.created_at;
    expect(created.getTime()).toBeGreaterThanOrEqual(released.getTime());
  });

  test("concurrent requests for one account send one email", async () => {
    const t = await tenant();
    const { accounts } = services();
    // Hold the account's row so that the requests surely overlap: each must
    // wait for the identity lock before its cooldown check.
    const holder = await superuserPool().connect();
    let outcomes: string[];
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT 1 FROM local_identities WHERE user_id = $1 FOR UPDATE`, [t.memberId]);
      const requests = Promise.all(Array.from({ length: 3 }, () => accounts.requestPasswordReset(t.memberEmail, META)));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await holder.query("COMMIT");
      outcomes = await requests;
    } finally {
      holder.release();
    }
    expect(outcomes.filter((outcome) => outcome === "sent")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "cooldown")).toHaveLength(2);
    expect(await outboxOf(t.memberId)).toHaveLength(1);
    expect(await openLinks(t.memberId)).toHaveLength(1);
  });

  test("no email for an unknown address, list syntax, an account not active, or a WorkOS user", async () => {
    const t = await tenant();
    const { accounts } = services();
    const pending = await accounts.createMember({
      tenantId: t.tenantId, email: `${randomUUID()}@example.test`, displayName: null, role: "member", actorUserId: t.ownerId, meta: META
    });
    const pendingEmail = (await superuserPool().query(`SELECT email FROM users WHERE user_id = $1`, [pending.userId])).rows[0].email as string;
    expect(await accounts.requestPasswordReset(pendingEmail, META)).toBe("not_active");
    expect(await accounts.requestPasswordReset(`${randomUUID()}@example.test`, META)).toBe("no_account");
    expect(await accounts.requestPasswordReset(`x<${t.memberEmail}>`, META)).toBe("no_account");
    expect(await accounts.requestPasswordReset("not an address", META)).toBe("no_account");

    await accounts.disableMember(t.tenantId, t.memberId, t.ownerId, META);
    expect(await accounts.requestPasswordReset(t.memberEmail, META)).toBe("not_active");

    const workosEmail = `${randomUUID()}@example.test`;
    await superuserPool().query(`INSERT INTO users (user_id, email, display_name, auth_source) VALUES ($1, $2, null, 'workos')`, [randomUUID(), workosEmail]);
    expect(await accounts.requestPasswordReset(workosEmail, META)).toBe("no_account");

    const rows = await superuserPool().query(`SELECT kind FROM email_outbox WHERE kind = 'password_reset_link'`);
    expect(rows.rowCount).toBe(0);
    expect(await openLinks(t.memberId)).toEqual([]);
  });

  test("without email nothing is issued", async () => {
    const t = await tenant();
    const accounts = new LocalAccountService({ afterSecurityChange: IGNORE_SECURITY_CHANGE, db: appPool(), lookupDb: maintenancePool(), hasher: new PasswordHasher(4), frontendOrigin: SITE.origin });
    expect(await accounts.requestPasswordReset(t.memberEmail, META)).toBe("mail_off");
    expect(await openLinks(t.memberId)).toEqual([]);
  });
});

describe.skipIf(!adminDatabaseUrl())("manager links by email (feature 4c)", () => {
  beforeEach(async () => {
    await superuserPool().query(`DELETE FROM email_outbox`);
  });

  const linkEmailOf = async (tenantId: string, userId: string) =>
    (await new TenantMemberStore(appPool()).listTenantMembers(tenantId)).find((member) => member.userId === userId)?.linkEmail;

  test("resend for an account not set up yet: a new setup email; the older link ends; nothing else changes", async () => {
    const t = await tenant();
    const { accounts } = services();
    const email = `${randomUUID()}@example.test`;
    const pending = await accounts.createMember({ tenantId: t.tenantId, email, displayName: null, role: "member", actorUserId: t.ownerId, meta: META });
    await superuserPool().query(`UPDATE email_outbox SET created_at = now() - interval '2 minutes' WHERE user_id = $1`, [pending.userId]);
    const version = await versionOf(pending.userId);

    expect(await accounts.resendMemberLink(t.tenantId, pending.userId, t.ownerId, META)).toMatchObject({ to: email, purpose: "account_setup" });

    expect(await versionOf(pending.userId)).toBe(version);
    const rows = await outboxOf(pending.userId);
    expect(rows.map((row) => row.kind)).toEqual(["account_setup_link", "account_setup_link"]);
    await expect(accounts.redeemLink("account_setup", tokenOf(linkIn(rows[0]!)), PASSWORD, META)).rejects.toMatchObject({ code: "link_invalid" });
    // One resend per minute per account.
    await expect(accounts.resendMemberLink(t.tenantId, pending.userId, t.ownerId, META)).rejects.toMatchObject({ code: "link_sent_recently" });
    await accounts.redeemLink("account_setup", tokenOf(linkIn(rows[1]!)), PASSWORD, META);
    const audit = await superuserPool().query(`SELECT payload FROM audit_events WHERE event_type = 'tenant.member.link_resent' AND tenant_id = $1`, [t.tenantId]);
    expect(audit.rows).toEqual([{ payload: { targetUserId: pending.userId, linkPurpose: "account_setup" } }]);
  });

  test("resend for an active account: a reset link email; no session ends", async () => {
    const t = await tenant();
    const { accounts } = services();
    const version = await versionOf(t.memberId);
    expect(await accounts.resendMemberLink(t.tenantId, t.memberId, t.ownerId, META)).toMatchObject({ to: t.memberEmail, purpose: "password_reset" });
    expect(await versionOf(t.memberId)).toBe(version);
    const [row] = await outboxOf(t.memberId);
    expect(row!.kind).toBe("password_reset_link");
    expect(mailOf(row!).subject).toBe("Acme Mail: A link to choose a new password");
    await accounts.redeemLink("password_reset", tokenOf(linkIn(row!)), NEW_PASSWORD, META);
  });

  test("resend is refused for a disabled account, an owner (for an admin), and without email", async () => {
    const t = await tenant();
    const { accounts } = services();
    await expect(accounts.resendMemberLink(t.tenantId, t.ownerId, t.memberId, META)).rejects.toMatchObject({ code: "not_a_manager" });
    await accounts.disableMember(t.tenantId, t.memberId, t.ownerId, META);
    await expect(accounts.resendMemberLink(t.tenantId, t.memberId, t.ownerId, META)).rejects.toMatchObject({ code: "account_state_conflict" });
    await expect(plainAccounts().resendMemberLink(t.tenantId, t.memberId, t.ownerId, META)).rejects.toMatchObject({ code: "email_off" });
    expect(await outboxOf(t.memberId)).toEqual([]);
  });

  test("a resend after a manager reset keeps the reset warning", async () => {
    const t = await tenant();
    const { accounts } = services();
    // The relay is down when the manager resets the password.
    await accounts.resetMemberPassword(t.tenantId, t.memberId, t.ownerId, META);
    const down = new FakeSender();
    down.fail = () => Object.assign(new Error("down"), { code: "ECONNECTION" });
    await worker(down).tick();
    // A minute later the manager sends the link again; the relay is back.
    await superuserPool().query(`UPDATE email_outbox SET created_at = now() - interval '2 minutes', next_attempt_at = now() WHERE user_id = $1`, [t.memberId]);
    await accounts.resendMemberLink(t.tenantId, t.memberId, t.ownerId, META);
    const up = new FakeSender();
    await worker(up).tick();

    expect(up.sent.map((mail) => mail.subject).sort()).toEqual([
      "Acme Mail: A link to choose a new password",
      "Acme Mail: An administrator reset your password"
    ]);
    expect((await outboxOf(t.memberId)).find((row) => row.status === "expired")?.kind).toBe("password_reset_link");
  });

  test("with email on, an account without an address gets no link, and nothing changes", async () => {
    const t = await tenant();
    const { accounts } = services();
    await superuserPool().query(`UPDATE users SET email = NULL WHERE user_id = $1`, [t.memberId]);
    const version = await versionOf(t.memberId);
    await expect(accounts.resetMemberPassword(t.tenantId, t.memberId, t.ownerId, META)).rejects.toMatchObject({ code: "no_email_address" });
    await expect(accounts.resendMemberLink(t.tenantId, t.memberId, t.ownerId, META)).rejects.toMatchObject({ code: "no_email_address" });
    expect(await versionOf(t.memberId)).toBe(version);
    const tokens = await superuserPool().query(`SELECT 1 FROM auth_action_tokens WHERE user_id = $1 AND used_at IS NULL`, [t.memberId]);
    expect(tokens.rowCount).toBe(0);
    expect(await outboxOf(t.memberId)).toEqual([]);
  });

  test("the members list shows the latest link email: queued, then sent or failed with its code", async () => {
    const t = await tenant();
    const { accounts } = services();
    expect(await linkEmailOf(t.tenantId, t.memberId)).toBeNull();
    const pending = await accounts.createMember({
      tenantId: t.tenantId, email: `${randomUUID()}@example.test`, displayName: null, role: "member", actorUserId: t.ownerId, meta: META
    });
    expect(await linkEmailOf(t.tenantId, pending.userId)).toMatchObject({ purpose: "account_setup", status: "queued", error: null });

    await worker(new FakeSender()).tick();
    expect(await linkEmailOf(t.tenantId, pending.userId)).toMatchObject({ purpose: "account_setup", status: "sent", error: null });

    await accounts.resetMemberPassword(t.tenantId, t.memberId, t.ownerId, META);
    const refusing = new FakeSender();
    refusing.fail = () => Object.assign(new Error("550 no such user"), { code: "EENVELOPE", responseCode: 550 });
    await worker(refusing).tick();
    expect(await linkEmailOf(t.tenantId, t.memberId)).toMatchObject({ purpose: "password_reset", status: "failed", error: "EENVELOPE 550" });
    // Security notices are not link emails.
    const owner = (await new TenantMemberStore(appPool()).listTenantMembers(t.tenantId)).find((member) => member.userId === t.ownerId);
    expect(owner?.linkEmail).toBeNull();
  });
});

// Live SMTP: a real send through nodemailer to a local Mailpit
// (`docker compose --profile mail up -d mailpit`). Runs only when
// INTEGRATION_MAILPIT_URL (the web API, http://127.0.0.1:8025) is set; the
// SMTP side is INTEGRATION_SMTP_URL (default smtp://127.0.0.1:1025).
const mailpit = process.env.INTEGRATION_MAILPIT_URL;
const smtpUrl = process.env.INTEGRATION_SMTP_URL ?? "smtp://127.0.0.1:1025";

type MailpitMessage = { ID: string; Subject: string; From: { Address: string; Name: string }; To: { Address: string }[] };

async function mailpitSearch(address: string): Promise<MailpitMessage[]> {
  const response = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`);
  return ((await response.json()) as { messages: MailpitMessage[] }).messages;
}

describe.skipIf(!adminDatabaseUrl() || !mailpit)("email outbox: live SMTP to Mailpit", () => {
  beforeEach(async () => {
    await superuserPool().query(`DELETE FROM email_outbox`);
  });

  test("a notice goes from the outbox through SMTP to the mailbox", async () => {
    const t = await tenant("Acme Live");
    const { accounts } = services();
    await accounts.changeOwnPassword(t.tenantId, t.memberId, PASSWORD, NEW_PASSWORD, await versionOf(t.memberId), META);
    const sender = new SmtpMailSender(parseSmtpUrl(smtpUrl, true), { name: "Cogniplane Test", address: "no-reply@example.test" });
    try {
      await worker(sender).tick();
    } finally {
      sender.close();
    }
    expect((await outboxOf(t.memberId))[0]).toMatchObject({ status: "sent", message_encrypted: null });

    const [message] = await mailpitSearch(t.memberEmail);
    expect(message).toMatchObject({
      Subject: "Acme Live: Your password was changed",
      From: { Address: "no-reply@example.test", Name: "Cogniplane Test" },
      To: [{ Address: t.memberEmail }]
    });
    const full = (await (await fetch(`${mailpit}/api/v1/message/${message!.ID}`)).json()) as { Text: string; HTML: string };
    expect(full.Text).toContain("Hello Max Member,");
    expect(full.HTML).toContain("<p>Hello Max Member,</p>");
    const headers = (await (await fetch(`${mailpit}/api/v1/message/${message!.ID}/headers`)).json()) as Record<string, string[]>;
    expect(headers["Auto-Submitted"]).toEqual(["auto-generated"]);
  });

  test("a reset link email arrives with a working link", async () => {
    const t = await tenant("Acme Live");
    const { accounts } = services();
    expect(await accounts.requestPasswordReset(t.memberEmail, META)).toBe("sent");
    const sender = new SmtpMailSender(parseSmtpUrl(smtpUrl, true), { name: "Cogniplane Test", address: "no-reply@example.test" });
    try {
      await worker(sender).tick();
    } finally {
      sender.close();
    }
    const [message] = await mailpitSearch(t.memberEmail);
    expect(message!.Subject).toBe("Acme Live: Reset your password");
    const full = (await (await fetch(`${mailpit}/api/v1/message/${message!.ID}`)).json()) as { Text: string };
    const url = /https:\/\/\S+#token=[A-Za-z0-9_-]{43}/.exec(full.Text)![0];
    await accounts.redeemLink("password_reset", tokenOf(url), NEW_PASSWORD, META);
    await expect(accounts.signInWithPassword(t.memberEmail, NEW_PASSWORD, META)).resolves.toMatchObject({ userId: t.memberId });
  });

  test("without the development opt-in, a server that offers no STARTTLS gets nothing", async () => {
    const address = `${randomUUID()}@example.test`;
    const sender = new SmtpMailSender(parseSmtpUrl(smtpUrl, false), { name: null, address: "no-reply@example.test" });
    let failure: unknown;
    try {
      await sender.send({ to: address, subject: "must not arrive", text: "x", html: "<p>x</p>" });
    } catch (error) {
      failure = error;
    } finally {
      sender.close();
    }
    expect(failure).toBeDefined();
    expect(classifySendError(failure).permanent).toBe(false);
    expect(await mailpitSearch(address)).toEqual([]);
  });
});
