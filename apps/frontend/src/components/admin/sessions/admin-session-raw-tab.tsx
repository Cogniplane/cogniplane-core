"use client";

import { useMemo, useState } from "react";

import type { AdminSessionDetailMessage } from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";
import { formatTimestamp } from "../../../lib/time-format";
import { PILL_GRAY, HINT, LIST_ITEM } from "../../../lib/ui-tokens";

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 10)}…` : id;
}

export function AdminSessionRawTab(props: { messages: AdminSessionDetailMessage[] }) {
  const [copied, setCopied] = useState(false);

  const allJson = useMemo(
    () =>
      JSON.stringify(
        props.messages.map((m) => ({
          messageId: m.messageId,
          role: m.role,
          status: m.status,
          createdAt: m.createdAt,
          detailJson: m.detailJson
        })),
        null,
        2
      ),
    [props.messages]
  );

  const handleCopyAll = () => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(allJson).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    }
  };

  if (props.messages.length === 0) {
    return <p className={HINT}>No messages in this session.</p>;
  }

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={handleCopyAll}>
          {copied ? "Copied" : "Copy all"}
        </Button>
        <span className={PILL_GRAY}>
          {props.messages.length} message{props.messages.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        {props.messages.map((message) => (
          <details key={message.messageId} className={LIST_ITEM}>
            <summary className="cursor-pointer list-revert">
              <div className="inline-block w-[calc(100%-24px)] align-top">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong className="text-sm font-semibold text-on-surface">{message.role}</strong>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className={PILL_GRAY}>{message.status}</span>
                    <span className="text-xs text-on-surface-faint">
                      {shortId(message.messageId)}
                    </span>
                  </div>
                </div>
                <p className="mt-1 text-xs text-on-surface-faint">
                  {formatTimestamp(message.createdAt)}
                </p>
              </div>
            </summary>
            <pre className="mt-2 overflow-auto text-[11px]">
              {JSON.stringify(message.detailJson ?? null, null, 2)}
            </pre>
          </details>
        ))}
      </div>
    </>
  );
}
