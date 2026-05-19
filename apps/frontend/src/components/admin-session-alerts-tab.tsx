"use client";

import { buildAlertItems } from "./admin-session-alerts-tab.logic";
import type {
  AdminSessionDetailApproval,
  AdminSessionDetailMessage,
  AdminSessionDetailPiiRun
} from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";

const PILL_BASE = "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium";
const PILL_RED = `${PILL_BASE} bg-danger-surface text-danger`;
const PILL_BLUE = `${PILL_BASE} bg-accent-soft text-accent`;
const PILL_GRAY = `${PILL_BASE} bg-surface-container text-on-surface-variant`;
const HINT = "text-sm text-on-surface-faint";
const LIST_ITEM = "rounded-lg border border-outline-variant bg-surface-container-lowest p-3";

const PILL_TONE: Record<"red" | "blue" | "gray", string> = {
  red: PILL_RED,
  blue: PILL_BLUE,
  gray: PILL_GRAY
};

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function jumpToMessage(messageId: string): void {
  const target = document.getElementById(`message-${messageId}`);
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
}

export function AdminSessionAlertsTab(props: {
  messages: AdminSessionDetailMessage[];
  approvals: AdminSessionDetailApproval[];
  piiRuns: AdminSessionDetailPiiRun[];
}) {
  const items = buildAlertItems(props);

  if (items.length === 0) {
    return <p className={HINT}>No alerts in this session.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {items.map((item) => (
        <div className={LIST_ITEM} key={item.id}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <strong className="text-sm font-semibold text-on-surface">{item.iconLabel}</strong>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={PILL_TONE[item.iconColor]}>{item.kind}</span>
              <span className="text-xs text-on-surface-faint">
                {formatTimestamp(item.timestamp)}
              </span>
            </div>
          </div>
          <p className="mt-1 text-sm text-on-surface-variant">{item.summary}</p>
          {item.jumpToMessageId ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="mt-2"
              onClick={() => jumpToMessage(item.jumpToMessageId as string)}
            >
              Jump to message
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
