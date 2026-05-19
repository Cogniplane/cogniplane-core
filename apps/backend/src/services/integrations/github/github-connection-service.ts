import { SignJWT, jwtVerify } from "jose";

import type { AppConfig } from "../../../config.js";
import { decrypt, encrypt } from "../../../lib/crypto-utils.js";
import type { Pool } from "../../../lib/db.js";
import type { AuditEventStore } from "../../audit-event-store.js";
import {
  exchangeUserAuthorizationCode,
  fetchUserProfile,
  selectGithubEmail,
  GITHUB_OAUTH_AUTHORIZE_URL
} from "./github-api-client.js";
import { GithubConnectionNotConfiguredError } from "./github-connection-errors.js";
import type { GithubConnectionRecord, GithubConnectionStore } from "./github-connection-store.js";
import {
  isTokenExpired,
  parseScopes,
  refreshAndPersistAccessToken,
  shouldRefreshToken,
  toIsoFromNow
} from "./github-token-lifecycle.js";
import type { RuntimeInvalidator } from "../contracts.js";

export { GithubConnectionNotConfiguredError } from "./github-connection-errors.js";

const GITHUB_USER_STATE_AUDIENCE = "cogniplane-github-user-connect";
const GITHUB_STATE_ISSUER = "cogniplane";
const GITHUB_STATE_TTL = "10m";

type GithubUserStatePayload = {
  tid: string;
  sub: string;
};

export type GithubUserConnectionSummary = {
  githubUserId: string;
  githubLogin: string;
  githubName: string | null;
  githubEmail: string | null;
  githubAvatarUrl: string | null;
  scopes: string[];
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
  connectedAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
};

export type GithubConnectionStatus = {
  configured: boolean;
  userConnection: GithubUserConnectionSummary | null;
};

export type GithubRuntimeCredentials = {
  login: string;
  name: string | null;
  email: string | null;
  token: string;
};

function getSecretKey(config: AppConfig): Uint8Array {
  return new TextEncoder().encode(config.JWT_SECRET);
}

function isGithubConfigured(config: AppConfig): boolean {
  return Boolean(
    config.GITHUB_OAUTH_CLIENT_ID &&
      config.GITHUB_OAUTH_CLIENT_SECRET &&
      config.GITHUB_OAUTH_REDIRECT_URI
  );
}

function toUserSummary(record: GithubConnectionRecord): GithubUserConnectionSummary {
  return {
    githubUserId: record.githubUserId,
    githubLogin: record.githubLogin,
    githubName: record.githubName,
    githubEmail: record.githubEmail,
    githubAvatarUrl: record.githubAvatarUrl,
    scopes: record.grantedScopes,
    accessTokenExpiresAt: record.accessTokenExpiresAt,
    refreshTokenExpiresAt: record.refreshTokenExpiresAt,
    connectedAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastUsedAt: record.tokenLastUsedAt
  };
}

export class GithubConnectionService {
  constructor(
    private readonly config: AppConfig,
    private readonly _db: Pool,
    private readonly store: GithubConnectionStore,
    private readonly auditEvents?: AuditEventStore,
    private readonly runtimeManager?: RuntimeInvalidator
  ) {}

  async getConnectionStatus(tenantId: string, userId: string): Promise<GithubConnectionStatus> {
    const userConnection = await this.store.get(tenantId, userId);
    return {
      configured: isGithubConfigured(this.config),
      userConnection: userConnection ? toUserSummary(userConnection) : null
    };
  }

  // Cheap presence check used by IntegrationRegistryService at session start.
  async hasConnection(tenantId: string, userId: string): Promise<boolean> {
    if (!isGithubConfigured(this.config)) return false;
    const record = await this.store.get(tenantId, userId);
    if (!record) return false;
    if (!isTokenExpired(record.accessTokenExpiresAt)) return true;
    return Boolean(record.refreshTokenEncrypted);
  }

  async getAuthorizationUrl(input: { tenantId: string; userId: string }): Promise<string> {
    this.assertConfigured();

    const state = await new SignJWT({
      tid: input.tenantId,
      sub: input.userId
    } satisfies GithubUserStatePayload)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(GITHUB_STATE_ISSUER)
      .setAudience(GITHUB_USER_STATE_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(GITHUB_STATE_TTL)
      .sign(getSecretKey(this.config));

    const url = new URL(GITHUB_OAUTH_AUTHORIZE_URL);
    url.searchParams.set("client_id", this.config.GITHUB_OAUTH_CLIENT_ID!);
    url.searchParams.set("redirect_uri", this.config.GITHUB_OAUTH_REDIRECT_URI!);
    url.searchParams.set("scope", "repo read:user user:email");
    url.searchParams.set("state", state);
    return url.toString();
  }

  async completeAuthorization(input: { code?: string | null; state?: string | null }): Promise<string> {
    const fallbackUrl = this.buildRedirectUrl("/settings/github", {
      githubAuth: "error",
      reason: "invalid_state"
    });

    if (!input.code || !input.state) {
      return this.buildRedirectUrl("/settings/github", {
        githubAuth: "error",
        reason: "missing_code"
      });
    }

    let state: GithubUserStatePayload;
    try {
      const verified = await jwtVerify(input.state, getSecretKey(this.config), {
        issuer: GITHUB_STATE_ISSUER,
        audience: GITHUB_USER_STATE_AUDIENCE,
        algorithms: ["HS256"]
      });
      const payload = verified.payload as Partial<GithubUserStatePayload>;
      if (typeof payload.tid !== "string" || typeof payload.sub !== "string") {
        return fallbackUrl;
      }
      state = { tid: payload.tid, sub: payload.sub };
    } catch {
      return fallbackUrl;
    }

    try {
      const connection = await this.exchangeUserCodeForConnection(input.code);
      await this.store.upsert({
        tenantId: state.tid,
        userId: state.sub,
        githubUserId: connection.githubUserId,
        githubLogin: connection.githubLogin,
        githubName: connection.githubName,
        githubEmail: connection.githubEmail,
        githubAvatarUrl: connection.githubAvatarUrl,
        tokenType: connection.tokenType,
        grantedScopes: connection.grantedScopes,
        accessTokenEncrypted: encrypt(connection.accessToken, this.config.DATA_ENCRYPTION_SECRET),
        accessTokenExpiresAt: connection.accessTokenExpiresAt,
        refreshTokenEncrypted: connection.refreshToken
          ? encrypt(connection.refreshToken, this.config.DATA_ENCRYPTION_SECRET)
          : null,
        refreshTokenExpiresAt: connection.refreshTokenExpiresAt,
        tokenLastRefreshedAt: connection.tokenLastRefreshedAt
      });

      await this.auditEvents?.create({
        tenantId: state.tid,
        sessionId: null,
        userId: state.sub,
        type: "user.github.connected",
        payload: {
          githubLogin: connection.githubLogin,
          githubUserId: connection.githubUserId
        }
      });
      await this.runtimeManager?.invalidateRuntimesForIntegration(state.tid, state.sub, "github");

      return this.buildRedirectUrl("/settings/github", {
        githubAuth: "connected"
      });
    } catch (error) {
      return this.buildRedirectUrl("/settings/github", {
        githubAuth: "error",
        reason: error instanceof Error ? error.message : "github_authorization_failed"
      });
    }
  }

  async disconnect(tenantId: string, userId: string): Promise<boolean> {
    const existing = await this.store.get(tenantId, userId);
    const removed = await this.store.delete(tenantId, userId);

    if (removed && existing) {
      await this.auditEvents?.create({
        tenantId,
        sessionId: null,
        userId,
        type: "user.github.disconnected",
        payload: {
          githubLogin: existing.githubLogin,
          githubUserId: existing.githubUserId
        }
      });
      await this.runtimeManager?.invalidateRuntimesForIntegration(tenantId, userId, "github");
    }

    return removed;
  }

  async getRuntimeCredentials(tenantId: string, userId: string): Promise<GithubRuntimeCredentials | null> {
    this.assertConfigured();

    const userConnection = await this.store.get(tenantId, userId);
    if (!userConnection) return null;

    const refreshed = shouldRefreshToken(userConnection.accessTokenExpiresAt)
      ? await refreshAndPersistAccessToken(this.config, this.store, userConnection)
      : userConnection;
    if (isTokenExpired(refreshed.accessTokenExpiresAt)) {
      return null;
    }

    await this.store.markTokenUsed(tenantId, userId);
    return {
      login: refreshed.githubLogin,
      name: refreshed.githubName,
      email: refreshed.githubEmail,
      token: decrypt(refreshed.accessTokenEncrypted, this.config.DATA_ENCRYPTION_SECRET)
    };
  }

  private assertConfigured(): void {
    if (!isGithubConfigured(this.config)) {
      throw new GithubConnectionNotConfiguredError();
    }
  }

  private async exchangeUserCodeForConnection(code: string) {
    const token = await exchangeUserAuthorizationCode(this.config, code);
    const user = await fetchUserProfile(token.access_token);
    const email = user.email ?? (await selectGithubEmail(token.access_token));
    return {
      githubUserId: String(user.id),
      githubLogin: user.login,
      githubName: user.name,
      githubEmail: email,
      githubAvatarUrl: user.avatar_url,
      tokenType: token.token_type ?? "bearer",
      grantedScopes: parseScopes(token.scope),
      accessToken: token.access_token,
      accessTokenExpiresAt: toIsoFromNow(token.expires_in),
      refreshToken: token.refresh_token ?? null,
      refreshTokenExpiresAt: toIsoFromNow(token.refresh_token_expires_in),
      tokenLastRefreshedAt: token.refresh_token ? new Date().toISOString() : null
    };
  }

  private buildRedirectUrl(pathname: string, params: Record<string, string>): string {
    const url = new URL(pathname, this.config.API_ORIGIN);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }
}
