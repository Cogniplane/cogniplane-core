import { describe, expect, test, vi } from "vitest";

import type { RuntimeAdapter } from "../../runtime-contracts.js";
import { createFanOutRuntimeInvalidator } from "./fan-out-invalidator.js";

function adapterWith(sessions: string[], label: string): RuntimeAdapter & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    id: label,
    hasActiveTurn: () => false,
    createSession: vi.fn(async () => ({ sessionId: "s", runtimeId: "r", runtimePolicy: { id: "p", label: "l", approvalPolicy: "never", approvalReviewer: "user", autoApproveReadOnlyTools: false, policyEnforcementMode: "monitor", allowCommandExecution: false, allowUserTokenForwarding: false, runtimeProvider: "codex", webSearchMode: "off", showEffortSelector: false } })),
    runMessage: vi.fn(async function* () {}),
    abortSession: vi.fn(async () => {}),
    invalidateRuntimesForIntegration: vi.fn(async (tenantId: string, userId: string, integrationId: string) => {
      calls.push({ tenantId, userId, integrationId });
      return sessions;
    }),
    calls
  } as unknown as RuntimeAdapter & { calls: unknown[] };
}

describe("createFanOutRuntimeInvalidator", () => {
  test("fans a reconnect out to every adapter and unions the invalidated session ids", async () => {
    const codex = adapterWith(["c-1", "c-2"], "codex");
    const claude = adapterWith(["cl-1"], "claude-code");
    const invalidator = createFanOutRuntimeInvalidator({ codex, "claude-code": claude });

    const result = await invalidator.invalidateRuntimesForIntegration("t-1", "u-1", "github");

    expect(result.sort()).toEqual(["c-1", "c-2", "cl-1"].sort());
    expect(codex.calls).toEqual([{ tenantId: "t-1", userId: "u-1", integrationId: "github" }]);
    expect(claude.calls).toEqual([{ tenantId: "t-1", userId: "u-1", integrationId: "github" }]);
  });

  test("an adapter without the user-scoped method contributes no sessions (optional guard)", async () => {
    const codex = adapterWith(["c-1"], "codex");
    // claude here omits invalidateRuntimesForIntegration entirely.
    const claude = { id: "claude-code", hasActiveTurn: () => false } as unknown as RuntimeAdapter;
    const invalidator = createFanOutRuntimeInvalidator({ codex, "claude-code": claude });

    const result = await invalidator.invalidateRuntimesForIntegration("t-1", "u-1", "notion");

    expect(result).toEqual(["c-1"]);
  });

  test("satisfies the RuntimeInvalidator contract (single method)", () => {
    const invalidator = createFanOutRuntimeInvalidator({});
    expect(typeof invalidator.invalidateRuntimesForIntegration).toBe("function");
  });
});
