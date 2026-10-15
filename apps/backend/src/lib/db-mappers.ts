/**
 * Row-mapper coercion helpers shared by the store layer. Postgres returns
 * timestamps as driver-dependent values; every store normalizes them to ISO
 * strings at the mapper boundary. Centralized so date-parsing semantics are
 * fixed in one place instead of ~74 hand-rolled call sites.
 */

/**
 * SQL that formats a timestamp expression as UTC ISO text with six fraction
 * digits. A JS Date keeps milliseconds only, so paging cursors and exact
 * bounds select this text instead of the Date.
 */
export function utcMicrosText(expression: string): string {
  return `to_char(${expression} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

export function isoTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" || typeof value === "number") {
    return new Date(value).toISOString();
  }
  throw new TypeError("Expected a Date, timestamp string, or epoch milliseconds");
}

export function isoTimestampOrNull(value: unknown): string | null {
  return value == null ? null : isoTimestamp(value);
}
