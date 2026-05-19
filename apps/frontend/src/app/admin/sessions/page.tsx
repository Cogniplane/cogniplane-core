"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { AdminSessionsSection } from "../../../components/admin-sessions-section";
import { AdminSessionsFilters } from "../../../components/admin-sessions-filters";
import {
  EMPTY_FILTER_STATE,
  defaultLast7dRange,
  filterStateToParams,
  type SessionsFilterState
} from "../../../components/admin-sessions-filters.logic";
import { AdminSessionsPresets } from "../../../components/admin-sessions-presets";
import { useAdminSessionsData } from "../../../hooks/use-admin-sessions-data";
import type { AdminSessionAlertKind, AdminSessionRow } from "@cogniplane/shared-types";

const SECTION_LABEL =
  "text-[0.62rem] font-bold uppercase tracking-[0.14em] text-on-surface-faint";

const FILTER_KEYS: Array<keyof SessionsFilterState> = [
  "userId",
  "from",
  "to",
  "status",
  "runtime",
  "alert"
];

const ALERT_KINDS: AdminSessionAlertKind[] = [
  "pii-blocked",
  "pii-transformed",
  "pii-detected",
  "approval-rejected",
  "approval-pending",
  "errored"
];

function parseStateFromSearchParams(params: URLSearchParams): SessionsFilterState {
  const status = params.get("status");
  const runtime = params.get("runtime");
  const alert = params.get("alert");
  const alertTokens =
    alert
      ?.split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .filter((t): t is AdminSessionAlertKind =>
        ALERT_KINDS.includes(t as AdminSessionAlertKind)
      ) ?? [];

  return {
    userId: params.get("userId") ?? "",
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
    status:
      status === "active" || status === "errored" ? status : "",
    runtime: runtime === "codex" || runtime === "claude-code" ? runtime : "",
    alert: alertTokens
  };
}

function stateToSearchString(state: SessionsFilterState): string {
  const params = new URLSearchParams();
  if (state.userId) params.set("userId", state.userId);
  if (state.from) params.set("from", state.from);
  if (state.to) params.set("to", state.to);
  if (state.status) params.set("status", state.status);
  if (state.runtime) params.set("runtime", state.runtime);
  if (state.alert.length > 0) params.set("alert", state.alert.join(","));
  return params.toString();
}

function searchParamsHaveAnyFilter(params: URLSearchParams): boolean {
  return FILTER_KEYS.some((key) => params.has(key));
}

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
    const qs = stateToSearchString(state);
    const fromParam = qs ? `?from=${encodeURIComponent(qs)}` : "";
    router.push(`/admin/sessions/${sessionId}${fromParam}`);
  };

  return (
    <section id="sessions" className="flex flex-col gap-5">
      <div>
        <p className={SECTION_LABEL}>Review</p>
        <h3 className="text-lg font-semibold text-on-surface">Sessions</h3>
      </div>
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
