import { describe, expect, it } from "vitest";

import {
  budgetChangeConsequences,
  budgetStatus,
  budgetStatusCopy,
  draftFromPolicy,
  formatMonth,
  formatUsd,
  parseVerifiedCost,
  utcMonth,
  validateBudgetDraft
} from "./model-budget";

function summary(limit: number | null, charged: number, extra: { reservation?: number; unknown?: number; active?: number } = {}) {
  return {
    policy: { monthlyLimitUsd: limit, turnReservationUsd: extra.reservation ?? 1, version: 1 },
    chargedUsd: charged,
    activeReservations: extra.active ?? 0,
    unknownReservations: extra.unknown ?? 0
  };
}

describe("budgetStatus", () => {
  it("never reports a block without a limit, even with unknown usage", () => {
    const status = budgetStatus(summary(null, 500, { unknown: 2 }));
    expect(status).toMatchObject({ level: "unlimited", percent: null, insufficient: false, unknownBlocks: false });
    expect(budgetStatusCopy(status).label).toBe("No limit");
  });

  it("treats a zero limit as a pause of new turns only, without a percentage", () => {
    const status = budgetStatus(summary(0, 0));
    expect(status).toMatchObject({ level: "off", percent: null });
    const copy = budgetStatusCopy(status);
    expect(copy.label).toBe("New turns paused");
    expect(copy.sentence).toBe("The monthly limit is $0.00, so no new chat or scheduled turn can start until you change the limit. Turns that already hold a reservation can continue within it.");
    expect(`${copy.label} ${copy.sentence}`).not.toMatch(/model work is off|turn off/i);
  });

  it("limits the open label to budget admission", () => {
    expect(budgetStatusCopy(budgetStatus(summary(100, 10))).label).toBe("Budget allows new turns");
  });

  it("admits a turn whose hold fits exactly and blocks one millionth more", () => {
    expect(budgetStatus(summary(10, 9)).insufficient).toBe(false);
    expect(budgetStatus(summary(10, 9.000001)).level).toBe("blocked");
    // 0.1 + 0.2 style float input still compares as exact integers.
    expect(budgetStatus(summary(0.3, 0.1, { reservation: 0.2 })).insufficient).toBe(false);
  });

  it("blocks below the warning threshold when the hold does not fit", () => {
    const status = budgetStatus(summary(10, 5, { reservation: 6 }));
    expect(status).toMatchObject({ level: "blocked", percent: 50, insufficient: true, unknownBlocks: false });
    expect(budgetStatusCopy(status).sentence).toBe("$5.00 remains and a new turn holds $6.00. To make room now, raise the limit or lower the hold per turn.");
  });

  it("says that running turns can release room when the hold does not fit", () => {
    const status = budgetStatus(summary(10, 5, { reservation: 6, active: 2 }));
    expect(budgetStatusCopy(status).sentence).toBe("$5.00 remains and a new turn holds $6.00. Room returns when running turns end and release unused holds. To make room now, raise the limit or lower the hold per turn.");
  });

  it("does not offer a limit change as the fix when unknown usage also blocks", () => {
    const sentence = budgetStatusCopy(budgetStatus(summary(10, 5, { reservation: 6, unknown: 1, active: 1 }))).sentence;
    expect(sentence).toContain("New turns cannot start until you reconcile it.");
    expect(sentence).toMatch(/holds \$6\.00\.$/);
  });

  it("shows the millionth that decides admission in the status copy", () => {
    const fits = budgetStatus(summary(1.000002, 0, { reservation: 1.000002 }));
    const short = budgetStatus(summary(1.000001, 0, { reservation: 1.000002 }));
    expect(fits.insufficient).toBe(false);
    expect(short.insufficient).toBe(true);
    expect(budgetStatusCopy(short).sentence).toContain("$1.000001 remains and a new turn holds $1.000002.");
  });

  it("warns at 80% and not below it", () => {
    expect(budgetStatus(summary(100, 79.999999)).level).toBe("open");
    expect(budgetStatus(summary(100, 80))).toMatchObject({ level: "approaching", percent: 80, turnsLeft: 20 });
  });

  it("blocks on unknown usage this month when a limit is set, before any warning", () => {
    const status = budgetStatus(summary(100, 90, { unknown: 1 }));
    expect(status.level).toBe("blocked");
    expect(budgetStatusCopy(status).sentence).toContain("1 reservation this month has unknown usage");
  });

  it("reports spending over the limit without a negative remainder in the copy", () => {
    const status = budgetStatus(summary(10, 12.5));
    expect(status).toMatchObject({ level: "blocked", remainingMicro: -2_500_000, percent: 125, turnsLeft: 0 });
    expect(budgetStatusCopy(status).sentence).toContain("$0.00 remains");
  });
});

describe("formatUsd", () => {
  it("keeps every stored millionth and at least two decimals", () => {
    expect(formatUsd(1.000001)).toBe("$1.000001");
    expect(formatUsd(1.000002)).toBe("$1.000002");
    expect(formatUsd(4.030001)).toBe("$4.030001");
    expect(formatUsd(250.5)).toBe("$250.50");
    expect(formatUsd(1234.123456)).toBe("$1,234.123456");
    expect(formatUsd(0.000001)).toBe("$0.000001");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(1_000_000)).toBe("$1,000,000.00");
  });
});

describe("budget draft", () => {
  const base = { mode: "limit" as const, limit: "100", reservation: "1" };

  it("tells blank apart from zero", () => {
    expect(validateBudgetDraft({ ...base, limit: "" }).errors.limit).toBe("Enter a monthly limit, or pick No limit.");
    expect(validateBudgetDraft({ ...base, limit: "0" }).errors.limit).toBe("Enter an amount above $0. To pause all new turns, pick Pause new turns.");
    expect(validateBudgetDraft({ ...base, reservation: "  " }).errors.reservation).toBe("Enter the amount that each turn holds.");
    expect(validateBudgetDraft({ ...base, reservation: "0.0" }).errors.reservation).toBe("The hold must be at least $0.000001.");
  });

  it.each(["1e3", "Infinity", "NaN", "-5", "1,000", "12.5.1", "$10", "0x10"])("rejects %s as a format error", (text) => {
    expect(validateBudgetDraft({ ...base, limit: text }).errors.limit).toBe("Use digits and one decimal point, for example 250.00.");
  });

  it("keeps the API precision and range", () => {
    expect(validateBudgetDraft({ ...base, reservation: "0.0000001" }).errors.reservation).toBe("Use at most 6 decimal places.");
    expect(validateBudgetDraft({ ...base, reservation: "0.000001" }).value).toEqual({ monthlyLimitUsd: 100, turnReservationUsd: 0.000001 });
    expect(validateBudgetDraft({ ...base, limit: "1000000.01" }).errors.limit).toBe("Enter at most $1,000,000.00.");
    expect(validateBudgetDraft({ ...base, limit: "1000000" }).value?.monthlyLimitUsd).toBe(1_000_000);
  });

  it("maps the explicit choices to null and zero", () => {
    expect(validateBudgetDraft({ ...base, mode: "none", limit: "" }).value).toEqual({ monthlyLimitUsd: null, turnReservationUsd: 1 });
    expect(validateBudgetDraft({ ...base, mode: "off", limit: "junk" }).value).toEqual({ monthlyLimitUsd: 0, turnReservationUsd: 1 });
  });

  it("starts from the saved policy", () => {
    expect(draftFromPolicy({ monthlyLimitUsd: 250.5, turnReservationUsd: 0.25, version: 2 })).toEqual({ mode: "limit", limit: "250.5", reservation: "0.25" });
    expect(draftFromPolicy({ monthlyLimitUsd: null, turnReservationUsd: 1, version: 2 }).mode).toBe("none");
    expect(draftFromPolicy({ monthlyLimitUsd: 0, turnReservationUsd: 1, version: 2 }).mode).toBe("off");
  });

  it("asks for confirmation only when the change turns work off or removes the limit", () => {
    const limited = { monthlyLimitUsd: 100, turnReservationUsd: 1, version: 1 };
    expect(budgetChangeConsequences({ monthlyLimitUsd: 0, turnReservationUsd: 1 }, limited, 0)?.[0]).toContain("No new chat or scheduled turn");
    expect(budgetChangeConsequences({ monthlyLimitUsd: null, turnReservationUsd: 1 }, limited, 2)).toContain("Unknown usage stops blocking new turns. Those reservations still need recovery.");
    expect(budgetChangeConsequences({ monthlyLimitUsd: 50, turnReservationUsd: 1 }, limited, 0)).toBeNull();
    expect(budgetChangeConsequences({ monthlyLimitUsd: null, turnReservationUsd: 2 }, { ...limited, monthlyLimitUsd: null }, 0)).toBeNull();
  });
});

it("accepts a zero verified cost but not a blank one", () => {
  expect(parseVerifiedCost("0")).toEqual({ value: 0 });
  expect(parseVerifiedCost("")).toEqual({ error: "Enter the verified total cost." });
  expect(parseVerifiedCost("-1")).toHaveProperty("error");
});

it("uses the UTC month", () => {
  expect(utcMonth(new Date("2026-09-30T23:30:00-05:00"))).toBe("2026-10");
  expect(formatMonth("2026-09")).toBe("September 2026");
});
