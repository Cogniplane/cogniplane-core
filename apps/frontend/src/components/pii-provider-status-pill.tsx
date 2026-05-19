"use client";

import { useEffect, useMemo, useState } from "react";

import { getPiiProviderStatus } from "../lib/admin-api";
import type { PiiProviderStatus } from "@cogniplane/shared-types";

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
  // open
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

export function PiiProviderStatusPill() {
  const [status, setStatus] = useState<PiiProviderStatus | null | undefined>(undefined);
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    const fetchStatus = async () => {
      try {
        const result = await getPiiProviderStatus();
        if (!cancelled) setStatus(result);
      } catch {
        // Errors here mean the breaker subsystem is gone or down. Treat as
        // unknown rather than spamming red — the indicator is best-effort.
        if (!cancelled) setStatus(null);
      }
    };
    void fetchStatus();
    // Refresh every 10s. Cheap call, mostly cache hits in Redis.
    const refresh = setInterval(fetchStatus, 10_000);
    // Tick the clock once a second so the "retry in Xs" countdown updates.
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      cancelled = true;
      clearInterval(refresh);
      clearInterval(tick);
    };
  }, []);

  const pill = useMemo(() => {
    if (status === undefined) return null;
    return resolvePill(status, now);
  }, [status, now]);

  if (!pill) return null;

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
  probing: "bg-accent-soft text-accent",
  outage: "bg-danger-surface text-danger",
  neutral: "bg-surface-container text-on-surface-variant"
};

// Exported so unit tests can verify pill resolution without React.
export const __TEST__ = { resolvePill };
