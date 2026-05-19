import { type Pool, withTenantScope } from "../lib/db.js";
import { decrypt, encrypt } from "../lib/crypto-utils.js";

import {
  DEFAULT_PII_PROTECTION,
  parsePiiProtection,
  type PiiProtectionSettings
} from "./pii/pii-policy.js";

export type TenantOrgSettingsRecord = {
  tenantId: string;
  hasOpenaiApiKey: boolean;
  hasAnthropicApiKey: boolean;
  skillMarketplaceManifestUrl: string | null;
  piiProtection: PiiProtectionSettings;
  updatedAt: string;
};

type Row = {
  tenant_id: string;
  openai_api_key_encrypted: string | null;
  anthropic_api_key_encrypted: string | null;
  skill_marketplace_manifest_url: string | null;
  pii_protection: unknown;
  updated_at: string | Date;
};

function mapRow(row: Row): TenantOrgSettingsRecord {
  return {
    tenantId: row.tenant_id,
    hasOpenaiApiKey: Boolean(row.openai_api_key_encrypted),
    hasAnthropicApiKey: Boolean(row.anthropic_api_key_encrypted),
    skillMarketplaceManifestUrl: row.skill_marketplace_manifest_url,
    piiProtection: row.pii_protection == null
      ? DEFAULT_PII_PROTECTION
      : parsePiiProtection(row.pii_protection),
    updatedAt: new Date(row.updated_at as string).toISOString()
  };
}

const EMPTY_RECORD = (tenantId: string): TenantOrgSettingsRecord => ({
  tenantId,
  hasOpenaiApiKey: false,
  hasAnthropicApiKey: false,
  skillMarketplaceManifestUrl: null,
  piiProtection: DEFAULT_PII_PROTECTION,
  updatedAt: new Date(0).toISOString()
});

export class TenantOrgSettingsStore {
  constructor(private readonly db: Pool, private readonly secret: string) {}

  async get(tenantId: string): Promise<TenantOrgSettingsRecord> {
    const result = await withTenantScope(this.db, tenantId, (client) =>
      client.query<Row>(
        `SELECT tenant_id, openai_api_key_encrypted, anthropic_api_key_encrypted,
                skill_marketplace_manifest_url, pii_protection, updated_at
         FROM tenant_org_settings WHERE tenant_id = $1 LIMIT 1`,
        [tenantId]
      )
    );
    return result.rows[0] ? mapRow(result.rows[0]) : EMPTY_RECORD(tenantId);
  }

  async getDecryptedOpenaiApiKey(tenantId: string): Promise<string | null> {
    const encrypted = await this.readEncryptedKey(tenantId, "openai_api_key_encrypted");
    return encrypted ? decrypt(encrypted, this.secret) : null;
  }

  async getDecryptedAnthropicApiKey(tenantId: string): Promise<string | null> {
    const encrypted = await this.readEncryptedKey(tenantId, "anthropic_api_key_encrypted");
    return encrypted ? decrypt(encrypted, this.secret) : null;
  }

  async setApiKeys(
    tenantId: string,
    input: { openaiApiKey?: string | null; anthropicApiKey?: string | null }
  ): Promise<void> {
    const updates: string[] = [];
    const values: unknown[] = [tenantId];
    if (input.openaiApiKey !== undefined) {
      updates.push(`openai_api_key_encrypted = $${values.length + 1}`);
      values.push(input.openaiApiKey ? encrypt(input.openaiApiKey, this.secret) : null);
    }
    if (input.anthropicApiKey !== undefined) {
      updates.push(`anthropic_api_key_encrypted = $${values.length + 1}`);
      values.push(input.anthropicApiKey ? encrypt(input.anthropicApiKey, this.secret) : null);
    }
    if (updates.length === 0) return;
    await this.upsert(tenantId, updates, values);
  }

  async setMarketplaceUrl(tenantId: string, url: string | null): Promise<void> {
    await this.upsert(tenantId, ["skill_marketplace_manifest_url = $2"], [tenantId, url]);
  }

  async setPiiProtection(tenantId: string, policy: PiiProtectionSettings): Promise<void> {
    await this.upsert(tenantId, ["pii_protection = $2::jsonb"], [tenantId, JSON.stringify(policy)]);
  }

  private async readEncryptedKey(
    tenantId: string,
    column: "openai_api_key_encrypted" | "anthropic_api_key_encrypted"
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
