"use client";

import { formatTokenCount } from "./message-list.logic";

// A compact ring + label showing how full the model's context window is, based
// on the most recent assistant turn's total token count. Inspired by t3code's
// ContextWindowMeter. Gracefully renders nothing until there's a real reading.
//
// The ring fills clockwise; it tints amber past 75% and red past 90% so the
// user sees compaction/limit pressure coming before it bites.
export function ContextWindowMeter({
  usedTokens,
  contextWindow
}: {
  usedTokens: number;
  contextWindow: number;
}) {
  if (usedTokens <= 0 || contextWindow <= 0) return null;

  const fraction = Math.min(usedTokens / contextWindow, 1);
  const pct = Math.round(fraction * 100);

  const tone =
    fraction >= 0.9 ? "text-danger" : fraction >= 0.75 ? "text-warning" : "text-on-surface-faint";

  // SVG ring geometry. r=7 → circumference ≈ 43.98.
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - fraction);

  return (
    <span
      className={`group relative inline-flex cursor-default items-center gap-1.5 text-[0.7rem] font-medium ${tone}`}
      aria-label={`Context window ${pct}% full · ${formatTokenCount(usedTokens)} of ${formatTokenCount(contextWindow)} tokens`}
    >
      <svg viewBox="0 0 18 18" className="size-4 -rotate-90" aria-hidden="true">
        <circle
          cx="9"
          cy="9"
          r={radius}
          fill="none"
          strokeWidth="2"
          className="stroke-outline-variant"
        />
        <circle
          cx="9"
          cy="9"
          r={radius}
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          stroke="currentColor"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
        />
      </svg>
      <span>{pct}%</span>
      <span
        role="tooltip"
        className="invisible absolute bottom-full left-0 z-10 mb-1 flex w-52 flex-col gap-1 rounded-md border border-outline-variant bg-popover p-3 text-xs text-popover-foreground opacity-0 shadow-lg transition-opacity group-hover:visible group-hover:opacity-100"
      >
        <span className="text-[0.62rem] font-bold uppercase tracking-wider text-on-surface-faint">
          Context window
        </span>
        <span className="flex justify-between">
          <span>Used</span>
          <span>{formatTokenCount(usedTokens)}</span>
        </span>
        <span className="flex justify-between">
          <span>Limit</span>
          <span>{formatTokenCount(contextWindow)}</span>
        </span>
        <span className="flex justify-between border-t border-outline-variant pt-1 font-semibold">
          <span>Full</span>
          <span>{pct}%</span>
        </span>
      </span>
    </span>
  );
}
