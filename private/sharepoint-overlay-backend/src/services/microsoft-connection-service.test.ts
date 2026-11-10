import { decodeJwt, decodeProtectedHeader } from "jose";
import { expect, test, vi } from "vitest";

import { decrypt, encrypt } from "../../../../apps/backend/src/lib/crypto-utils.js";
import { createTestConfig } from "../../../../apps/backend/src/test-helpers/test-config.js";
import { InMemoryAuditEventStore } from "../../../../apps/backend/src/test-helpers/in-memory-audit-events.js";
import { IntegrationOAuthStateStore } from "../../../../apps/backend/src/services/integrations/integration-oauth-state-store.js";

import {
  hasMicrosoftWriteScope,
  MicrosoftConnectionService,
  MicrosoftConnectionNotConfiguredError,
  MicrosoftInvalidEntraTenantError,
  isValidEntraTenantId
} from "./microsoft-connection-service.js";
import type { MicrosoftTenantConfig } from "./microsoft-connection-service.js";
import type { MicrosoftConnectionRecord, MicrosoftConnectionStore } from "./microsoft-connection-store.js";
import { OwnerSecurityVersionChangedError } from "../../../../apps/backend/src/services/auth/security-change.js";

class InMemoryMicrosoftConnectionStore {
  private records = new Map<string, MicrosoftConnectionRecord>();
  markUsedCount = 0;

  private key(tenantId: string, userId: string) { return JSON.stringify([tenantId, userId]); }

  get record(): MicrosoftConnectionRecord | null {
    return this.records.get(this.key("tenant-1", "user-1")) ?? null;
  }

  set record(value: MicrosoftConnectionRecord | null) {
    if (value) this.records.set(this.key(value.tenantId, value.userId), value);
    else this.records.delete(this.key("tenant-1", "user-1"));
  }

  // The stored owner_security_version per row, and the owner's current local
  // version (absent: a WorkOS owner). Same rule as ownerSecurityVersionSql.
  ownerVersions = new Map<string, number | null>();
  currentVersions = new Map<string, number>();

  private suspended(key: string): boolean {
    return this.currentVersions.has(key) && this.ownerVersions.get(key) !== this.currentVersions.get(key);
  }

  async get(tenantId: string, userId: string): Promise<MicrosoftConnectionRecord | null> {
    const key = this.key(tenantId, userId);
    return this.suspended(key) ? null : this.records.get(key) ?? null;
  }

  async getForOwner(tenantId: string, userId: string) {
    const key = this.key(tenantId, userId);
    const record = this.records.get(key);
    return record ? { ...record, suspended: this.suspended(key) } : null;
  }

  async confirm(tenantId: string, userId: string, microsoftUserId: string, ownerSecurityVersion: number | null) {
    const key = this.key(tenantId, userId);
    const record = this.records.get(key);
    // Same rule as the SQL: only a connection with the email that Graph returned.
    if (!record || record.microsoftUserId !== microsoftUserId || record.microsoftEmail === null) return null;
    this.ownerVersions.set(key, ownerSecurityVersion);
    return { ...record, suspended: this.suspended(key) };
  }

  async upsert(
    input: Omit<MicrosoftConnectionRecord, "createdAt" | "updatedAt" | "tokenLastUsedAt"> & {
      tokenLastRefreshedAt: string | null;
      ownerSecurityVersion: number | null;
    }
  ): Promise<MicrosoftConnectionRecord> {
    const key = this.key(input.tenantId, input.userId);
    const existing = this.records.get(key);
    const now = new Date().toISOString();
    const { ownerSecurityVersion, ...fields } = input;
    // Same rule as assertOwnerSecurityVersion: the callback write is bound to the current version.
    if ((this.currentVersions.get(key) ?? null) !== ownerSecurityVersion) throw new OwnerSecurityVersionChangedError();
    this.ownerVersions.set(key, ownerSecurityVersion);
    const record = {
      ...fields,
      tokenLastUsedAt: existing?.tokenLastUsedAt ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    this.records.set(key, record);
    return record;
  }

  updateRefreshedCalls = 0;

  // Same condition as the SQL: only the row the refresh started from. Never
  // creates a row and never changes the stored version.
  async updateRefreshedToken(input: Parameters<MicrosoftConnectionStore["updateRefreshedToken"]>[0]) {
    this.updateRefreshedCalls += 1;
    const key = this.key(input.tenantId, input.userId);
    const current = this.records.get(key);
    if (!current || current.microsoftUserId !== input.expectedMicrosoftUserId
      || current.refreshTokenEncrypted !== input.expectedRefreshTokenEncrypted || this.suspended(key)) return null;
    const { expectedMicrosoftUserId: _u, expectedRefreshTokenEncrypted: _r, ...fields } = input;
    const record = { ...current, ...fields, tokenLastRefreshedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    this.records.set(key, record);
    return record;
  }

  async delete(tenantId: string, userId: string): Promise<boolean> {
    return this.records.delete(this.key(tenantId, userId));
  }

  async markTokenUsed(tenantId: string, userId: string): Promise<void> {
    this.markUsedCount += 1;
    const key = this.key(tenantId, userId);
    const record = this.records.get(key);
    if (record) this.records.set(key, { ...record, tokenLastUsedAt: new Date().toISOString() });
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

type IntegrationRow = {
  readsEnabled: boolean;
  writesEnabled: boolean;
  config: Record<string, unknown>;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

class InMemoryIntegrationStateStore {
  private rows = new Map<string, IntegrationRow>();

  // Test-only seed: directly set the Microsoft config under tenant-1.
  seed(config: MicrosoftTenantConfig, tenantId = "tenant-1") {
    const now = new Date().toISOString();
    this.rows.set(`${tenantId}:microsoft`, {
      readsEnabled: false,
      writesEnabled: false,
      config: { ...config },
      updatedBy: null,
      createdAt: now,
      updatedAt: now
    });
  }

  async get(tenantId: string, integrationId: string) {
    const row = this.rows.get(`${tenantId}:${integrationId}`);
    if (!row) return null;
    return { tenantId, integrationId, ...row };
  }

  async upsert(
    tenantId: string,
    integrationId: string,
    patch: {
      readsEnabled?: boolean;
      writesEnabled?: boolean;
      config?: Record<string, unknown>;
      updatedBy?: string | null;
    }
  ) {
    const key = `${tenantId}:${integrationId}`;
    const existing = this.rows.get(key);
    const now = new Date().toISOString();
    const next: IntegrationRow = {
      readsEnabled: patch.readsEnabled ?? existing?.readsEnabled ?? false,
      writesEnabled: patch.writesEnabled ?? existing?.writesEnabled ?? false,
      config: patch.config ?? existing?.config ?? {},
      updatedBy: patch.updatedBy ?? existing?.updatedBy ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    this.rows.set(key, next);
    return { tenantId, integrationId, ...next };
  }
}

const TEST_ENTRA_TENANT_ID = "11111111-2222-3333-4444-555555555555";

function createMicrosoftTenantConfig(encryptionSecret: string): MicrosoftTenantConfig {
  return {
    clientId: "test-client-id",
    clientSecret: encrypt("test-client-secret", encryptionSecret),
    entraTenantId: TEST_ENTRA_TENANT_ID
  };
}

const TEST_REDIRECT_URI = "https://example.com/integrations/microsoft/callback";

test("getConnectionStatus returns configured: false when no tenant config", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryMicrosoftConnectionStore();
  const integrationStates = new InMemoryIntegrationStateStore();
  const service = new MicrosoftConnectionService(config, store, undefined, undefined, integrationStates, TEST_REDIRECT_URI);

  const status = await service.getConnectionStatus("tenant-1", "user-1");
  expect(status.configured).toBe(false);
  expect(status.userConnection).toBe(null);
});

test("getConnectionStatus returns configured: false when redirectUri is missing", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryMicrosoftConnectionStore();
  const integrationStates = new InMemoryIntegrationStateStore();
  integrationStates.seed(createMicrosoftTenantConfig(config.DATA_ENCRYPTION_SECRET));
  const service = new MicrosoftConnectionService(config, store, undefined, undefined, integrationStates, undefined);

  const status = await service.getConnectionStatus("tenant-1", "user-1");
  expect(status.configured).toBe(false);
  expect(status.userConnection).toBe(null);
});

test("getConnectionStatus returns configured: true with no connection", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryMicrosoftConnectionStore();
  const integrationStates = new InMemoryIntegrationStateStore();
  integrationStates.seed(createMicrosoftTenantConfig(config.DATA_ENCRYPTION_SECRET));
  const service = new MicrosoftConnectionService(config, store, undefined, undefined, integrationStates, TEST_REDIRECT_URI);

  const status = await service.getConnectionStatus("tenant-1", "user-1");
  expect(status.configured).toBe(true);
  expect(status.userConnection).toBe(null);
});

test("getAuthorizationUrl throws when not configured", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryMicrosoftConnectionStore();
  const integrationStates = new InMemoryIntegrationStateStore();
  const service = new MicrosoftConnectionService(config, store, undefined, undefined, integrationStates, TEST_REDIRECT_URI);

  await expect(() =>
    service.getAuthorizationUrl({ tenantId: "t", userId: "u", ownerSecurityVersion: null })
  ).rejects.toThrow(MicrosoftConnectionNotConfiguredError);
});

test("getAuthorizationUrl throws when redirectUri is missing", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryMicrosoftConnectionStore();
  const integrationStates = new InMemoryIntegrationStateStore();
  integrationStates.seed(createMicrosoftTenantConfig(config.DATA_ENCRYPTION_SECRET));
  const service = new MicrosoftConnectionService(config, store, undefined, undefined, integrationStates, undefined);

  await expect(() =>
    service.getAuthorizationUrl({ tenantId: "tenant-1", userId: "user-1", ownerSecurityVersion: null })
  ).rejects.toThrow(MicrosoftConnectionNotConfiguredError);
});

test("getAuthorizationUrl returns valid Entra ID URL", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryMicrosoftConnectionStore();
  const integrationStates = new InMemoryIntegrationStateStore();
  integrationStates.seed(createMicrosoftTenantConfig(config.DATA_ENCRYPTION_SECRET));
  const service = new MicrosoftConnectionService(config, store, undefined, undefined, integrationStates, TEST_REDIRECT_URI);

  const { url, browserBinding } = await service.getAuthorizationUrl({
    tenantId: "tenant-1",
    userId: "user-1",
    ownerSecurityVersion: null
  });
  const parsed = new URL(url);
  expect(parsed.hostname).toBe("login.microsoftonline.com");
  expect(parsed.pathname).toContain(TEST_ENTRA_TENANT_ID);
  expect(parsed.searchParams.has("state")).toBe(true);
  expect(parsed.searchParams.get("client_id")).toBe("test-client-id");
  expect(parsed.searchParams.get("response_type")).toBe("code");
  expect(parsed.searchParams.get("redirect_uri")).toBe(TEST_REDIRECT_URI);
  expect(parsed.searchParams.get("scope")).toContain("Files.Read.All");
  expect(parsed.searchParams.get("scope")).not.toContain("ReadWrite");
  expect(decodeProtectedHeader(parsed.searchParams.get("state")!).kid).toBe(config.JWT_KEY_ID);
  expect(browserBinding.name).toBe("cogniplane_oauth_bind_microsoft");
  expect(browserBinding.options).toMatchObject({
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: "/integrations/microsoft/callback",
    maxAge: 600
  });
});

// The Redis key must stay the same, so a state issued before a deploy is
// still valid after it.
test("getAuthorizationUrl asks for write scopes only when the tenant turned on writes", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const integrationStates = new InMemoryIntegrationStateStore();
  integrationStates.seed(createMicrosoftTenantConfig(config.DATA_ENCRYPTION_SECRET));
  await integrationStates.upsert("tenant-1", "microsoft", { writesEnabled: true });
  const service = new MicrosoftConnectionService(
    config, new InMemoryMicrosoftConnectionStore(), undefined, undefined, integrationStates, TEST_REDIRECT_URI
  );
  const { url } = await service.getAuthorizationUrl({ tenantId: "tenant-1", userId: "user-1", ownerSecurityVersion: null });
  const scope = new URL(url).searchParams.get("scope") ?? "";
  expect(scope).toContain("Files.ReadWrite.All");
  expect(scope).toContain("Sites.ReadWrite.All");
});

test("hasMicrosoftWriteScope accepts plain and resource-prefixed write scopes only", () => {
  expect(hasMicrosoftWriteScope(["Files.ReadWrite.All"])).toBe(true);
  expect(hasMicrosoftWriteScope(["https://graph.microsoft.com/Sites.ReadWrite.All"])).toBe(true);
  expect(hasMicrosoftWriteScope(["Files.Read.All", "Sites.Read.All"])).toBe(false);
});

test("getAuthorizationUrl stores the OAuth state under the persisted Microsoft Redis key", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const integrationStates = new InMemoryIntegrationStateStore();
  integrationStates.seed(createMicrosoftTenantConfig(config.DATA_ENCRYPTION_SECRET));
  const set = vi.fn(async () => "OK" as const);
  const getdel = vi.fn(async () => "issued");
  const service = new MicrosoftConnectionService(
    config,
    new InMemoryMicrosoftConnectionStore(),
    undefined,
    undefined,
    integrationStates,
    TEST_REDIRECT_URI,
    new IntegrationOAuthStateStore({ set, getdel } as never)
  );

  const { url } = await service.getAuthorizationUrl({ tenantId: "tenant-1", userId: "user-1", ownerSecurityVersion: null });
  const { jti } = decodeJwt(new URL(url).searchParams.get("state")!);

  expect(jti).toBeTruthy();
  expect(set).toHaveBeenCalledWith(`integration_oauth_state:microsoft:${jti}`, "issued", "EX", 600);
});

test("completeAuthorization exchanges code and stores connection", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryMicrosoftConnectionStore();
  const auditEvents = new InMemoryAuditEventStore();
  const runtimeManager = new InMemoryRuntimeManager();
  const integrationStates = new InMemoryIntegrationStateStore();
  integrationStates.seed(createMicrosoftTenantConfig(config.DATA_ENCRYPTION_SECRET));
  const service = new MicrosoftConnectionService(config, store, auditEvents, runtimeManager, integrationStates, TEST_REDIRECT_URI);

  // Get a valid state JWT by calling getAuthorizationUrl
  const { url: authUrl, browserBinding } = await service.getAuthorizationUrl({
    tenantId: "tenant-1",
    userId: "user-1",
    ownerSecurityVersion: null
  });
  const validStateJwt = new URL(authUrl).searchParams.get("state")!;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes("login.microsoftonline.com") && url.includes("/oauth2/v2.0/token")) {
      return new Response(
        JSON.stringify({
          access_token: "ms_access_token",
          token_type: "bearer",
          expires_in: 3600,
          refresh_token: "ms_refresh_token",
          scope: "User.Read Files.Read.All Sites.Read.All"
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (url === "https://graph.microsoft.com/v1.0/me") {
      return new Response(
        JSON.stringify({
          id: "ms-user-1",
          displayName: "Test User",
          mail: "test@example.com",
          userPrincipalName: "test@example.com"
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  try {
    const redirectUrl = await service.completeAuthorization({
      code: "test-code",
      state: validStateJwt,
      browserNonce: browserBinding.value
    });
    expect(redirectUrl).toMatch(/microsoftAuth=connected/);
    expect(store.record).toBeTruthy();
    expect(store.record!.microsoftUserId).toBe("ms-user-1");
    expect(decrypt(store.record!.accessTokenEncrypted, config.DATA_ENCRYPTION_SECRET)).toBe(
      "ms_access_token"
    );
    expect(auditEvents.events[0]?.type).toBe("user.microsoft.connected");
    expect(runtimeManager.invalidations).toEqual([
      { tenantId: "tenant-1", userId: "user-1", integrationId: "microsoft" }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("completeAuthorization rejects a state without the matching browser cookie", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryMicrosoftConnectionStore();
  const integrationStates = new InMemoryIntegrationStateStore();
  integrationStates.seed(createMicrosoftTenantConfig(config.DATA_ENCRYPTION_SECRET));
  const service = new MicrosoftConnectionService(config, store, undefined, undefined, integrationStates, TEST_REDIRECT_URI);
  const attacker = await service.getAuthorizationUrl({ tenantId: "tenant-1", userId: "attacker", ownerSecurityVersion: null });
  const victim = await service.getAuthorizationUrl({ tenantId: "tenant-1", userId: "victim", ownerSecurityVersion: null });
  const state = new URL(attacker.url).searchParams.get("state")!;

  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("token exchange must not run");
  };

  try {
    const noCookie = await service.completeAuthorization({ code: "code", state });
    const mismatched = await service.completeAuthorization({
      code: "code",
      state,
      browserNonce: victim.browserBinding.value
    });
    expect(noCookie).toMatch(/reason=invalid_state/);
    expect(mismatched).toMatch(/reason=invalid_state/);
    expect(fetchCalls).toBe(0);
    expect(store.record).toBe(null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("completeAuthorization rejects a replayed Microsoft state", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryMicrosoftConnectionStore();
  const integrationStates = new InMemoryIntegrationStateStore();
  integrationStates.seed(createMicrosoftTenantConfig(config.DATA_ENCRYPTION_SECRET));
  const service = new MicrosoftConnectionService(config, store, undefined, undefined, integrationStates, TEST_REDIRECT_URI);
  const { url, browserBinding } = await service.getAuthorizationUrl({
    tenantId: "tenant-1",
    userId: "user-1",
    ownerSecurityVersion: null
  });
  const state = new URL(url).searchParams.get("state")!;
  const browserNonce = browserBinding.value;

  let exchangeCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    exchangeCalls += 1;
    return new Response(JSON.stringify({ error: "invalid_grant" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const first = await service.completeAuthorization({ code: "code-1", state, browserNonce });
    const replay = await service.completeAuthorization({ code: "code-2", state, browserNonce });
    expect(first).toMatch(/microsoftAuth=error/);
    expect(first).not.toMatch(/reason=invalid_state/);
    expect(replay).toMatch(/reason=invalid_state/);
    expect(exchangeCalls).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("completeAuthorization does not put the token endpoint's error text in the redirect", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryMicrosoftConnectionStore();
  const integrationStates = new InMemoryIntegrationStateStore();
  integrationStates.seed(createMicrosoftTenantConfig(config.DATA_ENCRYPTION_SECRET));
  const service = new MicrosoftConnectionService(config, store, undefined, undefined, integrationStates, TEST_REDIRECT_URI);
  const { url, browserBinding } = await service.getAuthorizationUrl({ tenantId: "tenant-1", userId: "user-1", ownerSecurityVersion: null });
  const state = new URL(url).searchParams.get("state")!;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(
    { error: "invalid_grant", error_description: "AADSTS70008: trace 1234 correlation abcd" }, { status: 400 });

  try {
    const redirectUrl = await service.completeAuthorization({ code: "code", state, browserNonce: browserBinding.value });
    expect(new URL(redirectUrl).searchParams.get("reason")).toBe("microsoft_token_exchange_failed");
    expect(redirectUrl).not.toMatch(/AADSTS|correlation|invalid_grant/);
    expect(store.record).toBe(null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("completeAuthorization returns error redirect when code is missing", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryMicrosoftConnectionStore();
  const integrationStates = new InMemoryIntegrationStateStore();
  integrationStates.seed(createMicrosoftTenantConfig(config.DATA_ENCRYPTION_SECRET));
  const service = new MicrosoftConnectionService(config, store, undefined, undefined, integrationStates);

  const redirectUrl = await service.completeAuthorization({ code: null, state: "some-state" });
  expect(redirectUrl).toMatch(/microsoftAuth=error/);
});

test("disconnect removes record and emits audit event", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryMicrosoftConnectionStore();
  const auditEvents = new InMemoryAuditEventStore();
  const runtimeManager = new InMemoryRuntimeManager();
  const integrationStates = new InMemoryIntegrationStateStore();
  integrationStates.seed(createMicrosoftTenantConfig(config.DATA_ENCRYPTION_SECRET));
  const service = new MicrosoftConnectionService(config, store, auditEvents, runtimeManager, integrationStates);

  // Pre-populate store with a record
  store.record = {
    tenantId: "tenant-1",
    userId: "user-1",
    microsoftUserId: "ms-user-1",
    microsoftEmail: "test@example.com",
    microsoftDisplayName: "Test User",
    tokenType: "bearer",
    grantedScopes: ["User.Read", "Files.Read.All"],
    accessTokenEncrypted: encrypt("ms_access_token", config.DATA_ENCRYPTION_SECRET),
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshTokenEncrypted: encrypt("ms_refresh_token", config.DATA_ENCRYPTION_SECRET),
    refreshTokenExpiresAt: null,
    tokenLastRefreshedAt: null,
    tokenLastUsedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const removed = await service.disconnect("tenant-1", "user-1");
  expect(removed).toBe(true);
  expect(store.record).toBe(null);
  expect(auditEvents.events[0]?.type).toBe("user.microsoft.disconnected");
  expect(runtimeManager.invalidations).toEqual([
    { tenantId: "tenant-1", userId: "user-1", integrationId: "microsoft" }
  ]);
});

test("deleteConnection revokes the connection like a disconnect", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryMicrosoftConnectionStore();
  const auditEvents = new InMemoryAuditEventStore();
  const runtimeManager = new InMemoryRuntimeManager();
  const service = new MicrosoftConnectionService(config, store, auditEvents, runtimeManager, new InMemoryIntegrationStateStore());
  store.record = {
    tenantId: "tenant-1", userId: "user-1", microsoftUserId: "ms-user-1", microsoftEmail: "test@example.com",
    microsoftDisplayName: "Test User", tokenType: "bearer", grantedScopes: [],
    accessTokenEncrypted: encrypt("ms_access_token", config.DATA_ENCRYPTION_SECRET),
    accessTokenExpiresAt: null, refreshTokenEncrypted: null, refreshTokenExpiresAt: null,
    tokenLastRefreshedAt: null, tokenLastUsedAt: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };

  // Member removal calls deleteConnection through the integration registry.
  await expect(service.deleteConnection("tenant-1", "user-1")).resolves.toBe(true);
  expect(store.record).toBe(null);
  expect(auditEvents.events[0]?.type).toBe("user.microsoft.disconnected");
  expect(runtimeManager.invalidations).toEqual([{ tenantId: "tenant-1", userId: "user-1", integrationId: "microsoft" }]);
});

test("the Microsoft account is the stored user, and credentials refuse another one", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryMicrosoftConnectionStore();
  const integrationStates = new InMemoryIntegrationStateStore();
  integrationStates.seed(createMicrosoftTenantConfig(config.DATA_ENCRYPTION_SECRET));
  const service = new MicrosoftConnectionService(config, store, undefined, undefined, integrationStates);
  expect(await service.connectedAccountId("tenant-1", "user-1")).toBeNull();
  store.record = {
    tenantId: "tenant-1", userId: "user-1", microsoftUserId: "ms-user-b", microsoftEmail: "b@example.com",
    microsoftDisplayName: "B", tokenType: "bearer", grantedScopes: [],
    accessTokenEncrypted: encrypt("ms_access_token", config.DATA_ENCRYPTION_SECRET),
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshTokenEncrypted: null, refreshTokenExpiresAt: null, tokenLastRefreshedAt: null, tokenLastUsedAt: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };

  expect(await service.connectedAccountId("tenant-1", "user-1")).toBe("ms-user-b");
  await expect(service.getRuntimeCredentials("tenant-1", "user-1", "ms-user-a"))
    .rejects.toThrow("Microsoft 365 account changed");
  await expect(service.getRuntimeCredentials("tenant-1", "user-1", "ms-user-b"))
    .resolves.toMatchObject({ token: "ms_access_token" });
});

test("getRuntimeCredentials returns null when no tenant config", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryMicrosoftConnectionStore();
  const integrationStates = new InMemoryIntegrationStateStore();
  const service = new MicrosoftConnectionService(config, store, undefined, undefined, integrationStates);

  const creds = await service.getRuntimeCredentials("tenant-1", "user-1");
  expect(creds).toBe(null);
});

test("getRuntimeCredentials returns null when no connection", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryMicrosoftConnectionStore();
  const integrationStates = new InMemoryIntegrationStateStore();
  integrationStates.seed(createMicrosoftTenantConfig(config.DATA_ENCRYPTION_SECRET));
  const service = new MicrosoftConnectionService(config, store, undefined, undefined, integrationStates);

  const creds = await service.getRuntimeCredentials("tenant-1", "user-1");
  expect(creds).toBe(null);
});

test("getRuntimeCredentials returns decrypted token when connection exists", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryMicrosoftConnectionStore();
  const integrationStates = new InMemoryIntegrationStateStore();
  integrationStates.seed(createMicrosoftTenantConfig(config.DATA_ENCRYPTION_SECRET));
  const service = new MicrosoftConnectionService(config, store, undefined, undefined, integrationStates);

  // Pre-populate store with a record that has a future expiry
  store.record = {
    tenantId: "tenant-1",
    userId: "user-1",
    microsoftUserId: "ms-user-1",
    microsoftEmail: "test@example.com",
    microsoftDisplayName: "Test User",
    tokenType: "bearer",
    grantedScopes: ["User.Read", "Files.Read.All"],
    accessTokenEncrypted: encrypt("ms_access_token", config.DATA_ENCRYPTION_SECRET),
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshTokenEncrypted: encrypt("ms_refresh_token", config.DATA_ENCRYPTION_SECRET),
    refreshTokenExpiresAt: null,
    tokenLastRefreshedAt: null,
    tokenLastUsedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const creds = await service.getRuntimeCredentials("tenant-1", "user-1");
  expect(creds?.token).toBe("ms_access_token");
  expect(creds?.microsoftUserId).toBe("ms-user-1");
  expect(store.markUsedCount).toBe(1);
});

test("hasConnection returns false without tenant config", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryMicrosoftConnectionStore();
  const integrationStates = new InMemoryIntegrationStateStore();
  const service = new MicrosoftConnectionService(config, store, undefined, undefined, integrationStates);

  expect(await service.hasConnection("tenant-1", "user-1")).toBe(false);
});

test("hasConnection returns false without a user connection", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryMicrosoftConnectionStore();
  const integrationStates = new InMemoryIntegrationStateStore();
  integrationStates.seed(createMicrosoftTenantConfig(config.DATA_ENCRYPTION_SECRET));
  const service = new MicrosoftConnectionService(config, store, undefined, undefined, integrationStates);

  expect(await service.hasConnection("tenant-1", "user-1")).toBe(false);
});

test("hasConnection returns true when token is live", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryMicrosoftConnectionStore();
  store.record = {
    tenantId: "tenant-1",
    userId: "user-1",
    microsoftUserId: "ms-user-1",
    microsoftEmail: null,
    microsoftDisplayName: null,
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
  const integrationStates = new InMemoryIntegrationStateStore();
  integrationStates.seed(createMicrosoftTenantConfig(config.DATA_ENCRYPTION_SECRET));
  const service = new MicrosoftConnectionService(config, store, undefined, undefined, integrationStates);

  expect(await service.hasConnection("tenant-1", "user-1")).toBe(true);
});

test("hasConnection returns true when access token is expired but refresh token is on file", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryMicrosoftConnectionStore();
  store.record = {
    tenantId: "tenant-1",
    userId: "user-1",
    microsoftUserId: "ms-user-1",
    microsoftEmail: null,
    microsoftDisplayName: null,
    tokenType: "bearer",
    grantedScopes: [],
    accessTokenEncrypted: encrypt("token", config.DATA_ENCRYPTION_SECRET),
    accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
    refreshTokenEncrypted: encrypt("rt", config.DATA_ENCRYPTION_SECRET),
    refreshTokenExpiresAt: null,
    tokenLastRefreshedAt: null,
    tokenLastUsedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const integrationStates = new InMemoryIntegrationStateStore();
  integrationStates.seed(createMicrosoftTenantConfig(config.DATA_ENCRYPTION_SECRET));
  const service = new MicrosoftConnectionService(config, store, undefined, undefined, integrationStates);

  expect(await service.hasConnection("tenant-1", "user-1")).toBe(true);
});

test("hasConnection returns false when access token is expired and there is no refresh token", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryMicrosoftConnectionStore();
  store.record = {
    tenantId: "tenant-1",
    userId: "user-1",
    microsoftUserId: "ms-user-1",
    microsoftEmail: null,
    microsoftDisplayName: null,
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
  const integrationStates = new InMemoryIntegrationStateStore();
  integrationStates.seed(createMicrosoftTenantConfig(config.DATA_ENCRYPTION_SECRET));
  const service = new MicrosoftConnectionService(config, store, undefined, undefined, integrationStates);

  expect(await service.hasConnection("tenant-1", "user-1")).toBe(false);
});

test("setTenantMicrosoftConfig writes the merged config to tenant_integrations", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryMicrosoftConnectionStore();
  const integrationStates = new InMemoryIntegrationStateStore();
  integrationStates.seed(createMicrosoftTenantConfig(config.DATA_ENCRYPTION_SECRET));

  const service = new MicrosoftConnectionService(
    config,
    store,
    undefined,
    undefined,
    integrationStates
  );

  await service.setTenantMicrosoftConfig("tenant-1", { clientId: "rotated-client" });

  const row = await integrationStates.get("tenant-1", "microsoft");
  expect(row).toBeTruthy();
  expect((row!.config as Record<string, unknown>).clientId).toBe("rotated-client");
  expect((row!.config as Record<string, unknown>).entraTenantId).toBe(TEST_ENTRA_TENANT_ID);
});

test("isValidEntraTenantId accepts GUIDs, well-known aliases, and onmicrosoft domains", () => {
  expect(isValidEntraTenantId("11111111-2222-3333-4444-555555555555")).toBe(true);
  expect(isValidEntraTenantId("common")).toBe(true);
  expect(isValidEntraTenantId("organizations")).toBe(true);
  expect(isValidEntraTenantId("consumers")).toBe(true);
  expect(isValidEntraTenantId("contoso.onmicrosoft.com")).toBe(true);
});

test("isValidEntraTenantId rejects path/query/whitespace injection", () => {
  expect(isValidEntraTenantId("common/oauth2/v2.0/token?evil=1")).toBe(false);
  expect(isValidEntraTenantId("common#frag")).toBe(false);
  expect(isValidEntraTenantId("../evil")).toBe(false);
  expect(isValidEntraTenantId("evil.com")).toBe(false);
  expect(isValidEntraTenantId("contoso.onmicrosoft.com.evil.com")).toBe(false);
  expect(isValidEntraTenantId("has space")).toBe(false);
  expect(isValidEntraTenantId("")).toBe(false);
  expect(isValidEntraTenantId("Common")).toBe(false);
});

test("setTenantMicrosoftConfig rejects an invalid entraTenantId", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryMicrosoftConnectionStore();
  const integrationStates = new InMemoryIntegrationStateStore();
  const service = new MicrosoftConnectionService(config, store, undefined, undefined, integrationStates);

  await expect(() =>
    service.setTenantMicrosoftConfig("tenant-1", {
      clientId: "c",
      clientSecret: "s",
      entraTenantId: "common/oauth2/v2.0/token"
    })
  ).rejects.toThrow(MicrosoftInvalidEntraTenantError);
});

test("getRuntimeCredentials collapses concurrent refreshes onto a single token exchange", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryMicrosoftConnectionStore();
  const integrationStates = new InMemoryIntegrationStateStore();
  integrationStates.seed(createMicrosoftTenantConfig(config.DATA_ENCRYPTION_SECRET));
  const service = new MicrosoftConnectionService(config, store, undefined, undefined, integrationStates);

  // Access token already expiring (within the refresh skew window) so both callers
  // would otherwise each redeem the single-use refresh token.
  store.record = {
    tenantId: "tenant-1",
    userId: "user-1",
    microsoftUserId: "ms-user-1",
    microsoftEmail: "test@example.com",
    microsoftDisplayName: "Test User",
    tokenType: "bearer",
    grantedScopes: ["User.Read", "Files.Read.All"],
    accessTokenEncrypted: encrypt("stale_token", config.DATA_ENCRYPTION_SECRET),
    accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    refreshTokenEncrypted: encrypt("ms_refresh_token", config.DATA_ENCRYPTION_SECRET),
    refreshTokenExpiresAt: null,
    tokenLastRefreshedAt: null,
    tokenLastUsedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  let tokenExchangeCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("login.microsoftonline.com") && url.includes("/oauth2/v2.0/token")) {
      tokenExchangeCount += 1;
      // Yield so a concurrent caller has a chance to enter before this resolves.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(
        JSON.stringify({
          access_token: "fresh_token",
          token_type: "bearer",
          expires_in: 3600,
          refresh_token: "rotated_refresh_token",
          scope: "User.Read Files.Read.All"
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  vi.useFakeTimers();
  try {
    const credentials = Promise.all([
      service.getRuntimeCredentials("tenant-1", "user-1"),
      service.getRuntimeCredentials("tenant-1", "user-1")
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(tokenExchangeCount).toBe(1);
    await vi.advanceTimersByTimeAsync(5);
    const [a, b] = await credentials;
    expect(tokenExchangeCount).toBe(1);
    expect(a?.token).toBe("fresh_token");
    expect(b?.token).toBe("fresh_token");
  } finally {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  }
});

test("getTenantMicrosoftConfig returns null when the integration row has been cleared", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryMicrosoftConnectionStore();
  const integrationStates = new InMemoryIntegrationStateStore();
  // Admin pressed "Clear configuration": empty config row.
  await integrationStates.upsert("tenant-1", "microsoft", { config: {} });

  const service = new MicrosoftConnectionService(
    config,
    store,
    undefined,
    undefined,
    integrationStates
  );

  const status = await service.getConnectionStatus("tenant-1", "user-1");
  expect(status.configured).toBe(false);
});

test.each([
  ["tenant-1", "user-2"],
  ["tenant-2", "user-1"],
])("refresh and disconnect keep tenant-1/user-1 separate from %s/%s", async (otherTenant, otherUser) => {
  const config = createTestConfig();
  const store = new InMemoryMicrosoftConnectionStore();
  const integrationStates = new InMemoryIntegrationStateStore();
  const owners = [
    { tenantId: "tenant-1", userId: "user-1", suffix: "first" },
    { tenantId: otherTenant, userId: otherUser, suffix: "second" },
  ];
  for (const owner of owners) {
    integrationStates.seed(createMicrosoftTenantConfig(config.DATA_ENCRYPTION_SECRET), owner.tenantId);
    await store.upsert({
      tenantId: owner.tenantId, userId: owner.userId, microsoftUserId: `ms-${owner.suffix}`,
      microsoftEmail: null, microsoftDisplayName: null, tokenType: "bearer", grantedScopes: ["User.Read"],
      accessTokenEncrypted: encrypt(`old-${owner.suffix}`, config.DATA_ENCRYPTION_SECRET),
      accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      refreshTokenEncrypted: encrypt(`refresh-${owner.suffix}`, config.DATA_ENCRYPTION_SECRET),
      refreshTokenExpiresAt: null, tokenLastRefreshedAt: null, ownerSecurityVersion: null,
    });
  }
  const service = new MicrosoftConnectionService(config, store, undefined, undefined, integrationStates);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const refreshToken = new URLSearchParams(String(init?.body)).get("refresh_token");
    await gate;
    return Response.json({ access_token: refreshToken?.replace("refresh-", "fresh-"),
      expires_in: 3600, token_type: "bearer", scope: "User.Read" });
  });
  const credentials = Promise.all(owners.map(({ tenantId, userId }) => service.getRuntimeCredentials(tenantId, userId)));
  try {
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    release();
    expect((await credentials).map((value) => value?.token)).toEqual(["fresh-first", "fresh-second"]);
    for (const owner of owners) {
      const saved = await store.get(owner.tenantId, owner.userId);
      expect(decrypt(saved!.accessTokenEncrypted, config.DATA_ENCRYPTION_SECRET)).toBe(`fresh-${owner.suffix}`);
      expect(saved?.tokenLastUsedAt).not.toBeNull();
    }
    expect(await service.disconnect("tenant-1", "user-1")).toBe(true);
    expect(await service.getRuntimeCredentials("tenant-1", "user-1")).toBeNull();
    expect((await service.getRuntimeCredentials(otherTenant, otherUser))?.token).toBe("fresh-second");
  } finally {
    release();
    try { await credentials; } finally { fetch.mockRestore(); }
  }
});

// The connection keeps the security version of the session that started the
// authorization. A token refresh keeps that version. After a security change of
// the owner's account, only a confirm from a current session restores the
// connection.
test("a connection that an older session saved is suspended until a current session confirms it", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryMicrosoftConnectionStore();
  const auditEvents = new InMemoryAuditEventStore();
  const runtimeManager = new InMemoryRuntimeManager();
  const integrationStates = new InMemoryIntegrationStateStore();
  integrationStates.seed(createMicrosoftTenantConfig(config.DATA_ENCRYPTION_SECRET));
  const service = new MicrosoftConnectionService(config, store, auditEvents, runtimeManager, integrationStates, TEST_REDIRECT_URI);
  const key = JSON.stringify(["tenant-1", "user-1"]);
  store.currentVersions.set(key, 8);

  const { url, browserBinding } = await service.getAuthorizationUrl({
    tenantId: "tenant-1", userId: "user-1", ownerSecurityVersion: 8
  });
  const originalFetch = globalThis.fetch;
  let tokenRequests = 0;
  globalThis.fetch = async (input) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (requestUrl.includes("/oauth2/v2.0/token")) {
      tokenRequests += 1;
      // The first token expires within the refresh window, so the next use refreshes it.
      return Response.json({
        access_token: tokenRequests === 1 ? "ms_first" : "ms_attached", token_type: "bearer",
        expires_in: tokenRequests === 1 ? 60 : 3600, refresh_token: "ms_refresh"
      });
    }
    if (requestUrl === "https://graph.microsoft.com/v1.0/me") {
      return Response.json({ id: "ms-other", displayName: "Other", mail: "other@example.test" });
    }
    throw new Error(`Unexpected fetch URL: ${requestUrl}`);
  };
  try {
    expect(await service.completeAuthorization({
      code: "test-code", state: new URL(url).searchParams.get("state"), browserNonce: browserBinding.value
    })).toMatch(/microsoftAuth=connected/);
    expect(store.ownerVersions.get(key)).toBe(8);
    // The refresh writes through upsert and keeps the stored version.
    expect((await service.getRuntimeCredentials("tenant-1", "user-1"))?.token).toBe("ms_attached");
    expect(tokenRequests).toBe(2);
    expect(store.ownerVersions.get(key)).toBe(8);

    store.currentVersions.set(key, 9);
    expect(await service.getRuntimeCredentials("tenant-1", "user-1")).toBeNull();
    expect(await service.hasConnection("tenant-1", "user-1")).toBe(false);
    expect(await service.connectedAccountId("tenant-1", "user-1")).toBeNull();
    expect((await service.getConnectionStatus("tenant-1", "user-1")).userConnection)
      .toMatchObject({ microsoftUserId: "ms-other", suspended: true });

    await expect(service.confirm("tenant-1", "user-1", "ms-else", 9)).rejects.toMatchObject({ code: "account_changed" });
    expect(await service.confirm("tenant-1", "user-1", "ms-other", 8)).toMatchObject({ suspended: true });

    expect(await service.confirm("tenant-1", "user-1", "ms-other", 9)).toMatchObject({ suspended: false });
    expect((await service.getRuntimeCredentials("tenant-1", "user-1"))?.token).toBe("ms_attached");
    // The store writes user.microsoft.confirmed in the confirm's transaction (integration test).
    expect(runtimeManager.invalidations.at(-1)).toEqual({ tenantId: "tenant-1", userId: "user-1", integrationId: "microsoft" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// The callback has no session. An authorization that a session
// started before a security change must not overwrite the owner's connection.
test.each([
  ["a version older than the owner's current one", 8],
  ["no version for a local owner", null]
])("a callback with %s writes nothing and reports session_changed", async (_label, startedAt) => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryMicrosoftConnectionStore();
  const auditEvents = new InMemoryAuditEventStore();
  const integrationStates = new InMemoryIntegrationStateStore();
  integrationStates.seed(createMicrosoftTenantConfig(config.DATA_ENCRYPTION_SECRET));
  const service = new MicrosoftConnectionService(config, store, auditEvents, new InMemoryRuntimeManager(), integrationStates, TEST_REDIRECT_URI);
  const key = JSON.stringify(["tenant-1", "user-1"]);
  store.currentVersions.set(key, 9);
  store.record = {
    tenantId: "tenant-1", userId: "user-1", microsoftUserId: "ms-owner", microsoftEmail: "owner@example.test",
    microsoftDisplayName: null, tokenType: "bearer", grantedScopes: [], accessTokenEncrypted: "enc",
    accessTokenExpiresAt: null, refreshTokenEncrypted: null, refreshTokenExpiresAt: null, tokenLastRefreshedAt: null,
    tokenLastUsedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  store.ownerVersions.set(key, 9);

  const { url, browserBinding } = await service.getAuthorizationUrl({
    tenantId: "tenant-1", userId: "user-1", ownerSecurityVersion: startedAt
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (requestUrl.includes("/oauth2/v2.0/token")) return Response.json({ access_token: "ms_attacker", expires_in: 3600 });
    if (requestUrl === "https://graph.microsoft.com/v1.0/me") return Response.json({ id: "ms-attacker", mail: "a@example.test" });
    throw new Error(`Unexpected fetch URL: ${requestUrl}`);
  };
  try {
    const redirect = await service.completeAuthorization({
      code: "test-code", state: new URL(url).searchParams.get("state"), browserNonce: browserBinding.value
    });
    expect(new URL(redirect).searchParams.get("microsoftAuth")).toBe("error");
    expect(new URL(redirect).searchParams.get("reason")).toBe("session_changed");
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect(store.record?.microsoftUserId).toBe("ms-owner");
  expect(auditEvents.events.map((event) => event.type)).not.toContain("user.microsoft.connected");
});

// A token refresh has no session. It updates only the row it
// started from and never creates a row that a disconnect removed.
test.each([
  ["a disconnect", "disconnect"],
  ["a reconnect to another account", "reconnect"]
])("a refresh that finishes after %s writes nothing", async (_label, change) => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryMicrosoftConnectionStore();
  const integrationStates = new InMemoryIntegrationStateStore();
  integrationStates.seed(createMicrosoftTenantConfig(config.DATA_ENCRYPTION_SECRET));
  const service = new MicrosoftConnectionService(config, store, undefined, undefined, integrationStates);
  const connection = (microsoftUserId: string, refresh: string): MicrosoftConnectionRecord => ({
    tenantId: "tenant-1", userId: "user-1", microsoftUserId, microsoftEmail: null, microsoftDisplayName: null,
    tokenType: "bearer", grantedScopes: [], accessTokenEncrypted: encrypt("stale", config.DATA_ENCRYPTION_SECRET),
    accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    refreshTokenEncrypted: encrypt(refresh, config.DATA_ENCRYPTION_SECRET), refreshTokenExpiresAt: null,
    tokenLastRefreshedAt: null, tokenLastUsedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  });
  store.record = connection("ms-user-1", "refresh-1");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!requestUrl.includes("/oauth2/v2.0/token")) throw new Error(`Unexpected fetch URL: ${requestUrl}`);
    // The connection changes while the token request runs.
    if (change === "disconnect") store.record = null;
    else store.record = connection("ms-other", "refresh-other");
    return Response.json({ access_token: "fresh", expires_in: 3600, refresh_token: "rotated" });
  };
  try {
    expect(await service.getRuntimeCredentials("tenant-1", "user-1")).toBeNull();
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect(store.updateRefreshedCalls).toBe(1);
  if (change === "disconnect") expect(store.record).toBeNull();
  else expect(store.record?.microsoftUserId).toBe("ms-other");
});

// A failed refresh falls back to the stored token only while the connection
// that the refresh started from is still current and not suspended.
test.each([
  ["a disconnect", "disconnect", "a timeout"],
  ["a disconnect", "disconnect", "a refused refresh"],
  ["a suspension", "suspend", "a timeout"],
  ["a suspension", "suspend", "a refused refresh"],
  ["a reconnect to another account", "reconnect", "a timeout"],
  ["a reconnect to another account", "reconnect", "a refused refresh"]
])("a refresh that fails after %s returns no credentials (%s, %s)", async (_label, change, failure) => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryMicrosoftConnectionStore();
  const integrationStates = new InMemoryIntegrationStateStore();
  integrationStates.seed(createMicrosoftTenantConfig(config.DATA_ENCRYPTION_SECRET));
  const service = new MicrosoftConnectionService(config, store, undefined, undefined, integrationStates);
  const connection = (microsoftUserId: string, access: string): MicrosoftConnectionRecord => ({
    tenantId: "tenant-1", userId: "user-1", microsoftUserId, microsoftEmail: null, microsoftDisplayName: null,
    tokenType: "bearer", grantedScopes: [], accessTokenEncrypted: encrypt(access, config.DATA_ENCRYPTION_SECRET),
    // Inside the refresh window and still valid: getRuntimeCredentials refreshes first.
    accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    refreshTokenEncrypted: encrypt(`refresh-${microsoftUserId}`, config.DATA_ENCRYPTION_SECRET),
    refreshTokenExpiresAt: null, tokenLastRefreshedAt: null, tokenLastUsedAt: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  });
  const key = JSON.stringify(["tenant-1", "user-1"]);
  store.record = connection("ms-user-1", "old-token");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    // The connection changes while the token request runs.
    if (change === "disconnect") store.record = null;
    else if (change === "suspend") { store.currentVersions.set(key, 2); store.ownerVersions.set(key, 1); }
    else store.record = connection("ms-other", "other-token");
    if (failure === "a timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    return Response.json({ error: "invalid_grant" }, { status: 400 });
  };
  try {
    expect(await service.getRuntimeCredentials("tenant-1", "user-1")).toBeNull();
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect(store.markUsedCount).toBe(0);
});

test("a refresh that fails after a reconnect to the same account returns the current token", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryMicrosoftConnectionStore();
  const integrationStates = new InMemoryIntegrationStateStore();
  integrationStates.seed(createMicrosoftTenantConfig(config.DATA_ENCRYPTION_SECRET));
  const service = new MicrosoftConnectionService(config, store, undefined, undefined, integrationStates);
  const connection = (access: string, expiresInMs: number): MicrosoftConnectionRecord => ({
    tenantId: "tenant-1", userId: "user-1", microsoftUserId: "ms-user-1", microsoftEmail: null,
    microsoftDisplayName: null, tokenType: "bearer", grantedScopes: [],
    accessTokenEncrypted: encrypt(access, config.DATA_ENCRYPTION_SECRET),
    accessTokenExpiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    refreshTokenEncrypted: encrypt(`refresh-${access}`, config.DATA_ENCRYPTION_SECRET),
    refreshTokenExpiresAt: null, tokenLastRefreshedAt: null, tokenLastUsedAt: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  });
  store.record = connection("old-token", 60_000);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    store.record = connection("new-token", 3_600_000);
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  };
  try {
    expect((await service.getRuntimeCredentials("tenant-1", "user-1"))?.token).toBe("new-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// A confirm needs an identity that the provider attests. Graph
// returned no email, and a display name proves nothing: no confirm.
test("a suspended connection without an email cannot be confirmed", async () => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryMicrosoftConnectionStore();
  const runtimeManager = new InMemoryRuntimeManager();
  const integrationStates = new InMemoryIntegrationStateStore();
  integrationStates.seed(createMicrosoftTenantConfig(config.DATA_ENCRYPTION_SECRET));
  const service = new MicrosoftConnectionService(config, store, undefined, runtimeManager, integrationStates, TEST_REDIRECT_URI);
  const key = JSON.stringify(["tenant-1", "user-1"]);
  store.currentVersions.set(key, 9);
  store.ownerVersions.set(key, 8);
  store.record = {
    tenantId: "tenant-1", userId: "user-1", microsoftUserId: "ms-1", microsoftEmail: null, microsoftDisplayName: "Me",
    tokenType: "bearer", grantedScopes: [], accessTokenEncrypted: "enc", accessTokenExpiresAt: null,
    refreshTokenEncrypted: null, refreshTokenExpiresAt: null, tokenLastRefreshedAt: null, tokenLastUsedAt: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  expect((await service.getConnectionStatus("tenant-1", "user-1")).userConnection)
    .toMatchObject({ microsoftEmail: null, suspended: true });
  await expect(service.confirm("tenant-1", "user-1", "ms-1", 9)).rejects.toMatchObject({ code: "not_attested" });
  expect(store.ownerVersions.get(key)).toBe(8);
  expect(runtimeManager.invalidations).toEqual([]);
});

test.each([
  ["a failed or timed-out request", async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); }],
  ["a body that is not JSON", async () => new Response("<html>gateway</html>", { status: 200 })]
])("getRuntimeCredentials keeps the stored token after %s at refresh", async (_case, answer) => {
  const config = createTestConfig({ API_ORIGIN: "http://localhost:3000" });
  const store = new InMemoryMicrosoftConnectionStore();
  const integrationStates = new InMemoryIntegrationStateStore();
  integrationStates.seed(createMicrosoftTenantConfig(config.DATA_ENCRYPTION_SECRET));
  const service = new MicrosoftConnectionService(config, store, undefined, undefined, integrationStates);
  store.record = {
    tenantId: "tenant-1", userId: "user-1", microsoftUserId: "ms-user-1", microsoftEmail: "test@example.com",
    microsoftDisplayName: "Test User", tokenType: "bearer", grantedScopes: ["User.Read", "Files.Read.All"],
    accessTokenEncrypted: encrypt("ms_old_access_token", config.DATA_ENCRYPTION_SECRET),
    // Inside the refresh window and still valid: getRuntimeCredentials refreshes first.
    accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    refreshTokenEncrypted: encrypt("ms_refresh_token", config.DATA_ENCRYPTION_SECRET), refreshTokenExpiresAt: null,
    tokenLastRefreshedAt: null, tokenLastUsedAt: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  const signals: Array<AbortSignal | null | undefined> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    signals.push(init?.signal);
    return answer();
  };
  try {
    const creds = await service.getRuntimeCredentials("tenant-1", "user-1");
    expect(creds?.token).toBe("ms_old_access_token");
    // The refresh has a time limit, so a stalled one cannot hold the member's later calls.
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
