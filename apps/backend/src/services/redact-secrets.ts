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

// URL query parameters carrying tokens. Mirrors sanitize-url.ts so that
// `?token=rt_...` inside a string body (e.g. a tool-result echoing the MCP
// URL) is redacted before persistence. Stops at whitespace, `&`, quote, `;`,
// or `#` to preserve surrounding text. Key set matches sanitize-url.ts.
const URL_QUERY_SECRET_PATTERN =
  /([?&])(token|accessToken|refreshToken|apiKey|api_key)=[^\s&"';#]+/gi;

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
    .replace(URL_QUERY_SECRET_PATTERN, "$1$2=REDACTED");
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

  const entries = Object.entries(input as Record<string, unknown>).map(([key, value]) => {
    if (SECRET_KEY_PATTERN.test(key)) {
      return [key, redactSecretValue(value)];
    }

    return [key, redactSecrets(value)];
  });

  return Object.fromEntries(entries) as T;
}
