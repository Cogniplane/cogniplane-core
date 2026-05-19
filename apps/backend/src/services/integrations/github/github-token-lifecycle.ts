import type { AppConfig } from "../../../config.js";
import { decrypt, encrypt } from "../../../lib/crypto-utils.js";
import { refreshUserAccessToken } from "./github-api-client.js";
import type { GithubConnectionRecord, GithubConnectionStore } from "./github-connection-store.js";

const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

export function parseScopes(scope: string | undefined): string[] {
  return scope
    ? scope
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

export function toIsoFromNow(seconds: number | undefined): string | null {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? new Date(Date.now() + seconds * 1000).toISOString()
    : null;
}

/**
 * Returns true when the stored expiry is within the refresh skew window.
 * A null expiry is treated as "no refresh needed" (false) — callers that
 * store tokens without a recorded expiry should skip the refresh flow
 * rather than forcing one.
 */
export function shouldRefreshToken(value: string | null): boolean {
  if (!value) {
    return false;
  }

  const expiresAt = new Date(value).getTime();
  return Number.isFinite(expiresAt) && expiresAt - Date.now() <= TOKEN_REFRESH_SKEW_MS;
}

/**
 * Returns true only when the expiry is in the past. A null expiry is
 * treated as "not expired" (false); this matches the semantics used by
 * the refresh path, which writes a null expiry when the provider omits
 * one and we still want the token to be considered valid.
 */
export function isTokenExpired(value: string | null): boolean {
  if (!value) {
    return false;
  }

  const expiresAt = new Date(value).getTime();
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

/**
 * Refreshes a user's GitHub access token using the stored refresh token,
 * encrypts the result, and persists it via the connection store. Returns
 * the original record unchanged if no refresh token is on file or the
 * exchange fails.
 */
export async function refreshAndPersistAccessToken(
  config: AppConfig,
  store: GithubConnectionStore,
  record: GithubConnectionRecord
): Promise<GithubConnectionRecord> {
  if (!record.refreshTokenEncrypted) {
    return record;
  }

  const refreshToken = decrypt(record.refreshTokenEncrypted, config.DATA_ENCRYPTION_SECRET);
  const payload = await refreshUserAccessToken(config, refreshToken);
  if (!payload || !payload.access_token) {
    return record;
  }

  const refreshedScopes = parseScopes(payload.scope);
  return store.upsert({
    tenantId: record.tenantId,
    userId: record.userId,
    githubUserId: record.githubUserId,
    githubLogin: record.githubLogin,
    githubName: record.githubName,
    githubEmail: record.githubEmail,
    githubAvatarUrl: record.githubAvatarUrl,
    tokenType: payload.token_type ?? record.tokenType,
    grantedScopes: refreshedScopes.length > 0 ? refreshedScopes : record.grantedScopes,
    accessTokenEncrypted: encrypt(payload.access_token, config.DATA_ENCRYPTION_SECRET),
    accessTokenExpiresAt: toIsoFromNow(payload.expires_in),
    refreshTokenEncrypted: payload.refresh_token
      ? encrypt(payload.refresh_token, config.DATA_ENCRYPTION_SECRET)
      : record.refreshTokenEncrypted,
    refreshTokenExpiresAt:
      toIsoFromNow(payload.refresh_token_expires_in) ?? record.refreshTokenExpiresAt,
    tokenLastRefreshedAt: new Date().toISOString()
  });
}
