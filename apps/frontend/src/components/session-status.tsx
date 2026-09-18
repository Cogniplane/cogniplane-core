"use client";

import { useEffect, useState } from "react";
import { CircleCheckIcon, CircleAlertIcon, LoaderCircleIcon, ShieldQuestionIcon } from "lucide-react";
import { formatTurnElapsed, formatTurnDuration, type CompletedTurn, type SessionStatus } from "./session-status.logic";

const statuses = {
  approval: { label: "Waiting for approval", icon: ShieldQuestionIcon, color: "text-warning" },
  failed: { label: "Failed", icon: CircleAlertIcon, color: "text-danger" },
  running: { label: "Running", icon: LoaderCircleIcon, color: "text-brand" },
  ready: { label: "Ready", icon: CircleCheckIcon, color: "text-on-surface-variant" }
};

function TurnTimer({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);
  const elapsed = formatTurnElapsed(startedAt, now);
  return <span className="whitespace-nowrap tabular-nums">{elapsed === null ? "Running · time unavailable" : `Running for ${elapsed}`}</span>;
}

export function SessionStatusIndicator({ status, startedAt, completedTurn, showLabel = false }: {
  status: SessionStatus;
  startedAt?: string;
  completedTurn?: CompletedTurn;
  showLabel?: boolean;
}) {
  const duration = completedTurn ? formatTurnDuration(completedTurn.durationMs) : null;
  const completedLabel = completedTurn && duration !== null && (status === "ready" || status === "failed")
    ? `${completedTurn.status === "completed" ? "Worked for" : completedTurn.status === "error" ? "Failed after" : "Stopped after"} ${duration}`
    : null;
  // The session poll can lag behind the matching message's final outcome.
  const displayStatus = completedLabel && completedTurn
    ? completedTurn.status === "error" ? "failed" : "ready"
    : status;
  const { label, icon: Icon, color } = statuses[displayStatus];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 text-xs ${color}`} title={completedLabel ? `${completedLabel}. Elapsed time includes setup and approval waits.` : label}>
      <Icon aria-label={label} role="img" className={`size-3.5 shrink-0 ${status === "running" ? "motion-safe:animate-spin" : ""}`} />
      {status === "running" && startedAt ? <TurnTimer key={startedAt} startedAt={startedAt} /> : completedLabel ? <span className="whitespace-nowrap tabular-nums">{completedLabel}</span> : showLabel ? <span>{label}</span> : null}
    </span>
  );
}
