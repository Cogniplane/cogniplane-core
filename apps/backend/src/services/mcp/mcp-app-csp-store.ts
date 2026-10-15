import type { AdminMcpWidgetDomains, CspDeclarationEntry, McpAppCspDirective } from "@cogniplane/shared-types";

import { type Pool, withTenantScope } from "../../lib/db.js";
import { AdminConfigError } from "../admin-config-error.js";
import { AuditEventStore, type AuditEventInput } from "../audit-event-store.js";

/** The most approved sources for one server. */
export const MAX_APPROVED_SOURCES_PER_SERVER = 200;
// A server can declare any source, so the list of what it asked for has a limit.
// The limit is checked once for each statement, so one batch can pass it.
const MAX_REQUESTED_SOURCES_PER_SERVER = 200;
// A widget that opens often does not write on every open.
const REQUEST_TOUCH_INTERVAL = "1 hour";

type ApprovalRow = { directive: McpAppCspDirective; source: string; approved_by: string; approved_at: Date | string };
type RequestRow = { directive: McpAppCspDirective; source: string; first_seen_at: Date | string; last_seen_at: Date | string };

/**
 * The content security policy sources that administrators approved for MCP app
 * widgets, and the sources that widgets asked for. Both are per tenant and per
 * server. Every method runs in the tenant's scope.
 */
export class McpAppCspStore {
  constructor(private readonly db: Pool) {}

  async listApproved(tenantId: string, serverId: string): Promise<CspDeclarationEntry[]> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query<Pick<ApprovalRow, "directive" | "source">>(
        `SELECT directive, source FROM admin_mcp_app_csp_approvals
         WHERE tenant_id = $1 AND server_id = $2
         ORDER BY directive, source`,
        [tenantId, serverId]
      );
      return result.rows.map((row) => ({ directive: row.directive, source: row.source }));
    });
  }

  async listForAdmin(tenantId: string, serverId: string): Promise<AdminMcpWidgetDomains> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const approved = await client.query<ApprovalRow>(
        `SELECT directive, source, approved_by, approved_at FROM admin_mcp_app_csp_approvals
         WHERE tenant_id = $1 AND server_id = $2
         ORDER BY directive, source`,
        [tenantId, serverId]
      );
      const requested = await client.query<RequestRow>(
        `SELECT directive, source, first_seen_at, last_seen_at FROM admin_mcp_app_csp_requests
         WHERE tenant_id = $1 AND server_id = $2
         ORDER BY last_seen_at DESC, directive, source`,
        [tenantId, serverId]
      );
      return {
        serverId,
        approved: approved.rows.map((row) => ({
          directive: row.directive,
          source: row.source,
          approvedBy: row.approved_by,
          approvedAt: new Date(row.approved_at).toISOString()
        })),
        requested: requested.rows.map((row) => ({
          directive: row.directive,
          source: row.source,
          firstSeenAt: new Date(row.first_seen_at).toISOString(),
          lastSeenAt: new Date(row.last_seen_at).toISOString()
        }))
      };
    });
  }

  /** Records what a widget declared, so an administrator can see it. */
  async recordRequested(tenantId: string, serverId: string, entries: readonly CspDeclarationEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await withTenantScope(this.db, tenantId, async (client) => {
      await client.query(
        `INSERT INTO admin_mcp_app_csp_requests AS request (tenant_id, server_id, directive, source)
         SELECT $1::text, $2::text, declared.directive, declared.source
         FROM unnest($3::text[], $4::text[]) AS declared(directive, source)
         WHERE EXISTS (
             SELECT 1 FROM admin_mcp_app_csp_requests known
             WHERE known.tenant_id = $1 AND known.server_id = $2
               AND known.directive = declared.directive AND known.source = declared.source
           )
           OR (
             SELECT count(*) FROM admin_mcp_app_csp_requests counted
             WHERE counted.tenant_id = $1 AND counted.server_id = $2
           ) < $5
         ON CONFLICT (tenant_id, server_id, directive, source)
         DO UPDATE SET last_seen_at = now()
         WHERE request.last_seen_at < now() - interval '${REQUEST_TOUCH_INTERVAL}'`,
        [
          tenantId,
          serverId,
          entries.map((entry) => entry.directive),
          entries.map((entry) => entry.source),
          MAX_REQUESTED_SOURCES_PER_SERVER
        ]
      );
    });
  }

  /**
   * Approves one source. Returns false when it was already approved. The audit
   * event commits in the same transaction as the change.
   */
  async approve(
    tenantId: string,
    serverId: string,
    entry: CspDeclarationEntry,
    actorUserId: string,
    audit: () => AuditEventInput
  ): Promise<boolean> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const count = await client.query<{ total: string }>(
        `SELECT count(*) AS total FROM admin_mcp_app_csp_approvals WHERE tenant_id = $1 AND server_id = $2`,
        [tenantId, serverId]
      );
      const result = await client.query(
        `INSERT INTO admin_mcp_app_csp_approvals (tenant_id, server_id, directive, source, approved_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, server_id, directive, source) DO NOTHING`,
        [tenantId, serverId, entry.directive, entry.source, actorUserId]
      );
      if ((result.rowCount ?? 0) === 0) return false;
      if (Number(count.rows[0]?.total ?? 0) >= MAX_APPROVED_SOURCES_PER_SERVER) {
        // The transaction rolls back, so the row above is not kept.
        throw new AdminConfigError(
          `A server can have at most ${MAX_APPROVED_SOURCES_PER_SERVER} approved domains. Remove one first.`
        );
      }
      await AuditEventStore.createInTransaction(client, audit());
      return true;
    });
  }

  /**
   * Removes one approval. Returns false when there was none. A caller can pass
   * more than one spelling of the same source.
   */
  async revoke(
    tenantId: string,
    serverId: string,
    directive: McpAppCspDirective,
    sources: readonly string[],
    audit: () => AuditEventInput
  ): Promise<boolean> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `DELETE FROM admin_mcp_app_csp_approvals
         WHERE tenant_id = $1 AND server_id = $2 AND directive = $3 AND source = ANY($4::text[])`,
        [tenantId, serverId, directive, sources]
      );
      if ((result.rowCount ?? 0) === 0) return false;
      await AuditEventStore.createInTransaction(client, audit());
      return true;
    });
  }
}
