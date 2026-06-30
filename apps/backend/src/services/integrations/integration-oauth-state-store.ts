import type { Redis } from "ioredis";

export type IntegrationOAuthProvider = "github" | "notion";

type OAuthStateRedis = Pick<Redis, "getdel" | "set">;

type LocalState = {
  expiresAt: number;
};

export class IntegrationOAuthStateStore {
  private readonly local = new Map<string, LocalState>();

  constructor(private readonly redis?: OAuthStateRedis | null) {}

  async issue(provider: IntegrationOAuthProvider, jti: string, ttlSeconds: number): Promise<void> {
    const key = this.key(provider, jti);
    if (this.redis) {
      await this.redis.set(key, "issued", "EX", ttlSeconds);
      return;
    }
    this.sweepExpired();
    this.local.set(key, { expiresAt: Date.now() + ttlSeconds * 1_000 });
  }

  async consume(provider: IntegrationOAuthProvider, jti: string): Promise<boolean> {
    const key = this.key(provider, jti);
    if (this.redis) {
      return (await this.redis.getdel(key)) === "issued";
    }
    const state = this.local.get(key);
    this.local.delete(key);
    return Boolean(state && state.expiresAt > Date.now());
  }

  private key(provider: IntegrationOAuthProvider, jti: string): string {
    return `integration_oauth_state:${provider}:${jti}`;
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [key, state] of this.local) {
      if (state.expiresAt <= now) this.local.delete(key);
    }
  }
}
