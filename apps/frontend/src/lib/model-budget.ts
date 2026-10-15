import {
  MODEL_SPENDING_MAX_USD,
  MODEL_SPENDING_MIN_TURN_RESERVATION_USD,
  MODEL_SPENDING_USD_SCALE,
  type ModelSpendingPolicy,
  type ModelSpendingResponse
} from "@cogniplane/shared-types";

/** Spending at or above this part of the limit shows a warning. */
export const BUDGET_WARNING_PERCENT = 80;

/**
 * The ledger counts integer millionths of a USD. The API sends
 * `micro / 1_000_000`, so rounding recovers the exact integer. Compare in
 * integers, as the backend does, so that an exact fit admits a turn.
 */
export function toMicroUsd(usd: number): number {
  return Math.round(usd * MODEL_SPENDING_USD_SCALE);
}

/**
 * Shows every stored millionth of a USD, with at least 2 decimals. The ledger
 * and the policy use whole millionths, and one millionth can decide if a turn
 * starts, so the display does not round.
 */
export function formatUsd(usd: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6
  }).format(usd);
}

export function formatMicroUsd(micro: number): string {
  return formatUsd(micro / MODEL_SPENDING_USD_SCALE);
}

/** The accounting month for `now`, as `YYYY-MM` in UTC. */
export function utcMonth(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/** `2026-09` -> `September 2026`. */
export function formatMonth(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(year ?? 1970, (monthNumber ?? 1) - 1, 1)));
}

export type BudgetLevel = "unlimited" | "off" | "blocked" | "approaching" | "open";

export type BudgetStatus = {
  level: BudgetLevel;
  /** Null when there is no limit. */
  limitMicro: number | null;
  chargedMicro: number;
  reservationMicro: number;
  /** Limit minus charged and held. Negative when the month is over its limit. Null without a limit. */
  remainingMicro: number | null;
  /** Rounded down. Null without a limit or with a zero limit. */
  percent: number | null;
  /** The next turn's hold does not fit in the remaining allowance. */
  insufficient: boolean;
  /** Unknown usage this month with a limit set. The backend then refuses new turns. */
  unknownBlocks: boolean;
  unknownThisMonth: number;
  activeThisMonth: number;
  /** Turns that can start now at the current hold. Null without a limit. */
  turnsLeft: number | null;
};

export function budgetStatus(summary: Pick<ModelSpendingResponse, "policy" | "chargedUsd" | "activeReservations" | "unknownReservations">): BudgetStatus {
  const chargedMicro = toMicroUsd(summary.chargedUsd);
  const reservationMicro = toMicroUsd(summary.policy.turnReservationUsd);
  const base = {
    chargedMicro,
    reservationMicro,
    unknownThisMonth: summary.unknownReservations,
    activeThisMonth: summary.activeReservations
  };
  if (summary.policy.monthlyLimitUsd === null) {
    // New turns do not use the ledger, so nothing in it can block them.
    return { ...base, level: "unlimited", limitMicro: null, remainingMicro: null, percent: null, insufficient: false, unknownBlocks: false, turnsLeft: null };
  }
  const limitMicro = toMicroUsd(summary.policy.monthlyLimitUsd);
  const remainingMicro = limitMicro - chargedMicro;
  const insufficient = chargedMicro + reservationMicro > limitMicro;
  const unknownBlocks = summary.unknownReservations > 0;
  const turnsLeft = remainingMicro > 0 && reservationMicro > 0 ? Math.floor(remainingMicro / reservationMicro) : 0;
  if (limitMicro === 0) {
    return { ...base, level: "off", limitMicro, remainingMicro, percent: null, insufficient: true, unknownBlocks, turnsLeft: 0 };
  }
  const percent = Math.floor((chargedMicro * 100) / limitMicro);
  const approaching = chargedMicro * 100 >= limitMicro * BUDGET_WARNING_PERCENT;
  const level: BudgetLevel = unknownBlocks || insufficient ? "blocked" : approaching ? "approaching" : "open";
  return { ...base, level, limitMicro, remainingMicro, percent, insufficient, unknownBlocks, turnsLeft };
}

export type BudgetTone = "neutral" | "success" | "warning" | "danger";

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function turnsSentence(status: BudgetStatus): string {
  return `Room to start ${plural(status.turnsLeft ?? 0, "more turn", "more turns")} at ${formatMicroUsd(status.reservationMicro)} each.`;
}

/** The status label and one sentence that says what it means for new turns. */
export function budgetStatusCopy(status: BudgetStatus): { label: string; sentence: string; tone: BudgetTone } {
  switch (status.level) {
    case "unlimited":
      return {
        label: "No limit",
        sentence: "New turns start without a hold and are not counted in the budget ledger.",
        tone: "neutral"
      };
    case "off":
      return {
        label: "New turns paused",
        sentence: "The monthly limit is $0.00, so no new chat or scheduled turn can start until you change the limit. Turns that already hold a reservation can continue within it.",
        tone: "danger"
      };
    case "blocked": {
      const reasons: string[] = [];
      if (status.unknownBlocks) {
        reasons.push(`${plural(status.unknownThisMonth, "reservation", "reservations")} this month ${status.unknownThisMonth === 1 ? "has" : "have"} unknown usage. New turns cannot start until you reconcile ${status.unknownThisMonth === 1 ? "it" : "them"}.`);
      }
      if (status.insufficient) {
        const release = status.activeThisMonth > 0 ? " Room returns when running turns end and release unused holds." : "";
        const actions = status.unknownBlocks ? "" : `${release} To make room now, raise the limit or lower the hold per turn.`;
        reasons.push(`${formatMicroUsd(Math.max(0, status.remainingMicro ?? 0))} remains and a new turn holds ${formatMicroUsd(status.reservationMicro)}.${actions}`);
      }
      return { label: "New turns blocked", sentence: reasons.join(" "), tone: "danger" };
    }
    case "approaching":
      return { label: "Near the limit", sentence: `${status.percent}% of the limit is charged or held. ${turnsSentence(status)}`, tone: "warning" };
    case "open":
      return { label: "Budget allows new turns", sentence: turnsSentence(status), tone: "success" };
  }
}

// ---------------------------------------------------------------------------
// Draft validation for the budget dialog.

export type LimitMode = "limit" | "none" | "off";
export type BudgetDraft = { mode: LimitMode; limit: string; reservation: string };
export type BudgetDraftValue = { monthlyLimitUsd: number | null; turnReservationUsd: number };

type AmountProblem = "blank" | "format" | "precision" | "zero" | "min" | "max";

/** Digits with at most one decimal point. No signs, exponents, separators, or words such as Infinity. */
const AMOUNT_PATTERN = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

export function parseUsdAmount(text: string, min: number, allowZero = false): { value: number } | { problem: AmountProblem } {
  const trimmed = text.trim();
  if (!trimmed) return { problem: "blank" };
  if (!AMOUNT_PATTERN.test(trimmed)) return { problem: "format" };
  if ((trimmed.split(".")[1] ?? "").length > 6) return { problem: "precision" };
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return { problem: "format" };
  if (value > MODEL_SPENDING_MAX_USD) return { problem: "max" };
  if (value === 0) return allowZero ? { value } : { problem: "zero" };
  if (value < min) return { problem: "min" };
  return { value };
}

const FORMAT_HELP = "Use digits and one decimal point, for example 250.00.";
const MAX_HELP = `Enter at most ${formatUsd(MODEL_SPENDING_MAX_USD)}.`;

const LIMIT_MESSAGES: Record<AmountProblem, string> = {
  blank: "Enter a monthly limit, or pick No limit.",
  format: FORMAT_HELP,
  precision: "Use at most 6 decimal places.",
  zero: "Enter an amount above $0. To pause all new turns, pick Pause new turns.",
  min: "Enter an amount above $0.",
  max: MAX_HELP
};

const RESERVATION_MESSAGES: Record<AmountProblem, string> = {
  blank: "Enter the amount that each turn holds.",
  format: FORMAT_HELP,
  precision: "Use at most 6 decimal places.",
  zero: "The hold must be at least $0.000001.",
  min: "The hold must be at least $0.000001.",
  max: MAX_HELP
};

const COST_MESSAGES: Record<AmountProblem, string> = {
  blank: "Enter the verified total cost.",
  format: FORMAT_HELP,
  precision: "Use at most 6 decimal places.",
  zero: "",
  min: "",
  max: MAX_HELP
};

/** A verified total for reconciliation. Zero is a valid total, but blank is not. */
export function parseVerifiedCost(text: string): { value: number } | { error: string } {
  const result = parseUsdAmount(text, 0, true);
  return "problem" in result ? { error: COST_MESSAGES[result.problem] } : result;
}

export function validateBudgetDraft(draft: BudgetDraft): { errors: { limit?: string; reservation?: string }; value: BudgetDraftValue | null } {
  const errors: { limit?: string; reservation?: string } = {};
  let monthlyLimitUsd: number | null = draft.mode === "off" ? 0 : null;
  if (draft.mode === "limit") {
    const limit = parseUsdAmount(draft.limit, MODEL_SPENDING_MIN_TURN_RESERVATION_USD);
    if ("problem" in limit) errors.limit = LIMIT_MESSAGES[limit.problem];
    else monthlyLimitUsd = limit.value;
  }
  const reservation = parseUsdAmount(draft.reservation, MODEL_SPENDING_MIN_TURN_RESERVATION_USD);
  if ("problem" in reservation) errors.reservation = RESERVATION_MESSAGES[reservation.problem];
  if (errors.limit || errors.reservation || "problem" in reservation) return { errors, value: null };
  return { errors, value: { monthlyLimitUsd, turnReservationUsd: reservation.value } };
}

/** An amount as the admin would type it: no grouping, no trailing zeros. */
export function plainUsd(usd: number): string {
  return usd.toFixed(6).replace(/\.?0+$/, "");
}

export function draftFromPolicy(policy: ModelSpendingPolicy): BudgetDraft {
  const mode: LimitMode = policy.monthlyLimitUsd === null ? "none" : policy.monthlyLimitUsd === 0 ? "off" : "limit";
  return {
    mode,
    limit: mode === "limit" && policy.monthlyLimitUsd !== null ? plainUsd(policy.monthlyLimitUsd) : "",
    reservation: plainUsd(policy.turnReservationUsd)
  };
}

export function sameBudget(value: BudgetDraftValue, policy: ModelSpendingPolicy): boolean {
  const limit = (usd: number | null) => usd === null ? null : toMicroUsd(usd);
  return limit(value.monthlyLimitUsd) === limit(policy.monthlyLimitUsd)
    && toMicroUsd(value.turnReservationUsd) === toMicroUsd(policy.turnReservationUsd);
}

/** A change into No limit or $0 needs a second, explicit confirmation. */
export function budgetChangeConsequences(
  value: BudgetDraftValue,
  current: ModelSpendingPolicy,
  unknownThisMonth: number
): string[] | null {
  if (value.monthlyLimitUsd === 0 && current.monthlyLimitUsd !== 0) {
    return [
      "No new chat or scheduled turn can start until you change the limit. The pause continues into the next month.",
      "Turns that already hold a reservation keep it and can continue within it.",
      "People see an error that says the organization has no model allowance."
    ];
  }
  if (value.monthlyLimitUsd === null && current.monthlyLimitUsd !== null) {
    return [
      "New turns start without a hold. The budget ledger does not count them, so it will show less than the real spending.",
      "Use token reports to estimate the cost of those turns.",
      ...(unknownThisMonth > 0 ? ["Unknown usage stops blocking new turns. Those reservations still need recovery."] : []),
      "Reservations that are already open keep their holds."
    ];
  }
  return null;
}
