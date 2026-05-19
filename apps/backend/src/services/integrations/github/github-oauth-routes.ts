import type { FastifyInstance } from "fastify";

import type { GithubConnectionService } from "./github-connection-service.js";

export const GITHUB_OAUTH_CALLBACK_PATHS = [
  "/auth/github/install/callback",
  "/auth/github/user/callback"
] as const;

export function registerGithubOAuthRoutes(
  app: FastifyInstance,
  connections: GithubConnectionService
): void {
  app.get("/auth/github/user/callback", async (request, reply) => {
    const query = request.query as { code?: string; state?: string };
    const redirectUrl = await connections.completeAuthorization({
      code: query.code ?? null,
      state: query.state ?? null
    });
    return reply.redirect(redirectUrl);
  });

  // `/auth/github/install/callback` is reserved for future GitHub App
  // installation flow. The path stays in the public allowlist so that
  // when the route is wired up no auth middleware change is needed.
}
