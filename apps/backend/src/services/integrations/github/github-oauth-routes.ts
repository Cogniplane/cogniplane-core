import type { FastifyInstance } from "fastify";

import type { RequestLimitsInterface } from "../../request-limits.js";
import { enforceOAuthCallbackRateLimit } from "../oauth-callback-rate-limit.js";
import { buildIntegrationRedirectUrl } from "../integration-oauth-helpers.js";
import type { GithubConnectionService } from "./github-connection-service.js";

export const GITHUB_OAUTH_CALLBACK_PATHS = [
  "/auth/github/install/callback",
  "/auth/github/user/callback"
] as const;

export function registerGithubOAuthRoutes(
  app: FastifyInstance,
  connections: GithubConnectionService,
  limits?: RequestLimitsInterface
): void {
  app.get("/auth/github/user/callback", async (request, reply) => {
    if (await enforceOAuthCallbackRateLimit(request, reply, limits)) return reply;
    const query = request.query as {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
    };
    if (query.error) {
      return reply.redirect(
        buildIntegrationRedirectUrl(app.config, "/settings/github", {
          githubAuth: "error",
          reason: query.error_description ?? query.error
        })
      );
    }
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
