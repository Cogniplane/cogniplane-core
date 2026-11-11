import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { Pool } from "../../../../apps/backend/src/lib/db.js";
import type { AttachOverlaysInput } from "../../../../apps/backend/src/overlay-contracts.js";
import type { AuditEventInput } from "../../../../apps/backend/src/services/audit-event-store.js";
import type { LocalAuth } from "../../../../apps/backend/src/services/auth/local-auth.js";
import { RefreshTokenRotationService } from "../../../../apps/backend/src/services/auth/refresh-token-rotation-service.js";
import { OVERLAY_STEP_UP_ACTIONS, type OverlayStepUpAction } from "../../../../apps/backend/src/services/auth/step-up-routes.js";
import { StepUpStore } from "../../../../apps/backend/src/services/auth/step-up-store.js";
import { DataRouteControl } from "../../../../apps/backend/src/services/data-route-control.js";
import {
  __resetIntegrationRegistryForTesting,
  IntegrationRegistry
} from "../../../../apps/backend/src/services/integrations/integration-registry.js";
import type { DataSettingChange } from "../../../../apps/backend/src/services/mail/setting-change-notices.js";
import { ManagedToolCatalog } from "../../../../apps/backend/src/services/managed-tools/catalog.js";
import { ManagedToolFactoryRegistry } from "../../../../apps/backend/src/services/managed-tools/factory.js";
import { PiiImportScopeRegistry } from "../../../../apps/backend/src/services/pii/pii-import-scopes.js";
import { FakeRefreshTokenRedis } from "../../../../apps/backend/src/test-helpers/fake-refresh-token-redis.js";
import { createTestConfig } from "../../../../apps/backend/src/test-helpers/test-config.js";
import { bootstrap } from "../index.js";

// The overlay's part of the step-up census (apps/backend/src/routes/
// step-up-routes.test.ts checks the core plugins). The core list cannot name
// an overlay's route, so the overlay gives each overlay action
// (OVERLAY_STEP_UP_ACTIONS) to one of its routes here, and lists every other
// route of the overlay with the reason it needs no step-up. The routes come
// from bootstrap(...).attachRoutes, with the real DataRouteControl.

const OVERLAY_STEP_UP_ROUTES: Record<string, OverlayStepUpAction> = {
  "PUT /tenant/settings/microsoft": "integration.overlay_settings"
};

const NO_STEP_UP: Record<string, string> = {
  "DELETE /tenant/settings/microsoft": "removes the Microsoft app and turns the integration off",
  "GET /me/microsoft-connection": "read: the member's own connection",
  "POST /me/microsoft-connection/authorize":
    "starts the member's own OAuth sign-in at Microsoft, with the app that the step-up route saved; tracked in bead q4w0.8",
  "DELETE /me/microsoft-connection": "removes the member's own connection",
  "POST /me/microsoft-connection/confirm":
    "turns the member's own suspended connection on again; it needs a session at the current security version and an email that Microsoft attests (bead q4w0.8)",
  "POST /sessions/:sessionId/import-microsoft-file": "imports a file into the member's own session, through the upload checks",
  "GET /integrations/microsoft/sites": "read: the member's own Microsoft sites",
  "GET /integrations/microsoft/files": "read: the member's own Microsoft files",
  "GET /integrations/microsoft/files/search": "read: the member's own Microsoft files"
};

const TENANT_ID = "tenant-1";
const USER_ID = "owner-1";
const NOTICE: DataSettingChange = {
  setting: "integration",
  integrationName: "Microsoft 365",
  fields: ["Application (client) ID", "Client secret", "Directory (tenant) ID"]
};
const CHANGE_TRANSACTION = { transaction: "change" };
const CONFIG = { clientId: "client-id", clientSecret: "client-secret-value", entraTenantId: "contoso.onmicrosoft.com" };

function emptyPool(): Pool {
  const client = { query: async () => ({ rows: [] }), release: () => {} };
  return { connect: async () => client, query: async () => ({ rows: [] }) } as unknown as Pool;
}

async function buildApp(authSource: "local" | "workos" = "local") {
  const redis = new FakeRefreshTokenRedis();
  const refreshTokens = new RefreshTokenRotationService(redis, 60);
  await refreshTokens.issue({ jti: "jti-1", familyId: "family-1" });
  const stepUp = new StepUpStore(redis);
  const notices: Array<{ client: unknown; change: DataSettingChange }> = [];
  const dataRoutes = new DataRouteControl({
    authMode: "jwt",
    localAuth: { stepUp, refreshTokens, mfa: { hasSecondFactor: async () => false } } as unknown as LocalAuth,
    ownerNotices: {
      async queueOwnerNotice(client, _tenantId, input) {
        notices.push({ client, change: input.change });
        return 1;
      }
    }
  });
  // The integration store writes the change's audit event in its
  // transaction, which runs the owner notice.
  const applyChanges = vi.fn(async (_tenantId: string, _integrationId: string, changes: { configChanges: Record<string, unknown> }, audit?: (saved: never) => AuditEventInput) => {
    const saved = { config: changes.configChanges } as never;
    await audit?.(saved).alsoInTransaction?.(CHANGE_TRANSACTION as never);
    return saved;
  });
  const input: AttachOverlaysInput = {
    config: createTestConfig(),
    db: emptyPool(),
    uploadAdmission: { begin: vi.fn(), admit: vi.fn() },
    stores: { auditEvents: { create: vi.fn() }, integrationStates: { get: vi.fn(async () => null), upsert: vi.fn(), applyChanges } },
    integrationDescriptors: new IntegrationRegistry(),
    loadIntegrationEnablement: vi.fn(async () => ({
      tenantEnabled: true, tenantReadsEnabled: true, tenantWritesEnabled: false, platformConfigured: true
    })),
    oauthStates: { issue: vi.fn(), consume: vi.fn() },
    runtimeInvalidator: { invalidateRuntimesForIntegration: vi.fn(async () => []), invalidateTenantRuntimes: vi.fn(async () => []) },
    managedToolCatalog: new ManagedToolCatalog(),
    managedToolFactoryRegistry: new ManagedToolFactoryRegistry(),
    piiImportScopes: new PiiImportScopeRegistry()
  };

  const routes: string[] = [];
  const app = Fastify();
  app.decorate("db", emptyPool() as never);
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat()) {
      if (method !== "HEAD") routes.push(`${method} ${route.url}`);
    }
  });
  // A valid access token of a live session of an owner: what a stolen token gives.
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: USER_ID, tenantId: TENANT_ID, isAdmin: true, role: "owner",
      session: authSource === "workos"
        ? { authSource: "workos", familyId: "family-1" }
        : { authSource: "local", familyId: "family-1", securityVersion: 1 }
    };
  });
  bootstrap(input).attachRoutes(app, { dataRoutes });
  await app.ready();
  const token = async (action: "integration.overlay_settings" | "integration.update") =>
    (await stepUp.create({ userId: USER_ID, tenantId: TENANT_ID, familyId: "family-1", securityVersion: 1, action }, ["pwd"])).token;
  return { app, routes, applyChanges, notices, token };
}

const apps: Array<Awaited<ReturnType<typeof buildApp>>["app"]> = [];
const originalRedirectUri = process.env.MICROSOFT_OAUTH_REDIRECT_URI;
beforeEach(() => {
  __resetIntegrationRegistryForTesting();
  process.env.MICROSOFT_OAUTH_REDIRECT_URI = "https://api.example.com/integrations/microsoft/callback";
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  if (originalRedirectUri === undefined) delete process.env.MICROSOFT_OAUTH_REDIRECT_URI;
  else process.env.MICROSOFT_OAUTH_REDIRECT_URI = originalRedirectUri;
  __resetIntegrationRegistryForTesting();
});

async function harness(authSource: "local" | "workos" = "local") {
  const built = await buildApp(authSource);
  apps.push(built.app);
  return built;
}

describe("overlay step-up routes", () => {
  test("the Microsoft app refuses a request that carries only an access token", async () => {
    const { app, applyChanges, notices } = await harness();
    const res = await app.inject({ method: "PUT", url: "/tenant/settings/microsoft", payload: CONFIG });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "step_up_required", action: "integration.overlay_settings" });
    expect(applyChanges).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  });

  test("the Microsoft app refuses a step-up token for another action", async () => {
    const { app, applyChanges, token } = await harness();
    const res = await app.inject({
      method: "PUT", url: "/tenant/settings/microsoft", payload: CONFIG, headers: { "x-step-up": await token("integration.update") }
    });
    expect(res.statusCode).toBe(403);
    expect(applyChanges).not.toHaveBeenCalled();
  });

  test("with a step-up token the Microsoft app changes, and the owner notice goes with the change, without the secret", async () => {
    const { app, applyChanges, notices, token } = await harness();
    const res = await app.inject({
      method: "PUT", url: "/tenant/settings/microsoft", payload: CONFIG, headers: { "x-step-up": await token("integration.overlay_settings") }
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(applyChanges).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([{ client: CHANGE_TRANSACTION, change: NOTICE }]);
    expect(JSON.stringify(notices)).not.toContain(CONFIG.clientSecret);
  });

  test("a WorkOS session changes the Microsoft app with no step-up, and the owners get the notice", async () => {
    const { app, applyChanges, notices } = await harness("workos");
    const res = await app.inject({ method: "PUT", url: "/tenant/settings/microsoft", payload: CONFIG });
    expect(res.statusCode, res.body).toBe(200);
    expect(applyChanges).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([{ client: CHANGE_TRANSACTION, change: NOTICE }]);
  });

  test("every overlay route is in the step-up list or has a reason to need none, and every overlay action has a route", async () => {
    const { routes } = await harness();
    const listed = new Set(Object.keys(OVERLAY_STEP_UP_ROUTES));
    const exempt = new Set(Object.keys(NO_STEP_UP));
    expect(routes.filter((route) => !listed.has(route) && !exempt.has(route)), "routes in neither list").toEqual([]);
    expect([...listed, ...exempt].filter((route) => !routes.includes(route)), "listed routes that do not exist").toEqual([]);
    expect(Object.values(OVERLAY_STEP_UP_ROUTES).sort()).toEqual([...OVERLAY_STEP_UP_ACTIONS].sort());
  });
});
