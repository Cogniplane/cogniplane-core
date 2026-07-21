import type { ModelProvider } from "@cogniplane/shared-types";

import { type Pool, withTenantScope } from "../lib/db.js";
import { isoTimestamp } from "../lib/db-mappers.js";
import type { AvailableModel } from "../domain/models.js";

/**
 * Admin-added models extending the built-in catalog per tenant
 * (tenant_custom_models). The catalog id is "<provider>/<vendorModelId>" —
 * the namespace IS the provider, which lets the Deep Agents graph resolve the
 * construction facts for a custom id without a DB lookup (see
 * resolveModelConstruction).
 */
export type CustomModelRecord = {
  modelId: string;
  provider: ModelProvider;
  vendorModelId: string;
  displayName: string;
  description: string;
  contextWindow: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CustomModelInput = {
  provider: ModelProvider;
  vendorModelId: string;
  displayName: string;
  description: string;
  contextWindow: number;
  createdBy: string | null;
};

export function customModelId(provider: ModelProvider, vendorModelId: string): string {
  return `${provider}/${vendorModelId}`;
}

/** Custom models never advertise reasoning efforts (no per-provider wiring). */
export function toAvailableModel(record: CustomModelRecord): AvailableModel {
  return {
    id: record.modelId,
    displayName: record.displayName,
    description: record.description,
    isDefault: false,
    provider: record.provider,
    supportedEfforts: [],
    defaultEffort: null,
    contextWindow: record.contextWindow
  };
}

function mapRow(row: Record<string, unknown>): CustomModelRecord {
  return {
    modelId: String(row.model_id),
    provider: String(row.provider) as ModelProvider,
    vendorModelId: String(row.vendor_model_id),
    displayName: String(row.display_name),
    description: row.description ? String(row.description) : "",
    contextWindow: Number(row.context_window),
    createdBy: row.created_by ? String(row.created_by) : null,
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at)
  };
}

export class CustomModelStore {
  constructor(private readonly db: Pool) {}

  async list(tenantId: string): Promise<CustomModelRecord[]> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM tenant_custom_models WHERE tenant_id = $1 ORDER BY model_id ASC`,
        [tenantId]
      );
      return result.rows.map(mapRow);
    });
  }

  /** Returns null when the model id already exists for the tenant. */
  async create(tenantId: string, input: CustomModelInput): Promise<CustomModelRecord | null> {
    const modelId = customModelId(input.provider, input.vendorModelId);
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO tenant_custom_models (
           tenant_id, model_id, provider, vendor_model_id,
           display_name, description, context_window, created_by
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id, model_id) DO NOTHING
         RETURNING *`,
        [
          tenantId,
          modelId,
          input.provider,
          input.vendorModelId,
          input.displayName,
          input.description,
          input.contextWindow,
          input.createdBy
        ]
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    });
  }

  async delete(tenantId: string, modelId: string): Promise<boolean> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `DELETE FROM tenant_custom_models WHERE tenant_id = $1 AND model_id = $2`,
        [tenantId, modelId]
      );
      return (result.rowCount ?? 0) > 0;
    });
  }
}
