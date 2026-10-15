/**
 * Links between the admin session list and a session's detail page. The detail
 * URL carries the list's query string in `from`, encoded once, so the detail
 * page's Back link can restore the same filters. Both directions live here so
 * the encoding on one side cannot drift from the decoding on the other.
 */

/** Detail page link that remembers `listQuery`, the list's own query string. */
export function sessionDetailHref(sessionId: string, listQuery: string): string {
  const path = `/admin/sessions/${encodeURIComponent(sessionId)}`;
  return listQuery ? `${path}?from=${encodeURIComponent(listQuery)}` : path;
}

/**
 * The list link for a detail page's Back link. `from` is the value that
 * searchParams.get("from") returned, which is already decoded once. Decoding
 * it again would turn an encoded "&", "+", "%", or "#" in a filter value into
 * query syntax.
 */
export function sessionListHref(from: string | null): string {
  return from ? `/admin/sessions?${from}` : "/admin/sessions";
}
