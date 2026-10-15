// @vitest-environment jsdom
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelSpendingResponse } from "@cogniplane/shared-types";

import { getModelSpending } from "../lib/model-spending-api";
import { MODEL_SPENDING_REFRESH_MS, useModelSpending, useUtcMonth } from "./use-model-spending";

vi.mock("../lib/model-spending-api", () => ({ getModelSpending: vi.fn() }));

const summary: ModelSpendingResponse = { policy: { monthlyLimitUsd: 100, turnReservationUsd: 1, version: 1 }, chargedUsd: 0,
  activeReservations: 0, unknownReservations: 0, unresolved: [], nextCursor: null };

afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });

it("refreshes the budget on an interval while the page is visible", async () => {
  vi.useFakeTimers();
  vi.mocked(getModelSpending).mockResolvedValue(summary);
  // The app default turns focus refetch off and keeps data fresh for 30 seconds.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  renderHook(() => useModelSpending("2026-09"), { wrapper });
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(getModelSpending).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(MODEL_SPENDING_REFRESH_MS));
  expect(getModelSpending).toHaveBeenCalledTimes(2);
  client.clear();
});

it("checks the UTC month again when the page becomes visible, without waiting for a delayed timer", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-30T23:59:59.000Z"));
  const { result } = renderHook(() => useUtcMonth());
  expect(result.current).toBe("2026-09");
  vi.setSystemTime(new Date("2026-10-02T09:00:00.000Z"));
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(result.current).toBe("2026-10");
});
