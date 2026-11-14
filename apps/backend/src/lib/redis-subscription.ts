import type { Redis } from "ioredis";

// One rule for every Redis pub/sub channel of the backend. Each channel has a
// fallback that does not need the channel, so a channel only makes a change
// arrive sooner:
//
// - The first subscribe attempt runs at startup. Startup waits for it up to
//   SUBSCRIBE_ATTEMPT_TIMEOUT_MS, then continues also when it failed.
// - A failed attempt logs one warning and closes its connection. The next
//   attempt starts after a delay that doubles up to SUBSCRIBE_RETRY_MAX_MS.
//   One attempt runs at a time.
// - After a successful subscribe, ioredis reconnects and subscribes again by
//   itself (autoResubscribe). The retry here covers only the first subscribe.
// - close() stops the retries, also during an attempt, and closes the
//   connection. After close(), no attempt starts.

export const SUBSCRIBE_ATTEMPT_TIMEOUT_MS = 5_000;
export const SUBSCRIBE_RETRY_MIN_MS = 1_000;
export const SUBSCRIBE_RETRY_MAX_MS = 30_000;

export type RedisSubscriptionLogger = {
  warn(meta: object, message: string): void;
};

/** The slice of ioredis that a subscription uses. */
export type SubscriberRedis = Pick<Redis, "subscribe" | "disconnect" | "on" | "removeAllListeners">;

export type RedisSubscriptionOptions = {
  /** Gives a new connection for each attempt (`redis.duplicate()`). */
  connect: () => SubscriberRedis;
  channel: string;
  onMessage: (payload: string) => void;
  logger: RedisSubscriptionLogger;
  /** Fixed text for the logs, such as "policy cache invalidation". */
  name: string;
  /** Tests only; production uses the constants above. */
  attemptTimeoutMs?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
};

export class RedisSubscription {
  private client: SubscriberRedis | null = null;
  private attempt: Promise<boolean> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelayMs: number;
  private closed = false;
  private subscribed = false;

  private constructor(private readonly options: RedisSubscriptionOptions) {
    this.retryDelayMs = options.retryMinMs ?? SUBSCRIBE_RETRY_MIN_MS;
  }

  /**
   * Starts the subscription. The caller gets the object at once, so close()
   * works also while the first attempt runs. `ready` settles with the result
   * of the first attempt (true when subscribed) and never rejects: after a
   * failure, the retries run in the background.
   */
  static open(options: RedisSubscriptionOptions): { subscription: RedisSubscription; ready: Promise<boolean> } {
    const subscription = new RedisSubscription(options);
    return { subscription, ready: subscription.runAttempt() };
  }

  /** True while a connection holds the subscription. */
  get isSubscribed(): boolean {
    return this.subscribed;
  }

  /** Stops the retries and closes the connection, also during an attempt. */
  close(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    // A pending attempt then fails (ioredis rejects its queued command, or
    // the attempt times out) and starts no retry.
    this.closeClient();
  }

  private runAttempt(): Promise<boolean> {
    this.attempt ??= this.subscribeOnce().finally(() => {
      this.attempt = null;
    });
    return this.attempt;
  }

  private async subscribeOnce(): Promise<boolean> {
    if (this.closed) return false;
    const { channel, logger, name } = this.options;
    const client = this.options.connect();
    this.client = client;
    // A connection without an error listener would crash the process.
    client.on("error", (err: unknown) => {
      if (this.subscribed && this.client === client) {
        logger.warn({ err }, `Redis subscriber error: ${name}`);
      }
    });
    client.on("message", (messageChannel: string, payload: string) => {
      if (this.closed || this.client !== client || messageChannel !== channel) return;
      this.options.onMessage(payload);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutMs = this.options.attemptTimeoutMs ?? SUBSCRIBE_ATTEMPT_TIMEOUT_MS;
      await Promise.race([
        client.subscribe(channel),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Redis subscribe timed out")), timeoutMs);
          timer.unref?.();
        })
      ]);
    } catch (err) {
      if (this.client === client) this.closeClient();
      if (this.closed) return false;
      logger.warn({ err, retryInMs: this.retryDelayMs }, `Redis subscribe failed; retrying in the background: ${name}`);
      this.scheduleRetry();
      return false;
    } finally {
      clearTimeout(timer);
    }
    if (this.closed || this.client !== client) {
      if (this.client === client) this.closeClient();
      return false;
    }
    this.subscribed = true;
    this.retryDelayMs = this.options.retryMinMs ?? SUBSCRIBE_RETRY_MIN_MS;
    return true;
  }

  private scheduleRetry(): void {
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(delay * 2, this.options.retryMaxMs ?? SUBSCRIBE_RETRY_MAX_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.runAttempt();
    }, delay);
    this.retryTimer.unref?.();
  }

  private closeClient(): void {
    const client = this.client;
    if (!client) return;
    this.client = null;
    this.subscribed = false;
    client.removeAllListeners("message");
    // Keep the error listener: the connection can still report an error
    // while it closes.
    client.disconnect();
  }
}
