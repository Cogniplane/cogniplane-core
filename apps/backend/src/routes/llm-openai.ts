// OpenAI API proxy for the sandboxed Codex runtime. The Codex CLI inside the
// E2B sandbox holds only a session-scoped rt_* runtime token (written to
// ~/.codex/auth.json by `codex login --with-api-key`); this route swaps it for
// the real OPENAI_API_KEY and forwards to api.openai.com.
//
// Provider quirks captured here:
//   - Codex uses the OpenAI SDK convention: `Authorization: Bearer <key>`.
//     `x-api-key` is not used.
//   - Real-key prefix to refuse is `sk-` (covers `sk-proj-`, `sk-svcacct-`,
//     etc.). The rt_* token does NOT start with `sk-`, so this is a clean
//     defense-in-depth check.
//   - Codex resolves its base URL from `[model_providers.<id>].base_url`
//     in ~/.codex/config.toml. The renderer in e2b-codex-mcp-config.ts
//     points that at this route under `/llm/openai/v1`.
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

export type LlmOpenaiRouteStores = LlmProxyRouteStores & {
  provider: LlmProviderConfig;
};

export function buildLlmOpenaiRouteStores(input: {
  upstreamBaseUrl: string;
  runtimeTokenSecret: string;
  platformOpenaiApiKey: string | null;
  egressCidrs: string;
  egressIpPins: RuntimeEgressIpPinStore;
  getTenantOpenaiApiKey: (tenantId: string) => Promise<string | null>;
  auditEvents: AuditEventStore;
  messages: MessageStore;
  activeTurnMessageMap: ActiveTurnMessageMap;
}): LlmOpenaiRouteStores {
  const provider: LlmProviderConfig = {
    providerId: "openai",
    routePrefix: "/llm/openai",
    upstreamBaseUrl: input.upstreamBaseUrl.replace(/\/$/, ""),
    getTenantApiKey: input.getTenantOpenaiApiKey,
    platformApiKey: input.platformOpenaiApiKey,
    buildUpstreamAuthHeaders: (realApiKey) => ({ authorization: `Bearer ${realApiKey}` }),
    readInboundApiKey: (headers) => {
      // OpenAI SDKs send the key as Bearer in Authorization. Extract the
      // token value so the realKeyPrefixes check below can inspect it.
      const raw = headers["authorization"];
      const value = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
      if (typeof value !== "string") return null;
      if (value.startsWith("Bearer ")) return value.slice("Bearer ".length);
      return value;
    },
    realKeyPrefixes: ["sk-"]
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

export async function registerLlmOpenaiRoutes(
  app: FastifyInstance,
  stores: LlmOpenaiRouteStores
): Promise<void> {
  registerLlmProxyRoute(app, stores.provider, stores);
}
