import type { FastifyInstance } from "fastify";

import type { NotionConnectionService } from "./notion-connection-service.js";

export const NOTION_OAUTH_CALLBACK_PATHS = ["/integrations/notion/callback"] as const;

export function registerNotionOAuthRoutes(
  app: FastifyInstance,
  connections: NotionConnectionService
): void {
  app.get("/integrations/notion/callback", async (request, reply) => {
    const query = request.query as {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
    };
    if (query.error) {
      const reason = encodeURIComponent(query.error_description ?? query.error);
      return reply.redirect(`/settings/notion?notionAuth=error&reason=${reason}`);
    }
    const redirectUrl = await connections.completeAuthorization({
      code: query.code ?? null,
      state: query.state ?? null
    });
    return reply.redirect(redirectUrl);
  });
}
