"use client";

import { useState } from "react";
import { keepPreviousData, useQuery, type QueryKey } from "@tanstack/react-query";
import type { Days } from "./token-usage-chart-primitives.logic";

export type UsageReport<T> = { usage: T; days: Days; loadedAt: string };

export function useUsageReport<T>(keyForDays: (days: Days) => QueryKey, fetchUsage: (days: Days) => Promise<T>) {
  const [days, setDays] = useState<Days>(30);
  const [previous, setPrevious] = useState<UsageReport<T>>();
  const query = useQuery({
    queryKey: keyForDays(days),
    queryFn: async () => ({ usage: await fetchUsage(days), days, loadedAt: new Date().toISOString() }),
    placeholderData: keepPreviousData
  });
  const report = query.data ?? previous;
  function changeDays(next: Days) {
    if (next === days) return;
    // Keep the successful response and its period when the next read fails.
    setPrevious(report);
    setDays(next);
  }
  return { days, changeDays, query, report };
}
