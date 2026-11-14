import { Redis } from "ioredis";

import type { AppConfig } from "../config.js";

export type RedisLogger = {
  error(meta: object, msg: string): void;
};

const defaultRedisLogger: RedisLogger = {
  error(meta, msg) {
    console.error(JSON.stringify({ level: "error", msg, ...meta }));
  }
};

/**
 * The longest wait for one command of the shared client, also while the
 * command waits in the offline queue for a reconnect. Without it, a command
 * on a half-open connection (a failover that leaves the socket open) never
 * settles, and a request that waits for a rate limit keeps its turn slot or
 * admin slot. A command that times out rejects; the request limits then fail
 * closed with 503 (`RequestLimitsUnavailableError`).
 *
 * A client from `duplicate()` copies this limit. A client that runs blocking
 * commands sets a longer one (`TurnCoordinationBus.reader`).
 */
export const REDIS_COMMAND_TIMEOUT_MS = 2_000;

let instance: Redis | null = null;

export function getRedis(config: AppConfig, logger: RedisLogger = defaultRedisLogger): Redis | null {
  if (!config.REDIS_URL) return null;

  if (!instance) {
    instance = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      commandTimeout: REDIS_COMMAND_TIMEOUT_MS
    });
    // Prevent unhandled 'error' events from crashing the process.
    // ioredis retries internally; persistent failures surface as rejected promises at call sites.
    instance.on("error", (err) => {
      logger.error({ err: err.message }, "redis connection error");
    });
  }
  return instance;
}

export async function closeRedis(): Promise<void> {
  if (instance) {
    await instance.quit();
    instance = null;
  }
}
