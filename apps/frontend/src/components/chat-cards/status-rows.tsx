"use client";

import {
  AlertTriangleIcon,
  ChevronDownIcon,
  InfoIcon,
  WrenchIcon,
  XCircleIcon
} from "lucide-react";

import type { RuntimeNoticeRow, ToolStatusRow } from "./chat-cards.types";

export function ToolStatusRowView({ row }: { row: ToolStatusRow }) {
  return (
    <article className="flex items-center gap-3 rounded-md border border-danger/30 bg-danger-surface px-3 py-2 text-on-surface">
      <WrenchIcon aria-hidden="true" className="size-4 shrink-0 text-danger" />
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
      ? "border-danger/30 bg-danger-surface text-on-surface"
      : row.level === "warning"
        ? "border-warning/30 bg-warning-surface text-on-surface"
        : "border-outline-variant bg-surface-container-low text-on-surface-variant";
  const open = row.level !== "info";

  return (
    <details open={open} className={`group rounded-md border px-3 py-2 ${tone}`}>
      {/* The summary keeps the focus ring of the shared controls. The
          negative margin lets the ring frame the row inside the padding. */}
      <summary className="-mx-1 flex cursor-pointer list-none items-center gap-2 rounded-sm px-1 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 -rotate-90 transition-transform group-open:rotate-0 motion-reduce:transition-none" />
        <Icon aria-hidden="true" className={`size-4 shrink-0 ${row.level === "error" ? "text-danger" : row.level === "warning" ? "text-warning" : "text-on-surface-variant"}`} />
        <span className="font-semibold">{row.title}</span>
      </summary>
      <p className="mt-1 ml-11 break-words text-xs text-on-surface-variant [overflow-wrap:anywhere]">{row.message}</p>
    </details>
  );
}
