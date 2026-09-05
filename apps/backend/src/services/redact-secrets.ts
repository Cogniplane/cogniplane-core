import { SENSITIVE_QUERY_PARAM_PATTERN } from "../lib/sensitive-query-params.js";

// Matches anywhere in the key (`accessToken`, `x-api-key`, `passwordHash`);
// what happens to a matched value depends on its type — see redactSecretValue.
const SECRET_KEY_PATTERN = /(authorization|token|secret|api[_-]?key|password)/i;
const BEARER_TOKEN_PATTERN = /(\bBearer\s+)([^\s"',;]+)/gi;
const GITHUB_TOKEN_PATTERN =
  /\b(?:gh(?:o|u|s|r|p)_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g;

// PEM private-key blocks (RSA, EC, ED25519, PKCS#8, ...). Multiline; lazy
// match so adjacent blocks aren't merged.
const PEM_PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

// Provider API keys. Anthropic must precede OpenAI because `sk-ant-...` also
// satisfies the OpenAI prefix.
const ANTHROPIC_KEY_PATTERN = /\bsk-ant-[A-Za-z0-9_-]{20,}/g;
const OPENAI_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{20,}/g;
const AWS_ACCESS_KEY_PATTERN = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
const SLACK_TOKEN_PATTERN = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g;
const GOOGLE_API_KEY_PATTERN = /\bAIza[0-9A-Za-z_-]{35}\b/g;
// Z.AI (Zhipu / GLM) keys: a hex key-id, a dot, then an alphanumeric secret
// (e.g. `1a2b...def.AbCd1234EfGh5678`). No distinctive prefix, so anchor on the
// `{hex}.{alnum}` shape with a long-enough id to avoid matching ordinary text.
const ZAI_API_KEY_PATTERN = /\b[0-9a-f]{20,}\.[A-Za-z0-9]{12,}\b/g;
const RUNTIME_TOKEN_PATTERN = /\brt_[A-Za-z0-9._-]+\b/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const STRIPE_KEY_PATTERN = /\b(?:(?:sk|rk)_(?:live|test)|whsec)_[A-Za-z0-9]{16,}\b/g;
const GITLAB_TOKEN_PATTERN = /\bglpat-[A-Za-z0-9_-]{20,}\b/g;
const NPM_TOKEN_PATTERN = /\bnpm_[A-Za-z0-9]{20,}\b/g;
const TWILIO_API_KEY_PATTERN = /\bSK[0-9a-fA-F]{32}\b/g;
const TWILIO_SECRET_ASSIGNMENT_PATTERN =
  /(TWILIO_(?:AUTH_TOKEN|API_KEY_SECRET)\s*[:=]\s*["']?)[A-Za-z0-9]{20,}/gi;
const SENDGRID_KEY_PATTERN = /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{40,}\b/g;

// URL query parameters carrying tokens, so a `?token=`/`?apiKey=` inside a
// string body (e.g. a tool result echoing a URL) is redacted before
// persistence. Stops at whitespace, `&`, quote, `;`, or `#` to preserve
// surrounding text. The key list is shared with sanitize-url.ts — the two
// copies used to drift.
const URL_QUERY_SECRET_PATTERN = new RegExp(
  `([?&])(${SENSITIVE_QUERY_PARAM_PATTERN})=[^\\s&"';#]+`,
  "gi"
);

function redactInlineSecrets(value: string): string {
  return value
    .replace(PEM_PRIVATE_KEY_PATTERN, "[REDACTED]")
    .replace(BEARER_TOKEN_PATTERN, "$1[REDACTED]")
    .replace(GITHUB_TOKEN_PATTERN, "[REDACTED]")
    .replace(ANTHROPIC_KEY_PATTERN, "[REDACTED]")
    .replace(OPENAI_KEY_PATTERN, "[REDACTED]")
    .replace(AWS_ACCESS_KEY_PATTERN, "[REDACTED]")
    .replace(SLACK_TOKEN_PATTERN, "[REDACTED]")
    .replace(GOOGLE_API_KEY_PATTERN, "[REDACTED]")
    .replace(ZAI_API_KEY_PATTERN, "[REDACTED]")
    .replace(RUNTIME_TOKEN_PATTERN, "[REDACTED]")
    .replace(JWT_PATTERN, "[REDACTED]")
    .replace(STRIPE_KEY_PATTERN, "[REDACTED]")
    .replace(GITLAB_TOKEN_PATTERN, "[REDACTED]")
    .replace(NPM_TOKEN_PATTERN, "[REDACTED]")
    .replace(TWILIO_API_KEY_PATTERN, "[REDACTED]")
    .replace(TWILIO_SECRET_ASSIGNMENT_PATTERN, "$1[REDACTED]")
    .replace(SENDGRID_KEY_PATTERN, "[REDACTED]")
    .replace(URL_QUERY_SECRET_PATTERN, "$1$2=REDACTED");
}

/**
 * Values handed back AS-IS instead of being walked, because walking them with
 * `Object.entries` would yield `{}` and silently destroy them.
 *
 * Deliberately just `Date` and `RegExp`, and deliberately conditional on the
 * instance carrying no own enumerable keys:
 *
 * - Type alone is NOT sufficient to skip redaction. Any of these can carry
 *   arbitrary expando properties — `Object.assign(/x/, { apiKey: "..." })`
 *   JSON-serializes as `{"apiKey":"..."}`. So an instance with own enumerable
 *   keys is NOT opaque; it falls through to the walk and gets redacted (losing
 *   its Date/RegExp identity, which is the correct trade at a security
 *   boundary). `Object.keys` is free for these two — a normal Date or RegExp has
 *   zero own enumerable keys.
 *
 * - Byte views (TypedArray/Buffer/DataView) and ArrayBuffer are NOT listed, even
 *   though walking them produces a bloated index→byte map. Detecting an expando
 *   on those means separating custom keys from the intrinsic numeric indices,
 *   and every way of doing that materializes one string per byte — an O(size)
 *   cost on a path that runs per tool call. They are also unreachable here in
 *   practice: every current caller feeds this JSON-parsed data (gateway tool
 *   results, tool args, UI resources), which never contains a Buffer. Lossy is
 *   an acceptable outcome for a value that does not occur; leaking is not.
 *
 * Everything else — class instances, Map, Set, unrecognized host objects — also
 * falls through to the walk. The failure mode of this function has to be
 * "lossy", never "leaks".
 */
function isOpaqueBuiltin(value: object): boolean {
  if (!(value instanceof Date) && !(value instanceof RegExp)) {
    return false;
  }
  // An expando makes it walkable — and therefore something we must walk.
  return Object.keys(value).length === 0;
}

function redactSecretValue(value: unknown): unknown {
  if (value == null) {
    return value;
  }

  // Credentials are strings (or lists of them); blank both. Numbers/booleans
  // under a secret-looking key are token counts and limits, not secrets —
  // keep them. Plain objects recurse so telemetry like
  // `tokenUsage: { inputTokens: 12 }` survives while a composite under e.g.
  // `credentials` still has its inner secret-keyed strings redacted.
  if (typeof value === "string" || Array.isArray(value)) {
    return "[REDACTED]";
  }
  if (typeof value === "object") {
    return redactSecrets(value);
  }
  return value;
}

export function redactSecrets<T>(input: T): T {
  if (input == null) {
    return input;
  }

  if (typeof input === "string") {
    return redactInlineSecrets(input) as T;
  }

  if (Array.isArray(input)) {
    return input.map((value) => redactSecrets(value)) as T;
  }

  if (typeof input !== "object") {
    return input;
  }

  // A bare Date/RegExp would be rebuilt as `{}` by the Object.entries round-trip
  // below — hand those back untouched. Strict allowlist, and strictly limited to
  // instances with nothing enumerable on them: a class instance, or a Date with
  // an `apiKey` expando, is NOT opaque and must still be walked. See
  // isOpaqueBuiltin.
  if (isOpaqueBuiltin(input as object)) {
    return input;
  }

  const entries = Object.entries(input as Record<string, unknown>).map(([key, value]) => {
    if (SECRET_KEY_PATTERN.test(key)) {
      return [key, redactSecretValue(value)];
    }

    return [key, redactSecrets(value)];
  });

  return Object.fromEntries(entries) as T;
}
