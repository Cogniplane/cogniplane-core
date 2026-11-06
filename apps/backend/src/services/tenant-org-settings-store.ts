import type { ModelProvider, PiiProtectionSettings } from "@cogniplane/shared-types";
import { MODEL_PROVIDERS } from "@cogniplane/shared-types";

import { type Pool, withTenantScope } from "../lib/db.js";
import { decrypt, encrypt } from "../lib/crypto-utils.js";

import { AuditEventStore, type AuditEventInput } from "./audit-event-store.js";
import { mergeStoredPiiScopes } from "./pii/pii-policy.js";
import { WeakerChangeError } from "./weaker-change-error.js";

/** Public provider id → its encrypted-key column on tenant_org_settings. */
const PROVIDER_KEY_COLUMNS = {
  anthropic: "anthropic_api_key_encrypted",
  openai: "openai_api_key_encrypted",
  google: "google_api_key_encrypted",
  openrouter: "openrouter_api_key_encrypted",
  zai: "zai_api_key_encrypted"
} as const satisfies Record<ModelProvider, string>;

type ProviderKeyColumn = (typeof PROVIDER_KEY_COLUMNS)[ModelProvider];

export type TenantOrgSettingsRecord = {
  tenantId: string;
  /** Per-provider key-presence map (never the keys themselves). */
  providerKeys: Record<ModelProvider, boolean>;
  skillMarketplaceManifestUrl: string | null;
  /**
   * The stored PII policy as stored, not checked; null when none. Read it with
   * `resolvePiiPolicy`, which needs the app's import scope registry.
   */
  storedPiiProtection: unknown;
  /** Adds 1 on each PII save. 0 when the tenant never saved PII settings. */
  piiProtectionRevision: number;
  updatedAt: string;
};

/** The stored policy and its new revision after a PII save. */
export type PiiProtectionSaveResult = {
  stored: PiiProtectionSettings;
  revision: number;
};

/**
 * A PII save named a revision that is not the stored revision. Another save
 * changed the settings after this save's form loaded them.
 */
export class PiiSettingsConflictError extends Error {
  constructor() {
    super("The PII settings changed after this save loaded them.");
    this.name = "PiiSettingsConflictError";
  }
}

type Row = {
  tenant_id: string;
  anthropic_api_key_encrypted: string | null;
  openai_api_key_encrypted: string | null;
  google_api_key_encrypted: string | null;
  openrouter_api_key_encrypted: string | null;
  zai_api_key_encrypted: string | null;
  skill_marketplace_manifest_url: string | null;
  pii_protection: unknown;
  pii_protection_revision: number;
  updated_at: string | Date;
};

function providerKeysFromRow(row: Row): Record<ModelProvider, boolean> {
  const map = {} as Record<ModelProvider, boolean>;
  for (const provider of MODEL_PROVIDERS) {
    map[provider] = Boolean(row[PROVIDER_KEY_COLUMNS[provider]]);
  }
  return map;
}

function emptyProviderKeys(): Record<ModelProvider, boolean> {
  const map = {} as Record<ModelProvider, boolean>;
  for (const provider of MODEL_PROVIDERS) map[provider] = false;
  return map;
}

function mapRow(row: Row): TenantOrgSettingsRecord {
  const providerKeys = providerKeysFromRow(row);
  return {
    tenantId: row.tenant_id,
    providerKeys,
    skillMarketplaceManifestUrl: row.skill_marketplace_manifest_url,
    storedPiiProtection: row.pii_protection ?? null,
    piiProtectionRevision: row.pii_protection_revision,
    updatedAt: new Date(row.updated_at as string).toISOString()
  };
}

const EMPTY_RECORD = (tenantId: string): TenantOrgSettingsRecord => ({
  tenantId,
  providerKeys: emptyProviderKeys(),
  skillMarketplaceManifestUrl: null,
  storedPiiProtection: null,
  piiProtectionRevision: 0,
  updatedAt: new Date(0).toISOString()
});

export class TenantOrgSettingsStore {
  constructor(private readonly db: Pool, private readonly secret: string) {}

  async get(tenantId: string): Promise<TenantOrgSettingsRecord> {
    const result = await withTenantScope(this.db, tenantId, (client) =>
      client.query<Row>(
        `SELECT tenant_id, anthropic_api_key_encrypted, openai_api_key_encrypted,
                google_api_key_encrypted, openrouter_api_key_encrypted,
                zai_api_key_encrypted,
                skill_marketplace_manifest_url, pii_protection,
                pii_protection_revision, updated_at
         FROM tenant_org_settings WHERE tenant_id = $1 LIMIT 1`,
        [tenantId]
      )
    );
    return result.rows[0] ? mapRow(result.rows[0]) : EMPTY_RECORD(tenantId);
  }

  /** Decrypted tenant key for a specific provider (null if unset). */
  async getDecryptedApiKey(tenantId: string, provider: ModelProvider): Promise<string | null> {
    const encrypted = await this.readEncryptedKey(tenantId, PROVIDER_KEY_COLUMNS[provider]);
    return encrypted ? decrypt(encrypted, this.secret) : null;
  }

  /** Set (or clear, when null) one provider's API key. */
  // Each setter takes an optional audit event, written in the same transaction
  // as the change, so a change never commits without its evidence.
  async setApiKey(
    tenantId: string,
    provider: ModelProvider,
    apiKey: string | null,
    audit?: AuditEventInput
  ): Promise<void> {
    const column = PROVIDER_KEY_COLUMNS[provider];
    await this.upsert(
      tenantId,
      [`${column} = $2`],
      [tenantId, apiKey ? encrypt(apiKey, this.secret) : null],
      audit
    );
  }

  async setMarketplaceUrl(tenantId: string, url: string | null, audit?: AuditEventInput): Promise<void> {
    await this.upsert(tenantId, ["skill_marketplace_manifest_url = $2"], [tenantId, url], audit);
  }

  /**
   * Stores an admin save and returns the stored policy and its new revision.
   * Scope keys that the save does not name keep their raw stored values
   * (`mergeStoredPiiScopes`). The read, the write, and the audit event share
   * one transaction, and the row lock stops a concurrent save from dropping a
   * key.
   *
   * The row is created first when it does not exist. Without this step, two
   * first saves can both read no row, and the second write replaces the
   * first with no merge. With it, the second insert waits for the first
   * transaction, and the locking read then sees the committed row.
   *
   * With `expectedRevision`, the save continues only when the locked row has
   * that revision. Otherwise it throws `PiiSettingsConflictError` and writes
   * nothing: no settings change and no audit event. A save that waits for
   * another save reads the row after that save commits, so of two saves with
   * the same revision, only the first one is stored.
   *
   * Compatibility path: without `expectedRevision`, the save replaces the
   * settings with no check (last write wins). Older frontends send no
   * revision. Remove this path when all clients and rollback versions send it.
   *
   * `weakerFields` classifies the save against the locked row, after the
   * revision check: it gets the stored policy as stored and the policy to
   * store, and returns the labels of the fields that the save makes weaker.
   * A weaker save throws WeakerChangeError and writes nothing, unless
   * `allowWeaker` (the caller has step-up, or needs none). The labels go to
   * `audit`, so the caller can attach the owner notice to the audit event.
   */
  async setPiiProtection(
    tenantId: string,
    policy: PiiProtectionSettings,
    options: {
      expectedRevision?: number;
      weakerFields: (stored: unknown, next: PiiProtectionSettings) => string[];
      allowWeaker: boolean;
      audit?: (stored: PiiProtectionSettings, revision: number, weakerFields: string[]) => AuditEventInput;
    }
  ): Promise<PiiProtectionSaveResult> {
    return withTenantScope(this.db, tenantId, async (client) => {
      await client.query(
        "INSERT INTO tenant_org_settings (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING",
        [tenantId]
      );
      const current = await client.query<{ pii_protection: unknown; pii_protection_revision: number }>(
        "SELECT pii_protection, pii_protection_revision FROM tenant_org_settings WHERE tenant_id = $1 FOR UPDATE",
        [tenantId]
      );
      // The insert above guarantees a row. No row here means a tenant-scope
      // fault, so stop with a clear error, not a TypeError after the update.
      if (current.rows.length === 0) {
        throw new Error(`tenant_org_settings row not visible for tenant ${tenantId}`);
      }
      const currentRevision = current.rows[0].pii_protection_revision;
      // The throw rolls back the transaction, including a row that the insert
      // above created.
      if (options.expectedRevision !== undefined && options.expectedRevision !== currentRevision) {
        throw new PiiSettingsConflictError();
      }
      const stored = mergeStoredPiiScopes(policy, current.rows[0].pii_protection);
      // The throw rolls back the transaction, like the revision check above.
      const weaker = options.weakerFields(current.rows[0].pii_protection, stored);
      if (weaker.length > 0 && !options.allowWeaker) throw new WeakerChangeError();
      const updated = await client.query<{ pii_protection_revision: number }>(
        `UPDATE tenant_org_settings
         SET pii_protection = $2::jsonb, pii_protection_revision = pii_protection_revision + 1, updated_at = NOW()
         WHERE tenant_id = $1
         RETURNING pii_protection_revision`,
        [tenantId, JSON.stringify(stored)]
      );
      const revision = updated.rows[0].pii_protection_revision;
      if (options.audit) await AuditEventStore.createInTransaction(client, options.audit(stored, revision, weaker));
      return { stored, revision };
    });
  }

  private async readEncryptedKey(
    tenantId: string,
    column: ProviderKeyColumn
  ): Promise<string | null> {
    const result = await withTenantScope(this.db, tenantId, (client) =>
      client.query<{ value: string | null }>(
        `SELECT ${column} AS value FROM tenant_org_settings WHERE tenant_id = $1 LIMIT 1`,
        [tenantId]
      )
    );
    return result.rows[0]?.value ?? null;
  }

  // Lazy upsert: row is created on first write so callers don't need a separate
  // INSERT step. The SET-list is built per call so each setter only touches the
  // columns it owns.
  private async upsert(
    tenantId: string,
    setExpressions: string[],
    values: unknown[],
    audit?: AuditEventInput
  ): Promise<void> {
    const setClause = [...setExpressions, "updated_at = NOW()"].join(", ");
    const insertColumns = ["tenant_id"];
    const insertExpressions = ["$1"];
    for (const expr of setExpressions) {
      const eqIndex = expr.indexOf(" = ");
      insertColumns.push(expr.slice(0, eqIndex));
      // Reuse the full RHS (including any "::jsonb" cast) so INSERT and UPDATE
      // bind the placeholder identically.
      insertExpressions.push(expr.slice(eqIndex + 3));
    }

    await withTenantScope(this.db, tenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_org_settings (${insertColumns.join(", ")})
         VALUES (${insertExpressions.join(", ")})
         ON CONFLICT (tenant_id) DO UPDATE SET ${setClause}`,
        values
      );
      if (audit) await AuditEventStore.createInTransaction(client, audit);
    });
  }
}
