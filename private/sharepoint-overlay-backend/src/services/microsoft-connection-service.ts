import { SignJWT, jwtVerify } from "jose";

import type { OverlayConfig } from "../../../../apps/backend/src/overlay-contracts.js";
import { decrypt, encrypt } from "../../../../apps/backend/src/lib/crypto-utils.js";
import type { AuditEventInput, AuditEventStore } from "../../../../apps/backend/src/services/audit-event-store.js";
// Adds the Microsoft audit event types that this service emits.
import type {} from "../audit-event-types.js";
import type { IntegrationStateStore } from "../../../../apps/backend/src/services/integrations/integration-state-store.js";
import {
  createOAuthBrowserBinding,
  getSecretKey,
  getVerificationKey,
  oauthBrowserBindingMatches,
  type OAuthBrowserBindingCookie
} from "../../../../apps/backend/src/services/integrations/integration-oauth-helpers.js";
import { IntegrationOAuthStateStore } from "../../../../apps/backend/src/services/integrations/integration-oauth-state-store.js";
import { uuidv7 } from "../../../../apps/backend/src/lib/uuid.js";
import type {
  MicrosoftConnectionRecord,
  MicrosoftConnectionStore,
  MicrosoftOwnerConnectionRecord
} from "./microsoft-connection-store.js";
import {
  ConnectionConfirmError,
  OwnerSecurityVersionChangedError
} from "../../../../apps/backend/src/services/auth/security-change.js";
import type { RuntimeInvalidator } from "../../../../apps/backend/src/services/integrations/contracts.js";
import { assertBoundIntegrationAccount } from "../../../../apps/backend/src/services/integrations/integration-account-binding.js";

const GRAPH_API_URL = "https://graph.microsoft.com/v1.0";
const MICROSOFT_STATE_AUDIENCE = "cogniplane-microsoft-user-connect";
const MICROSOFT_STATE_ISSUER = "cogniplane";
const MICROSOFT_STATE_TTL = "10m";
const MICROSOFT_STATE_TTL_SECONDS = 10 * 60;
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
// Read scopes always; write scopes only when the tenant turned on Microsoft 365
// writes, so a read-only tenant never asks users for write consent. A user who
// connected before writes were turned on reconnects to grant them.
const MICROSOFT_READ_SCOPES = "User.Read Files.Read.All Sites.Read.All offline_access";
const MICROSOFT_WRITE_SCOPES = "User.Read Files.ReadWrite.All Sites.ReadWrite.All offline_access";

/** True when the granted scopes allow writing files (Graph may prefix them with its resource URL). */
export function hasMicrosoftWriteScope(scopes: readonly string[]): boolean {
  return scopes.some((scope) => /(^|\/)(Files|Sites)\.ReadWrite\.All$/.test(scope));
}

export type MicrosoftTenantConfig = {
  clientId: string;
  clientSecret: string;
  entraTenantId: string;
};

// The Entra tenant identifier is interpolated directly into
// `https://login.microsoftonline.com/<entraTenantId>/oauth2/v2.0/{authorize,token}`
// URLs that carry the client secret. An unvalidated value containing `/`, `?`,
// `#`, `:` or whitespace could rewrite the path/query of those credential-bearing
// requests (e.g. pointing the token POST at an attacker-controlled path). Microsoft
// accepts exactly four forms for the tenant segment: a directory (tenant) GUID, one
// of the well-known aliases, or a verified `<name>.onmicrosoft.com` domain.
const ENTRA_TENANT_GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ENTRA_TENANT_ALIASES = new Set(["common", "organizations", "consumers"]);
const ENTRA_TENANT_ONMICROSOFT = /^[a-zA-Z0-9-]{1,63}\.onmicrosoft\.com$/;

export class MicrosoftInvalidEntraTenantError extends Error {
  constructor() {
    super(
      "Invalid Entra tenant identifier. Use a directory (tenant) GUID, " +
        "'common', 'organizations', 'consumers', or a '<name>.onmicrosoft.com' domain."
    );
    this.name = "MicrosoftInvalidEntraTenantError";
  }
}

export function isValidEntraTenantId(value: string): boolean {
  return (
    ENTRA_TENANT_GUID.test(value) ||
    ENTRA_TENANT_ALIASES.has(value) ||
    ENTRA_TENANT_ONMICROSOFT.test(value)
  );
}

export function assertValidEntraTenantId(value: string): void {
  if (!isValidEntraTenantId(value)) {
    throw new MicrosoftInvalidEntraTenantError();
  }
}

type MicrosoftStatePayload = {
  tid: string;
  sub: string;
  jti: string;
  // SHA-256 of the browser-binding cookie nonce.
  bnh: string;
  // Security version of the session that started the authorization. Absent
  // for a WorkOS session. The callback has no session, so the connection
  // stores this value (see services/auth/security-change.ts in the backend).
  sv?: number;
};

type MicrosoftTokenResponse = {
  access_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
};

type MicrosoftUserProfile = {
  id: string;
  displayName: string | null;
  mail: string | null;
  userPrincipalName: string;
};

export type MicrosoftUserConnectionSummary = {
  microsoftUserId: string;
  microsoftEmail: string | null;
  microsoftDisplayName: string | null;
  scopes: string[];
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
  connectedAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  // A security change of the owner's account suspended the connection. The
  // agent does not use it until the owner confirms it or connects again.
  suspended: boolean;
};

export type MicrosoftConnectionStatus = {
  configured: boolean;
  userConnection: MicrosoftUserConnectionSummary | null;
};

export type MicrosoftRuntimeCredentials = {
  microsoftUserId: string;
  displayName: string | null;
  email: string | null;
  token: string;
  /** The scopes Microsoft granted to this connection. */
  scopes: string[];
};

export class MicrosoftConnectionNotConfiguredError extends Error {
  constructor(message = "Microsoft integration is not configured.") {
    super(message);
  }
}

function parseScopes(scope: string | undefined): string[] {
  return scope
    ? scope
        .split(" ")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

function toIsoFromNow(seconds: number | undefined): string | null {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? new Date(Date.now() + seconds * 1000).toISOString()
    : null;
}

function isExpiringSoon(value: string | null): boolean {
  if (!value) {
    return false;
  }

  const expiresAt = new Date(value).getTime();
  return Number.isFinite(expiresAt) && expiresAt - Date.now() <= TOKEN_REFRESH_SKEW_MS;
}

function isExpired(value: string | null): boolean {
  if (!value) {
    return false;
  }

  const expiresAt = new Date(value).getTime();
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function toUserSummary(record: MicrosoftOwnerConnectionRecord): MicrosoftUserConnectionSummary {
  return {
    microsoftUserId: record.microsoftUserId,
    microsoftEmail: record.microsoftEmail,
    microsoftDisplayName: record.microsoftDisplayName,
    scopes: record.grantedScopes,
    accessTokenExpiresAt: record.accessTokenExpiresAt,
    refreshTokenExpiresAt: record.refreshTokenExpiresAt,
    connectedAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastUsedAt: record.tokenLastUsedAt,
    suspended: record.suspended
  };
}

const MICROSOFT_AUTHORIZATION_REASONS = new Set(["microsoft_token_exchange_failed", "microsoft_user_fetch_failed"]);

export class MicrosoftConnectionService {
  // Single-flight cache for token refreshes, keyed by `${tenantId} ${userId}`.
  // Microsoft refresh tokens are single-use: concurrent turns that each notice the
  // access token is expiring would otherwise race to redeem the same refresh token,
  // and the loser's response would clobber the fresh token row with a now-invalid
  // refresh token. Collapsing concurrent refreshes for the same (tenant, user) onto
  // one in-flight promise guarantees the refresh token is redeemed exactly once.
  // Note: this is per-process. It does not coordinate across backend instances.
  private readonly inFlightRefreshes = new Map<string, Promise<MicrosoftConnectionRecord | null>>();

  constructor(
    private readonly config: OverlayConfig,
    private readonly store: Pick<
      MicrosoftConnectionStore,
      "get" | "getForOwner" | "confirm" | "upsert" | "updateRefreshedToken" | "delete" | "markTokenUsed"
    >,
    private readonly auditEvents: Pick<AuditEventStore, "create"> | undefined,
    private readonly runtimeManager: RuntimeInvalidator | undefined,
    private readonly integrationStates: Pick<IntegrationStateStore, "get" | "upsert">,
    private readonly redirectUri?: string,
    private readonly oauthStates: Pick<IntegrationOAuthStateStore, "issue" | "consume"> =
      new IntegrationOAuthStateStore()
  ) {}

  private isValidConfig(value: unknown): value is MicrosoftTenantConfig {
    return (
      value !== null &&
      typeof value === "object" &&
      typeof (value as Record<string, unknown>).clientId === "string" &&
      typeof (value as Record<string, unknown>).clientSecret === "string" &&
      typeof (value as Record<string, unknown>).entraTenantId === "string"
    );
  }

  private async getTenantMicrosoftConfig(tenantId: string): Promise<MicrosoftTenantConfig | null> {
    const integrationState = await this.integrationStates.get(tenantId, "microsoft");
    if (!integrationState) return null;
    return this.isValidConfig(integrationState.config) ? integrationState.config : null;
  }

  /**
   * Stores the tenant's Microsoft app. The audit event, when given, commits
   * in the same transaction as the change, with its owner notice.
   */
  async setTenantMicrosoftConfig(
    tenantId: string,
    patch: Partial<MicrosoftTenantConfig>,
    audit?: () => AuditEventInput
  ): Promise<void> {
    const existing = await this.getTenantMicrosoftConfig(tenantId);

    if (!existing && (!patch.clientId || !patch.clientSecret || !patch.entraTenantId)) {
      throw new Error("Initial Microsoft configuration requires clientId, clientSecret, and entraTenantId.");
    }

    if (patch.entraTenantId !== undefined) {
      assertValidEntraTenantId(patch.entraTenantId);
    }

    const merged: MicrosoftTenantConfig = {
      clientId: patch.clientId ?? existing!.clientId,
      clientSecret: patch.clientSecret
        ? encrypt(patch.clientSecret, this.config.DATA_ENCRYPTION_SECRET)
        : existing!.clientSecret,
      entraTenantId: patch.entraTenantId ?? existing!.entraTenantId
    };

    const existingState = await this.integrationStates.get(tenantId, "microsoft");
    await this.integrationStates.upsert(tenantId, "microsoft", {
      readsEnabled: existingState?.readsEnabled ?? false,
      writesEnabled: existingState?.writesEnabled ?? false,
      config: merged as unknown as Record<string, unknown>,
      updatedBy: existingState?.updatedBy ?? null
    }, audit);
  }

  async removeTenantMicrosoftConfig(tenantId: string): Promise<void> {
    const existingState = await this.integrationStates.get(tenantId, "microsoft");
    await this.integrationStates.upsert(tenantId, "microsoft", {
      readsEnabled: false,
      writesEnabled: false,
      config: {},
      updatedBy: existingState?.updatedBy ?? null
    });
  }

  async getConnectionStatus(tenantId: string, userId: string): Promise<MicrosoftConnectionStatus> {
    const [tenantConfig, userConnection] = await Promise.all([
      this.getTenantMicrosoftConfig(tenantId),
      this.store.getForOwner(tenantId, userId)
    ]);

    return {
      configured: Boolean(this.redirectUri) && tenantConfig !== null,
      userConnection: userConnection ? toUserSummary(userConnection) : null
    };
  }

  async connectedAccountId(tenantId: string, userId: string): Promise<string | null> {
    return (await this.store.get(tenantId, userId))?.microsoftUserId ?? null;
  }

  // Cheap presence check used by IntegrationRegistryService at session start.
  // Considers a connection live if the tenant OAuth app is configured, a stored
  // token row exists, and either the access token is still valid or a refresh
  // token is on file (the actual refresh happens later in getRuntimeCredentials).
  async hasConnection(tenantId: string, userId: string): Promise<boolean> {
    const [tenantConfig, record] = await Promise.all([
      this.getTenantMicrosoftConfig(tenantId),
      this.store.get(tenantId, userId)
    ]);
    if (!tenantConfig || !record) return false;
    if (!isExpired(record.accessTokenExpiresAt)) return true;
    return record.refreshTokenEncrypted !== null;
  }

  async getAuthorizationUrl(input: {
    tenantId: string;
    userId: string;
    // The security version of the requesting session (requestSecurityVersion).
    ownerSecurityVersion: number | null;
  }): Promise<{ url: string; browserBinding: OAuthBrowserBindingCookie }> {
    if (!this.redirectUri) {
      throw new MicrosoftConnectionNotConfiguredError();
    }
    const tenantConfig = await this.getTenantMicrosoftConfig(input.tenantId);
    if (!tenantConfig) throw new MicrosoftConnectionNotConfiguredError();
    assertValidEntraTenantId(tenantConfig.entraTenantId);

    const jti = uuidv7();
    const binding = createOAuthBrowserBinding(
      "microsoft",
      this.getRedirectUri(),
      MICROSOFT_STATE_TTL_SECONDS
    );
    await this.oauthStates.issue("microsoft", jti, MICROSOFT_STATE_TTL_SECONDS);
    const state = await new SignJWT({
      tid: input.tenantId,
      sub: input.userId,
      jti,
      bnh: binding.nonceHash,
      ...(input.ownerSecurityVersion === null ? {} : { sv: input.ownerSecurityVersion })
    } satisfies MicrosoftStatePayload)
      .setProtectedHeader({ alg: "HS256", kid: this.config.JWT_KEY_ID })
      .setIssuer(MICROSOFT_STATE_ISSUER)
      .setAudience(MICROSOFT_STATE_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(MICROSOFT_STATE_TTL)
      .sign(getSecretKey(this.config));

    const url = new URL(`https://login.microsoftonline.com/${tenantConfig.entraTenantId}/oauth2/v2.0/authorize`);
    url.searchParams.set("client_id", tenantConfig.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", this.getRedirectUri());
    const integrationState = await this.integrationStates.get(input.tenantId, "microsoft");
    url.searchParams.set("scope", integrationState?.writesEnabled ? MICROSOFT_WRITE_SCOPES : MICROSOFT_READ_SCOPES);
    url.searchParams.set("state", state);
    url.searchParams.set("response_mode", "query");
    return { url: url.toString(), browserBinding: binding.cookie };
  }

  async completeAuthorization(input: {
    code?: string | null;
    state?: string | null;
    browserNonce?: string | null;
  }): Promise<string> {
    const fallbackUrl = this.buildRedirectUrl("/settings/microsoft", {
      microsoftAuth: "error",
      reason: "invalid_state"
    });

    if (!input.code || !input.state) {
      return this.buildRedirectUrl("/settings/microsoft", {
        microsoftAuth: "error",
        reason: input.code ? "missing_state" : "missing_code"
      });
    }

    let state: MicrosoftStatePayload;
    try {
      const verified = await jwtVerify(
        input.state,
        (protectedHeader) => getVerificationKey(this.config, protectedHeader.kid),
        {
          issuer: MICROSOFT_STATE_ISSUER,
          audience: MICROSOFT_STATE_AUDIENCE,
          algorithms: ["HS256"]
        }
      );
      const payload = verified.payload as Partial<MicrosoftStatePayload>;
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
      if (!(await this.oauthStates.consume("microsoft", payload.jti))) {
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
      const tenantConfig = await this.getTenantMicrosoftConfig(state.tid);
      if (!tenantConfig) {
        return this.buildRedirectUrl("/settings/microsoft", {
          microsoftAuth: "error",
          reason: "microsoft_not_configured"
        });
      }

      assertValidEntraTenantId(tenantConfig.entraTenantId);
      const clientSecret = decrypt(tenantConfig.clientSecret, this.config.DATA_ENCRYPTION_SECRET);

      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: this.getRedirectUri(),
        client_id: tenantConfig.clientId,
        client_secret: clientSecret
      });

      const tokenResponse = await fetch(
        `https://login.microsoftonline.com/${tenantConfig.entraTenantId}/oauth2/v2.0/token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString()
        }
      );

      const tokenPayload = (await tokenResponse.json().catch(() => ({}))) as MicrosoftTokenResponse;
      if (!tokenResponse.ok || !tokenPayload.access_token) {
        // The provider's error text never goes into the redirect URL.
        throw new Error("microsoft_token_exchange_failed");
      }

      const profileResponse = await fetch(`${GRAPH_API_URL}/me`, {
        headers: {
          Authorization: `Bearer ${tokenPayload.access_token}`,
          "Content-Type": "application/json"
        }
      });

      if (!profileResponse.ok) {
        throw new Error("microsoft_user_fetch_failed");
      }

      const profile = (await profileResponse.json()) as MicrosoftUserProfile;

      await this.store.upsert({
        tenantId: state.tid,
        userId: state.sub,
        microsoftUserId: profile.id,
        microsoftEmail: profile.mail ?? profile.userPrincipalName,
        microsoftDisplayName: profile.displayName,
        tokenType: tokenPayload.token_type ?? "bearer",
        grantedScopes: parseScopes(tokenPayload.scope),
        accessTokenEncrypted: encrypt(tokenPayload.access_token, this.config.DATA_ENCRYPTION_SECRET),
        accessTokenExpiresAt: toIsoFromNow(tokenPayload.expires_in),
        refreshTokenEncrypted: tokenPayload.refresh_token
          ? encrypt(tokenPayload.refresh_token, this.config.DATA_ENCRYPTION_SECRET)
          : null,
        refreshTokenExpiresAt: null,
        tokenLastRefreshedAt: tokenPayload.refresh_token ? new Date().toISOString() : null,
        ownerSecurityVersion: state.sv ?? null
      });

      await this.auditEvents?.create({
        tenantId: state.tid,
        sessionId: null,
        userId: state.sub,
        type: "user.microsoft.connected",
        payload: {
          microsoftUserId: profile.id,
          microsoftEmail: profile.mail ?? profile.userPrincipalName
        }
      });
      await this.runtimeManager?.invalidateRuntimesForIntegration(state.tid, state.sub, "microsoft");

      return this.buildRedirectUrl("/settings/microsoft", {
        microsoftAuth: "connected"
      });
    } catch (error) {
      // Only fixed reason codes reach the browser URL. Other errors can hold
      // provider or database text. `session_changed`: a security change after
      // the session that started the authorization; nothing was written.
      const reason = error instanceof OwnerSecurityVersionChangedError ? "session_changed"
        : error instanceof Error && MICROSOFT_AUTHORIZATION_REASONS.has(error.message)
          ? error.message : "microsoft_authorization_failed";
      return this.buildRedirectUrl("/settings/microsoft", { microsoftAuth: "error", reason });
    }
  }

  // `IntegrationConnectionProbe.deleteConnection`: member removal revokes the
  // connection with the same audit event and invalidation as a disconnect.
  async deleteConnection(tenantId: string, userId: string): Promise<boolean> {
    return this.disconnect(tenantId, userId);
  }

  /**
   * The owner confirms a suspended connection from a current session.
   * `microsoftUserId` is the account that the owner saw.
   * `ownerSecurityVersion` is the version of the requesting session. The
   * result stays suspended when that version is not current (a security
   * change raced the request).
   */
  async confirm(
    tenantId: string,
    userId: string,
    microsoftUserId: string,
    ownerSecurityVersion: number | null
  ): Promise<MicrosoftUserConnectionSummary> {
    const confirmed = await this.store.confirm(tenantId, userId, microsoftUserId, ownerSecurityVersion);
    if (!confirmed) {
      const current = await this.store.getForOwner(tenantId, userId);
      throw new ConnectionConfirmError(
        !current ? "not_connected" : current.microsoftEmail === null ? "not_attested" : "account_changed", "Microsoft 365");
    }
    // The store writes the audit event in the confirm's transaction.
    if (!confirmed.suspended) {
      await this.runtimeManager?.invalidateRuntimesForIntegration(tenantId, userId, "microsoft");
    }
    return toUserSummary(confirmed);
  }

  async disconnect(tenantId: string, userId: string): Promise<boolean> {
    const existing = await this.store.getForOwner(tenantId, userId);
    const removed = await this.store.delete(tenantId, userId);

    if (removed && existing) {
      await this.auditEvents?.create({
        tenantId,
        sessionId: null,
        userId,
        type: "user.microsoft.disconnected",
        payload: {
          microsoftUserId: existing.microsoftUserId,
          microsoftEmail: existing.microsoftEmail
        }
      });
      await this.runtimeManager?.invalidateRuntimesForIntegration(tenantId, userId, "microsoft");
    }

    return removed;
  }

  // `expectedAccountId` is the account the turn recorded (see boundIntegrationAccount).
  async getRuntimeCredentials(tenantId: string, userId: string,
    expectedAccountId?: string | null): Promise<MicrosoftRuntimeCredentials | null> {
    const tenantConfig = await this.getTenantMicrosoftConfig(tenantId);
    if (!tenantConfig) return null;

    const record = await this.store.get(tenantId, userId);
    if (!record) {
      // No connection, so no token of any account is used.
      return null;
    }
    assertBoundIntegrationAccount("Microsoft 365", expectedAccountId, record.microsoftUserId);

    const refreshed = isExpiringSoon(record.accessTokenExpiresAt)
      ? await this.refreshAccessTokenSingleFlight(tenantId, userId, record, tenantConfig)
      : record;

    // Null: the connection changed or went away during the refresh.
    if (!refreshed || isExpired(refreshed.accessTokenExpiresAt)) {
      return null;
    }

    await this.store.markTokenUsed(tenantId, userId);

    return {
      microsoftUserId: refreshed.microsoftUserId,
      displayName: refreshed.microsoftDisplayName,
      email: refreshed.microsoftEmail,
      token: decrypt(refreshed.accessTokenEncrypted, this.config.DATA_ENCRYPTION_SECRET),
      scopes: refreshed.grantedScopes
    };
  }

  // Collapses concurrent refreshes for the same (tenant, user) onto a single
  // in-flight redemption of the (single-use) refresh token. Late callers await
  // the same promise and observe the freshly persisted record.
  private async refreshAccessTokenSingleFlight(
    tenantId: string,
    userId: string,
    record: MicrosoftConnectionRecord,
    tenantConfig: MicrosoftTenantConfig
  ): Promise<MicrosoftConnectionRecord | null> {
    const key = `${tenantId} ${userId}`;
    const existing = this.inFlightRefreshes.get(key);
    if (existing) {
      return existing;
    }

    const refreshPromise = this.refreshAccessToken(record, tenantConfig).finally(() => {
      this.inFlightRefreshes.delete(key);
    });
    this.inFlightRefreshes.set(key, refreshPromise);
    return refreshPromise;
  }

  // Returns null when the stored connection is no longer the one the refresh
  // started from (see MicrosoftConnectionStore.updateRefreshedToken).
  private async refreshAccessToken(
    record: MicrosoftConnectionRecord,
    tenantConfig: MicrosoftTenantConfig
  ): Promise<MicrosoftConnectionRecord | null> {
    if (!record.refreshTokenEncrypted) {
      return record;
    }

    assertValidEntraTenantId(tenantConfig.entraTenantId);
    const refreshToken = decrypt(record.refreshTokenEncrypted, this.config.DATA_ENCRYPTION_SECRET);
    const clientSecret = decrypt(tenantConfig.clientSecret, this.config.DATA_ENCRYPTION_SECRET);

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: tenantConfig.clientId,
      client_secret: clientSecret
    });

    const response = await fetch(
      `https://login.microsoftonline.com/${tenantConfig.entraTenantId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString()
      }
    );

    const payload = (await response.json()) as MicrosoftTokenResponse;
    if (!response.ok || !payload.access_token) {
      return record;
    }

    // A refresh has no session. Bind it to the row it started from, so it
    // never creates a deleted row again or overwrites a reconnect.
    return this.store.updateRefreshedToken({
      tenantId: record.tenantId,
      userId: record.userId,
      expectedMicrosoftUserId: record.microsoftUserId,
      expectedRefreshTokenEncrypted: record.refreshTokenEncrypted,
      tokenType: payload.token_type ?? record.tokenType,
      grantedScopes:
        parseScopes(payload.scope).length > 0 ? parseScopes(payload.scope) : record.grantedScopes,
      accessTokenEncrypted: encrypt(payload.access_token, this.config.DATA_ENCRYPTION_SECRET),
      accessTokenExpiresAt: toIsoFromNow(payload.expires_in),
      refreshTokenEncrypted: payload.refresh_token
        ? encrypt(payload.refresh_token, this.config.DATA_ENCRYPTION_SECRET)
        : record.refreshTokenEncrypted
    });
  }

  private getRedirectUri(): string {
    if (!this.redirectUri) {
      throw new MicrosoftConnectionNotConfiguredError();
    }
    return this.redirectUri;
  }

  private buildRedirectUrl(pathname: string, params: Record<string, string>): string {
    const url = new URL(pathname, this.config.API_ORIGIN);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }
}
