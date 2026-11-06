import type { Redis } from "ioredis";

// Opaque id of the integration that runs an OAuth flow, for example "github".
// Core does not list the ids, so that an overlay can use its own id. The id
// goes into the Redis key and into the browser binding cookie name. Thus it
// must start with a lower-case letter and contain only lower-case letters,
// digits, "_" and "-". Each use checks the id and throws if it is not valid.
export type IntegrationOAuthProvider = string;

const OAUTH_PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export function assertIntegrationOAuthProvider(provider: IntegrationOAuthProvider): void {
  if (!OAUTH_PROVIDER_ID_PATTERN.test(provider)) {
    throw new Error(`Invalid OAuth provider id: ${JSON.stringify(provider)}`);
  }
}

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
    assertIntegrationOAuthProvider(provider);
    return `integration_oauth_state:${provider}:${jti}`;
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [key, state] of this.local) {
      if (state.expiresAt <= now) this.local.delete(key);
    }
  }
}
