/**
 * Row-mapper coercion helpers shared by the store layer. Postgres returns
 * timestamps as driver-dependent values. The stores convert them to ISO
 * strings here, so the date parsing stays the same in every store.
 */

/**
 * SQL that formats the timestamp expression as UTC ISO text with six fraction
 * digits. A JS Date keeps only milliseconds. Paging cursors and exact bounds
 * use this text instead of a Date.
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
