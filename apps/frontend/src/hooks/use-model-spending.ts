"use client";

import { useEffect, useState } from "react";
import { useInfiniteQuery, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import type { ModelSpendingReservation, ModelSpendingResponse } from "@cogniplane/shared-types";

import { getModelSpending } from "../lib/model-spending-api";
import { utcMonth } from "../lib/model-budget";
import { queryKeys } from "../lib/query-keys";

export type ModelSpendingPages = InfiniteData<ModelSpendingResponse, string | null>;

/** Background refresh while the page is visible. Runtime turns change the ledger at any time. */
export const MODEL_SPENDING_REFRESH_MS = 60_000;

/**
 * The current UTC accounting month. It changes at the month boundary, so the
 * query key changes and the summary loads again for the new month.
 */
export function useUtcMonth(): string {
  const [month, setMonth] = useState(() => utcMonth());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      clearTimeout(timer);
      const now = new Date();
      const nextMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
      // Timers longer than about 24 days overflow, so check at least daily.
      timer = setTimeout(() => {
        setMonth(utcMonth());
        schedule();
      }, Math.min(nextMonth - now.getTime() + 1_000, 86_400_000));
    };
    // A suspended tab or a sleeping computer delays timers. Check the month
    // again as soon as the page is visible or focused.
    const check = () => {
      if (document.visibilityState === "hidden") return;
      setMonth(utcMonth());
      schedule();
    };
    schedule();
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, []);
  return month;
}

/**
 * The first page holds the summary for the whole month (policy, charged and
 * held total, counts). Later pages only add unresolved reservations. The Usage
 * panel and the Overview share this cache entry.
 *
 * The data refreshes on focus and every minute while the page is visible.
 */
export function useModelSpending(month: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.admin.modelSpendingMonth(month),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => getModelSpending(pageParam),
    getNextPageParam: (last) => last.nextCursor,
    refetchOnWindowFocus: true,
    refetchInterval: MODEL_SPENDING_REFRESH_MS
  });
}

/** Unresolved reservations from all loaded pages, without duplicates. */
export function unresolvedReservations(data: Pick<ModelSpendingPages, "pages"> | undefined): ModelSpendingReservation[] {
  const byId = new Map<string, ModelSpendingReservation>();
  for (const page of data?.pages ?? []) {
    for (const reservation of page.unresolved) {
      if (!byId.has(reservation.reservationId)) byId.set(reservation.reservationId, reservation);
    }
  }
  return [...byId.values()];
}

/**
 * After a change, keep only the first page (replaced by `firstPage` when the
 * server returned it) and load it again. Later pages would use cursors from
 * before the change, so they are dropped instead of shown stale.
 */
export function refreshModelSpending(
  queryClient: QueryClient,
  month: string,
  options: { firstPage?: ModelSpendingResponse; throwOnError?: boolean } = {}
) {
  queryClient.setQueryData<ModelSpendingPages>(queryKeys.admin.modelSpendingMonth(month), (old) => {
    const page = options.firstPage ?? old?.pages[0];
    return page ? { pages: [page], pageParams: [null] } : old;
  });
  // With `throwOnError`, the promise rejects when the reload fails, so the
  // caller does not say that the list is current.
  return queryClient.invalidateQueries({ queryKey: queryKeys.admin.modelSpending() }, { throwOnError: options.throwOnError });
}
