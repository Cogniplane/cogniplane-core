// Anthropic API proxy for sandboxed Claude runtimes
// (CLAUDE_RUNTIME_BACKEND=e2b). The harness inside the sandbox holds only
// a session-scoped rt_* runtime token; this route swaps it for the real
// ANTHROPIC_API_KEY and forwards to api.anthropic.com.
//
// Provider quirks captured here:
//   - The Agent SDK sends the API key as `x-api-key`, not as a Bearer
//     header. We pass that header through the rt_* check.
//   - Real-key prefix to refuse is `sk-ant-`.
//
// All shared logic (auth, audit, CIDR, forwarding) lives in
// llm-proxy-core.ts.

import type { FastifyInstance } from "fastify";

import { parseCidrAllowlist } from "../lib/cidr-allowlist.js";
import type { ActiveTurnMessageMap } from "../services/active-turn-message-map.js";
import type { AuditEventStore } from "../services/audit-event-store.js";
import type { MessageStore } from "../services/message-store.js";
import type { RuntimeEgressIpPinStore } from "../services/runtime-egress-ip-pin.js";
import {
  registerLlmProxyRoute,
  type LlmProviderConfig,
  type LlmProxyRouteStores
} from "./llm-proxy-core.js";

export type LlmAnthropicRouteStores = LlmProxyRouteStores & {
  provider: LlmProviderConfig;
};

export function buildLlmAnthropicRouteStores(input: {
  upstreamBaseUrl: string;
  runtimeTokenSecret: string;
  platformAnthropicApiKey: string | null;
  egressCidrs: string;
  egressIpPins: RuntimeEgressIpPinStore;
  getTenantAnthropicApiKey: (tenantId: string) => Promise<string | null>;
  auditEvents: AuditEventStore;
  messages: MessageStore;
  activeTurnMessageMap: ActiveTurnMessageMap;
}): LlmAnthropicRouteStores {
  const provider: LlmProviderConfig = {
    providerId: "anthropic",
    routePrefix: "/llm/anthropic",
    upstreamBaseUrl: input.upstreamBaseUrl.replace(/\/$/, ""),
    getTenantApiKey: input.getTenantAnthropicApiKey,
    platformApiKey: input.platformAnthropicApiKey,
    buildUpstreamAuthHeaders: (realApiKey) => ({ "x-api-key": realApiKey }),
    readInboundApiKey: (headers) => {
      const raw = headers["x-api-key"];
      return typeof raw === "string" ? raw : Array.isArray(raw) ? (raw[0] ?? null) : null;
    },
    realKeyPrefixes: ["sk-ant-"]
  };
  return {
    runtimeTokenSecret: input.runtimeTokenSecret,
    egressAllowlist: parseCidrAllowlist(input.egressCidrs),
    egressIpPins: input.egressIpPins,
    auditEvents: input.auditEvents,
    messages: input.messages,
    activeTurnMessageMap: input.activeTurnMessageMap,
    provider
  };
}

export async function registerLlmAnthropicRoutes(
  app: FastifyInstance,
  stores: LlmAnthropicRouteStores
): Promise<void> {
  registerLlmProxyRoute(app, stores.provider, stores);
}
