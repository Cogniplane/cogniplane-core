import type { PoolClient } from "pg";

import { decrypt, encrypt } from "../../lib/crypto-utils.js";
import { type Pool, withTenantScope } from "../../lib/db.js";
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  isRecoveryCodeShape,
  RECOVERY_CODE_KEY_LABEL
} from "../../lib/recovery-codes.js";
import { generateTotpSecret, matchTotp, otpauthUri } from "../../lib/totp.js";
import { AuditEventStore } from "../audit-event-store.js";
import type { SecurityNoticeQueue } from "../mail/mail-outbox.js";
import { actorIdOf, currentRole, isManager, lockTenantMembership, type ManagerActor } from "../member-authority.js";
import type { TenantMembershipRole } from "../tenant-member-store.js";
import {
  auditInput,
  bumpSecurityVersion,
  deleteSecondFactors,
  LocalAccountError,
  type LocalSessionIdentity,
  lockIdentity,
  lockTargetForManager,
  type LockedIdentity,
  type RequestMeta
} from "./local-account-service.js";
import { type AfterSecurityChange, type SecurityChange, withSecurityChange } from "./security-change.js";

// Second factors of local accounts: an authenticator app (TOTP) and one-time
// recovery codes, plus the tenant's MFA policy. Passkeys are the other second
// factor (local-passkey-service.ts); "has a second factor" means an
// authenticator app or at least one passkey. See docs/architecture/local-accounts.md.
//
// Every change locks the account's identity row first, like every other
// change of a local account, and every check of a code runs in the same
// transaction as the write that spends it: a TOTP step and a recovery code
// each work once, also under concurrent requests.

export const MFA_POLICIES = ["optional", "required_for_admins", "required_for_all"] as const;
export type MfaPolicy = (typeof MFA_POLICIES)[number];

const POLICY_RANK: Record<MfaPolicy, number> = { optional: 0, required_for_admins: 1, required_for_all: 2 };

export function isMfaPolicy(value: unknown): value is MfaPolicy {
  return typeof value === "string" && (MFA_POLICIES as readonly string[]).includes(value);
}

/** Whether the tenant policy asks this role for a second factor. */
export function policyRequiresMfa(policy: string, role: TenantMembershipRole | null): boolean {
  if (policy === "required_for_all") return true;
  if (policy === "required_for_admins") return role === "owner" || role === "admin";
  return false;
}

export type FactorState = {
  totpEnabled: boolean;
  passkeyCount: number;
  recoveryCodesRemaining: number;
  /** The tenant policy or a manager reset asks this account for a second factor. */
  mfaRequired: boolean;
};

export type TotpEnrollment = { secret: string; otpauthUri: string };

export type IdentityRow = LockedIdentity & { mfa_enrollment_required: boolean; mfa_policy: string };

export function hasAnyFactor(state: Pick<FactorState, "totpEnabled" | "passkeyCount">): boolean {
  return state.totpEnabled || state.passkeyCount > 0;
}

/**
 * SQL condition: the identity `li` has a second factor. Used where many
 * identities are checked at once (policy changes, the members list).
 */
export const HAS_SECOND_FACTOR_SQL = `(
  EXISTS (SELECT 1 FROM user_totp_factors f WHERE f.tenant_id = li.tenant_id AND f.user_id = li.user_id AND f.confirmed_at IS NOT NULL)
  OR EXISTS (SELECT 1 FROM user_passkeys p WHERE p.tenant_id = li.tenant_id AND p.user_id = li.user_id)
)`;

export async function readFactorState(client: PoolClient, tenantId: string, userId: string): Promise<FactorState> {
  const result = await client.query<{
    totp_enabled: boolean; passkeys: number; codes_left: number; mfa_enrollment_required: boolean; mfa_policy: string;
    role: TenantMembershipRole | null;
  }>(
    `
      SELECT
        EXISTS (SELECT 1 FROM user_totp_factors f WHERE f.tenant_id = li.tenant_id AND f.user_id = li.user_id AND f.confirmed_at IS NOT NULL) AS totp_enabled,
        (SELECT count(*) FROM user_passkeys p WHERE p.tenant_id = li.tenant_id AND p.user_id = li.user_id)::int AS passkeys,
        (SELECT count(*) FROM user_recovery_codes c WHERE c.tenant_id = li.tenant_id AND c.user_id = li.user_id AND c.used_at IS NULL)::int AS codes_left,
        li.mfa_enrollment_required, t.mfa_policy, tm.role
      FROM local_identities li
      JOIN tenants t ON t.tenant_id = li.tenant_id
      LEFT JOIN tenant_memberships tm ON tm.tenant_id = li.tenant_id AND tm.user_id = li.user_id
      WHERE li.tenant_id = $1 AND li.user_id = $2
    `,
    [tenantId, userId]
  );
  const row = result.rows[0];
  if (!row) return { totpEnabled: false, passkeyCount: 0, recoveryCodesRemaining: 0, mfaRequired: false };
  return {
    totpEnabled: row.totp_enabled,
    passkeyCount: row.passkeys,
    recoveryCodesRemaining: row.codes_left,
    mfaRequired: row.mfa_enrollment_required || policyRequiresMfa(row.mfa_policy, row.role)
  };
}

/** The identity lock, plus the two MFA columns, read after the lock is held. */
export async function lockIdentityForMfa(client: PoolClient, tenantId: string, userId: string): Promise<IdentityRow | null> {
  const identity = await lockIdentity(client, tenantId, userId);
  if (!identity) return null;
  const extra = await client.query<{ mfa_enrollment_required: boolean; mfa_policy: string }>(
    `
      SELECT li.mfa_enrollment_required, t.mfa_policy
      FROM local_identities li JOIN tenants t ON t.tenant_id = li.tenant_id
      WHERE li.tenant_id = $1 AND li.user_id = $2
    `,
    [tenantId, userId]
  );
  return { ...identity, ...extra.rows[0]! };
}

/**
 * For a change of the factors that the tenant policy depends on (a confirmed
 * factor, a removed one): the tenant's membership lock first, as every
 * policy change and manager change takes it, then the identity. So a policy
 * change and a factor change never overlap.
 */
export async function lockIdentityForFactorChange(client: PoolClient, tenantId: string, userId: string): Promise<IdentityRow | null> {
  await lockTenantMembership(client, tenantId);
  return lockIdentityForMfa(client, tenantId, userId);
}

export function sessionIdentity(tenantId: string, userId: string, identity: LockedIdentity, securityVersion: number): LocalSessionIdentity {
  if (identity.role === null) throw new LocalAccountError("member_not_found");
  return {
    tenantId,
    userId,
    role: identity.role,
    email: identity.email ?? "",
    displayName: identity.display_name,
    securityVersion
  };
}

/** The identity must be active, of a local tenant, and (when given) at the version a flow or session carries. */
export function assertUsable(identity: LockedIdentity | null, expectedVersion: number | undefined): asserts identity is LockedIdentity {
  if (
    !identity || identity.status !== "active" || identity.role === null || identity.login_type !== "local" ||
    (expectedVersion !== undefined && identity.security_version !== expectedVersion)
  ) {
    throw new LocalAccountError("session_changed");
  }
}

export async function replaceRecoveryCodes(client: PoolClient, tenantId: string, userId: string, rootSecret: string): Promise<string[]> {
  await client.query(`DELETE FROM user_recovery_codes WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId]);
  const codes = generateRecoveryCodes(rootSecret);
  for (const { hash } of codes) {
    await client.query(
      `INSERT INTO user_recovery_codes (tenant_id, user_id, code_hash, key_label) VALUES ($1, $2, $3, $4)`,
      [tenantId, userId, hash, RECOVERY_CODE_KEY_LABEL]
    );
  }
  return codes.map((c) => c.code);
}

/**
 * In the transaction that deleted one factor, after the delete: with no
 * factor left, the tenant policy must allow it (else `mfa_required` rolls the
 * delete back), and the recovery codes go too. Returns whether a factor is
 * left. The caller holds the tenant lock and the identity lock.
 */
export async function settleFactorRemoval(client: PoolClient, tenantId: string, userId: string, identity: IdentityRow): Promise<boolean> {
  if (hasAnyFactor(await readFactorState(client, tenantId, userId))) return true;
  if (policyRequiresMfa(identity.mfa_policy, identity.role)) throw new LocalAccountError("mfa_required");
  await client.query(`DELETE FROM user_recovery_codes WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId]);
  return false;
}

/**
 * Spends a recovery code that a sign-in step checked, in the enrolment's
 * transaction (after the identity lock). A code that another enrolment spent
 * or replaced meanwhile refuses this one.
 */
export async function spendRecoveryCode(
  client: PoolClient,
  tenantId: string,
  userId: string,
  codeHash: string,
  meta: RequestMeta
): Promise<void> {
  const spent = await client.query(
    `UPDATE user_recovery_codes SET used_at = now() WHERE tenant_id = $1 AND user_id = $2 AND code_hash = $3 AND used_at IS NULL`,
    [tenantId, userId, codeHash]
  );
  if (spent.rowCount !== 1) throw new LocalAccountError("invalid_code");
  await AuditEventStore.createInTransaction(client, auditInput(tenantId, userId, "auth.recovery_code_used", {}, meta));
}

/** Work that must succeed before an enrolment commits (the new session). */
export type BeforeCommit = (identity: LocalSessionIdentity) => Promise<void>;

export class LocalMfaService {
  constructor(
    private readonly deps: {
      /** app_user pool. */
      db: Pool;
      /** DATA_ENCRYPTION_SECRET: TOTP secrets and the recovery-code HMAC key. */
      secret: string;
      /** Name the authenticator app shows. */
      issuer: string;
      /** Security notices by email; absent when email is off. */
      notices?: SecurityNoticeQueue | null;
      /** After the commit of a new security version: stops the account's active work. */
      afterSecurityChange: AfterSecurityChange;
      now?: () => number;
    }
  ) {}

  /** A transaction that can increment security versions (security-change.ts). */
  private securityChange<T>(tenantId: string, fn: (client: PoolClient, change: SecurityChange) => Promise<T>): Promise<T> {
    return withSecurityChange(this.deps.db, tenantId, this.deps.afterSecurityChange, fn);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  async factorState(tenantId: string, userId: string): Promise<FactorState> {
    return withTenantScope(this.deps.db, tenantId, (client) => readFactorState(client, tenantId, userId));
  }

  /** An authenticator app or at least one passkey. */
  async hasSecondFactor(tenantId: string, userId: string): Promise<boolean> {
    return hasAnyFactor(await this.factorState(tenantId, userId));
  }

  /**
   * Starts (or restarts) an authenticator enrolment: a new pending secret. An
   * active factor stays in place until a code from the new one is confirmed.
   * `familyId`: the session family of a start in the user's own settings;
   * only that family can confirm it. Absent for the sign-in flow.
   */
  async startTotpEnrollment(
    tenantId: string,
    userId: string,
    expectedVersion: number,
    options: { familyId?: string } = {}
  ): Promise<TotpEnrollment> {
    return withTenantScope(this.deps.db, tenantId, async (client) => {
      const identity = await lockIdentityForMfa(client, tenantId, userId);
      assertUsable(identity, expectedVersion);
      const secret = generateTotpSecret();
      await client.query(
        `
          INSERT INTO user_totp_factors (tenant_id, user_id, pending_secret_encrypted, pending_created_at, pending_family_id)
          VALUES ($1, $2, $3, now(), $4)
          ON CONFLICT (tenant_id, user_id) DO UPDATE
          SET pending_secret_encrypted = EXCLUDED.pending_secret_encrypted, pending_created_at = now(),
              pending_family_id = EXCLUDED.pending_family_id, updated_at = now()
        `,
        [tenantId, userId, encrypt(secret, this.deps.secret), options.familyId ?? null]
      );
      return { secret, otpauthUri: otpauthUri({ issuer: this.deps.issuer, account: identity.email ?? userId, secret }) };
    });
  }

  /**
   * Confirms the pending enrolment with a code from the app. The new factor
   * replaces any old one, the recovery codes are replaced (shown once), the
   * manager-reset flag clears, and the security version increments: every
   * older session ends, the caller starts a new one with `otp` in its amr.
   * The pending secret must come from the same start: the same session
   * family (`familyId`), or the sign-in flow when `familyId` is absent.
   * Otherwise `enrollment_not_started`.
   */
  async confirmTotpEnrollment(
    tenantId: string,
    userId: string,
    code: string,
    expectedVersion: number,
    meta: RequestMeta,
    options: {
      /** A sign-in recovery: the checked code, spent with this enrolment. */
      recoveryCodeHash?: string;
      beforeCommit?: BeforeCommit;
      /** The confirming session's family, in the user's own settings. */
      familyId?: string;
    } = {}
  ): Promise<{ identity: LocalSessionIdentity; recoveryCodes: string[] }> {
    return this.securityChange(tenantId, async (client, change) => {
      const identity = await lockIdentityForFactorChange(client, tenantId, userId);
      assertUsable(identity, expectedVersion);
      const pending = await client.query<{
        pending_secret_encrypted: string | null; pending_created_at: Date | null; pending_family_id: string | null;
      }>(
        `
          SELECT pending_secret_encrypted, pending_created_at, pending_family_id
          FROM user_totp_factors WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE
        `,
        [tenantId, userId]
      );
      const row = pending.rows[0];
      // A pending secret older than 15 minutes must be started again, and so
      // must one that another session family (or path) started.
      if (
        !row?.pending_secret_encrypted || !row.pending_created_at ||
        this.now() - row.pending_created_at.getTime() > 15 * 60_000 ||
        (row.pending_family_id ?? null) !== (options.familyId ?? null)
      ) {
        throw new LocalAccountError("enrollment_not_started");
      }
      const secret = decrypt(row.pending_secret_encrypted, this.deps.secret);
      const step = matchTotp(secret, code, this.now());
      if (step === null) throw new LocalAccountError("invalid_code");

      await client.query(
        `
          UPDATE user_totp_factors
          SET secret_encrypted = pending_secret_encrypted, confirmed_at = now(), last_used_step = $3,
              pending_secret_encrypted = NULL, pending_created_at = NULL, pending_family_id = NULL, updated_at = now()
          WHERE tenant_id = $1 AND user_id = $2
        `,
        [tenantId, userId, step]
      );
      if (options.recoveryCodeHash) await spendRecoveryCode(client, tenantId, userId, options.recoveryCodeHash, meta);
      const recoveryCodes = await replaceRecoveryCodes(client, tenantId, userId, this.deps.secret);
      await client.query(
        `UPDATE local_identities SET mfa_enrollment_required = false WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, userId]
      );
      const securityVersion = await bumpSecurityVersion(change, userId, identity.security_version);
      await AuditEventStore.createInTransaction(client, auditInput(tenantId, userId, "auth.mfa_enrolled", { method: "totp" }, meta));
      await this.deps.notices?.queue(client, tenantId, userId, { kind: "factor_added", method: "totp" });
      const result = { identity: sessionIdentity(tenantId, userId, identity, securityVersion), recoveryCodes };
      await options.beforeCommit?.(result.identity);
      return result;
    });
  }

  /**
   * Checks a code from the authenticator app and spends its time step, so the
   * same code cannot be used again. For a second-factor sign-in and for
   * step-up. `expectedVersion`: the version the flow or session carries.
   */
  async verifyTotp(tenantId: string, userId: string, code: string, expectedVersion: number): Promise<LocalSessionIdentity> {
    return withTenantScope(this.deps.db, tenantId, async (client) => {
      const identity = await lockIdentity(client, tenantId, userId);
      assertUsable(identity, expectedVersion);
      const factor = await client.query<{ secret_encrypted: string | null }>(
        `SELECT secret_encrypted FROM user_totp_factors WHERE tenant_id = $1 AND user_id = $2 AND confirmed_at IS NOT NULL`,
        [tenantId, userId]
      );
      const encrypted = factor.rows[0]?.secret_encrypted;
      if (!encrypted) throw new LocalAccountError("invalid_code");
      const step = matchTotp(decrypt(encrypted, this.deps.secret), code, this.now());
      if (step === null) throw new LocalAccountError("invalid_code");
      // Atomic: a step not greater than the last one used is a replay.
      const spent = await client.query(
        `
          UPDATE user_totp_factors SET last_used_step = $3, updated_at = now()
          WHERE tenant_id = $1 AND user_id = $2 AND (last_used_step IS NULL OR last_used_step < $3)
        `,
        [tenantId, userId, step]
      );
      if (spent.rowCount !== 1) throw new LocalAccountError("invalid_code");
      return sessionIdentity(tenantId, userId, identity, identity.security_version);
    });
  }

  /**
   * Checks a recovery code without spending it. The sign-in step then starts
   * an enrolment flow that carries the code's hash; the enrolment spends the
   * code in the same transaction as the new factor (`spendRecoveryCode`). So
   * a failure between the two steps loses no code.
   */
  async checkRecoveryCode(
    tenantId: string,
    userId: string,
    code: string,
    expectedVersion: number
  ): Promise<{ identity: LocalSessionIdentity; codeHash: string }> {
    if (!isRecoveryCodeShape(code)) throw new LocalAccountError("invalid_code");
    const codeHash = hashRecoveryCode(code, this.deps.secret);
    return withTenantScope(this.deps.db, tenantId, async (client) => {
      const identity = await lockIdentity(client, tenantId, userId);
      assertUsable(identity, expectedVersion);
      const unused = await client.query(
        `SELECT 1 FROM user_recovery_codes WHERE tenant_id = $1 AND user_id = $2 AND code_hash = $3 AND used_at IS NULL`,
        [tenantId, userId, codeHash]
      );
      if (unused.rowCount !== 1) throw new LocalAccountError("invalid_code");
      return { identity: sessionIdentity(tenantId, userId, identity, identity.security_version), codeHash };
    });
  }

  /** New recovery codes; the old ones stop working. Needs an active factor. */
  async regenerateRecoveryCodes(tenantId: string, userId: string, expectedVersion: number, meta: RequestMeta): Promise<string[]> {
    return withTenantScope(this.deps.db, tenantId, async (client) => {
      const identity = await lockIdentity(client, tenantId, userId);
      assertUsable(identity, expectedVersion);
      if (!hasAnyFactor(await readFactorState(client, tenantId, userId))) throw new LocalAccountError("no_second_factor");
      const codes = await replaceRecoveryCodes(client, tenantId, userId, this.deps.secret);
      await AuditEventStore.createInTransaction(client, auditInput(tenantId, userId, "auth.recovery_codes_regenerated", {}, meta));
      return codes;
    });
  }

  /**
   * Removes the user's own authenticator app. When no second factor is left,
   * the recovery codes go too, and the tenant policy must allow it. Every
   * session ends; the caller starts a new one.
   */
  async removeOwnTotp(
    tenantId: string,
    userId: string,
    expectedVersion: number,
    meta: RequestMeta
  ): Promise<{ identity: LocalSessionIdentity; factorsLeft: boolean }> {
    return this.securityChange(tenantId, async (client, change) => {
      const identity = await lockIdentityForFactorChange(client, tenantId, userId);
      assertUsable(identity, expectedVersion);
      const removed = await client.query(
        `DELETE FROM user_totp_factors WHERE tenant_id = $1 AND user_id = $2 AND confirmed_at IS NOT NULL`,
        [tenantId, userId]
      );
      if (removed.rowCount !== 1) throw new LocalAccountError("no_second_factor");
      const factorsLeft = await settleFactorRemoval(client, tenantId, userId, identity);
      const securityVersion = await bumpSecurityVersion(change, userId, identity.security_version);
      await AuditEventStore.createInTransaction(client, auditInput(tenantId, userId, "auth.mfa_removed", { by: "self", method: "totp" }, meta));
      await this.deps.notices?.queue(client, tenantId, userId, { kind: "factor_removed", method: "totp" });
      return { identity: sessionIdentity(tenantId, userId, identity, securityVersion), factorsLeft };
    });
  }

  /**
   * A manager removes a member's second factors (lost phone, no codes). Every
   * session ends, and the member must enrol a new factor at the next sign-in.
   * Rights as for every manager action (member-authority.ts).
   */
  async resetMemberFactors(tenantId: string, targetUserId: string, actor: ManagerActor, meta: RequestMeta): Promise<void> {
    const actorUserId = actorIdOf(actor);
    await this.securityChange(tenantId, async (client, change) => {
      const identity = await lockTargetForManager(client, tenantId, targetUserId, actor);
      if (identity.status === "removed") throw new LocalAccountError("account_state_conflict");
      const removed = await deleteSecondFactors(client, tenantId, targetUserId);
      await client.query(
        `UPDATE local_identities SET mfa_enrollment_required = true WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, targetUserId]
      );
      await bumpSecurityVersion(change, targetUserId, identity.security_version);
      await AuditEventStore.createInTransaction(client, auditInput(tenantId, actorUserId, "tenant.member.mfa_reset", { targetUserId }, meta));
      if (removed > 0) await this.deps.notices?.queue(client, tenantId, targetUserId, { kind: "admin_factors_reset" });
    });
  }

  async getPolicy(tenantId: string): Promise<MfaPolicy> {
    return withTenantScope(this.deps.db, tenantId, async (client) => {
      const result = await client.query<{ mfa_policy: MfaPolicy }>(`SELECT mfa_policy FROM tenants WHERE tenant_id = $1`, [tenantId]);
      return result.rows[0]?.mfa_policy ?? "optional";
    });
  }

  /**
   * Changes the tenant's MFA policy. Any manager can make it stricter; only an
   * owner with step-up can make it weaker. The route checks the step-up
   * before the lock, so it says whether it did: when the policy changed in
   * between and the change is now weaker, it is refused (`policy_changed`).
   * A stricter policy ends every session of the members it now covers who
   * have no second factor yet, so they enrol at their next sign-in, and
   * after the commit their active work stops.
   */
  async setPolicy(
    tenantId: string,
    actor: ManagerActor,
    policy: MfaPolicy,
    meta: RequestMeta,
    proof: { stepUpVerified: boolean }
  ): Promise<{ previous: MfaPolicy }> {
    const actorUserId = actorIdOf(actor);
    return this.securityChange(tenantId, async (client, change) => {
      // The membership lock serialises every policy change. No row lock on
      // tenants: FOR UPDATE there would block the foreign-key checks of
      // enrolments that hold an identity this change must update (deadlock).
      await lockTenantMembership(client, tenantId);
      const tenant = await client.query<{ mfa_policy: MfaPolicy; login_type: string }>(
        `SELECT mfa_policy, login_type FROM tenants WHERE tenant_id = $1`,
        [tenantId]
      );
      const row = tenant.rows[0];
      if (!row || row.login_type !== "local") throw new LocalAccountError("wrong_login_type");
      const actorRole = await currentRole(client, tenantId, actor);
      if (!isManager(actorRole)) throw new LocalAccountError("not_a_manager");
      const previous = row.mfa_policy;
      if (POLICY_RANK[policy] < POLICY_RANK[previous]) {
        if (actorRole !== "owner") throw new LocalAccountError("only_owner_can_weaken_policy");
        if (!proof.stepUpVerified) throw new LocalAccountError("policy_changed");
      }
      if (policy === previous) return { previous };

      await client.query(`UPDATE tenants SET mfa_policy = $2, updated_at = now() WHERE tenant_id = $1`, [tenantId, policy]);
      if (POLICY_RANK[policy] > POLICY_RANK[previous]) {
        const covered = await client.query<{ user_id: string }>(
          `
            UPDATE local_identities li
            SET security_version = li.security_version + 1, updated_at = now()
            FROM tenant_memberships tm
            WHERE li.tenant_id = $1 AND tm.tenant_id = li.tenant_id AND tm.user_id = li.user_id
              AND li.status = 'active'
              AND ($2 = 'required_for_all' OR tm.role IN ('owner', 'admin'))
              AND NOT ${HAS_SECOND_FACTOR_SQL}
            RETURNING li.user_id
          `,
          [tenantId, policy]
        );
        for (const row of covered.rows) change.endActiveWork(row.user_id);
      }
      await AuditEventStore.createInTransaction(client, auditInput(tenantId, actorUserId, "tenant.security_policy.changed", {
        mfaPolicy: policy, previous
      }, meta));
      return { previous };
    });
  }

  /**
   * For the role route, inside its transaction after the identity lock: a
   * promotion into the group the policy covers ends the member's sessions when
   * the member has no second factor, so the next sign-in enrols one. After
   * the commit, the member's active work stops.
   */
  static async applyPolicyToRoleChange(
    change: SecurityChange,
    userId: string,
    previousRole: TenantMembershipRole,
    nextRole: TenantMembershipRole
  ): Promise<void> {
    const { client, tenantId } = change;
    const policy = await client.query<{ mfa_policy: string }>(`SELECT mfa_policy FROM tenants WHERE tenant_id = $1`, [tenantId]);
    const mfaPolicy = policy.rows[0]?.mfa_policy ?? "optional";
    if (policyRequiresMfa(mfaPolicy, previousRole) || !policyRequiresMfa(mfaPolicy, nextRole)) return;
    if (hasAnyFactor(await readFactorState(client, tenantId, userId))) return;
    const bumped = await client.query(
      `UPDATE local_identities SET security_version = security_version + 1, updated_at = now() WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId]
    );
    if (bumped.rowCount) change.endActiveWork(userId);
  }
}
