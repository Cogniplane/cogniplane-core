"use client";

import type { AdminSessionAlert, AdminSessionAlertKind } from "@cogniplane/shared-types";
import { PILL_BASE } from "../../../lib/ui-tokens";

type BadgeMeta = {
  label: string;
  color: "red" | "blue" | "gray";
  tooltip: string;
};

export const ALERT_BADGE_META: Record<AdminSessionAlertKind, BadgeMeta> = {
  "pii-blocked": {
    label: "PII blocked",
    color: "red",
    tooltip: "PII detection blocked content from being processed."
  },
  "pii-transformed": {
    label: "PII transformed",
    color: "blue",
    tooltip: "PII detection masked or rewrote content before processing."
  },
  "pii-detected": {
    label: "PII detected",
    color: "gray",
    tooltip: "PII detection completed and surfaced findings without modifying content."
  },
  "approval-rejected": {
    label: "Approval rejected",
    color: "red",
    tooltip: "An approval request was rejected during this session."
  },
  "approval-pending": {
    label: "Approval pending",
    color: "blue",
    tooltip: "An approval request is still awaiting a decision."
  },
  errored: {
    label: "Errored",
    color: "red",
    tooltip: "One or more messages in this session ended in an error state."
  }
};

const PILL_TONE: Record<BadgeMeta["color"], string> = {
  red: `${PILL_BASE} bg-danger-surface text-danger`,
  blue: `${PILL_BASE} bg-accent-soft text-accent`,
  gray: `${PILL_BASE} bg-surface-container text-on-surface-variant`
};

export function AdminSessionAlertBadge(props: { alert: AdminSessionAlert }) {
  const meta = ALERT_BADGE_META[props.alert.kind];
  const text = props.alert.count > 1 ? `${meta.label} × ${props.alert.count}` : meta.label;
  return (
    <span className={PILL_TONE[meta.color]} title={meta.tooltip}>
      {text}
    </span>
  );
}
