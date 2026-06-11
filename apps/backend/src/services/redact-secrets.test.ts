import { test, expect } from "vitest";

import { redactSecrets } from "./redact-secrets.js";

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
