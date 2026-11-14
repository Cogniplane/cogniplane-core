import type { FastifyInstance } from "fastify";

// Public liveness and readiness. Both answer with a bare status. Build
// metadata, uptime and runtime activity are not public: they live behind admin
// authentication in GET /admin/diagnostics (admin-runtime-routes.ts).
//
// External monitors match the body text `"status":"ok"`, so keep that field and
// its value.
export async function registerHealthRoutes(
  app: FastifyInstance,
  options: {
    /** True from the start of the shutdown. The app still serves requests then. */
    isDraining?: () => boolean;
  } = {}
): Promise<void> {
  // Container liveness must remain independent of dependency availability.
  // It stays ok during the shutdown, so the orchestrator does not kill the
  // process while it drains.
  app.get("/health", async () => ({ status: "ok" }));

  app.get("/ready", async (_request, reply) => {
    // A load balancer stops sending new requests to a draining process.
    if (options.isDraining?.()) return reply.code(503).send({ status: "unavailable" });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        app.db.query("SELECT 1"),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error("Readiness probe timed out")), 2_000);
        })
      ]);
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    } finally {
      clearTimeout(deadline);
    }
    return { status: "ok" };
  });
}
