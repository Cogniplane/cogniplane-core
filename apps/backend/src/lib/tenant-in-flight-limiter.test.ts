import Fastify from "fastify";
import { afterEach, expect, test, vi } from "vitest";

import { registerTenantInFlightLimit, TenantInFlightLimiter } from "./tenant-in-flight-limiter.js";

afterEach(() => {
  vi.useRealTimers();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("each tenant has its own slots, and a waiter gets a slot in arrival order", async () => {
  const limiter = new TenantInFlightLimiter({ maxActivePerTenant: 2, maxWaitingPerTenant: 2, maxWaitMs: 60_000 });
  const a1 = await limiter.acquire("a");
  const a2 = await limiter.acquire("a");
  const order: string[] = [];
  const a3 = limiter.acquire("a").then((release) => { order.push("a3"); return release; });
  const a4 = limiter.acquire("a").then((release) => { order.push("a4"); return release; });
  // The queue of A is full: refused at once.
  expect(await limiter.acquire("a")).toBeNull();
  // Tenant B does not wait for A.
  const b1 = await limiter.acquire("b");
  expect(b1).toBeTypeOf("function");

  a1!();
  a1!(); // A second call gives back nothing more.
  a2!();
  const [r3, r4] = await Promise.all([a3, a4]);
  expect(order).toEqual(["a3", "a4"]);
  r3!();
  r4!();
  b1!();
  // No tenant keeps an entry once its work is done.
  expect(limiter.trackedTenantCount()).toBe(0);
});

test("a waiter leaves the queue when its wait times out or its caller aborts", async () => {
  vi.useFakeTimers();
  const limiter = new TenantInFlightLimiter({ maxActivePerTenant: 1, maxWaitingPerTenant: 4, maxWaitMs: 1_000 });
  const held = await limiter.acquire("a");
  const timedOut = limiter.acquire("a");
  const caller = new AbortController();
  const aborted = limiter.acquire("a", caller.signal);
  caller.abort();
  expect(await aborted).toBeNull();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await timedOut).toBeNull();
  held!();
  expect(limiter.trackedTenantCount()).toBe(0);
  // A new request gets the free slot at once.
  const next = await limiter.acquire("a");
  next!();
  expect(limiter.trackedTenantCount()).toBe(0);
});

async function limitedApp(limiter: TenantInFlightLimiter, abandonedGraceMs = 60_000) {
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    request.auth = { tenantId: String(request.headers["x-tenant"]), userId: "user-1", role: "admin", isAdmin: true };
  });
  registerTenantInFlightLimit(app, {
    limiter,
    matches: (request) => request.url.startsWith("/admin/"),
    abandonedGraceMs,
    busy: (reply) => reply.code(429).send({ error: "admin_queries_busy" })
  });
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const started: string[] = [];
  app.get("/admin/report/:id", async (request) => {
    const { id } = request.params as { id: string };
    started.push(id);
    const gate = deferred();
    gates.set(id, gate);
    await gate.promise;
    if (id.startsWith("fail")) throw new Error("report failed");
    return { id };
  });
  app.get("/other", async () => ({ ok: true }));
  await app.ready();
  return { app, gates, started };
}

test("the admin hook caps each tenant, frees the slot on success and on error, and leaves other tenants and routes alone", async () => {
  const limiter = new TenantInFlightLimiter({ maxActivePerTenant: 1, maxWaitingPerTenant: 1, maxWaitMs: 60_000 });
  const { app, gates, started } = await limitedApp(limiter);
  const inject = (tenant: string, id: string) =>
    app.inject({ method: "GET", url: `/admin/report/${id}`, headers: { "x-tenant": tenant } });

  const failing = inject("a", "fail-1");
  await vi.waitFor(() => expect(started).toEqual(["fail-1"]));
  const waiting = inject("a", "ok-2");
  await vi.waitFor(() => expect(limiter.waitingCount("a")).toBe(1));
  const refused = await inject("a", "ok-3");
  expect(refused.statusCode).toBe(429);
  expect(refused.json()).toEqual({ error: "admin_queries_busy" });
  // Tenant B and routes outside /admin/ do not wait.
  const other = inject("b", "b-1");
  await vi.waitFor(() => expect(started).toEqual(["fail-1", "b-1"]));
  expect((await app.inject({ method: "GET", url: "/other", headers: { "x-tenant": "a" } })).statusCode).toBe(200);

  gates.get("fail-1")!.resolve();
  expect((await failing).statusCode).toBe(500);
  // The error freed the slot: the waiter runs.
  await vi.waitFor(() => expect(started).toContain("ok-2"));
  gates.get("ok-2")!.resolve();
  gates.get("b-1")!.resolve();
  expect((await waiting).statusCode).toBe(200);
  expect((await other).statusCode).toBe(200);
  expect(limiter.trackedTenantCount()).toBe(0);
  await app.close();
});

test("a client that disconnects while it waits leaves the queue; one that disconnects while its route runs keeps the slot until the route ends", async () => {
  const limiter = new TenantInFlightLimiter({ maxActivePerTenant: 1, maxWaitingPerTenant: 1, maxWaitMs: 60_000 });
  const { app, gates, started } = await limitedApp(limiter);
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const request = (id: string) => {
    const controller = new AbortController();
    const response = fetch(`${address}/admin/report/${id}`, { headers: { "x-tenant": "a" }, signal: controller.signal })
      .then((reply) => reply.status, () => "aborted" as const);
    return { response, abort: () => controller.abort() };
  };

  const running = request("run-1");
  await vi.waitFor(() => expect(started).toEqual(["run-1"]));
  const queued = request("queued-2");
  await vi.waitFor(() => expect(limiter.waitingCount("a")).toBe(1));
  queued.abort();
  expect(await queued.response).toBe("aborted");
  await vi.waitFor(() => expect(limiter.waitingCount("a")).toBe(0));
  // The queue is free again: a new request waits (the slot is still held).
  const third = request("third-3");
  await vi.waitFor(() => expect(limiter.waitingCount("a")).toBe(1));
  expect(started).toEqual(["run-1"]);

  // The client of the running route goes away; its work still holds the slot.
  running.abort();
  expect(await running.response).toBe("aborted");
  // Give the server time to see the closed socket: the waiter still waits.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(started).toEqual(["run-1"]);
  expect(limiter.waitingCount("a")).toBe(1);
  gates.get("run-1")!.resolve();
  await vi.waitFor(() => expect(started).toEqual(["run-1", "third-3"]));
  gates.get("third-3")!.resolve();
  expect(await third.response).toBe(200);
  expect(limiter.trackedTenantCount()).toBe(0);
  await app.close();
});
