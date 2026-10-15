import { test, expect } from "vitest";
import { decodeProtectedHeader } from "jose";

import { decrypt, encrypt } from "../../../lib/crypto-utils.js";
import { createTestConfig } from "../../../test-helpers/test-config.js";
import { createFakeFetch } from "../../../test-helpers/fake-fetch.js";
import { InMemoryAuditEventStore } from "../../../test-helpers/in-memory-audit-events.js";

import {
  GithubConnectionService,
  GithubConnectionError,
  GithubConnectionNotConfiguredError,
  type GithubRuntimeCredentials
} from "./github-connection-service.js";
import type { GithubConnectionRecord, GithubConnectionStore } from "./github-connection-store.js";
import { InvalidGithubRepositoryListError } from "./github-repository-allowlist.js";

class InMemoryGithubConnectionStore {
  record: GithubConnectionRecord | null = null;
  markUsedCount = 0;

  async get(): Promise<GithubConnectionRecord | null> {
    return this.record;
  }

  async upsert(input: Omit<GithubConnectionRecord, "createdAt" | "updatedAt" | "tokenLastUsedAt" | "allowedRepositories"> & {
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
      // Same rule as the SQL: the same account keeps its list, another starts empty.
      allowedRepositories:
        this.record?.githubUserId === input.githubUserId ? this.record.allowedRepositories : [],
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

  async updateRefreshedToken(input: Parameters<GithubConnectionStore["updateRefreshedToken"]>[0]) {
    // Same condition as the SQL: only the connection the refresh started from.
    const current = this.record;
    if (
      !current ||
      current.githubUserId !== input.expectedGithubUserId ||
      current.refreshTokenEncrypted !== input.expectedRefreshTokenEncrypted
    ) {
      return null;
    }
    const { expectedGithubUserId: _u, expectedRefreshTokenEncrypted: _r, ...fields } = input;
    this.record = { ...current, ...fields, tokenLastRefreshedAt: new Date().toISOString() };
    return this.record;
  }

  async setAllowedRepositories(
    _tenantId: string,
    _userId: string,
    repositories: readonly string[],
    expectedGithubUserId: string
  ) {
    if (!this.record) return { status: "not_connected" } as const;
    if (this.record.githubUserId !== expectedGithubUserId) return { status: "account_changed" } as const;
    const previous = this.record.allowedRepositories;
    this.record = { ...this.record, allowedRepositories: [...repositories] };
    return { status: "updated", previous, record: this.record } as const;
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

test.each(["none", "audit", "audit_sync", "runtime", "runtime_sync"])("authorizes a user despite %s follow-up failure", async (failure) => {
  const config = createOAuthConfig();
  const store = new InMemoryGithubConnectionStore();
  const auditEvents = new InMemoryAuditEventStore();
  if (failure === "audit") auditEvents.create = async () => { throw new Error("audit unavailable"); };
  if (failure === "audit_sync") auditEvents.create = () => { throw new Error("audit unavailable"); };
  const invalidatedUsers: Array<{ tenantId: string; userId: string; integrationId: string }> = [];
  const service = new GithubConnectionService(config, store, auditEvents, {
    invalidateRuntimesForIntegration(tenantId: string, userId: string, integrationId: string) {
      invalidatedUsers.push({ tenantId, userId, integrationId });
      if (failure === "runtime") return Promise.reject(new Error("runtime unavailable"));
      if (failure === "runtime_sync") throw new Error("runtime unavailable");
      return Promise.resolve([]);
    }
  }, undefined, { warn() {} });

  const { url: authorizeUrl, browserBinding } = await service.getAuthorizationUrl({
    tenantId: "tenant-1",
    userId: "user-1"
  });
  const authState = new URL(authorizeUrl).searchParams.get("state");
  expect(authState).toBeTruthy();
  expect(decodeProtectedHeader(authState!).kid).toBe(config.JWT_KEY_ID);

  const fake = createFakeFetch((url) => {
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
  });

  try {
    const authRedirect = await service.completeAuthorization({
      code: "oauth-code",
      state: authState,
      browserNonce: browserBinding.value
    });
    expect(authRedirect).toMatch(/githubAuth=connected/);
    expect(invalidatedUsers).toEqual([
            { tenantId: "tenant-1", userId: "user-1", integrationId: "github" }
          ]);
    expect(store.record).toBeTruthy();
    expect(store.record?.githubLogin).toBe("octocat");
    expect(store.record?.accessTokenEncrypted).not.toBe("ghu_user_token");
    expect(decrypt(String(store.record?.accessTokenEncrypted), config.DATA_ENCRYPTION_SECRET)).toBe("ghu_user_token");
    if (!failure.startsWith("audit")) expect(auditEvents.events[0]?.type).toBe("user.github.connected");

    const runtimeCredentials = (await service.getRuntimeCredentials(
      "tenant-1",
      "user-1"
    )) as GithubRuntimeCredentials;
    expect(runtimeCredentials.token).toBe("ghu_user_token");
    expect(runtimeCredentials.login).toBe("octocat");
    expect(store.markUsedCount).toBe(1);
  } finally {
    fake.restore();
  }
});

test("getRuntimeCredentials returns null when no user connection exists", async () => {
  const config = createOAuthConfig();
  const store = new InMemoryGithubConnectionStore();
  const service = new GithubConnectionService(config, store, new InMemoryAuditEventStore());

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
    grantedScopes: [], allowedRepositories: [],
    accessTokenEncrypted: encrypt("ghu_expired", config.DATA_ENCRYPTION_SECRET),
    accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    refreshTokenEncrypted: encrypt("ghr_refresh", config.DATA_ENCRYPTION_SECRET),
    refreshTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    tokenLastRefreshedAt: null,
    tokenLastUsedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const service = new GithubConnectionService(config, store, new InMemoryAuditEventStore());

  const fake = createFakeFetch(
    () =>
      new Response(JSON.stringify({ error: "bad_refresh_token" }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      })
  );

  try {
    const credentials = await service.getRuntimeCredentials("tenant-1", "user-1");
    expect(credentials).toBe(null);
    expect(store.markUsedCount).toBe(0);
  } finally {
    fake.restore();
  }
});

test.each(["disconnect", "reconnect"])("a slow token refresh does not undo a %s", async (change) => {
  const config = createOAuthConfig();
  const store = new InMemoryGithubConnectionStore();
  const now = new Date().toISOString();
  store.record = {
    tenantId: "tenant-1",
    userId: "user-1",
    githubUserId: "12345",
    githubLogin: "octocat",
    githubName: null,
    githubEmail: null,
    githubAvatarUrl: null,
    tokenType: "bearer",
    grantedScopes: [], allowedRepositories: [],
    accessTokenEncrypted: encrypt("ghu_old", config.DATA_ENCRYPTION_SECRET),
    accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    refreshTokenEncrypted: encrypt("ghr_old", config.DATA_ENCRYPTION_SECRET),
    refreshTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    tokenLastRefreshedAt: null,
    tokenLastUsedAt: null,
    createdAt: now,
    updatedAt: now
  };
  const newConnection = {
    ...store.record,
    githubUserId: "67890",
    githubLogin: "other",
    refreshTokenEncrypted: encrypt("ghr_new", config.DATA_ENCRYPTION_SECRET)
  };
  const service = new GithubConnectionService(config, store, new InMemoryAuditEventStore());

  let release!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  let requested!: () => void;
  const refreshStarted = new Promise<void>((resolve) => { requested = resolve; });
  const fake = createFakeFetch(async () => {
    requested();
    await paused;
    return new Response(
      JSON.stringify({ access_token: "ghu_refreshed", token_type: "bearer", expires_in: 3600 }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });

  try {
    const pending = service.getRuntimeCredentials("tenant-1", "user-1");
    await refreshStarted;
    store.record = change === "disconnect" ? null : newConnection;
    release();

    expect(await pending).toBe(null);
    expect(store.record).toEqual(change === "disconnect" ? null : newConnection);
  } finally {
    fake.restore();
  }
});

test("getAuthorizationUrl throws when GitHub OAuth is not configured", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryGithubConnectionStore();
  const service = new GithubConnectionService(config, store, new InMemoryAuditEventStore());

  await expect(() => service.getAuthorizationUrl({ tenantId: "tenant-1", userId: "user-1" })).rejects.toThrow(GithubConnectionNotConfiguredError);
});

test("completeAuthorization consumes GitHub OAuth state before token exchange", async () => {
  const config = createOAuthConfig();
  const store = new InMemoryGithubConnectionStore();
  const service = new GithubConnectionService(config, store);
  const { url, browserBinding } = await service.getAuthorizationUrl({
    tenantId: "tenant-1",
    userId: "user-1"
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

    expect(first).toMatch(/githubAuth=error/);
    expect(first).toMatch(/reason=github_authorization_failed/);
    expect(first).not.toMatch(/invalid_grant/);
    expect(replay).toMatch(/reason=invalid_state/);
    expect(exchangeCalls).toBe(1);
  } finally {
    fake.restore();
  }
});

test("completeAuthorization rejects a state from another browser without storing a connection", async () => {
  const config = createOAuthConfig();
  const store = new InMemoryGithubConnectionStore();
  const service = new GithubConnectionService(config, store);
  // The attacker starts the flow; the victim's browser has no cookie or its own.
  const attacker = await service.getAuthorizationUrl({ tenantId: "tenant-a", userId: "attacker" });
  const victim = await service.getAuthorizationUrl({ tenantId: "tenant-v", userId: "victim" });
  const state = new URL(attacker.url).searchParams.get("state")!;
  let exchangeCalls = 0;
  const fake = createFakeFetch(() => {
    exchangeCalls += 1;
    throw new Error("token exchange must not run");
  });

  try {
    const noCookie = await service.completeAuthorization({ code: "code", state, browserNonce: null });
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

test("hasConnection returns false when GitHub OAuth is not configured", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryGithubConnectionStore();
  const service = new GithubConnectionService(config, store);

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
    grantedScopes: [], allowedRepositories: [],
    accessTokenEncrypted: encrypt("token", config.DATA_ENCRYPTION_SECRET),
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshTokenEncrypted: null,
    refreshTokenExpiresAt: null,
    tokenLastRefreshedAt: null,
    tokenLastUsedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const service = new GithubConnectionService(config, store);

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
    grantedScopes: [], allowedRepositories: [],
    accessTokenEncrypted: encrypt("token", config.DATA_ENCRYPTION_SECRET),
    accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
    refreshTokenEncrypted: null,
    refreshTokenExpiresAt: null,
    tokenLastRefreshedAt: null,
    tokenLastUsedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const service = new GithubConnectionService(config, store);

  expect(await service.hasConnection("tenant-1", "user-1")).toBe(false);
});

function githubRecord(config: ReturnType<typeof createOAuthConfig>, githubUserId: string): GithubConnectionRecord {
  return {
    tenantId: "tenant-1", userId: "user-1", githubUserId, githubLogin: "octocat", githubName: null,
    githubEmail: null, githubAvatarUrl: null, tokenType: "bearer", grantedScopes: [], allowedRepositories: [],
    accessTokenEncrypted: encrypt(`token-${githubUserId}`, config.DATA_ENCRYPTION_SECRET),
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshTokenEncrypted: null, refreshTokenExpiresAt: null, tokenLastRefreshedAt: null,
    tokenLastUsedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
}

test("connectedAccountId names the stored GitHub user", async () => {
  const config = createOAuthConfig();
  const store = new InMemoryGithubConnectionStore();
  const service = new GithubConnectionService(config, store);

  expect(await service.connectedAccountId("tenant-1", "user-1")).toBeNull();
  store.record = githubRecord(config, "42");
  expect(await service.connectedAccountId("tenant-1", "user-1")).toBe("42");
});

test("getRuntimeCredentials refuses the token of another account than the turn recorded", async () => {
  const config = createOAuthConfig();
  const store = new InMemoryGithubConnectionStore();
  store.record = githubRecord(config, "B");
  const service = new GithubConnectionService(config, store);

  // The check reads the same row that holds the token, so a reconnect between
  // the gateway check and this lookup cannot switch accounts.
  await expect(service.getRuntimeCredentials("tenant-1", "user-1", "A")).rejects.toThrow("GitHub account changed");
  await expect(service.getRuntimeCredentials("tenant-1", "user-1", null)).rejects.toThrow("GitHub account changed");
  expect(store.markUsedCount).toBe(0);
  await expect(service.getRuntimeCredentials("tenant-1", "user-1", "B")).resolves.toMatchObject({ token: "token-B" });
  // A context without a record keeps the old behaviour.
  await expect(service.getRuntimeCredentials("tenant-1", "user-1")).resolves.toMatchObject({ token: "token-B" });
  // Without a connection no token is used, so the usual "no connection" answer is safe.
  store.record = null;
  await expect(service.getRuntimeCredentials("tenant-1", "user-1", "B")).resolves.toBeNull();
});

// ── Allowed repositories ─────────────────────────────────────────────────────

test("getRuntimeCredentials passes the allowed repositories with the token, empty by default", async () => {
  const config = createOAuthConfig();
  const store = new InMemoryGithubConnectionStore();
  store.record = githubRecord(config, "1");
  const service = new GithubConnectionService(config, store);

  await expect(service.getRuntimeCredentials("tenant-1", "user-1")).resolves.toMatchObject({
    allowedRepositories: []
  });
  store.record = { ...store.record, allowedRepositories: ["acme/app"] };
  await expect(service.getRuntimeCredentials("tenant-1", "user-1")).resolves.toMatchObject({
    allowedRepositories: ["acme/app"]
  });
  expect((await service.getConnectionStatus("tenant-1", "user-1")).userConnection?.allowedRepositories)
    .toEqual(["acme/app"]);
});

test("setAllowedRepositories validates, lower-cases and de-duplicates the list, then audits the change", async () => {
  const config = createOAuthConfig();
  const store = new InMemoryGithubConnectionStore();
  store.record = { ...githubRecord(config, "1"), allowedRepositories: ["acme/old", "acme/keep"] };
  const auditEvents = new InMemoryAuditEventStore();
  const service = new GithubConnectionService(config, store, auditEvents);

  const saved = await service.setAllowedRepositories("tenant-1", "user-1", [
    " Acme/Keep ", "ACME/new", "acme/new", "acme/Another.Repo_1"
  ], "1");

  expect(saved).toEqual(["acme/another.repo_1", "acme/keep", "acme/new"]);
  expect(store.record.allowedRepositories).toEqual(saved);
  expect(auditEvents.events).toHaveLength(1);
  expect(auditEvents.events[0]).toMatchObject({
    userId: "user-1",
    type: "user.github.repositories_updated",
    payload: {
      githubLogin: "octocat",
      githubUserId: "1",
      added: ["acme/another.repo_1", "acme/new"],
      removed: ["acme/old"],
      count: 3
    }
  });
});

test("setAllowedRepositories writes no audit event when the list did not change", async () => {
  const config = createOAuthConfig();
  const store = new InMemoryGithubConnectionStore();
  store.record = { ...githubRecord(config, "1"), allowedRepositories: ["acme/app"] };
  const auditEvents = new InMemoryAuditEventStore();
  const service = new GithubConnectionService(config, store, auditEvents);

  await service.setAllowedRepositories("tenant-1", "user-1", ["Acme/App"], "1");

  expect(auditEvents.events).toEqual([]);
});

test.each([
  ["a name without an owner", ["app"]],
  ["a path segment", ["acme/app/contents"]],
  ["a dot segment", ["acme/.."]],
  ["a query string", ["acme/app?x=1"]],
  ["too many entries", Array.from({ length: 201 }, (_, i) => `acme/repo-${i}`)]
])("setAllowedRepositories rejects %s and keeps the stored list", async (_label, repositories) => {
  const config = createOAuthConfig();
  const store = new InMemoryGithubConnectionStore();
  store.record = { ...githubRecord(config, "1"), allowedRepositories: ["acme/app"] };
  const service = new GithubConnectionService(config, store);

  await expect(service.setAllowedRepositories("tenant-1", "user-1", repositories, "1")).rejects.toThrow(
    InvalidGithubRepositoryListError
  );
  expect(store.record.allowedRepositories).toEqual(["acme/app"]);
});

test("setAllowedRepositories refuses a list that was chosen for another GitHub account", async () => {
  const config = createOAuthConfig();
  const store = new InMemoryGithubConnectionStore();
  // Account A prepared the list in an old tab. A reconnect made account B the connected one.
  store.record = { ...githubRecord(config, "B"), allowedRepositories: ["b-org/private"] };
  const auditEvents = new InMemoryAuditEventStore();
  const service = new GithubConnectionService(config, store, auditEvents);

  await expect(service.setAllowedRepositories("tenant-1", "user-1", ["a-org/secret"], "A")).rejects.toMatchObject({
    code: "account_changed"
  });
  expect(store.record.allowedRepositories).toEqual(["b-org/private"]);
  expect(auditEvents.events).toEqual([]);
  // The same call for the connected account works.
  await expect(service.setAllowedRepositories("tenant-1", "user-1", ["b-org/other"], "B")).resolves.toEqual(["b-org/other"]);
});

test("setAllowedRepositories reports a missing connection", async () => {
  const service = new GithubConnectionService(createOAuthConfig(), new InMemoryGithubConnectionStore());

  await expect(service.setAllowedRepositories("tenant-1", "user-1", ["acme/app"], "1")).rejects.toMatchObject({
    code: "not_connected"
  });
});

function repositoryPage(count: number, offset = 0) {
  return Array.from({ length: count }, (_, i) => ({
    full_name: `Acme/repo-${offset + i}`, private: i % 2 === 0, archived: false, ignored: "field"
  }));
}

test("listAccessibleRepositories lists the repositories that the token reaches", async () => {
  const config = createOAuthConfig();
  const store = new InMemoryGithubConnectionStore();
  store.record = githubRecord(config, "1");
  const service = new GithubConnectionService(config, store);
  const fake = createFakeFetch(() => Response.json([
    { full_name: "Acme/App", private: true, archived: false },
    { full_name: "octocat/hello", private: false, archived: true },
    { private: true }
  ]));

  try {
    await expect(service.listAccessibleRepositories("tenant-1", "user-1")).resolves.toEqual({
      repositories: [
        { fullName: "Acme/App", private: true, archived: false },
        { fullName: "octocat/hello", private: false, archived: true }
      ],
      truncated: false
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.url).toMatch(/^https:\/\/api\.github\.com\/user\/repos\?per_page=100&page=1&/);
    expect((fake.calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer token-1");
  } finally {
    fake.restore();
  }
});

test("listAccessibleRepositories stops at three pages and says that the list is cut", async () => {
  const config = createOAuthConfig();
  const store = new InMemoryGithubConnectionStore();
  store.record = githubRecord(config, "1");
  const service = new GithubConnectionService(config, store);
  const fake = createFakeFetch((url) => Response.json(repositoryPage(100, (Number(new URL(url).searchParams.get("page")) - 1) * 100)));

  try {
    const listing = await service.listAccessibleRepositories("tenant-1", "user-1");
    expect(listing.repositories).toHaveLength(300);
    expect(listing.truncated).toBe(true);
    expect(fake.calls).toHaveLength(3);
  } finally {
    fake.restore();
  }
});

test("listAccessibleRepositories separates a missing connection, a rejected token and a GitHub failure", async () => {
  const config = createOAuthConfig();
  const store = new InMemoryGithubConnectionStore();
  const service = new GithubConnectionService(config, store, undefined, undefined, undefined, { warn() {} });

  await expect(service.listAccessibleRepositories("tenant-1", "user-1")).rejects.toMatchObject({
    code: "not_connected"
  });

  store.record = githubRecord(config, "1");
  let status = 401;
  const fake = createFakeFetch(() => new Response("{}", { status }));
  try {
    await expect(service.listAccessibleRepositories("tenant-1", "user-1")).rejects.toMatchObject({
      code: "credentials_unusable"
    });
    status = 502;
    await expect(service.listAccessibleRepositories("tenant-1", "user-1")).rejects.toBeInstanceOf(GithubConnectionError);
    await expect(service.listAccessibleRepositories("tenant-1", "user-1")).rejects.toMatchObject({
      code: "upstream_unavailable"
    });
  } finally {
    fake.restore();
  }

  // An expired token that cannot refresh is not usable either.
  store.record = { ...githubRecord(config, "1"), accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString() };
  await expect(service.listAccessibleRepositories("tenant-1", "user-1")).rejects.toMatchObject({
    code: "credentials_unusable"
  });
});
