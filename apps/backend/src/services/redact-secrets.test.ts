import { test, expect } from "vitest";

import { isSensitiveQueryParameterName } from "../lib/sensitive-query-params.js";
import { randomText, runIsolated, seededRandom } from "../test-helpers/isolated-timing.js";
import { redactAppData, redactSecrets } from "./redact-secrets.js";

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
  seed: number, alphabet: readonly string[], expected: (text: string) => string
): { mismatches: string[]; changed: number } {
  const random = seededRandom(seed);
  const mismatches: string[] = [];
  let changed = 0;
  for (let i = 0; i < 10_000; i += 1) {
    const text = randomText(random, alphabet, 24);
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
  const result = compareOnRandomText(3, alphabet, (text) => text.replace(QUERY_PATTERN, recursiveQueryRedaction));
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
      nestedQuery: timed(() => redactSecrets("?a=".repeat(300_000) + "?token=abc").slice(-15))
    });
  `);

  expect(runs.jwtRun!.result).toBe(4_000_000);
  expect(runs.jwtRunThenToken!.result).toBe(" [REDACTED]");
  expect(runs.pemHeaders!.result).toBe("Bearer [REDACTED]");
  expect(runs.nestedQuery!.result).toBe("?token=REDACTED");
  for (const [name, run] of Object.entries(runs)) expect(run.ms, name).toBeLessThan(2_000);
});
