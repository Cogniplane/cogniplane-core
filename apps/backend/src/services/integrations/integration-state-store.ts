import { withTenantScope, type Pool } from "../../lib/db.js";
import { isoTimestamp } from "../../lib/db-mappers.js";
import { AuditEventStore, type AuditEventInput } from "../audit-event-store.js";

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

  /**
   * Writes the patch. The audit event, when given, commits in the same
   * transaction as the change, with its owner notice (AuditEventInput).
   */
  async upsert(
    tenantId: string,
    integrationId: string,
    patch: IntegrationStatePatch,
    audit?: (saved: IntegrationStateRecord) => AuditEventInput
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
      const saved = toRecord(result.rows[0]);
      if (audit) await AuditEventStore.createInTransaction(client, audit(saved));
      return saved;
    });
  }

  /**
   * Writes only what the save changes, onto the row as it is now: the row is
   * locked (`FOR UPDATE`) in the transaction, an omitted toggle keeps its
   * value, and the settings keys in `configChanges` replace only those keys.
   * A save read from an older copy can therefore not write back an older
   * toggle or secret (an admin route classifies the save against that copy,
   * docs/ARCHITECTURE.md, "Data routes"). The audit event, when given,
   * commits in the same transaction, with its owner notice.
   */
  async applyChanges(
    tenantId: string,
    integrationId: string,
    changes: {
      readsEnabled?: boolean;
      writesEnabled?: boolean;
      /** Settings keys to set; values are already encrypted where the field is a secret. */
      configChanges: Record<string, unknown>;
      updatedBy: string;
    },
    audit?: (saved: IntegrationStateRecord) => AuditEventInput
  ): Promise<IntegrationStateRecord> {
    return withTenantScope(this.db, tenantId, async (client) => {
      // A first save makes the row, so that the lock below always has one.
      await client.query(
        `INSERT INTO tenant_integrations (tenant_id, integration_id, reads_enabled, writes_enabled, config_json)
         VALUES ($1, $2, FALSE, FALSE, '{}'::jsonb)
         ON CONFLICT (tenant_id, integration_id) DO NOTHING`,
        [tenantId, integrationId]
      );
      const locked = await client.query(
        `SELECT * FROM tenant_integrations WHERE tenant_id = $1 AND integration_id = $2 FOR UPDATE`,
        [tenantId, integrationId]
      );
      const current = toRecord(locked.rows[0]);
      const result = await client.query(
        `UPDATE tenant_integrations
         SET reads_enabled = $3, writes_enabled = $4, config_json = $5::jsonb, updated_by = $6, updated_at = NOW()
         WHERE tenant_id = $1 AND integration_id = $2
         RETURNING *`,
        [
          tenantId,
          integrationId,
          changes.readsEnabled ?? current.readsEnabled,
          changes.writesEnabled ?? current.writesEnabled,
          JSON.stringify({ ...current.config, ...changes.configChanges }),
          changes.updatedBy
        ]
      );
      const saved = toRecord(result.rows[0]);
      if (audit) await AuditEventStore.createInTransaction(client, audit(saved));
      return saved;
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
