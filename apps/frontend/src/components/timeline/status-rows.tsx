"use client";

import {
  AlertTriangleIcon,
  ChevronDownIcon,
  InfoIcon,
  ServerIcon,
  ShieldAlertIcon,
  XCircleIcon
} from "lucide-react";

import type {
  McpServerStatusRow,
  PolicyBlockRow,
  RuntimeErrorRow,
  RuntimeNoticeRow
} from "../timeline.logic";

export function McpServerStatusRowView({ row }: { row: McpServerStatusRow }) {
  const isFailed = row.status === "failed";
  return (
    <article
      className={`flex items-center gap-3 rounded-md border px-3 py-2 ${
        isFailed
          ? "border-danger/30 bg-danger-surface/20 text-on-surface"
          : "border-outline-variant bg-surface-container-low text-on-surface-variant"
      }`}
    >
      <ServerIcon className={`size-4 shrink-0 ${isFailed ? "text-danger" : "text-on-surface-faint"}`} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">
          {row.serverName} · {row.status}
        </div>
        {row.error ? (
          <div className="mt-0.5 truncate font-mono text-xs text-on-surface-faint">{row.error}</div>
        ) : null}
      </div>
    </article>
  );
}

export function RuntimeNoticeRowView({ row }: { row: RuntimeNoticeRow }) {
  const Icon = row.level === "error" ? XCircleIcon : row.level === "warning" ? AlertTriangleIcon : InfoIcon;
  const tone =
    row.level === "error"
      ? "border-danger/30 bg-danger-surface/20 text-on-surface"
      : row.level === "warning"
        ? "border-warning/30 bg-warning-surface/20 text-on-surface"
        : "border-outline-variant bg-surface-container-low text-on-surface-variant";
  const open = row.level !== "info";

  return (
    <details open={open} className={`group rounded-md border px-3 py-2 ${tone}`}>
      <summary className="flex cursor-pointer items-center gap-2 text-sm outline-none">
        <ChevronDownIcon className="size-3 -rotate-90 transition-transform group-open:rotate-0" />
        <Icon className="size-4 shrink-0" />
        <span className="font-semibold">{row.title}</span>
      </summary>
      <p className="mt-1 ml-6 text-xs text-on-surface-variant">{row.message}</p>
    </details>
  );
}

export function PolicyBlockRowView({ row }: { row: PolicyBlockRow }) {
  return (
    <article
      role="alert"
      className="flex items-start gap-3 rounded-md border border-danger/30 bg-danger-surface/20 px-4 py-3"
    >
      <ShieldAlertIcon className="size-5 shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <div className="text-[0.64rem] font-extrabold uppercase tracking-[0.14em] text-danger">
          Policy block · {row.blockReason}
        </div>
        <p className="mt-1 text-sm text-on-surface">{row.message}</p>
      </div>
    </article>
  );
}

export function RuntimeErrorRowView({ row }: { row: RuntimeErrorRow }) {
  return (
    <article
      role="alert"
      className="flex items-start gap-3 rounded-md border border-danger/30 bg-danger-surface/20 px-4 py-3"
    >
      <XCircleIcon className="size-5 shrink-0 text-danger" />
      <p className="m-0 text-sm text-on-surface">{row.message}</p>
    </article>
  );
}
