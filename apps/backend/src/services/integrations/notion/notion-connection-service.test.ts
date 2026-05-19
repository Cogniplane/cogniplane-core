import { test, expect } from "vitest";

import { decrypt, encrypt } from "../../../lib/crypto-utils.js";
import { createTestConfig } from "../../../test-helpers/test-config.js";
import { InMemoryAuditEventStore } from "../../../test-helpers/in-memory-audit-events.js";

import {
  NotionConnectionService,
  NotionConnectionNotConfiguredError
} from "./notion-connection-service.js";
import type { NotionConnectionRecord } from "./notion-connection-store.js";

class InMemoryNotionConnectionStore {
  record: NotionConnectionRecord | null = null;
  markUsedCount = 0;

  async get(): Promise<NotionConnectionRecord | null> {
    return this.record;
  }

  async upsert(
    input: Omit<NotionConnectionRecord, "createdAt" | "updatedAt" | "tokenLastUsedAt"> & {
      tokenLastRefreshedAt: string | null;
    }
  ): Promise<NotionConnectionRecord> {
    const now = new Date().toISOString();
    this.record = {
      ...input,
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

  await expect(() => service.getAuthorizationUrl({ tenantId: "t", userId: "u" })).rejects.toThrow(NotionConnectionNotConfiguredError);
});

test("getAuthorizationUrl returns valid Notion URL", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000", ...NOTION_OAUTH_OVERRIDES });
  const store = new InMemoryNotionConnectionStore();
  const service = new NotionConnectionService(config, store);

  const url = await service.getAuthorizationUrl({ tenantId: "tenant-1", userId: "user-1" });
  const parsed = new URL(url);
  expect(parsed.hostname).toBe("api.notion.com");
  expect(parsed.pathname).toBe("/v1/oauth/authorize");
  expect(parsed.searchParams.get("client_id")).toBe("test-notion-client-id");
  expect(parsed.searchParams.get("response_type")).toBe("code");
  expect(parsed.searchParams.get("owner")).toBe("user");
  expect(parsed.searchParams.has("state")).toBeTruthy();
  expect(parsed.searchParams.get("redirect_uri")).toBe("http://localhost:3001/integrations/notion/callback");
});

test("completeAuthorization exchanges code and stores connection", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000", ...NOTION_OAUTH_OVERRIDES });
  const store = new InMemoryNotionConnectionStore();
  const auditEvents = new InMemoryAuditEventStore();
  const runtimeManager = new InMemoryRuntimeManager();
  const service = new NotionConnectionService(config, store, auditEvents, runtimeManager);

  // Get a valid state JWT by calling getAuthorizationUrl
  const authUrl = await service.getAuthorizationUrl({ tenantId: "tenant-1", userId: "user-1" });
  const validStateJwt = new URL(authUrl).searchParams.get("state")!;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url === "https://api.notion.com/v1/oauth/token") {
      // Verify Basic auth header is present
      const headers = new Headers(init?.headers as HeadersInit | undefined);
      const authHeader = headers.get("Authorization");
      expect(authHeader?.startsWith("Basic ")).toBeTruthy();
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
  };

  try {
    const redirectUrl = await service.completeAuthorization({
      code: "test-code",
      state: validStateJwt
    });
    expect(redirectUrl).toMatch(/notionAuth=connected/);
    expect(store.record).toBeTruthy();
    expect(store.record.notionUserId).toBe("notion-user-1");
    expect(store.record.notionWorkspaceId).toBe("ws-xyz");
    expect(store.record.notionWorkspaceName).toBe("Test Workspace");
    expect(store.record.notionOwnerEmail).toBe("test@example.com");
    expect(store.record.notionOwnerName).toBe("Test User");
    expect(decrypt(store.record.accessTokenEncrypted, config.DATA_ENCRYPTION_SECRET)).toBe("secret_notion_access_token");
    expect(auditEvents.events[0]?.type).toBe("user.notion.connected");
    expect(runtimeManager.invalidations).toEqual([
            { tenantId: "tenant-1", userId: "user-1", integrationId: "notion" }
          ]);
  } finally {
    globalThis.fetch = originalFetch;
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

test("completeAuthorization fails when token endpoint returns error", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000", ...NOTION_OAUTH_OVERRIDES });
  const store = new InMemoryNotionConnectionStore();
  const service = new NotionConnectionService(config, store);

  const authUrl = await service.getAuthorizationUrl({ tenantId: "tenant-1", userId: "user-1" });
  const validStateJwt = new URL(authUrl).searchParams.get("state")!;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "invalid_grant", error_description: "code expired" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });

  try {
    const redirectUrl = await service.completeAuthorization({
      code: "test-code",
      state: validStateJwt
    });
    expect(redirectUrl).toMatch(/notionAuth=error/);
    expect(redirectUrl).toMatch(/code\+expired|code%20expired/);
    expect(store.record).toBe(null);
  } finally {
    globalThis.fetch = originalFetch;
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

  const creds = await service.getRuntimeCredentials("tenant-1", "user-1");
  expect(creds).toBeTruthy();
  expect(creds.notionUserId).toBe("notion-user-1");
  expect(creds.workspaceId).toBe("ws-xyz");
  expect(creds.token).toBe("secret_notion_access_token");
  expect(store.markUsedCount).toBe(1);
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
