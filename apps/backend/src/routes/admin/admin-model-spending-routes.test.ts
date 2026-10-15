import Fastify from "fastify";
import { describe, expect, test, vi } from "vitest";
import { FakePool } from "../../test-helpers/fake-pool.js";
import { registerAdminModelSpendingRoutes } from "./admin-model-spending-routes.js";

async function setup(isAdmin = true) {
  const app = Fastify();
  app.decorate("db",new FakePool().onQuery(/INSERT INTO users/,()=>({rows:[],rowCount:1})).asPool());
  app.addHook("preHandler",async request=>{
    request.auth={tenantId:"tenant",userId:"actor",role:isAdmin ? "admin":"member",isAdmin};
  });
  const store={get:vi.fn(async()=>({policy:{version:1}})),setPolicy:vi.fn(async()=>{}),
    close:vi.fn(async()=>{}),reconcile:vi.fn(async()=>{})};
  await registerAdminModelSpendingRoutes(app,store as never);
  return {app,store};
}
describe("model spending admin routes",()=>{
  test("requires an administrator for every endpoint",async()=>{
    const {app,store}=await setup(false);
    for (const [method,url] of [["GET","/admin/model-spending"],["PUT","/admin/model-spending"],
      ["POST","/admin/model-spending/r/close"],["POST","/admin/model-spending/r/reconcile"]] as const) {
      expect((await app.inject({method,url})).statusCode).toBe(403);
    }
    expect(store.get).not.toHaveBeenCalled();
    expect(store.setPolicy).not.toHaveBeenCalled();
    expect(store.close).not.toHaveBeenCalled();
    expect(store.reconcile).not.toHaveBeenCalled();
    await app.close();
  });
  test("takes tenant and actor from authentication and validates policy and reconciliation",async()=>{
    const {app,store}=await setup();
    const policy={monthlyLimitUsd:100,turnReservationUsd:1,version:1};
    expect((await app.inject({method:"GET",url:"/admin/model-spending?cursor=previous"})).statusCode).toBe(200);
    expect(store.get).toHaveBeenCalledWith("tenant","previous");
    expect((await app.inject({method:"GET",url:"/admin/model-spending?tenantId=other"})).statusCode).toBe(400);
    expect((await app.inject({method:"PUT",url:"/admin/model-spending",payload:policy})).statusCode).toBe(200);
    expect(store.setPolicy).toHaveBeenCalledWith("tenant","actor",policy);
    for (const payload of [{...policy,monthlyLimitUsd:-1},{...policy,turnReservationUsd:0},{...policy,tenantId:"other"}]) {
      expect((await app.inject({method:"PUT",url:"/admin/model-spending",payload})).statusCode).toBe(400);
    }
    expect((await app.inject({method:"POST",url:"/admin/model-spending/r/reconcile",payload:{actualUsd:.25}})).statusCode).toBe(200);
    expect(store.reconcile).toHaveBeenCalledWith("tenant","actor","r",.25);
    expect((await app.inject({method:"POST",url:"/admin/model-spending/r/reconcile",payload:{actualUsd:-1}})).statusCode).toBe(400);
    await app.close();
  });
});
