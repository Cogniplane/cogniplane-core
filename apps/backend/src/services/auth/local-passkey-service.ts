import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse
} from "@simplewebauthn/server";
import type { PoolClient } from "pg";

import { type Pool, withTenantScope } from "../../lib/db.js";
import { AuditEventStore } from "../audit-event-store.js";
import type { SecurityNoticeQueue } from "../mail/mail-outbox.js";
import {
  auditInput,
  bumpSecurityVersion,
  LocalAccountError,
  type LocalSessionIdentity,
  lockIdentity,
  type RequestMeta
} from "./local-account-service.js";
import {
  assertUsable,
  hasAnyFactor,
  lockIdentityForFactorChange,
  type BeforeCommit,
  readFactorState,
  replaceRecoveryCodes,
  sessionIdentity,
  settleFactorRemoval,
  spendRecoveryCode
} from "./local-mfa-service.js";
import { type AfterSecurityChange, type SecurityChange, withSecurityChange } from "./security-change.js";

// Passkeys (WebAuthn credentials) of local accounts: passwordless sign-in, a
// second factor after the password, and step-up. The browser ceremony runs
// on the frontend origin; every response is checked here against that exact
// origin, the configured RP id, the challenge of a single-use record
// (passkey-challenge-store.ts), and user verification. A passkey with user
// verification is itself two factors (the device and its PIN or biometric).
// See docs/architecture/local-accounts.md.
//
// Changes that the tenant policy depends on (a new factor, a removed one)
// take the tenant lock, then the identity, like every other factor change.

export const MAX_PASSKEYS_PER_ACCOUNT = 10;

export type PasskeySummary = {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  backedUp: boolean;
};

type PasskeyRow = {
  credential_id: string;
  user_id: string;
  public_key: Buffer;
  counter: string;
  transports: string[];
  name: string;
  backed_up: boolean;
  created_at: Date;
  last_used_at: Date | null;
};

function summary(row: Pick<PasskeyRow, "credential_id" | "name" | "created_at" | "last_used_at" | "backed_up">): PasskeySummary {
  return {
    id: row.credential_id,
    name: row.name,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    backedUp: row.backed_up
  };
}

/** The WebAuthn user handle: the user id's UTF-8 bytes. It holds no personal data. */
export function userHandleOf(userId: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(userId, "utf8"));
}

const NOT_ACCEPTED = () => new LocalAccountError("passkey_not_accepted");

export class LocalPasskeyService {
  constructor(
    private readonly deps: {
      /** app_user pool. */
      db: Pool;
      /** Maintenance pool: only the lookup by credential id, before the tenant is known. */
      lookupDb: Pool;
      /** DATA_ENCRYPTION_SECRET, for recovery codes. */
      secret: string;
      rpId: string;
      rpName: string;
      /** The exact frontend origin (API_ORIGIN). */
      origin: string;
      /** Security notices by email; absent when email is off. */
      notices?: SecurityNoticeQueue | null;
      /** After the commit of a new security version: stops the account's active work. */
      afterSecurityChange: AfterSecurityChange;
    }
  ) {}

  /** A transaction that can increment security versions (security-change.ts). */
  private securityChange<T>(tenantId: string, fn: (client: PoolClient, change: SecurityChange) => Promise<T>): Promise<T> {
    return withSecurityChange(this.deps.db, tenantId, this.deps.afterSecurityChange, fn);
  }

  /** Options to add a passkey to this account. */
  async registrationOptions(tenantId: string, userId: string, expectedVersion: number): Promise<PublicKeyCredentialCreationOptionsJSON> {
    return withTenantScope(this.deps.db, tenantId, async (client) => {
      const identity = await lockIdentity(client, tenantId, userId);
      assertUsable(identity, expectedVersion);
      const existing = await client.query<{ credential_id: string; transports: string[] }>(
        `SELECT credential_id, transports FROM user_passkeys WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, userId]
      );
      if (existing.rowCount! >= MAX_PASSKEYS_PER_ACCOUNT) throw new LocalAccountError("passkey_limit");
      const email = identity.email ?? userId;
      return generateRegistrationOptions({
        rpName: this.deps.rpName,
        rpID: this.deps.rpId,
        userName: email,
        userID: userHandleOf(userId),
        userDisplayName: identity.display_name ?? email,
        attestationType: "none",
        // The same authenticator cannot hold two passkeys of one account.
        excludeCredentials: existing.rows.map((row) => ({ id: row.credential_id, transports: row.transports })),
        // Discoverable, so it also works without an email (passwordless).
        authenticatorSelection: { residentKey: "required", userVerification: "required" }
      });
    });
  }

  /**
   * Checks a registration and stores the passkey. A first second factor, or
   * an enrolment after a recovery code (which it spends), also replaces the recovery codes
   * (shown once), clears a manager's enrolment requirement, and increments
   * the security version: every older session ends, and the caller starts a
   * new one. Adding another passkey changes no session.
   */
  async register(input: {
    tenantId: string;
    userId: string;
    credential: RegistrationResponseJSON;
    expectedChallenge: string;
    expectedVersion: number;
    name: string | undefined;
    /** A sign-in recovery: the checked code, spent with this enrolment. */
    recoveryCodeHash?: string;
    /**
     * Work that must succeed before the commit, when the enrolment starts a
     * new session (a first factor or a recovery): the new session.
     */
    beforeCommit?: BeforeCommit;
    meta: RequestMeta;
  }): Promise<{ identity: LocalSessionIdentity; passkey: PasskeySummary; recoveryCodes: string[] | null }> {
    let verified;
    try {
      verified = await verifyRegistrationResponse({
        response: input.credential,
        expectedChallenge: input.expectedChallenge,
        expectedOrigin: this.deps.origin,
        expectedRPID: this.deps.rpId,
        requireUserVerification: true
      });
    } catch {
      throw NOT_ACCEPTED();
    }
    if (!verified.verified || !verified.registrationInfo.userVerified) throw NOT_ACCEPTED();
    const info = verified.registrationInfo;

    return this.securityChange(input.tenantId, async (client, change) => {
      const identity = await lockIdentityForFactorChange(client, input.tenantId, input.userId);
      assertUsable(identity, input.expectedVersion);
      const before = await readFactorState(client, input.tenantId, input.userId);
      if (before.passkeyCount >= MAX_PASSKEYS_PER_ACCOUNT) throw new LocalAccountError("passkey_limit");
      const firstFactor = !hasAnyFactor(before);

      const name = input.name?.trim() || `Passkey ${before.passkeyCount + 1}`;
      let inserted;
      try {
        inserted = await client.query<PasskeyRow>(
          `
            INSERT INTO user_passkeys
              (tenant_id, user_id, credential_id, public_key, counter, transports, name, aaguid, device_type, backed_up)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING credential_id, name, created_at, last_used_at, backed_up
          `,
          [
            input.tenantId, input.userId, info.credential.id, Buffer.from(info.credential.publicKey), info.credential.counter,
            info.credential.transports ?? [], name, info.aaguid, info.credentialDeviceType, info.credentialBackedUp
          ]
        );
      } catch (error) {
        if ((error as { code?: string }).code === "23505") throw new LocalAccountError("passkey_exists");
        throw error;
      }

      if (input.recoveryCodeHash) await spendRecoveryCode(client, input.tenantId, input.userId, input.recoveryCodeHash, input.meta);
      let recoveryCodes: string[] | null = null;
      let securityVersion = identity.security_version;
      if (firstFactor || input.recoveryCodeHash) {
        recoveryCodes = await replaceRecoveryCodes(client, input.tenantId, input.userId, this.deps.secret);
        await client.query(
          `UPDATE local_identities SET mfa_enrollment_required = false WHERE tenant_id = $1 AND user_id = $2`,
          [input.tenantId, input.userId]
        );
        securityVersion = await bumpSecurityVersion(change, input.userId, identity.security_version);
      }
      await AuditEventStore.createInTransaction(client, auditInput(input.tenantId, input.userId, "auth.passkey_added", {
        firstFactor, backedUp: info.credentialBackedUp
      }, input.meta));
      await this.deps.notices?.queue(client, input.tenantId, input.userId, { kind: "factor_added", method: "passkey" });
      const result = {
        identity: sessionIdentity(input.tenantId, input.userId, identity, securityVersion),
        passkey: summary(inserted.rows[0]!),
        recoveryCodes
      };
      if (recoveryCodes) await input.beforeCommit?.(result.identity);
      return result;
    });
  }

  /**
   * Options for a sign-in or a step-up. With a known account, only its
   * passkeys are allowed; without one (passwordless), the browser offers the
   * discoverable passkeys it has for this site.
   */
  async authenticationOptions(account?: { tenantId: string; userId: string }): Promise<PublicKeyCredentialRequestOptionsJSON> {
    let allowCredentials: { id: string; transports?: string[] }[] | undefined;
    if (account) {
      const rows = await withTenantScope(this.deps.db, account.tenantId, async (client) =>
        (await client.query<{ credential_id: string; transports: string[] }>(
          `SELECT credential_id, transports FROM user_passkeys WHERE tenant_id = $1 AND user_id = $2`,
          [account.tenantId, account.userId]
        )).rows
      );
      if (rows.length === 0) throw new LocalAccountError("no_second_factor");
      allowCredentials = rows.map((row) => ({ id: row.credential_id, transports: row.transports }));
    }
    return generateAuthenticationOptions({ rpID: this.deps.rpId, allowCredentials, userVerification: "required" });
  }

  /**
   * Checks an assertion and spends it: the signature counter must move
   * forward (a counter of 0 is a synced passkey and is accepted). With
   * `expected`, the passkey must belong to that account at that version
   * (second factor, step-up). Without it (passwordless), the account comes
   * from the credential id, and the user handle that the authenticator
   * returns must match it. Every failure is `passkey_not_accepted`.
   */
  async verifyAssertion(input: {
    credential: AuthenticationResponseJSON;
    expectedChallenge: string;
    expected?: { tenantId: string; userId: string; securityVersion: number };
    meta: RequestMeta;
  }): Promise<LocalSessionIdentity> {
    const credentialId = input.credential.id;
    let owner = input.expected ? { tenant_id: input.expected.tenantId, user_id: input.expected.userId } : undefined;
    if (!owner) {
      const found = await this.deps.lookupDb.query<{ tenant_id: string; user_id: string }>(
        `SELECT tenant_id, user_id FROM user_passkeys WHERE credential_id = $1`,
        [credentialId]
      );
      owner = found.rows[0];
      if (!owner) throw NOT_ACCEPTED();
      const handle = input.credential.response.userHandle;
      if (!handle || handle !== Buffer.from(userHandleOf(owner.user_id)).toString("base64url")) throw NOT_ACCEPTED();
    }
    const { tenant_id: tenantId, user_id: userId } = owner;

    return withTenantScope(this.deps.db, tenantId, async (client) => {
      const identity = await lockIdentity(client, tenantId, userId);
      try {
        assertUsable(identity, input.expected?.securityVersion);
      } catch (error) {
        // A flow or session from an older version must start again; a
        // passwordless sign-in gives an inactive account no other answer.
        if (input.expected) throw error;
        throw NOT_ACCEPTED();
      }
      const row = await this.lockedPasskey(client, tenantId, userId, credentialId);
      if (!row) throw NOT_ACCEPTED();

      let verified;
      try {
        verified = await verifyAuthenticationResponse({
          response: input.credential,
          expectedChallenge: input.expectedChallenge,
          expectedOrigin: this.deps.origin,
          expectedRPID: this.deps.rpId,
          credential: {
            id: row.credential_id,
            publicKey: new Uint8Array(row.public_key),
            counter: Number(row.counter),
            transports: row.transports as never
          },
          requireUserVerification: true
        });
      } catch {
        throw NOT_ACCEPTED();
      }
      if (!verified.verified || !verified.authenticationInfo.userVerified) throw NOT_ACCEPTED();

      await client.query(
        `
          UPDATE user_passkeys SET counter = $4, backed_up = $5, last_used_at = now()
          WHERE tenant_id = $1 AND user_id = $2 AND credential_id = $3
        `,
        [tenantId, userId, credentialId, verified.authenticationInfo.newCounter, verified.authenticationInfo.credentialBackedUp]
      );
      if (!input.expected) {
        await AuditEventStore.createInTransaction(client, auditInput(tenantId, userId, "auth.login_succeeded", { amr: ["pkey"] }, input.meta));
      }
      return sessionIdentity(tenantId, userId, identity, identity.security_version);
    });
  }

  private async lockedPasskey(client: PoolClient, tenantId: string, userId: string, credentialId: string): Promise<PasskeyRow | null> {
    const result = await client.query<PasskeyRow>(
      `
        SELECT credential_id, user_id, public_key, counter, transports, name, backed_up, created_at, last_used_at
        FROM user_passkeys WHERE tenant_id = $1 AND user_id = $2 AND credential_id = $3
        FOR UPDATE
      `,
      [tenantId, userId, credentialId]
    );
    return result.rows[0] ?? null;
  }

  async list(tenantId: string, userId: string): Promise<PasskeySummary[]> {
    return withTenantScope(this.deps.db, tenantId, async (client) => {
      const result = await client.query<PasskeyRow>(
        `
          SELECT credential_id, name, created_at, last_used_at, backed_up FROM user_passkeys
          WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at
        `,
        [tenantId, userId]
      );
      return result.rows.map(summary);
    });
  }

  async rename(tenantId: string, userId: string, credentialId: string, name: string): Promise<PasskeySummary> {
    return withTenantScope(this.deps.db, tenantId, async (client) => {
      const result = await client.query<PasskeyRow>(
        `
          UPDATE user_passkeys SET name = $4 WHERE tenant_id = $1 AND user_id = $2 AND credential_id = $3
          RETURNING credential_id, name, created_at, last_used_at, backed_up
        `,
        [tenantId, userId, credentialId, name.trim()]
      );
      if (!result.rows[0]) throw new LocalAccountError("passkey_not_found");
      return summary(result.rows[0]);
    });
  }

  /**
   * Removes one of the user's passkeys. With no factor left, the recovery
   * codes go too, and the tenant policy must allow it. Every session ends;
   * the caller starts a new one.
   */
  async remove(
    tenantId: string,
    userId: string,
    credentialId: string,
    expectedVersion: number,
    meta: RequestMeta
  ): Promise<{ identity: LocalSessionIdentity; factorsLeft: boolean }> {
    return this.securityChange(tenantId, async (client, change) => {
      const identity = await lockIdentityForFactorChange(client, tenantId, userId);
      assertUsable(identity, expectedVersion);
      const removed = await client.query(
        `DELETE FROM user_passkeys WHERE tenant_id = $1 AND user_id = $2 AND credential_id = $3`,
        [tenantId, userId, credentialId]
      );
      if (removed.rowCount !== 1) throw new LocalAccountError("passkey_not_found");
      const factorsLeft = await settleFactorRemoval(client, tenantId, userId, identity);
      const securityVersion = await bumpSecurityVersion(change, userId, identity.security_version);
      await AuditEventStore.createInTransaction(client, auditInput(tenantId, userId, "auth.passkey_removed", {}, meta));
      await this.deps.notices?.queue(client, tenantId, userId, { kind: "factor_removed", method: "passkey" });
      return { identity: sessionIdentity(tenantId, userId, identity, securityVersion), factorsLeft };
    });
  }
}
