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
//   - Redis is used when configured so all backend replicas share one pin.
//     Local/test deployments without Redis retain an in-memory fallback.
//   - IPv4-mapped IPv6 prefixes (::ffff:1.2.3.4) are normalized to v4 so
//     the same physical peer doesn't get two pins if the listener flips
//     between dual-stack and v4-only.

import { isIP } from "node:net";
import type { Redis } from "ioredis";

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

type PinRedis = Pick<Redis, "eval" | "del">;

const CHECK_AND_PIN = `
  local existing = redis.call('GET', KEYS[1])
  if existing then
    return {0, existing}
  end
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return {1, ARGV[1]}
`;

export class RuntimeEgressIpPinStore {
  private readonly pins = new Map<string, Entry>();

  constructor(
    private readonly ttlMs: number,
    private readonly redis?: PinRedis
  ) {}

  /**
   * On first observation: record the peer IP and return `pinned`.
   * On subsequent calls: return `ok` if the IP matches, `mismatch`
   * otherwise. Stale pins (older than `ttlMs`) are evicted on read so
   * a long-running process can't accumulate dead entries.
   */
  async checkAndPin(runtimeId: string, rawObservedIp: string): Promise<IpPinResult> {
    const observedIp = normalize(rawObservedIp);
    if (isIP(observedIp) === 0) {
      // Not a usable IP — treat as a mismatch against a synthetic
      // expectation so the proxy refuses. This shouldn't fire on real
      // traffic; if it does, the operator wants a 403 + audit row.
      return { kind: "mismatch", expectedIp: "(none)", observedIp: rawObservedIp };
    }

    if (this.redis) {
      const result = (await this.redis.eval(
        CHECK_AND_PIN,
        1,
        `runtime-egress-ip:${runtimeId}`,
        observedIp,
        String(this.ttlMs)
      )) as [number, string];
      const [created, expectedIp] = result;
      if (created === 1) return { kind: "pinned", ip: observedIp };
      if (expectedIp === observedIp) return { kind: "ok", ip: observedIp };
      return { kind: "mismatch", expectedIp, observedIp };
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
  async clear(runtimeId: string): Promise<void> {
    if (this.redis) {
      await this.redis.del(`runtime-egress-ip:${runtimeId}`);
      return;
    }
    this.pins.delete(runtimeId);
  }
}
