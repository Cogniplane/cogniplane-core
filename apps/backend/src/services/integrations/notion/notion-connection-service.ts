import { SignJWT, jwtVerify } from "jose";

import type { AppConfig } from "../../../config.js";
import { decrypt, encrypt } from "../../../lib/crypto-utils.js";
import type { AuditEventStore } from "../../audit-event-store.js";
import type { NotionConnectionRecord, NotionConnectionStore } from "./notion-connection-store.js";
import type { RuntimeInvalidator } from "../contracts.js";
import {
  buildIntegrationRedirectUrl,
  getSecretKey,
  toIsoFromNow
} from "../integration-oauth-helpers.js";

const NOTION_AUTHORIZE_URL = "https://api.notion.com/v1/oauth/authorize";
const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";
const NOTION_STATE_AUDIENCE = "cogniplane-notion-user-connect";
const NOTION_STATE_ISSUER = "cogniplane";
const NOTION_STATE_TTL = "10m";

export type NotionOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

type NotionStatePayload = {
  tid: string;
  sub: string;
};

type NotionOwner = {
  type?: string;
  user?: {
    id?: string;
    name?: string | null;
    avatar_url?: string | null;
    person?: { email?: string | null } | null;
  };
};

type NotionTokenResponse = {
  access_token?: string;
  token_type?: string;
  bot_id?: string;
  workspace_id?: string;
  workspace_name?: string | null;
  workspace_icon?: string | null;
  owner?: NotionOwner;
  duplicated_template_id?: string | null;
  // Notion does not currently issue refresh tokens or expirations, but the
  // public OAuth response shape allows for them — keep the fields wired.
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
};

export type NotionUserConnectionSummary = {
  notionUserId: string;
  notionWorkspaceId: string | null;
  notionWorkspaceName: string | null;
  notionWorkspaceIcon: string | null;
  notionOwnerEmail: string | null;
  notionOwnerName: string | null;
  scopes: string[];
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
  connectedAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
};

export type NotionConnectionStatus = {
  configured: boolean;
  userConnection: NotionUserConnectionSummary | null;
};

export type NotionRuntimeCredentials = {
  notionUserId: string;
  workspaceId: string | null;
  workspaceName: string | null;
  ownerEmail: string | null;
  ownerName: string | null;
  token: string;
};

export class NotionConnectionNotConfiguredError extends Error {
  constructor(message = "Notion integration is not configured.") {
    super(message);
  }
}

function isExpired(value: string | null): boolean {
  if (!value) return false;
  const expiresAt = new Date(value).getTime();
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function toUserSummary(record: NotionConnectionRecord): NotionUserConnectionSummary {
  return {
    notionUserId: record.notionUserId,
    notionWorkspaceId: record.notionWorkspaceId,
    notionWorkspaceName: record.notionWorkspaceName,
    notionWorkspaceIcon: record.notionWorkspaceIcon,
    notionOwnerEmail: record.notionOwnerEmail,
    notionOwnerName: record.notionOwnerName,
    scopes: record.grantedScopes,
    accessTokenExpiresAt: record.accessTokenExpiresAt,
    refreshTokenExpiresAt: record.refreshTokenExpiresAt,
    connectedAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastUsedAt: record.tokenLastUsedAt
  };
}

function readNotionConfig(config: AppConfig): NotionOAuthConfig | null {
  if (!config.NOTION_OAUTH_CLIENT_ID || !config.NOTION_OAUTH_CLIENT_SECRET || !config.NOTION_OAUTH_REDIRECT_URI) {
    return null;
  }
  return {
    clientId: config.NOTION_OAUTH_CLIENT_ID,
    clientSecret: config.NOTION_OAUTH_CLIENT_SECRET,
    redirectUri: config.NOTION_OAUTH_REDIRECT_URI
  };
}

export class NotionConnectionService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: NotionConnectionStore,
    private readonly auditEvents?: AuditEventStore,
    private readonly runtimeManager?: RuntimeInvalidator
  ) {}

  isConfigured(): boolean {
    return readNotionConfig(this.config) !== null;
  }

  async getConnectionStatus(tenantId: string, userId: string): Promise<NotionConnectionStatus> {
    const userConnection = await this.store.get(tenantId, userId);
    return {
      configured: this.isConfigured(),
      userConnection: userConnection ? toUserSummary(userConnection) : null
    };
  }

  // Cheap presence check used by IntegrationRegistryService at session start.
  // Avoids the cost of decrypt + token-refresh that getRuntimeCredentials does.
  async hasConnection(tenantId: string, userId: string): Promise<boolean> {
    if (!this.isConfigured()) return false;
    const record = await this.store.get(tenantId, userId);
    if (!record) return false;
    return !isExpired(record.accessTokenExpiresAt);
  }

  async getAuthorizationUrl(input: { tenantId: string; userId: string }): Promise<string> {
    const oauth = readNotionConfig(this.config);
    if (!oauth) throw new NotionConnectionNotConfiguredError();

    const state = await new SignJWT({
      tid: input.tenantId,
      sub: input.userId
    } satisfies NotionStatePayload)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(NOTION_STATE_ISSUER)
      .setAudience(NOTION_STATE_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(NOTION_STATE_TTL)
      .sign(getSecretKey(this.config));

    const url = new URL(NOTION_AUTHORIZE_URL);
    url.searchParams.set("client_id", oauth.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("owner", "user");
    url.searchParams.set("redirect_uri", oauth.redirectUri);
    url.searchParams.set("state", state);
    return url.toString();
  }

  async completeAuthorization(input: { code?: string | null; state?: string | null }): Promise<string> {
    const fallbackUrl = buildIntegrationRedirectUrl(this.config, "/settings/notion", {
      notionAuth: "error",
      reason: "invalid_state"
    });

    if (!input.code || !input.state) {
      return buildIntegrationRedirectUrl(this.config, "/settings/notion", {
        notionAuth: "error",
        reason: input.code ? "missing_state" : "missing_code"
      });
    }

    let state: NotionStatePayload;
    try {
      const verified = await jwtVerify(input.state, getSecretKey(this.config), {
        issuer: NOTION_STATE_ISSUER,
        audience: NOTION_STATE_AUDIENCE,
        algorithms: ["HS256"]
      });
      const payload = verified.payload as Partial<NotionStatePayload>;
      if (typeof payload.tid !== "string" || typeof payload.sub !== "string") {
        return fallbackUrl;
      }
      state = { tid: payload.tid, sub: payload.sub };
    } catch {
      return fallbackUrl;
    }

    try {
      const oauth = readNotionConfig(this.config);
      if (!oauth) {
        return buildIntegrationRedirectUrl(this.config, "/settings/notion", {
          notionAuth: "error",
          reason: "notion_not_configured"
        });
      }

      const basicAuth = Buffer.from(`${oauth.clientId}:${oauth.clientSecret}`).toString("base64");

      const tokenResponse = await fetch(NOTION_TOKEN_URL, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basicAuth}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code: input.code,
          redirect_uri: oauth.redirectUri
        })
      });

      const tokenPayload = (await tokenResponse.json()) as NotionTokenResponse;
      if (!tokenResponse.ok || !tokenPayload.access_token) {
        throw new Error(
          tokenPayload.error_description ?? tokenPayload.error ?? "notion_token_exchange_failed"
        );
      }

      const ownerUser = tokenPayload.owner?.user;
      const notionUserId = ownerUser?.id;
      if (!notionUserId) {
        throw new Error("notion_owner_user_missing");
      }

      await this.store.upsert({
        tenantId: state.tid,
        userId: state.sub,
        notionUserId,
        notionWorkspaceId: tokenPayload.workspace_id ?? null,
        notionWorkspaceName: tokenPayload.workspace_name ?? null,
        notionWorkspaceIcon: tokenPayload.workspace_icon ?? null,
        notionBotId: tokenPayload.bot_id ?? null,
        notionOwnerEmail: ownerUser?.person?.email ?? null,
        notionOwnerName: ownerUser?.name ?? null,
        tokenType: tokenPayload.token_type ?? "bearer",
        // Notion's response does not include a `scope` field — capabilities are
        // configured on the integration in Notion's developer portal, not via OAuth scopes.
        grantedScopes: [],
        accessTokenEncrypted: encrypt(tokenPayload.access_token, this.config.DATA_ENCRYPTION_SECRET),
        accessTokenExpiresAt: toIsoFromNow(tokenPayload.expires_in),
        refreshTokenEncrypted: tokenPayload.refresh_token
          ? encrypt(tokenPayload.refresh_token, this.config.DATA_ENCRYPTION_SECRET)
          : null,
        refreshTokenExpiresAt: null,
        tokenLastRefreshedAt: tokenPayload.refresh_token ? new Date().toISOString() : null
      });

      await this.auditEvents?.create({
        tenantId: state.tid,
        sessionId: null,
        userId: state.sub,
        type: "user.notion.connected",
        payload: {
          notionUserId,
          notionWorkspaceId: tokenPayload.workspace_id ?? null,
          notionWorkspaceName: tokenPayload.workspace_name ?? null
        }
      });
      await this.runtimeManager?.invalidateRuntimesForIntegration(state.tid, state.sub, "notion");

      return buildIntegrationRedirectUrl(this.config, "/settings/notion", {
        notionAuth: "connected"
      });
    } catch (error) {
      return buildIntegrationRedirectUrl(this.config, "/settings/notion", {
        notionAuth: "error",
        reason: error instanceof Error ? error.message : "notion_authorization_failed"
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
        type: "user.notion.disconnected",
        payload: {
          notionUserId: existing.notionUserId,
          notionWorkspaceId: existing.notionWorkspaceId
        }
      });
      await this.runtimeManager?.invalidateRuntimesForIntegration(tenantId, userId, "notion");
    }

    return removed;
  }

  async getRuntimeCredentials(tenantId: string, userId: string): Promise<NotionRuntimeCredentials | null> {
    if (!this.isConfigured()) return null;

    const record = await this.store.get(tenantId, userId);
    if (!record) return null;

    // Notion currently issues non-expiring tokens. If/when expirations appear,
    // a refresh path will go here.
    if (isExpired(record.accessTokenExpiresAt)) {
      return null;
    }

    await this.store.markTokenUsed(tenantId, userId);

    return {
      notionUserId: record.notionUserId,
      workspaceId: record.notionWorkspaceId,
      workspaceName: record.notionWorkspaceName,
      ownerEmail: record.notionOwnerEmail,
      ownerName: record.notionOwnerName,
      token: decrypt(record.accessTokenEncrypted, this.config.DATA_ENCRYPTION_SECRET)
    };
  }

}
