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
  app.get("/health", async () => ({
    status: "ok",
    uptimeSeconds: Math.round(process.uptime()),
    version: {
      sha: process.env.BUILD_SHA ?? "dev",
      buildDate: process.env.BUILD_DATE ?? ""
    },
    runtimes: stores.deepAgentsAdapter.getHealthSnapshot()
  }));
}
