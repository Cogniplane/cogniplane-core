// Query-parameter names that may carry a credential. Single source of truth for
// both log sanitization (sanitize-url.ts) and persistence redaction
// (services/redact-secrets.ts) — the two lists used to drift apart.
//
// Lowercase entries only: both consumers match case-insensitively, because a
// caller controls the casing (`?API_KEY=`) and a case-sensitive match would
// pass it straight through.
export const SENSITIVE_QUERY_PARAMS: ReadonlySet<string> = new Set([
  "token",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "idtoken",
  "id_token",
  "apikey",
  "api_key",
  "clientsecret",
  "client_secret",
  "password",
  "sig"
]);

// Alternation for the same names, for regex-based redaction of URLs embedded in
// text. Derived from the set so the two can never diverge.
export const SENSITIVE_QUERY_PARAM_PATTERN = [...SENSITIVE_QUERY_PARAMS].join("|");
