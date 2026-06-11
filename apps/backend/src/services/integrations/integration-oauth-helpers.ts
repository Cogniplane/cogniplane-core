import type { AppConfig } from "../../config.js";

/**
 * OAuth plumbing shared by the integration connection services (GitHub,
 * Notion, …). Each service previously carried private copies of these —
 * security-relevant token handling should be patched in one place.
 */

/** Key for signing/verifying the OAuth `state` JWT. */
export function getSecretKey(config: Pick<AppConfig, "JWT_SECRET">): Uint8Array {
  return new TextEncoder().encode(config.JWT_SECRET);
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
