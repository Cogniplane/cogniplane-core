import { beforeEach, expect, it, vi } from "vitest";

import { request } from "./api-client";
import {
  closeModelSpendingReservation,
  getModelSpending,
  reconcileModelSpendingReservation,
  updateModelSpendingPolicy
} from "./model-spending-api";

vi.mock("./api-client", () => ({ request: vi.fn() }));

function body(unresolved: unknown[] = []) {
  return {
    policy: { monthlyLimitUsd: 100, turnReservationUsd: 1, version: 3 },
    chargedUsd: 12.5,
    activeReservations: 1,
    unknownReservations: 0,
    unresolved,
    nextCursor: null
  };
}

function row(overrides: Record<string, unknown>) {
  return {
    reservationId: "r-1", sessionId: "s-1", turnContext: "interactive", period: "2026-09-01",
    status: "reserved", chargedMicroUsd: "1000000", updatedAt: "2026-09-27T12:00:00.000Z", ...overrides
  };
}

beforeEach(() => { vi.mocked(request).mockReset(); });

it("reads bigint charges sent as strings or numbers as safe integers", async () => {
  vi.mocked(request).mockResolvedValue(body([row({ chargedMicroUsd: "1250000" }), row({ reservationId: "r-2", chargedMicroUsd: 42 })]));
  const result = await getModelSpending();
  expect(result.unresolved.map((item) => item.chargedMicroUsd)).toEqual([1_250_000, 42]);
  expect(vi.mocked(request)).toHaveBeenCalledWith("/admin/model-spending");
});

it.each([
  ["a plain date", "2026-09-01", "2026-09"],
  ["UTC midnight", "2026-09-01T00:00:00.000Z", "2026-09"],
  ["local midnight east of UTC", "2026-08-31T22:00:00.000Z", "2026-09"],
  ["local midnight at UTC+14", "2026-08-31T10:00:00.000Z", "2026-09"],
  ["local midnight west of UTC", "2026-09-01T04:00:00.000Z", "2026-09"],
  ["local midnight at UTC-12", "2026-01-01T12:00:00.000Z", "2026-01"]
])("normalizes a period sent as %s to its UTC month", async (_label, period, month) => {
  vi.mocked(request).mockResolvedValue(body([row({ period })]));
  expect((await getModelSpending()).unresolved[0]!.period).toBe(month);
});

it.each([
  ["a negative charge", row({ chargedMicroUsd: "-1" })],
  ["a decimal charge", row({ chargedMicroUsd: "1.5" })],
  ["an unsafe charge", row({ chargedMicroUsd: "9007199254740993" })],
  ["an unknown status", row({ status: "settled" })]
])("rejects %s instead of showing wrong money", async (_label, value) => {
  vi.mocked(request).mockResolvedValue(body([value]));
  await expect(getModelSpending()).rejects.toThrow("Schema mismatch");
});

it("passes the cursor for later pages", async () => {
  vi.mocked(request).mockResolvedValue(body());
  await getModelSpending("r/200 &x");
  expect(vi.mocked(request)).toHaveBeenCalledWith("/admin/model-spending?cursor=r%2F200+%26x");
});

it("sends only the policy fields with the version, and returns the new summary", async () => {
  vi.mocked(request).mockResolvedValue(body());
  const result = await updateModelSpendingPolicy({ monthlyLimitUsd: null, turnReservationUsd: 0.5, version: 3 });
  expect(result.policy.version).toBe(3);
  const [path, init] = vi.mocked(request).mock.calls[0]!;
  expect(path).toBe("/admin/model-spending");
  expect(init?.method).toBe("PUT");
  expect(JSON.parse(String(init?.body))).toEqual({ monthlyLimitUsd: null, turnReservationUsd: 0.5, version: 3 });
});

it.each([
  { monthlyLimitUsd: -1, turnReservationUsd: 1, version: 1 },
  { monthlyLimitUsd: 1_000_001, turnReservationUsd: 1, version: 1 },
  { monthlyLimitUsd: 10, turnReservationUsd: 0, version: 1 },
  { monthlyLimitUsd: Number.POSITIVE_INFINITY, turnReservationUsd: 1, version: 1 },
  { monthlyLimitUsd: 10, turnReservationUsd: 1, version: 0 }
])("does not send a policy outside the API limits: %o", async (input) => {
  await expect(updateModelSpendingPolicy(input)).rejects.toThrow();
  expect(vi.mocked(request)).not.toHaveBeenCalled();
});

it("encodes reservation IDs and sends the verified total", async () => {
  vi.mocked(request).mockResolvedValue({ ok: true });
  await closeModelSpendingReservation("turn/1");
  await reconcileModelSpendingReservation("turn/1", 0.25);
  expect(vi.mocked(request).mock.calls[0]).toEqual(["/admin/model-spending/turn%2F1/close", { method: "POST" }]);
  expect(vi.mocked(request).mock.calls[1]).toEqual(["/admin/model-spending/turn%2F1/reconcile", { method: "POST", body: JSON.stringify({ actualUsd: 0.25 }) }]);
  await expect(reconcileModelSpendingReservation("turn/1", -1)).rejects.toThrow();
  expect(vi.mocked(request)).toHaveBeenCalledTimes(2);
});
