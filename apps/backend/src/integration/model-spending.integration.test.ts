import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, onTestFinished, test } from "vitest";
import { registerAdminModelSpendingRoutes } from "../routes/admin/admin-model-spending-routes.js";
import { ModelSpendingStore } from "../services/model-spending-store.js";
import { withTenantScope } from "../lib/db.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedTenant, seedUser, seedMembership, seedSession } from "./support/fixtures.js";

async function setup(monthlyLimitUsd: number | null = 2, turnReservationUsd = 1) {
  const tenantId = await seedTenant(), userId = await seedUser();
  await seedMembership(tenantId,userId);
  const sessionId = await seedSession(tenantId,userId);
  const store = new ModelSpendingStore(appPool(), { monthlyLimitUsd, turnReservationUsd });
  const input = { tenantId,userId,sessionId,turnContext: "interactive" as const,reservationId: randomUUID(),modelName: "gpt-6-sol" };
  return { store, input, tenantId, userId, sessionId };
}

// Raw ledger values, read as text so that no conversion hides a wrong micro-USD.
async function storedPolicy(tenantId: string) {
  return (await superuserPool().query(`SELECT monthly_limit_microusd::text AS "limit",
    turn_reservation_microusd::text AS reservation FROM tenant_model_spending_policy WHERE tenant_id=$1`,[tenantId])).rows[0];
}
async function storedCharge(tenantId: string, reservationId: string) {
  return (await superuserPool().query(`SELECT status, charged_microusd::text AS charged
    FROM model_spending_reservations WHERE tenant_id=$1 AND reservation_id=$2`,[tenantId,reservationId])).rows[0];
}
async function auditPayloads(tenantId: string, eventType: string) {
  return (await superuserPool().query("SELECT payload FROM audit_events WHERE tenant_id=$1 AND event_type=$2",
    [tenantId,eventType])).rows.map(row => row.payload);
}
// Leaves the reservation unknown: a started call without usage blocks settlement.
async function unknownReservation(store: ModelSpendingStore, input: Parameters<ModelSpendingStore["reserve"]>[0]) {
  const r = (await store.reserve(input))!;
  await store.startCall(r,"missing","gpt-6-sol");
  await store.finish(r);
  return r;
}

describe.skipIf(!adminDatabaseUrl())("model spending under RLS", () => {
  test("interactive and scheduled replicas compete atomically for one remaining allowance", async () => {
    const { store, input, tenantId } = await setup(1);
    await store.get(tenantId);
    const replica = new ModelSpendingStore(appPool(), { monthlyLimitUsd: 100, turnReservationUsd: 1 });
    const results = await Promise.allSettled(Array.from({length: 12}, (_,i) =>
      (i % 2 ? store : replica).reserve({...input,reservationId: randomUUID(),turnContext: i % 2 ? "scheduled" : "interactive"})));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await store.get(tenantId)).toMatchObject({chargedUsd: 1,activeReservations: 1});
  });
  test.each([
    ["no other call", async (_store: ModelSpendingStore, _r: Awaited<ReturnType<ModelSpendingStore["reserve"]>>) => {}],
    ["a failed call", async (store: ModelSpendingStore, r: Awaited<ReturnType<ModelSpendingStore["reserve"]>>) => {
      await store.startCall(r!,"failed","gpt-6-sol");
      await store.failCall(r!,"failed");
    }]
  ])("settlement with an untracked call keeps the hold and leaves the reservation unknown after %s", async (_name, before) => {
    const { store,input,tenantId } = await setup();
    const r = (await store.reserve(input))!;
    await before(store, r);
    await store.finish(r,{callId:"untracked-model-call",modelName:"gpt-6-sol"});
    expect(await storedCharge(tenantId,r.reservationId)).toMatchObject({status:"unknown",charged:"1000000"});
    // A settled reservation gets no new call rows.
    await store.finish(r,{callId:"late-call",modelName:"gpt-6-sol"});
    expect((await superuserPool().query("SELECT 1 FROM model_spending_calls WHERE tenant_id=$1 AND reservation_id=$2 AND call_id='late-call'",
      [tenantId,r.reservationId])).rowCount).toBe(0);
  });
  test("known usage refunds unused credit, remains after session deletion, and settles once", async () => {
    const { store,input,tenantId,sessionId } = await setup();
    const r = (await store.reserve(input))!;
    await store.startCall(r,"call","gpt-6-sol");
    await store.completeCall(r,"call",250_000);
    await store.finish(r);
    await store.finish(r);
    await superuserPool().query("DELETE FROM sessions WHERE session_id=$1",[sessionId]);
    expect(await store.get(tenantId)).toMatchObject({chargedUsd: .25,activeReservations: 0});
    await expect(store.reserve(input)).rejects.toMatchObject({code: "spending_reservation_reused"});
  });
  test("missing usage retains credit and blocks new admission until audited reconciliation", async () => {
    const { store,input,tenantId,userId } = await setup();
    const r = (await store.reserve(input))!;
    await store.startCall(r,"known","gpt-6-sol");
    await store.completeCall(r,"known",100_000);
    await store.startCall(r,"missing","gpt-6-sol");
    await store.completeCall(r,"missing",null);
    await store.finish(r);
    expect(await store.get(tenantId)).toMatchObject({chargedUsd: 1.1,unknownReservations: 1});
    await expect(store.reserve({...input,reservationId: randomUUID()})).rejects.toMatchObject({code: "model_usage_unknown"});
    await store.reconcile(tenantId,userId,input.reservationId,.4);
    expect(await store.get(tenantId)).toMatchObject({chargedUsd: .4,unknownReservations: 0});
    expect(await store.reserve({...input,reservationId: randomUUID()})).not.toBeNull();
    await expect(store.reconcile(tenantId,userId,input.reservationId,0)).rejects.toMatchObject({statusCode:409});
    const audit = await withTenantScope(appPool(),tenantId, db => db.query(
      "SELECT event_type FROM audit_events WHERE tenant_id=$1 AND event_type='model_spending_reconciled'",[tenantId]));
    expect(audit.rowCount).toBe(1);
  });
  test("a failed or cancelled call keeps the full reservation without blocking admission", async () => {
    const { store,input,tenantId } = await setup(5);
    const r = (await store.reserve(input))!;
    await store.startCall(r,"known","gpt-6-sol");
    await store.completeCall(r,"known",100_000);
    await store.startCall(r,"cancelled","gpt-6-sol");
    await store.failCall(r,"cancelled");
    await expect(store.startCall(r,"retry","gpt-6-sol")).rejects.toMatchObject({code:"model_turn_allowance"});
    await store.finish(r);
    expect(await store.get(tenantId)).toMatchObject({chargedUsd: 1,unknownReservations: 0,activeReservations: 0});
    expect(await store.reserve({...input,reservationId: randomUUID()})).not.toBeNull();
  });
  test("one in-flight call may overrun, but further calls and admission stop", async () => {
    const { store,input,tenantId } = await setup(1);
    const r = (await store.reserve(input))!;
    await store.startCall(r,"expensive","gpt-6-sol");
    await expect(store.startCall(r,"parallel","gpt-6-sol")).rejects.toMatchObject({code:"model_turn_allowance"});
    await store.completeCall(r,"expensive",1_200_000);
    await expect(store.startCall(r,"next","gpt-6-sol")).rejects.toMatchObject({code:"model_turn_allowance"});
    await store.finish(r);
    expect(await store.get(tenantId)).toMatchObject({chargedUsd:1.2});
    await expect(store.reserve({...input,reservationId:randomUUID()})).rejects.toMatchObject({code:"model_spending_limit"});
  });
  test("an administrator can close a crashed reservation without silently returning credit", async () => {
    const { store,input,tenantId,userId } = await setup();
    const r = (await store.reserve(input))!;
    await store.startCall(r,"pending","gpt-6-sol");
    await store.close(tenantId,userId,input.reservationId);
    await store.completeCall(r,"pending",100_000);
    await store.finish(r);
    expect(await store.get(tenantId)).toMatchObject({chargedUsd:1,unknownReservations:1});
    await expect(store.startCall(r,"late","gpt-6-sol")).rejects.toMatchObject({code:"model_turn_allowance"});
    await store.reconcile(tenantId,userId,input.reservationId,.1);
  });
  test("UTC month rollover frees new admission but prevents old turns making more calls", async () => {
    const {store,input,tenantId} = await setup(1);
    const r = (await store.reserve(input))!;
    await superuserPool().query("UPDATE model_spending_reservations SET period=(date_trunc('month',now() AT TIME ZONE 'UTC') - interval '1 month')::date WHERE tenant_id=$1",[tenantId]);
    await expect(store.startCall(r,"late","gpt-6-sol")).rejects.toMatchObject({code:"model_turn_allowance"});
    expect(await store.reserve({...input,reservationId:randomUUID()})).not.toBeNull();
  });
  test("an unpriced model takes no reservation, and a turn with no model call settles", async () => {
    const { store,input,tenantId } = await setup();
    await expect(store.reserve({...input,modelName:"unpriced-model"})).rejects.toMatchObject({code:"model_price_unknown"});
    expect(await store.get(tenantId)).toMatchObject({chargedUsd: 0,activeReservations: 0,unknownReservations: 0});
    const r = (await store.reserve(input))!;
    await store.finish(r);
    expect(await store.get(tenantId)).toMatchObject({chargedUsd: 0,unknownReservations: 0,unresolved: []});
    expect(await store.reserve({...input,reservationId:randomUUID()})).not.toBeNull();
  });
  test("hasLimit reads the policy, and the defaults before the first write", async () => {
    const limited = await setup(2), unlimited = await setup(null);
    expect(await limited.store.hasLimit(limited.tenantId)).toBe(true);
    expect(await unlimited.store.hasLimit(unlimited.tenantId)).toBe(false);
    await unlimited.store.setPolicy(unlimited.tenantId,unlimited.userId,{monthlyLimitUsd:5,turnReservationUsd:1,version:1});
    expect(await unlimited.store.hasLimit(unlimited.tenantId)).toBe(true);
  });
  test("policy writes detect concurrent edits; limits can be zero or unlimited", async () => {
    const {store,input,tenantId,userId} = await setup(null);
    expect(await store.reserve(input)).toBeNull();
    await store.setPolicy(tenantId,userId,{monthlyLimitUsd:0,turnReservationUsd:1,version:1});
    await expect(store.reserve(input)).rejects.toMatchObject({code:"model_spending_limit"});
    await expect(store.setPolicy(tenantId,userId,{monthlyLimitUsd:99,turnReservationUsd:1,version:1})).rejects.toMatchObject({statusCode:409});
  });
  test("all unresolved records remain discoverable beyond 200 old reservations", async () => {
    const {store,input,tenantId,userId} = await setup(500);
    await superuserPool().query(`INSERT INTO model_spending_reservations
      (tenant_id,reservation_id,period,session_id,user_id,turn_context,reserved_microusd,charged_microusd)
      SELECT $1,'old-' || lpad(n::text,3,'0'),DATE '2020-01-01',$2,$3,'interactive',1000000,1000000
      FROM generate_series(1,205) AS n`,[tenantId,input.sessionId,userId]);
    const r=(await store.reserve({...input,reservationId:"unresolved-current"}))!;
    await store.startCall(r,"missing","gpt-6-sol");
    await store.finish(r);
    const first=await store.get(tenantId);
    expect(first.unresolved).toHaveLength(200);
    expect(first.nextCursor).not.toBeNull();
    const second=await store.get(tenantId,first.nextCursor!);
    expect(second.unresolved).toHaveLength(6);
    expect(second.unresolved).toContainEqual(expect.objectContaining({reservationId:r.reservationId,status:"unknown"}));
    expect(second.nextCursor).toBeNull();
    expect(first.unknownReservations).toBe(1);
    expect(second.chargedUsd).toBe(1);
    await store.reconcile(tenantId,userId,r.reservationId,.1);
  });
  test("RLS hides all spending tables from a second tenant", async () => {
    const a = await setup(), b = await setup();
    const r = (await a.store.reserve(a.input))!;
    await a.store.startCall(r,"call","gpt-6-sol");
    for (const table of ["tenant_model_spending_policy","model_spending_reservations","model_spending_calls"]) {
      const result = await withTenantScope(appPool(),b.tenantId,db => db.query(
        `SELECT * FROM ${table} WHERE tenant_id=$1`,[a.tenantId]));
      expect(result.rowCount).toBe(0);
    }
    await expect(b.store.reconcile(b.tenantId,b.userId,r.reservationId,0)).rejects.toMatchObject({statusCode:409});
  });
  // Math.ceil(4.03 * 1e6) is 4030001, so these amounts check exact decimal conversion.
  test("defaults and policy updates store exact micro-USD amounts", async () => {
    const { store,tenantId,userId } = await setup(4.03,264630.358293);
    expect(await store.get(tenantId)).toMatchObject({policy:{monthlyLimitUsd:4.03,turnReservationUsd:264630.358293,version:1}});
    expect(await storedPolicy(tenantId)).toEqual({limit:"4030000",reservation:"264630358293"});
    await store.setPolicy(tenantId,userId,{monthlyLimitUsd:545473.652007,turnReservationUsd:4.07,version:1});
    expect(await storedPolicy(tenantId)).toEqual({limit:"545473652007",reservation:"4070000"});
    expect(await auditPayloads(tenantId,"model_spending_policy_updated")).toEqual([
      {monthlyLimitUsd:545473.652007,turnReservationUsd:4.07,version:1}]);
  });
  // The route uses fixture authentication. The routes, store and Postgres are real.
  test("the admin routes round-trip exact policy and reconciliation amounts with audit records", async () => {
    const { store,input,tenantId,userId } = await setup(null);
    const app = Fastify();
    app.decorate("db",appPool());
    app.addHook("preHandler",async request => {
      request.auth = { tenantId,userId,role:"admin",isAdmin:true };
    });
    await registerAdminModelSpendingRoutes(app,store);
    onTestFinished(() => app.close());
    const put = await app.inject({method:"PUT",url:"/admin/model-spending",
      payload:{monthlyLimitUsd:4.03,turnReservationUsd:1.01,version:1}});
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({policy:{monthlyLimitUsd:4.03,turnReservationUsd:1.01,version:2}});
    expect(await storedPolicy(tenantId)).toEqual({limit:"4030000",reservation:"1010000"});
    expect(await auditPayloads(tenantId,"model_spending_policy_updated")).toEqual([
      {monthlyLimitUsd:4.03,turnReservationUsd:1.01,version:1}]);
    await unknownReservation(store,input);
    const reconcile = await app.inject({method:"POST",url:`/admin/model-spending/${input.reservationId}/reconcile`,
      payload:{actualUsd:4.07}});
    expect(reconcile.statusCode).toBe(200);
    expect(await storedCharge(tenantId,input.reservationId)).toEqual({status:"settled",charged:"4070000"});
    expect(await auditPayloads(tenantId,"model_spending_reconciled")).toEqual([
      {reservationId:input.reservationId,actualUsd:4.07}]);
    const get = await app.inject({method:"GET",url:"/admin/model-spending"});
    expect(get.json()).toMatchObject({chargedUsd:4.07,unknownReservations:0,policy:{monthlyLimitUsd:4.03,version:2}});
  });
  test("an exact remaining allowance admits a turn, and one micro-USD more is refused", async () => {
    for (const [actualUsd,charged,admitted] of [[3.03,"3030000",true],[3.030001,"3030001",false]] as const) {
      const { store,input,tenantId,userId } = await setup(null);
      await store.setPolicy(tenantId,userId,{monthlyLimitUsd:4.03,turnReservationUsd:1,version:1});
      await unknownReservation(store,input);
      await store.reconcile(tenantId,userId,input.reservationId,actualUsd);
      expect((await storedCharge(tenantId,input.reservationId)).charged).toBe(charged);
      const next = store.reserve({...input,reservationId:randomUUID()});
      if (admitted) {
        expect(await next).toMatchObject({reservedMicroUsd:1_000_000});
        expect(await store.get(tenantId)).toMatchObject({chargedUsd:4.03,activeReservations:1});
      } else {
        await expect(next).rejects.toMatchObject({code:"model_spending_limit"});
        expect(await store.get(tenantId)).toMatchObject({chargedUsd:3.030001,activeReservations:0});
      }
    }
  });
});
