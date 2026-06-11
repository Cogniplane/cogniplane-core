"use client";

import { ChevronDownIcon, TerminalIcon, WrenchIcon } from "lucide-react";

import type { McpToolCallRow, ShellCommandRow } from "../timeline.logic";
import { formatElapsed, STATUS_BADGE, STATUS_BORDER, statusBadgeLabel } from "./shared";

export function ShellCommandRowView({ row }: { row: ShellCommandRow }) {
  const elapsed = formatElapsed(row.durationMs);
  const open = row.status === "in_progress" || row.status === "failed";

  return (
    <details
      open={open}
      className={`group rounded-md border-l-2 bg-surface-container-low pl-3 pr-2 py-2 ${STATUS_BORDER[row.status]}`}
    >
      <summary className="flex cursor-pointer items-center gap-2 text-sm outline-none">
        <ChevronDownIcon className="size-3 -rotate-90 text-on-surface-faint transition-transform group-open:rotate-0" />
        <TerminalIcon className="size-3 shrink-0 text-on-surface-faint" />
        <span className="min-w-0 flex-1 truncate font-mono text-on-surface">
          {row.command || "shell command"}
        </span>
        {elapsed ? (
          <span className="shrink-0 font-mono text-[0.7rem] text-on-surface-faint">{elapsed}</span>
        ) : null}
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[0.62rem] font-bold uppercase tracking-wider ${STATUS_BADGE[row.status]}`}
        >
          {statusBadgeLabel(row.status)}
        </span>
      </summary>
      <div className="mt-2 overflow-x-auto">
        <pre className="whitespace-pre-wrap break-all font-mono text-[0.78rem] leading-snug text-on-surface-variant">
          {row.cwd ? `cwd: ${row.cwd}\n` : ""}
          {row.command}
          {row.output ? `\n\n${row.output}` : ""}
          {row.exitCode != null ? `\n\nexit code: ${row.exitCode}` : ""}
        </pre>
      </div>
    </details>
  );
}

export function McpToolCallRowView({ row }: { row: McpToolCallRow }) {
  const elapsed = formatElapsed(row.durationMs);
  const open = row.status === "in_progress" || row.status === "failed";

  const label = `${row.toolName ?? "tool"}${row.server ? ` @ ${row.server}` : ""}`;

  return (
    <details
      open={open}
      className={`group rounded-md border-l-2 bg-surface-container-low pl-3 pr-2 py-2 ${STATUS_BORDER[row.status]}`}
    >
      <summary className="flex cursor-pointer items-center gap-2 text-sm outline-none">
        <ChevronDownIcon className="size-3 -rotate-90 text-on-surface-faint transition-transform group-open:rotate-0" />
        <WrenchIcon className="size-3 shrink-0 text-on-surface-faint" />
        <span className="min-w-0 flex-1 truncate font-mono text-on-surface">{label}</span>
        {elapsed ? (
          <span className="shrink-0 font-mono text-[0.7rem] text-on-surface-faint">{elapsed}</span>
        ) : null}
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[0.62rem] font-bold uppercase tracking-wider ${STATUS_BADGE[row.status]}`}
        >
          {statusBadgeLabel(row.status)}
        </span>
      </summary>
      <div className="mt-2 overflow-x-auto">
        <pre className="whitespace-pre-wrap break-all font-mono text-[0.78rem] leading-snug text-on-surface-variant">
          {row.input ? `${row.input}\n\n` : ""}
          {row.output}
        </pre>
      </div>
    </details>
  );
}
