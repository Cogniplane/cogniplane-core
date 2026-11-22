import type { AppConfig } from "../../config.js";
import { AdminConfigError } from "../admin-config-error.js";
import type { AdminMcpServerRecord } from "../admin-config-records.js";
import { AuditEventStore, type AuditEventInput } from "../audit-event-store.js";
import {
  createMcpServer as createMcpServerMutation,
  updateMcpServer as updateMcpServerMutation,
  validateMcpServerInput,
  type CreateMcpServerPayload,
  type UpdateMcpServerPayload
} from "../dynamic-config-mutation-service.js";
import type { McpServerStore } from "../mcp-server-store.js";
import { buildDefaultTenantSettingsInput, type TenantSettingsStore } from "../tenant-settings-store.js";

export type McpAudience = "off" | "test_users" | "members";

type McpAdminStores = {
  mcpServers: Pick<
    McpServerStore,
    | "listMcpServers"
    | "getAdminMcpServer"
    | "createMcpServer"
    | "updateMcpServer"
    | "disableMcpServer"
    | "setMcpServerPublished"
    | "withTransaction"
  >;
  tenantSettings: Pick<TenantSettingsStore, "get" | "upsert" | "setMcpServerAllowed">;
};

/**
 * Administration of a tenant's MCP servers.
 *
 * The connection form uses two operations: `saveMcpServerWithAudience` saves a
 * connection and its audience in one transaction, and
 * `setInheritedMcpAudience` sets the audience of an inherited system
 * connection. The other changes serve the published single-step routes
 * (routes/admin/admin-mcp-server-routes.ts).
 *
 * The audit event of a change, when given, commits in the same transaction as
 * the change.
 */
export class McpAdminService {
  constructor(
    private readonly config: Pick<AppConfig, "MCP_UPSTREAM_ALLOW_PRIVATE_ADDRESSES">,
    private readonly stores: McpAdminStores
  ) {}

  /** The tenant's servers and the system servers that it inherits, disabled servers too. */
  listMcpServers(tenantId: string): Promise<AdminMcpServerRecord[]> {
    return this.stores.mcpServers.listMcpServers(tenantId, true);
  }

  /** The servers on the tenant's allowlist. A tenant with no settings row gets one. */
  async listAllowedMcpServerIds(tenantId: string): Promise<string[]> {
    const settings = (await this.stores.tenantSettings.get(tenantId)) ??
      (await this.stores.tenantSettings.upsert(tenantId, {}));
    return settings.enabledMcpServerIds;
  }

  async createMcpServer(
    tenantId: string,
    input: CreateMcpServerPayload,
    audit?: (server: AdminMcpServerRecord) => AuditEventInput
  ): Promise<AdminMcpServerRecord> {
    return this.stores.mcpServers.withTransaction(tenantId, async (client) => {
      const server = await createMcpServerMutation({
        tenantId,
        store: this.stores.mcpServers,
        payload: input,
        allowPrivateAddresses: this.config.MCP_UPSTREAM_ALLOW_PRIVATE_ADDRESSES,
        client
      });
      if (audit) await AuditEventStore.createInTransaction(client, audit(server));
      return server;
    });
  }

  async updateMcpServer(
    tenantId: string,
    input: UpdateMcpServerPayload,
    audit?: (server: AdminMcpServerRecord) => AuditEventInput
  ): Promise<AdminMcpServerRecord | null> {
    return this.stores.mcpServers.withTransaction(tenantId, async (client) => {
      const server = await updateMcpServerMutation({
        tenantId,
        store: this.stores.mcpServers,
        payload: input,
        allowPrivateAddresses: this.config.MCP_UPSTREAM_ALLOW_PRIVATE_ADDRESSES,
        client
      });
      if (server && audit) await AuditEventStore.createInTransaction(client, audit(server));
      return server;
    });
  }

  async saveMcpServerWithAudience(
    tenantId: string,
    // An edit keeps each omitted upstream field. A create uses the defaults.
    input: UpdateMcpServerPayload & { actorUserId: string },
    audience: "off" | "test_users" | "members",
    // An edit saves a full draft, so it names the saved version that the draft
    // started from. Another version throws McpServerVersionConflictError, and
    // the transaction writes nothing.
    editing?: { serverId: string; expectedVersion: number },
    audit?: (server: AdminMcpServerRecord) => AuditEventInput
  ): Promise<AdminMcpServerRecord | null> {
    const enabled = audience !== "off";
    validateMcpServerInput(input, {
      requireUrlAndSecret: !editing,
      // An edit that leaves the server off: the store applies the address
      // policy, with the saved address (McpServerStore.updateMcpServer).
      allowPrivateAddresses: this.config.MCP_UPSTREAM_ALLOW_PRIVATE_ADDRESSES === true || (Boolean(editing) && !enabled)
    });
    return this.stores.mcpServers.withTransaction(tenantId, async (client) => {
      const saved = editing
        ? await this.stores.mcpServers.updateMcpServer(tenantId, {
            ...input,
            serverId: editing.serverId,
            expectedVersion: editing.expectedVersion,
            enabled
          }, client)
        : await this.stores.mcpServers.createMcpServer(tenantId, {
            ...input,
            upstreamUrl: input.upstreamUrl ?? null,
            upstreamAuthType: input.upstreamAuthType ?? "none",
            upstreamAuthName: input.upstreamAuthName ?? null,
            upstreamAuthSecret: input.upstreamAuthSecret ?? null,
            enabled,
            createdBy: input.actorUserId
          }, client);
      if (!saved) return null;
      const published = await this.stores.mcpServers.setMcpServerPublished(
        tenantId,
        saved.serverId,
        audience === "members",
        client
      );
      if (!published) throw new AdminConfigError("MCP server was not saved.");
      await this.stores.tenantSettings.setMcpServerAllowed(
        tenantId,
        saved.serverId,
        enabled,
        client
      );
      if (audit) await AuditEventStore.createInTransaction(client, audit(published));
      return published;
    });
  }

  async setInheritedMcpAudience(
    tenantId: string,
    serverId: string,
    audience: "off" | "test_users" | "members",
    audit?: (server: AdminMcpServerRecord) => AuditEventInput
  ): Promise<AdminMcpServerRecord> {
    return this.stores.mcpServers.withTransaction(tenantId, async (client) => {
      const server = await this.stores.mcpServers.getAdminMcpServer(tenantId, serverId, client);
      if (!server || server.ownerTenantId !== "system" || tenantId === "system") {
        throw new AdminConfigError("This connection is not an inherited system connection.");
      }
      if (audience !== "off" && !server.enabled) {
        throw new AdminConfigError("This connection is disabled by the system.");
      }
      if (audience === "members" && !server.isPublished) {
        throw new AdminConfigError("This connection is available only to test users.");
      }
      if (audience === "test_users" && server.isPublished) {
        throw new AdminConfigError("This connection is published for all members.");
      }
      await this.stores.tenantSettings.setMcpServerAllowed(
        tenantId,
        serverId,
        audience !== "off",
        client
      );
      if (audit) await AuditEventStore.createInTransaction(client, audit(server));
      return server;
    });
  }

  async disableMcpServer(
    tenantId: string,
    serverId: string,
    audit?: (server: AdminMcpServerRecord) => AuditEventInput
  ): Promise<AdminMcpServerRecord | null> {
    const settings = await this.stores.tenantSettings.get(tenantId);
    const enabledMcpServerIds = settings?.enabledMcpServerIds
      ?? buildDefaultTenantSettingsInput().enabledMcpServerIds;

    if (enabledMcpServerIds.includes(serverId)) {
      throw new AdminConfigError(
        `Cannot disable MCP server "${serverId}" — it is referenced by the tenant's active settings. Remove it from enabled MCP servers first.`
      );
    }
    return this.stores.mcpServers.withTransaction(tenantId, async (client) => {
      const server = await this.stores.mcpServers.disableMcpServer(tenantId, serverId, client);
      if (server && audit) await AuditEventStore.createInTransaction(client, audit(server));
      return server;
    });
  }

  setMcpServerPublished(
    tenantId: string,
    serverId: string,
    isPublished: boolean,
    audit?: (server: AdminMcpServerRecord) => AuditEventInput
  ): Promise<AdminMcpServerRecord | null> {
    return this.stores.mcpServers.withTransaction(tenantId, async (client) => {
      const server = await this.stores.mcpServers.setMcpServerPublished(tenantId, serverId, isPublished, client);
      if (server && audit) await AuditEventStore.createInTransaction(client, audit(server));
      return server;
    });
  }
}
