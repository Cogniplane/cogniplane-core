import type { FastifyBaseLogger } from "fastify";

import { cidrAllowlistAllows, parseCidrAllowlist } from "../../lib/cidr-allowlist.js";
import { rpcFailure as failure, type McpRpcResponse as RpcResponse } from "../../lib/mcp-upstream-client.js";
import { verifyRuntimeToken, type RuntimeTokenClaims } from "../auth/runtime-token.js";
import type { AuditEventStore } from "../audit-event-store.js";
import type { RuntimeEgressIpPinStore } from "../runtime-egress-ip-pin.js";

// Admission slice of the gateway stores, defined locally to avoid coupling this
// service module "up" to the route-owned McpRouteStores type.
type GatewayAdmissionStores = {
  runtimeTokenSecret: string;
  egressAllowlist: ReturnType<typeof parseCidrAllowlist>;
  egressIpPins: RuntimeEgressIpPinStore;
  auditEvents: AuditEventStore;
};

// Best-effort evidence row for a gateway rejection. A failure here (e.g. the DB
// is unreachable) must never change the gating decision — the audit protects
// the platform; losing the evidence row is the lesser failure.
async function recordGatewayRejection(
  auditEvents: AuditEventStore,
  reason: string,
  ctx: {
    claims: RuntimeTokenClaims;
    ipAddress: string | null;
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
      ipAddress: ctx.ipAddress
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
  ipAddress: string | null;
  stores: GatewayAdmissionStores;
  logger: FastifyBaseLogger;
};

export type GatewayAdmissionResult =
  | { ok: true; claims: RuntimeTokenClaims; ipAddress: string | null }
  | { ok: false; statusCode: 401 | 403; body: RpcResponse };

// Verifies the runtime token and enforces the egress controls, returning either
// the admitted claims + peer IP or a JSON-RPC failure to write. Every side
// effect (warn logs, recordGatewayRejection evidence writes) runs in the same
// order the inline preamble did — callers just translate `{ ok: false }` into
// `reply.code(statusCode); return body`.
export async function runGatewayAdmission(input: GatewayAdmissionInput): Promise<GatewayAdmissionResult> {
  const { authorizationHeader, rpcId, rpcMethod, serverId, tenantId, ipAddress, stores, logger } = input;

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

  // Same egress controls as the LLM proxy (llm-proxy-core.ts). The CIDR
  // allowlist (E2B_EGRESS_CIDRS) is dormant unless configured — E2B does not
  // publish egress ranges — so the per-runtime IP pin is the operative
  // control: the first gateway/proxy call for a runtimeId records the peer
  // IP, and a leaked rt_* token replayed from any other host is refused for
  // the rest of its TTL. The pin store is shared with /llm/*, so whichever
  // route the sandbox hits first establishes the pin for both.
  if (stores.egressAllowlist && !cidrAllowlistAllows(stores.egressAllowlist, ipAddress ?? "")) {
    await recordGatewayRejection(stores.auditEvents, "egress_ip_not_allowed", { claims, ipAddress, serverId, rpcMethod }, logger);
    return { ok: false, statusCode: 403, body: failure(rpcId, -32000, "Egress IP is not allowed.") };
  }
  if (ipAddress) {
    const pinResult = await stores.egressIpPins.checkAndPin(claims.rid, ipAddress);
    if (pinResult.kind === "mismatch") {
      await recordGatewayRejection(stores.auditEvents, "egress_ip_mismatch", { claims, ipAddress, serverId, rpcMethod }, logger);
      // Log expected/observed at warn so an operator investigating a leak
      // can see both — the audit payload deliberately omits the expected IP
      // to avoid storing per-runtime peer addresses in a long-retention
      // table (mirrors the LLM proxy).
      logger.warn(
        { runtimeId: claims.rid, expectedIp: pinResult.expectedIp, observedIp: pinResult.observedIp },
        "MCP gateway egress IP mismatch — refusing rt_* call from unexpected peer"
      );
      return { ok: false, statusCode: 403, body: failure(rpcId, -32000, "Egress IP mismatch.") };
    }
  }

  return { ok: true, claims, ipAddress };
}
