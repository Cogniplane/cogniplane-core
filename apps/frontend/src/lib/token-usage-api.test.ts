import { beforeEach, expect, it, vi } from "vitest";

import { request } from "./api-client";
import { fetchMemberMonthUsage, fetchTokenUsage } from "./token-usage-api";

vi.mock("./api-client", () => ({ request: vi.fn() }));

const usage = {
  daily: [],
  byUser: [],
  byModel: [],
  totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, messageCount: 0 }
};
const range = { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" };

beforeEach(() => { vi.mocked(request).mockReset(); });

it("asks for one member's current UTC month and returns the range", async () => {
  vi.mocked(request).mockResolvedValue({ usage, days: 30, period: "current_month", range, userId: "dana" });
  expect(await fetchMemberMonthUsage("dana")).toEqual({ usage, range });
  const url = new URL(vi.mocked(request).mock.calls[0]![0], "http://localhost");
  expect(url.pathname).toBe("/admin/token-usage");
  expect(url.searchParams.get("userId")).toBe("dana");
  expect(url.searchParams.get("period")).toBe("current_month");
});

it.each([
  ["ignores the filters", { usage, days: 30 }],
  ["echoes another member", { usage, days: 30, period: "current_month", range, userId: "fox" }]
])("rejects a response that %s instead of showing wrong data", async (_label, body) => {
  vi.mocked(request).mockResolvedValue(body);
  await expect(fetchMemberMonthUsage("dana")).rejects.toThrow("cannot report usage for one person");
});

it("keeps the tenant-wide request unchanged", async () => {
  vi.mocked(request).mockResolvedValue({ usage, days: 7 });
  await fetchTokenUsage(7);
  expect(vi.mocked(request)).toHaveBeenCalledWith("/admin/token-usage?days=7");
});
