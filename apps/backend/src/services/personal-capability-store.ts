import { SessionCapabilitySelectionSchema, type SessionCapabilitiesUpdate, type SessionCapabilitySelection } from "@cogniplane/shared-types";
import { type Pool, withTenantScope } from "../lib/db.js";
import { AuditEventStore } from "./audit-event-store.js";
import { hasUnavailableAdditions } from "./capability-selection.js";

export class PersonalCapabilityAccessError extends Error {
  constructor() { super("Your organization membership is no longer available."); }
}

export class PersonalCapabilityStore {
  constructor(private readonly db: Pool) {}

  async get(tenantId: string, userId: string): Promise<SessionCapabilitiesUpdate> {
    return withTenantScope(this.db, tenantId, async client => {
      const result = await client.query(
        `SELECT d.capability_selection, COALESCE(d.capability_version, 0) AS capability_version
         FROM tenant_memberships m LEFT JOIN personal_capability_defaults d
           ON d.tenant_id=m.tenant_id AND d.user_id=m.user_id
         WHERE m.tenant_id=$1 AND m.user_id=$2`, [tenantId, userId]
      );
      if (!result.rows[0]) throw new PersonalCapabilityAccessError();
      return {
        selection: SessionCapabilitySelectionSchema.nullable().parse(result.rows[0].capability_selection),
        version: Number(result.rows[0].capability_version)
      };
    });
  }

  async save(tenantId: string, userId: string, input: SessionCapabilitiesUpdate,
    available: SessionCapabilitySelection): Promise<SessionCapabilitiesUpdate | null> {
    return withTenantScope(this.db, tenantId, async client => {
      const member = await client.query(
        "SELECT 1 FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2 FOR KEY SHARE", [tenantId, userId]
      );
      if (!member.rowCount) throw new PersonalCapabilityAccessError();
      // Also serialize the first save, when no defaults row exists yet.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [JSON.stringify(["personal-capabilities", tenantId, userId])]);
      const result = await client.query(
        "SELECT capability_selection, capability_version FROM personal_capability_defaults WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE",
        [tenantId, userId]
      );
      const row = result.rows[0];
      if (Number(row?.capability_version ?? 0) !== input.version) return null;
      const selection = SessionCapabilitySelectionSchema.nullable().parse(row?.capability_selection ?? null);
      if (hasUnavailableAdditions(input.selection, selection, available)) return null;
      const saved = { selection: input.selection, version: input.version + 1 };
      await client.query(
        `INSERT INTO personal_capability_defaults (tenant_id,user_id,capability_selection,capability_version)
         VALUES ($1,$2,$3::jsonb,$4)
         ON CONFLICT (tenant_id,user_id) DO UPDATE SET capability_selection=EXCLUDED.capability_selection,
           capability_version=EXCLUDED.capability_version, updated_at=now()`,
        [tenantId, userId, saved.selection === null ? null : JSON.stringify(saved.selection), saved.version]
      );
      await AuditEventStore.createInTransaction(client, {
        tenantId, userId, sessionId: null, type: "personal_capabilities_changed", payload: saved
      });
      return saved;
    });
  }
}
