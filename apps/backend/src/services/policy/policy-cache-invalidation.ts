import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";

import { RedisSubscription } from "../../lib/redis-subscription.js";

const POLICY_CACHE_INVALIDATION_CHANNEL = "cogniplane:policy-cache:invalidate:v1";
const MAX_TENANT_ID_LENGTH = 512;

export type PolicyInvalidationSubscription = {
  /** Settles after the first subscribe attempt. It does not reject. */
  ready: Promise<unknown>;
  /** Stops the subscription, also while the first attempt runs. */
  close(): Promise<void> | void;
};

export type PolicyInvalidationBus = {
  subscribe(onInvalidate: (tenantId: string) => void): PolicyInvalidationSubscription;
  publish(tenantId: string): Promise<void>;
};

/**
 * Redis pub/sub bridge used to evict per-tenant policy caches across replicas.
 * The subscription follows the rule in lib/redis-subscription.ts; the rule
 * cache TTL is the fallback while it is not subscribed.
 */
export class RedisPolicyInvalidationBus implements PolicyInvalidationBus {
  constructor(
    private readonly publisher: Redis,
    private readonly logger: Pick<FastifyBaseLogger, "warn">
  ) {}

  subscribe(onInvalidate: (tenantId: string) => void): PolicyInvalidationSubscription {
    const { subscription, ready } = RedisSubscription.open({
      connect: () => this.publisher.duplicate(),
      channel: POLICY_CACHE_INVALIDATION_CHANNEL,
      name: "policy cache invalidation",
      logger: this.logger,
      onMessage: (tenantId) => {
        if (!tenantId || tenantId.length > MAX_TENANT_ID_LENGTH) {
          this.logger.warn(
            { tenantIdLength: tenantId.length },
            "ignoring malformed policy cache invalidation message"
          );
          return;
        }
        onInvalidate(tenantId);
      }
    });
    return { ready, close: () => subscription.close() };
  }

  async publish(tenantId: string): Promise<void> {
    await this.publisher.publish(POLICY_CACHE_INVALIDATION_CHANNEL, tenantId);
  }
}
