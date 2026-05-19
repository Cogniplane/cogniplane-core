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

let instance: Redis | null = null;

export function getRedis(config: AppConfig, logger: RedisLogger = defaultRedisLogger): Redis | null {
  if (!config.REDIS_URL) return null;

  if (!instance) {
    instance = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: true
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
