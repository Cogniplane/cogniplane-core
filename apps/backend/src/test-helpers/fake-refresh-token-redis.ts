import type { Redis } from "ioredis";

import type { RefreshTokenRedis } from "../lib/refresh-token-store.js";

/** One captured `set(...)` invocation, including the TTL options. */
export type FakeRedisSetCall = {
  key: string;
  value: string;
  mode: "EX";
  ttlSeconds: number;
};

/**
 * Map-backed stand-in for the three Redis methods `refresh-token-store` uses.
 * Exposes the inner Map so tests can inspect/seed Redis state directly
 * (`fake.store.set("refresh_family:fid-1", "revoked")`) without having to
 * round-trip through the API.
 *
 * `setCalls` additionally records the FULL argument tuple of every `set()`
 * (key, value, `EX` mode, ttlSeconds) so tests can assert the TTL is bounded —
 * an unbounded revoked-family key would be a security smell. The `store` Map
 * only holds key→value, so the TTL is observable solely through `setCalls`.
 */
export class FakeRefreshTokenRedis implements RefreshTokenRedis {
  readonly store = new Map<string, string>();
  readonly setCalls: FakeRedisSetCall[] = [];
  /**
   * Remaining TTL per key, in milliseconds. Modelled because the restore
   * script copies the family key's PTTL onto the jti it restores — a fake that
   * ignored TTLs could not tell a correctly restored lifetime from a silently
   * extended one.
   */
  readonly ttlMs = new Map<string, number>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async getdel(key: string): Promise<string | null> {
    const value = this.store.get(key) ?? null;
    if (value !== null) {
      this.store.delete(key);
    }
    return value;
  }

  async eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown> {
    if (script.includes("refresh-token-issue-v1") && numberOfKeys === 3) {
      const [jtiKey, familyKey, loginAtKey, familyId, revoked, loginAt, absoluteTtl, ttl, active] =
        args;
      if (
        !jtiKey ||
        !familyKey ||
        !loginAtKey ||
        !familyId ||
        !revoked ||
        !loginAt ||
        !absoluteTtl ||
        !ttl ||
        !active
      ) {
        throw new Error("Invalid refresh issue script arguments");
      }
      if (this.store.get(familyKey) === revoked) return 0;
      if (!this.store.has(loginAtKey)) {
        await this.set(loginAtKey, loginAt, "EX", Number(absoluteTtl));
      }
      await this.set(jtiKey, familyId, "EX", Number(ttl));
      await this.set(familyKey, active, "EX", Number(ttl));
      return 1;
    }

    if (script.includes("refresh-token-restore-v1") && numberOfKeys === 3) {
      const [jtiKey, familyKey, rotationKey, familyId, pendingPrefix, active] = args;
      if (!jtiKey || !familyKey || !rotationKey || !familyId || !pendingPrefix || !active) {
        throw new Error("Invalid refresh restore script arguments");
      }
      // A completed rotation must keep its cached result.
      const marker = this.store.get(rotationKey);
      if (marker !== undefined && !marker.startsWith(pendingPrefix)) return 0;
      // Never resurrect a jti into a family that is gone or revoked.
      if (this.store.get(familyKey) !== active) return 0;
      const ttlMs = this.ttlMs.get(familyKey);
      if (ttlMs === undefined || ttlMs <= 0) return 0;
      this.store.delete(rotationKey);
      this.store.set(jtiKey, familyId);
      this.ttlMs.set(jtiKey, ttlMs);
      return 1;
    }

    if (!script.includes("refresh-token-rotation-claim-v1") || numberOfKeys !== 4) {
      throw new Error("Unsupported fake Redis script");
    }

    const [jtiKey, familyKey, rotationKey, loginAtKey] = args;
    const [claimedFamily, revoked, pendingPrefix, grace, active, now, absoluteLifetime, familyTtl] =
      args.slice(4);
    if (
      !jtiKey ||
      !familyKey ||
      !rotationKey ||
      !loginAtKey ||
      !claimedFamily ||
      !revoked ||
      !pendingPrefix ||
      !grace ||
      !active ||
      !now ||
      !absoluteLifetime ||
      !familyTtl
    ) {
      throw new Error("Invalid refresh rotation script arguments");
    }

    const familyState = this.store.get(familyKey);
    if (familyState === revoked) return [2];
    const loginAt = Number(this.store.get(loginAtKey));
    if (
      familyState === active &&
      (!Number.isFinite(loginAt) || Number(now) - loginAt >= Number(absoluteLifetime))
    ) {
      await this.set(familyKey, revoked, "EX", Number(familyTtl));
      return [5];
    }

    const consumed = this.store.get(jtiKey);
    if (consumed !== undefined) {
      this.store.delete(jtiKey);
      if (consumed !== claimedFamily) return [1, consumed];
      await this.set(rotationKey, `${pendingPrefix}${consumed}`, "EX", Number(grace));
      return [0, consumed];
    }

    const rotation = this.store.get(rotationKey);
    if (rotation !== undefined) return [3, rotation];
    if (familyState === active) return [1, claimedFamily];
    return [4];
  }

  async set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown> {
    this.setCalls.push({ key, value, mode, ttlSeconds });
    this.store.set(key, value);
    this.ttlMs.set(key, ttlSeconds * 1000);
    return "OK";
  }

  /**
   * Cast helper so the fake can be `app.decorate`d as `redis` (typed as the
   * full ioredis `Redis`). Only the methods above are exercised by the
   * auth route; everything else would throw at runtime if hit.
   */
  asAppRedis(): Redis {
    return this as unknown as Redis;
  }
}
