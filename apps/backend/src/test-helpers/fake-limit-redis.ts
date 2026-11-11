import type { Redis } from "ioredis";

/**
 * The Redis commands of `RedisRequestLimits`, in memory: its two Lua scripts
 * (found by their version tag) and PTTL. Tests use it to check the keys and
 * windows that the real limiter writes, without a Redis server.
 */
export class FakeLimitRedis {
  readonly counters = new Map<string, { count: number; expiresAtMs: number | null }>();

  async eval(script: string, _numKeys: number, key: string, ttlMs?: string): Promise<number> {
    this.dropExpired(key);
    const entry = this.counters.get(key);
    if (script.includes("request-limit-incr-v1")) {
      const next = { count: (entry?.count ?? 0) + 1, expiresAtMs: entry?.expiresAtMs ?? null };
      if (next.expiresAtMs === null) next.expiresAtMs = Date.now() + Number(ttlMs);
      this.counters.set(key, next);
      return next.count;
    }
    if (script.includes("request-limit-decr-v1")) {
      if (!entry || entry.count <= 0) return 0;
      entry.count -= 1;
      return entry.count;
    }
    throw new Error("FakeLimitRedis: unknown script");
  }

  async pttl(key: string): Promise<number> {
    this.dropExpired(key);
    const entry = this.counters.get(key);
    if (!entry) return -2;
    return entry.expiresAtMs === null ? -1 : entry.expiresAtMs - Date.now();
  }

  /** The window that the first INCR of `key` set, in milliseconds. */
  windowOf(key: string): number | null {
    const entry = this.counters.get(key);
    return entry?.expiresAtMs == null ? null : entry.expiresAtMs - Date.now();
  }

  asRedis(): Redis {
    return this as unknown as Redis;
  }

  private dropExpired(key: string): void {
    const entry = this.counters.get(key);
    if (entry?.expiresAtMs != null && entry.expiresAtMs <= Date.now()) this.counters.delete(key);
  }
}
