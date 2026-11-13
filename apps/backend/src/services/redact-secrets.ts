import { isSensitiveQueryParameterName } from "../lib/sensitive-query-params.js";

// Matches anywhere in the key (`accessToken`, `x-api-key`, `passwordHash`);
// what happens to a matched value depends on its type — see redactSecretValue.
const SECRET_KEY_PATTERN = /(authorization|token|secret|credential|api[_-]?key|password)/i;
const APP_PAGING_KEY_PATTERN = /^(?:pageToken|nextPageToken|previousPageToken|prevPageToken)$/i;
const isCredentialKey = (key: string) => SECRET_KEY_PATTERN.test(key) && !APP_PAGING_KEY_PATTERN.test(key);
const BEARER_TOKEN_PATTERN = /(\bBearer\s+)(?!\$\{)([^\s"',;]+)/gi;
const GITHUB_TOKEN_PATTERN =
  /\b(?:gh(?:o|u|s|r|p)_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g;

// PEM private-key blocks (RSA, EC, ED25519, PKCS#8, ...): from a BEGIN line to
// the first END line after it, so adjacent blocks stay separate. See
// redactPemBlocks.
const PEM_PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g;
const PEM_PRIVATE_KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

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
// A JWT starts with `eyJ` (base64url of `{"`) and has three dot-separated
// segments. Sticky: redactJwts tries it only at a possible start.
const JWT_AT = /eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/y;
const STRIPE_KEY_PATTERN = /\b(?:(?:sk|rk)_(?:live|test)|whsec)_[A-Za-z0-9]{16,}\b/g;
const GITLAB_TOKEN_PATTERN = /\bglpat-[A-Za-z0-9_-]{20,}\b/g;
const NPM_TOKEN_PATTERN = /\bnpm_[A-Za-z0-9]{20,}\b/g;
const TWILIO_API_KEY_PATTERN = /\bSK[0-9a-fA-F]{32}\b/g;
const TWILIO_SECRET_ASSIGNMENT_PATTERN =
  /(TWILIO_(?:AUTH_TOKEN|API_KEY_SECRET)\s*[:=]\s*["']?)[A-Za-z0-9]{20,}/gi;
const SENDGRID_KEY_PATTERN = /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{40,}\b/g;

// URL query parameters carrying tokens, so a `?token=`/`?api-key=` inside a
// string body (e.g. a tool result echoing a URL) is redacted before
// persistence. Stops at whitespace, `&`, quote, `;`, or `#` to preserve
// surrounding text. The name check is shared with sanitize-url.ts and
// url-validation.ts.
const URL_QUERY_PARAMETER_PATTERN = /([?&])([^=&\s"';#?]+)=(?!\$\{)([^\s&"';#]+)/g;
// The same parameter inside a value. Its value runs to the end of the outer
// value, so a lookahead checks that it is not empty and the pattern does not
// read it.
const NESTED_URL_QUERY_PARAMETER = /([?&])([^=&\s"';#?]+)=(?!\$\{)(?=[^\s&"';#])/;

// A non-credential value can hold a nested URL (`?next=https://x/?token=…`),
// so it is scanned again. A value has no `&`, and a nested value runs to the
// end of the outer value, so one scan of a value finds at most one nested
// parameter. The loop follows that chain. A recursive scan overflowed the
// stack at about 2,000 levels (`"?a=".repeat(2000)`), and a scan that read
// each nested value to its end took quadratic time.
function redactQueryParameter(_match: string, separator: string, name: string, value: string): string {
  let redacted = `${separator}${name}=`;
  for (;;) {
    if (isSensitiveQueryParameterName(name)) return `${redacted}REDACTED`;
    const nested = NESTED_URL_QUERY_PARAMETER.exec(value);
    if (!nested) return redacted + value;
    const valueStart = nested.index + nested[0].length;
    redacted += value.slice(0, valueStart);
    name = nested[2]!;
    value = value.slice(valueStart);
  }
}

// A global regex starts a new attempt at each position. When a failed attempt
// reads to the end of a long run and the run has many possible starts, the
// regex takes quadratic time. Each function below finds the same matches as
// the regex in its comment and reads each character a fixed number of times.

const isWordCode = (code: number) =>
  (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
const isJwtCode = (code: number) => isWordCode(code) || code === 45;

// Replaces /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g.
// That regex read to the end of the text from each BEGIN line without an END
// line. When no END line follows one BEGIN line, none follows a later one, so
// the search stops there.
function redactPemBlocks(value: string): string {
  let redacted = "";
  let copied = 0;
  PEM_PRIVATE_KEY_BEGIN.lastIndex = 0;
  for (let begin = PEM_PRIVATE_KEY_BEGIN.exec(value); begin; begin = PEM_PRIVATE_KEY_BEGIN.exec(value)) {
    PEM_PRIVATE_KEY_END.lastIndex = PEM_PRIVATE_KEY_BEGIN.lastIndex;
    if (!PEM_PRIVATE_KEY_END.exec(value)) break;
    redacted += `${value.slice(copied, begin.index)}[REDACTED]`;
    copied = PEM_PRIVATE_KEY_BEGIN.lastIndex = PEM_PRIVATE_KEY_END.lastIndex;
  }
  return copied === 0 ? value : redacted + value.slice(copied);
}

// Replaces /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g. That
// regex tried each `eyJ` in a run of token characters (`"eyJ-".repeat(n)`)
// and read the run to its end each time. All starts in one run reach the same
// dots, so they all match or all fail. After a failed start, skip the run.
function redactJwts(value: string): string {
  let redacted = "";
  let copied = 0;
  let start = value.indexOf("eyJ");
  while (start >= 0) {
    let next = start + 1;
    // `\b` before the `e`.
    if (!isWordCode(value.charCodeAt(start - 1))) {
      JWT_AT.lastIndex = start;
      if (JWT_AT.exec(value)) {
        redacted += `${value.slice(copied, start)}[REDACTED]`;
        copied = next = JWT_AT.lastIndex;
      } else {
        while (next < value.length && isJwtCode(value.charCodeAt(next))) next += 1;
      }
    }
    start = value.indexOf("eyJ", next);
  }
  return copied === 0 ? value : redacted + value.slice(copied);
}

// Live replay (lastSafeSplit in turn-event-log.ts) cuts held text between two
// non-ASCII characters. It expects that, apart from private keys, only the
// Bearer and URL query rules can match a non-ASCII character. Update it when a
// rule can.
function redactInlineSecrets(value: string): string {
  const beforeJwts = redactPemBlocks(value)
    .replace(BEARER_TOKEN_PATTERN, "$1[REDACTED]")
    .replace(GITHUB_TOKEN_PATTERN, "[REDACTED]")
    .replace(ANTHROPIC_KEY_PATTERN, "[REDACTED]")
    .replace(OPENAI_KEY_PATTERN, "[REDACTED]")
    .replace(AWS_ACCESS_KEY_PATTERN, "[REDACTED]")
    .replace(SLACK_TOKEN_PATTERN, "[REDACTED]")
    .replace(GOOGLE_API_KEY_PATTERN, "[REDACTED]")
    .replace(ZAI_API_KEY_PATTERN, "[REDACTED]")
    .replace(RUNTIME_TOKEN_PATTERN, "[REDACTED]");
  return redactJwts(beforeJwts)
    .replace(STRIPE_KEY_PATTERN, "[REDACTED]")
    .replace(GITLAB_TOKEN_PATTERN, "[REDACTED]")
    .replace(NPM_TOKEN_PATTERN, "[REDACTED]")
    .replace(TWILIO_API_KEY_PATTERN, "[REDACTED]")
    .replace(TWILIO_SECRET_ASSIGNMENT_PATTERN, "$1[REDACTED]")
    .replace(SENDGRID_KEY_PATTERN, "[REDACTED]")
    .replace(URL_QUERY_PARAMETER_PATTERN, redactQueryParameter);
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
  //
  // The credential context deliberately ends at a nested object: tool schemas
  // (`maxTokens: { type: "integer" }`) and telemetry share these key names,
  // so `{ secret: { value: "raw" } }` is not redacted by key. Pattern rules
  // and the gateway's upstream-secret scrub still apply to its strings.
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
    if (isCredentialKey(key)) {
      return [key, redactSecretValue(value)];
    }

    return [key, redactSecrets(value)];
  });

  return Object.fromEntries(entries) as T;
}

/** Redact credential strings in app data without changing object or array types. */
export function redactAppData<T>(input: T): T {
  const visit = (value: unknown, credential = false): unknown => {
    if (typeof value === "string") return credential ? "[REDACTED]" : redactInlineSecrets(value);
    if (Array.isArray(value)) return value.map((item) => visit(item, credential));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) =>
        [key, visit(item, credential || isCredentialKey(key))]
      ));
    }
    return value;
  };
  return visit(input) as T;
}
