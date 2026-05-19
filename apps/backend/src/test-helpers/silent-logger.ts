import type { FastifyBaseLogger } from "fastify";

/**
 * Returns a no-op logger typed as `FastifyBaseLogger`. Use in tests instead of
 * `{ ... } as any` so signature drift in Fastify's logger contract surfaces at
 * compile time.
 */
export function createSilentLogger(): FastifyBaseLogger {
  const logger: FastifyBaseLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child: () => logger,
    level: "silent",
    silent: () => {}
  } as FastifyBaseLogger;
  return logger;
}
