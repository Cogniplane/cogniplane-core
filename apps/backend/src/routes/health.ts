import type { FastifyInstance } from "fastify";

// Public liveness and readiness. Both answer with a bare status. Build
// metadata, uptime and runtime activity are not public: they live behind admin
// authentication in GET /admin/diagnostics (admin-runtime-routes.ts).
//
// Monitors match the body text `"status":"ok"` (deploy/homelab/monitor.sh), so
// keep that field and its value.
export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  // Container liveness must remain independent of dependency availability.
  app.get("/health", async () => ({ status: "ok" }));

  app.get("/ready", async (_request, reply) => {
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
