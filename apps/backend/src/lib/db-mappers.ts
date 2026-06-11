/**
 * Row-mapper coercion helpers shared by the store layer. Postgres returns
 * timestamps as driver-dependent values; every store normalizes them to ISO
 * strings at the mapper boundary. Centralized so date-parsing semantics are
 * fixed in one place instead of ~74 hand-rolled call sites.
 */

export function isoTimestamp(value: unknown): string {
  return new Date(String(value)).toISOString();
}

export function isoTimestampOrNull(value: unknown): string | null {
  return value ? new Date(String(value)).toISOString() : null;
}
