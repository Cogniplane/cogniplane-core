"use client";

import { ChevronDownIcon } from "lucide-react";

import { SafeMarkdown } from "../safe-markdown";
import type { PlanRow } from "./chat-cards.types";

export function PlanRowView({ row }: { row: PlanRow }) {
  return (
    <details open className="group rounded-md bg-info-surface p-3">
      <summary className="flex cursor-pointer items-center gap-2 rounded-sm text-sm font-medium text-info outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <ChevronDownIcon aria-hidden="true" className="size-3.5 -rotate-90 transition-transform group-open:rotate-0 motion-reduce:transition-none" />
        <span>Plan</span>
      </summary>
      <div className="mt-2 min-w-0 text-sm text-on-surface">
        <SafeMarkdown>{row.text}</SafeMarkdown>
      </div>
    </details>
  );
}
