import type { AppConfig } from "../../config.js";
import { getJwtSigningKey, resolveJwtVerificationKey } from "../../lib/jwt.js";

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
