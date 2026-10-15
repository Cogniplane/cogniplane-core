import type { FastifyBaseLogger } from "fastify";
import type { AdminMcpConnectionTest } from "@cogniplane/shared-types";
import { type Pool, withTenantScope } from "../../lib/db.js";
import { forwardRpc, type McpRpcResponse, type McpUpstreamAuth } from "../../lib/mcp-upstream-client.js";
import type { AdminMcpServerRecord } from "../admin-config-records.js";
import type { McpServerStore } from "../mcp-server-store.js";
import type { MemberMcpCredentialStore } from "../member-mcp-credential-store.js";

type Check = AdminMcpConnectionTest;
type Credential = { auth: McpUpstreamAuth; version: number } | null;
type SavedServer = NonNullable<Awaited<ReturnType<McpServerStore["getMcpServer"]>>>;
const MAX_PAGES = 3;
const MAX_TOOLS = 500;
const MAX_RESPONSE_BYTES = 256 * 1024;

export class McpConnectionTestNotFoundError extends Error {}
export class McpConnectionTestConflictError extends Error {
  constructor() {
    super("This saved connection changed. Reload it before testing.");
  }
}

function owner(server: AdminMcpServerRecord, tenantId: string) {
  return server.ownerTenantId ?? tenantId;
}

function rowResult(row: Record<string, unknown>): Check {
  return {
    serverId: String(row.server_id),
    configVersion: Number(row.config_version),
    configHash: String(row.config_hash),
    checkedAt: new Date(row.checked_at as string | Date).toISOString(),
    credentialScope: row.scope_user_id ? "personal" : "organization",
    testedUserId: row.scope_user_id ? String(row.scope_user_id) : null,
    reachability: row.reachability as Check["reachability"],
    authentication: row.authentication as Check["authentication"],
    toolDiscovery: row.tool_discovery as Check["toolDiscovery"],
    toolCount: row.tool_count === null ? null : Number(row.tool_count),
    message: String(row.message)
  };
}

function outcome(
  server: AdminMcpServerRecord,
  userId: string,
  fields: Pick<Check, "reachability" | "authentication" | "toolDiscovery" | "toolCount" | "message">
): Check {
  return {
    serverId: server.serverId,
    configVersion: server.version,
    configHash: server.configHash,
    checkedAt: new Date().toISOString(),
    credentialScope: server.credentialScope,
    testedUserId: server.credentialScope === "personal" ? userId : null,
    ...fields
  };
}

function validTools(value: unknown): value is { tools: Array<{ name: string }>; nextCursor?: string } {
  if (!value || typeof value !== "object" || !Array.isArray((value as { tools?: unknown }).tools)) {
    return false;
  }
  const page = value as { tools: unknown[]; nextCursor?: unknown };
  return page.tools.length <= MAX_TOOLS &&
    page.tools.every(tool =>
      tool !== null &&
      typeof tool === "object" &&
      typeof (tool as { name?: unknown }).name === "string" &&
      (tool as { name: string }).name.length > 0 &&
      (tool as { name: string }).name.length <= 256 &&
      typeof (tool as { inputSchema?: unknown }).inputSchema === "object" &&
      (tool as { inputSchema?: unknown }).inputSchema !== null &&
      !Array.isArray((tool as { inputSchema?: unknown }).inputSchema) &&
      (tool as { inputSchema: { type?: unknown } }).inputSchema.type === "object"
    ) &&
    (page.nextCursor === undefined ||
      (typeof page.nextCursor === "string" && page.nextCursor.length <= 256));
}

export class McpConnectionTestService {
  constructor(private readonly input: {
    db: Pool;
    servers: Pick<McpServerStore, "getAdminMcpServer" | "getMcpServer">;
    credentials: Pick<MemberMcpCredentialStore, "getStatus" | "listStatuses" | "getRuntimeCredential">;
    timeoutMs: number;
    logger?: Pick<FastifyBaseLogger, "warn">;
    forward?: typeof forwardRpc;
  }) {}

  async listLatest(tenantId: string, userId: string, servers: AdminMcpServerRecord[]) {
    if (!servers.length) return new Map<string, Check>();
    const rows = await withTenantScope(this.input.db, tenantId, client => client.query(
      `SELECT * FROM admin_mcp_connection_tests WHERE tenant_id=$1
       AND server_id=ANY($2::text[]) AND scope_user_id IN ('',$3)`,
      [tenantId, servers.map(server => server.serverId), userId]
    ));
    const byKey = new Map(rows.rows.map(row => [`${row.server_id}:${row.scope_user_id}`, row]));
    const current = servers.flatMap(server => {
      const scopeUserId = server.credentialScope === "personal" ? userId : "";
      const row = byKey.get(`${server.serverId}:${scopeUserId}`);
      return row && row.owner_tenant_id === owner(server, tenantId) &&
        row.config_hash === server.configHash && Number(row.config_version) === server.version
        ? [{ server, row, personal: Boolean(scopeUserId) }] : [];
    });
    const personal = current.filter(item => item.personal).map(item => item.server);
    const statuses = personal.length
      ? await this.input.credentials.listStatuses(tenantId, userId, personal) : new Map();
    const result = new Map<string, Check>();
    for (const { server, row, personal: isPersonal } of current) {
      if (isPersonal && (row.credential_binding_id !== server.credentialBindingId ||
          (row.credential_version === null ? null : Number(row.credential_version)) !==
            statuses.get(server.serverId)?.credentialVersion)) continue;
      result.set(server.serverId, rowResult(row));
    }
    return result;
  }

  async test(tenantId: string, userId: string, serverId: string,
    expected: { expectedVersion: number; expectedConfigHash: string }): Promise<Check> {
    const server = await this.input.servers.getAdminMcpServer(tenantId, serverId);
    if (!server) throw new McpConnectionTestNotFoundError("Connection not found.");
    if (server.version !== expected.expectedVersion || server.configHash !== expected.expectedConfigHash) {
      throw new McpConnectionTestConflictError();
    }
    const startedAt = new Date().toISOString();
    let credentialVersion: number | null = null;
    let credential: Credential = null;
    if (server.credentialScope === "personal") {
      const status = await this.input.credentials.getStatus(tenantId, userId, server);
      credentialVersion = status.credentialVersion;
      credential = await this.input.credentials.getRuntimeCredential(tenantId, userId, server);
      if (credential && credential.version !== credentialVersion) {
        throw new McpConnectionTestConflictError();
      }
    }
    let check: Check;
    if (server.mode === "managed") {
      // Organization settings and the turn select which managed tools a
      // member sees. The server itself has no tool list, so report no count.
      check = outcome(server, userId, { reachability: "unknown", authentication: "indeterminate",
        toolDiscovery: "succeeded", toolCount: null,
        message: "Local managed tools are registered. This does not check external providers or runtime access." });
    } else if (server.credentialScope === "personal" && !credential) {
      check = outcome(server, userId, { reachability: "unknown", authentication: "credential_missing",
        toolDiscovery: "not_tested", toolCount: null,
        message: "Your credential is unavailable for this saved connection." });
    } else {
      const runtime = await this.input.servers.getMcpServer(tenantId, serverId);
      if (!runtime || runtime.version !== server.version ||
          runtime.configHash !== server.configHash ||
          runtime.credentialBindingId !== server.credentialBindingId ||
          owner(runtime, tenantId) !== owner(server, tenantId)) {
        throw new McpConnectionTestConflictError();
      }
      check = await this.checkProxy(server, runtime, credential?.auth ?? null, userId);
    }
    const current = await this.input.servers.getAdminMcpServer(tenantId, serverId);
    if (!current || current.version !== server.version || current.configHash !== server.configHash ||
        owner(current, tenantId) !== owner(server, tenantId)) throw new McpConnectionTestConflictError();
    if (server.credentialScope === "personal") {
      const status = await this.input.credentials.getStatus(tenantId, userId, server);
      if (status.credentialVersion !== credentialVersion) throw new McpConnectionTestConflictError();
    }
    return this.persist(tenantId, userId, server, credentialVersion, startedAt, check);
  }

  private async checkProxy(server: AdminMcpServerRecord, runtime: SavedServer | null,
    personalAuth: McpUpstreamAuth | null, userId: string): Promise<Check> {
    if (!runtime?.upstreamUrl || (server.upstreamAuthType !== "none" &&
        !(personalAuth ?? runtime.upstreamAuth))) {
      return outcome(server, userId, { reachability: "unknown", authentication: "credential_missing",
        toolDiscovery: "not_tested", toolCount: null,
        message: "The saved endpoint or credential is unavailable." });
    }
    const signal = AbortSignal.timeout(this.input.timeoutMs);
    const seen = new Set<string>();
    let cursor: string | null = null;
    const cursors = new Set<string>();
    const send = this.input.forward ?? forwardRpc;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const observed: {
        diagnostic: { kind: "http"; status: number } | { kind: "transport" } | null;
      } = { diagnostic: null };
      const rpc: Parameters<typeof forwardRpc>[1] = {
        jsonrpc: "2.0", id: `admin-connection-test:${page}`, method: "tools/list",
        ...(cursor ? { params: { cursor } } : {})
      };
      const response: McpRpcResponse = await send(runtime.upstreamUrl, rpc,
        { "X-Forwarded-By": "cogniplane-core" }, undefined,
        { timeoutMs: this.input.timeoutMs, maxResponseBytes: MAX_RESPONSE_BYTES,
          signal, logger: this.input.logger, serverId: server.serverId,
          onDiagnostic: value => { observed.diagnostic = value; } },
        personalAuth ?? runtime.upstreamAuth ?? null);
      if (signal.aborted) break;
      if (response.error) {
        const diagnostic = observed.diagnostic;
        const status = diagnostic?.kind === "http" ? diagnostic.status : null;
        const authRejected = status === 401 || status === 403;
        return outcome(server, userId, { reachability: status === null ?
          (diagnostic?.kind === "transport" ? "unreachable" : "unknown") : "reachable",
          authentication: "indeterminate", toolDiscovery: "failed", toolCount: null,
          message: authRejected
            ? "The upstream rejected this test identity. Runtime access may differ."
            : status === null
              ? "The saved endpoint did not return a response."
              : "The upstream did not return a usable tool list. Runtime access may differ." });
      }
      if (!validTools(response.result)) {
        return outcome(server, userId, { reachability: "reachable", authentication: "indeterminate",
          toolDiscovery: "failed", toolCount: null, message: "The upstream returned an invalid tool list." });
      }
      for (const tool of response.result.tools) seen.add(tool.name);
      if (seen.size > MAX_TOOLS) break;
      if (!response.result.nextCursor) {
        return outcome(server, userId, { reachability: "reachable",
          authentication: server.upstreamAuthType === "none" ? "not_required" : "accepted",
          toolDiscovery: "succeeded", toolCount: seen.size,
          message: "Tool discovery completed. No tool was executed." });
      }
      if (cursors.has(response.result.nextCursor)) break;
      cursors.add(response.result.nextCursor);
      cursor = response.result.nextCursor;
    }
    return outcome(server, userId, { reachability: signal.aborted ? "unknown" : "reachable",
      authentication: "indeterminate", toolDiscovery: signal.aborted ? "failed" : "partial",
      toolCount: signal.aborted ? null : seen.size,
      message: signal.aborted ? "The connection test reached its time limit."
        : "Tool discovery stopped at its safety limit; the list is incomplete." });
  }

  private async persist(tenantId: string, userId: string, server: AdminMcpServerRecord,
    credentialVersion: number | null, startedAt: string, check: Check): Promise<Check> {
    const scopeUserId = server.credentialScope === "personal" ? userId : "";
    const saved = await withTenantScope(this.input.db, tenantId, client => client.query(
      `INSERT INTO admin_mcp_connection_tests
       (tenant_id,server_id,scope_user_id,owner_tenant_id,config_hash,config_version,
        credential_binding_id,credential_version,started_at,checked_at,reachability,
        authentication,tool_discovery,tool_count,message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (tenant_id,server_id,scope_user_id) DO UPDATE SET
         owner_tenant_id=EXCLUDED.owner_tenant_id,config_hash=EXCLUDED.config_hash,
         config_version=EXCLUDED.config_version,credential_binding_id=EXCLUDED.credential_binding_id,
         credential_version=EXCLUDED.credential_version,started_at=EXCLUDED.started_at,
         checked_at=EXCLUDED.checked_at,reachability=EXCLUDED.reachability,
         authentication=EXCLUDED.authentication,tool_discovery=EXCLUDED.tool_discovery,
         tool_count=EXCLUDED.tool_count,message=EXCLUDED.message
       WHERE admin_mcp_connection_tests.started_at <= EXCLUDED.started_at
       RETURNING *`,
      [tenantId, server.serverId, scopeUserId, owner(server, tenantId), server.configHash, server.version,
        scopeUserId ? server.credentialBindingId : null, credentialVersion, startedAt, check.checkedAt,
        check.reachability, check.authentication, check.toolDiscovery, check.toolCount, check.message]
    ));
    if (saved.rows[0]) return rowResult(saved.rows[0]);
    const latest = await this.listLatest(tenantId, userId, [server]);
    return latest.get(server.serverId) ?? check;
  }
}
