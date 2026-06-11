import { withTenantScope, type Pool } from "../../lib/db.js";
import { isoTimestamp } from "../../lib/db-mappers.js";

export type IntegrationStateRecord = {
  tenantId: string;
  integrationId: string;
  readsEnabled: boolean;
  writesEnabled: boolean;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
};

export type IntegrationStatePatch = {
  readsEnabled?: boolean;
  writesEnabled?: boolean;
  config?: Record<string, unknown>;
  updatedBy?: string | null;
};

function toRecord(row: Record<string, unknown>): IntegrationStateRecord {
  const rawConfig = row.config_json;
  const config: Record<string, unknown> =
    rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig)
      ? (rawConfig as Record<string, unknown>)
      : {};

  return {
    tenantId: String(row.tenant_id),
    integrationId: String(row.integration_id),
    readsEnabled: Boolean(row.reads_enabled),
    writesEnabled: Boolean(row.writes_enabled),
    config,
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
    updatedBy: row.updated_by == null ? null : String(row.updated_by)
  };
}

export class IntegrationStateStore {
  constructor(private readonly db: Pool) {}

  async get(tenantId: string, integrationId: string): Promise<IntegrationStateRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM tenant_integrations
         WHERE tenant_id = $1 AND integration_id = $2
         LIMIT 1`,
        [tenantId, integrationId]
      );
      return result.rows[0] ? toRecord(result.rows[0]) : null;
    });
  }

  async list(tenantId: string): Promise<IntegrationStateRecord[]> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM tenant_integrations
         WHERE tenant_id = $1
         ORDER BY integration_id`,
        [tenantId]
      );
      return result.rows.map(toRecord);
    });
  }

  async upsert(
    tenantId: string,
    integrationId: string,
    patch: IntegrationStatePatch
  ): Promise<IntegrationStateRecord> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const existing = await client.query(
        `SELECT * FROM tenant_integrations
         WHERE tenant_id = $1 AND integration_id = $2
         LIMIT 1`,
        [tenantId, integrationId]
      );

      const previous = existing.rows[0] ? toRecord(existing.rows[0]) : null;
      const readsEnabled = patch.readsEnabled ?? previous?.readsEnabled ?? false;
      const writesEnabled = patch.writesEnabled ?? previous?.writesEnabled ?? false;
      const config = patch.config ?? previous?.config ?? {};
      const updatedBy = patch.updatedBy === undefined ? previous?.updatedBy ?? null : patch.updatedBy;

      const result = await client.query(
        `INSERT INTO tenant_integrations (
            tenant_id, integration_id, reads_enabled, writes_enabled,
            config_json, updated_by
          ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
          ON CONFLICT (tenant_id, integration_id)
          DO UPDATE SET
            reads_enabled = EXCLUDED.reads_enabled,
            writes_enabled = EXCLUDED.writes_enabled,
            config_json = EXCLUDED.config_json,
            updated_by = EXCLUDED.updated_by,
            updated_at = NOW()
          RETURNING *`,
        [tenantId, integrationId, readsEnabled, writesEnabled, JSON.stringify(config), updatedBy]
      );
      return toRecord(result.rows[0]);
    });
  }

  async clearConfig(
    tenantId: string,
    integrationId: string,
    updatedBy: string | null
  ): Promise<IntegrationStateRecord> {
    return this.upsert(tenantId, integrationId, {
      readsEnabled: false,
      writesEnabled: false,
      config: {},
      updatedBy
    });
  }
}
