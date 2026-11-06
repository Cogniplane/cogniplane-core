import Fastify from "fastify";
import { describe, expect, test, vi } from "vitest";

import { FakeRefreshTokenRedis } from "../test-helpers/fake-refresh-token-redis.js";
import type { LocalAuth } from "./auth/local-auth.js";
import { RefreshTokenRotationService } from "./auth/refresh-token-rotation-service.js";
import { StepUpStore } from "./auth/step-up-store.js";
import { DataRouteControl, NO_OWNER_NOTICE_WARNING } from "./data-route-control.js";
import type { OwnerNoticeQueue } from "./mail/mail-outbox.js";
import { WeakerChangeError } from "./weaker-change-error.js";

// The rules of a data route: who gives step-up, and who gets the notice.
// routes/step-up-routes.test.ts checks every data route through the real
// route plugins; this file checks the rules one by one.

type Session = { authSource: "local" | "workos"; familyId: string; securityVersion?: number };
const AUTH = { userId: "admin-1", tenantId: "tenant-1", role: "admin" as const, isAdmin: true, email: "admin@example.test" };
const LOCAL: Session = { authSource: "local", familyId: "family-1", securityVersion: 2 };

type Limits = ConstructorParameters<typeof DataRouteControl>[0]["limits"];

async function harness(input: { authMode?: "jwt" | "dev-headers"; withLocalAuth?: boolean; session?: Session | null; limits?: Limits } = {}) {
  const redis = new FakeRefreshTokenRedis();
  const refreshTokens = new RefreshTokenRotationService(redis, 60);
  await refreshTokens.issue({ jti: "jti-1", familyId: "family-1" });
  const stepUp = new StepUpStore(redis);
  const consume = vi.spyOn(stepUp, "consume");
  const localAuth = { stepUp, refreshTokens, mfa: { hasSecondFactor: async () => false } } as unknown as LocalAuth;
  const control = new DataRouteControl({
    authMode: input.authMode ?? "jwt",
    ...(input.withLocalAuth === false ? {} : { localAuth }),
    ownerNotices: null,
    ...(input.limits ? { limits: input.limits } : {})
  });
  const session = input.session === undefined ? LOCAL : input.session;
  const app = Fastify();
  app.addHook("preHandler", async (request) => {
    request.auth = { ...AUTH, ...(session ? { session } : {}) };
  });
  app.put("/route", async (request, reply) =>
    (await control.requireStepUp(request, reply, "PUT /admin/tenant-settings")) ? { ok: true } : reply);
  app.put("/overlay", async (request, reply) =>
    (await control.requireStepUpForOverlay(request, reply, "integration.overlay_settings")) ? { ok: true } : reply);
  app.put("/admin/route", async (request, reply) =>
    (await control.requireStepUp(request, reply, "PUT /admin/tenant-settings")) ? { ok: true } : reply);
  // A write that needs step-up only when weaker: the store refuses a weaker
  // change unless allowed; `weaker` stands for the store's classification.
  const writes: boolean[] = [];
  let weaker = true;
  app.put("/weaker", async (request, reply) => {
    const written = await control.writeWithStepUpIfWeaker(request, reply, "PUT /admin/tenant-settings", async (allowWeaker) => {
      writes.push(allowWeaker);
      if (weaker && !allowWeaker) throw new WeakerChangeError();
      return { ok: true };
    });
    return written ? written.saved : reply;
  });
  await app.ready();
  const token = async (action: "tenant.settings" | "integration.overlay_settings" = "tenant.settings") =>
    (await stepUp.create({ userId: AUTH.userId, tenantId: AUTH.tenantId, familyId: "family-1", securityVersion: 2, action }, ["pwd"])).token;
  return { app, consume, token, writes, setWeaker: (value: boolean) => { weaker = value; } };
}

describe("DataRouteControl.writeWithStepUpIfWeaker", () => {
  test("a change that is not weaker is written once, with no step-up", async () => {
    const { app, consume, writes, setWeaker } = await harness();
    setWeaker(false);
    expect((await app.inject({ method: "PUT", url: "/weaker" })).statusCode).toBe(200);
    expect(writes).toEqual([false]);
    expect(consume).not.toHaveBeenCalled();
  });

  test("a weaker change from a local session without a token is refused after the store's refusal, and is not written", async () => {
    const { app, consume, writes } = await harness();
    const refused = await app.inject({ method: "PUT", url: "/weaker" });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: "step_up_required", action: "tenant.settings" });
    expect(writes).toEqual([false]);
    expect(consume).toHaveBeenCalledTimes(1);
  });

  test("a weaker change with a step-up token is written again with allowWeaker", async () => {
    const { app, writes, token } = await harness();
    expect((await app.inject({ method: "PUT", url: "/weaker", headers: { "x-step-up": await token() } })).statusCode).toBe(200);
    expect(writes).toEqual([false, true]);
  });

  test("a WorkOS session writes a weaker change with no step-up", async () => {
    const { app, consume, writes } = await harness({ session: { authSource: "workos", familyId: "family-1" } });
    expect((await app.inject({ method: "PUT", url: "/weaker" })).statusCode).toBe(200);
    expect(writes).toEqual([false, true]);
    expect(consume).not.toHaveBeenCalled();
  });

  test("another error of the store goes to the caller, with no step-up", async () => {
    const control = new DataRouteControl({ authMode: "jwt", ownerNotices: null });
    const failure = new Error("conflict");
    await expect(control.writeWithStepUpIfWeaker({} as never, {} as never, "PUT /admin/tenant-settings", async () => { throw failure; }))
      .rejects.toBe(failure);
  });
});

describe("DataRouteControl.requireStepUp", () => {
  test("a local session needs a step-up token for the route's action; the refusal names the action", async () => {
    const { app, token } = await harness();
    const refused = await app.inject({ method: "PUT", url: "/route" });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: "step_up_required", action: "tenant.settings" });

    const wrong = await app.inject({ method: "PUT", url: "/route", headers: { "x-step-up": await token("integration.overlay_settings") } });
    expect(wrong.json()).toEqual({ error: "step_up_required", action: "tenant.settings" });

    const ok = await app.inject({ method: "PUT", url: "/route", headers: { "x-step-up": await token() } });
    expect(ok.statusCode).toBe(200);
  });

  test("an overlay's route needs a token for its own action", async () => {
    const { app, token } = await harness();
    expect((await app.inject({ method: "PUT", url: "/overlay" })).json()).toEqual({ error: "step_up_required", action: "integration.overlay_settings" });
    expect((await app.inject({ method: "PUT", url: "/overlay", headers: { "x-step-up": await token() } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: "/overlay", headers: { "x-step-up": await token("integration.overlay_settings") } })).statusCode).toBe(200);
  });

  test("a WorkOS session needs no step-up: WorkOS owns that sign-in", async () => {
    const { app, consume } = await harness({ session: { authSource: "workos", familyId: "family-1" } });
    expect((await app.inject({ method: "PUT", url: "/route" })).statusCode).toBe(200);
    expect(consume).not.toHaveBeenCalled();
  });

  test("dev-headers mode needs no step-up: it has no sessions", async () => {
    const { app } = await harness({ authMode: "dev-headers", session: null, withLocalAuth: false });
    expect((await app.inject({ method: "PUT", url: "/route" })).statusCode).toBe(200);
  });

  test("jwt mode fails closed: no session, or a local session with local login off, is refused", async () => {
    const noSession = await harness({ session: null });
    expect((await noSession.app.inject({ method: "PUT", url: "/route" })).statusCode).toBe(403);
    const noLocalAuth = await harness({ withLocalAuth: false });
    expect((await noLocalAuth.app.inject({ method: "PUT", url: "/route" })).json()).toEqual({ error: "step_up_required", action: "tenant.settings" });
  });
});

// A data route outside /admin/ uses the admin limit; the admin hook in app.ts
// already counts every /admin/ request.
describe("DataRouteControl rate limit", () => {
  const LIMITED = { error: "rate_limit_exceeded", retryAfterMs: 4_200, limitType: "rate_limit", scope: "user", resource: "admin_query" };

  test("a data route outside /admin/ gets 429 when the admin limit is used up, before any step-up check", async () => {
    const consumeRateLimit = vi.fn(async () => LIMITED as never);
    const { app, consume } = await harness({ session: { authSource: "workos", familyId: "family-1" }, limits: { consumeRateLimit } });
    const res = await app.inject({ method: "PUT", url: "/route" });
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBe("5");
    expect(consumeRateLimit).toHaveBeenCalledWith({ resource: "admin_query", userId: "admin-1", tenantId: "tenant-1" });
    expect(consume).not.toHaveBeenCalled();
    expect((await app.inject({ method: "PUT", url: "/overlay" })).statusCode).toBe(429);
  });

  test("a data route under /admin/ is not counted twice", async () => {
    const consumeRateLimit = vi.fn(async () => LIMITED as never);
    const { app } = await harness({ session: { authSource: "workos", familyId: "family-1" }, limits: { consumeRateLimit } });
    expect((await app.inject({ method: "PUT", url: "/admin/route" })).statusCode).toBe(200);
    expect(consumeRateLimit).not.toHaveBeenCalled();
  });

  test("within the limit, the step-up rules apply", async () => {
    const consumeRateLimit = vi.fn(async () => null);
    const { app } = await harness({ limits: { consumeRateLimit } });
    expect((await app.inject({ method: "PUT", url: "/route" })).json()).toEqual({ error: "step_up_required", action: "tenant.settings" });
    expect(consumeRateLimit).toHaveBeenCalledTimes(1);
  });
});

describe("DataRouteControl warnings", () => {
  test("startup warns when WorkOS login is on and email is off: WorkOS tenants then have no check", () => {
    const warn = vi.fn();
    new DataRouteControl({ authMode: "jwt", loginTypes: ["workos", "local"], ownerNotices: null, logger: { warn } });
    expect(warn).toHaveBeenCalledWith(NO_OWNER_NOTICE_WARNING);

    for (const deps of [
      { loginTypes: ["workos"] as const, ownerNotices: { queueOwnerNotice: async () => 1 } },
      { loginTypes: ["local"] as const, ownerNotices: null }
    ]) {
      const quiet = vi.fn();
      new DataRouteControl({ authMode: "jwt", ...deps, logger: { warn: quiet } });
      expect(quiet).not.toHaveBeenCalled();
    }
  });

  test("a notice that reaches no owner is logged", async () => {
    const warn = vi.fn();
    const request = { auth: AUTH } as Parameters<DataRouteControl["ownerNotice"]>[0];
    const nobody = new DataRouteControl({ authMode: "jwt", ownerNotices: { queueOwnerNotice: async () => 0 }, logger: { warn } });
    await nobody.ownerNotice(request, { setting: "mcp_server", serverId: "crm", created: true })!({} as never);
    expect(warn).toHaveBeenCalledWith({ tenantId: "tenant-1", setting: "mcp_server" }, expect.stringContaining("reached nobody"));

    warn.mockClear();
    const owners = new DataRouteControl({ authMode: "jwt", ownerNotices: { queueOwnerNotice: async () => 2 }, logger: { warn } });
    await owners.ownerNotice(request, { setting: "mcp_server", serverId: "crm", created: true })!({} as never);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("DataRouteControl.ownerNotice", () => {
  const request = { auth: AUTH } as Parameters<DataRouteControl["ownerNotice"]>[0];

  test("queues the notice for the caller's tenant, with the caller as the actor, in the client it gets", async () => {
    const queue: OwnerNoticeQueue = { queueOwnerNotice: vi.fn(async () => 2) };
    const control = new DataRouteControl({ authMode: "jwt", ownerNotices: queue });
    const client = { transaction: 1 };
    await control.ownerNotice(request, { setting: "mcp_server", serverId: "crm", created: true })!(client as never);
    expect(queue.queueOwnerNotice).toHaveBeenCalledWith(client, "tenant-1", {
      actorUserId: "admin-1", change: { setting: "mcp_server", serverId: "crm", created: true }
    });
  });

  test("is undefined when email is off: the audit event is the only record", () => {
    const control = new DataRouteControl({ authMode: "jwt", ownerNotices: null });
    expect(control.ownerNotice(request, { setting: "tenant_settings", fields: ["Web search"] })).toBeUndefined();
  });
});
