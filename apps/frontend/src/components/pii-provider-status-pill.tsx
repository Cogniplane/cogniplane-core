"use client";

import { focusManager, useQuery } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";

import { getPiiProviderStatus } from "../lib/admin-api";
import { ApiError } from "../lib/api-client";
import { shouldRetryQuery } from "../lib/query-provider";
import { queryKeys } from "../lib/query-keys";
import type { PiiProviderStatus } from "@cogniplane/shared-types";

/** How often the pill reads the status while the document is visible. */
const STATUS_POLL_MS = 10_000;

type PillVariant = "ok" | "probing" | "outage" | "neutral";

interface ResolvedPill {
  variant: PillVariant;
  label: string;
  detail: string | null;
}

function resolvePill(status: PiiProviderStatus | null, now: number): ResolvedPill {
  if (!status) {
    return { variant: "neutral", label: "PII provider: unknown", detail: null };
  }
  if (status.state === "closed") {
    return {
      variant: "ok",
      label: "PII provider: OK",
      detail:
        status.failureCount > 0
          ? `${status.failureCount} recent failure${status.failureCount === 1 ? "" : "s"} (in window)`
          : null
    };
  }
  if (status.state === "half_open") {
    return {
      variant: "probing",
      label: "PII provider: probing",
      detail: "Testing recovery — next call decides whether the breaker closes"
    };
  }
  const willRetry = status.willRetryAt;
  const remainingMs = willRetry !== null ? Math.max(0, willRetry - now) : null;
  return {
    variant: "outage",
    label: "PII provider: outage",
    detail:
      remainingMs !== null
        ? `Will retry in ~${Math.ceil(remainingMs / 1000)}s`
        : "Provider unavailable"
  };
}

// The next read gets the same answer: the session ended (401) or the user is
// no longer an admin (403).
function isAccessError(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

// Query's focus manager tells if the document is visible. The poll uses the same signal.
function subscribeToVisibility(onChange: () => void): () => void {
  return focusManager.subscribe(onChange);
}

function isDocumentVisible(): boolean {
  return focusManager.isFocused();
}

/** A clock that ticks once a second until `until`. With `until` null it does not tick. */
function useCountdownClock(until: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until === null) return;
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= until) clearInterval(timer);
    }, 1_000);
    return () => clearInterval(timer);
  }, [until]);
  return now;
}

/**
 * Set `active` to false while the panel that holds the pill stays mounted but
 * hidden. The pill then stops its reads and its countdown.
 */
export function PiiProviderStatusPill({ active = true }: { active?: boolean }) {
  // Query does not run the interval read while the document is hidden
  // (refetchIntervalInBackground is false).
  const statusQuery = useQuery({
    queryKey: queryKeys.admin.piiProviderStatus(),
    queryFn: getPiiProviderStatus,
    enabled: active,
    refetchInterval: (query) => (isAccessError(query.state.error) ? false : STATUS_POLL_MS),
    retry: (failureCount, error) => !isAccessError(error) && shouldRetryQuery(failureCount, error)
  });
  const visible = useSyncExternalStore(subscribeToVisibility, isDocumentVisible, () => true);
  // A failed read shows "unknown". The indicator is best-effort, so it does not show an error.
  const status = statusQuery.isError ? null : (statusQuery.data ?? null);
  const retryAt = status?.state === "open" ? status.willRetryAt : null;
  const clock = useCountdownClock(active && visible ? retryAt : null);

  if (statusQuery.isPending || isAccessError(statusQuery.error)) return null;

  // The clock does not tick while no countdown shows, so its value can be old.
  // The time of the last read is a lower limit.
  const pill = resolvePill(status, Math.max(clock, statusQuery.dataUpdatedAt));
  const variantClass = VARIANT_CLASSES[pill.variant];

  return (
    <div
      className={`inline-flex items-center justify-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${variantClass}`}
    >
      <span>{pill.label}</span>
      {pill.detail ? <span className="font-normal opacity-85"> · {pill.detail}</span> : null}
    </div>
  );
}

const VARIANT_CLASSES: Record<PillVariant, string> = {
  ok: "bg-success-surface text-success",
  probing: "bg-info-surface text-info",
  outage: "bg-danger-surface text-danger",
  neutral: "bg-surface-container text-on-surface-variant"
};

// Exported so unit tests can verify pill resolution without React.
export const __TEST__ = { resolvePill };
