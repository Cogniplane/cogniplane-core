"use client";

import { useMemo, useState } from "react";

import type { AdminSessionDetailAuditEvent } from "@cogniplane/shared-types";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatTimestamp } from "../../../lib/time-format";
import { PILL_GRAY, HINT, LIST_ITEM } from "../../../lib/ui-tokens";

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function AdminSessionAuditTab(props: { auditEvents: AdminSessionDetailAuditEvent[] }) {
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return props.auditEvents;
    return props.auditEvents.filter((evt) => evt.eventType.toLowerCase().includes(q));
  }, [filter, props.auditEvents]);

  if (props.auditEvents.length === 0) {
    return <p className={HINT}>No audit events for this session.</p>;
  }

  return (
    <>
      <div className="mb-3 flex flex-col gap-1.5">
        <Label htmlFor="audit-filter">Filter by event type</Label>
        <Input
          id="audit-filter"
          type="text"
          placeholder="e.g. approval"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {filtered.length === 0 ? (
        <p className={HINT}>No events match this filter.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map((evt, idx) => (
            <details
              key={`${evt.createdAt}-${evt.eventType}-${idx}`}
              className={LIST_ITEM}
            >
              <summary className="cursor-pointer list-revert">
                <div className="inline-block w-[calc(100%-24px)] align-top">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <strong className="text-sm font-semibold text-on-surface">
                      {evt.eventType}
                    </strong>
                    {evt.ipAddress ? <span className={PILL_GRAY}>{evt.ipAddress}</span> : null}
                  </div>
                  <p className="mt-1 text-xs text-on-surface-faint">
                    {formatTimestamp(evt.createdAt)} · user {evt.userId}
                    {evt.approvalId ? ` · approval ${evt.approvalId}` : ""}
                  </p>
                  {evt.userAgent ? (
                    <p className="text-xs text-on-surface-faint">
                      UA: {truncate(evt.userAgent, 60)}
                    </p>
                  ) : null}
                </div>
              </summary>
              <div className="mt-2 text-xs text-on-surface-variant">
                {evt.userAgent ? (
                  <p className="break-all">
                    <strong className="font-semibold text-on-surface">User agent:</strong>{" "}
                    {evt.userAgent}
                  </p>
                ) : null}
                {evt.approvalId ? (
                  <p>
                    <strong className="font-semibold text-on-surface">Approval ID:</strong>{" "}
                    {evt.approvalId}
                  </p>
                ) : null}
                <details className="mt-2" open>
                  <summary className="cursor-pointer">Payload</summary>
                  <pre className="mt-1.5 overflow-auto text-[11px]">
                    {JSON.stringify(evt.payload ?? null, null, 2)}
                  </pre>
                </details>
              </div>
            </details>
          ))}
        </div>
      )}
    </>
  );
}
