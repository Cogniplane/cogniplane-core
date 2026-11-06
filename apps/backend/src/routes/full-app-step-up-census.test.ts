import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestConfig } from "../test-helpers/test-config.js";
import { FakePool } from "../test-helpers/fake-pool.js";
import { FakeRefreshTokenRedis } from "../test-helpers/fake-refresh-token-redis.js";

const capture = vi.hoisted(() => ({ routes: new Set<string>(), overlays: true, overlayPresent: false }));
vi.mock("fastify", async (original) => {
  const actual = await original<typeof import("fastify")>();
  return { ...actual, default: (options: import("fastify").FastifyServerOptions) => {
    const app = actual.default(options);
    app.addHook("onRoute", route => {
      for (const method of [route.method].flat()) {
        if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) capture.routes.add(`${method} ${route.url}`);
      }
    });
    return app;
  } };
});
vi.mock("../config.js", async original => ({ ...await original<typeof import("../config.js")>(), loadConfig: vi.fn() }));
vi.mock("../lib/db.js", async original => ({ ...await original<typeof import("../lib/db.js")>(), createDatabase: vi.fn(), createMaintenanceDatabase: vi.fn() }));
vi.mock("../lib/maintenance-db.js", () => ({ assertApplicationRole: vi.fn(), assertMaintenanceRole: vi.fn() }));
vi.mock("../lib/redis.js", () => ({ getRedis: vi.fn(), closeRedis: vi.fn() }));
// Keep all route and dependency builders real. Background workers do not register routes.
vi.mock("../app-bootstrap.js", async original => ({ ...await original<typeof import("../app-bootstrap.js")>(), registerAppLifecycle: vi.fn() }));

vi.mock("../overlays.js", async original => {
  const actual = await original<typeof import("../overlays.js")>();
  return { attachOverlays: (...args: Parameters<typeof actual.attachOverlays>) => {
    const handles = capture.overlays ? actual.attachOverlays(...args) : { attachRoutes() {} };
    // The per-app descriptor also distinguishes a public no-op from an overlay
    // whose route attachment was accidentally removed in full.
    capture.overlayPresent = Boolean(args[0].integrationDescriptors.get("microsoft"));
    return handles;
  } };
});

import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createDatabase, createMaintenanceDatabase } from "../lib/db.js";
import { getRedis } from "../lib/redis.js";
import type { AppConfig } from "../config.js";
import { STEP_UP_ROUTES } from "../services/auth/step-up-routes.js";
import { CORE_NO_STEP_UP, SURVIVING_REVOCATION, OVERLAY_CLASSIFICATIONS } from "../test-helpers/step-up-classifications.js";

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

async function census(overlays: boolean, overrides: Partial<AppConfig> = {}) {
  capture.overlays = overlays;
  capture.routes.clear();
  const config = createTestConfig({ AUTH_MODE: "jwt", AUTH_LOGIN_TYPES: ["local", "workos"],
    MAINTENANCE_DATABASE_URL: "postgres://unused", LOG_LEVEL: "silent",
    WORKOS_API_KEY: "test", WORKOS_CLIENT_ID: "test", WORKOS_REDIRECT_URI: "https://example.test/callback",
    WEBAUTHN_RP_ID: "localhost", SMTP_URL: "smtps://example.test", MAIL_FROM: "test@example.test", ...overrides });
  vi.mocked(loadConfig).mockReturnValue(config);
  const db = new FakePool().asPool();
  vi.mocked(createDatabase).mockReturnValue(db);
  vi.mocked(createMaintenanceDatabase).mockReturnValue(db);
  // Local-auth stores need a Redis object at construction. Other builders use
  // in-memory limits and OAuth state here, so no pub/sub sockets are opened.
  vi.mocked(getRedis).mockReturnValue(null).mockReturnValueOnce(new FakeRefreshTokenRedis().asAppRedis());
  app = await buildApp();
  await app.ready();
  const routes = new Set(capture.routes);
  await app.close();
  app = undefined;
  return routes;
}

function checkClassification(routes: Set<string>, classifications: Record<string, unknown>, stale = true) {
  expect([...routes].filter(route => !(route in classifications)), "unclassified mutating routes").toEqual([]);
  if (stale) expect(Object.keys(classifications).filter(route => !routes.has(route)), "stale classifications").toEqual([]);
}

function coreClassifications() {
  const groups = [STEP_UP_ROUTES, CORE_NO_STEP_UP, SURVIVING_REVOCATION];
  const keys = groups.flatMap(group => Object.keys(group));
  expect(new Set(keys).size, "classifications must not overlap").toBe(keys.length);
  for (const reason of Object.values(CORE_NO_STEP_UP)) expect(reason.length).toBeGreaterThan(10);
  for (const risk of Object.values(SURVIVING_REVOCATION)) {
    expect(risk.reason.length).toBeGreaterThan(20);
    expect(risk.bead).toMatch(/^(fff0|q4w0\.21)$/);
  }
  return Object.assign({}, ...groups);
}

test("every mutating route from real buildApp has exactly one reviewed classification, with no stale entries", async () => {
  const routes = await census(false);
  checkClassification(routes, coreClassifications());
  expect(routes.has("POST /admin/projects/:projectId/recover-owner")).toBe(true);
  expect(routes.has("POST /admin/integrations/jira/cleanups/:cleanupId/retry")).toBe(true);
});

test("real optional overlays extend the complete app; core also works without an overlay", async () => {
  const core = await census(false);
  const full = await census(true);
  const added = new Set([...full].filter(route => !core.has(route)));
  // Public distributions ship a no-op overlay. Any nonempty extension must match
  // the reviewed overlay list exactly, including removed and newly added routes.
  if (capture.overlayPresent || added.size) checkClassification(added, OVERLAY_CLASSIFICATIONS);
  checkClassification(full, { ...coreClassifications(), ...(capture.overlayPresent ? OVERLAY_CLASSIFICATIONS : {}) });
});

describe("conditional full-app registration", () => {
  let enabled: ReadonlySet<string>;
  beforeAll(async () => { enabled = await census(false); });

  test.each([
    ["local only", { AUTH_LOGIN_TYPES: ["local"] }],
    ["WorkOS only", { AUTH_LOGIN_TYPES: ["workos"] }],
    ["mail off", { SMTP_URL: undefined, MAIL_FROM: undefined }],
    ["passkeys off", { WEBAUTHN_RP_ID: undefined }],
    ["mail and passkeys off", { SMTP_URL: undefined, MAIL_FROM: undefined, WEBAUTHN_RP_ID: undefined }],
    ["development headers", { AUTH_MODE: "dev-headers", AUTH_LOGIN_TYPES: [] }]
  ] satisfies [string, Partial<AppConfig>][])("%s", async (_name, config: Partial<AppConfig>) => {
    const routes = await census(false, config);
    checkClassification(routes, coreClassifications(), false);
    const local = config.AUTH_MODE !== "dev-headers" && (config.AUTH_LOGIN_TYPES ?? ["local", "workos"]).includes("local");
    const workos = config.AUTH_MODE !== "dev-headers" && (config.AUTH_LOGIN_TYPES ?? ["local", "workos"]).includes("workos");
    expect(routes.has("POST /auth/callback")).toBe(workos);
    expect(routes.has("POST /auth/local/login")).toBe(local);
    expect(routes.has("POST /tenant/members")).toBe(local);
    const mail = !("SMTP_URL" in config) || Boolean(config.SMTP_URL);
    const passkeys = !("WEBAUTHN_RP_ID" in config) || Boolean(config.WEBAUTHN_RP_ID);
    expect(routes.has("POST /auth/local/password/forgot")).toBe(local && mail);
    expect(routes.has("POST /auth/passkey/login/options")).toBe(local && passkeys);
    expect(routes.has("POST /me/security/passkeys/options")).toBe(local && passkeys);
    const expected = new Set(enabled);
    for (const route of enabled) {
      const localRoute = / \/(auth\/(local|passkey|step-up)|me\/security)/.test(route)
        || /^POST \/tenant\/members(?:$|\/)/.test(route)
        || route === "PUT /tenant/settings/security";
      const passkeyRoute = /passkey/.test(route);
      const mailRoute = route === "POST /auth/local/password/forgot";
      if ((!local && localRoute) || ((!passkeys && passkeyRoute) || (!mail && mailRoute))
        || (!workos && route === "POST /auth/callback")
        || (config.AUTH_MODE === "dev-headers" && ["POST /auth/logout", "POST /auth/refresh"].includes(route))) {
        expected.delete(route);
      }
    }
    expect([...routes].sort(), "exact route registration for this configuration").toEqual([...expected].sort());
  });
});

test("classification removal and stale entries fail closed", async () => {
  const routes = await census(false);
  const classifications = coreClassifications();
  delete classifications["POST /admin/projects/:projectId/recover-owner"];
  expect(() => checkClassification(routes, classifications)).toThrow("unclassified mutating routes");
  expect(() => checkClassification(routes, { ...coreClassifications(), "POST /removed-route": "removed" })).toThrow("stale classifications");
});

// This uses a real Fastify plugin through buildApp's overlay registration, not
// an invented entry in the captured route set.
test("a new plugin route fails the full-app census", async () => {
  const { attachOverlays } = await import("../overlays.js");
  const module = await import("../overlays.js");
  const spy = vi.spyOn(module, "attachOverlays").mockImplementation((...args) => {
    const handles = attachOverlays(...args);
    return { attachRoutes(app, controls) {
      handles.attachRoutes(app, controls);
      void app.register(async plugin => { plugin.post("/census-new-plugin", async () => ({})); });
    } };
  });
  try {
    const routes = await census(true);
    expect(routes.has("POST /census-new-plugin")).toBe(true);
    expect(() => checkClassification(routes, { ...coreClassifications(), ...OVERLAY_CLASSIFICATIONS }, false)).toThrow("unclassified mutating routes");
  } finally { spy.mockRestore(); }
});
