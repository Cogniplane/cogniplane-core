import type { FastifyInstance } from "fastify";

import {
  buildIntegrationRedirectUrl,
  mapOAuthProviderError,
  takeOAuthBrowserNonce
} from "../../../../apps/backend/src/services/integrations/integration-oauth-helpers.js";
import { enforceOAuthCallbackRateLimit } from "../../../../apps/backend/src/services/integrations/oauth-callback-rate-limit.js";
import type { RequestLimitsInterface } from "../../../../apps/backend/src/services/request-limits.js";
import type { MicrosoftConnectionService } from "./microsoft-connection-service.js";

export const MICROSOFT_OAUTH_CALLBACK_PATHS = ["/integrations/microsoft/callback"] as const;

export function registerMicrosoftOAuthRoutes(
  app: FastifyInstance,
  connections: Pick<MicrosoftConnectionService, "completeAuthorization">,
  limits?: Pick<RequestLimitsInterface, "consumeRateLimit">
): void {
  app.get("/integrations/microsoft/callback", async (request, reply) => {
    if (await enforceOAuthCallbackRateLimit(request, reply, limits)) return reply;
    const browserNonce = takeOAuthBrowserNonce(request, reply, "microsoft");
    const query = request.query as {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
    };
    if (query.error) {
      // Redirect to the frontend origin with a fixed reason code. The provider's
      // own text is never reflected into the URL.
      return reply.redirect(
        buildIntegrationRedirectUrl(app.config, "/settings/microsoft", {
          microsoftAuth: "error",
          reason: mapOAuthProviderError(query.error)
        })
      );
    }
    const redirectUrl = await connections.completeAuthorization({
      code: query.code ?? null,
      state: query.state ?? null,
      browserNonce
    });
    return reply.redirect(redirectUrl);
  });
}
