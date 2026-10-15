"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { AdminSessionsSection } from "../../../components/admin/sessions/admin-sessions-section";
import { AdminSessionsFilters } from "../../../components/admin/sessions/admin-sessions-filters";
import {
  EMPTY_FILTER_STATE,
  defaultLast7dRange,
  filterStateToParams,
  parseStateFromSearchParams,
  searchParamsHaveAnyFilter,
  stateToSearchString,
  type SessionsFilterState
} from "../../../components/admin/sessions/admin-sessions-filters.logic";
import { AdminSessionsPresets } from "../../../components/admin/sessions/admin-sessions-presets";
import { useAdminSessionsData } from "../../../hooks/use-admin-sessions-data";
import { sessionDetailHref } from "../../../lib/admin-session-links";
import type { AdminSessionRow } from "@cogniplane/shared-types";

export default function AdminSessionsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [state, setState] = useState<SessionsFilterState>(() => {
    const initial = parseStateFromSearchParams(new URLSearchParams(searchParams.toString()));
    if (!searchParamsHaveAnyFilter(new URLSearchParams(searchParams.toString()))) {
      return { ...EMPTY_FILTER_STATE, ...defaultLast7dRange() };
    }
    return initial;
  });

  // Push the chosen default range into the URL on first paint when no filters are present,
  // so the page is bookmarkable and matches what the data hook actually requested.
  const hasSyncedDefaultRef = useRef(false);
  useEffect(() => {
    if (hasSyncedDefaultRef.current) return;
    if (searchParamsHaveAnyFilter(new URLSearchParams(searchParams.toString()))) {
      hasSyncedDefaultRef.current = true;
      return;
    }
    hasSyncedDefaultRef.current = true;
    const qs = stateToSearchString(state);
    if (qs) router.replace(`${pathname}?${qs}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced URL sync. The text field is the only source that fires often;
  // selects and date pickers fire on commit.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const qs = stateToSearchString(state);
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [state, pathname, router]);

  const params = useMemo(() => filterStateToParams(state), [state]);
  const { sessions, error, available, isLoading, hasMore, isLoadingMore, loadMore } =
    useAdminSessionsData(params);

  const handleClear = () => {
    setState({ ...EMPTY_FILTER_STATE, ...defaultLast7dRange() });
  };

  const handleRowClick = (sessionId: string) => {
    router.push(sessionDetailHref(sessionId, stateToSearchString(state)));
  };

  return (
    <section id="sessions" className="flex flex-col gap-5 pt-5">
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <AdminSessionsPresets state={state} onApply={setState} />
      <AdminSessionsFilters state={state} onChange={setState} onClear={handleClear} />
      {available ? (
        <AdminSessionsSection
          sessions={sessions as AdminSessionRow[]}
          isLoading={isLoading}
          onRowClick={handleRowClick}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          onLoadMore={loadMore}
        />
      ) : null}
    </section>
  );
}
