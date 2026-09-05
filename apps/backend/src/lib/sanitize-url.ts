// Strips sensitive query parameters from a URL before it reaches logs —
// defense in depth so a caller-supplied `?token=`/`?apiKey=` never lands in
// long-term log retention (CloudWatch, Datadog).

import { SENSITIVE_QUERY_PARAMS } from "./sensitive-query-params.js";

export function sanitizeUrl(url: string): string {
  const queryStart = url.indexOf("?");
  if (queryStart < 0) return url;

  const path = url.slice(0, queryStart);
  const query = url.slice(queryStart + 1);
  if (!query) return url;

  const sanitized = query
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      const key = eq < 0 ? pair : pair.slice(0, eq);
      // Case-insensitive: the key comes from the caller, so `?API_KEY=` must
      // redact exactly like `?api_key=`.
      if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
        return `${key}=REDACTED`;
      }
      return pair;
    })
    .join("&");

  return sanitized ? `${path}?${sanitized}` : path;
}
