import { test, expect } from "vitest";
import { MODEL_PROVIDER_META, MODEL_PROVIDERS, type ModelProvider } from "@cogniplane/shared-types";

import { isSensitiveQueryParameterName } from "../lib/sensitive-query-params.js";
import { randomText, runIsolated, seededRandom } from "../test-helpers/isolated-timing.js";
import { PROVIDER_KEY_PATTERNS, redactAppData, redactSecrets } from "./redact-secrets.js";

test("redaction preserves app data types and removes nested credentials", () => {
  expect(redactAppData({ tokenLimits: [100, 200], token: "abc", idToken: "def",
    "x-api-key": "ghi", credentials: { sessionToken: "jkl" } })).toEqual({
    tokenLimits: [100, 200], token: "[REDACTED]", idToken: "[REDACTED]",
    "x-api-key": "[REDACTED]", credentials: { sessionToken: "[REDACTED]" }
  });
});

test("app paging cursors survive while credential fields stay redacted", () => {
  expect(redactAppData({ pageToken: "cursor-1", nextPageToken: "cursor-2", credentials: {
    sessionToken: "secret", nextPageToken: "nested-secret"
  } })).toEqual({ pageToken: "cursor-1", nextPageToken: "cursor-2", credentials: {
    sessionToken: "[REDACTED]", nextPageToken: "[REDACTED]"
  } });
  expect(redactSecrets({ pageToken: "cursor-1", nextPageToken: "cursor-2", token: "secret" }))
    .toEqual({ pageToken: "cursor-1", nextPageToken: "cursor-2", token: "[REDACTED]" });
});

test("redaction keeps JavaScript template placeholders intact", () => {
  const source = 'const header = `Bearer ${token}`; const url = `?token=${t}&sig=${s}`;';
  expect(redactSecrets(source)).toBe(source);
  expect(redactSecrets("Bearer actual-token ?token=actual-value")).toBe(
    "Bearer [REDACTED] ?token=REDACTED"
  );
});

test("redactSecrets redacts known secret-bearing fields and preserves non-sensitive strings", () => {
  const result = redactSecrets({
    command: "curl https://example.com",
    headers: {
      authorization: "Bearer top-secret-token",
      "x-trace-id": "trace-123"
    },
    nested: [
      {
        apiKey: "secret-api-key"
      },
      {
        note: "keep this visible"
      }
    ]
  });

  expect(result).toEqual({
        command: "curl https://example.com",
        headers: {
          authorization: "[REDACTED]",
          "x-trace-id": "trace-123"
        },
        nested: [
          {
            apiKey: "[REDACTED]"
          },
          {
            note: "keep this visible"
          }
        ]
      });
});

test("redactSecrets blanks secret-keyed strings (including composite names) but preserves numeric telemetry", () => {
  const result = redactSecrets({
    accessToken: "abc",
    refresh_token: "def",
    "x-api-key": "ghi",
    clientSecret: "jkl",
    dbPassword: "mno",
    // Composite names where the secret word is NOT the final segment must
    // still be blanked — these are real credential shapes.
    secretAccessKey: "aws-secret",
    passwordHash: "$2b$10$hash",
    tokenValue: "rt_value",
    tokens: ["rt_1", "rt_2"],
    // Numeric/object telemetry under token-ish keys must survive.
    tokenUsage: { inputTokens: 12, outputTokens: 34 },
    maxTokens: 4096,
    tokenCount: 7
  });

  expect(result).toEqual({
    accessToken: "[REDACTED]",
    refresh_token: "[REDACTED]",
    "x-api-key": "[REDACTED]",
    clientSecret: "[REDACTED]",
    dbPassword: "[REDACTED]",
    secretAccessKey: "[REDACTED]",
    passwordHash: "[REDACTED]",
    tokenValue: "[REDACTED]",
    tokens: "[REDACTED]",
    tokenUsage: { inputTokens: 12, outputTokens: 34 },
    maxTokens: 4096,
    tokenCount: 7
  });
});

test("redactSecrets redacts inline bearer tokens without blanking the surrounding text", () => {
  const result = redactSecrets(
    "curl -H 'Authorization: Bearer top-secret-token' https://example.com"
  );

  expect(result).toBe("curl -H 'Authorization: Bearer [REDACTED]' https://example.com");
});

test.each([
  ["Authorization: Basic dXNlcjpwYXNz", "Authorization: Basic [REDACTED]"],
  ["aUtHoRiZaTiOn \t: bAsIc\tdXNlcjpwYXNz==", "aUtHoRiZaTiOn \t: bAsIc\t[REDACTED]"],
  ["Proxy-Authorization: Basic malformed%%%", "Proxy-Authorization: Basic [REDACTED]"],
  ["curl -H 'Authorization: Basic dXNlcjpwYXNz' https://example.com", "curl -H 'Authorization: Basic [REDACTED]' https://example.com"]
])("redacts Basic authorization in %s", (source, expected) => {
  expect(redactSecrets(source)).toBe(expected);
  expect(redactSecrets(expected)).toBe(expected);
});

test.each([
  ["https://user:password@example.test/path?q=ok#keep", "https://[REDACTED]@example.test/path?q=ok#keep"],
  ["POSTGRESQL://us%40er:p%2Fass%3Aword@db.test:5432/db", "POSTGRESQL://[REDACTED]@db.test:5432/db"],
  ["redis+tls://:password@[::1]:6379/0", "redis+tls://[REDACTED]@[::1]:6379/0"],
  ["ssh://user:pw@host.test/repo", "ssh://[REDACTED]@host.test/repo"],
  ["git+ssh://git:pw@github.com/o/r.git", "git+ssh://[REDACTED]@github.com/o/r.git"],
  ["ssh://first@second:pw@host.test", "ssh://[REDACTED]@host.test"],
  ["https://token@host.test/repo", "https://[REDACTED]@host.test/repo"],
  ["sshx://git@host.test/repo", "sshx://[REDACTED]@host.test/repo"],
  ["xssh://git@host.test/repo", "xssh://[REDACTED]@host.test/repo"],
  ["https://user:bad%zz@host.test", "https://[REDACTED]@host.test"],
  ["https://first@second:pass@host.test", "https://[REDACTED]@host.test"],
  ['URL="https://user:pass@host.test"', 'URL="https://[REDACTED]@host.test"'],
  ["https://outer.test/?next=https://u:p@inner.test/", "https://outer.test/?next=https://[REDACTED]@inner.test/"],
  ["https://outer:https://u:p@inner.test/", "https://outer:https://[REDACTED]@inner.test/"]
])("redacts URL userinfo in %s", (source, expected) => {
  expect(redactSecrets(source)).toBe(expected);
  expect(redactSecrets(expected)).toBe(expected);
});

// An SSH-family scheme has no password in a user name alone.
test.each([
  "ssh://only-user@host.test/repo",
  "ssh://git@github.com/org/repo",
  "git+ssh://git@github.com/o/r.git",
  "ssh+git://git@github.com/o/r.git",
  "svn+ssh://svn@host.test/repo",
  "SSH://git@host.test",
  'url = "Git+SSH://git@host.test:22/o/r.git"'
])("keeps the SSH user name in %s", (source) => {
  expect(redactSecrets(source)).toBe(source);
});

test.each([
  "API_KEY", "OPENAI_API_KEY", "CLIENT_SECRET", "PASSWORD", "ACCESS_TOKEN", "REFRESH_TOKEN", "SECRET_ACCESS_KEY"
])("redacts environment assignment %s", (name) => {
  const source = `PORT=3000\r\n  export ${name} = 'opaque value' # keep\r\nNODE_ENV=production`;
  const expected = `PORT=3000\r\n  export ${name} = [REDACTED] # keep\r\nNODE_ENV=production`;
  expect(redactSecrets(source)).toBe(expected);
  expect(redactSecrets(expected)).toBe(expected);
});

test.each([
  ['API_KEY="first\\"part\nsecond part"\nPORT=3000', "API_KEY=[REDACTED]\nPORT=3000"],
  ["PASSWORD='first\r\nsecond'\r\nNODE_ENV=production", "PASSWORD=[REDACTED]\r\nNODE_ENV=production"],
  ["CLIENT_SECRET=first\\\r\nsecond\r\nPORT=3000", "CLIENT_SECRET=[REDACTED]\r\nPORT=3000"],
  ["PASSWORD=unquoted value # comment", "PASSWORD=[REDACTED] # comment"],
  ["API_KEY='unterminated\nmore sensitive words", "API_KEY=[REDACTED]"],
  ["ACCESS_TOKEN=trailing\\", "ACCESS_TOKEN=[REDACTED]"],
  ["API_KEY='one'\"two\"; PORT=3000", "API_KEY=[REDACTED]; PORT=3000"]
])("redacts escaped, multiline or malformed assignments in %s", (source, expected) => {
  expect(redactSecrets(source)).toBe(expected);
});

// Tool results that the model reads and edits hold source code. Lowercase and
// mixed-case names are code variables, not environment settings, and an
// apostrophe in their value must not hide the rest of the text.
test("keeps source-code assignments with lowercase or mixed-case names", () => {
  const source = [
    "password = getpass()", "    access_token = response.json()[\"access_token\"]",
    "export api_key = 'value'", "Password = the user's choice", "client_Secret = load()",
    "def handler():", "    return token"
  ].join("\n");
  expect(redactSecrets(source)).toBe(source);
});

test("keeps ordinary assignments, prose, URL paths and incomplete authorization headers", () => {
  const source = [
    "PORT=3000", "NODE_ENV=production", "PUBLIC_KEY=public-value", "TOKEN_COUNT=100", "key=value",
    "An example is API_KEY=value, not a setting.", "Basic authentication is supported.",
    "Authorization: Basic", "API_KEY=", "export PASSWORD = # no value",
    "https://host.test/user:password@path", "https://host.test/?contact=user@example.test",
    "mail user@example.test", "https://host.test/path", "https://", "not_a_scheme://u:p@host"
  ].join("\n");
  expect(redactSecrets(source)).toBe(source);
});

test("redactSecrets redacts raw GitHub token formats in plain text output", () => {
  const result = redactSecrets(
    "tokens: ghu_user_token_123 ghs_install_token_456 github_pat_abcdefghijklmnopqrstuvwxyz"
  );

  expect(result).toBe("tokens: [REDACTED] [REDACTED] [REDACTED]");
});

test("redactSecrets redacts AWS access keys (AKIA and ASIA)", () => {
  const result = redactSecrets("aws=AKIAIOSFODNN7EXAMPLE sts=ASIAIOSFODNN7EXAMPLE");
  expect(result).toBe("aws=[REDACTED] sts=[REDACTED]");
});

test("redactSecrets redacts OpenAI API keys", () => {
  const result = redactSecrets("openai key sk-abcdefghijklmnopqrstuvwxyz0123 done");
  expect(result).toBe("openai key [REDACTED] done");
});

test("redactSecrets redacts Anthropic API keys", () => {
  const result = redactSecrets("anthropic key sk-ant-abcdefghijklmnopqrstuv done");
  expect(result).toBe("anthropic key [REDACTED] done");
});

test("redactSecrets redacts Slack tokens", () => {
  const result = redactSecrets(
    "bot xoxb-1234567890-abcdefghij user xoxp-9876543210-zyxwvutsrq"
  );
  expect(result).toBe("bot [REDACTED] user [REDACTED]");
});

test("redactSecrets redacts Google API keys", () => {
  const result = redactSecrets("g=AIzaSyA-abcdefghijklmnopqrstuvwxyz01234 done");
  expect(result).toBe("g=[REDACTED] done");
});

test("redactSecrets redacts PEM private key blocks", () => {
  const pem = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEowIBAAKCAQEAuFFKEXAMPLE",
    "supersecretmaterial==",
    "-----END RSA PRIVATE KEY-----"
  ].join("\n");
  const result = redactSecrets(`prefix\n${pem}\nsuffix`);
  expect(result).toBe("prefix\n[REDACTED]\nsuffix");
});

test("redactSecrets redacts multiple distinct provider keys in one string", () => {
  const result = redactSecrets(
    "AKIAIOSFODNN7EXAMPLE sk-ant-abcdefghijklmnopqrstuv sk-abcdefghijklmnopqrstuvwxyz0123 AIzaSyA-abcdefghijklmnopqrstuvwxyz01234"
  );
  expect(result).toBe("[REDACTED] [REDACTED] [REDACTED] [REDACTED]");
});

test.each([
  ["runtime", "rt_eyJzaWQiOiJzMSJ9.signature", "token [REDACTED] done"],
  [
    "jwt",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl",
    "token [REDACTED] done"
  ],
  ["stripe secret", `sk_live_${"a".repeat(24)}`, "token [REDACTED] done"],
  ["stripe restricted", `rk_live_${"b".repeat(24)}`, "token [REDACTED] done"],
  ["stripe webhook", `whsec_${"c".repeat(24)}`, "token [REDACTED] done"],
  ["gitlab", `glpat-${"d".repeat(24)}`, "token [REDACTED] done"],
  ["npm", `npm_${"e".repeat(36)}`, "token [REDACTED] done"],
  ["twilio api key", `SK${"a1".repeat(16)}`, "token [REDACTED] done"],
  [
    "twilio auth token assignment",
    `TWILIO_AUTH_TOKEN=${"f".repeat(32)}`,
    "token TWILIO_AUTH_TOKEN=[REDACTED] done"
  ],
  [
    "sendgrid",
    `SG.${"g".repeat(22)}.${"h".repeat(43)}`,
    "token [REDACTED] done"
  ],
  ["zai", `${"a1b2c3d4".repeat(4)}.${"Xy9z".repeat(4)}`, "token [REDACTED] done"]
])("redactSecrets redacts %s credentials in plain text", (_name, credential, expected) => {
  expect(redactSecrets(`token ${credential} done`)).toBe(expected);
});

// One sample key per model provider. The record type makes a new provider
// fail to compile until it has a sample, and the test fails until its
// MODEL_PROVIDER_META entry has a pattern that matches it (or a null whose
// comment names the pattern that does).
const PROVIDER_SAMPLE_KEYS: Record<ModelProvider, string> = {
  anthropic: `sk-ant-api03-${"a".repeat(24)}`,
  openai: `sk-proj-${"b".repeat(24)}`,
  google: `AIza${"C".repeat(35)}`,
  openrouter: `sk-or-v1-${"d1".repeat(16)}`,
  zai: `${"0123456789abcdef".repeat(2)}.${"Xy9z".repeat(4)}`
};

test.each(MODEL_PROVIDERS)("redactSecrets redacts a %s API key from the provider metadata", (provider) => {
  expect(redactSecrets(`key ${PROVIDER_SAMPLE_KEYS[provider]} done`)).toBe("key [REDACTED] done");
});

test("each provider key pattern runs once, global, in provider order", () => {
  const declared = MODEL_PROVIDERS.map((provider) => MODEL_PROVIDER_META[provider].keyPattern).filter((pattern) => pattern !== null);
  expect(PROVIDER_KEY_PATTERNS.map((pattern) => pattern.source)).toEqual(declared.map((pattern) => pattern!.source));
  for (const pattern of PROVIDER_KEY_PATTERNS) expect(pattern.flags).toBe("g");
  // A metadata pattern has no flags: a global or sticky RegExp keeps state.
  for (const pattern of declared) expect(pattern!.flags).toBe("");
});

test("redactSecrets does not redact incomplete provider prefixes or ordinary identifiers", () => {
  const value = "rt_ sk_live_ glpat-short npm_short SK1234 SG.short user_SK123456 task_rt_status";
  expect(redactSecrets(value)).toBe(value);
});

test("redactSecrets strips runtime tokens embedded in URL query strings", () => {
  const result = redactSecrets(
    "calling https://api.example.com/mcp/srv?token=rt_eyJzaWQiOiJzMSJ9.abcDEF now"
  );
  expect(result).toBe("calling https://api.example.com/mcp/srv?token=REDACTED now");
});

test("redactSecrets strips token-bearing query params with all known keys and separators", () => {
  const result = redactSecrets(
    "https://x/?token=AAA&accessToken=BBB&refreshToken=CCC&apiKey=DDD&api_key=EEE&next=keep"
  );
  expect(result).toBe(
    "https://x/?token=REDACTED&accessToken=REDACTED&refreshToken=REDACTED&apiKey=REDACTED&api_key=REDACTED&next=keep"
  );
});

test("redactSecrets preserves the URL fragment and surrounding quotes when redacting query tokens", () => {
  const result = redactSecrets(
    `link: "https://x/?token=secret#frag" and 'https://y/?apiKey=other'.`
  );
  expect(result).toBe(
    `link: "https://x/?token=REDACTED#frag" and 'https://y/?apiKey=REDACTED'.`
  );
});

// redactSecrets walks arbitrary MCP tool results, so it meets values that are
// not plain objects. Two competing failure modes: walking an opaque built-in
// destroys it, and NOT walking a class instance leaks whatever it holds. The
// allowlist has to land exactly between them.

test("redactSecrets redacts secret-keyed properties on a class instance", () => {
  class ToolResult {
    constructor(
      public authorization: string,
      public label: string
    ) {}
  }

  const result = redactSecrets(new ToolResult("Bearer sk-ant-abcdefghijklmnopqrstuvwx", "ok")) as {
    authorization: string;
    label: string;
  };

  // A class instance is NOT opaque: skipping the walk here would put a live
  // credential on the wire and into the durable checkpointer.
  expect(result.authorization).toBe("[REDACTED]");
  expect(result.label).toBe("ok");
});

test("redactSecrets redacts secret-keyed properties nested under a class instance", () => {
  class Envelope {
    constructor(public payload: { apiKey: string; keep: number }) {}
  }

  const result = redactSecrets(new Envelope({ apiKey: "sk-live-abcdefghijklmnop", keep: 7 })) as {
    payload: { apiKey: string; keep: number };
  };

  expect(result.payload.apiKey).toBe("[REDACTED]");
  expect(result.payload.keep).toBe(7);
});

test("redactSecrets preserves opaque built-ins instead of flattening them to {}", () => {
  const date = new Date("2026-07-25T00:00:00.000Z");
  const pattern = /ab+c/gi;

  const result = redactSecrets({ date, pattern, note: "fine" }) as {
    date: Date;
    pattern: RegExp;
    note: string;
  };

  // Walking these would yield {} and lose the value entirely.
  expect(result.date).toBeInstanceOf(Date);
  expect(result.date.toISOString()).toBe("2026-07-25T00:00:00.000Z");
  expect(result.pattern).toBeInstanceOf(RegExp);
  expect(result.note).toBe("fine");
});

test("redactSecrets still redacts a secret-keyed string alongside opaque built-ins", () => {
  const result = redactSecrets({
    createdAt: new Date("2026-07-25T00:00:00.000Z"),
    apiKey: "sk-live-abcdefghijklmnopqrst"
  }) as { createdAt: Date; apiKey: string };

  expect(result.createdAt).toBeInstanceOf(Date);
  expect(result.apiKey).toBe("[REDACTED]");
});

// A built-in's TYPE is not a safe reason to skip redaction: any of them can
// carry expando properties, and those serialize. `Object.assign(/x/, {apiKey})`
// JSON-stringifies to {"apiKey":"..."} — a live credential past the boundary.
test("redactSecrets redacts an expando credential on a RegExp instead of passing it through", () => {
  const withExpando = Object.assign(/x/, { apiKey: "live-secret-value" });

  const result = redactSecrets(withExpando) as unknown as { apiKey: string };

  expect(result.apiKey).toBe("[REDACTED]");
  expect(JSON.stringify(result)).not.toContain("live-secret-value");
});

test("redactSecrets redacts an expando credential on a Date", () => {
  const withExpando = Object.assign(new Date("2026-07-25T00:00:00.000Z"), {
    authorization: "Bearer sk-ant-abcdefghijklmnopqrstuvwx"
  });

  const result = redactSecrets(withExpando) as unknown as { authorization: string };

  expect(result.authorization).toBe("[REDACTED]");
});

test("redactSecrets redacts an expando credential on a typed array", () => {
  const withExpando = Object.assign(new Uint8Array([1, 2]), { apiKey: "live-secret-value" });

  const result = redactSecrets(withExpando) as unknown as { apiKey: string };

  expect(result.apiKey).toBe("[REDACTED]");
  expect(JSON.stringify(result)).not.toContain("live-secret-value");
});

test("redactSecrets leaves a clean Date opaque but walks one carrying any own key", () => {
  const clean = new Date("2026-07-25T00:00:00.000Z");
  expect(redactSecrets(clean)).toBe(clean); // same reference — not rebuilt

  const dirty = Object.assign(new Date("2026-07-25T00:00:00.000Z"), { note: "hi" });
  // Walked, so no longer a Date — the deliberate lossy-not-leaky trade.
  expect(redactSecrets(dirty)).not.toBeInstanceOf(Date);
});

test("redactSecrets keeps tool schemas and numeric arrays under credential-like keys", () => {
  // Key-based redaction must not corrupt a proxy tool schema or telemetry.
  expect(redactSecrets({
    properties: { maxTokens: { type: "integer", minimum: 1 }, token: { type: "string", description: "Page token" } },
    tokenUsage: { perModel: [{ model: "example", inputTokens: 12 }] }
  })).toEqual({
    properties: { maxTokens: { type: "integer", minimum: 1 }, token: { type: "string", description: "Page token" } },
    tokenUsage: { perModel: [{ model: "example", inputTokens: 12 }] }
  });
});

test("redactSecrets finds a credential in a URL nested in another parameter's value", () => {
  expect(redactSecrets("go to https://outer.test/?next=https://inner.test/?token=opaque-secret&page=2")).toBe(
    "go to https://outer.test/?next=https://inner.test/?token=REDACTED&page=2"
  );
});

test("redactSecrets and sanitizeUrl redact a percent-encoded credential name", () => {
  expect(redactSecrets("https://x/?api%2Dkey=opaque-secret")).toBe("https://x/?api%2Dkey=REDACTED");
});

test("redactSecrets strips every credential query name that URL validation refuses", () => {
  const result = redactSecrets(
    "https://x/?key=A&api-key=B&x_api_key=C&secret=D&auth=E&signature=F&sig=G&idtoken=H&page=2&monkey=keep"
  );
  expect(result).toBe(
    "https://x/?key=REDACTED&api-key=REDACTED&x_api_key=REDACTED&secret=REDACTED&auth=REDACTED&signature=REDACTED&sig=REDACTED&idtoken=REDACTED&page=2&monkey=keep"
  );
});

// These rules replaced the regexes below, which took quadratic time on some
// long inputs, and a recursive query scan that overflowed the stack. On short
// text the old forms are safe, so they give the expected output.
const REGEX_JWT_PATTERN = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const REGEX_PEM_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const QUERY_PATTERN = /([?&])([^=&\s"';#?]+)=(?!\$\{)([^\s&"';#]+)/g;
function recursiveQueryRedaction(_match: string, separator: string, name: string, value: string): string {
  return isSensitiveQueryParameterName(name)
    ? `${separator}${name}=REDACTED`
    : `${separator}${name}=${value.replace(QUERY_PATTERN, recursiveQueryRedaction)}`;
}

function compareOnRandomText(
  seed: number, alphabet: readonly string[], expected: (text: string) => string, prefix = ""
): { mismatches: string[]; changed: number } {
  const random = seededRandom(seed);
  const mismatches: string[] = [];
  let changed = 0;
  for (let i = 0; i < 10_000; i += 1) {
    const text = prefix + randomText(random, alphabet, 24);
    const want = expected(text);
    if (want !== text) changed += 1;
    if (redactSecrets(text) !== want) mismatches.push(JSON.stringify(text));
  }
  return { mismatches, changed };
}

test("redactSecrets redacts the same JWTs as the regex on random text", () => {
  const alphabet = ["eyJ", "eyJ", "-", "_", ".", ".", "x", "Z", "1", " ", "!", "é", "eyJ.a.b ", " eyJx.y-"];
  const result = compareOnRandomText(1, alphabet, (text) => text.replace(REGEX_JWT_PATTERN, "[REDACTED]"));
  expect(result.mismatches).toEqual([]);
  expect(result.changed).toBeGreaterThan(2_000);
});

test("redactSecrets redacts the same PEM blocks as the regex on random text", () => {
  const alphabet = ["-----BEGIN PRIVATE KEY-----", "-----END PRIVATE KEY-----", "-----BEGIN RSA PRIVATE KEY-----",
    "-----END RSA PRIVATE KEY-----", "-----BEGIN ", "-----END ", "PRIVATE KEY", "-----", "KEY-----", "x", "\n", " "];
  const result = compareOnRandomText(2, alphabet, (text) => text.replace(REGEX_PEM_PATTERN, "[REDACTED]"));
  expect(result.mismatches).toEqual([]);
  expect(result.changed).toBeGreaterThan(2_000);
});

test("redactSecrets redacts the same nested query values as the recursive scan on random text", () => {
  const alphabet = ["?", "&", "=", "token", "next", "a", "${", "#", " ", "x", "'", "%74oken", "?a=", "?next=", "=${x}", "sig",
    "?token=", "?next=x?sig="];
  // Keep this comparison about query values, not a line-start TOKEN assignment.
  const result = compareOnRandomText(3, alphabet, (text) => text.replace(QUERY_PATTERN, recursiveQueryRedaction), "URL query ");
  expect(result.mismatches).toEqual([]);
  expect(result.changed).toBeGreaterThan(2_000);
});

test("redactSecrets keeps JWT word boundaries", () => {
  expect(redactSecrets("id-eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln-")).toBe("id-[REDACTED]-");
  expect(redactSecrets("xeyJa.b.c")).toBe("xeyJa.b.c");
  // A failed start skips its run; a later run still matches.
  expect(redactSecrets("eyJ-eyJ.a eyJb.c.d")).toBe("eyJ-eyJ.a [REDACTED]");
  expect(redactSecrets("eyJa.b.c eyJd.e.f")).toBe("[REDACTED] [REDACTED]");
});

test("redactSecrets redacts a PEM block to its first END line", () => {
  expect(redactSecrets(
    "-----BEGIN PRIVATE KEY-----\nA\n-----BEGIN RSA PRIVATE KEY-----\nB\n-----END RSA PRIVATE KEY-----\nafter"
  )).toBe("[REDACTED]\nafter");
  expect(redactSecrets(
    "k1 -----BEGIN EC PRIVATE KEY-----\nA\n-----END EC PRIVATE KEY----- mid -----BEGIN PRIVATE KEY-----\nB\n-----END PRIVATE KEY----- end"
  )).toBe("k1 [REDACTED] mid [REDACTED] end");
});

test("redactSecrets follows a deep chain of nested query parameters", () => {
  // The recursive scan threw RangeError (stack overflow) here.
  const chain = "?a=".repeat(10_000);
  expect(redactSecrets(`${chain}?token=abc`)).toBe(`${chain}?token=REDACTED`);
  expect(redactSecrets("?next=x?%74oken=abc")).toBe("?next=x?%74oken=REDACTED");
  expect(redactSecrets("?next=x?token=${t}")).toBe("?next=x?token=${t}");
  expect(redactSecrets("?next=x?token=")).toBe("?next=x?token=");
});

// The old rules needed hours on the JWT input and over 10 s on the PEM input,
// and overflowed the stack on the query input. In a separate process, a
// regression fails at the kill timeout instead of blocking the test run.
// Measured on an Intel i5-12600K: about 40 ms for each JWT input, 15 ms for
// the PEM input, 80 ms for the query input.
test("redactSecrets stays linear on large adversarial input", { timeout: 60_000 }, () => {
  type Timed = { ms: number; result: unknown };
  const runs = runIsolated<Record<string, Timed>>(`
    const { redactSecrets } = await importSource("src/services/redact-secrets.ts");
    redactSecrets("warm up Bearer abc");
    print({
      // 4,000,000 characters: one run of 1,000,000 possible JWT starts.
      jwtRun: timed(() => redactSecrets("eyJ-".repeat(1_000_000)).length),
      jwtRunThenToken: timed(() => redactSecrets("eyJ-".repeat(1_000_000) + " eyJa.b.c").slice(-11)),
      // 100,000 BEGIN lines and no END line.
      pemHeaders: timed(() => redactSecrets("-----BEGIN PRIVATE KEY-----\\n".repeat(100_000) + "Bearer abc").slice(-17)),
      // 300,000 nested parameters.
      nestedQuery: timed(() => redactSecrets("?a=".repeat(300_000) + "?token=abc").slice(-15)),
      // Provider key patterns: a hex run with no dot after it (Z.AI), and many
      // short provider prefixes.
      providerHexRun: timed(() => redactSecrets("a".repeat(2_000_000) + ". Bearer abc").slice(-17)),
      providerPrefixes: timed(() => redactSecrets("sk-ant-x AIza sk- ".repeat(200_000) + "Bearer abc").slice(-17)),
      basicSpaces: timed(() => redactSecrets("Authorization: Basic " + " ".repeat(2_000_000) + "opaque").slice(-10)),
      urlSchemeRun: timed(() => redactSecrets("a-".repeat(1_000_000) + "://user:pass@host").slice(-15)),
      urlAuthorities: timed(() => redactSecrets("x://no-user/".repeat(100_000) + "x://u:p@host").slice(-19)),
      nestedAuthorities: timed(() => redactSecrets("x://".repeat(200_000) + "u:p@host").slice(-19)),
      sshUsers: timed(() => redactSecrets("ssh://git@host/".repeat(100_000) + "ssh://u:p@host").slice(-21)),
      sshLongUser: timed(() => redactSecrets("ssh://" + "u".repeat(2_000_000) + "@host").length),
      envName: timed(() => redactSecrets("A_".repeat(1_000_000) + "PUBLIC_KEY=public").length),
      envQuotes: timed(() => redactSecrets('API_KEY="' + ("escaped" + String.fromCharCode(92, 34, 10)).repeat(100_000)).slice(-10)),
      envLines: timed(() => redactSecrets("PORT=3000\\n".repeat(200_000) + "API_KEY=opaque").slice(-18))
    });
  `);

  expect(runs.jwtRun!.result).toBe(4_000_000);
  expect(runs.jwtRunThenToken!.result).toBe(" [REDACTED]");
  expect(runs.pemHeaders!.result).toBe("Bearer [REDACTED]");
  expect(runs.nestedQuery!.result).toBe("?token=REDACTED");
  expect(runs.providerHexRun!.result).toBe("Bearer [REDACTED]");
  expect(runs.providerPrefixes!.result).toBe("Bearer [REDACTED]");
  expect(runs.basicSpaces!.result).toBe("[REDACTED]");
  expect(runs.urlSchemeRun!.result).toBe("[REDACTED]@host");
  expect(runs.urlAuthorities!.result).toBe("x://[REDACTED]@host");
  expect(runs.nestedAuthorities!.result).toBe("x://[REDACTED]@host");
  expect(runs.sshUsers!.result).toBe("ssh://[REDACTED]@host");
  expect(runs.sshLongUser!.result).toBe(2_000_011);
  expect(runs.envName!.result).toBe(2_000_017);
  expect(runs.envQuotes!.result).toBe("[REDACTED]");
  expect(runs.envLines!.result).toBe("API_KEY=[REDACTED]");
  for (const [name, run] of Object.entries(runs)) expect(run.ms, name).toBeLessThan(2_000);
});
