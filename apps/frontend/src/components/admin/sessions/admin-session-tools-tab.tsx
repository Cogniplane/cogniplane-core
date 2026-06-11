"use client";

import { useMemo, useState } from "react";

import type {
  AdminSessionDetailMessageToolResult,
  AdminSessionDetailToolEvent
} from "@cogniplane/shared-types";
import {
  buildToolRows,
  formatToolDuration,
  formatToolTimestamp
} from "./admin-session-tools-tab.logic";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PILL_GRAY, PILL_BLUE, PILL_RED, HINT, LIST_ITEM } from "../../../lib/ui-tokens";

function phasePillClass(phase: string): string {
  if (phase === "completed") return PILL_BLUE;
  if (phase === "failed") return PILL_RED;
  return PILL_GRAY;
}

function statusPillClass(status: string): string {
  if (status === "completed") return PILL_BLUE;
  if (status === "failed" || status === "declined") return PILL_RED;
  return PILL_GRAY;
}

export function AdminSessionToolsTab(props: {
  toolEvents: AdminSessionDetailToolEvent[];
  messageToolResults: AdminSessionDetailMessageToolResult[];
}) {
  const [filter, setFilter] = useState("");

  const allRows = useMemo(
    () => buildToolRows(props.toolEvents, props.messageToolResults),
    [props.toolEvents, props.messageToolResults]
  );

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return allRows;
    return allRows.filter((row) => row.title.toLowerCase().includes(q));
  }, [filter, allRows]);

  if (allRows.length === 0) {
    return <p className={HINT}>No tool invocations in this session.</p>;
  }

  return (
    <>
      <div className="mb-3 flex flex-col gap-1.5">
        <Label htmlFor="tools-filter">Filter by tool</Label>
        <Input
          id="tools-filter"
          type="text"
          placeholder="Tool name"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {filtered.length === 0 ? (
        <p className={HINT}>No tools match this filter.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map((row) => (
            <details key={row.key} className={LIST_ITEM}>
              <summary className="cursor-pointer list-revert">
                <div className="inline-block w-[calc(100%-24px)] align-top">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <strong className="text-sm font-semibold text-on-surface">{row.title}</strong>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={PILL_GRAY}>{row.kind}</span>
                      {row.source === "event" ? (
                        <>
                          <span className={phasePillClass(row.data.phase)}>{row.data.phase}</span>
                          <span className={PILL_GRAY}>{row.data.status}</span>
                        </>
                      ) : (
                        <>
                          <span className={statusPillClass(row.data.status)}>
                            {row.data.status}
                          </span>
                          {row.data.serverName ? (
                            <span className={PILL_GRAY}>{row.data.serverName}</span>
                          ) : null}
                        </>
                      )}
                    </div>
                  </div>
                  <p className="mt-1 text-xs text-on-surface-faint">
                    {formatToolTimestamp(row.createdAt)} · {formatToolDuration(row.durationMs)}
                  </p>
                </div>
              </summary>
              {row.source === "event" ? (
                <ToolEventBody event={row.data} />
              ) : (
                <ToolResultBody result={row.data} />
              )}
            </details>
          ))}
        </div>
      )}
    </>
  );
}

function ToolEventBody(props: { event: AdminSessionDetailToolEvent }) {
  const { event: evt } = props;
  return (
    <div className="mt-2 text-xs text-on-surface-variant">
      <p>
        <strong className="font-semibold text-on-surface">Tool call ID:</strong> {evt.toolCallId}
      </p>
      {evt.messageId ? (
        <p>
          <strong className="font-semibold text-on-surface">Message ID:</strong> {evt.messageId}
        </p>
      ) : null}
      {evt.approvalId ? (
        <p>
          <strong className="font-semibold text-on-surface">Approval ID:</strong> {evt.approvalId}
        </p>
      ) : null}
      {evt.payload &&
      typeof evt.payload === "object" &&
      Object.keys(evt.payload as object).length > 0 ? (
        <details className="mt-2">
          <summary className="cursor-pointer">Payload (redacted at write time)</summary>
          <pre className="mt-1.5 overflow-auto text-[11px]">
            {JSON.stringify(evt.payload, null, 2)}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

function ToolResultBody(props: { result: AdminSessionDetailMessageToolResult }) {
  const { result: tr } = props;
  return (
    <div className="mt-2 text-xs text-on-surface-variant">
      <p>
        <strong className="font-semibold text-on-surface">Tool result ID:</strong> {tr.toolResultId}
      </p>
      <p>
        <strong className="font-semibold text-on-surface">Message ID:</strong> {tr.messageId}
      </p>
      {tr.toolName ? (
        <p>
          <strong className="font-semibold text-on-surface">Tool name:</strong> {tr.toolName}
        </p>
      ) : null}
      {tr.commandText ? (
        <p>
          <strong className="font-semibold text-on-surface">Command:</strong>{" "}
          <code className="rounded bg-surface-container px-1 py-0.5 text-[11px]">
            {tr.commandText}
          </code>
        </p>
      ) : null}
      {tr.cwd ? (
        <p>
          <strong className="font-semibold text-on-surface">cwd:</strong> {tr.cwd}
        </p>
      ) : null}
      {tr.exitCode != null ? (
        <p>
          <strong className="font-semibold text-on-surface">Exit code:</strong> {tr.exitCode}
        </p>
      ) : null}
      {tr.inputText ? (
        <details className="mt-2">
          <summary className="cursor-pointer">Input (redacted at write time)</summary>
          <pre className="mt-1.5 overflow-auto text-[11px]">{tr.inputText}</pre>
        </details>
      ) : null}
      {tr.outputText ? (
        <details className="mt-2">
          <summary className="cursor-pointer">Output (redacted at write time)</summary>
          <pre className="mt-1.5 overflow-auto text-[11px]">{tr.outputText}</pre>
        </details>
      ) : null}
    </div>
  );
}
