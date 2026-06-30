import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";

const POLICY_CACHE_INVALIDATION_CHANNEL = "cogniplane:policy-cache:invalidate:v1";
const MAX_TENANT_ID_LENGTH = 512;

export type PolicyInvalidationBus = {
  subscribe(onInvalidate: (tenantId: string) => void): Promise<() => Promise<void>>;
  publish(tenantId: string): Promise<void>;
};

/** Redis pub/sub bridge used to evict per-tenant policy caches across replicas. */
export class RedisPolicyInvalidationBus implements PolicyInvalidationBus {
  private readonly subscriber: Redis;

  constructor(
    private readonly publisher: Redis,
    private readonly logger: Pick<FastifyBaseLogger, "warn">
  ) {
    this.subscriber = publisher.duplicate();
    this.subscriber.on("error", (err) => {
      this.logger.warn({ err }, "policy cache invalidation subscriber error");
    });
  }

  async subscribe(onInvalidate: (tenantId: string) => void): Promise<() => Promise<void>> {
    const onMessage = (channel: string, tenantId: string) => {
      if (channel !== POLICY_CACHE_INVALIDATION_CHANNEL) return;
      if (!tenantId || tenantId.length > MAX_TENANT_ID_LENGTH) {
        this.logger.warn(
          { tenantIdLength: tenantId.length },
          "ignoring malformed policy cache invalidation message"
        );
        return;
      }
      onInvalidate(tenantId);
    };

    this.subscriber.on("message", onMessage);
    await this.subscriber.subscribe(POLICY_CACHE_INVALIDATION_CHANNEL);

    return async () => {
      this.subscriber.removeListener("message", onMessage);
      await this.subscriber.unsubscribe(POLICY_CACHE_INVALIDATION_CHANNEL);
      await this.subscriber.quit();
    };
  }

  async publish(tenantId: string): Promise<void> {
    await this.publisher.publish(POLICY_CACHE_INVALIDATION_CHANNEL, tenantId);
  }
}
