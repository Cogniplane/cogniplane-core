import { createHash, randomBytes } from "node:crypto";

import type { PoolClient } from "pg";

import { parseEmail } from "../../lib/email-address.js";
import { type Pool, withTenantScope } from "../../lib/db.js";
import type { PasswordHasher } from "../../lib/password-hash.js";
import { checkPasswordPolicy, normalizePassword, type PasswordPolicyError } from "../../lib/password-policy.js";
import { uuidv7 } from "../../lib/uuid.js";
import { AuditEventStore } from "../audit-event-store.js";
import type { LinkEmailVariant } from "../mail/link-emails.js";
import type { AccountMailQueue } from "../mail/mail-outbox.js";
import type { AuditEventType } from "../audit-event-types.js";
import {
  actorIdOf,
  currentRole,
  lockTenantMembership,
  type ManagerActor,
  managerMayAct,
  type ManagerRightsError,
  mayAssignRole,
  ownerRoleRefusal
} from "../member-authority.js";
import type { LocalAccountStatus, TenantMembershipRole } from "../tenant-member-store.js";
import { type AfterSecurityChange, type SecurityChange, withSecurityChange } from "./security-change.js";

export { managerMayAct };

// Local accounts: sign-in, one-time links, password change, and the manager
// actions. See docs/ARCHITECTURE.md, "Authentication".
//
// Pools. `lookupDb` is the maintenance pool and is used only for the two
// reads that run before the tenant is known: account by email, link by token
// hash. Every other read and every write uses `db`, the app_user
// pool, inside withTenantScope, so RLS applies.
//
// Serialisation rule. Every change of an account's credentials or
// status runs in one transaction that first locks the local_identities row,
// then the link row, then the password row; rechecks status and version under
// that lock; and increments security_version with a conditional update. So two
// links for one account cannot both succeed, and a reset cannot write after a
// concurrent disable. Argon2 runs before the transaction, never under a lock.
// A transaction that increments the version runs in withSecurityChange, which
// stops the account's active work after the commit (security-change.ts).

export const ACCOUNT_SETUP_TTL_MS = 72 * 60 * 60_000;
export const MANAGER_RESET_TTL_MS = 24 * 60 * 60_000;
// The status of an account that a manager creates. The owner rule reads it,
// so the rule and the insert cannot disagree.
const NEW_ACCOUNT_STATUS: LocalAccountStatus = "pending_setup";
/** A reset link that the person asked for on the sign-in page. */
export const SELF_RESET_TTL_MS = 30 * 60_000;
/** At most one self-service reset email per account in this time. */
export const SELF_RESET_COOLDOWN_MS = 5 * 60_000;
/**
 * A manager's link email (a resend, or a new setup link) waits this long after
 * any link email to the account, so it cannot flood the inbox.
 */
export const MANAGER_LINK_COOLDOWN_MS = 60_000;

/** What a forgot-password request did. Only tests and logs see it; the caller answers the same in every case. */
export type PasswordResetRequestOutcome = "sent" | "no_account" | "not_active" | "cooldown" | "no_address" | "mail_off";
// Bounds the work of one hash on attacker input. The policy limit for a new
// password (PASSWORD_MAX_LENGTH) is far lower.
export const MAX_PASSWORD_INPUT_LENGTH = 1024;

export type ActionPurpose = "account_setup" | "password_reset";

export type RequestMeta = { ipAddress: string | null; userAgent: string | null };

export type LocalAccountErrorCode =
  | "invalid_credentials"
  | "link_invalid"
  | "email_invalid"
  | "email_in_use"
  | "wrong_login_type"
  | "member_not_found"
  | "account_state_conflict"
  | "account_not_active"
  | "concurrent_change"
  | ManagerRightsError
  | "only_owner_can_assign_admin"
  | "only_owner_can_assign_owner"
  | "invalid_code"
  | "session_changed"
  | "enrollment_not_started"
  | "mfa_required"
  | "no_second_factor"
  | "only_owner_can_weaken_policy"
  | "policy_changed"
  | "passkey_not_accepted"
  | "passkey_exists"
  | "passkey_limit"
  | "passkey_not_found"
  | "email_off"
  | "link_sent_recently"
  | "no_email_address"
  | PasswordPolicyError;

export type { ManagerRightsError };

const STATUS_BY_CODE: Record<LocalAccountErrorCode, number> = {
  invalid_credentials: 401,
  link_invalid: 400,
  email_invalid: 400,
  email_in_use: 409,
  wrong_login_type: 409,
  member_not_found: 404,
  account_state_conflict: 409,
  account_not_active: 409,
  concurrent_change: 409,
  invalid_code: 401,
  session_changed: 401,
  enrollment_not_started: 409,
  mfa_required: 409,
  no_second_factor: 409,
  only_owner_can_weaken_policy: 403,
  policy_changed: 409,
  passkey_not_accepted: 401,
  passkey_exists: 409,
  passkey_limit: 409,
  passkey_not_found: 404,
  email_off: 409,
  link_sent_recently: 429,
  no_email_address: 409,
  only_owner_can_assign_admin: 403,
  only_owner_can_assign_owner: 403,
  cannot_manage_self: 400,
  cannot_manage_owner: 403,
  only_owner_can_manage_admin: 403,
  not_a_manager: 403,
  password_too_short: 400,
  password_too_long: 400,
  password_too_common: 400,
  password_contains_email: 400
};

export class LocalAccountError extends Error {
  readonly status: number;

  constructor(readonly code: LocalAccountErrorCode) {
    super(code);
    this.name = "LocalAccountError";
    this.status = STATUS_BY_CODE[code];
  }
}

/** What a session needs about a local account. */
export type LocalSessionIdentity = {
  tenantId: string;
  userId: string;
  role: TenantMembershipRole;
  email: string;
  displayName: string | null;
  securityVersion: number;
};

export type IssuedLink = { url: string; expiresAt: string; purpose: ActionPurpose };

/** A link that went to the person by email; the manager sees only this. */
export type EmailedLink = { to: string; expiresAt: string; purpose: ActionPurpose };

/** Exactly one is set: the link went by email, or (email off) it is for the caller to pass on. */
export type LinkDelivery = { link: IssuedLink; email: null } | { link: null; email: EmailedLink };

export type CreateMemberInput = {
  tenantId: string;
  email: string;
  displayName: string | null;
  role: TenantMembershipRole;
  /** The manager; null for an operator command. */
  actorUserId: string | null;
  /** The security version of the manager's session (local sessions). */
  actorVersion?: number;
  meta: RequestMeta;
};

export type LockedIdentity = {
  status: LocalAccountStatus;
  security_version: number;
  role: TenantMembershipRole | null;
  email: string | null;
  display_name: string | null;
  login_type: string;
};

export function hashActionToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export function auditInput(
  tenantId: string,
  userId: string | null,
  type: AuditEventType,
  payload: Record<string, unknown>,
  meta: RequestMeta
) {
  return { tenantId, sessionId: null, userId, type, payload, ipAddress: meta.ipAddress, userAgent: meta.userAgent };
}

/**
 * Locks the identity row and reads what every transition checks.
 *
 * Two statements on purpose. Under READ COMMITTED, a `SELECT ... FOR UPDATE
 * OF li` that waits for the lock re-reads only the locked row; the rows it
 * joins keep the version from before the wait. A role change that held the
 * lock would then be invisible: a reset racing a promotion read the old role.
 * The second statement starts after the lock is held and sees every commit.
 */
export async function lockIdentity(client: PoolClient, tenantId: string, userId: string): Promise<LockedIdentity | null> {
  const locked = await client.query(
    `SELECT 1 FROM local_identities WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE`,
    [tenantId, userId]
  );
  if (!locked.rowCount) return null;
  const result = await client.query<LockedIdentity>(
    `
      SELECT li.status, li.security_version, tm.role, u.email, u.display_name, t.login_type
      FROM local_identities li
      JOIN users u ON u.user_id = li.user_id
      JOIN tenants t ON t.tenant_id = li.tenant_id
      LEFT JOIN tenant_memberships tm ON tm.tenant_id = li.tenant_id AND tm.user_id = li.user_id
      WHERE li.tenant_id = $1 AND li.user_id = $2
    `,
    [tenantId, userId]
  );
  return result.rows[0] ?? null;
}

/**
 * Takes the tenant's membership lock, locks the target's identity, then
 * checks the manager's rights against both roles as committed now. Role
 * changes and removals take the same tenant lock first, so neither a
 * promotion of the target nor a demotion of the actor can commit between this
 * check and the change (services/member-authority.ts).
 */
export async function lockTargetForManager(
  client: PoolClient,
  tenantId: string,
  targetUserId: string,
  actor: ManagerActor
): Promise<LockedIdentity & { role: TenantMembershipRole }> {
  const actorUserId = actorIdOf(actor);
  await lockTenantMembership(client, tenantId);
  const identity = await lockIdentity(client, tenantId, targetUserId);
  if (!identity || identity.role === null) throw new LocalAccountError("member_not_found");
  const actorRole = await currentRole(client, tenantId, actor);
  const refusal = managerMayAct({ userId: actorUserId, role: actorRole }, { userId: targetUserId, role: identity.role });
  if (refusal) throw new LocalAccountError(refusal);
  return { ...identity, role: identity.role };
}

/**
 * For routes/tenant.ts: before a role change or a removal locks the
 * membership row, lock the local identity, if the member has one. This keeps
 * one lock order for every change of a local account (identity, then
 * membership, then the rows that follow). Returns the local account's status,
 * or null for a member without a local account.
 */
export async function lockLocalIdentityForMembershipChange(
  client: PoolClient,
  tenantId: string,
  userId: string
): Promise<LocalAccountStatus | null> {
  const result = await client.query<{ status: LocalAccountStatus }>(
    `SELECT status FROM local_identities WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE`,
    [tenantId, userId]
  );
  return result.rows[0]?.status ?? null;
}

/**
 * Increments security_version only if it still has the expected value. After
 * the commit, the account's active work stops (security-change.ts).
 */
export async function bumpSecurityVersion(
  change: SecurityChange,
  userId: string,
  expected: number,
  status?: LocalAccountStatus
): Promise<number> {
  const result = await change.client.query<{ security_version: number }>(
    `
      UPDATE local_identities
      SET security_version = security_version + 1,
          status = COALESCE($4, status),
          updated_at = now()
      WHERE tenant_id = $1 AND user_id = $2 AND security_version = $3
      RETURNING security_version
    `,
    [change.tenantId, userId, expected, status ?? null]
  );
  if (!result.rows[0]) throw new LocalAccountError("concurrent_change");
  change.endActiveWork(userId);
  return result.rows[0].security_version;
}

/**
 * Removes every open link of the account. Called when a new link is issued
 * and on every security change; the version check also refuses old links,
 * this keeps the table honest.
 */
export async function cancelOpenLinks(client: PoolClient, tenantId: string, userId: string, purpose?: ActionPurpose): Promise<void> {
  await client.query(
    `
      UPDATE auth_action_tokens SET used_at = now()
      WHERE tenant_id = $1 AND user_id = $2 AND used_at IS NULL AND ($3::text IS NULL OR purpose = $3)
    `,
    [tenantId, userId, purpose ?? null]
  );
}

/**
 * Marks a local account removed inside the caller's transaction: no password,
 * no links, a new security version. The membership delete that follows ends
 * the account's access; the identity row stays for audit references. After
 * the commit, the account's active work stops (security-change.ts).
 */
export async function markLocalIdentityRemoved(change: SecurityChange, userId: string): Promise<void> {
  const { client, tenantId } = change;
  const removed = await client.query(
    `
      UPDATE local_identities
      SET status = 'removed', security_version = security_version + 1, updated_at = now()
      WHERE tenant_id = $1 AND user_id = $2
    `,
    [tenantId, userId]
  );
  if (removed.rowCount) change.endActiveWork(userId);
  await client.query(`DELETE FROM local_passwords WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId]);
  await client.query(`DELETE FROM auth_action_tokens WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId]);
  await deleteSecondFactors(client, tenantId, userId);
}

/**
 * Removes the authenticator app, the passkeys, and every recovery code of an
 * account. Returns how many factors (an app, passkeys) it removed; a pending
 * app enrolment does not count.
 */
export async function deleteSecondFactors(client: PoolClient, tenantId: string, userId: string): Promise<number> {
  const totp = await client.query(
    `DELETE FROM user_totp_factors WHERE tenant_id = $1 AND user_id = $2 RETURNING confirmed_at IS NOT NULL AS confirmed`,
    [tenantId, userId]
  );
  const passkeys = await client.query(`DELETE FROM user_passkeys WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId]);
  await client.query(`DELETE FROM user_recovery_codes WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId]);
  const confirmedApps = (totp.rows as { confirmed: boolean }[]).filter((row) => row.confirmed).length;
  return confirmedApps + (passkeys.rowCount ?? 0);
}

class NoAddressError extends Error {}

export class LocalAccountService {
  constructor(
    private readonly deps: {
      /** app_user pool: every tenant-scoped read and write. */
      db: Pool;
      /** Maintenance pool: the two lookups before the tenant is known. */
      lookupDb: Pool;
      hasher: PasswordHasher;
      /** Frontend origin, for the links (config API_ORIGIN). */
      frontendOrigin: string;
      /** Security notices and link emails; absent when email is off. */
      notices?: AccountMailQueue | null;
      /** After the commit of a new security version: stops the account's active work. */
      afterSecurityChange: AfterSecurityChange;
    }
  ) {}

  /** A transaction that can increment security versions (security-change.ts). */
  private securityChange<T>(tenantId: string, fn: (client: PoolClient, change: SecurityChange) => Promise<T>): Promise<T> {
    return withSecurityChange(this.deps.db, tenantId, this.deps.afterSecurityChange, fn);
  }

  private linkUrl(purpose: ActionPurpose, rawToken: string): string {
    // The token is in the fragment, so it reaches neither server logs nor the
    // Referer header.
    const page = purpose === "account_setup" ? "/auth/setup" : "/auth/reset-password";
    return `${this.deps.frontendOrigin}${page}#token=${rawToken}`;
  }

  /** Inside a transaction that holds the identity lock. */
  private async issueLink(
    client: PoolClient,
    input: { tenantId: string; userId: string; purpose: ActionPurpose; securityVersion: number; createdBy: string | null; ttlMs: number }
  ): Promise<{ link: IssuedLink; tokenHash: string }> {
    await cancelOpenLinks(client, input.tenantId, input.userId, input.purpose);
    const rawToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + input.ttlMs);
    await client.query(
      `
        INSERT INTO auth_action_tokens (token_hash, tenant_id, user_id, purpose, security_version, created_by, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [hashActionToken(rawToken), input.tenantId, input.userId, input.purpose, input.securityVersion, input.createdBy, expiresAt]
    );
    return {
      link: { url: this.linkUrl(input.purpose, rawToken), expiresAt: expiresAt.toISOString(), purpose: input.purpose },
      tokenHash: hashActionToken(rawToken)
    };
  }

  /**
   * With email on, queues the link email in the caller's transaction and
   * returns only where it went: the caller (a manager) never sees the link.
   * An account without an address then fails (`no_email_address`), and the
   * transaction rolls back. With email off, returns the link for the caller
   * to pass on.
   */
  private async deliverLink(
    client: PoolClient,
    tenantId: string,
    userId: string,
    issued: { link: IssuedLink; tokenHash: string },
    variant: LinkEmailVariant
  ): Promise<LinkDelivery> {
    const { link, tokenHash } = issued;
    const mail = this.deps.notices;
    if (!mail) return { link, email: null };
    const to = await mail.queueLink(client, tenantId, userId, {
      kind: link.purpose === "account_setup" ? "account_setup_link" : "password_reset_link",
      variant,
      url: link.url,
      expiresAt: new Date(link.expiresAt),
      tokenHash
    });
    if (!to) throw new LocalAccountError("no_email_address");
    return { link: null, email: { to, expiresAt: link.expiresAt, purpose: link.purpose } };
  }

  /**
   * Checks an email and password. Every failure is the same
   * `invalid_credentials`, with the same Argon2 work, whatever the cause: no
   * account, no password yet, wrong password, disabled, removed, or a tenant
   * that does not use local login. The caller throttles first.
   */
  async signInWithPassword(rawEmail: string, rawPassword: string, meta: RequestMeta): Promise<LocalSessionIdentity> {
    const password = normalizePassword(rawPassword);
    const email = parseEmail(rawEmail);
    const account = email && password.length <= MAX_PASSWORD_INPUT_LENGTH
      ? await this.findAccountByEmail(email)
      : null;
    if (!account) {
      await this.deps.hasher.verifyDummy(password.slice(0, MAX_PASSWORD_INPUT_LENGTH));
      throw new LocalAccountError("invalid_credentials");
    }

    const row = await withTenantScope(this.deps.db, account.tenantId, async (client) => {
      const result = await client.query<{
        status: LocalAccountStatus; security_version: number; password_hash: string | null;
        email: string; display_name: string | null; login_type: string; role: TenantMembershipRole | null;
      }>(
        `
          SELECT li.status, li.security_version, lp.password_hash, u.email, u.display_name, t.login_type, tm.role
          FROM local_identities li
          JOIN users u ON u.user_id = li.user_id
          JOIN tenants t ON t.tenant_id = li.tenant_id
          LEFT JOIN local_passwords lp ON lp.tenant_id = li.tenant_id AND lp.user_id = li.user_id
          LEFT JOIN tenant_memberships tm ON tm.tenant_id = li.tenant_id AND tm.user_id = li.user_id
          WHERE li.tenant_id = $1 AND li.user_id = $2
        `,
        [account.tenantId, account.userId]
      );
      return result.rows[0];
    });

    if (!row?.password_hash) {
      await this.deps.hasher.verifyDummy(password);
      throw new LocalAccountError("invalid_credentials");
    }
    const verification = await this.deps.hasher.verify(row.password_hash, password);
    const usable = row.status === "active" && row.role !== null && row.login_type === "local";
    if (!verification.ok || !usable) {
      await withTenantScope(this.deps.db, account.tenantId, (client) =>
        AuditEventStore.createInTransaction(client, auditInput(account.tenantId, account.userId, "auth.login_failed", {
          reason: verification.ok ? `account_${row.status}` : "wrong_password"
        }, meta))
      );
      throw new LocalAccountError("invalid_credentials");
    }

    const newHash = verification.needsRehash ? await this.deps.hasher.hash(password) : null;
    await withTenantScope(this.deps.db, account.tenantId, async (client) => {
      await client.query(
        `UPDATE local_identities SET last_login_at = now() WHERE tenant_id = $1 AND user_id = $2`,
        [account.tenantId, account.userId]
      );
      if (newHash) {
        // Only if the password did not change in between.
        await client.query(
          `UPDATE local_passwords SET password_hash = $3 WHERE tenant_id = $1 AND user_id = $2 AND password_hash = $4`,
          [account.tenantId, account.userId, newHash, row.password_hash]
        );
      }
      await AuditEventStore.createInTransaction(client, auditInput(account.tenantId, account.userId, "auth.login_succeeded", { amr: ["pwd"] }, meta));
    });

    return {
      tenantId: account.tenantId,
      userId: account.userId,
      role: row.role!,
      email: row.email,
      displayName: row.display_name,
      securityVersion: row.security_version
    };
  }

  private async findAccountByEmail(email: string): Promise<{ tenantId: string; userId: string } | null> {
    const result = await this.deps.lookupDb.query<{ tenant_id: string; user_id: string }>(
      `
        SELECT li.tenant_id, li.user_id
        FROM users u
        JOIN local_identities li ON li.user_id = u.user_id
        WHERE u.email_key = lower(btrim($1)) AND u.auth_source = 'local'
        LIMIT 1
      `,
      [email]
    );
    const row = result.rows[0];
    return row ? { tenantId: row.tenant_id, userId: row.user_id } : null;
  }

  /**
   * Sets a password with a link. `account_setup` works only for an
   * account in pending_setup and activates it; `password_reset` works only for
   * an active account. Both increment the security version, so every older
   * session and link ends. Returns the identity: setup starts a session,
   * reset does not.
   */
  async redeemLink(purpose: ActionPurpose, rawToken: string, rawPassword: string, meta: RequestMeta): Promise<LocalSessionIdentity> {
    if (typeof rawToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(rawToken)) throw new LocalAccountError("link_invalid");
    const tokenHash = hashActionToken(rawToken);
    const found = await this.deps.lookupDb.query<{ tenant_id: string; user_id: string; purpose: string; email: string | null }>(
      `
        SELECT t.tenant_id, t.user_id, t.purpose, u.email
        FROM auth_action_tokens t
        JOIN users u ON u.user_id = t.user_id
        WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now()
      `,
      [tokenHash]
    );
    const link = found.rows[0];
    if (!link || link.purpose !== purpose) throw new LocalAccountError("link_invalid");

    const password = normalizePassword(rawPassword);
    const policyError = checkPasswordPolicy(password, { email: link.email });
    if (policyError) throw new LocalAccountError(policyError);
    const passwordHash = await this.deps.hasher.hash(password);

    return this.securityChange(link.tenant_id, async (client, change) => {
      const identity = await lockIdentity(client, link.tenant_id, link.user_id);
      const token = await client.query<{ purpose: string; security_version: number; used_at: Date | null; expires_at: Date }>(
        `SELECT purpose, security_version, used_at, expires_at FROM auth_action_tokens WHERE token_hash = $1 FOR UPDATE`,
        [tokenHash]
      );
      const tokenRow = token.rows[0];
      const expectedStatus: LocalAccountStatus = purpose === "account_setup" ? "pending_setup" : "active";
      if (
        !identity || !tokenRow || tokenRow.purpose !== purpose || tokenRow.used_at !== null ||
        tokenRow.expires_at.getTime() <= Date.now() || tokenRow.security_version !== identity.security_version ||
        identity.status !== expectedStatus || identity.role === null || identity.login_type !== "local"
      ) {
        throw new LocalAccountError("link_invalid");
      }

      await client.query(
        `
          INSERT INTO local_passwords (tenant_id, user_id, password_hash) VALUES ($1, $2, $3)
          ON CONFLICT (tenant_id, user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, changed_at = now()
        `,
        [link.tenant_id, link.user_id, passwordHash]
      );
      const securityVersion = await bumpSecurityVersion(change, link.user_id, identity.security_version, "active");
      await client.query(`UPDATE auth_action_tokens SET used_at = now() WHERE token_hash = $1`, [tokenHash]);
      await cancelOpenLinks(client, link.tenant_id, link.user_id);
      await AuditEventStore.createInTransaction(client, auditInput(link.tenant_id, link.user_id,
        purpose === "account_setup" ? "auth.account_setup_completed" : "auth.password_reset_completed", {}, meta));
      if (purpose === "password_reset") await this.deps.notices?.queue(client, link.tenant_id, link.user_id, { kind: "password_changed" });

      return {
        tenantId: link.tenant_id,
        userId: link.user_id,
        role: identity.role,
        email: identity.email ?? "",
        displayName: identity.display_name,
        securityVersion
      };
    });
  }

  /**
   * "Forgot password": emails a 30-minute reset link to an active account.
   * The caller has already answered (the same answer for every address), so
   * nothing here can show whether an account exists. The link is issued under
   * the identity lock without a new security version, so a request from
   * someone else signs nobody out; it replaces an older reset link. One email
   * per account per SELF_RESET_COOLDOWN_MS.
   */
  async requestPasswordReset(rawEmail: string, meta: RequestMeta): Promise<PasswordResetRequestOutcome> {
    const mail = this.deps.notices;
    if (!mail) return "mail_off";
    const email = parseEmail(rawEmail);
    const account = email ? await this.findAccountByEmail(email) : null;
    if (!account) return "no_account";
    return withTenantScope(this.deps.db, account.tenantId, async (client) => {
      const identity = await lockIdentity(client, account.tenantId, account.userId);
      if (!identity || identity.status !== "active" || identity.role === null || identity.login_type !== "local") return "not_active";
      if (await mail.linkQueuedWithin(client, account.tenantId, account.userId, ["password_reset_link"], SELF_RESET_COOLDOWN_MS)) {
        return "cooldown";
      }
      const { link, tokenHash } = await this.issueLink(client, {
        tenantId: account.tenantId, userId: account.userId, purpose: "password_reset",
        securityVersion: identity.security_version, createdBy: null, ttlMs: SELF_RESET_TTL_MS
      });
      const queued = await mail.queueLink(client, account.tenantId, account.userId, {
        kind: "password_reset_link", variant: "self_reset", url: link.url, expiresAt: new Date(link.expiresAt), tokenHash
      });
      // No address: roll back, so the older link stays.
      if (!queued) throw new NoAddressError();
      await AuditEventStore.createInTransaction(client, auditInput(account.tenantId, account.userId, "auth.password_reset_requested", {}, meta));
      return "sent";
    }).catch((error: unknown) => {
      if (error instanceof NoAddressError) return "no_address" as const;
      throw error;
    });
  }

  /**
   * Proves the password of the signed-in user, for a step-up or a password
   * change. Throws invalid_credentials on a wrong password.
   */
  async verifyOwnPassword(tenantId: string, userId: string, rawPassword: string): Promise<{ email: string; passwordHash: string }> {
    const password = normalizePassword(rawPassword);
    const row = await withTenantScope(this.deps.db, tenantId, async (client) => {
      const result = await client.query<{ password_hash: string; email: string }>(
        `
          SELECT lp.password_hash, u.email
          FROM local_passwords lp JOIN users u ON u.user_id = lp.user_id
          WHERE lp.tenant_id = $1 AND lp.user_id = $2
        `,
        [tenantId, userId]
      );
      return result.rows[0];
    });
    if (!row || password.length > MAX_PASSWORD_INPUT_LENGTH) {
      await this.deps.hasher.verifyDummy(password.slice(0, MAX_PASSWORD_INPUT_LENGTH));
      throw new LocalAccountError("invalid_credentials");
    }
    const verification = await this.deps.hasher.verify(row.password_hash, password);
    if (!verification.ok) throw new LocalAccountError("invalid_credentials");
    return { email: row.email, passwordHash: row.password_hash };
  }

  /**
   * Changes the password of the signed-in user. Ends every session of the
   * account, the current one too; the route starts a new session with the
   * returned identity.
   */
  async changeOwnPassword(
    tenantId: string,
    userId: string,
    currentPassword: string,
    newPassword: string,
    /** The version the caller's session carries. */
    expectedVersion: number,
    meta: RequestMeta
  ): Promise<LocalSessionIdentity> {
    const verified = await this.verifyOwnPassword(tenantId, userId, currentPassword);
    const password = normalizePassword(newPassword);
    const policyError = checkPasswordPolicy(password, { email: verified.email });
    if (policyError) throw new LocalAccountError(policyError);
    const passwordHash = await this.deps.hasher.hash(password);

    return this.securityChange(tenantId, async (client, change) => {
      const identity = await lockIdentity(client, tenantId, userId);
      if (!identity || identity.status !== "active" || identity.role === null) throw new LocalAccountError("account_state_conflict");
      // A security change since the caller's checks (for example a new
      // second factor while the hash ran) ends this session: the caller
      // decided on step-up and on the new session's amr with the old state.
      if (identity.security_version !== expectedVersion) throw new LocalAccountError("session_changed");
      // The password must still be the one just verified.
      const updated = await client.query(
        `UPDATE local_passwords SET password_hash = $3, changed_at = now() WHERE tenant_id = $1 AND user_id = $2 AND password_hash = $4`,
        [tenantId, userId, passwordHash, verified.passwordHash]
      );
      if (updated.rowCount !== 1) throw new LocalAccountError("concurrent_change");
      const securityVersion = await bumpSecurityVersion(change, userId, identity.security_version);
      await cancelOpenLinks(client, tenantId, userId);
      await AuditEventStore.createInTransaction(client, auditInput(tenantId, userId, "auth.password_changed", {}, meta));
      await this.deps.notices?.queue(client, tenantId, userId, { kind: "password_changed" });
      return { tenantId, userId, role: identity.role, email: identity.email ?? "", displayName: identity.display_name, securityVersion };
    });
  }

  /**
   * Ends every session of an account: increments its security version. After
   * the commit, the account's runtimes and tool contexts stop too.
   */
  async revokeSessions(tenantId: string, targetUserId: string, actor: ManagerActor, meta: RequestMeta): Promise<void> {
    const actorUserId = actorIdOf(actor);
    await this.securityChange(tenantId, async (client, change) => {
      // The user's own "sign out everywhere" needs no manager rights.
      const identity = actorUserId === targetUserId
        ? await lockIdentity(client, tenantId, targetUserId)
        : await lockTargetForManager(client, tenantId, targetUserId, actor);
      if (!identity || identity.role === null) throw new LocalAccountError("member_not_found");
      await bumpSecurityVersion(change, targetUserId, identity.security_version);
      await AuditEventStore.createInTransaction(client, auditInput(tenantId, actorUserId,
        actorUserId === targetUserId ? "auth.sessions_revoked" : "tenant.member.sessions_revoked",
        actorUserId === targetUserId ? {} : { targetUserId }, meta));
    });
  }

  /**
   * Creates a local member and its setup link. The caller has checked the
   * manager's rights; they are checked again here. A manager cannot create an
   * owner (`account_not_active`). An email that any account already holds, of
   * either login type, is refused: an existing user row is never adopted.
   */
  async createMember(input: CreateMemberInput): Promise<{ userId: string } & LinkDelivery> {
    return withTenantScope(this.deps.db, input.tenantId, (client) => this.createMemberInTransaction(client, input));
  }

  /**
   * The body of createMember, for a caller that already holds a transaction in
   * the tenant's scope (the bootstrap command creates the tenant in the same
   * transaction).
   */
  async createMemberInTransaction(client: PoolClient, input: CreateMemberInput): Promise<{ userId: string } & LinkDelivery> {
    const email = parseEmail(input.email);
    if (!email) throw new LocalAccountError("email_invalid");
    // First lock of the transaction (member-authority.ts).
    await lockTenantMembership(client, input.tenantId);
    const tenant = await client.query<{ login_type: string }>(
      `SELECT login_type FROM tenants WHERE tenant_id = $1 FOR SHARE`,
      [input.tenantId]
    );
    if (tenant.rows[0]?.login_type !== "local") throw new LocalAccountError("wrong_login_type");
    // A manager's rights as committed now; the operator commands pass no actor.
    // The new account is pending_setup, so a manager cannot make it an owner
    // (ownerRoleRefusal). Only the operator's bootstrap creates a pending owner.
    if (input.actorUserId !== null) {
      const refusal = mayAssignRole(
        await currentRole(client, input.tenantId, { userId: input.actorUserId, securityVersion: input.actorVersion }),
        input.role
      ) ?? ownerRoleRefusal(input.role, NEW_ACCOUNT_STATUS);
      if (refusal) throw new LocalAccountError(refusal);
    }

    // Same lock key as WorkOS provisioning, so the two cannot race for one email.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('users:email_key:' || lower(btrim($1))))`, [email]);
    const taken = await client.query(`SELECT 1 FROM users WHERE email_key = lower(btrim($1)) LIMIT 1`, [email]);
    if (taken.rowCount) throw new LocalAccountError("email_in_use");

    const userId = uuidv7();
    await client.query(
      `INSERT INTO users (user_id, email, display_name, auth_source) VALUES ($1, $2, $3, 'local')`,
      [userId, email, input.displayName]
    );
    await client.query(
      `INSERT INTO local_identities (tenant_id, user_id, status) VALUES ($1, $2, $3)`,
      [input.tenantId, userId, NEW_ACCOUNT_STATUS]
    );
    await client.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, role, user_auth_source) VALUES ($1, $2, $3, 'local')`,
      [input.tenantId, userId, input.role]
    );
    const issued = await this.issueLink(client, {
      tenantId: input.tenantId, userId, purpose: "account_setup", securityVersion: 0,
      createdBy: input.actorUserId, ttlMs: ACCOUNT_SETUP_TTL_MS
    });
    const delivery = await this.deliverLink(client, input.tenantId, userId, issued, "setup");
    await AuditEventStore.createInTransaction(client, auditInput(input.tenantId, input.actorUserId, "tenant.member.created", {
      targetUserId: userId, role: input.role, linkDelivery: delivery.email ? "email" : "shown",
      ...(input.actorUserId === null ? { actor: "operator" } : {})
    }, input.meta));
    return { userId, ...delivery };
  }

  /**
   * Operator recovery of an owner who lost the password: the
   * account goes back to pending_setup with no password and a new setup
   * link, and every session and older link ends.
   */
  async recoverOwner(tenantId: string, rawEmail: string): Promise<{ userId: string; link: IssuedLink }> {
    const email = parseEmail(rawEmail);
    if (!email) throw new LocalAccountError("email_invalid");
    return this.securityChange(tenantId, async (client, change) => {
      const found = await client.query<{ user_id: string }>(
        `
          SELECT li.user_id
          FROM local_identities li
          JOIN users u ON u.user_id = li.user_id
          WHERE li.tenant_id = $1 AND u.email_key = lower(btrim($2))
        `,
        [tenantId, email]
      );
      const userId = found.rows[0]?.user_id;
      if (!userId) throw new LocalAccountError("member_not_found");
      // An operator change of an owner account: same lock order as managers.
      await lockTenantMembership(client, tenantId);
      const identity = await lockIdentity(client, tenantId, userId);
      if (!identity || identity.role !== "owner") throw new LocalAccountError("member_not_found");
      if (identity.status === "removed") throw new LocalAccountError("account_state_conflict");
      await client.query(`DELETE FROM local_passwords WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId]);
      await deleteSecondFactors(client, tenantId, userId);
      const securityVersion = await bumpSecurityVersion(change, userId, identity.security_version, "pending_setup");
      await cancelOpenLinks(client, tenantId, userId);
      const { link } = await this.issueLink(client, {
        tenantId, userId, purpose: "account_setup", securityVersion, createdBy: null, ttlMs: ACCOUNT_SETUP_TTL_MS
      });
      await AuditEventStore.createInTransaction(client, auditInput(tenantId, null, "auth.owner_recovered", {
        targetUserId: userId, actor: "operator", previousStatus: identity.status
      }, { ipAddress: null, userAgent: null }));
      return { userId, link };
    });
  }

  /** Target role and status, for the manager's rights check. */
  async getMemberState(tenantId: string, userId: string): Promise<{ role: TenantMembershipRole; status: LocalAccountStatus } | null> {
    return withTenantScope(this.deps.db, tenantId, async (client) => {
      const result = await client.query<{ role: TenantMembershipRole; status: LocalAccountStatus }>(
        `
          SELECT tm.role, li.status
          FROM tenant_memberships tm
          JOIN local_identities li ON li.tenant_id = tm.tenant_id AND li.user_id = tm.user_id
          WHERE tm.tenant_id = $1 AND tm.user_id = $2
        `,
        [tenantId, userId]
      );
      return result.rows[0] ?? null;
    });
  }

  /**
   * Ends every session of the member and issues a link: by email to the
   * member when email is on (the email says an administrator reset the
   * password), otherwise to the manager. An active account gets a
   * password-reset link: it changes the password only, and the old password
   * keeps working until then. An account that never finished setup gets a new
   * setup link. A disabled account must be enabled first.
   */
  async resetMemberPassword(tenantId: string, targetUserId: string, actor: ManagerActor, meta: RequestMeta): Promise<LinkDelivery> {
    const actorUserId = actorIdOf(actor);
    return this.securityChange(tenantId, async (client, change) => {
      const identity = await lockTargetForManager(client, tenantId, targetUserId, actor);
      if (identity.status !== "active" && identity.status !== "pending_setup") throw new LocalAccountError("account_state_conflict");
      // A new setup link is only an email: it waits like a resend. A reset of
      // an active account is a security action (every session ends) and
      // never waits.
      const mail = this.deps.notices;
      if (
        identity.status === "pending_setup" && mail &&
        (await mail.linkQueuedWithin(client, tenantId, targetUserId, ["account_setup_link", "password_reset_link"], MANAGER_LINK_COOLDOWN_MS))
      ) {
        throw new LocalAccountError("link_sent_recently");
      }
      const securityVersion = await bumpSecurityVersion(change, targetUserId, identity.security_version);
      await cancelOpenLinks(client, tenantId, targetUserId);
      const purpose: ActionPurpose = identity.status === "active" ? "password_reset" : "account_setup";
      const issued = await this.issueLink(client, {
        tenantId, userId: targetUserId, purpose, securityVersion, createdBy: actorUserId,
        ttlMs: purpose === "password_reset" ? MANAGER_RESET_TTL_MS : ACCOUNT_SETUP_TTL_MS
      });
      const delivery = await this.deliverLink(client, tenantId, targetUserId, issued, purpose === "password_reset" ? "admin_reset" : "setup");
      await AuditEventStore.createInTransaction(client, auditInput(tenantId, actorUserId, "tenant.member.password_reset", {
        targetUserId, linkPurpose: purpose, linkDelivery: delivery.email ? "email" : "shown"
      }, meta));
      // The warning goes as its own notice: the link email can be replaced
      // (a resend) or expire before it is sent, the notice cannot.
      if (purpose === "password_reset") await mail?.queue(client, tenantId, targetUserId, { kind: "admin_password_reset" });
      return delivery;
    });
  }

  /**
   * Email on only: sends the member a new link, for a lost or late email.
   * It changes nothing else: no session ends, the version stays, and the new
   * link replaces the open one of its purpose. An account not set up yet
   * gets a setup link; an active account a password-reset link. No step-up:
   * the manager never sees the link. One resend per account per
   * MANAGER_LINK_COOLDOWN_MS.
   */
  async resendMemberLink(tenantId: string, targetUserId: string, actor: ManagerActor, meta: RequestMeta): Promise<EmailedLink> {
    const mail = this.deps.notices;
    if (!mail) throw new LocalAccountError("email_off");
    const actorUserId = actorIdOf(actor);
    return withTenantScope(this.deps.db, tenantId, async (client) => {
      const identity = await lockTargetForManager(client, tenantId, targetUserId, actor);
      if (identity.status !== "active" && identity.status !== "pending_setup") throw new LocalAccountError("account_state_conflict");
      if (await mail.linkQueuedWithin(client, tenantId, targetUserId, ["account_setup_link", "password_reset_link"], MANAGER_LINK_COOLDOWN_MS)) {
        throw new LocalAccountError("link_sent_recently");
      }
      const purpose: ActionPurpose = identity.status === "active" ? "password_reset" : "account_setup";
      const issued = await this.issueLink(client, {
        tenantId, userId: targetUserId, purpose, securityVersion: identity.security_version, createdBy: actorUserId,
        ttlMs: purpose === "password_reset" ? MANAGER_RESET_TTL_MS : ACCOUNT_SETUP_TTL_MS
      });
      const delivery = await this.deliverLink(client, tenantId, targetUserId, issued, purpose === "password_reset" ? "admin_resend" : "setup");
      if (!delivery.email) throw new LocalAccountError("email_off");
      await AuditEventStore.createInTransaction(client, auditInput(tenantId, actorUserId, "tenant.member.link_resent", {
        targetUserId, linkPurpose: purpose
      }, meta));
      return delivery.email;
    });
  }

  /**
   * Disables a member: no sign-in, every session ends, open links end, and
   * scheduled jobs are suspended in the same transaction (as member removal
   * does). After the commit, the member's active runtimes stop.
   */
  async disableMember(tenantId: string, targetUserId: string, actor: ManagerActor, meta: RequestMeta): Promise<void> {
    const actorUserId = actorIdOf(actor);
    await this.securityChange(tenantId, async (client, change) => {
      const identity = await lockTargetForManager(client, tenantId, targetUserId, actor);
      if (identity.status === "disabled") return;
      if (identity.status !== "active" && identity.status !== "pending_setup") throw new LocalAccountError("account_state_conflict");
      await bumpSecurityVersion(change, targetUserId, identity.security_version, "disabled");
      await cancelOpenLinks(client, tenantId, targetUserId);
      // The reason makes the owner review each job before it runs again
      // (Review, not Enable): someone else can have saved its prompt.
      await client.query(
        `UPDATE scheduled_jobs SET enabled = FALSE, next_run_at = NULL, paused_reason = 'security_change', updated_at = NOW()
         WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, targetUserId]
      );
      await AuditEventStore.createInTransaction(client, auditInput(tenantId, actorUserId, "tenant.member.disabled", {
        targetUserId, previousStatus: identity.status
      }, meta));
    });
  }

  /**
   * Enables a disabled member. An account with a password becomes active; one
   * that never set a password goes back to pending_setup and needs a new
   * setup link (the old ones ended at disable). Suspended jobs stay off; the
   * member reviews each one and turns it on again.
   */
  async enableMember(tenantId: string, targetUserId: string, actor: ManagerActor, meta: RequestMeta): Promise<LocalAccountStatus> {
    const actorUserId = actorIdOf(actor);
    return this.securityChange(tenantId, async (client, change) => {
      const identity = await lockTargetForManager(client, tenantId, targetUserId, actor);
      if (identity.status !== "disabled") return identity.status;
      const hasPassword = await client.query(
        `SELECT 1 FROM local_passwords WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, targetUserId]
      );
      const status: LocalAccountStatus = hasPassword.rowCount ? "active" : "pending_setup";
      await bumpSecurityVersion(change, targetUserId, identity.security_version, status);
      await AuditEventStore.createInTransaction(client, auditInput(tenantId, actorUserId, "tenant.member.enabled", {
        targetUserId, status
      }, meta));
      return status;
    });
  }
}
