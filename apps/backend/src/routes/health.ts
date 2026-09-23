import type { FastifyInstance } from "fastify";

import type { AppDependencies } from "../app-dependencies.js";

export function buildHealthRouteStores(deps: AppDependencies) {
  return {
    deepAgentsAdapter: deps.deepAgentsAdapter
  };
}

export type HealthRouteStores = {
  deepAgentsAdapter: Pick<AppDependencies["deepAgentsAdapter"], "getHealthSnapshot">;
};

export async function registerHealthRoutes(
  app: FastifyInstance,
  stores: HealthRouteStores
): Promise<void> {
  const snapshot = () => ({
    status: "ok",
    uptimeSeconds: Math.round(process.uptime()),
    version: {
      sha: process.env.BUILD_SHA ?? "dev",
      buildDate: process.env.BUILD_DATE ?? ""
    },
    runtimes: stores.deepAgentsAdapter.getHealthSnapshot()
  });

  // Container liveness must remain independent of dependency availability.
  app.get("/health", async () => snapshot());

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
    return snapshot();
  });
}
