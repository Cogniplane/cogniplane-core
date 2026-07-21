"use client";

import { ChevronDownIcon } from "lucide-react";

import { SafeMarkdown } from "../safe-markdown";
import type { PlanRow } from "./chat-cards.types";

export function PlanRowView({ row }: { row: PlanRow }) {
  return (
    <details open className="group rounded-md border border-accent/20 bg-accent-soft p-3">
      <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium text-accent outline-none">
        <ChevronDownIcon className="size-3 -rotate-90 transition-transform group-open:rotate-0" />
        <span>Plan</span>
      </summary>
      <div className="mt-2 prose prose-sm max-w-none">
        <SafeMarkdown>{row.text}</SafeMarkdown>
      </div>
    </details>
  );
}
