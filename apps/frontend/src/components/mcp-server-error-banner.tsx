"use client";

import type { McpServerStatusEvent } from "../lib/streaming-api";

export function McpServerErrorBanner(props: {
  errors: McpServerStatusEvent[];
  onDismiss: (serverName: string) => void;
}) {
  if (!props.errors.length) return null;

  return (
    <div className="flex flex-col gap-2 px-4 pt-3">
      {props.errors.map((event) => (
        <div
          key={event.serverName}
          className="flex items-start justify-between gap-3 rounded-md border border-danger/25 bg-danger-surface px-4 py-2.5 text-sm"
          role="alert"
        >
          <div className="flex min-w-0 flex-col gap-0.5">
            <strong className="text-sm text-on-surface">
              MCP server unavailable: {event.serverName}
            </strong>
            {event.error ? (
              <span className="text-xs text-on-surface-variant">{event.error}</span>
            ) : null}
          </div>
          <button
            aria-label={`Dismiss error for ${event.serverName}`}
            className="flex-shrink-0 cursor-pointer rounded px-1 py-0.5 text-xs leading-none text-on-surface-variant hover:bg-surface-container hover:text-on-surface"
            onClick={() => props.onDismiss(event.serverName)}
            type="button"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
