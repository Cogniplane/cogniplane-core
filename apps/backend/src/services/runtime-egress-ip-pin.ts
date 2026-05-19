// Per-runtime egress IP pinning for the LLM proxy.
//
// The CIDR allowlist (E2B_EGRESS_CIDRS) restricts incoming /llm/* calls
// to the sandbox provider's documented NAT range. That narrows a leaked
// rt_* token's blast radius from "anywhere on the internet" to "anyone
// running code inside E2B." Pinning narrows further: the first observed
// peer IP for a given runtimeId is recorded, and subsequent calls for
// the same runtimeId must come from that exact IP. A leaked token used
// from a different sandbox in the same NAT range fails.
//
// Caveats:
//   - Opportunistic. If an attacker beats the legitimate sandbox to the
//     first request, the attacker pins their own IP and the real sandbox
//     fails. The leak window is short (workspace boot → first turn is
//     seconds) and the CIDR allowlist gates the attacker's location.
//   - Single-process scope. Pin state isn't shared across backend
//     instances. Same caveat as ActiveTurnMessageMap / ActiveTurnsRegistry.
//     Multi-instance correctness would need Redis or a DB column.
//   - IPv4-mapped IPv6 prefixes (::ffff:1.2.3.4) are normalized to v4 so
//     the same physical peer doesn't get two pins if the listener flips
//     between dual-stack and v4-only.

import { isIP } from "node:net";

export type IpPinResult =
  | { kind: "pinned"; ip: string }
  | { kind: "ok"; ip: string }
  | { kind: "mismatch"; expectedIp: string; observedIp: string };

type Entry = {
  ip: string;
  pinnedAt: number;
};

function normalize(rawIp: string): string {
  if (rawIp.startsWith("::ffff:")) return rawIp.slice("::ffff:".length);
  return rawIp;
}

export class RuntimeEgressIpPinStore {
  private readonly pins = new Map<string, Entry>();

  constructor(private readonly ttlMs: number) {}

  /**
   * On first observation: record the peer IP and return `pinned`.
   * On subsequent calls: return `ok` if the IP matches, `mismatch`
   * otherwise. Stale pins (older than `ttlMs`) are evicted on read so
   * a long-running process can't accumulate dead entries.
   */
  checkAndPin(runtimeId: string, rawObservedIp: string): IpPinResult {
    const observedIp = normalize(rawObservedIp);
    if (isIP(observedIp) === 0) {
      // Not a usable IP — treat as a mismatch against a synthetic
      // expectation so the proxy refuses. This shouldn't fire on real
      // traffic; if it does, the operator wants a 403 + audit row.
      return { kind: "mismatch", expectedIp: "(none)", observedIp: rawObservedIp };
    }

    const existing = this.pins.get(runtimeId);
    if (existing) {
      if (Date.now() - existing.pinnedAt > this.ttlMs) {
        this.pins.delete(runtimeId);
        // Re-pin under the same runtimeId; the rt_* token would have
        // already been rejected by auth if expired, so reaching here
        // with a fresh observation is a legitimate continuation.
      } else if (existing.ip === observedIp) {
        return { kind: "ok", ip: observedIp };
      } else {
        return { kind: "mismatch", expectedIp: existing.ip, observedIp };
      }
    }

    this.pins.set(runtimeId, { ip: observedIp, pinnedAt: Date.now() });
    return { kind: "pinned", ip: observedIp };
  }

  /** Explicit teardown hook for tests + runtime termination paths. */
  clear(runtimeId: string): void {
    this.pins.delete(runtimeId);
  }
}
