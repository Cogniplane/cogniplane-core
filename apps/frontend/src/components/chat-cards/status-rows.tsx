"use client";

import {
  AlertTriangleIcon,
  ChevronDownIcon,
  InfoIcon,
  ServerIcon,
  WrenchIcon,
  XCircleIcon
} from "lucide-react";

import type { McpServerStatusRow, RuntimeNoticeRow, ToolStatusRow } from "./chat-cards.types";

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

export function ToolStatusRowView({ row }: { row: ToolStatusRow }) {
  return (
    <article className="flex items-center gap-3 rounded-md border border-danger/30 bg-danger-surface/20 px-3 py-2 text-on-surface">
      <WrenchIcon className="size-4 shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">
          <span className="font-mono">{row.toolName}</span>
          {row.server ? <span className="text-on-surface-variant"> · {row.server}</span> : null}
          <span className="text-on-surface-variant"> · {row.status}</span>
        </div>
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
