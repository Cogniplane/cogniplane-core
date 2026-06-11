import type { FastifyInstance } from "fastify";

import type { RequestLimitsInterface } from "../../request-limits.js";
import { enforceOAuthCallbackRateLimit } from "../oauth-callback-rate-limit.js";
import { buildIntegrationRedirectUrl } from "../integration-oauth-helpers.js";
import type { NotionConnectionService } from "./notion-connection-service.js";

export const NOTION_OAUTH_CALLBACK_PATHS = ["/integrations/notion/callback"] as const;

export function registerNotionOAuthRoutes(
  app: FastifyInstance,
  connections: NotionConnectionService,
  limits?: RequestLimitsInterface
): void {
  app.get("/integrations/notion/callback", async (request, reply) => {
    if (await enforceOAuthCallbackRateLimit(request, reply, limits)) return reply;
    const query = request.query as {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
    };
    if (query.error) {
      return reply.redirect(
        buildIntegrationRedirectUrl(app.config, "/settings/notion", {
          notionAuth: "error",
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
}
