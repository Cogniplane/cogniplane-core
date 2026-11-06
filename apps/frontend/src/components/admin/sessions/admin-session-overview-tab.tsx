"use client";

import type { AdminSessionDetailOverview } from "@cogniplane/shared-types";
import { SessionCopyButton } from "./session-copy-button";
import { formatTimestamp } from "../../../lib/time-format";
import { LIST_ITEM } from "../../../lib/ui-tokens";

function Field(props: { label: string; value: string | number | null }) {
  const display = props.value == null || props.value === "" ? "—" : String(props.value);
  const copyable = display !== "—";
  return (
    <div className={LIST_ITEM}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong className="text-sm font-semibold text-on-surface">{props.label}</strong>
        {copyable ? <SessionCopyButton value={display} label={`Copy ${props.label}`} /> : null}
      </div>
      <p className="mt-1 text-xs break-all text-on-surface-faint">{display}</p>
    </div>
  );
}

export function AdminSessionOverviewTab(props: { overview: AdminSessionDetailOverview }) {
  const { overview } = props;
  const userValue = overview.userEmail
    ? `${overview.userEmail} (${overview.userId})`
    : overview.userId;
  const cost = overview.totalCostUsd > 0 ? `$${overview.totalCostUsd.toFixed(4)}` : "—";
  const tokens = overview.totalTokens > 0 ? overview.totalTokens.toLocaleString() : "—";

  return (
    <div className="flex flex-col gap-2">
      <Field label="User" value={userValue} />
      <Field label="Tenant ID" value={overview.tenantId} />
      <Field label="Session ID" value={overview.sessionId} />
      <Field label="Session name" value={overview.sessionName || "—"} />
      <Field label="Status" value={overview.status} />
      <Field label="Started" value={formatTimestamp(overview.createdAt)} />
      <Field label="Last activity" value={formatTimestamp(overview.lastActivityAt)} />
      <Field label="Message count" value={overview.messageCount} />
      <Field label="Total cost" value={cost} />
      <Field label="Total tokens" value={tokens} />
    </div>
  );
}
