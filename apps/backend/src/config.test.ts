import { test, expect } from "vitest";

import { loadConfig } from "./config.js";

function workosConfig(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    AUTH_MODE: "workos",
    DATABASE_URL: "postgres://app_user:pw@localhost:5432/cogniplane",
    MIGRATION_DATABASE_URL: "postgres://postgres:pw@localhost:5432/cogniplane",
    WORKOS_API_KEY: "sk_test_123",
    WORKOS_CLIENT_ID: "client_123",
    WORKOS_REDIRECT_URI: "http://localhost:3000/auth/callback",
    JWT_SECRET: "test-jwt-secret-must-be-at-least-32chars!",
    DATA_ENCRYPTION_SECRET: "test-encryption-secret-must-be-at-least-32chars!",
    REDIS_URL: "redis://localhost:6379",
    ...overrides
  };
}

test("loadConfig requires Redis when WorkOS auth is enabled", () => {
  expect(() =>
          loadConfig(workosConfig({ REDIS_URL: undefined }))).toThrow(/REDIS_URL is required when AUTH_MODE=workos/);
});

test("loadConfig requires explicit non-default data encryption secret in WorkOS mode", () => {
  expect(() => loadConfig(workosConfig({ DATA_ENCRYPTION_SECRET: undefined }))).toThrow(/DATA_ENCRYPTION_SECRET must be explicitly set to a non-default value when AUTH_MODE=workos/);
});

test("loadConfig rejects the default data encryption secret in WorkOS mode", () => {
  expect(() =>
          loadConfig(
            workosConfig({
              DATA_ENCRYPTION_SECRET: "local-dev-data-encryption-secret-change-in-production!!"
            })
          )).toThrow(/DATA_ENCRYPTION_SECRET must be explicitly set to a non-default value when AUTH_MODE=workos/);
});

test("loadConfig rejects WorkOS mode without WORKOS_API_KEY", () => {
  expect(() => loadConfig(workosConfig({ WORKOS_API_KEY: undefined }))).toThrow(/WORKOS_API_KEY is required when AUTH_MODE=workos/);
});

test("loadConfig rejects WorkOS mode without WORKOS_CLIENT_ID", () => {
  expect(() => loadConfig(workosConfig({ WORKOS_CLIENT_ID: undefined }))).toThrow(/WORKOS_CLIENT_ID is required when AUTH_MODE=workos/);
});

test("loadConfig rejects WorkOS mode without WORKOS_REDIRECT_URI", () => {
  expect(() => loadConfig(workosConfig({ WORKOS_REDIRECT_URI: undefined }))).toThrow(/WORKOS_REDIRECT_URI is required when AUTH_MODE=workos/);
});

test("loadConfig rejects WorkOS mode without MIGRATION_DATABASE_URL", () => {
  expect(() => loadConfig(workosConfig({ MIGRATION_DATABASE_URL: undefined }))).toThrow(/MIGRATION_DATABASE_URL is required when AUTH_MODE=workos/);
});

test("loadConfig rejects WorkOS mode when MIGRATION_DATABASE_URL equals DATABASE_URL", () => {
  const same = "postgres://app_user:pw@localhost:5432/cogniplane";
  expect(() =>
          loadConfig(
            workosConfig({ DATABASE_URL: same, MIGRATION_DATABASE_URL: same })
          )).toThrow(/MIGRATION_DATABASE_URL must use a privileged connection/);
});

test("loadConfig rejects WorkOS mode when JWT_SECRET is left at the default", () => {
  expect(() =>
          loadConfig(
            workosConfig({ JWT_SECRET: "local-dev-jwt-secret-change-in-production!!" })
          )).toThrow(/JWT_SECRET must be changed from the default/);
});

test("loadConfig rejects ARTIFACT_STORAGE_BACKEND=bucket without ARTIFACT_BUCKET_NAME", () => {
  expect(() => loadConfig({ ARTIFACT_STORAGE_BACKEND: "bucket" })).toThrow(/ARTIFACT_BUCKET_NAME is required when ARTIFACT_STORAGE_BACKEND=bucket/);
});

test("loadConfig rejects SKILL_BUNDLE_STORAGE_BACKEND=bucket without SKILL_BUNDLE_BUCKET_NAME", () => {
  expect(() => loadConfig({ SKILL_BUNDLE_STORAGE_BACKEND: "bucket" })).toThrow(/SKILL_BUNDLE_BUCKET_NAME is required when SKILL_BUNDLE_STORAGE_BACKEND=bucket/);
});

test("loadConfig accepts WorkOS mode with explicit non-default data encryption secret", () => {
  const config = loadConfig(workosConfig());
  expect(config.AUTH_MODE).toBe("workos");
  expect(config.DATA_ENCRYPTION_SECRET).toBe("test-encryption-secret-must-be-at-least-32chars!");
});

test("loadConfig rejects explicit AUTH_MODE=dev-headers when NODE_ENV=production", () => {
  expect(() => loadConfig({ NODE_ENV: "production", AUTH_MODE: "dev-headers" })).toThrow(/AUTH_MODE=dev-headers is not permitted when NODE_ENV=production/);
});

test("loadConfig rejects defaulted AUTH_MODE when NODE_ENV=production", () => {
  // AUTH_MODE defaults to dev-headers in the schema; production must override.
  expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/AUTH_MODE=dev-headers is not permitted when NODE_ENV=production/);
});

test("loadConfig accepts AUTH_MODE=workos when NODE_ENV=production", () => {
  const config = loadConfig(workosConfig({ NODE_ENV: "production" }));
  expect(config.AUTH_MODE).toBe("workos");
});

test("loadConfig boots when PII provider is disabled and no API key is set", () => {
  const config = loadConfig({});
  expect(config.PII_PROVIDER_ENABLED).toBe(false);
  expect(config.PII_OPENROUTER_API_KEY).toBe(undefined);
  expect(config.PII_PROVIDER_TIMEOUT_MS).toBe(5000);
  expect(config.PII_OPENROUTER_BASE_URL).toBe("https://openrouter.ai/api/v1");
  expect(config.PII_OPENROUTER_MODEL).toBe("google/gemini-2.5-flash");
});

test("loadConfig requires OpenRouter API key when PII provider is enabled", () => {
  expect(() => loadConfig({ PII_PROVIDER_ENABLED: "true" })).toThrow(/PII_OPENROUTER_API_KEY is required when PII_PROVIDER_ENABLED=true/);
});

test("loadConfig accepts PII provider config when enabled with an API key", () => {
  const config = loadConfig({
    PII_PROVIDER_ENABLED: "true",
    PII_OPENROUTER_API_KEY: "sk-or-test-123",
    PII_OPENROUTER_MODEL: "custom/model-id",
    PII_PROVIDER_TIMEOUT_MS: "7500"
  });
  expect(config.PII_PROVIDER_ENABLED).toBe(true);
  expect(config.PII_OPENROUTER_API_KEY).toBe("sk-or-test-123");
  expect(config.PII_OPENROUTER_MODEL).toBe("custom/model-id");
  expect(config.PII_PROVIDER_TIMEOUT_MS).toBe(7500);
});

test("loadConfig does not require a Claude-specific E2B template when RUNTIME_BACKEND=e2b", () => {
  const config = loadConfig({
    RUNTIME_BACKEND: "e2b",
    E2B_API_KEY: "e2b-test-key",
    E2B_TEMPLATE_ID: "real-tpl-abc123",
    RUNTIME_GATEWAY_BASE_URL: "https://api.example.com"
  });

  expect(config.RUNTIME_BACKEND).toBe("e2b");
  expect(config.E2B_API_KEY).toBe("e2b-test-key");
});

test("loadConfig refuses RUNTIME_BACKEND=e2b when E2B_TEMPLATE_ID is the placeholder default", () => {
  expect(() =>
    loadConfig({
      RUNTIME_BACKEND: "e2b",
      E2B_API_KEY: "e2b-test-key",
      RUNTIME_GATEWAY_BASE_URL: "https://api.example.com"
    })
  ).toThrow(/E2B_TEMPLATE_ID is not configured for RUNTIME_BACKEND=e2b/);
});

test("loadConfig refuses CLAUDE_RUNTIME_BACKEND=e2b when E2B_TEMPLATE_ID is the placeholder default", () => {
  expect(() =>
    loadConfig({
      CLAUDE_RUNTIME_BACKEND: "e2b",
      E2B_API_KEY: "e2b-test-key",
      RUNTIME_GATEWAY_BASE_URL: "https://api.example.com"
    })
  ).toThrow(/E2B_TEMPLATE_ID is not configured for CLAUDE_RUNTIME_BACKEND=e2b/);
});

test("loadConfig requires E2B_API_KEY when RUNTIME_BACKEND=e2b", () => {
  expect(() => loadConfig({ RUNTIME_BACKEND: "e2b" })).toThrow(
    /E2B_API_KEY is required when RUNTIME_BACKEND=e2b/
  );
});

test("loadConfig requires E2B_API_KEY when CLAUDE_RUNTIME_BACKEND=e2b", () => {
  expect(() => loadConfig({ CLAUDE_RUNTIME_BACKEND: "e2b" })).toThrow(
    /E2B_API_KEY is required when CLAUDE_RUNTIME_BACKEND=e2b/
  );
});

test("loadConfig warns when RUNTIME_BACKEND=e2b but RUNTIME_GATEWAY_BASE_URL is localhost", () => {
  const warnings: Array<{ meta: object; msg: string }> = [];
  const config = loadConfig(
    {
      RUNTIME_BACKEND: "e2b",
      E2B_API_KEY: "e2b-key",
      E2B_TEMPLATE_ID: "tpl-real",
      RUNTIME_GATEWAY_BASE_URL: "http://localhost:3001"
    },
    {
      warn(meta, msg) {
        warnings.push({ meta, msg });
      }
    }
  );
  expect(config.RUNTIME_BACKEND).toBe("e2b");
  const localhostWarn = warnings.find((w) => w.msg.includes("E2B sandboxes cannot reach localhost"));
  expect(localhostWarn).toBeDefined();
});

test("loadConfig parses ADMIN_USER_IDS as comma-separated list", () => {
  const config = loadConfig({ ADMIN_USER_IDS: "alice, bob ,, carol" });
  expect(config.ADMIN_USER_IDS).toEqual(["alice", "bob", "carol"]);
});

test("loadConfig defaults ADMIN_USER_IDS to [LOCAL_DEV_USER_ID] when unset", () => {
  const config = loadConfig({ LOCAL_DEV_USER_ID: "dev-only" });
  expect(config.ADMIN_USER_IDS).toEqual(["dev-only"]);
});

test("loadConfig requires both ARTIFACT_BUCKET access keys when one is set", () => {
  expect(() =>
    loadConfig({
      ARTIFACT_BUCKET_ACCESS_KEY_ID: "akid"
      // missing ARTIFACT_BUCKET_SECRET_ACCESS_KEY
    })
  ).toThrow(/ARTIFACT_BUCKET_ACCESS_KEY_ID and ARTIFACT_BUCKET_SECRET_ACCESS_KEY must be provided together/);

  expect(() =>
    loadConfig({
      ARTIFACT_BUCKET_SECRET_ACCESS_KEY: "sk"
      // missing ARTIFACT_BUCKET_ACCESS_KEY_ID
    })
  ).toThrow(/ARTIFACT_BUCKET_ACCESS_KEY_ID and ARTIFACT_BUCKET_SECRET_ACCESS_KEY must be provided together/);
});

test("loadConfig requires all GitHub OAuth fields when any is set", () => {
  expect(() => loadConfig({ GITHUB_OAUTH_CLIENT_ID: "x" })).toThrow(
    /GITHUB_OAUTH_CLIENT_SECRET is required when GitHub OAuth is configured/
  );
  expect(() =>
    loadConfig({ GITHUB_OAUTH_CLIENT_ID: "x", GITHUB_OAUTH_CLIENT_SECRET: "y" })
  ).toThrow(/GITHUB_OAUTH_REDIRECT_URI is required when GitHub OAuth is configured/);
  // Setting only the secret triggers the missing-CLIENT_ID branch.
  expect(() => loadConfig({ GITHUB_OAUTH_CLIENT_SECRET: "y" })).toThrow(
    /GITHUB_OAUTH_CLIENT_ID is required when GitHub OAuth is configured/
  );
});

test("loadConfig accepts GitHub OAuth when all three fields are set", () => {
  const config = loadConfig({
    GITHUB_OAUTH_CLIENT_ID: "x",
    GITHUB_OAUTH_CLIENT_SECRET: "y",
    GITHUB_OAUTH_REDIRECT_URI: "http://localhost:3001/auth/github/callback"
  });
  expect(config.GITHUB_OAUTH_CLIENT_ID).toBe("x");
});

test("loadConfig requires all Notion OAuth fields when any is set", () => {
  expect(() => loadConfig({ NOTION_OAUTH_CLIENT_ID: "x" })).toThrow(
    /NOTION_OAUTH_CLIENT_SECRET is required when Notion OAuth is configured/
  );
  expect(() =>
    loadConfig({ NOTION_OAUTH_CLIENT_ID: "x", NOTION_OAUTH_CLIENT_SECRET: "y" })
  ).toThrow(/NOTION_OAUTH_REDIRECT_URI is required when Notion OAuth is configured/);
  expect(() => loadConfig({ NOTION_OAUTH_CLIENT_SECRET: "y" })).toThrow(
    /NOTION_OAUTH_CLIENT_ID is required when Notion OAuth is configured/
  );
});

test("loadConfig warns when JWT_SECRET is the default and AUTH_MODE != workos", () => {
  const warnings: Array<{ meta: object; msg: string }> = [];
  const config = loadConfig(
    {
      // AUTH_MODE defaults to dev-headers; JWT_SECRET defaults to the well-known string
    },
    {
      warn(meta, msg) {
        warnings.push({ meta, msg });
      }
    }
  );
  expect(config.AUTH_MODE).toBe("dev-headers");
  expect(warnings.some((w) => w.msg.includes("JWT_SECRET is using the well-known default"))).toBe(true);
  expect(warnings.some((w) => w.msg.includes("DATA_ENCRYPTION_SECRET is using the well-known default"))).toBe(true);
});
