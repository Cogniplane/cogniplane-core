"use client";

import { useId } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatCostUsd, formatTokenCount } from "./context-window-meter.logic";

// A compact ring + label showing how full the model's context window is, based
// on the most recent assistant turn's total token count, plus the session's
// running cost. Gracefully renders nothing until there's a real reading.
//
// The ring fills clockwise; it tints amber from 75% and red from 90% so the
// user sees compaction/limit pressure coming before it bites. The meter is a
// button: a click, a tap, Enter or Space opens the details, and Escape closes
// them and returns focus to the meter. The details state the numbers in text,
// so the tint is never the only signal.
export function ContextWindowMeter({
  usedTokens,
  contextWindow,
  costUsd
}: {
  usedTokens: number;
  contextWindow: number;
  costUsd: number;
}) {
  const headingId = useId();
  const hasContext = usedTokens > 0 && contextWindow > 0;
  const hasCost = costUsd > 0;
  if (!hasContext && !hasCost) return null;

  const fraction = hasContext ? Math.min(usedTokens / contextWindow, 1) : 0;
  const pct = Math.round(fraction * 100);

  const tone =
    fraction >= 0.9 ? "text-danger" : fraction >= 0.75 ? "text-warning" : "text-on-surface-faint";
  // Faint text is too light on the hover and open surface in dark mode
  // (3.9:1), so it takes the secondary text color there.
  const raised = tone === "text-on-surface-faint" ? "hover:text-on-surface-variant data-[state=open]:text-on-surface-variant" : "";

  // SVG ring geometry. r=7 → circumference ≈ 43.98.
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - fraction);

  const label = hasContext
    ? `Context window ${pct}% full · ${formatTokenCount(usedTokens)} of ${formatTokenCount(contextWindow)} tokens${hasCost ? ` · ${formatCostUsd(costUsd)} spent` : ""}`
    : `${formatCostUsd(costUsd)} spent this session`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium tabular-nums outline-none transition-[color,background-color,box-shadow] duration-150 hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:bg-accent motion-reduce:transition-none ${tone} ${raised}`}
        >
          {hasContext ? (
            <>
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
            </>
          ) : null}
          {hasCost ? (
            <span className={hasContext ? "text-on-surface-variant" : undefined}>
              {formatCostUsd(costUsd)}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label="Usage details" className="w-60 p-3 text-sm focus-visible:ring-[3px] focus-visible:ring-ring/50">
        {hasContext ? (
          <section aria-labelledby={headingId}>
            <h3 id={headingId} className="text-xs font-semibold text-on-surface-variant">Context window</h3>
            <dl className="mt-1.5 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 tabular-nums">
              <dt className="text-on-surface-variant">Used</dt>
              <dd className="text-right">{formatTokenCount(usedTokens)} tokens</dd>
              <dt className="text-on-surface-variant">Limit</dt>
              <dd className="text-right">{formatTokenCount(contextWindow)} tokens</dd>
              <dt className="font-semibold">Full</dt>
              <dd className={`text-right font-semibold ${fraction >= 0.75 ? tone : ""}`}>{pct}%</dd>
            </dl>
          </section>
        ) : null}
        {hasCost ? (
          <dl className={`grid grid-cols-[1fr_auto] gap-x-4 tabular-nums ${hasContext ? "mt-2 border-t border-outline-variant pt-2" : ""}`}>
            <dt className="font-semibold">Session cost</dt>
            <dd className="text-right font-semibold">{formatCostUsd(costUsd)}</dd>
          </dl>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
