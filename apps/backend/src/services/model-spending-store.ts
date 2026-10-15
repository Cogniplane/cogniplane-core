import { withTenantScope, type Pool } from "../lib/db.js";
import type { PoolClient } from "pg";
import { hasModelPrice } from "./token-cost-calculator.js";

export class ModelSpendingError extends Error {
  readonly statusCode = 402;
  constructor(readonly code: string, message: string) { super(message); }
}
export const USD_SCALE = 1_000_000;
// Converts USD to whole micro-USD and rounds up. The value is read as the
// shortest decimal that String(value) prints, so 4.03 gives 4030000. The
// product 4.03 * 1e6 is 4030000.0000000005 and would give 4030001. Any nonzero
// digit after the sixth decimal place rounds up: an estimate of 0.0000028 USD
// is 3 micro-USD. A double keeps about 15 significant digits, so every value
// with at most six decimal places up to 1,000,000 USD (the API and config
// maximum) converts exactly. Values above 9007199254.74099 USD exceed the
// safe-integer range and are refused.
export function toMicroUsd(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error("Invalid model cost.");
  const [mantissa = "", exponent = "0"] = String(value).split("e");
  const [whole = "", fraction = ""] = mantissa.split(".");
  const digits = BigInt(whole + fraction);
  // Power of ten that turns `digits` into micro-USD.
  const shift = Number(exponent) - fraction.length + 6;
  const divisor = 10n ** BigInt(Math.max(0, -shift));
  const micro = shift >= 0 ? digits * 10n ** BigInt(shift) : (digits + divisor - 1n) / divisor;
  if (micro > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Invalid model cost.");
  return Number(micro);
}
export type SpendingReservation = { tenantId: string; reservationId: string; reservedMicroUsd: number };
export type SpendingPolicy = { monthlyLimitUsd: number | null; turnReservationUsd: number; version: number };

export class ModelSpendingStore {
  constructor(private readonly db: Pool, private readonly defaults: Omit<SpendingPolicy, "version">) {}

  private async locked<T>(tenantId: string, work: (db: PoolClient) => Promise<T>): Promise<T> {
    return withTenantScope(this.db, tenantId, async db => {
      // All admission, reconciliation and policy changes use the same lock.
      await db.query("SELECT pg_advisory_xact_lock(hashtext('model-spending'), hashtext($1))", [tenantId]);
      await db.query(`INSERT INTO tenant_model_spending_policy (tenant_id, monthly_limit_microusd, turn_reservation_microusd)
        VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [tenantId,
        this.defaults.monthlyLimitUsd === null ? null : toMicroUsd(this.defaults.monthlyLimitUsd), toMicroUsd(this.defaults.turnReservationUsd)]);
      return work(db);
    });
  }

  // Lock-free read for callers that only need to know if a limit applies.
  async hasLimit(tenantId: string): Promise<boolean> {
    return withTenantScope(this.db, tenantId, async db => {
      const row = (await db.query("SELECT monthly_limit_microusd FROM tenant_model_spending_policy WHERE tenant_id=$1", [tenantId])).rows[0];
      // A tenant without a policy row uses the defaults until its first locked write.
      return row ? row.monthly_limit_microusd !== null : this.defaults.monthlyLimitUsd !== null;
    });
  }

  async get(tenantId: string, cursor?: string) {
    return this.locked(tenantId, async db => {
      const policy = (await db.query("SELECT * FROM tenant_model_spending_policy WHERE tenant_id=$1", [tenantId])).rows[0];
      const totals = (await db.query(`SELECT
        COALESCE(sum(charged_microusd),0) AS charged,
        count(*) FILTER (WHERE status='reserved') AS active,
        count(*) FILTER (WHERE status='unknown') AS unknown
        FROM model_spending_reservations WHERE tenant_id=$1 AND period=date_trunc('month', now() AT TIME ZONE 'UTC')::date`, [tenantId])).rows[0];
      const unresolved = (await db.query(`SELECT reservation_id AS "reservationId", session_id AS "sessionId",
        turn_context AS "turnContext", period, status, charged_microusd AS "chargedMicroUsd", updated_at AS "updatedAt"
        FROM model_spending_reservations WHERE tenant_id=$1 AND status<>'settled'
        AND ($2::text IS NULL OR reservation_id>$2)
        ORDER BY reservation_id LIMIT 201`, [tenantId, cursor ?? null])).rows;
      const page = unresolved.slice(0, 200);
      const nextCursor: string | null = unresolved.length > 200 ? String(page[199].reservationId) : null;
      return { unresolved: page, nextCursor, policy: {
        monthlyLimitUsd: policy.monthly_limit_microusd === null ? null : Number(policy.monthly_limit_microusd) / USD_SCALE,
        turnReservationUsd: Number(policy.turn_reservation_microusd) / USD_SCALE, version: Number(policy.version)
      }, chargedUsd: Number(totals.charged) / USD_SCALE, activeReservations: Number(totals.active), unknownReservations: Number(totals.unknown) };
    });
  }

  async setPolicy(tenantId: string, userId: string, policy: SpendingPolicy): Promise<void> {
    if (!(policy.turnReservationUsd > 0) || !Number.isSafeInteger(policy.version) || policy.version < 1)
      throw Object.assign(new Error("Invalid spending policy."), { statusCode: 400 });
    await this.locked(tenantId, async db => {
      const result = await db.query(`UPDATE tenant_model_spending_policy
        SET monthly_limit_microusd=$2, turn_reservation_microusd=$3, version=version+1, updated_at=now()
        WHERE tenant_id=$1 AND version=$4 RETURNING tenant_id`, [tenantId,
        policy.monthlyLimitUsd === null ? null : toMicroUsd(policy.monthlyLimitUsd), toMicroUsd(policy.turnReservationUsd), policy.version]);
      if (!result.rowCount) throw Object.assign(new Error("Spending policy changed. Reload and try again."), { statusCode: 409 });
      await db.query(`INSERT INTO audit_events(tenant_id,user_id,event_type,payload)
        VALUES ($1,$2,'model_spending_policy_updated',$3::jsonb)`, [tenantId,userId,JSON.stringify(policy)]);
    });
  }

  async reserve(input: { tenantId: string; reservationId: string; sessionId: string; userId: string;
    turnContext: "interactive" | "scheduled"; modelName: string }): Promise<SpendingReservation | null> {
    return this.locked(input.tenantId, async db => {
      const policy = (await db.query("SELECT * FROM tenant_model_spending_policy WHERE tenant_id=$1", [input.tenantId])).rows[0];
      if (policy.monthly_limit_microusd === null) return null;
      // Refuse an unpriced model before the turn holds a reservation.
      if (!hasModelPrice(input.modelName)) {
        throw new ModelSpendingError("model_price_unknown", "This model has no cost estimate. Choose a priced model while spending limits are enabled.");
      }
      const duplicate = await db.query("SELECT 1 FROM model_spending_reservations WHERE tenant_id=$1 AND reservation_id=$2", [input.tenantId,input.reservationId]);
      if (duplicate.rowCount) throw new ModelSpendingError("spending_reservation_reused", "This turn already has a spending reservation. Start a new turn.");
      const totals = (await db.query(`SELECT COALESCE(sum(charged_microusd),0) AS charged,
        count(*) FILTER (WHERE status='unknown') AS unknown FROM model_spending_reservations
        WHERE tenant_id=$1 AND period=date_trunc('month', now() AT TIME ZONE 'UTC')::date`, [input.tenantId])).rows[0];
      if (Number(totals.unknown)) throw new ModelSpendingError("model_usage_unknown", "Model usage is incomplete. An administrator must reconcile it before more model work can start.");
      const reserved = Number(policy.turn_reservation_microusd);
      if (Number(totals.charged) + reserved > Number(policy.monthly_limit_microusd)) {
        throw new ModelSpendingError("model_spending_limit", "The organization has insufficient model allowance for another turn.");
      }
      await db.query(`INSERT INTO model_spending_reservations
        (tenant_id,reservation_id,period,session_id,user_id,turn_context,reserved_microusd,charged_microusd)
        VALUES ($1,$2,date_trunc('month', now() AT TIME ZONE 'UTC')::date,$3,$4,$5,$6,$6)`,
        [input.tenantId,input.reservationId,input.sessionId,input.userId,input.turnContext,reserved]);
      return { tenantId: input.tenantId, reservationId: input.reservationId, reservedMicroUsd: reserved };
    });
  }

  async startCall(r: SpendingReservation, callId: string, modelName: string): Promise<void> {
    await this.locked(r.tenantId, async db => {
      const row = (await db.query(`SELECT *, period=date_trunc('month',now() AT TIME ZONE 'UTC')::date AS current_period
        FROM model_spending_reservations WHERE tenant_id=$1 AND reservation_id=$2 FOR UPDATE`, [r.tenantId,r.reservationId])).rows[0];
      const calls = (await db.query(`SELECT COALESCE(sum(cost_microusd),0) AS cost,
        count(*) FILTER (WHERE status<>'complete') AS incomplete FROM model_spending_calls
        WHERE tenant_id=$1 AND reservation_id=$2`, [r.tenantId,r.reservationId])).rows[0];
      if (!row || row.status !== 'reserved' || !row.current_period || Number(calls.incomplete) || Number(calls.cost) >= Number(row.reserved_microusd)) {
        throw new ModelSpendingError("model_turn_allowance", "This turn's model allowance is exhausted or its usage is incomplete. Saved progress remains available.");
      }
      await db.query(`INSERT INTO model_spending_calls (tenant_id,reservation_id,call_id,model_name) VALUES ($1,$2,$3,$4)`, [r.tenantId,r.reservationId,callId,modelName]);
    });
  }

  async completeCall(r: SpendingReservation, callId: string, cost: number | null): Promise<void> {
    if (cost !== null && (!Number.isSafeInteger(cost) || cost < 0)) throw new Error("Invalid model cost.");
    await this.locked(r.tenantId, async db => {
      await db.query(`UPDATE model_spending_calls SET cost_microusd=$4,status=$5
        WHERE tenant_id=$1 AND reservation_id=$2 AND call_id=$3 AND status='pending'`,
        [r.tenantId,r.reservationId,callId,cost,cost === null ? 'unknown' : 'complete']);
      await db.query(`UPDATE model_spending_reservations SET charged_microusd=GREATEST(charged_microusd,
        (SELECT COALESCE(sum(cost_microusd),0) FROM model_spending_calls WHERE tenant_id=$1 AND reservation_id=$2)), updated_at=now()
        WHERE tenant_id=$1 AND reservation_id=$2 AND status='reserved'`, [r.tenantId,r.reservationId]);
    });
  }

  // A provider error or cancellation is a normal end of a call. It keeps the
  // turn's full reservation as its charge but does not block the tenant.
  async failCall(r: SpendingReservation, callId: string): Promise<void> {
    await this.locked(r.tenantId, async db => {
      await db.query(`UPDATE model_spending_calls SET status='failed'
        WHERE tenant_id=$1 AND reservation_id=$2 AND call_id=$3 AND status='pending'`,
        [r.tenantId,r.reservationId,callId]);
    });
  }

  // `untracked` names a model call that ran without the spending callback. It is
  // recorded as 'unknown' without the allowance check, in the same transaction as
  // the settlement, so the turn can only settle as 'unknown' for an administrator
  // to reconcile.
  async finish(r: SpendingReservation, untracked?: { callId: string; modelName: string }): Promise<void> {
    await this.locked(r.tenantId, async db => {
      if (untracked) {
        await db.query(`INSERT INTO model_spending_calls (tenant_id,reservation_id,call_id,model_name,status)
          SELECT $1,$2,$3,$4,'unknown' FROM model_spending_reservations
          WHERE tenant_id=$1 AND reservation_id=$2 AND status='reserved'
          ON CONFLICT (tenant_id,reservation_id,call_id) DO UPDATE SET status='unknown'`,
        [r.tenantId,r.reservationId,untracked.callId,untracked.modelName]);
      }
      await db.query(`WITH usage AS (
        SELECT COALESCE(sum(cost_microusd),0) AS cost,
          count(*) FILTER (WHERE status IN ('pending','unknown')) AS incomplete,
          count(*) FILTER (WHERE status='failed') AS failed
        FROM model_spending_calls WHERE tenant_id=$1 AND reservation_id=$2
      ) UPDATE model_spending_reservations SET
        status=CASE WHEN usage.incomplete>0 THEN 'unknown' ELSE 'settled' END,
        charged_microusd=CASE WHEN usage.incomplete>0 THEN usage.cost + reserved_microusd
          WHEN usage.failed>0 THEN GREATEST(usage.cost, reserved_microusd)
          ELSE usage.cost END,
        updated_at=now() FROM usage WHERE tenant_id=$1 AND reservation_id=$2 AND status='reserved'`, [r.tenantId,r.reservationId]);
    });
  }

  async close(tenantId: string, userId: string, reservationId: string): Promise<void> {
    await this.locked(tenantId, async db => {
      const result = await db.query(`UPDATE model_spending_reservations
        SET status='unknown', updated_at=now() WHERE tenant_id=$1 AND reservation_id=$2 AND status='reserved'
        RETURNING reservation_id`, [tenantId,reservationId]);
      if (!result.rowCount) throw Object.assign(new Error("Only an active reservation can be closed."), { statusCode: 409 });
      await db.query(`INSERT INTO audit_events(tenant_id,user_id,event_type,payload)
        VALUES ($1,$2,'model_spending_closed',$3::jsonb)`, [tenantId,userId,JSON.stringify({reservationId})]);
    });
  }

  async reconcile(tenantId: string, userId: string, reservationId: string, actualUsd: number): Promise<void> {
    await this.locked(tenantId, async db => {
      const result = await db.query(`UPDATE model_spending_reservations SET status='settled',charged_microusd=$3,updated_at=now()
        WHERE tenant_id=$1 AND reservation_id=$2 AND status='unknown' RETURNING reservation_id`, [tenantId,reservationId,toMicroUsd(actualUsd)]);
      if (!result.rowCount) throw Object.assign(new Error("Only an unresolved reservation can be reconciled."), { statusCode: 409 });
      await db.query(`INSERT INTO audit_events(tenant_id,user_id,event_type,payload)
        VALUES ($1,$2,'model_spending_reconciled',$3::jsonb)`, [tenantId,userId,JSON.stringify({reservationId,actualUsd})]);
    });
  }
}
