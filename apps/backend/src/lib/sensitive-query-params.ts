// Query-parameter names that may carry a credential. One module for both uses:
//
// - isCredentialQueryParameterName: MCP URL validation refuses these names
//   (url-validation.ts) and the legacy query-auth migration moves them out of
//   stored URLs. Keep it stable: a wider check would refuse URLs that tenants
//   already saved.
// - isSensitiveQueryParameterName: log sanitization (sanitize-url.ts) and
//   persistence redaction (services/redact-secrets.ts). It covers every name
//   that validation refuses, plus older whole names, and it decodes the name
//   first. The lists used to drift apart.
//
// Both checks are case-insensitive: a caller controls the casing (`?API_KEY=`),
// and a case-sensitive match would pass it straight through.

// A credential word as its own segment: `key`, `api-key`, `x_api_key`,
// `refresh_token`, `sig`, `signature`, `auth`, ...
const CREDENTIAL_QUERY_NAME =
  /(?:^|[^a-z0-9])(?:api[-_]?key|access[-_]?token|auth(?:orization)?|bearer|client[-_]?secret|key|password|secret|sig(?:nature)?|token)(?=$|[^a-z0-9])/i;

// Whole names whose credential word is not separated from a prefix, so the
// segment pattern cannot see it.
const SENSITIVE_QUERY_NAMES: ReadonlySet<string> = new Set([
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apikey",
  "clientsecret"
]);

export function isCredentialQueryParameterName(name: string): boolean {
  return CREDENTIAL_QUERY_NAME.test(name);
}

function decodeQueryName(name: string): string {
  try {
    return decodeURIComponent(name.replace(/\+/g, " "));
  } catch {
    return name;
  }
}

export function isSensitiveQueryParameterName(name: string): boolean {
  return [name, decodeQueryName(name)].some((candidate) =>
    SENSITIVE_QUERY_NAMES.has(candidate.toLowerCase()) || CREDENTIAL_QUERY_NAME.test(candidate)
  );
}
