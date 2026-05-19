import { test, expect } from "vitest";

import { decrypt, encrypt } from "../../../lib/crypto-utils.js";
import { createTestConfig } from "../../../test-helpers/test-config.js";
import { InMemoryAuditEventStore } from "../../../test-helpers/in-memory-audit-events.js";

import {
  GithubConnectionService,
  GithubConnectionNotConfiguredError,
  type GithubRuntimeCredentials
} from "./github-connection-service.js";
import type { GithubConnectionRecord } from "./github-connection-store.js";

class InMemoryGithubConnectionStore {
  record: GithubConnectionRecord | null = null;
  markUsedCount = 0;

  async get(): Promise<GithubConnectionRecord | null> {
    return this.record;
  }

  async upsert(input: Omit<GithubConnectionRecord, "createdAt" | "updatedAt" | "tokenLastUsedAt"> & {
    tokenLastRefreshedAt: string | null;
  }): Promise<GithubConnectionRecord> {
    const now = new Date().toISOString();
    this.record = {
      tenantId: input.tenantId,
      userId: input.userId,
      githubUserId: input.githubUserId,
      githubLogin: input.githubLogin,
      githubName: input.githubName,
      githubEmail: input.githubEmail,
      githubAvatarUrl: input.githubAvatarUrl,
      tokenType: input.tokenType,
      grantedScopes: input.grantedScopes,
      accessTokenEncrypted: input.accessTokenEncrypted,
      accessTokenExpiresAt: input.accessTokenExpiresAt,
      refreshTokenEncrypted: input.refreshTokenEncrypted,
      refreshTokenExpiresAt: input.refreshTokenExpiresAt,
      tokenLastRefreshedAt: input.tokenLastRefreshedAt,
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
      this.record = {
        ...this.record,
        tokenLastUsedAt: new Date().toISOString()
      };
    }
  }
}

function createOAuthConfig() {
  return createTestConfig({
    API_ORIGIN: "http://localhost:3000",
    GITHUB_OAUTH_CLIENT_ID: "github-oauth-client",
    GITHUB_OAUTH_CLIENT_SECRET: "github-oauth-secret",
    GITHUB_OAUTH_REDIRECT_URI: "http://localhost:3001/auth/github/user/callback"
  });
}

test("authorizes a user, persists encrypted tokens, and serves user runtime credentials", async () => {
  const config = createOAuthConfig();
  const store = new InMemoryGithubConnectionStore();
  const auditEvents = new InMemoryAuditEventStore();
  const invalidatedUsers: Array<{ tenantId: string; userId: string; integrationId: string }> = [];
  const service = new GithubConnectionService(config, {} as never, store, auditEvents, {
    async invalidateRuntimesForIntegration(tenantId: string, userId: string, integrationId: string) {
      invalidatedUsers.push({ tenantId, userId, integrationId });
      return [];
    }
  });

  const authorizeUrl = await service.getAuthorizationUrl({
    tenantId: "tenant-1",
    userId: "user-1"
  });
  const authState = new URL(authorizeUrl).searchParams.get("state");
  expect(authState).toBeTruthy();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url === "https://github.com/login/oauth/access_token") {
      return new Response(
        JSON.stringify({
          access_token: "ghu_user_token",
          token_type: "bearer",
          expires_in: 3600,
          refresh_token: "ghr_refresh_token",
          refresh_token_expires_in: 7200
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (url === "https://api.github.com/user") {
      return new Response(
        JSON.stringify({
          id: 12345,
          login: "octocat",
          name: "The Octocat",
          email: null,
          avatar_url: "https://avatars.githubusercontent.com/u/1?v=4"
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (url === "https://api.github.com/user/emails") {
      return new Response(
        JSON.stringify([
          { email: "octocat@example.com", verified: true, primary: true }
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  try {
    const authRedirect = await service.completeAuthorization({
      code: "oauth-code",
      state: authState
    });
    expect(authRedirect).toMatch(/githubAuth=connected/);
    expect(invalidatedUsers).toEqual([
            { tenantId: "tenant-1", userId: "user-1", integrationId: "github" }
          ]);
    expect(store.record).toBeTruthy();
    expect(store.record?.githubLogin).toBe("octocat");
    expect(store.record?.accessTokenEncrypted).not.toBe("ghu_user_token");
    expect(decrypt(String(store.record?.accessTokenEncrypted), config.DATA_ENCRYPTION_SECRET)).toBe("ghu_user_token");
    expect(auditEvents.events[0]?.type).toBe("user.github.connected");

    const runtimeCredentials = (await service.getRuntimeCredentials(
      "tenant-1",
      "user-1"
    )) as GithubRuntimeCredentials;
    expect(runtimeCredentials.token).toBe("ghu_user_token");
    expect(runtimeCredentials.login).toBe("octocat");
    expect(store.markUsedCount).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getRuntimeCredentials returns null when no user connection exists", async () => {
  const config = createOAuthConfig();
  const store = new InMemoryGithubConnectionStore();
  const service = new GithubConnectionService(config, {} as never, store, new InMemoryAuditEventStore());

  const credentials = await service.getRuntimeCredentials("tenant-1", "user-1");
  expect(credentials).toBe(null);
});

test("getRuntimeCredentials returns null when token expired and refresh fails", async () => {
  const config = createOAuthConfig();
  const store = new InMemoryGithubConnectionStore();
  store.record = {
    tenantId: "tenant-1",
    userId: "user-1",
    githubUserId: "12345",
    githubLogin: "octocat",
    githubName: "The Octocat",
    githubEmail: "octocat@example.com",
    githubAvatarUrl: null,
    tokenType: "bearer",
    grantedScopes: [],
    accessTokenEncrypted: encrypt("ghu_expired", config.DATA_ENCRYPTION_SECRET),
    accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    refreshTokenEncrypted: encrypt("ghr_refresh", config.DATA_ENCRYPTION_SECRET),
    refreshTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    tokenLastRefreshedAt: null,
    tokenLastUsedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const service = new GithubConnectionService(config, {} as never, store, new InMemoryAuditEventStore());

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "bad_refresh_token" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });

  try {
    const credentials = await service.getRuntimeCredentials("tenant-1", "user-1");
    expect(credentials).toBe(null);
    expect(store.markUsedCount).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getAuthorizationUrl throws when GitHub OAuth is not configured", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryGithubConnectionStore();
  const service = new GithubConnectionService(config, {} as never, store, new InMemoryAuditEventStore());

  await expect(() => service.getAuthorizationUrl({ tenantId: "tenant-1", userId: "user-1" })).rejects.toThrow(GithubConnectionNotConfiguredError);
});

test("hasConnection returns false when GitHub OAuth is not configured", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryGithubConnectionStore();
  const service = new GithubConnectionService(config, {} as never, store);

  expect(await service.hasConnection("tenant-1", "user-1")).toBe(false);
});

test("hasConnection returns true when a non-expired user record exists", async () => {
  const config = createOAuthConfig();
  const store = new InMemoryGithubConnectionStore();
  store.record = {
    tenantId: "tenant-1",
    userId: "user-1",
    githubUserId: "1",
    githubLogin: "octocat",
    githubName: null,
    githubEmail: null,
    githubAvatarUrl: null,
    tokenType: "bearer",
    grantedScopes: [],
    accessTokenEncrypted: encrypt("token", config.DATA_ENCRYPTION_SECRET),
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshTokenEncrypted: null,
    refreshTokenExpiresAt: null,
    tokenLastRefreshedAt: null,
    tokenLastUsedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const service = new GithubConnectionService(config, {} as never, store);

  expect(await service.hasConnection("tenant-1", "user-1")).toBe(true);
});

test("hasConnection returns false when token expired and no refresh available", async () => {
  const config = createOAuthConfig();
  const store = new InMemoryGithubConnectionStore();
  store.record = {
    tenantId: "tenant-1",
    userId: "user-1",
    githubUserId: "1",
    githubLogin: "octocat",
    githubName: null,
    githubEmail: null,
    githubAvatarUrl: null,
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
  const service = new GithubConnectionService(config, {} as never, store);

  expect(await service.hasConnection("tenant-1", "user-1")).toBe(false);
});
