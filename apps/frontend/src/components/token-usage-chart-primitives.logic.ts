/**
 * Pure helpers for the inline token-usage charts. Kept separate from the
 * SVG components so geometry decisions (bar widths, tick stops, label
 * shortening) are testable without rendering.
 */

export const DAY_OPTIONS = [7, 14, 30, 90] as const;
export type Days = (typeof DAY_OPTIONS)[number];

/**
 * Compact token count: e.g. 1_500 → "1.5k", 2_750_000 → "2.75M".
 *
 * Tokens are emitted at small magnitudes too (a single message is hundreds
 * of tokens), so the threshold for kilo-formatting is 1k. Uses two decimals
 * for millions to avoid silent precision loss on big-spend tenants.
 */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Compact USD cost. Special-cases tiny costs to keep five decimals (so
 * sub-cent amounts don't render as "$0.0000") and uses four decimals
 * elsewhere to match the dashboard's existing precision.
 */
export function fmtCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(5)}`;
  return `$${usd.toFixed(4)}`;
}

/**
 * Compact integer formatter for SVG y-axis labels. One-decimal kilos to
 * keep the axis numbers narrow; full integers below 1k.
 */
export function fmtAxisShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

/**
 * Friendly bar label. Recognizes ISO dates (YYYY-MM-DD) and renders them
 * as "Mon DD"; otherwise truncates to the trailing 8 chars.
 */
export function formatBarLabel(label: string): string {
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(label);
  if (isoMatch) {
    const [, , month, day] = isoMatch;
    const monthNames = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec"
    ];
    const idx = parseInt(month, 10) - 1;
    if (idx >= 0 && idx < 12) {
      return `${monthNames[idx]} ${day}`;
    }
  }
  return label.length > 8 ? label.slice(-8) : label;
}
