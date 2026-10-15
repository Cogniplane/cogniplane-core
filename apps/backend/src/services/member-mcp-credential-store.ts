import type { McpConnection, McpCredentialStatus } from "@cogniplane/shared-types";
import type { PoolClient } from "pg";
import { decrypt, encrypt } from "../lib/crypto-utils.js";
import { type Pool, withTenantScope } from "../lib/db.js";
import type { McpUpstreamAuth } from "../lib/mcp-upstream-client.js";
import { isCredentialQueryParameterName } from "../lib/sensitive-query-params.js";
import { mcpUpstreamUrlSchema } from "../lib/url-validation.js";
import type { AdminMcpServerRecord } from "./admin-config-records.js";
import { mapMcpServer } from "./admin-config-store-mappers.js";
import { AuditEventStore } from "./audit-event-store.js";
import { DEFAULT_TENANT_MCP_SERVER_IDS } from "./tenant-settings-store.js";

export class MemberMcpAccessError extends Error {
  constructor() { super("Your organization membership is no longer available."); }
}
export class MemberMcpNotFoundError extends Error {
  constructor() { super("This connection is no longer available."); }
}
export class MemberMcpConflictError extends Error {
  constructor() { super("This connection changed. Reload it and try again."); }
}
export class MemberMcpValidationError extends Error {
  constructor(message: string) { super(message); }
}

type CredentialRow = {
  credential_binding_id: string;
  secret_encrypted: string | null;
  account_label: string | null;
  version: number;
  updated_at: Date | string;
};
type MemberState = { beta: boolean; allowedServerIds: Set<string> };

// remove() writes this binding. Server bindings are random v4 UUIDs, so it
// never matches one. It tells a removal apart from a binding rotation.
const REMOVED_BINDING_ID = "00000000-0000-0000-0000-000000000000";

function hasLegacyUrlCredential(upstreamUrl: string | null): boolean {
  if (!upstreamUrl) return false;
  try {
    return [...new URL(upstreamUrl).searchParams.entries()].some(([name, value]) =>
      value.length > 0 && isCredentialQueryParameterName(name));
  } catch {
    return false;
  }
}

function validInput(input: { version: number; serverVersion: number; secret: string; accountLabel: string | null }) {
  if (!Number.isInteger(input.version) || input.version < 0 || !Number.isInteger(input.serverVersion) || input.serverVersion < 1) {
    throw new MemberMcpValidationError("Connection versions must be valid non-negative numbers.");
  }
  if (typeof input.secret !== "string" || input.secret.length < 8 || input.secret.length > 8192 || /[\r\n\0]/.test(input.secret)) {
    throw new MemberMcpValidationError("Credential must be 8 to 8192 characters with no line breaks or null characters.");
  }
  if (input.accountLabel !== null && (typeof input.accountLabel !== "string" || input.accountLabel.trim().length > 120)) {
    throw new MemberMcpValidationError("Account label must be 120 characters or fewer.");
  }
}
function status(server: AdminMcpServerRecord | null, row: CredentialRow | null, available: boolean): McpCredentialStatus {
  const credentialVersion = Number(row?.version ?? 0);
  const accountLabel = row?.account_label ?? null;
  if (!server || !available) return { status: "unavailable", credentialVersion, accountLabel: null };
  if (server.credentialScope === "organization") return {
    status: server.upstreamAuthType === "none" && !hasLegacyUrlCredential(server.upstreamUrl) ? "no_auth" : "organization",
    credentialVersion, accountLabel: null
  };
  if (server.upstreamAuthType === "none") return { status: "no_auth", credentialVersion, accountLabel: null };
  if (!row || String(row.credential_binding_id) === REMOVED_BINDING_ID) {
    return { status: "not_connected", credentialVersion, accountLabel: null };
  }
  // A binding rotation clears the secret but keeps the old binding and label.
  if (String(row.credential_binding_id) !== server.credentialBindingId) {
    return { status: "reconnect_required", credentialVersion, accountLabel };
  }
  if (!row.secret_encrypted) return { status: "not_connected", credentialVersion, accountLabel: null };
  return { status: "connected", credentialVersion, accountLabel };
}
function approved(server: AdminMcpServerRecord, state: MemberState): boolean {
  return server.mode === "proxy" && server.enabled && (server.isPublished || state.beta) &&
    state.allowedServerIds.has(server.serverId);
}
function canConnect(server: AdminMcpServerRecord, state: MemberState): boolean {
  return approved(server, state) && server.credentialScope === "personal" && server.upstreamAuthType !== "none" &&
    server.upstreamUrl !== null && mcpUpstreamUrlSchema.safeParse(server.upstreamUrl).success;
}
function connection(server: AdminMcpServerRecord | null, serverId: string,
  row: CredentialRow | null, state: MemberState): McpConnection {
  const isApproved = server ? approved(server, state) : false;
  const currentStatus = status(server, row, isApproved);
  const connectable = server ? canConnect(server, state) : false;
  return {
    ...currentStatus,
    serverId,
    serverName: server?.serverName ?? serverId,
    description: server?.description ?? null,
    upstreamUrl: connectable ? server?.upstreamUrl ?? null : null,
    authType: connectable ? server!.upstreamAuthType : "none",
    authName: connectable ? server!.upstreamAuthName : null,
    credentialScope: server?.credentialScope ?? "personal",
    serverVersion: server?.version ?? 0,
    canConnect: connectable,
    hasCredential: Boolean(row?.secret_encrypted),
    updatedAt: row ? new Date(row.updated_at).toISOString() : null
  };
}

export class MemberMcpCredentialStore {
  constructor(private readonly db: Pool, private readonly encryptionSecret: string) {}

  // Call in the transaction that rotates the server's credential binding.
  // The old secrets can no longer be used, so do not keep them at rest.
  static async revokeForServer(client: PoolClient, tenantId: string, serverId: string): Promise<void> {
    await client.query(
      `UPDATE member_mcp_credentials SET secret_encrypted=NULL, version=version+1, updated_at=now()
       WHERE tenant_id=$1 AND server_id=$2 AND secret_encrypted IS NOT NULL`,
      [tenantId, serverId]);
  }

  // revokeForServer cannot reach other tenants' rows for a system server.
  // Clear a secret for an old binding when a read sees it. The row keeps
  // its binding and label, so status() reports reconnect_required.
  private async clearStaleSecret(client: PoolClient, tenantId: string, userId: string, serverId: string,
    row: CredentialRow, currentBindingId: string): Promise<CredentialRow> {
    if (!row.secret_encrypted || String(row.credential_binding_id) === currentBindingId) return row;
    const cleared = await client.query(
      `UPDATE member_mcp_credentials SET secret_encrypted=NULL, version=version+1, updated_at=now()
       WHERE tenant_id=$1 AND user_id=$2 AND server_id=$3 AND credential_binding_id=$4::uuid
         AND secret_encrypted IS NOT NULL
       RETURNING credential_binding_id, secret_encrypted, account_label, version, updated_at`,
      [tenantId, userId, serverId, row.credential_binding_id]);
    return cleared.rows[0] as CredentialRow | undefined
      ?? await this.credential(client, tenantId, userId, serverId, false)
      ?? { ...row, secret_encrypted: null };
  }

  private async memberState(client: PoolClient, tenantId: string, userId: string, lock: boolean): Promise<MemberState> {
    const member = await client.query(
      `SELECT is_beta_tester FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2 ${lock ? "FOR KEY SHARE" : ""}`,
      [tenantId, userId]);
    if (!member.rowCount) throw new MemberMcpAccessError();
    const settings = await client.query("SELECT enabled_mcp_server_ids FROM tenant_settings WHERE tenant_id=$1", [tenantId]);
    const allowed = settings.rows[0]?.enabled_mcp_server_ids ?? DEFAULT_TENANT_MCP_SERVER_IDS;
    return { beta: Boolean(member.rows[0].is_beta_tester),
      allowedServerIds: new Set(Array.isArray(allowed) ? allowed.filter((id): id is string => typeof id === "string") : []) };
  }

  private async currentServer(client: PoolClient, tenantId: string, serverId: string, lock: boolean): Promise<AdminMcpServerRecord | null> {
    const result = await client.query(
      `SELECT * FROM admin_mcp_servers WHERE server_id=$1 AND tenant_id IN ($2::text, 'system')
       ORDER BY (tenant_id=$2::text) DESC LIMIT 1`, [serverId, tenantId]);
    if (!result.rows[0]) return null;
    if (lock && result.rows[0].tenant_id === tenantId) {
      const owned = await client.query(
        "SELECT * FROM admin_mcp_servers WHERE tenant_id=$1 AND server_id=$2 FOR SHARE", [tenantId, serverId]);
      return owned.rows[0] ? mapMcpServer(owned.rows[0]) : null;
    }
    return mapMcpServer(result.rows[0]);
  }

  private async credential(client: PoolClient, tenantId: string, userId: string, serverId: string, lock: boolean): Promise<CredentialRow | null> {
    const result = await client.query(
      `SELECT credential_binding_id, secret_encrypted, account_label, version, updated_at
       FROM member_mcp_credentials WHERE tenant_id=$1 AND user_id=$2 AND server_id=$3 ${lock ? "FOR UPDATE" : ""}`,
      [tenantId, userId, serverId]);
    return result.rows[0] as CredentialRow | undefined ?? null;
  }

  async list(tenantId: string, userId: string): Promise<McpConnection[]> {
    return withTenantScope(this.db, tenantId, async client => {
      const state = await this.memberState(client, tenantId, userId, false);
      const [servers, credentials] = await Promise.all([
        client.query(
          `SELECT * FROM (SELECT DISTINCT ON (server_id) * FROM admin_mcp_servers
           WHERE tenant_id IN ($1::text, 'system')
           ORDER BY server_id, (tenant_id=$1::text) DESC) selected
           ORDER BY server_name, server_id`, [tenantId]),
        client.query(
          `SELECT server_id, credential_binding_id, secret_encrypted, account_label, version, updated_at
           FROM member_mcp_credentials WHERE tenant_id=$1 AND user_id=$2`, [tenantId, userId])
      ]);
      const saved = new Map<string, CredentialRow>(credentials.rows.map(row => [String(row.server_id), row as CredentialRow]));
      const result: McpConnection[] = [];
      for (const raw of servers.rows) {
        const server = mapMcpServer(raw);
        const savedRow = saved.get(server.serverId);
        const row = savedRow
          ? await this.clearStaleSecret(client, tenantId, userId, server.serverId, savedRow, server.credentialBindingId)
          : null;
        if (approved(server, state) || row) result.push(connection(server, server.serverId, row, state));
        saved.delete(server.serverId);
      }
      for (const [serverId, row] of saved) result.push(connection(null, serverId, row, state));
      return result;
    });
  }

  async getStatus(tenantId: string, userId: string, server: AdminMcpServerRecord): Promise<McpCredentialStatus> {
    return (await this.listStatuses(tenantId, userId, [server])).get(server.serverId)!;
  }

  // Reads the status of many servers in one transaction.
  async listStatuses(tenantId: string, userId: string,
    servers: readonly AdminMcpServerRecord[]): Promise<Map<string, McpCredentialStatus>> {
    const result = new Map<string, McpCredentialStatus>();
    if (!servers.length) return result;
    return withTenantScope(this.db, tenantId, async client => {
      const state = await this.memberState(client, tenantId, userId, false);
      const ids = [...new Set(servers.map(server => server.serverId))];
      const [currentRows, credentialRows] = await Promise.all([
        client.query(
          `SELECT * FROM (SELECT DISTINCT ON (server_id) * FROM admin_mcp_servers
           WHERE tenant_id IN ($1::text, 'system') AND server_id = ANY($2::text[])
           ORDER BY server_id, (tenant_id=$1::text) DESC) selected`, [tenantId, ids]),
        client.query(
          `SELECT server_id, credential_binding_id, secret_encrypted, account_label, version, updated_at
           FROM member_mcp_credentials WHERE tenant_id=$1 AND user_id=$2 AND server_id = ANY($3::text[])`,
          [tenantId, userId, ids])
      ]);
      const currentById = new Map(currentRows.rows.map(row => [String(row.server_id), mapMcpServer(row)]));
      const credentials = new Map(credentialRows.rows.map(row => [String(row.server_id), row as CredentialRow]));
      for (const [serverId, row] of credentials) {
        const current = currentById.get(serverId);
        if (current) {
          credentials.set(serverId,
            await this.clearStaleSecret(client, tenantId, userId, serverId, row, current.credentialBindingId));
        }
      }
      for (const server of servers) {
        const current = currentById.get(server.serverId) ?? null;
        const value = status(current, credentials.get(server.serverId) ?? null,
          Boolean(current && approved(current, state)));
        result.set(server.serverId, value.status === "connected" &&
          current?.credentialBindingId !== server.credentialBindingId
          ? { ...value, status: "reconnect_required" } : value);
      }
      return result;
    });
  }

  async getRuntimeCredential(tenantId: string, userId: string, server: AdminMcpServerRecord): Promise<{ auth: McpUpstreamAuth; version: number } | null> {
    return withTenantScope(this.db, tenantId, async client => {
      const state = await this.memberState(client, tenantId, userId, false);
      const current = await this.currentServer(client, tenantId, server.serverId, false);
      if (!current) return null;
      const saved = await this.credential(client, tenantId, userId, server.serverId, false);
      const row = saved
        ? await this.clearStaleSecret(client, tenantId, userId, server.serverId, saved, current.credentialBindingId)
        : null;
      if (!canConnect(current, state) || current.credentialBindingId !== server.credentialBindingId) return null;
      if (!row?.secret_encrypted || String(row.credential_binding_id) !== current.credentialBindingId) return null;
      const secret = decrypt(row.secret_encrypted, this.encryptionSecret);
      const auth: McpUpstreamAuth = current.upstreamAuthType === "bearer"
        ? { type: "bearer", secret }
        : { type: current.upstreamAuthType as "header" | "query", name: current.upstreamAuthName!, secret };
      return { auth, version: Number(row.version) };
    });
  }

  async save(tenantId: string, userId: string, serverId: string,
    input: { version: number; serverVersion: number; secret: string; accountLabel: string | null }): Promise<McpConnection> {
    validInput(input);
    return withTenantScope(this.db, tenantId, async client => {
      const state = await this.memberState(client, tenantId, userId, true);
      const server = await this.currentServer(client, tenantId, serverId, true);
      if (!server || !canConnect(server, state)) throw new MemberMcpNotFoundError();
      if (server.version !== input.serverVersion) throw new MemberMcpConflictError();
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [JSON.stringify(["member-mcp-credential", tenantId, userId, serverId])]);
      const prior = await this.credential(client, tenantId, userId, serverId, true);
      if (Number(prior?.version ?? 0) !== input.version) throw new MemberMcpConflictError();
      const label = input.accountLabel?.trim() || null;
      const encrypted = encrypt(input.secret, this.encryptionSecret);
      const saved = await client.query(
        `INSERT INTO member_mcp_credentials
         (tenant_id,user_id,server_id,credential_binding_id,secret_encrypted,account_label,version)
         VALUES ($1,$2,$3,$4::uuid,$5,$6,$7)
         ON CONFLICT (tenant_id,user_id,server_id) DO UPDATE SET
           credential_binding_id=EXCLUDED.credential_binding_id,
           secret_encrypted=EXCLUDED.secret_encrypted, account_label=EXCLUDED.account_label,
           version=EXCLUDED.version, updated_at=now()
         RETURNING credential_binding_id, secret_encrypted, account_label, version, updated_at`,
        [tenantId, userId, serverId, server.credentialBindingId, encrypted, label, input.version + 1]);
      await AuditEventStore.createInTransaction(client, { tenantId, userId, sessionId: null,
        type: "member.mcp_credential.saved", payload: { serverId, version: input.version + 1, serverVersion: server.version } });
      return connection(server, serverId, saved.rows[0] as CredentialRow, state);
    });
  }

  async remove(tenantId: string, userId: string, serverId: string, version: number): Promise<void> {
    if (!Number.isInteger(version) || version < 0) throw new MemberMcpValidationError("Credential version is invalid.");
    await withTenantScope(this.db, tenantId, async client => {
      await this.memberState(client, tenantId, userId, true);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [JSON.stringify(["member-mcp-credential", tenantId, userId, serverId])]);
      const prior = await this.credential(client, tenantId, userId, serverId, true);
      if (!prior) throw new MemberMcpNotFoundError();
      if (Number(prior.version) !== version) throw new MemberMcpConflictError();
      await client.query(
        `UPDATE member_mcp_credentials SET secret_encrypted=NULL, account_label=NULL,
           credential_binding_id=$4::uuid, version=version+1, updated_at=now()
         WHERE tenant_id=$1 AND user_id=$2 AND server_id=$3`,
        [tenantId, userId, serverId, REMOVED_BINDING_ID]);
      await AuditEventStore.createInTransaction(client, { tenantId, userId, sessionId: null,
        type: "member.mcp_credential.removed", payload: { serverId, version: version + 1 } });
    });
  }
}
