import { test, expect, onTestFinished } from "vitest";

import Fastify from "fastify";

import { registerTenantRoutes } from "./tenant.js";
import {
  DEFAULT_PII_PROTECTION,
  parsePiiProtection,
  type PiiProtectionSettings
} from "../services/pii/pii-policy.js";
import type { TenantOrgSettingsStore } from "../services/tenant-org-settings-store.js";

// ---------------------------------------------------------------------------
// In-memory TenantOrgSettingsStore for route-level tests. The real store
// encrypts API keys; the fake just stores plaintext "marker" strings — these
// tests only assert on round-trip behavior + the "configured" boolean.
// ---------------------------------------------------------------------------

type FakeOrgSettingsState = {
  openaiApiKey: string | null;
  anthropicApiKey: string | null;
  marketplaceUrl: string | null;
  pii: PiiProtectionSettings | null;
};

function makeFakeOrgSettingsStore(initial: Partial<FakeOrgSettingsState> = {}): {
  store: TenantOrgSettingsStore;
  state: FakeOrgSettingsState;
} {
  const state: FakeOrgSettingsState = {
    openaiApiKey: initial.openaiApiKey ?? null,
    anthropicApiKey: initial.anthropicApiKey ?? null,
    marketplaceUrl: initial.marketplaceUrl ?? null,
    pii: initial.pii ?? null
  };
  const store = {
    async get(_tenantId: string) {
      return {
        tenantId: _tenantId,
        hasOpenaiApiKey: Boolean(state.openaiApiKey),
        hasAnthropicApiKey: Boolean(state.anthropicApiKey),
        skillMarketplaceManifestUrl: state.marketplaceUrl,
        piiProtection: state.pii ?? DEFAULT_PII_PROTECTION,
        updatedAt: new Date().toISOString()
      };
    },
    async getDecryptedOpenaiApiKey() {
      return state.openaiApiKey;
    },
    async getDecryptedAnthropicApiKey() {
      return state.anthropicApiKey;
    },
    async setApiKeys(_tenantId: string, input: { openaiApiKey?: string | null; anthropicApiKey?: string | null }) {
      if (input.openaiApiKey !== undefined) state.openaiApiKey = input.openaiApiKey;
      if (input.anthropicApiKey !== undefined) state.anthropicApiKey = input.anthropicApiKey;
    },
    async setMarketplaceUrl(_tenantId: string, url: string | null) {
      state.marketplaceUrl = url;
    },
    async setPiiProtection(_tenantId: string, policy: PiiProtectionSettings) {
      state.pii = policy;
    }
  } as unknown as TenantOrgSettingsStore;
  return { store, state };
}

// ---------------------------------------------------------------------------
// In-memory DB serving GET /tenant's `SELECT tenant_id ... FROM tenants`.
// All settings now live in the org-settings store, not in tenants.settings_json.
// ---------------------------------------------------------------------------

function makeTenantsDb() {
  const queryFn = async (text: string) => {
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK" || text.includes("set_config")) {
      return { rows: [] };
    }
    if (text.includes("SELECT tenant_id")) {
      return {
        rows: [
          {
            tenant_id: "tenant-1",
            tenant_name: "Test Tenant",
            slug: "test",
            sso_provider: null,
            plan: "free",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }
        ]
      };
    }
    return { rows: [] };
  };
  const client = { query: queryFn, release: () => {} };
  return {
    query: queryFn,
    connect: async () => client
  };
}

function makeOrgSettingsApp(role: string = "owner") {
  const app = Fastify();
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: "user-1",
      tenantId: "tenant-1",
      role,
      isAdmin: role === "admin"
    };
  });
  return app;
}

test("tenant role updates reject demoting an owner", async () => {
  let updateCalled = false;
  const client = {
    async query(text: string) {
      if (
        text === "BEGIN" ||
        text === "COMMIT" ||
        text === "ROLLBACK" ||
        text.includes("set_config")
      ) {
        return { rows: [] };
      }
      if (text.includes("SELECT role FROM tenant_memberships")) {
        return { rows: [{ role: "owner" }] };
      }
      if (text.includes("UPDATE tenant_memberships SET role")) {
        updateCalled = true;
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
    release() {}
  };
  const db = {
    async connect() {
      return client;
    }
  };

  const app = Fastify();
  onTestFinished(async () => {
        await app.close();
      });

  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: "admin-user",
      tenantId: "tenant-1",
      role: "admin",
      isAdmin: true
    };
  });

  await registerTenantRoutes(app, { db: db as never, tenantOrgSettings: makeFakeOrgSettingsStore().store });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/tenant/members/owner-user/role",
    payload: { role: "member" }
  });

  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({ error: "cannot_demote_owner" });
  expect(updateCalled).toBe(false);
});

test("tenant role updates still allow changing a non-owner member", async () => {
  const client = {
    async query(text: string, values: unknown[]) {
      if (
        text === "BEGIN" ||
        text === "COMMIT" ||
        text === "ROLLBACK" ||
        text.includes("set_config")
      ) {
        return { rows: [] };
      }
      if (text.includes("SELECT role FROM tenant_memberships")) {
        return { rows: [{ role: "member" }] };
      }
      if (text.includes("UPDATE tenant_memberships SET role")) {
        return {
          rows: [{ tenant_id: values[1], user_id: values[2], role: values[0] }]
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
    release() {}
  };
  const db = {
    async connect() {
      return client;
    }
  };

  const app = Fastify();
  onTestFinished(async () => {
        await app.close();
      });

  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: "owner-user",
      tenantId: "tenant-1",
      role: "owner",
      isAdmin: true
    };
  });

  await registerTenantRoutes(app, { db: db as never, tenantOrgSettings: makeFakeOrgSettingsStore().store });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/tenant/members/member-user/role",
    payload: { role: "admin" }
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
        tenant_id: "tenant-1",
        user_id: "member-user",
        role: "admin"
      });
});

// ---------------------------------------------------------------------------
// PUT /tenant/settings/marketplace
// ---------------------------------------------------------------------------

test("marketplace: valid URL is stored and returned", async () => {
  const { store, state } = makeFakeOrgSettingsStore();
  const db = makeTenantsDb();
  const app = makeOrgSettingsApp();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { db: db as never, tenantOrgSettings: store });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/tenant/settings/marketplace",
    payload: { skillMarketplaceManifestUrl: "https://example.com/manifest.json" }
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
        ok: true,
        skillMarketplaceManifestUrl: "https://example.com/manifest.json"
      });
  expect(state.marketplaceUrl).toBe("https://example.com/manifest.json");
});

test("marketplace: empty string is stored as null", async () => {
  const { store, state } = makeFakeOrgSettingsStore({ marketplaceUrl: "https://prev.example.com" });
  const db = makeTenantsDb();
  const app = makeOrgSettingsApp();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { db: db as never, tenantOrgSettings: store });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/tenant/settings/marketplace",
    payload: { skillMarketplaceManifestUrl: "" }
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ ok: true, skillMarketplaceManifestUrl: null });
  expect(state.marketplaceUrl).toBe(null);
});

test("marketplace: null is stored as null", async () => {
  const { store, state } = makeFakeOrgSettingsStore({ marketplaceUrl: "https://prev.example.com" });
  const db = makeTenantsDb();
  const app = makeOrgSettingsApp();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { db: db as never, tenantOrgSettings: store });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/tenant/settings/marketplace",
    payload: { skillMarketplaceManifestUrl: null }
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ ok: true, skillMarketplaceManifestUrl: null });
  expect(state.marketplaceUrl).toBe(null);
});

test("marketplace: whitespace-only string is stored as null, not a 400", async () => {
  const { store, state } = makeFakeOrgSettingsStore({ marketplaceUrl: "https://prev.example.com" });
  const db = makeTenantsDb();
  const app = makeOrgSettingsApp();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { db: db as never, tenantOrgSettings: store });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/tenant/settings/marketplace",
    payload: { skillMarketplaceManifestUrl: "   " }
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ ok: true, skillMarketplaceManifestUrl: null });
  expect(state.marketplaceUrl).toBe(null);
});

test("marketplace: invalid URL returns 400 invalid_url", async () => {
  const { store } = makeFakeOrgSettingsStore();
  const db = makeTenantsDb();
  const app = makeOrgSettingsApp();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { db: db as never, tenantOrgSettings: store });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/tenant/settings/marketplace",
    payload: { skillMarketplaceManifestUrl: "not-a-url" }
  });

  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ error: "invalid_url" });
});

test("marketplace: http:// URL returns 400 invalid_url (SSRF protection)", async () => {
  const { store } = makeFakeOrgSettingsStore();
  const db = makeTenantsDb();
  const app = makeOrgSettingsApp();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { db: db as never, tenantOrgSettings: store });
  await app.ready();

  for (const badUrl of ["http://example.com/manifest.json", "file:///etc/passwd", "ftp://example.com/x"]) {
    const response = await app.inject({
      method: "PUT",
      url: "/tenant/settings/marketplace",
      payload: { skillMarketplaceManifestUrl: badUrl }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_url" });
  }
});

test("marketplace: private/reserved IP URLs are rejected (SSRF protection)", async () => {
  const { store, state } = makeFakeOrgSettingsStore();
  const db = makeTenantsDb();
  const app = makeOrgSettingsApp();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { db: db as never, tenantOrgSettings: store });
  await app.ready();

  const ssrfUrls = [
    // AWS IMDS — the canonical SSRF target on EC2/ECS hosts.
    "https://169.254.169.254/latest/meta-data/iam/security-credentials/",
    // Loopback / localhost.
    "https://127.0.0.1/manifest.json",
    "https://127.0.0.1:8080/manifest.json",
    // RFC1918 private ranges.
    "https://10.0.0.1/manifest.json",
    "https://192.168.1.1/manifest.json",
    "https://172.16.0.1/manifest.json",
    // IPv6 loopback.
    "https://[::1]/manifest.json",
    // Numeric-shaped formats the OS resolver may still treat as IPs.
    "https://2130706433/manifest.json", // 32-bit form of 127.0.0.1
    "https://0177.0.0.1/manifest.json"  // octal-shaped 127.0.0.1
  ];

  for (const ssrfUrl of ssrfUrls) {
    const response = await app.inject({
      method: "PUT",
      url: "/tenant/settings/marketplace",
      payload: { skillMarketplaceManifestUrl: ssrfUrl }
    });
    expect(response.statusCode, `expected 400 for ${ssrfUrl}`).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_url" });
  }

  // Critical: the store must NOT have been touched by any of the rejected URLs.
  expect(state.marketplaceUrl).toBe(null);
});

test("marketplace: URL longer than 2048 chars returns 400 url_too_long", async () => {
  const { store } = makeFakeOrgSettingsStore();
  const db = makeTenantsDb();
  const app = makeOrgSettingsApp();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { db: db as never, tenantOrgSettings: store });
  await app.ready();

  const longUrl = "https://example.com/" + "a".repeat(2048);
  const response = await app.inject({
    method: "PUT",
    url: "/tenant/settings/marketplace",
    payload: { skillMarketplaceManifestUrl: longUrl }
  });

  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ error: "url_too_long" });
});

test("marketplace: member role returns 403", async () => {
  const { store } = makeFakeOrgSettingsStore();
  const db = makeTenantsDb();
  const app = makeOrgSettingsApp("member");
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { db: db as never, tenantOrgSettings: store });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/tenant/settings/marketplace",
    payload: { skillMarketplaceManifestUrl: "https://example.com/manifest.json" }
  });

  expect(response.statusCode).toBe(403);
});

test("GET /tenant response includes skillMarketplaceManifestUrl", async () => {
  const { store } = makeFakeOrgSettingsStore({
    marketplaceUrl: "https://example.com/manifest.json"
  });
  const db = makeTenantsDb();
  const app = makeOrgSettingsApp();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { db: db as never, tenantOrgSettings: store });
  await app.ready();

  const response = await app.inject({ method: "GET", url: "/tenant" });

  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body.settings.skillMarketplaceManifestUrl).toBe("https://example.com/manifest.json");
});

// ---------------------------------------------------------------------------
// piiProtection in GET /tenant
// ---------------------------------------------------------------------------

test("GET /tenant returns default piiProtection when setting is absent", async () => {
  const { store } = makeFakeOrgSettingsStore();
  const db = makeTenantsDb();
  const app = makeOrgSettingsApp();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { db: db as never, tenantOrgSettings: store });
  await app.ready();

  const response = await app.inject({ method: "GET", url: "/tenant" });

  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body.settings.piiProtection).toBeTruthy();
  expect(body.settings.piiProtection.enabled).toBe(false);
  expect(body.settings.piiProtection.mode).toBe("off");
  expect(body.settings.piiProtection.rawRetention).toBe("never");
  expect(body.settings.piiProtection.provider.type).toBe("openrouter");
  expect(body.settings.piiProtection.scopes.chatPrompts).toBe(true);
  expect(Array.isArray(body.settings.piiProtection.detectors.entityTypes)).toBeTruthy();
});

test("GET /tenant returns stored piiProtection when present and valid", async () => {
  const validPolicy = parsePiiProtection({
    enabled: true,
    mode: "detect",
    rawRetention: "never",
    provider: { type: "openrouter", model: "meta/llama-guard" },
    scopes: { chatPrompts: true, uploads: false, microsoftImports: true },
    actions: { reportToAdmins: true },
    detectors: { useRulesFirst: true, entityTypes: ["email", "phone"] }
  });
  const { store } = makeFakeOrgSettingsStore({ pii: validPolicy });
  const db = makeTenantsDb();
  const app = makeOrgSettingsApp();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { db: db as never, tenantOrgSettings: store });
  await app.ready();

  const response = await app.inject({ method: "GET", url: "/tenant" });

  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body.settings.piiProtection.enabled).toBe(true);
  expect(body.settings.piiProtection.mode).toBe("detect");
  expect(body.settings.piiProtection.provider.model).toBe("meta/llama-guard");
  expect(body.settings.piiProtection.scopes.uploads).toBe(false);
  expect(body.settings.piiProtection.detectors.entityTypes).toEqual(["email", "phone"]);
});

// ---------------------------------------------------------------------------
// PUT /tenant/settings/pii
// ---------------------------------------------------------------------------

const VALID_PII_PAYLOAD = {
  enabled: true,
  mode: "detect" as const,
  rawRetention: "never" as const,
  provider: { type: "openrouter" as const, model: "meta/llama-guard" },
  scopes: { chatPrompts: true, uploads: true, microsoftImports: false },
  actions: { reportToAdmins: true },
  detectors: { useRulesFirst: true, entityTypes: ["email", "phone"] as const }
};

test("PUT /tenant/settings/pii stores a valid payload", async () => {
  const { store, state } = makeFakeOrgSettingsStore();
  const db = makeTenantsDb();
  const app = makeOrgSettingsApp();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { db: db as never, tenantOrgSettings: store });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/tenant/settings/pii",
    payload: VALID_PII_PAYLOAD
  });

  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body.ok).toBe(true);
  expect(body.piiProtection).toEqual(VALID_PII_PAYLOAD);
  expect(state.pii).toEqual(VALID_PII_PAYLOAD);
});

test("PUT /tenant/settings/pii rejects invalid enum", async () => {
  const { store } = makeFakeOrgSettingsStore();
  const db = makeTenantsDb();
  const app = makeOrgSettingsApp();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { db: db as never, tenantOrgSettings: store });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/tenant/settings/pii",
    payload: { ...VALID_PII_PAYLOAD, mode: "bogus" }
  });

  expect(response.statusCode).toBe(400);
  const body = response.json();
  expect(body.error).toBe("validation_error");
  expect(Array.isArray(body.details)).toBeTruthy();
  expect(body.details.some((d: { path: string }) => d.path === "mode")).toBeTruthy();
  expect(typeof body.message).toBe("string");
  expect(body.message).toMatch(/mode/);
});

test("PUT /tenant/settings/pii rejects enabled+off combination", async () => {
  const { store } = makeFakeOrgSettingsStore();
  const db = makeTenantsDb();
  const app = makeOrgSettingsApp();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { db: db as never, tenantOrgSettings: store });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/tenant/settings/pii",
    payload: { ...VALID_PII_PAYLOAD, enabled: true, mode: "off" }
  });

  expect(response.statusCode).toBe(400);
  expect(response.json().error).toBe("invalid_combination");
});

test("PUT /tenant/settings/pii returns 403 for member role", async () => {
  const { store } = makeFakeOrgSettingsStore();
  const db = makeTenantsDb();
  const app = makeOrgSettingsApp("member");
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { db: db as never, tenantOrgSettings: store });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/tenant/settings/pii",
    payload: VALID_PII_PAYLOAD
  });

  expect(response.statusCode).toBe(403);
});

test("PUT /tenant/settings/pii rejects missing required fields", async () => {
  const { store } = makeFakeOrgSettingsStore();
  const db = makeTenantsDb();
  const app = makeOrgSettingsApp();
  onTestFinished(() => app.close());
  await registerTenantRoutes(app, { db: db as never, tenantOrgSettings: store });
  await app.ready();

  const response = await app.inject({
    method: "PUT",
    url: "/tenant/settings/pii",
    payload: { mode: "detect" }
  });

  expect(response.statusCode).toBe(400);
  expect(response.json().error).toBe("validation_error");
});
