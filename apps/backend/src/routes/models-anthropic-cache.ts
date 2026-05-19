import type { RuntimeReasoningEffort } from "../runtime-contracts.js";

export type AnthropicEffortCapabilities = Map<
  string,
  { supportedEfforts: RuntimeReasoningEffort[]; defaultEffort: RuntimeReasoningEffort | null }
>;

type Entry =
  | { kind: "ok"; value: AnthropicEffortCapabilities; expiresAt: number }
  | { kind: "miss"; expiresAt: number };

export type AnthropicCapabilitiesCache = {
  getOrLoad(
    tenantId: string,
    loader: () => Promise<AnthropicEffortCapabilities | null>
  ): Promise<AnthropicEffortCapabilities | null>;
};

// Per-process cache for the Anthropic /v1/models response, keyed by tenant
// (each tenant uses its own API key so the result set differs per tenant).
//
// Two TTLs:
//   - successTtlMs: how long a usable capability map is reused. Anthropic
//     model lists rarely change (days/weeks) so 10 minutes is conservative;
//     it keeps /models from issuing a billable upstream call on every chat-
//     screen render while remaining responsive to actual model changes.
//   - negativeTtlMs: how long a `null` outcome (timeout, non-2xx, network
//     error) is remembered. Short on purpose: a freshly-fixed key or a
//     transient outage shouldn't lock the tenant out of capability data
//     for the full success window.
//
// Like the recently-resolved approval cache (routes/approvals.ts), this is
// per-process. In a multi-replica deployment each replica issues at most
// one upstream call per tenant per TTL — still bounded, still cheap. To
// share state across replicas, replace the Map with Redis under the same
// TTL contract.
export function createAnthropicCapabilitiesCache(input: {
  successTtlMs: number;
  negativeTtlMs: number;
  now?: () => number;
}): AnthropicCapabilitiesCache {
  const entries = new Map<string, Entry>();
  const now = input.now ?? Date.now;

  // Pending loads de-duplicated per tenant: a thundering herd of concurrent
  // requests on the first cache miss should issue exactly one upstream call.
  const inflight = new Map<string, Promise<AnthropicEffortCapabilities | null>>();

  function readFresh(tenantId: string): Entry | undefined {
    const entry = entries.get(tenantId);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
      entries.delete(tenantId);
      return undefined;
    }
    return entry;
  }

  return {
    async getOrLoad(tenantId, loader) {
      const fresh = readFresh(tenantId);
      if (fresh) {
        return fresh.kind === "ok" ? fresh.value : null;
      }

      const existing = inflight.get(tenantId);
      if (existing) return existing;

      const promise = loader()
        .then((result) => {
          if (result) {
            entries.set(tenantId, {
              kind: "ok",
              value: result,
              expiresAt: now() + input.successTtlMs
            });
          } else {
            entries.set(tenantId, {
              kind: "miss",
              expiresAt: now() + input.negativeTtlMs
            });
          }
          return result;
        })
        .finally(() => {
          inflight.delete(tenantId);
        });

      inflight.set(tenantId, promise);
      return promise;
    }
  };
}
