import { buildApp } from "./app.js";

const app = await buildApp();

// Crash on programmer errors instead of limping along in an undefined state.
// An unhandled rejection or uncaught exception means an invariant we relied on
// is broken; the orchestrator (ECS/Docker) restarts a clean process. We log,
// attempt a best-effort graceful close (so onClose cleanup fires), then exit.
let shuttingDown = false;

// `exitCode` is the code to use after a SUCCESSFUL graceful close: 0 for a
// requested stop (SIGTERM/SIGINT), 1 for a programmer-error crash
// (unhandledRejection/uncaughtException) so orchestrators that restart/alert on
// non-zero exits don't mistake a crash for a clean stop. A failed close always
// exits 1.
async function shutdown(reason: string, exitCode: number, error?: unknown): Promise<never> {
  if (shuttingDown) {
    // A second signal/error while we're already closing: hard-exit immediately
    // with the same code the in-flight shutdown is already heading for (0 for a
    // requested stop, 1 for a crash).
    process.exit(exitCode);
  }
  shuttingDown = true;
  if (error) {
    app.log.error({ err: error }, `shutting down: ${reason}`);
  } else {
    app.log.info(`shutting down: ${reason}`);
  }
  try {
    await app.close();
    process.exit(exitCode);
  } catch (closeError) {
    app.log.error({ err: closeError }, "error during graceful shutdown");
    process.exit(1);
  }
}

process.on("unhandledRejection", (reason) => {
  void shutdown("unhandledRejection", 1, reason);
});
process.on("uncaughtException", (error) => {
  void shutdown("uncaughtException", 1, error);
});

// SIGTERM (orchestrator stop) / SIGINT (Ctrl-C) → graceful close so the
// onClose hook tears down workers, runtimes, Redis, and DB pools.
process.on("SIGTERM", () => {
  void shutdown("SIGTERM", 0);
});
process.on("SIGINT", () => {
  void shutdown("SIGINT", 0);
});

try {
  await app.listen({
    host: app.config.API_HOST,
    port: app.config.API_PORT
  });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
