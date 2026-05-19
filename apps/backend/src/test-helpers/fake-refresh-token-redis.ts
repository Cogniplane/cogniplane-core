import type { Redis } from "ioredis";

import type { RefreshTokenRedis } from "../lib/refresh-token-store.js";

/**
 * Map-backed stand-in for the three Redis methods `refresh-token-store` uses.
 * Exposes the inner Map so tests can inspect/seed Redis state directly
 * (`fake.store.set("refresh_family:fid-1", "revoked")`) without having to
 * round-trip through the API.
 */
export class FakeRefreshTokenRedis implements RefreshTokenRedis {
  readonly store = new Map<string, string>();

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

  async set(key: string, value: string): Promise<unknown> {
    this.store.set(key, value);
    return "OK";
  }

  /**
   * Cast helper so the fake can be `app.decorate`d as `redis` (typed as the
   * full ioredis `Redis`). Only the three methods above are exercised by the
   * auth route; everything else would throw at runtime if hit.
   */
  asAppRedis(): Redis {
    return this as unknown as Redis;
  }
}
