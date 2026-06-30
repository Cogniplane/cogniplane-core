// Strips sensitive query parameters from a URL before it reaches logs —
// defense in depth so a caller-supplied `?token=`/`?apiKey=` never lands in
// long-term log retention (CloudWatch, Datadog).

const SENSITIVE_QUERY_PARAMS = new Set(["token", "accessToken", "refreshToken", "apiKey", "api_key"]);

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
      if (SENSITIVE_QUERY_PARAMS.has(key)) {
        return `${key}=REDACTED`;
      }
      return pair;
    })
    .join("&");

  return sanitized ? `${path}?${sanitized}` : path;
}
