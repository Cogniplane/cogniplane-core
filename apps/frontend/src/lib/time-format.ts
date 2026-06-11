/**
 * Shared timestamp formatters. Two date+time display families exist on
 * purpose: `formatTimestamp` renders in the viewer's locale (admin tables,
 * session detail), while `formatMediumDateTime` renders a fixed en-US
 * medium/short stamp (integration-connection and scheduled-job status lines).
 */

/**
 * Locale-aware absolute timestamp. Returns `fallback` for nullish input and
 * the raw string for an unparseable date, so a malformed API response never
 * renders "Invalid Date".
 */
export function formatTimestamp(iso: string | null | undefined, fallback = "—"): string {
  if (!iso) return fallback;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

/**
 * Fixed en-US "May 9, 2026, 2:35 PM"-style stamp. Same null/invalid handling
 * as `formatTimestamp`, but the caller supplies the fallback copy (e.g.
 * "Not available", "Not scheduled yet").
 */
export function formatMediumDateTime(iso: string | null | undefined, fallback: string): string {
  if (!iso) return fallback;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

/** HH:MM stamp on chat bubbles (message list + timeline rows). */
export function formatMessageTimestamp(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(iso));
}
