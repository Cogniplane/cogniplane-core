import { z } from "zod";

import { IsoDateSchema } from "./_helpers.js";

/** Limits of `PUT /admin/model-spending` and the reconcile route. */
export const MODEL_SPENDING_MAX_USD = 1_000_000;
export const MODEL_SPENDING_MIN_TURN_RESERVATION_USD = 0.000001;
/** The ledger stores integer millionths of a USD. */
export const MODEL_SPENDING_USD_SCALE = 1_000_000;

const UsdAmountSchema = z.number().finite().min(0).max(MODEL_SPENDING_MAX_USD);

export const ModelSpendingPolicySchema = z.object({
  /** Null permits new turns without a reservation. Zero denies new turns. */
  monthlyLimitUsd: UsdAmountSchema.nullable(),
  turnReservationUsd: UsdAmountSchema.min(MODEL_SPENDING_MIN_TURN_RESERVATION_USD),
  version: z.number().int().positive()
}).passthrough();
export type ModelSpendingPolicy = z.infer<typeof ModelSpendingPolicySchema>;

/**
 * PostgreSQL returns `bigint` columns as decimal strings. Older fixtures and
 * other drivers can send a number. Both become a safe integer.
 */
const MicroUsdSchema = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^\d+$/).transform(Number)
]).refine(Number.isSafeInteger, "Amount is too large.");

/**
 * The accounting month of a reservation, as `YYYY-MM`.
 *
 * The column is a date for the first day of a UTC month. The backend can send
 * it as `YYYY-MM-DD`, or as the date-time of local midnight of the backend
 * process (up to 14 hours from UTC midnight). A shift of 14 hours cannot move
 * the first day of a month into another month, so the UTC month of that time
 * is correct for every time zone.
 */
const SpendingPeriodSchema = z.union([
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).transform((value) => value.slice(0, 7)),
  IsoDateSchema.transform((value) => new Date(Date.parse(value) + 14 * 3_600_000).toISOString().slice(0, 7))
]);

export const ModelSpendingReservationSchema = z.object({
  reservationId: z.string().min(1),
  sessionId: z.string().min(1),
  turnContext: z.enum(["interactive", "scheduled"]),
  period: SpendingPeriodSchema,
  status: z.enum(["reserved", "unknown"]),
  chargedMicroUsd: MicroUsdSchema,
  updatedAt: IsoDateSchema
}).passthrough();
export type ModelSpendingReservation = z.infer<typeof ModelSpendingReservationSchema>;

/**
 * `GET /admin/model-spending`. `chargedUsd` and the two counts cover the whole
 * current UTC month. `chargedUsd` is charged and held money: it includes the
 * full hold of active and unknown reservations. `unresolved` is one page of
 * active and unknown reservations from any month, ordered by ID.
 */
export const ModelSpendingResponseSchema = z.object({
  policy: ModelSpendingPolicySchema,
  chargedUsd: z.number().finite().nonnegative(),
  activeReservations: z.number().int().nonnegative(),
  unknownReservations: z.number().int().nonnegative(),
  unresolved: z.array(ModelSpendingReservationSchema),
  nextCursor: z.string().min(1).nullable()
}).passthrough();
export type ModelSpendingResponse = z.infer<typeof ModelSpendingResponseSchema>;

export const ModelSpendingPolicyUpdateRequestSchema = z.object({
  monthlyLimitUsd: UsdAmountSchema.nullable(),
  turnReservationUsd: UsdAmountSchema.min(MODEL_SPENDING_MIN_TURN_RESERVATION_USD),
  version: z.number().int().positive()
}).strict();
export type ModelSpendingPolicyUpdateRequest = z.infer<typeof ModelSpendingPolicyUpdateRequestSchema>;

export const ModelSpendingReconcileRequestSchema = z.object({
  actualUsd: UsdAmountSchema
}).strict();
export type ModelSpendingReconcileRequest = z.infer<typeof ModelSpendingReconcileRequestSchema>;
