import { MODEL_PROVIDERS, MODEL_PROVIDER_META } from "@cogniplane/shared-types";

import { isSensitiveQueryParameterName } from "../lib/sensitive-query-params.js";

// Matches anywhere in the key (`accessToken`, `x-api-key`, `passwordHash`);
// what happens to a matched value depends on its type — see redactSecretValue.
const SECRET_KEY_PATTERN = /(authorization|token|secret|credential|api[_-]?key|password)/i;
const APP_PAGING_KEY_PATTERN = /^(?:pageToken|nextPageToken|previousPageToken|prevPageToken)$/i;
const isCredentialKey = (key: string) => SECRET_KEY_PATTERN.test(key) && !APP_PAGING_KEY_PATTERN.test(key);
const BEARER_TOKEN_PATTERN = /(\bBearer\s+)(?!\$\{)([^\s"',;]+)/gi;
const BASIC_AUTH_PATTERN = /(\bauthorization[ \t]*:[ \t]*Basic[ \t]+)(?!\$\{)([^\s"',;]+)/gi;
// Match credential names, not all assignments or public-key settings.
const ENV_SECRET_NAME = /(?:^|_)(?:API_?KEY|SECRET|PASSWORD|PASSWD|TOKEN|CREDENTIALS?|PRIVATE_KEY|SECRET_ACCESS_KEY|API_KEY_SECRET|AUTHORIZATION)$/i;
const ENV_NAME_AT = /[A-Za-z_][A-Za-z0-9_]*/y;
const GITHUB_TOKEN_PATTERN =
  /\b(?:gh(?:o|u|s|r|p)_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g;

// PEM private-key blocks (RSA, EC, ED25519, PKCS#8, ...): from a BEGIN line to
// the first END line after it, so adjacent blocks stay separate. See
// redactPemBlocks.
const PEM_PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g;
const PEM_PRIVATE_KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

// Model provider API keys: the `keyPattern` of each MODEL_PROVIDER_META entry,
// in MODEL_PROVIDERS order (Anthropic `sk-ant-` before OpenAI `sk-`). The
// record type makes a new provider fail to compile until it has a pattern or
// an explicit null.
export const PROVIDER_KEY_PATTERNS: readonly RegExp[] = MODEL_PROVIDERS.flatMap((provider) => {
  const pattern = MODEL_PROVIDER_META[provider].keyPattern;
  return pattern ? [new RegExp(pattern.source, "g")] : [];
});
const AWS_ACCESS_KEY_PATTERN = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
const SLACK_TOKEN_PATTERN = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g;
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

type TextRange = { start: number; end: number };
const isHorizontalSpace = (char: string | undefined) => char === " " || char === "\t";

// Read an assignment once, including quoted newlines and escaped line breaks.
// An unmatched quote consumes the rest of the text instead of exposing it.
function assignmentEnd(value: string, start: number): number {
  let quote: string | undefined;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === "\\") {
      index += value[index + 1] === "\r" && value[index + 2] === "\n" ? 2 : 1;
    } else if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "\r" || char === "\n" || char === ";" || (char === "#" && (index === start || isHorizontalSpace(value[index - 1])))) {
      return index;
    }
  }
  return value.length;
}

function visitSecretAssignments(value: string, visit: (range: TextRange, lineStart: number) => void): void {
  let lineStart = 0;
  while (lineStart < value.length) {
    let index = lineStart;
    while (isHorizontalSpace(value[index])) index += 1;
    if (value.slice(index, index + 6).toLowerCase() === "export" && isHorizontalSpace(value[index + 6])) {
      index += 7;
      while (isHorizontalSpace(value[index])) index += 1;
    }
    ENV_NAME_AT.lastIndex = index;
    const name = ENV_NAME_AT.exec(value)?.[0];
    if (name && ENV_SECRET_NAME.test(name)) {
      index += name.length;
      while (isHorizontalSpace(value[index])) index += 1;
      if (value[index] === "=") {
        index += 1;
        while (isHorizontalSpace(value[index])) index += 1;
        let end = assignmentEnd(value, index);
        const nextLine = value.indexOf("\n", end);
        while (end > index && isHorizontalSpace(value[end - 1])) end -= 1;
        if (end > index) visit({ start: index, end }, lineStart);
        lineStart = nextLine < 0 ? value.length : nextLine + 1;
        continue;
      }
    }
    const newline = value.indexOf("\n", index);
    lineStart = newline < 0 ? value.length : newline + 1;
  }
}

const isSchemeCode = (code: number) => (isWordCode(code) && code !== 95) || code === 43 || code === 45 || code === 46;
const URL_AUTHORITY_END = /[\s/\\?#"'<>]/;

// Find literal :// separators, then scan each authority once. A global regex
// with a variable-length scheme can retry a long malformed scheme at every '-'.
function visitUrlAuthorities(value: string, visit: (range: TextRange, at: number, userinfoStart: number) => void): void {
  let separator = value.indexOf("://");
  while (separator >= 0) {
    let scheme = separator;
    while (scheme > 0 && isSchemeCode(value.charCodeAt(scheme - 1))) scheme -= 1;
    const start = separator + 3;
    let end = start;
    let at = -1;
    while (end < value.length && !URL_AUTHORITY_END.test(value[end]!)) {
      if (value[end] === "@") at = end;
      end += 1;
    }
    if (/[A-Za-z]/.test(value[scheme] ?? "") && !isWordCode(value.charCodeAt(scheme - 1))) {
      visit({ start: scheme, end }, at, start);
    }
    // Another separator can end this authority at its first slash. Include
    // it in the next pass, so malformed outer URLs cannot hide an inner URL.
    separator = value.indexOf("://", separator + 3);
  }
}

function redactAssignments(value: string): string {
  let result = "";
  let copied = 0;
  visitSecretAssignments(value, ({ start, end }) => {
    result += value.slice(copied, start) + "[REDACTED]";
    copied = end;
  });
  return copied === 0 ? value : result + value.slice(copied);
}

function redactUrlUserinfo(value: string): string {
  let result = "";
  let copied = 0;
  visitUrlAuthorities(value, (_range, at, start) => {
    if (at < start) return;
    result += value.slice(copied, start) + "[REDACTED]";
    copied = at;
  });
  return copied === 0 ? value : result + value.slice(copied);
}

/** Keep replay cuts outside assignments and URL authorities, even before '@' arrives. */
export function secretSafeTextCutoff(value: string, candidate: number): number {
  let cutoff = candidate;
  visitSecretAssignments(value, ({ end }, lineStart) => {
    if (lineStart < cutoff && cutoff < end) cutoff = lineStart;
  });
  visitUrlAuthorities(value, ({ start, end }) => {
    if (start < cutoff && cutoff < end) cutoff = start;
  });
  return cutoff;
}

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
// non-ASCII characters. Basic/Bearer values and query parameters are held by
// that scanner. Assignment and URL-authority cuts use secretSafeTextCutoff.
function redactInlineSecrets(value: string): string {
  let beforeJwts = redactAssignments(redactUrlUserinfo(redactPemBlocks(value)))
    .replace(BEARER_TOKEN_PATTERN, "$1[REDACTED]")
    .replace(BASIC_AUTH_PATTERN, "$1[REDACTED]")
    .replace(GITHUB_TOKEN_PATTERN, "[REDACTED]");
  for (const pattern of PROVIDER_KEY_PATTERNS) beforeJwts = beforeJwts.replace(pattern, "[REDACTED]");
  beforeJwts = beforeJwts
    .replace(AWS_ACCESS_KEY_PATTERN, "[REDACTED]")
    .replace(SLACK_TOKEN_PATTERN, "[REDACTED]")
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
