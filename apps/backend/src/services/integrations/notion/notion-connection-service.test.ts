import { test, expect } from "vitest";
import { decodeProtectedHeader } from "jose";

import { decrypt, encrypt } from "../../../lib/crypto-utils.js";
import { createTestConfig } from "../../../test-helpers/test-config.js";
import { createFakeFetch } from "../../../test-helpers/fake-fetch.js";
import { InMemoryAuditEventStore } from "../../../test-helpers/in-memory-audit-events.js";

import {
  NotionConnectionService,
  NotionConnectionNotConfiguredError
} from "./notion-connection-service.js";
import type { NotionConnectionRecord } from "./notion-connection-store.js";
import { OwnerSecurityVersionChangedError } from "../../auth/security-change.js";

class InMemoryNotionConnectionStore {
  record: NotionConnectionRecord | null = null;
  markUsedCount = 0;
  // The stored owner_security_version, and the owner's current local version
  // (null: a WorkOS owner). Same rule as ownerSecurityVersionSql.
  ownerSecurityVersion: number | null = null;
  currentSecurityVersion: number | null = null;

  private suspended(): boolean {
    return this.currentSecurityVersion !== null && this.ownerSecurityVersion !== this.currentSecurityVersion;
  }

  async get(): Promise<NotionConnectionRecord | null> {
    return this.suspended() ? null : this.record;
  }

  async getForOwner() {
    return this.record ? { ...this.record, suspended: this.suspended() } : null;
  }

  async confirm(_tenantId: string, _userId: string,
    expected: { notionUserId: string; notionWorkspaceId: string | null }, ownerSecurityVersion: number | null) {
    // Same rule as the SQL: only a connection with an attested owner email.
    if (!this.record || this.record.notionUserId !== expected.notionUserId
      || this.record.notionWorkspaceId !== expected.notionWorkspaceId || this.record.notionOwnerEmail === null) return null;
    this.ownerSecurityVersion = ownerSecurityVersion;
    return { ...this.record, suspended: this.suspended() };
  }

  async upsert(
    input: Omit<NotionConnectionRecord, "createdAt" | "updatedAt" | "tokenLastUsedAt"> & {
      tokenLastRefreshedAt: string | null;
      ownerSecurityVersion: number | null;
    }
  ): Promise<NotionConnectionRecord> {
    const now = new Date().toISOString();
    const { ownerSecurityVersion, ...fields } = input;
    // Same rule as assertOwnerSecurityVersion: the callback write is bound to the current version.
    if (this.currentSecurityVersion !== ownerSecurityVersion) throw new OwnerSecurityVersionChangedError();
    this.ownerSecurityVersion = ownerSecurityVersion;
    this.record = {
      ...fields,
      tokenLastUsedAt: this.record?.tokenLastUsedAt ?? null,
      createdAt: this.record?.createdAt ?? now,
      updatedAt: now
    };
    return this.record;
  }

  async delete(): Promise<boolean> {
    const hadRecord = Boolean(this.record);
    this.record = null;
    return hadRecord;
  }

  async markTokenUsed(): Promise<void> {
    this.markUsedCount += 1;
    if (this.record) {
      this.record = { ...this.record, tokenLastUsedAt: new Date().toISOString() };
    }
  }
}

class InMemoryRuntimeManager {
  invalidations: Array<{ tenantId: string; userId: string; integrationId: string }> = [];

  async invalidateRuntimesForIntegration(
    tenantId: string,
    userId: string,
    integrationId: string
  ): Promise<string[]> {
    this.invalidations.push({ tenantId, userId, integrationId });
    return [];
  }
}

const NOTION_OAUTH_OVERRIDES = {
  NOTION_OAUTH_CLIENT_ID: "test-notion-client-id",
  NOTION_OAUTH_CLIENT_SECRET: "test-notion-client-secret",
  NOTION_OAUTH_REDIRECT_URI: "http://localhost:3001/integrations/notion/callback"
};

function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`Expected ${label}.`);
  return value;
}

test("getConnectionStatus returns configured: false when env vars are missing", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryNotionConnectionStore();
  const service = new NotionConnectionService(config, store);

  const status = await service.getConnectionStatus("tenant-1", "user-1");
  expect(status.configured).toBe(false);
  expect(status.userConnection).toBe(null);
});

test("getConnectionStatus returns configured: true when env vars are set", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000", ...NOTION_OAUTH_OVERRIDES });
  const store = new InMemoryNotionConnectionStore();
  const service = new NotionConnectionService(config, store);

  const status = await service.getConnectionStatus("tenant-1", "user-1");
  expect(status.configured).toBe(true);
  expect(status.userConnection).toBe(null);
});

test("getAuthorizationUrl throws when not configured", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryNotionConnectionStore();
  const service = new NotionConnectionService(config, store);

  await expect(() => service.getAuthorizationUrl({ tenantId: "t", userId: "u", ownerSecurityVersion: null })).rejects.toThrow(NotionConnectionNotConfiguredError);
});

test("getAuthorizationUrl returns valid Notion URL", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000", ...NOTION_OAUTH_OVERRIDES });
  const store = new InMemoryNotionConnectionStore();
  const service = new NotionConnectionService(config, store);

  const { url, browserBinding } = await service.getAuthorizationUrl({
    tenantId: "tenant-1",
    userId: "user-1",
    ownerSecurityVersion: null
  });
  const parsed = new URL(url);
  expect(parsed.hostname).toBe("api.notion.com");
  expect(parsed.pathname).toBe("/v1/oauth/authorize");
  expect(parsed.searchParams.get("client_id")).toBe("test-notion-client-id");
  expect(parsed.searchParams.get("response_type")).toBe("code");
  expect(parsed.searchParams.get("owner")).toBe("user");
  expect(parsed.searchParams.has("state")).toBeTruthy();
  expect(decodeProtectedHeader(parsed.searchParams.get("state")!).kid).toBe(config.JWT_KEY_ID);
  expect(parsed.searchParams.get("redirect_uri")).toBe("http://localhost:3001/integrations/notion/callback");
  expect(browserBinding.name).toBe("cogniplane_oauth_bind_notion");
  expect(browserBinding.options.path).toBe("/integrations/notion/callback");
});

test.each(["none", "audit", "audit_sync", "runtime", "runtime_sync"])("completeAuthorization stores connection despite %s follow-up failure", async (failure) => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000", ...NOTION_OAUTH_OVERRIDES });
  const store = new InMemoryNotionConnectionStore();
  const auditEvents = new InMemoryAuditEventStore();
  const runtimeManager = new InMemoryRuntimeManager();
  if (failure === "audit") auditEvents.create = async () => { throw new Error("audit unavailable"); };
  if (failure === "audit_sync") auditEvents.create = () => { throw new Error("audit unavailable"); };
  if (failure === "runtime") runtimeManager.invalidateRuntimesForIntegration = async () => { throw new Error("runtime unavailable"); };
  if (failure === "runtime_sync") runtimeManager.invalidateRuntimesForIntegration = () => { throw new Error("runtime unavailable"); };
  const service = new NotionConnectionService(config, store, auditEvents, runtimeManager, undefined, { warn() {} });

  // Get a valid state JWT by calling getAuthorizationUrl
  const { url: authUrl, browserBinding } = await service.getAuthorizationUrl({
    tenantId: "tenant-1",
    userId: "user-1",
    ownerSecurityVersion: null
  });
  const validStateJwt = new URL(authUrl).searchParams.get("state")!;

  const fake = createFakeFetch((url, init) => {
    if (url === "https://api.notion.com/v1/oauth/token") {
      // Verify Basic auth header is present
      const headers = new Headers(init?.headers as HeadersInit | undefined);
      const authHeader = requireValue(headers.get("Authorization"), "Authorization header");
      expect(authHeader.startsWith("Basic ")).toBeTruthy();
      const decoded = Buffer.from(authHeader.slice("Basic ".length), "base64").toString("utf8");
      expect(decoded).toBe("test-notion-client-id:test-notion-client-secret");

      return new Response(
        JSON.stringify({
          access_token: "secret_notion_access_token",
          token_type: "bearer",
          bot_id: "bot-abc",
          workspace_id: "ws-xyz",
          workspace_name: "Test Workspace",
          workspace_icon: "🦊",
          owner: {
            type: "user",
            user: {
              id: "notion-user-1",
              name: "Test User",
              avatar_url: null,
              person: { email: "test@example.com" }
            }
          }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  });

  try {
    const redirectUrl = await service.completeAuthorization({
      code: "test-code",
      state: validStateJwt,
      browserNonce: browserBinding.value
    });
    expect(redirectUrl).toMatch(/notionAuth=connected/);
    const record = requireValue(store.record, "stored Notion connection");
    expect(record.notionUserId).toBe("notion-user-1");
    expect(record.notionWorkspaceId).toBe("ws-xyz");
    expect(record.notionWorkspaceName).toBe("Test Workspace");
    expect(record.notionOwnerEmail).toBe("test@example.com");
    expect(record.notionOwnerName).toBe("Test User");
    expect(decrypt(record.accessTokenEncrypted, config.DATA_ENCRYPTION_SECRET)).toBe("secret_notion_access_token");
    if (!failure.startsWith("audit")) expect(auditEvents.events[0]?.type).toBe("user.notion.connected");
    if (!failure.startsWith("runtime")) expect(runtimeManager.invalidations).toEqual([
            { tenantId: "tenant-1", userId: "user-1", integrationId: "notion" }
          ]);
  } finally {
    fake.restore();
  }
});

test("completeAuthorization returns error redirect when code is missing", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000", ...NOTION_OAUTH_OVERRIDES });
  const store = new InMemoryNotionConnectionStore();
  const service = new NotionConnectionService(config, store);

  const redirectUrl = await service.completeAuthorization({ code: null, state: "some-state" });
  expect(redirectUrl).toMatch(/notionAuth=error/);
  expect(redirectUrl).toMatch(/reason=missing_code/);
});

test("completeAuthorization returns error redirect when state is invalid", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000", ...NOTION_OAUTH_OVERRIDES });
  const store = new InMemoryNotionConnectionStore();
  const service = new NotionConnectionService(config, store);

  const redirectUrl = await service.completeAuthorization({ code: "code", state: "not-a-jwt" });
  expect(redirectUrl).toMatch(/notionAuth=error/);
});

test("completeAuthorization consumes Notion OAuth state before token exchange", async () => {
  const config = createTestConfig({
    API_ORIGIN: "http://localhost:3000",
    ...NOTION_OAUTH_OVERRIDES
  });
  const store = new InMemoryNotionConnectionStore();
  const service = new NotionConnectionService(config, store);
  const { url, browserBinding } = await service.getAuthorizationUrl({
    tenantId: "tenant-1",
    userId: "user-1",
    ownerSecurityVersion: null
  });
  const state = new URL(url).searchParams.get("state")!;
  const browserNonce = browserBinding.value;
  let exchangeCalls = 0;
  const fake = createFakeFetch(() => {
    exchangeCalls += 1;
    return new Response(JSON.stringify({ error: "invalid_grant" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  });

  try {
    const first = await service.completeAuthorization({ code: "code-1", state, browserNonce });
    const replay = await service.completeAuthorization({ code: "code-2", state, browserNonce });

    expect(first).toMatch(/notionAuth=error/);
    expect(replay).toMatch(/reason=invalid_state/);
    expect(exchangeCalls).toBe(1);
  } finally {
    fake.restore();
  }
});

test("completeAuthorization rejects a state without the matching browser cookie", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000", ...NOTION_OAUTH_OVERRIDES });
  const store = new InMemoryNotionConnectionStore();
  const service = new NotionConnectionService(config, store);
  const attacker = await service.getAuthorizationUrl({ tenantId: "tenant-a", userId: "attacker", ownerSecurityVersion: null });
  const victim = await service.getAuthorizationUrl({ tenantId: "tenant-v", userId: "victim", ownerSecurityVersion: null });
  const state = new URL(attacker.url).searchParams.get("state")!;
  let exchangeCalls = 0;
  const fake = createFakeFetch(() => {
    exchangeCalls += 1;
    throw new Error("token exchange must not run");
  });

  try {
    const noCookie = await service.completeAuthorization({ code: "code", state });
    const mismatched = await service.completeAuthorization({
      code: "code",
      state,
      browserNonce: victim.browserBinding.value
    });

    expect(noCookie).toMatch(/reason=invalid_state/);
    expect(mismatched).toMatch(/reason=invalid_state/);
    expect(exchangeCalls).toBe(0);
    expect(store.record).toBe(null);
  } finally {
    fake.restore();
  }
});

test("completeAuthorization fails when token endpoint returns error", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000", ...NOTION_OAUTH_OVERRIDES });
  const store = new InMemoryNotionConnectionStore();
  const service = new NotionConnectionService(config, store);

  const { url: authUrl, browserBinding } = await service.getAuthorizationUrl({
    tenantId: "tenant-1",
    userId: "user-1",
    ownerSecurityVersion: null
  });
  const validStateJwt = new URL(authUrl).searchParams.get("state")!;

  const fake = createFakeFetch(
    () =>
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "code expired" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      })
  );

  try {
    const redirectUrl = await service.completeAuthorization({
      code: "test-code",
      state: validStateJwt,
      browserNonce: browserBinding.value
    });
    expect(redirectUrl).toMatch(/notionAuth=error/);
    expect(redirectUrl).toMatch(/reason=notion_authorization_failed/);
    expect(redirectUrl).not.toMatch(/code\+expired|code%20expired/);
    expect(store.record).toBe(null);
  } finally {
    fake.restore();
  }
});

test("completeAuthorization bounds the token request and handles a non-JSON gateway error", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000", ...NOTION_OAUTH_OVERRIDES });
  const store = new InMemoryNotionConnectionStore();
  const service = new NotionConnectionService(config, store);
  const { url: authUrl, browserBinding } = await service.getAuthorizationUrl({ tenantId: "tenant-1", userId: "user-1", ownerSecurityVersion: null });
  const state = new URL(authUrl).searchParams.get("state")!;
  let signal: AbortSignal | null | undefined;
  const fake = createFakeFetch((_url, init) => {
    signal = init?.signal;
    return new Response("<html>502 Bad Gateway</html>", { status: 502 });
  });

  try {
    const redirectUrl = await service.completeAuthorization({ code: "test-code", state, browserNonce: browserBinding.value });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(redirectUrl).toMatch(/reason=notion_authorization_failed/);
    expect(store.record).toBe(null);
  } finally {
    fake.restore();
  }
});

test("disconnect removes record and emits audit event", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000", ...NOTION_OAUTH_OVERRIDES });
  const store = new InMemoryNotionConnectionStore();
  const auditEvents = new InMemoryAuditEventStore();
  const runtimeManager = new InMemoryRuntimeManager();
  const service = new NotionConnectionService(config, store, auditEvents, runtimeManager);

  store.record = {
    tenantId: "tenant-1",
    userId: "user-1",
    notionUserId: "notion-user-1",
    notionWorkspaceId: "ws-xyz",
    notionWorkspaceName: "Test Workspace",
    notionWorkspaceIcon: null,
    notionBotId: "bot-abc",
    notionOwnerEmail: "test@example.com",
    notionOwnerName: "Test User",
    tokenType: "bearer",
    grantedScopes: [],
    accessTokenEncrypted: encrypt("secret_notion_access_token", config.DATA_ENCRYPTION_SECRET),
    accessTokenExpiresAt: null,
    refreshTokenEncrypted: null,
    refreshTokenExpiresAt: null,
    tokenLastRefreshedAt: null,
    tokenLastUsedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const removed = await service.disconnect("tenant-1", "user-1");
  expect(removed).toBe(true);
  expect(store.record).toBe(null);
  expect(auditEvents.events[0]?.type).toBe("user.notion.disconnected");
  expect(runtimeManager.invalidations).toEqual([
        { tenantId: "tenant-1", userId: "user-1", integrationId: "notion" }
      ]);
});

test("disconnect returns false when no record exists", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000", ...NOTION_OAUTH_OVERRIDES });
  const store = new InMemoryNotionConnectionStore();
  const service = new NotionConnectionService(config, store);

  const removed = await service.disconnect("tenant-1", "user-1");
  expect(removed).toBe(false);
});

test("getRuntimeCredentials returns null when not configured", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryNotionConnectionStore();
  const service = new NotionConnectionService(config, store);

  const creds = await service.getRuntimeCredentials("tenant-1", "user-1");
  expect(creds).toBe(null);
});

test("getRuntimeCredentials returns null when no connection exists", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000", ...NOTION_OAUTH_OVERRIDES });
  const store = new InMemoryNotionConnectionStore();
  const service = new NotionConnectionService(config, store);

  const creds = await service.getRuntimeCredentials("tenant-1", "user-1");
  expect(creds).toBe(null);
});

test("getRuntimeCredentials returns decrypted token and marks token used", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000", ...NOTION_OAUTH_OVERRIDES });
  const store = new InMemoryNotionConnectionStore();
  const service = new NotionConnectionService(config, store);

  store.record = {
    tenantId: "tenant-1",
    userId: "user-1",
    notionUserId: "notion-user-1",
    notionWorkspaceId: "ws-xyz",
    notionWorkspaceName: "Test Workspace",
    notionWorkspaceIcon: null,
    notionBotId: null,
    notionOwnerEmail: "test@example.com",
    notionOwnerName: "Test User",
    tokenType: "bearer",
    grantedScopes: [],
    accessTokenEncrypted: encrypt("secret_notion_access_token", config.DATA_ENCRYPTION_SECRET),
    accessTokenExpiresAt: null,
    refreshTokenEncrypted: null,
    refreshTokenExpiresAt: null,
    tokenLastRefreshedAt: null,
    tokenLastUsedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const creds = requireValue(
    await service.getRuntimeCredentials("tenant-1", "user-1"),
    "Notion runtime credentials"
  );
  expect(creds.notionUserId).toBe("notion-user-1");
  expect(creds.workspaceId).toBe("ws-xyz");
  expect(creds.token).toBe("secret_notion_access_token");
  expect(store.markUsedCount).toBe(1);
});

test("the Notion account is the user and workspace, and credentials refuse another one", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000", ...NOTION_OAUTH_OVERRIDES });
  const store = new InMemoryNotionConnectionStore();
  const service = new NotionConnectionService(config, store);
  expect(await service.connectedAccountId("tenant-1", "user-1")).toBeNull();
  store.record = {
    tenantId: "tenant-1", userId: "user-1", notionUserId: "notion-user-1", notionWorkspaceId: "ws-new",
    notionWorkspaceName: "New", notionWorkspaceIcon: null, notionBotId: null, notionOwnerEmail: null,
    notionOwnerName: null, tokenType: "bearer", grantedScopes: [],
    accessTokenEncrypted: encrypt("secret_notion_access_token", config.DATA_ENCRYPTION_SECRET),
    accessTokenExpiresAt: null, refreshTokenEncrypted: null, refreshTokenExpiresAt: null,
    tokenLastRefreshedAt: null, tokenLastUsedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };

  expect(await service.connectedAccountId("tenant-1", "user-1")).toBe("notion-user-1:ws-new");
  // The same Notion user in another workspace is another account.
  await expect(service.getRuntimeCredentials("tenant-1", "user-1", "notion-user-1:ws-old"))
    .rejects.toThrow("Notion account changed");
  expect(store.markUsedCount).toBe(0);
  await expect(service.getRuntimeCredentials("tenant-1", "user-1", "notion-user-1:ws-new"))
    .resolves.toMatchObject({ token: "secret_notion_access_token" });
});

test("getRuntimeCredentials returns null when access token has expired", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000", ...NOTION_OAUTH_OVERRIDES });
  const store = new InMemoryNotionConnectionStore();
  const service = new NotionConnectionService(config, store);

  store.record = {
    tenantId: "tenant-1",
    userId: "user-1",
    notionUserId: "notion-user-1",
    notionWorkspaceId: null,
    notionWorkspaceName: null,
    notionWorkspaceIcon: null,
    notionBotId: null,
    notionOwnerEmail: null,
    notionOwnerName: null,
    tokenType: "bearer",
    grantedScopes: [],
    accessTokenEncrypted: encrypt("expired", config.DATA_ENCRYPTION_SECRET),
    accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
    refreshTokenEncrypted: null,
    refreshTokenExpiresAt: null,
    tokenLastRefreshedAt: null,
    tokenLastUsedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const creds = await service.getRuntimeCredentials("tenant-1", "user-1");
  expect(creds).toBe(null);
});

test("hasConnection returns false when env vars are missing", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryNotionConnectionStore();
  store.record = {
    tenantId: "tenant-1",
    userId: "user-1",
    notionUserId: "n",
    notionWorkspaceId: null,
    notionWorkspaceName: null,
    notionWorkspaceIcon: null,
    notionBotId: null,
    notionOwnerEmail: null,
    notionOwnerName: null,
    tokenType: "bearer",
    grantedScopes: [],
    accessTokenEncrypted: encrypt("token", config.DATA_ENCRYPTION_SECRET),
    accessTokenExpiresAt: null,
    refreshTokenEncrypted: null,
    refreshTokenExpiresAt: null,
    tokenLastRefreshedAt: null,
    tokenLastUsedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const service = new NotionConnectionService(config, store);

  expect(await service.hasConnection("tenant-1", "user-1")).toBe(false);
});

test("hasConnection returns false when no record exists", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000", ...NOTION_OAUTH_OVERRIDES });
  const store = new InMemoryNotionConnectionStore();
  const service = new NotionConnectionService(config, store);

  expect(await service.hasConnection("tenant-1", "user-1")).toBe(false);
});

test("hasConnection returns true when configured and a non-expired record exists", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000", ...NOTION_OAUTH_OVERRIDES });
  const store = new InMemoryNotionConnectionStore();
  store.record = {
    tenantId: "tenant-1",
    userId: "user-1",
    notionUserId: "n",
    notionWorkspaceId: null,
    notionWorkspaceName: null,
    notionWorkspaceIcon: null,
    notionBotId: null,
    notionOwnerEmail: null,
    notionOwnerName: null,
    tokenType: "bearer",
    grantedScopes: [],
    accessTokenEncrypted: encrypt("token", config.DATA_ENCRYPTION_SECRET),
    accessTokenExpiresAt: null,
    refreshTokenEncrypted: null,
    refreshTokenExpiresAt: null,
    tokenLastRefreshedAt: null,
    tokenLastUsedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const service = new NotionConnectionService(config, store);

  expect(await service.hasConnection("tenant-1", "user-1")).toBe(true);
});

test("hasConnection returns false when the access token has expired", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000", ...NOTION_OAUTH_OVERRIDES });
  const store = new InMemoryNotionConnectionStore();
  store.record = {
    tenantId: "tenant-1",
    userId: "user-1",
    notionUserId: "n",
    notionWorkspaceId: null,
    notionWorkspaceName: null,
    notionWorkspaceIcon: null,
    notionBotId: null,
    notionOwnerEmail: null,
    notionOwnerName: null,
    tokenType: "bearer",
    grantedScopes: [],
    accessTokenEncrypted: encrypt("token", config.DATA_ENCRYPTION_SECRET),
    accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
    refreshTokenEncrypted: null,
    refreshTokenExpiresAt: null,
    tokenLastRefreshedAt: null,
    tokenLastUsedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const service = new NotionConnectionService(config, store);

  expect(await service.hasConnection("tenant-1", "user-1")).toBe(false);
});

// q4w0.8: see the GitHub test of the same name.
test("a connection that an older session saved is suspended until a current session confirms it", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000", ...NOTION_OAUTH_OVERRIDES });
  const store = new InMemoryNotionConnectionStore();
  const auditEvents = new InMemoryAuditEventStore();
  const runtimeManager = new InMemoryRuntimeManager();
  const service = new NotionConnectionService(config, store, auditEvents, runtimeManager, undefined, { warn() {} });
  store.currentSecurityVersion = 2;

  const { url, browserBinding } = await service.getAuthorizationUrl({
    tenantId: "tenant-1", userId: "user-1", ownerSecurityVersion: 2
  });
  const fake = createFakeFetch((requestUrl) => {
    if (requestUrl !== "https://api.notion.com/v1/oauth/token") throw new Error(`Unexpected fetch URL: ${requestUrl}`);
    return Response.json({
      access_token: "secret_attached", token_type: "bearer", bot_id: "bot-1", workspace_id: "ws-other",
      workspace_name: "Other workspace",
      owner: { type: "user", user: { id: "notion-other", name: "Other", person: { email: "other@example.test" } } }
    });
  });
  try {
    expect(await service.completeAuthorization({
      code: "test-code", state: new URL(url).searchParams.get("state"), browserNonce: browserBinding.value
    })).toMatch(/notionAuth=connected/);
  } finally {
    fake.restore();
  }
  expect(store.ownerSecurityVersion).toBe(2);
  expect((await service.getRuntimeCredentials("tenant-1", "user-1"))?.token).toBe("secret_attached");

  store.currentSecurityVersion = 3;
  expect(await service.getRuntimeCredentials("tenant-1", "user-1")).toBeNull();
  expect(await service.hasConnection("tenant-1", "user-1")).toBe(false);
  expect(await service.connectedAccountId("tenant-1", "user-1")).toBeNull();
  expect((await service.getConnectionStatus("tenant-1", "user-1")).userConnection)
    .toMatchObject({ notionUserId: "notion-other", suspended: true });

  await expect(service.confirm("tenant-1", "user-1", { notionUserId: "notion-other", notionWorkspaceId: "ws-x" }, 3))
    .rejects.toMatchObject({ code: "account_changed" });
  expect(await service.confirm("tenant-1", "user-1", { notionUserId: "notion-other", notionWorkspaceId: "ws-other" }, 2))
    .toMatchObject({ suspended: true });

  expect(await service.confirm("tenant-1", "user-1", { notionUserId: "notion-other", notionWorkspaceId: "ws-other" }, 3))
    .toMatchObject({ suspended: false });
  expect((await service.getRuntimeCredentials("tenant-1", "user-1"))?.token).toBe("secret_attached");
  // The store writes user.notion.confirmed in the confirm's transaction (integration test).
  expect(runtimeManager.invalidations.at(-1)).toEqual({ tenantId: "tenant-1", userId: "user-1", integrationId: "notion" });
});

// q4w0.8 review: the callback has no session. An authorization that a session
// started before a security change must not overwrite the owner's connection.
test.each([
  ["a version older than the owner's current one", 2],
  ["no version for a local owner", null]
])("a callback with %s writes nothing and reports session_changed", async (_label, startedAt) => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000", ...NOTION_OAUTH_OVERRIDES });
  const store = new InMemoryNotionConnectionStore();
  const auditEvents = new InMemoryAuditEventStore();
  const service = new NotionConnectionService(config, store, auditEvents, new InMemoryRuntimeManager(), undefined, { warn() {} });
  store.currentSecurityVersion = 3;
  store.ownerSecurityVersion = 3;
  store.record = {
    tenantId: "tenant-1", userId: "user-1", notionUserId: "owner", notionWorkspaceId: "ws-owner",
    notionWorkspaceName: "Owner", notionWorkspaceIcon: null, notionBotId: null, notionOwnerEmail: "owner@example.test",
    notionOwnerName: null, tokenType: "bearer", grantedScopes: [], accessTokenEncrypted: "enc", accessTokenExpiresAt: null,
    refreshTokenEncrypted: null, refreshTokenExpiresAt: null, tokenLastRefreshedAt: null, tokenLastUsedAt: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };

  const { url, browserBinding } = await service.getAuthorizationUrl({
    tenantId: "tenant-1", userId: "user-1", ownerSecurityVersion: startedAt
  });
  const fake = createFakeFetch(() => Response.json({
    access_token: "secret_attacker", token_type: "bearer", bot_id: "bot-x", workspace_id: "ws-attacker",
    owner: { type: "user", user: { id: "attacker", name: "Attacker" } }
  }));
  try {
    const redirect = await service.completeAuthorization({
      code: "test-code", state: new URL(url).searchParams.get("state"), browserNonce: browserBinding.value
    });
    expect(new URL(redirect).searchParams.get("notionAuth")).toBe("error");
    expect(new URL(redirect).searchParams.get("reason")).toBe("session_changed");
  } finally {
    fake.restore();
  }
  expect(store.record?.notionUserId).toBe("owner");
  expect(auditEvents.events.map((event) => event.type)).not.toContain("user.notion.connected");
});

// q4w0.8 review: a confirm needs an identity that the provider attests. Notion
// returned no owner email, so the user ID and the workspace name are all the
// page could show: no confirm. The owner connects again or disconnects.
test("a suspended connection without an owner email cannot be confirmed", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000", ...NOTION_OAUTH_OVERRIDES });
  const store = new InMemoryNotionConnectionStore();
  const runtimeManager = new InMemoryRuntimeManager();
  const service = new NotionConnectionService(config, store, undefined, runtimeManager, undefined, { warn() {} });
  store.currentSecurityVersion = 3;
  store.ownerSecurityVersion = 2;
  store.record = {
    tenantId: "tenant-1", userId: "user-1", notionUserId: "n-1", notionWorkspaceId: "ws-1",
    notionWorkspaceName: "My workspace", notionWorkspaceIcon: null, notionBotId: null, notionOwnerEmail: null,
    notionOwnerName: "Me", tokenType: "bearer", grantedScopes: [], accessTokenEncrypted: "enc", accessTokenExpiresAt: null,
    refreshTokenEncrypted: null, refreshTokenExpiresAt: null, tokenLastRefreshedAt: null, tokenLastUsedAt: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  expect((await service.getConnectionStatus("tenant-1", "user-1")).userConnection)
    .toMatchObject({ notionOwnerEmail: null, suspended: true });
  await expect(service.confirm("tenant-1", "user-1", { notionUserId: "n-1", notionWorkspaceId: "ws-1" }, 3))
    .rejects.toMatchObject({ code: "not_attested" });
  expect(store.ownerSecurityVersion).toBe(2);
  expect(runtimeManager.invalidations).toEqual([]);
});
