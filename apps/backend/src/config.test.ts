import { test, expect } from "vitest";

import { isMailEnabled, isPasswordRecoveryEnabled, loadConfig } from "./config.js";

// E2B is required at boot, and the packaged default template id is a
// placeholder. Any config that is expected to BOOT must carry a real
// E2B_API_KEY and E2B_TEMPLATE_ID. `devConfig` is the dev-headers equivalent of
// `workosConfig` for bare-call tests that assert on a successful load rather
// than an early validation throw.
function devConfig(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    E2B_API_KEY: "e2b-test-key",
    E2B_TEMPLATE_ID: "tpl-test",
    ...overrides
  };
}

function workosConfig(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    AUTH_MODE: "workos",
    DATABASE_URL: "postgres://app_user:pw@localhost:5432/cogniplane",
    MAINTENANCE_DATABASE_URL: "postgres://maintenance_user:pw@localhost:5432/cogniplane",
    WORKOS_API_KEY: "sk_test_123",
    WORKOS_CLIENT_ID: "client_123",
    WORKOS_REDIRECT_URI: "http://localhost:3000/auth/callback",
    JWT_SECRET: "test-jwt-secret-must-be-at-least-32chars!",
    DATA_ENCRYPTION_SECRET: "test-encryption-secret-must-be-at-least-32chars!",
    REDIS_URL: "redis://localhost:6379",
    E2B_API_KEY: "e2b-test-key",
    E2B_TEMPLATE_ID: "tpl-test",
    ...overrides
  };
}

test("loadConfig requires Redis when WorkOS auth is enabled", () => {
  expect(() =>
          loadConfig(workosConfig({ REDIS_URL: undefined }))).toThrow(/REDIS_URL is required when AUTH_MODE=jwt/);
});

test("loadConfig requires explicit non-default data encryption secret in WorkOS mode", () => {
  expect(() => loadConfig(workosConfig({ DATA_ENCRYPTION_SECRET: undefined }))).toThrow(/DATA_ENCRYPTION_SECRET must be explicitly set to a non-default value when AUTH_MODE=jwt/);
});

test("loadConfig rejects the default data encryption secret in WorkOS mode", () => {
  expect(() =>
          loadConfig(
            workosConfig({
              DATA_ENCRYPTION_SECRET: "local-dev-data-encryption-secret-change-in-production!!"
            })
          )).toThrow(/DATA_ENCRYPTION_SECRET must be explicitly set to a non-default value when AUTH_MODE=jwt/);
});

test("loadConfig rejects WorkOS mode without WORKOS_API_KEY", () => {
  expect(() => loadConfig(workosConfig({ WORKOS_API_KEY: undefined }))).toThrow(/WORKOS_API_KEY is required when WorkOS login is enabled/);
});

test("loadConfig rejects WorkOS mode without WORKOS_CLIENT_ID", () => {
  expect(() => loadConfig(workosConfig({ WORKOS_CLIENT_ID: undefined }))).toThrow(/WORKOS_CLIENT_ID is required when WorkOS login is enabled/);
});

test("loadConfig rejects WorkOS mode without WORKOS_REDIRECT_URI", () => {
  expect(() => loadConfig(workosConfig({ WORKOS_REDIRECT_URI: undefined }))).toThrow(/WORKOS_REDIRECT_URI is required when WorkOS login is enabled/);
});

test("loadConfig rejects WorkOS mode without MAINTENANCE_DATABASE_URL", () => {
  expect(() => loadConfig(workosConfig({ MAINTENANCE_DATABASE_URL: undefined }))).toThrow(/MAINTENANCE_DATABASE_URL is required when AUTH_MODE=jwt/);
});

test("loadConfig rejects WorkOS mode when MAINTENANCE_DATABASE_URL equals DATABASE_URL", () => {
  const same = "postgres://app_user:pw@localhost:5432/cogniplane";
  expect(() =>
          loadConfig(
            workosConfig({ DATABASE_URL: same, MAINTENANCE_DATABASE_URL: same })
          )).toThrow(/MAINTENANCE_DATABASE_URL must use a separate maintenance role/);
});

test("loadConfig rejects WorkOS mode when JWT_SECRET is left at the default", () => {
  expect(() =>
          loadConfig(
            workosConfig({ JWT_SECRET: "local-dev-jwt-secret-change-in-production!!" })
          )).toThrow(/JWT_SECRET must be changed from the default/);
});

test("loadConfig parses verification-only JWT keys from JSON", () => {
  const config = loadConfig(
    devConfig({
      JWT_KEY_ID: "current",
      JWT_VERIFICATION_KEYS: JSON.stringify({
        previous: "previous-jwt-secret-must-be-at-least-32chars!"
      })
    })
  );
  expect(config.JWT_VERIFICATION_KEYS).toEqual({
    previous: "previous-jwt-secret-must-be-at-least-32chars!"
  });
});

test("loadConfig rejects conflicting active JWT key definitions", () => {
  expect(() =>
    loadConfig(
      devConfig({
        JWT_KEY_ID: "current",
        JWT_SECRET: "current-jwt-secret-must-be-at-least-32chars!",
        JWT_VERIFICATION_KEYS: JSON.stringify({
          current: "different-jwt-secret-must-be-at-least-32chars!"
        })
      })
    )
  ).toThrow(/must not redefine JWT_KEY_ID/);
});

test("loadConfig rejects ARTIFACT_STORAGE_BACKEND=bucket without ARTIFACT_BUCKET_NAME", () => {
  expect(() => loadConfig({ ARTIFACT_STORAGE_BACKEND: "bucket" })).toThrow(/ARTIFACT_BUCKET_NAME is required when ARTIFACT_STORAGE_BACKEND=bucket/);
});

test("loadConfig accepts AUTH_MODE=jwt with WorkOS login, the same as the workos alias", () => {
  const config = loadConfig(workosConfig({ AUTH_MODE: "jwt", AUTH_LOGIN_TYPES: " WorkOS , workos " }));
  expect(config.AUTH_MODE).toBe("jwt");
  expect(config.AUTH_LOGIN_TYPES).toEqual(["workos"]);
  // WorkOS is the default login type for jwt mode.
  expect(loadConfig(workosConfig({ AUTH_MODE: "jwt" })).AUTH_LOGIN_TYPES).toEqual(["workos"]);
  // Production accepts jwt mode too.
  expect(loadConfig(workosConfig({ AUTH_MODE: "jwt", NODE_ENV: "production" })).AUTH_MODE).toBe("jwt");
});

test("loadConfig fails closed on login types it cannot serve", () => {
  expect(() => loadConfig(workosConfig({ AUTH_MODE: "jwt", AUTH_LOGIN_TYPES: "saml" }))).toThrow(
    /AUTH_LOGIN_TYPES contains an unknown login type "saml"/
  );
  expect(() => loadConfig(workosConfig({ AUTH_MODE: "jwt", AUTH_LOGIN_TYPES: " , " }))).toThrow(
    /AUTH_LOGIN_TYPES must list at least one login type/
  );
  // The alias means WorkOS only; it cannot be combined with another list.
  expect(() => loadConfig(workosConfig({ AUTH_LOGIN_TYPES: "workos,local" }))).toThrow(
    /AUTH_MODE=workos means AUTH_LOGIN_TYPES=workos/
  );
  // dev-headers has no login, so a list there is a mistake.
  expect(() => loadConfig(devConfig({ AUTH_LOGIN_TYPES: "workos" }))).toThrow(
    /AUTH_LOGIN_TYPES is only valid with AUTH_MODE=jwt/
  );
});

test("loadConfig enables local login next to WorkOS, or alone without WorkOS keys", () => {
  expect(loadConfig(workosConfig({ AUTH_MODE: "jwt", AUTH_LOGIN_TYPES: "workos,local" })).AUTH_LOGIN_TYPES)
    .toEqual(["workos", "local"]);
  const localOnly = loadConfig(workosConfig({
    AUTH_MODE: "jwt", AUTH_LOGIN_TYPES: "local",
    WORKOS_API_KEY: undefined, WORKOS_CLIENT_ID: undefined, WORKOS_REDIRECT_URI: undefined
  }));
  expect(localOnly.AUTH_LOGIN_TYPES).toEqual(["local"]);
  expect(localOnly.LOCAL_AUTH_HASH_CONCURRENCY).toBe(4);
});

test("loadConfig resolves dev-headers to no login types", () => {
  expect(loadConfig(devConfig()).AUTH_LOGIN_TYPES).toEqual([]);
});

test("loadConfig reads the shared resource read limits, accepts 0 and rejects a negative value", () => {
  const defaults = loadConfig(devConfig());
  expect(defaults.RESOURCE_READ_LIMIT_PER_USER_PER_WINDOW).toBe(20);
  expect(defaults.RESOURCE_READ_LIMIT_PER_TENANT_PER_WINDOW).toBe(100);
  const overridden = loadConfig(devConfig({
    RESOURCE_READ_LIMIT_PER_USER_PER_WINDOW: "0",
    RESOURCE_READ_LIMIT_PER_TENANT_PER_WINDOW: "7"
  }));
  expect(overridden.RESOURCE_READ_LIMIT_PER_USER_PER_WINDOW).toBe(0);
  expect(overridden.RESOURCE_READ_LIMIT_PER_TENANT_PER_WINDOW).toBe(7);
  expect(() => loadConfig(devConfig({ RESOURCE_READ_LIMIT_PER_TENANT_PER_WINDOW: "-1" })))
    .toThrow(/RESOURCE_READ_LIMIT_PER_TENANT_PER_WINDOW/);
});

test("loadConfig rejects SKILL_BUNDLE_STORAGE_BACKEND=bucket without SKILL_BUNDLE_BUCKET_NAME", () => {
  expect(() => loadConfig({ SKILL_BUNDLE_STORAGE_BACKEND: "bucket" })).toThrow(/SKILL_BUNDLE_BUCKET_NAME is required when SKILL_BUNDLE_STORAGE_BACKEND=bucket/);
});

test("loadConfig accepts WorkOS mode with explicit non-default data encryption secret", () => {
  const config = loadConfig(workosConfig());
  expect(config.AUTH_MODE).toBe("jwt");
  expect(config.AUTH_LOGIN_TYPES).toEqual(["workos"]);
  expect(config.DATA_ENCRYPTION_SECRET).toBe("test-encryption-secret-must-be-at-least-32chars!");
});

test("loadConfig rejects explicit AUTH_MODE=dev-headers when NODE_ENV=production", () => {
  expect(() => loadConfig({ NODE_ENV: "production", AUTH_MODE: "dev-headers" })).toThrow(/AUTH_MODE=dev-headers is only permitted when NODE_ENV/);
});

test("loadConfig rejects defaulted AUTH_MODE when NODE_ENV=production", () => {
  // AUTH_MODE defaults to dev-headers in the schema; production must override.
  expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/AUTH_MODE=dev-headers is only permitted when NODE_ENV/);
  // A script serves no request: the production image runs its migration without the auth settings.
  expect(loadConfig({ NODE_ENV: "production" }, undefined, { skipRuntimeChecks: true }).AUTH_MODE).toBe("dev-headers");
});

test("loadConfig fail-closes dev-headers on an unrecognized NODE_ENV (typo guard)", () => {
  // A typo such as "prod" or "Production" must not leave dev-headers active.
  // Each of these values must throw.
  expect(() => loadConfig({ NODE_ENV: "prod" })).toThrow(/treated as production/);
  expect(() => loadConfig({ NODE_ENV: "Production" })).toThrow(/treated as production/);
  expect(() => loadConfig({ NODE_ENV: "staging" })).toThrow(/treated as production/);
});

test("loadConfig still allows dev-headers for unset / development / test NODE_ENV", () => {
  expect(loadConfig(devConfig()).AUTH_MODE).toBe("dev-headers");
  expect(loadConfig(devConfig({ NODE_ENV: "development" })).AUTH_MODE).toBe("dev-headers");
  expect(loadConfig(devConfig({ NODE_ENV: "test" })).AUTH_MODE).toBe("dev-headers");
});

test("loadConfig defaults dev-headers to the IPv4 loopback listener", () => {
  expect(loadConfig(devConfig()).API_HOST).toBe("127.0.0.1");
});

test("loadConfig defaults workos to the dual-stack all-interfaces listener", () => {
  // Networked deployments (ECS behind an ALB) rely on this default: a loopback
  // default would make the container unreachable and fail ELB health checks.
  expect(loadConfig(workosConfig()).API_HOST).toBe("::");
  // An explicit value still wins over the auth-mode default.
  expect(loadConfig(workosConfig({ API_HOST: "0.0.0.0" })).API_HOST).toBe("0.0.0.0");
});

test("loadConfig allows loopback listeners in dev-headers mode", () => {
  expect(loadConfig(devConfig({ API_HOST: "127.0.0.1" })).API_HOST).toBe("127.0.0.1");
  expect(loadConfig(devConfig({ API_HOST: "::1" })).API_HOST).toBe("::1");
  expect(loadConfig(devConfig({ API_HOST: "localhost" })).API_HOST).toBe("localhost");
});

test("loadConfig rejects network-exposed listeners in dev-headers mode", () => {
  expect(() => loadConfig(devConfig({ API_HOST: "0.0.0.0" }))).toThrow(/API_HOST must be a loopback address/);
  expect(() => loadConfig(devConfig({ API_HOST: "::" }))).toThrow(/API_HOST must be a loopback address/);
  expect(() => loadConfig(devConfig({ API_HOST: "192.168.1.10" }))).toThrow(/API_HOST must be a loopback address/);
  expect(() => loadConfig(devConfig({ API_HOST: "backend.internal" }))).toThrow(/API_HOST must be a loopback address/);
});

test("loadConfig allows dev-headers on a non-loopback listener only when the container opt-in is set", () => {
  // Without the opt-in, the guard still throws (covered above). With it, boot
  // succeeds — but only alongside a shared secret, because the network guard is
  // the thing being removed.
  const optIn = { API_HOST: "0.0.0.0", DEV_HEADERS_AUTH_KEY: "dev-headers-shared-secret" };
  expect(loadConfig(devConfig({ ...optIn, COGNIPLANE_ALLOW_DEV_HEADERS_ON_NON_LOOPBACK: "1" })).API_HOST).toBe(
    "0.0.0.0"
  );
  expect(loadConfig(devConfig({ ...optIn, COGNIPLANE_ALLOW_DEV_HEADERS_ON_NON_LOOPBACK: "true" })).API_HOST).toBe(
    "0.0.0.0"
  );
  // Unknown / falsy values must NOT bypass the guard.
  expect(() => loadConfig(devConfig({ ...optIn, COGNIPLANE_ALLOW_DEV_HEADERS_ON_NON_LOOPBACK: "no" }))).toThrow(
    /API_HOST must be a loopback address/
  );
});

test("loadConfig refuses the non-loopback opt-in without a shared secret", () => {
  // Dropping the bind guard with no request-level guard is unauthenticated
  // cross-tenant impersonation for anything that can reach the port.
  expect(() =>
    loadConfig(devConfig({ API_HOST: "0.0.0.0", COGNIPLANE_ALLOW_DEV_HEADERS_ON_NON_LOOPBACK: "1" }))
  ).toThrow(/DEV_HEADERS_AUTH_KEY .* is required/);
  expect(() =>
    loadConfig(
      devConfig({
        API_HOST: "0.0.0.0",
        COGNIPLANE_ALLOW_DEV_HEADERS_ON_NON_LOOPBACK: "1",
        DEV_HEADERS_AUTH_KEY: "too-short"
      })
    )
  ).toThrow();
});

test("loadConfig accepts versioned/platform pdftotext names, rejects unrelated binaries", () => {
  expect(loadConfig(devConfig({ PDFTOTEXT_BINARY_PATH: "/usr/bin/pdftotext" })).PDFTOTEXT_BINARY_PATH).toBe(
    "/usr/bin/pdftotext"
  );
  expect(loadConfig(devConfig({ PDFTOTEXT_BINARY_PATH: "/opt/poppler/pdftotext-24.02" })).PDFTOTEXT_BINARY_PATH).toBe(
    "/opt/poppler/pdftotext-24.02"
  );
  expect(loadConfig(devConfig({ PDFTOTEXT_BINARY_PATH: "/tools/pdftotext.exe" })).PDFTOTEXT_BINARY_PATH).toBe(
    "/tools/pdftotext.exe"
  );
  expect(() => loadConfig(devConfig({ PDFTOTEXT_BINARY_PATH: "/usr/bin/evil-script" }))).toThrow(
    /must point at a pdftotext binary/
  );
});

test("loadConfig pins the basenames of the PDF OCR tools", () => {
  const config = loadConfig(devConfig({
    PDFINFO_BINARY_PATH: "/usr/bin/pdfinfo",
    PDFTOPPM_BINARY_PATH: "/opt/poppler/pdftoppm-24.02",
    TESSERACT_BINARY_PATH: "/usr/local/bin/tesseract"
  }));
  expect([config.PDFINFO_BINARY_PATH, config.PDFTOPPM_BINARY_PATH, config.TESSERACT_BINARY_PATH])
    .toEqual(["/usr/bin/pdfinfo", "/opt/poppler/pdftoppm-24.02", "/usr/local/bin/tesseract"]);
  expect(() => loadConfig(devConfig({ TESSERACT_BINARY_PATH: "/usr/bin/sh" }))).toThrow(/must point at a tesseract binary/);
  expect(() => loadConfig(devConfig({ PDFTOPPM_BINARY_PATH: "/tmp/pdfinfo" }))).toThrow(/must point at a pdftoppm binary/);
});

test("loadConfig keeps PDF OCR off by default and checks its settings", () => {
  const config = loadConfig(devConfig());
  expect(config).toMatchObject({
    PII_PDF_OCR_ENABLED: false, PII_PDF_OCR_MAX_PAGES: 20, PII_PDF_OCR_TIMEOUT_MS: 30_000,
    PII_PDF_OCR_MAX_CONCURRENT: 2, PII_PDF_OCR_LANGUAGES: "eng"
  });
  expect(loadConfig(devConfig({ PII_PDF_OCR_LANGUAGES: "eng+fra+chi_sim" })).PII_PDF_OCR_LANGUAGES).toBe("eng+fra+chi_sim");
  for (const languages of ["", "eng fra", "eng;rm", "-l", "eng+"]) {
    expect(() => loadConfig(devConfig({ PII_PDF_OCR_LANGUAGES: languages }))).toThrow();
  }
});

test("loadConfig requires the PDF OCR budget to fit inside the PII job timeout", () => {
  expect(() => loadConfig(devConfig({
    PII_PDF_OCR_ENABLED: "true", PII_PDF_OCR_TIMEOUT_MS: "296000", SCHEDULER_JOB_TIMEOUT_MS: "300000"
  }))).toThrow(/PII_PDF_OCR_TIMEOUT_MS/);
  expect(loadConfig(devConfig({ PII_PDF_OCR_ENABLED: "true" })).PII_PDF_OCR_ENABLED).toBe(true);
});

test("loadConfig accepts AUTH_MODE=workos when NODE_ENV=production", () => {
  const config = loadConfig(workosConfig({ NODE_ENV: "production", API_HOST: "0.0.0.0" }));
  expect(config.AUTH_MODE).toBe("jwt");
  expect(config.API_HOST).toBe("0.0.0.0");
});

test("loadConfig boots when PII provider is disabled and no API key is set", () => {
  const config = loadConfig(devConfig());
  expect(config.PII_PROVIDER_ENABLED).toBe(false);
  expect(config.PII_LLM_API_KEY).toBe(undefined);
  expect(config.PII_PROVIDER_TIMEOUT_MS).toBe(5000);
  expect(config.PII_LLM_BASE_URL).toBe("https://openrouter.ai/api/v1");
  expect(config.PII_LLM_MODEL).toBe("google/gemini-2.5-flash");
});

test("loadConfig requires a PII model API key when PII provider is enabled", () => {
  expect(() => loadConfig(devConfig({ PII_PROVIDER_ENABLED: "true" }))).toThrow(/PII_LLM_API_KEY is required when PII_PROVIDER_ENABLED=true/);
});

test("loadConfig accepts PII provider config when enabled with an API key", () => {
  const config = loadConfig(devConfig({
    PII_PROVIDER_ENABLED: "true",
    PII_LLM_API_KEY: "sk-or-test-123",
    PII_LLM_MODEL: "google/gemma-4-E2B-it-qat-w4a16-ct",
    PII_PROVIDER_TIMEOUT_MS: "7500"
  }));
  expect(config.PII_PROVIDER_ENABLED).toBe(true);
  expect(config.PII_LLM_API_KEY).toBe("sk-or-test-123");
  expect(config.PII_LLM_MODEL).toBe("google/gemma-4-E2B-it-qat-w4a16-ct");
  expect(config.PII_PROVIDER_TIMEOUT_MS).toBe(7500);
});

// The Deep Agents runtime executes exclusively inside E2B, so E2B config is
// validated at boot unconditionally — there is no in-process local execution
// mode.

test("loadConfig accepts a real E2B template", () => {
  const config = loadConfig({
    E2B_API_KEY: "e2b-test-key",
    E2B_TEMPLATE_ID: "real-tpl-abc123",
    RUNTIME_GATEWAY_BASE_URL: "http://127.0.0.1:3001"
  });

  expect(config.E2B_API_KEY).toBe("e2b-test-key");
  expect(config.E2B_TEMPLATE_ID).toBe("real-tpl-abc123");
});

test("loadConfig rejects non-loopback RUNTIME_GATEWAY_BASE_URL", () => {
  expect(() =>
    loadConfig({
      E2B_API_KEY: "e2b-test-key",
      E2B_TEMPLATE_ID: "real-tpl-abc123",
      RUNTIME_GATEWAY_BASE_URL: "https://api.example.com"
    })
  ).toThrow(/RUNTIME_GATEWAY_BASE_URL must resolve to a loopback address/);
});

test("loadConfig accepts localhost and [::1] loopback RUNTIME_GATEWAY_BASE_URL", () => {
  const cfgLocalhost = loadConfig({
    E2B_API_KEY: "e2b-test-key",
    E2B_TEMPLATE_ID: "real-tpl-abc123",
    RUNTIME_GATEWAY_BASE_URL: "http://localhost:3001"
  });
  expect(cfgLocalhost.RUNTIME_GATEWAY_BASE_URL).toBe("http://localhost:3001");

  const cfgIpv6 = loadConfig({
    E2B_API_KEY: "e2b-test-key",
    E2B_TEMPLATE_ID: "real-tpl-abc123",
    RUNTIME_GATEWAY_BASE_URL: "http://[::1]:3001"
  });
  expect(cfgIpv6.RUNTIME_GATEWAY_BASE_URL).toBe("http://[::1]:3001");
});

test("loadConfig skipRuntimeChecks bypasses RUNTIME_GATEWAY_BASE_URL loopback validation", () => {
  const config = loadConfig(
    {
      E2B_API_KEY: undefined,
      E2B_TEMPLATE_ID: undefined,
      RUNTIME_GATEWAY_BASE_URL: "https://api.example.com"
    },
    undefined,
    { skipRuntimeChecks: true }
  );
  expect(config.RUNTIME_GATEWAY_BASE_URL).toBe("https://api.example.com");
});

test("loadConfig refuses the placeholder E2B_TEMPLATE_ID default", () => {
  expect(() =>
    loadConfig({
      E2B_API_KEY: "e2b-test-key",
      E2B_TEMPLATE_ID: "replace-with-your-template-id",
      RUNTIME_GATEWAY_BASE_URL: "http://127.0.0.1:3001"
    })
  ).toThrow(/E2B_TEMPLATE_ID is not configured/);
});

test("loadConfig requires E2B_API_KEY (the runtime executes inside E2B)", () => {
  expect(() => loadConfig({ E2B_API_KEY: undefined })).toThrow(
    /E2B_API_KEY is required/
  );
});

test("loadConfig skipRuntimeChecks bypasses E2B/PII validation for the migration runner", () => {
  // The migration runner only needs a DATABASE_URL — it must load with no E2B
  // key/template and no PII key, since those aren't present in the CI/deploy
  // step that runs `pnpm db:migrate`.
  const config = loadConfig(
    { E2B_API_KEY: undefined, E2B_TEMPLATE_ID: undefined, PII_PROVIDER_ENABLED: "true" },
    undefined,
    { skipRuntimeChecks: true }
  );
  expect(config.DATABASE_URL).toBeDefined();
});

test("loadConfig skipRuntimeChecks still enforces DB-backed (workos) validations", () => {
  // skipRuntimeChecks only relaxes runtime-serving checks; production auth
  // posture must still fail closed even on the migration path.
  expect(() =>
    loadConfig(workosConfig({ REDIS_URL: undefined }), undefined, { skipRuntimeChecks: true })
  ).toThrow(/REDIS_URL is required when AUTH_MODE=jwt/);
});

test("loadConfig does not warn on a localhost RUNTIME_GATEWAY_BASE_URL", () => {
  // The MCP client runs in the backend process (deep-agents-graph.ts), so
  // localhost is reachable. That is the right default for local dev.
  const warnings: Array<{ meta: object; msg: string }> = [];
  loadConfig(
    {
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
  const gatewayWarn = warnings.find((w) => w.msg.includes("RUNTIME_GATEWAY_BASE_URL"));
  expect(gatewayWarn).toBeUndefined();
});

test("loadConfig parses ADMIN_USER_IDS as comma-separated list", () => {
  const config = loadConfig(devConfig({ ADMIN_USER_IDS: "alice, bob ,, carol" }));
  expect(config.ADMIN_USER_IDS).toEqual(["alice", "bob", "carol"]);
});

test("loadConfig defaults ADMIN_USER_IDS to [LOCAL_DEV_USER_ID] when unset", () => {
  const config = loadConfig(devConfig({ LOCAL_DEV_USER_ID: "dev-only" }));
  expect(config.ADMIN_USER_IDS).toEqual(["dev-only"]);
});

test("loadConfig requires both ARTIFACT_BUCKET access keys when one is set", () => {
  expect(() =>
    loadConfig(devConfig({
      ARTIFACT_BUCKET_ACCESS_KEY_ID: "akid"
    }))
  ).toThrow(/ARTIFACT_BUCKET_ACCESS_KEY_ID and ARTIFACT_BUCKET_SECRET_ACCESS_KEY must be provided together/);

  expect(() =>
    loadConfig(devConfig({
      ARTIFACT_BUCKET_SECRET_ACCESS_KEY: "sk"
    }))
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
  const config = loadConfig(devConfig({
    GITHUB_OAUTH_CLIENT_ID: "x",
    GITHUB_OAUTH_CLIENT_SECRET: "y",
    GITHUB_OAUTH_REDIRECT_URI: "http://localhost:3001/auth/github/callback"
  }));
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
    devConfig({
      // AUTH_MODE defaults to dev-headers; JWT_SECRET defaults to the well-known string
    }),
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

test("loadConfig rejects a turn timeout at or below the approval TTL", () => {
  expect(() =>
    loadConfig(
      devConfig({ RUNTIME_TURN_TIMEOUT_MS: "600000", APPROVAL_REQUEST_TTL_MS: "600000" })
    )
  ).toThrow(/RUNTIME_TURN_TIMEOUT_MS must exceed APPROVAL_REQUEST_TTL_MS/);
});

test("loadConfig rejects a turn timeout at or above the sandbox lifetime", () => {
  expect(() =>
    loadConfig(
      devConfig({ RUNTIME_TURN_TIMEOUT_MS: "1800000", E2B_SANDBOX_TIMEOUT_MS: "1800000" })
    )
  ).toThrow(/RUNTIME_TURN_TIMEOUT_MS must be less than E2B_SANDBOX_TIMEOUT_MS/);
});

test("loadConfig rejects a tool-context TTL that cannot absorb one paused approval", () => {
  // The turn watchdog pauses while a human decides an approval. A turn's
  // wall-clock ceiling is therefore RUNTIME_TURN_TIMEOUT_MS + APPROVAL_REQUEST_TTL_MS.
  // The tool-context TTL does not pause. 25 min of context against a 20-min
  // watchdog and a 10-min approval expires the context mid-turn.
  expect(() =>
    loadConfig(
      devConfig({
        RUNTIME_TURN_TIMEOUT_MS: "1200000",
        APPROVAL_REQUEST_TTL_MS: "600000",
        TOOL_CONTEXT_TTL_MS: "1500000"
      })
    )
  ).toThrow(/TOOL_CONTEXT_TTL_MS .* must exceed RUNTIME_TURN_TIMEOUT_MS \+ APPROVAL_REQUEST_TTL_MS/);
});

test("loadConfig accepts a tool-context TTL above the turn + approval sum", () => {
  const config = loadConfig(
    devConfig({
      RUNTIME_TURN_TIMEOUT_MS: "1200000",
      APPROVAL_REQUEST_TTL_MS: "600000",
      TOOL_CONTEXT_TTL_MS: "2100000"
    })
  );
  expect(config.TOOL_CONTEXT_TTL_MS).toBe(2_100_000);
});

test("the shipped defaults satisfy their own timing invariants", () => {
  // Guards against raising one default and leaving the others behind: the
  // no-override load must not throw, and the wall-clock ordering must hold.
  const config = loadConfig(devConfig({}));
  expect(config.TOOL_CONTEXT_TTL_MS).toBeGreaterThan(
    config.RUNTIME_TURN_TIMEOUT_MS + config.APPROVAL_REQUEST_TTL_MS
  );
  expect(config.RUNTIME_TURN_TIMEOUT_MS).toBeLessThan(config.E2B_SANDBOX_TIMEOUT_MS);
});

test("loadConfig warns that a disabled turn watchdog (0) leaves the context TTL unenforceable", () => {
  // With no watchdog a turn has NO ceiling, so no finite TOOL_CONTEXT_TTL_MS
  // can be validated against it — there is no correct number to require. The
  // config is accepted (0 is a documented escape hatch) but must say out loud
  // that a long turn can still lose managed MCP tool access mid-flight.
  const warnings: Array<{ msg: string }> = [];
  const config = loadConfig(devConfig({ RUNTIME_TURN_TIMEOUT_MS: "0" }), {
    warn: (_meta: object, msg: string) => warnings.push({ msg })
  } as never);
  expect(config.RUNTIME_TURN_TIMEOUT_MS).toBe(0);
  expect(warnings.some((w) => w.msg.includes("disables the turn watchdog"))).toBe(true);
});

test("loadConfig refuses the v1 upstream signing override, which upstreams held", () => {
  expect(() => loadConfig(devConfig({ MCP_UPSTREAM_SIGNING_SECRET: "x".repeat(40) })))
    .toThrow(/MCP_UPSTREAM_SIGNING_SECRET is the v1 upstream signing key/);
  expect(loadConfig(devConfig({ MCP_UPSTREAM_SIGNING_ROOT_SECRET: "y".repeat(40) })).MCP_UPSTREAM_SIGNING_ROOT_SECRET)
    .toBe("y".repeat(40));
});


test("runtime WorkOS config does not require migration credentials", () => {
  expect(loadConfig(workosConfig({ MIGRATION_DATABASE_URL: undefined })).MAINTENANCE_DATABASE_URL).toBeDefined();
});

test("migration config does not require runtime maintenance credentials", () => {
  expect(loadConfig(workosConfig({ MAINTENANCE_DATABASE_URL: undefined }), undefined, { skipRuntimeChecks: true }).MAINTENANCE_DATABASE_URL).toBeUndefined();
});

test("migration credentials cannot replace missing runtime maintenance credentials", () => {
  expect(() => loadConfig(workosConfig({
    MAINTENANCE_DATABASE_URL: undefined,
    MIGRATION_DATABASE_URL: "postgres://postgres:pw@localhost:5432/cogniplane"
  }))).toThrow("MAINTENANCE_DATABASE_URL is required");
});

test("model spending defaults are optional and reject negative or zero reservations", () => {
  expect(loadConfig(devConfig()).MODEL_SPENDING_MONTHLY_LIMIT_USD).toBeUndefined();
  expect(loadConfig(devConfig()).MODEL_SPENDING_TURN_RESERVATION_USD).toBe(1);
  expect(loadConfig(devConfig({ MODEL_SPENDING_MONTHLY_LIMIT_USD: "0" })).MODEL_SPENDING_MONTHLY_LIMIT_USD).toBe(0);
  expect(() => loadConfig(devConfig({ MODEL_SPENDING_MONTHLY_LIMIT_USD: "-1" }))).toThrow();
  expect(() => loadConfig(devConfig({ MODEL_SPENDING_TURN_RESERVATION_USD: "0" }))).toThrow();
});

test("the sandbox network check limits default to 20 s and 5 s, can be set, and must be positive integers", () => {
  // One deadline covers the network check of a sandbox. One timeout covers each
  // E2B request inside it. The SDK default of 60 s per request would let four
  // reads in a row block a call for minutes.
  const defaults = loadConfig(devConfig());
  expect(defaults.E2B_NETWORK_CONFIRM_TIMEOUT_MS).toBe(20_000);
  expect(defaults.E2B_NETWORK_REQUEST_TIMEOUT_MS).toBe(5_000);

  const custom = loadConfig(devConfig({ E2B_NETWORK_CONFIRM_TIMEOUT_MS: "30000", E2B_NETWORK_REQUEST_TIMEOUT_MS: "2500" }));
  expect(custom.E2B_NETWORK_CONFIRM_TIMEOUT_MS).toBe(30_000);
  expect(custom.E2B_NETWORK_REQUEST_TIMEOUT_MS).toBe(2_500);

  // A zero or negative limit would fail every confirmation at once, or never.
  for (const invalid of ["0", "-1", "1.5", "soon"]) {
    expect(() => loadConfig(devConfig({ E2B_NETWORK_CONFIRM_TIMEOUT_MS: invalid }))).toThrow();
    expect(() => loadConfig(devConfig({ E2B_NETWORK_REQUEST_TIMEOUT_MS: invalid }))).toThrow();
  }
});

test("WEBAUTHN_RP_ID needs local login and must match the frontend host", () => {
  const local = { AUTH_MODE: "jwt", AUTH_LOGIN_TYPES: "local", API_ORIGIN: "https://app.example.test" };
  expect(loadConfig(workosConfig({ ...local, WEBAUTHN_RP_ID: "app.example.test" })).WEBAUTHN_RP_ID).toBe("app.example.test");
  // A parent domain is valid WebAuthn; the name defaults.
  const parent = loadConfig(workosConfig({ ...local, WEBAUTHN_RP_ID: "Example.Test" }));
  expect(parent.WEBAUTHN_RP_ID).toBe("example.test");
  expect(parent.WEBAUTHN_RP_NAME).toBe("Cogniplane");
  expect(() => loadConfig(workosConfig({ ...local, WEBAUTHN_RP_ID: "other.test" }))).toThrow(/WEBAUTHN_RP_ID must equal the hostname of API_ORIGIN/);
  // A suffix that is not a domain boundary is not a parent.
  expect(() => loadConfig(workosConfig({ ...local, WEBAUTHN_RP_ID: "ample.test" }))).toThrow(/WEBAUTHN_RP_ID must equal/);
  expect(() => loadConfig(workosConfig({ AUTH_MODE: "jwt", WEBAUTHN_RP_ID: "app.example.test", API_ORIGIN: "https://app.example.test" })))
    .toThrow(/WEBAUTHN_RP_ID needs local login/);
});

test("SMTP_URL and MAIL_FROM: both or neither, jwt mode, TLS unless a development opt-in", () => {
  const local = { AUTH_MODE: "jwt", AUTH_LOGIN_TYPES: "local", API_ORIGIN: "https://app.example.test" };
  const mail = { SMTP_URL: "smtps://user:secret-pass@smtp.example.test", MAIL_FROM: "Cogniplane <no-reply@example.test>" };
  const on = loadConfig(workosConfig({ ...local, ...mail }));
  expect(isMailEnabled(on)).toBe(true);
  expect(on.SMTP_ALLOW_PLAINTEXT).toBe(false);
  expect(isMailEnabled(loadConfig(workosConfig(local)))).toBe(false);

  expect(() => loadConfig(workosConfig({ ...local, SMTP_URL: mail.SMTP_URL }))).toThrow(/SMTP_URL and MAIL_FROM must be set together/);
  expect(() => loadConfig(workosConfig({ ...local, MAIL_FROM: mail.MAIL_FROM }))).toThrow(/SMTP_URL and MAIL_FROM must be set together/);
  // Any login type: WorkOS owners get the notice of a data setting change.
  // Password recovery still needs local login.
  const workosOnly = loadConfig(workosConfig({ AUTH_MODE: "jwt", ...mail }));
  expect(isMailEnabled(workosOnly)).toBe(true);
  expect(isPasswordRecoveryEnabled(workosOnly)).toBe(false);
  expect(isPasswordRecoveryEnabled(on)).toBe(true);
  expect(() => loadConfig(devConfig(mail))).toThrow(/SMTP_URL needs AUTH_MODE=jwt/);
  expect(() => loadConfig(workosConfig({ ...local, ...mail, SMTP_URL: "http://smtp.example.test" }))).toThrow(/smtps:\/\/ or smtp:\/\//);
  expect(() => loadConfig(workosConfig({ ...local, ...mail, MAIL_FROM: "not an address" }))).toThrow(/MAIL_FROM must be an email address/);
  // The error never repeats the URL: it can hold the password.
  let message = "";
  try {
    loadConfig(workosConfig({ ...local, ...mail, SMTP_URL: "smtp://user:secret-pass@smtp.example.test/path" }));
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toMatch(/must not have a path/);
  expect(message).not.toContain("secret-pass");

  // Plaintext SMTP is a development opt-in, refused in production.
  const plain = { ...local, SMTP_URL: "smtp://localhost:1025", MAIL_FROM: "dev@example.test", SMTP_ALLOW_PLAINTEXT: "true" };
  expect(loadConfig(workosConfig(plain)).SMTP_ALLOW_PLAINTEXT).toBe(true);
  expect(() => loadConfig(workosConfig({ ...plain, NODE_ENV: "production" }))).toThrow(/SMTP_ALLOW_PLAINTEXT is for development only/);
});
