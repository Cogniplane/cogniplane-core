import type { RuntimeInvalidator } from "../integrations/contracts.js";
import type { RuntimeProvider } from "../admin-config-records.js";
import type { RuntimeAdapter } from "../../runtime-contracts.js";

// Builds the integration invalidator that fans a single (re)connect/disconnect
// across every registered runtime adapter, so a user's stale sessions are torn
// down regardless of which provider they were running on (Codex and Claude
// alike). Each adapter's user-scoped `invalidateRuntimesForIntegration` is
// optional; adapters that don't implement it contribute no sessions. Returns
// the union of invalidated session ids.
export function createFanOutRuntimeInvalidator(
  adapters: Partial<Record<RuntimeProvider, RuntimeAdapter>> | RuntimeAdapter[]
): RuntimeInvalidator {
  const list: RuntimeAdapter[] = Array.isArray(adapters)
    ? adapters
    : Object.values(adapters).filter((a): a is RuntimeAdapter => Boolean(a));
  return {
    async invalidateRuntimesForIntegration(tenantId, userId, integrationId) {
      const results = await Promise.all(
        list.map((adapter) =>
          adapter.invalidateRuntimesForIntegration?.(tenantId, userId, integrationId) ??
          Promise.resolve([] as string[])
        )
      );
      return results.flat();
    }
  };
}
