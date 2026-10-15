import Fastify from "fastify";
import { expect, test, vi } from "vitest";
import { FakePool } from "../../test-helpers/fake-pool.js";
import { registerAdminHistoryRoutes } from "./admin-history-routes.js";
import { HistoryInputError } from "../../services/admin-history-store.js";

async function setup(isAdmin = true) {
  const app = Fastify();
  app.decorate("db", new FakePool().onQuery(/INSERT INTO users/, () => ({ rows: [], rowCount: 1 })).asPool());
  app.addHook("preHandler", async request => { request.auth = { tenantId: "tenant", userId: "actor", role: isAdmin ? "admin" : "member", isAdmin }; });
  const store = { list: vi.fn(async () => ({ items: [], nextCursor: null })), detail: vi.fn(async () => null) };
  await registerAdminHistoryRoutes(app, store);
  return { app, store };
}
test("both reads require admin access", async () => {
  const { app, store } = await setup(false);
  for (const url of ["/admin/history", "/admin/history/1"]) expect((await app.inject(url)).statusCode).toBe(403);
  expect(store.list).not.toHaveBeenCalled(); expect(store.detail).not.toHaveBeenCalled(); await app.close();
});
test("validates input and uses only authenticated tenant scope", async () => {
  const { app, store } = await setup();
  for (const url of ["?tenantId=other", "?limit=0", "?category=unknown", "/abc", "/9223372036854775808", "/1?compareTo=abc"]) expect((await app.inject(`/admin/history${url}`)).statusCode).toBe(400);
  expect(store.list).not.toHaveBeenCalled(); expect(store.detail).not.toHaveBeenCalled();
  expect((await app.inject("/admin/history?category=people&limit=2")).statusCode).toBe(200);
  expect(store.list).toHaveBeenCalledWith("tenant", { category: "people", limit: 2 });
  expect((await app.inject("/admin/history/9007199254740993?compareTo=2")).statusCode).toBe(404);
  expect(store.detail).toHaveBeenCalledWith("tenant", "9007199254740993", "2");
  store.list.mockRejectedValueOnce(new HistoryInputError("Invalid cursor"));
  expect((await app.inject("/admin/history?cursor=bad")).statusCode).toBe(400);
  await app.close();
});
