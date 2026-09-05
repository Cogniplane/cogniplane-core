import type { ModelProvider, PiiProtectionSettings } from "@cogniplane/shared-types";
import { DEFAULT_PII_PROTECTION, MODEL_PROVIDERS } from "@cogniplane/shared-types";

import { type Pool, withTenantScope } from "../lib/db.js";
import { decrypt, encrypt } from "../lib/crypto-utils.js";

import { parsePiiProtection } from "./pii/pii-policy.js";

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
  piiProtection: PiiProtectionSettings;
  updatedAt: string;
};

type Row = {
  tenant_id: string;
  anthropic_api_key_encrypted: string | null;
  openai_api_key_encrypted: string | null;
  google_api_key_encrypted: string | null;
  openrouter_api_key_encrypted: string | null;
  zai_api_key_encrypted: string | null;
  skill_marketplace_manifest_url: string | null;
  pii_protection: unknown;
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
    piiProtection: row.pii_protection == null
      ? DEFAULT_PII_PROTECTION
      : parsePiiProtection(row.pii_protection),
    updatedAt: new Date(row.updated_at as string).toISOString()
  };
}

const EMPTY_RECORD = (tenantId: string): TenantOrgSettingsRecord => ({
  tenantId,
  providerKeys: emptyProviderKeys(),
  skillMarketplaceManifestUrl: null,
  piiProtection: DEFAULT_PII_PROTECTION,
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
                skill_marketplace_manifest_url, pii_protection, updated_at
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
  async setApiKey(tenantId: string, provider: ModelProvider, apiKey: string | null): Promise<void> {
    const column = PROVIDER_KEY_COLUMNS[provider];
    await this.upsert(
      tenantId,
      [`${column} = $2`],
      [tenantId, apiKey ? encrypt(apiKey, this.secret) : null]
    );
  }

  async setMarketplaceUrl(tenantId: string, url: string | null): Promise<void> {
    await this.upsert(tenantId, ["skill_marketplace_manifest_url = $2"], [tenantId, url]);
  }

  async setPiiProtection(tenantId: string, policy: PiiProtectionSettings): Promise<void> {
    await this.upsert(tenantId, ["pii_protection = $2::jsonb"], [tenantId, JSON.stringify(policy)]);
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
  private async upsert(tenantId: string, setExpressions: string[], values: unknown[]): Promise<void> {
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

    await withTenantScope(this.db, tenantId, (client) =>
      client.query(
        `INSERT INTO tenant_org_settings (${insertColumns.join(", ")})
         VALUES (${insertExpressions.join(", ")})
         ON CONFLICT (tenant_id) DO UPDATE SET ${setClause}`,
        values
      )
    );
  }
}
