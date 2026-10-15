import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { onTestFinished } from "vitest";

import { registerSessionRoutes, type SessionRouteStores } from "../routes/sessions.js";

/**
 * A Fastify app with only the session routes and a fixed request identity.
 * `stores` is a partial fake. Call it inside a test: the app closes when the
 * test ends.
 */
export async function sessionRoutesApp(
  stores: object,
  auth: Partial<FastifyRequest["auth"]> = {}
): Promise<FastifyInstance> {
  const app = Fastify();
  onTestFinished(() => app.close());
  app.addHook("preHandler", async (request) => {
    request.auth = { userId: "user", tenantId: "tenant", role: "member", isAdmin: false, ...auth };
  });
  await registerSessionRoutes(app, stores as unknown as SessionRouteStores);
  return app;
}
