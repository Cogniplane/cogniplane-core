import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type {} from "@fastify/cookie";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { AppConfig } from "../../config.js";
import { getJwtSigningKey, resolveJwtVerificationKey } from "../../lib/jwt.js";
import type { IntegrationOAuthProvider } from "./integration-oauth-state-store.js";

/**
 * OAuth plumbing shared by the integration connection services (GitHub,
 * Notion, …). Each service previously carried private copies of these —
 * security-relevant token handling should be patched in one place.
 */

/** Key for signing/verifying the OAuth `state` JWT. */
type IntegrationJwtConfig = Pick<
  AppConfig,
  "JWT_SECRET" | "JWT_KEY_ID" | "JWT_VERIFICATION_KEYS"
>;

export function getSecretKey(config: IntegrationJwtConfig): Uint8Array {
  return getJwtSigningKey(config);
}

export function getVerificationKey(config: IntegrationJwtConfig, kid: unknown): Uint8Array {
  // State JWTs issued before key rotation support had no kid and live for only
  // ten minutes. Accept those under the active key during rolling deployment.
  return resolveJwtVerificationKey(config, kid, { allowMissingKid: true });
}

/** Absolute expiry timestamp from a provider's `expires_in` seconds field. */
export function toIsoFromNow(seconds: number | undefined): string | null {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? new Date(Date.now() + seconds * 1000).toISOString()
    : null;
}

/** Settings-page redirect carrying the connect outcome query params. */
export function buildIntegrationRedirectUrl(
  config: Pick<AppConfig, "API_ORIGIN">,
  pathname: string,
  params: Record<string, string>
): string {
  const url = new URL(pathname, config.API_ORIGIN);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export function mapOAuthProviderError(error: unknown): string {
  if (error === "access_denied") return "access_denied";
  if (error === "server_error" || error === "temporarily_unavailable") {
    return "provider_unavailable";
  }
  return "provider_error";
}

/**
 * Browser binding for the connect flow. The callback is public and the signed
 * `state` names the user who started the flow. Without a binding, an attacker
 * can start a connect and send the provider URL to a victim; the victim's
 * token is then stored on the attacker's account. Authorize sets a random
 * nonce in an httpOnly cookie and puts its SHA-256 in the state. The callback
 * requires the cookie and compares the two.
 */
export type OAuthBrowserBindingCookie = {
  name: string;
  value: string;
  options: {
    httpOnly: true;
    secure: boolean;
    sameSite: "none" | "lax";
    path: string;
    maxAge: number;
  };
};

export function oauthBrowserBindingCookieName(provider: IntegrationOAuthProvider): string {
  return `cogniplane_oauth_bind_${provider}`;
}

function hashBrowserNonce(nonce: string): Buffer {
  return createHash("sha256").update(nonce).digest();
}

export function createOAuthBrowserBinding(
  provider: IntegrationOAuthProvider,
  redirectUri: string,
  ttlSeconds: number
): { nonceHash: string; cookie: OAuthBrowserBindingCookie } {
  const nonce = randomBytes(32).toString("base64url");
  const callback = new URL(redirectUri);
  const secure = callback.protocol === "https:";
  return {
    nonceHash: hashBrowserNonce(nonce).toString("base64url"),
    cookie: {
      name: oauthBrowserBindingCookieName(provider),
      value: nonce,
      options: {
        httpOnly: true,
        // Authorize is a credentialed fetch from the frontend origin. When the
        // frontend and the API are different sites, the browser stores a cookie
        // from that response only with SameSite=None, which requires Secure
        // (same as the refresh and WorkOS flow cookies). The provider then
        // sends the browser to the callback with a top-level GET, which carries
        // the cookie. Plain-http local dev is same-site on localhost, so Lax is
        // sufficient there and Secure is not possible.
        secure,
        sameSite: secure ? "none" : "lax",
        path: callback.pathname,
        maxAge: ttlSeconds
      }
    }
  };
}

/** Constant-time check of the callback cookie against the state's nonce hash. */
export function oauthBrowserBindingMatches(
  nonceHash: unknown,
  browserNonce: string | null | undefined
): boolean {
  if (typeof nonceHash !== "string" || !browserNonce) return false;
  const expected = Buffer.from(nonceHash, "base64url");
  const actual = hashBrowserNonce(browserNonce);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Reads the binding nonce in a callback and clears the cookie. The cookie is
 * single-use, so clear it on every outcome. Authorize scopes it to the
 * redirect URI path, which is the path of this callback request.
 */
export function takeOAuthBrowserNonce(
  request: FastifyRequest,
  reply: FastifyReply,
  provider: IntegrationOAuthProvider
): string | null {
  const name = oauthBrowserBindingCookieName(provider);
  const nonce = request.cookies?.[name];
  reply.clearCookie(name, { path: request.url.split("?")[0] });
  return nonce || null;
}
