import { SignJWT, jwtVerify } from "jose";

import type { AppConfig } from "../../../config.js";
import { decrypt, encrypt } from "../../../lib/crypto-utils.js";
import type { AuditEventStore } from "../../audit-event-store.js";
import {
  exchangeUserAuthorizationCode,
  fetchUserProfile,
  GithubApiError,
  listUserRepositories,
  selectGithubEmail,
  GITHUB_OAUTH_AUTHORIZE_URL,
  type GithubRepositorySummary
} from "./github-api-client.js";
import {
  GithubConnectionError,
  GithubConnectionNotConfiguredError
} from "./github-connection-errors.js";
import { normalizeAllowedRepositories } from "./github-repository-allowlist.js";
import type { GithubOwnerConnectionRecord, GithubConnectionStore } from "./github-connection-store.js";
import {
  isTokenExpired,
  parseScopes,
  refreshAndPersistAccessToken,
  shouldRefreshToken
} from "./github-token-lifecycle.js";
import {
  buildIntegrationRedirectUrl,
  createOAuthBrowserBinding,
  getSecretKey,
  getVerificationKey,
  oauthBrowserBindingMatches,
  toIsoFromNow,
  type OAuthBrowserBindingCookie
} from "../integration-oauth-helpers.js";
import type { RuntimeInvalidator } from "../contracts.js";
import { IntegrationOAuthStateStore } from "../integration-oauth-state-store.js";
import { uuidv7 } from "../../../lib/uuid.js";
import { assertBoundIntegrationAccount } from "../integration-account-binding.js";
import { ConnectionConfirmError, OwnerSecurityVersionChangedError } from "../../auth/security-change.js";

export { GithubConnectionError, GithubConnectionNotConfiguredError } from "./github-connection-errors.js";

const GITHUB_USER_STATE_AUDIENCE = "cogniplane-github-user-connect";
const GITHUB_STATE_ISSUER = "cogniplane";
const GITHUB_STATE_TTL = "10m";
const GITHUB_STATE_TTL_SECONDS = 10 * 60;

type GithubUserStatePayload = {
  tid: string;
  sub: string;
  jti: string;
  // SHA-256 of the browser-binding cookie nonce.
  bnh: string;
  // Security version of the session that started the authorization. Absent
  // for a WorkOS session. The callback has no session, so the connection
  // stores this value (see services/auth/security-change.ts).
  sv?: number;
};

export type GithubUserConnectionSummary = {
  githubUserId: string;
  githubLogin: string;
  githubName: string | null;
  githubEmail: string | null;
  githubAvatarUrl: string | null;
  scopes: string[];
  allowedRepositories: string[];
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
  connectedAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  // A security change of the owner's account suspended the connection. The
  // agent does not use it until the owner confirms it or connects again.
  suspended: boolean;
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
  // Repositories the agent may use, lower case. Empty means none. Every tool
  // that names a repository must check it before the GitHub API call.
  allowedRepositories: string[];
};

function isGithubConfigured(config: AppConfig): boolean {
  return Boolean(
    config.GITHUB_OAUTH_CLIENT_ID &&
      config.GITHUB_OAUTH_CLIENT_SECRET &&
      config.GITHUB_OAUTH_REDIRECT_URI
  );
}

function toUserSummary(record: GithubOwnerConnectionRecord): GithubUserConnectionSummary {
  return {
    githubUserId: record.githubUserId,
    githubLogin: record.githubLogin,
    githubName: record.githubName,
    githubEmail: record.githubEmail,
    githubAvatarUrl: record.githubAvatarUrl,
    scopes: record.grantedScopes,
    allowedRepositories: record.allowedRepositories,
    accessTokenExpiresAt: record.accessTokenExpiresAt,
    refreshTokenExpiresAt: record.refreshTokenExpiresAt,
    connectedAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastUsedAt: record.tokenLastUsedAt,
    suspended: record.suspended
  };
}

export class GithubConnectionService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: Pick<
      GithubConnectionStore,
      | "get"
      | "getForOwner"
      | "confirm"
      | "upsert"
      | "updateRefreshedToken"
      | "delete"
      | "markTokenUsed"
      | "setAllowedRepositories"
    >,
    private readonly auditEvents?: Pick<AuditEventStore, "create">,
    private readonly runtimeManager?: RuntimeInvalidator,
    private readonly oauthStates: Pick<IntegrationOAuthStateStore, "issue" | "consume"> =
      new IntegrationOAuthStateStore(),
    private readonly logger: Pick<Console, "warn"> = console
  ) {}

  async getConnectionStatus(tenantId: string, userId: string): Promise<GithubConnectionStatus> {
    const userConnection = await this.store.getForOwner(tenantId, userId);
    return {
      configured: isGithubConfigured(this.config),
      userConnection: userConnection ? toUserSummary(userConnection) : null
    };
  }

  async connectedAccountId(tenantId: string, userId: string): Promise<string | null> {
    return (await this.store.get(tenantId, userId))?.githubUserId ?? null;
  }

  // Cheap presence check used by IntegrationRegistryService at session start.
  async hasConnection(tenantId: string, userId: string): Promise<boolean> {
    if (!isGithubConfigured(this.config)) return false;
    const record = await this.store.get(tenantId, userId);
    if (!record) return false;
    if (!isTokenExpired(record.accessTokenExpiresAt)) return true;
    return Boolean(record.refreshTokenEncrypted);
  }

  async getAuthorizationUrl(input: {
    tenantId: string;
    userId: string;
    // The security version of the requesting session (requestSecurityVersion).
    ownerSecurityVersion: number | null;
  }): Promise<{ url: string; browserBinding: OAuthBrowserBindingCookie }> {
    this.assertConfigured();

    const jti = uuidv7();
    const binding = createOAuthBrowserBinding(
      "github",
      this.config.GITHUB_OAUTH_REDIRECT_URI!,
      GITHUB_STATE_TTL_SECONDS
    );
    await this.oauthStates.issue("github", jti, GITHUB_STATE_TTL_SECONDS);
    const state = await new SignJWT({
      tid: input.tenantId,
      sub: input.userId,
      jti,
      bnh: binding.nonceHash,
      ...(input.ownerSecurityVersion === null ? {} : { sv: input.ownerSecurityVersion })
    } satisfies GithubUserStatePayload)
      .setProtectedHeader({ alg: "HS256", kid: this.config.JWT_KEY_ID })
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
    return { url: url.toString(), browserBinding: binding.cookie };
  }

  async completeAuthorization(input: {
    code?: string | null;
    state?: string | null;
    browserNonce?: string | null;
  }): Promise<string> {
    const fallbackUrl = buildIntegrationRedirectUrl(this.config, "/settings/github", {
      githubAuth: "error",
      reason: "invalid_state"
    });

    if (!input.code || !input.state) {
      return buildIntegrationRedirectUrl(this.config, "/settings/github", {
        githubAuth: "error",
        reason: "missing_code"
      });
    }

    let state: GithubUserStatePayload;
    try {
      const verified = await jwtVerify(
        input.state,
        (protectedHeader) => getVerificationKey(this.config, protectedHeader.kid),
        {
          issuer: GITHUB_STATE_ISSUER,
          audience: GITHUB_USER_STATE_AUDIENCE,
          algorithms: ["HS256"]
        }
      );
      const payload = verified.payload as Partial<GithubUserStatePayload>;
      if (
        typeof payload.tid !== "string" ||
        typeof payload.sub !== "string" ||
        typeof payload.jti !== "string" ||
        typeof payload.bnh !== "string"
      ) {
        return fallbackUrl;
      }
      // Check the browser binding before spending the state, so a callback
      // from another browser cannot burn it.
      if (!oauthBrowserBindingMatches(payload.bnh, input.browserNonce)) {
        return fallbackUrl;
      }
      if (!(await this.oauthStates.consume("github", payload.jti))) {
        return fallbackUrl;
      }
      state = {
        tid: payload.tid,
        sub: payload.sub,
        jti: payload.jti,
        bnh: payload.bnh,
        ...(typeof payload.sv === "number" && Number.isInteger(payload.sv) ? { sv: payload.sv } : {})
      };
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
        tokenLastRefreshedAt: connection.tokenLastRefreshedAt,
        ownerSecurityVersion: state.sv ?? null
      // The event commits with the connection: a failed event saves nothing.
      }, () => ({
        tenantId: state.tid,
        sessionId: null,
        userId: state.sub,
        type: "user.github.connected",
        payload: {
          githubLogin: connection.githubLogin,
          githubUserId: connection.githubUserId
        }
      }));
      try {
        await this.runtimeManager?.invalidateRuntimesForIntegration(state.tid, state.sub, "github");
      } catch (err) {
        this.logger.warn({ err }, "Failed to refresh runtimes after github connection");
      }

      return buildIntegrationRedirectUrl(this.config, "/settings/github", {
        githubAuth: "connected"
      });
    } catch (error) {
      return buildIntegrationRedirectUrl(this.config, "/settings/github", {
        githubAuth: "error",
        // A security change after the session that started the authorization:
        // nothing was written.
        reason: error instanceof OwnerSecurityVersionChangedError ? "session_changed" : "github_authorization_failed"
      });
    }
  }

  /**
   * `IntegrationConnectionProbe.deleteConnection`. Member removal calls this
   * through the registry; it is `disconnect` under the name the probe declares,
   * so revoking on removal writes the same audit event and runtime
   * invalidation as a user-initiated disconnect.
   */
  async deleteConnection(tenantId: string, userId: string): Promise<boolean> {
    return this.disconnect(tenantId, userId);
  }

  async disconnect(tenantId: string, userId: string): Promise<boolean> {
    const existing = await this.store.getForOwner(tenantId, userId);
    // The event commits with the delete and names the row that it removed.
    const removed = await this.store.delete(tenantId, userId, (row) => ({
      tenantId,
      sessionId: null,
      userId,
      type: "user.github.disconnected",
      payload: {
        githubLogin: row.githubLogin,
        githubUserId: row.githubUserId
      }
    }));

    if (removed && existing) {
      await this.runtimeManager?.invalidateRuntimesForIntegration(tenantId, userId, "github");
    }

    return removed;
  }

  /**
   * The owner confirms a suspended connection from a current session.
   * `githubUserId` is the account that the owner saw. `ownerSecurityVersion`
   * is the version of the requesting session. The result stays suspended when
   * that version is not current (a security change raced the request).
   */
  async confirm(
    tenantId: string,
    userId: string,
    githubUserId: string,
    ownerSecurityVersion: number | null
  ): Promise<GithubUserConnectionSummary> {
    // The store writes the audit event in the confirm's transaction.
    const confirmed = await this.store.confirm(tenantId, userId, githubUserId, ownerSecurityVersion);
    if (!confirmed) {
      const current = await this.store.getForOwner(tenantId, userId);
      throw new ConnectionConfirmError(current ? "account_changed" : "not_connected", "GitHub");
    }
    if (!confirmed.suspended) {
      await this.runtimeManager?.invalidateRuntimesForIntegration(tenantId, userId, "github");
    }
    return toUserSummary(confirmed);
  }

  // `expectedAccountId` is the account the turn recorded (see boundIntegrationAccount).
  async getRuntimeCredentials(tenantId: string, userId: string,
    expectedAccountId?: string | null): Promise<GithubRuntimeCredentials | null> {
    this.assertConfigured();

    const userConnection = await this.store.get(tenantId, userId);
    if (!userConnection) {
      // No connection, so no token of any account is used.
      return null;
    }
    assertBoundIntegrationAccount("GitHub", expectedAccountId, userConnection.githubUserId);

    const refreshed = shouldRefreshToken(userConnection.accessTokenExpiresAt)
      ? await refreshAndPersistAccessToken(this.config, this.store, userConnection)
      : userConnection;
    if (!refreshed || isTokenExpired(refreshed.accessTokenExpiresAt)) {
      return null;
    }

    await this.store.markTokenUsed(tenantId, userId);
    return {
      login: refreshed.githubLogin,
      name: refreshed.githubName,
      email: refreshed.githubEmail,
      token: decrypt(refreshed.accessTokenEncrypted, this.config.DATA_ENCRYPTION_SECRET),
      allowedRepositories: refreshed.allowedRepositories
    };
  }

  /**
   * The repositories that the member's token can reach, for the settings page
   * to offer as choices. It lists what GitHub allows the member; it does not
   * limit what the agent may use. The allowlist does that.
   */
  async listAccessibleRepositories(
    tenantId: string,
    userId: string
  ): Promise<{ repositories: GithubRepositorySummary[]; truncated: boolean }> {
    this.assertConfigured();
    if (!(await this.store.get(tenantId, userId))) {
      throw new GithubConnectionError("not_connected", "GitHub is not connected.");
    }
    const credentials = await this.getRuntimeCredentials(tenantId, userId);
    if (!credentials) {
      throw new GithubConnectionError(
        "credentials_unusable",
        "The GitHub authorization expired. Connect GitHub again."
      );
    }
    try {
      return await listUserRepositories(credentials.token);
    } catch (err) {
      if (err instanceof GithubApiError && err.status === 401) {
        throw new GithubConnectionError(
          "credentials_unusable",
          "GitHub rejected the authorization. Connect GitHub again."
        );
      }
      this.logger.warn({ err }, "Failed to list GitHub repositories");
      throw new GithubConnectionError("upstream_unavailable", "GitHub did not list the repositories. Try again.");
    }
  }

  /**
   * Replace the repositories that the agent may use. Only the member's own
   * settings request calls this; the model has no tool for it. The tools read
   * the list on every call, so no runtime restart is needed.
   * `expectedGithubUserId` is the account that the member saw when they chose
   * the list. A different connected account refuses the save.
   */
  async setAllowedRepositories(
    tenantId: string,
    userId: string,
    repositories: readonly string[],
    expectedGithubUserId: string
  ): Promise<string[]> {
    const normalized = normalizeAllowedRepositories(repositories);
    // The event commits with the change, and only when the list changed.
    const outcome = await this.store.setAllowedRepositories(tenantId, userId, normalized, expectedGithubUserId,
      (updated) => {
        const previous = new Set(updated.previous);
        const current = new Set(updated.record.allowedRepositories);
        const added = updated.record.allowedRepositories.filter((repo) => !previous.has(repo));
        const removed = updated.previous.filter((repo) => !current.has(repo));
        if (added.length === 0 && removed.length === 0) return null;
        return {
          tenantId,
          sessionId: null,
          userId,
          type: "user.github.repositories_updated",
          payload: {
            githubLogin: updated.record.githubLogin,
            githubUserId: updated.record.githubUserId,
            added,
            removed,
            count: updated.record.allowedRepositories.length
          }
        };
      });
    if (outcome.status === "not_connected") {
      throw new GithubConnectionError("not_connected", "GitHub is not connected.");
    }
    if (outcome.status === "account_changed") {
      throw new GithubConnectionError(
        "account_changed",
        "The connected GitHub account changed. Reload the page and choose the repositories again."
      );
    }
    return outcome.record.allowedRepositories;
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

}
