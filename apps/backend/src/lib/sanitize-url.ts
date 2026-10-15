// Strips sensitive query parameters from a URL before it reaches logs —
// defense in depth so a caller-supplied `?token=`/`?apiKey=` never lands in
// long-term log retention (CloudWatch, Datadog).

import { isSensitiveQueryParameterName } from "./sensitive-query-params.js";

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
      if (isSensitiveQueryParameterName(key)) {
        return `${key}=REDACTED`;
      }
      return pair;
    })
    .join("&");

  return sanitized ? `${path}?${sanitized}` : path;
}
