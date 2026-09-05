import type { FastifyBaseLogger } from "fastify";

import { rpcFailure as failure, type McpRpcResponse as RpcResponse } from "../../lib/mcp-upstream-client.js";
import { verifyRuntimeToken, type RuntimeTokenClaims } from "../auth/runtime-token.js";
import type { AuditEventStore } from "../audit-event-store.js";

// Admission slice of the gateway stores, defined locally to avoid coupling this
// service module "up" to the route-owned McpRouteStores type.
type GatewayAdmissionStores = {
  runtimeTokenSecret: string;
  auditEvents: Pick<AuditEventStore, "create">;
};

const LOOPBACK_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

// Best-effort evidence row for a gateway rejection. A failure here (e.g. the DB
// is unreachable) must never change the gating decision — the audit protects
// the platform; losing the evidence row is the lesser failure.
async function recordGatewayRejection(
  auditEvents: Pick<AuditEventStore, "create">,
  reason: string,
  ctx: {
    claims: RuntimeTokenClaims;
    remoteAddress: string | null;
    serverId: string;
    rpcMethod: string;
  },
  log: FastifyBaseLogger
): Promise<void> {
  try {
    await auditEvents.create({
      tenantId: ctx.claims.tid,
      sessionId: ctx.claims.sid,
      userId: ctx.claims.uid,
      type: "mcp.gateway.rejected",
      payload: { reason, serverId: ctx.serverId, rpcMethod: ctx.rpcMethod },
      ipAddress: ctx.remoteAddress
    });
  } catch (err) {
    log.warn({ err, reason, serverId: ctx.serverId }, "failed to persist mcp.gateway.rejected audit event");
  }
}

/**
 * Extracts the full claims from a runtime token (rt_*) in the Authorization
 * header.
 *
 * The auth middleware already verified this token before the handler ran;
 * re-verifying here keeps the claim extraction localised to MCP routes instead
 * of widening `request.auth` for every endpoint. Callers use `sid` for the
 * session-scoped context fallback/telemetry and `sid` + `uid` to bind a
 * caller-supplied toolContextId to the authenticated identity.
 */
function resolveRuntimeTokenClaims(
  authHeader: string | string[] | undefined,
  secret: string
): RuntimeTokenClaims | null {
  const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!header?.startsWith("Bearer rt_")) return null;
  const result = verifyRuntimeToken(header.slice("Bearer ".length), secret);
  return result.kind === "valid" ? result.claims : null;
}

export type GatewayAdmissionInput = {
  authorizationHeader: string | string[] | undefined;
  rpcId: string | number | undefined;
  rpcMethod: string;
  serverId: string;
  tenantId: string;
  remoteAddress: string | null | undefined;
  stores: GatewayAdmissionStores;
  logger: FastifyBaseLogger;
};

export type GatewayAdmissionResult =
  | { ok: true; claims: RuntimeTokenClaims }
  | { ok: false; statusCode: 401 | 403; body: RpcResponse };

// Verifies the runtime token and enforces loopback-only admission, returning either
// the admitted claims or a JSON-RPC failure to write.
export async function runGatewayAdmission(input: GatewayAdmissionInput): Promise<GatewayAdmissionResult> {
  const { authorizationHeader, rpcId, rpcMethod, serverId, tenantId, remoteAddress, stores, logger } = input;

  // The MCP gateway exists for the sandboxed runtime alone — every request,
  // including initialize, must carry a valid session-scoped rt_* token as
  // `Authorization: Bearer` (both runtimes send it on every request). User
  // JWTs and dev headers are deliberately rejected: resolveBoundToolContext
  // binds caller-supplied toolContextIds to these claims, so admitting
  // non-runtime callers would let a same-tenant user substitute another
  // user's context id and execute tools under that identity. We re-verify
  // the token here rather than threading claims through request.auth so the
  // rest of the API surface stays unchanged.
  const claims = resolveRuntimeTokenClaims(authorizationHeader, stores.runtimeTokenSecret);
  if (!claims) {
    logger.warn(
      { serverId, rpcMethod, tenantId },
      "MCP gateway 401: request authenticated without a valid runtime token (rt_*)"
    );
    return { ok: false, statusCode: 401, body: failure(rpcId, -32000, "The MCP gateway requires a valid runtime token (rt_*).") };
  }

  // Loopback-only egress check: the gateway must only accept connections originating
  // from the local host (127.0.0.1, ::1, or IPv4-mapped IPv6 loopback).
  if (!remoteAddress || !LOOPBACK_IPS.has(remoteAddress)) {
    await recordGatewayRejection(
      stores.auditEvents,
      "non_loopback_peer",
      { claims, remoteAddress: remoteAddress ?? null, serverId, rpcMethod },
      logger
    );
    logger.warn(
      { serverId, rpcMethod, remoteAddress: remoteAddress ?? null },
      "MCP gateway 403: connection from non-loopback peer rejected"
    );
    return { ok: false, statusCode: 403, body: failure(rpcId, -32000, "Loopback connection required.") };
  }

  return { ok: true, claims };
}
