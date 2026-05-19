import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import codexRelease from "./codex-release.json" with { type: "json" };

const envFilePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const defaultRuntimeWorkspaceRoot = path.join(
  os.tmpdir(),
  "cogniplane-core-runtime-workspaces"
);
const defaultArtifactStorageRoot = path.join(os.tmpdir(), "cogniplane-core-artifacts");
const defaultSkillBundleStorageRoot = path.join(os.tmpdir(), "cogniplane-core-skills");
const defaultSkillBundleCacheRoot = path.join(os.tmpdir(), "cogniplane-skill-cache");
const DEFAULT_DATA_ENCRYPTION_SECRET = "local-dev-data-encryption-secret-change-in-production!!";
const DEFAULT_JWT_SECRET = "local-dev-jwt-secret-change-in-production!!";
const booleanFromEnvSchema = z.preprocess((value) => {
  if (typeof value === "string") {
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  }

  return value;
}, z.boolean());

const envSchema = z.object({
  API_HOST: z.string().default("::"),
  API_PORT: z.coerce.number().int().positive().default(3001),
  API_ORIGIN: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgres://postgres:postgres@localhost:5432/cogniplane"),
  LOCAL_DEV_USER_ID: z.string().min(1).default("local-dev-user"),
  ADMIN_USER_IDS: z.string().optional(),
  CODEX_BINARY_PATH: z.string().min(1).default("codex"),
  CODEX_VERSION: z.string().trim().min(1).default(codexRelease.codexVersion),
  CODEX_SCHEMA_VERSION: z.string().trim().min(1).default(codexRelease.schemaVersion),
  CODEX_MODEL: z.string().trim().min(1).default("gpt-5.4-mini"),
  CODEX_SANDBOX_MODE: z.enum(["workspace-write", "danger-full-access", "read-only"]).optional(),
  ANTHROPIC_API_KEY: z.string().trim().min(1).optional(),
  // Upstream Anthropic API base URL used by the in-backend proxy at
  // /llm/anthropic. Override for local mocking, regional routing, or
  // gateway/bedrock front-ends. Production: leave at the default.
  ANTHROPIC_UPSTREAM_BASE_URL: z
    .string()
    .url()
    .default("https://api.anthropic.com"),
  // Upstream OpenAI API base URL used by the in-backend proxy at
  // /llm/openai. Codex inside the sandbox is configured (via the
  // [model_providers.cogniplane_proxy] block in ~/.codex/config.toml) to
  // talk to this route, NOT to api.openai.com — that way the real
  // OPENAI_API_KEY never leaves the backend. Override for testing or
  // regional routing; production should leave at the default.
  OPENAI_UPSTREAM_BASE_URL: z
    .string()
    .url()
    .default("https://api.openai.com"),
  // Comma-separated CIDR allowlist for the /llm/anthropic proxy. Only the
  // direct socket peer (request.ip) is checked — no X-Forwarded-For trust.
  // Set to the documented E2B egress CIDRs so a leaked runtime token cannot
  // be redeemed from outside the sandbox provider's NAT range. Empty (the
  // default) disables the check, which is appropriate for local dev where
  // the proxy is not in use anyway. The check applies in addition to the
  // rt_* token's session-scoped HMAC claims; both must pass.
  E2B_EGRESS_CIDRS: z.string().trim().default(""),
  CLAUDE_CODE_MODEL: z.string().trim().min(1).default("claude-sonnet-4-6"),
  // Where the Claude Agent SDK runs. `local` keeps the SDK in-process on the
  // backend (quickest for local dev and regional fallback). `e2b` launches
  // the bundled sandbox-agent harness inside the shared agent-runtime
  // template, giving Claude the same sandbox isolation Codex has.
  CLAUDE_RUNTIME_BACKEND: z.enum(["local", "e2b"]).default("local"),
  CLAUDE_AGENT_SDK_VERSION: z.string().trim().min(1).default(codexRelease.claudeAgentSdkVersion),
  OPENAI_API_KEY: z.string().trim().min(1).optional(),
  SESSION_TITLER_CLAUDE_MODEL: z.string().trim().min(1).default("claude-haiku-4-5-20251001"),
  SESSION_TITLER_CODEX_MODEL: z.string().trim().min(1).default("gpt-5.4-nano"),
  SESSION_TITLER_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  RUNTIME_WORKSPACE_ROOT: z
    .string()
    .min(1)
    .default(defaultRuntimeWorkspaceRoot),
  RUNTIME_GATEWAY_BASE_URL: z.string().url().default("http://localhost:3001"),
  RUNTIME_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
  RUNTIME_START_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  RUNTIME_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  // Lifetime of the HMAC-signed runtime token embedded in the generated
  // codex.toml / .mcp.json so the sandbox can call back to /mcp/:serverId.
  // Default: 24 hours. The token is the only thing tying a sandbox to its
  // tenant/user/session; if it leaks (workspace tarball, log line, snapshot)
  // an attacker can call MCP tools for the bound session until expiry.
  //
  // The TTL must outlive the longest realistic session because the token is
  // minted once at workspace bootstrap and not refreshed for the lifetime of
  // the runtime — Codex caches its Authorization header at process start and
  // the Claude SDK pins MCP tokens at session start, so an in-place refresh
  // would require tearing down and rebuilding the runtime mid-session.
  // Idle timeout (RUNTIME_IDLE_TIMEOUT_MS, default 5 min) tears Codex down on
  // inactivity, but a session with a turn every few minutes can stay alive
  // indefinitely. Local Claude (CLAUDE_RUNTIME_BACKEND=local) has no sandbox
  // hard cap; e2b mode is bounded by E2B_SANDBOX_TIMEOUT_MS (default 30 min).
  //
  // 24 hours is the floor that comfortably exceeds long debugging sessions
  // while still being 7x tighter than the previous 7-day default. Tighten to
  // 1 hour (3600000) only if you accept that any session running continuously
  // past that will fail with `runtime_token_expired` until it's restarted.
  RUNTIME_TOKEN_TTL_MS: z.coerce.number().int().positive().default(24 * 60 * 60 * 1000),
  TOOL_CONTEXT_TTL_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  APPROVAL_REQUEST_TTL_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
  ARTIFACT_STORAGE_BACKEND: z.enum(["local", "bucket"]).default("local"),
  ARTIFACT_STORAGE_ROOT: z.string().min(1).default(defaultArtifactStorageRoot),
  SKILL_BUNDLE_STORAGE_ROOT: z.string().min(1).default(defaultSkillBundleStorageRoot),
  SKILL_BUNDLE_STORAGE_BACKEND: z.enum(["local", "bucket"]).default("local"),
  SKILL_BUNDLE_BUCKET_NAME: z.string().trim().min(1).optional(),
  SKILL_BUNDLE_BUCKET_PREFIX: z.string().trim().default(""),
  SKILL_BUNDLE_CACHE_ROOT: z.string().min(1).default(defaultSkillBundleCacheRoot),
  ARTIFACT_BUCKET_NAME: z.string().trim().min(1).optional(),
  ARTIFACT_BUCKET_REGION: z.string().trim().min(1).default("us-east-1"),
  ARTIFACT_BUCKET_ENDPOINT: z.string().url().optional(),
  ARTIFACT_BUCKET_PREFIX: z.string().trim().default(""),
  ARTIFACT_BUCKET_FORCE_PATH_STYLE: booleanFromEnvSchema.default(false),
  ARTIFACT_BUCKET_ACCESS_KEY_ID: z.string().trim().min(1).optional(),
  ARTIFACT_BUCKET_SECRET_ACCESS_KEY: z.string().trim().min(1).optional(),
  ARTIFACT_BUCKET_SESSION_TOKEN: z.string().trim().min(1).optional(),
  ARTIFACT_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  ARTIFACT_DOWNLOAD_TTL_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  SKILL_BUNDLE_RETENTION_DAYS: z.coerce.number().int().min(0).default(30),
  SKILL_MARKETPLACE_MANIFEST_URL: z.string().url().optional(),
  SKILL_MARKETPLACE_CACHE_TTL_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
  PDFTOTEXT_BINARY_PATH: z.string().min(1).default("pdftotext"),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  SESSION_CREATE_LIMIT_PER_USER_PER_WINDOW: z.coerce.number().int().min(0).default(10),
  SESSION_CREATE_LIMIT_PER_TENANT_PER_WINDOW: z.coerce.number().int().min(0).default(50),
  MESSAGE_LIMIT_PER_USER_PER_WINDOW: z.coerce.number().int().min(0).default(20),
  MESSAGE_LIMIT_PER_TENANT_PER_WINDOW: z.coerce.number().int().min(0).default(100),
  TURN_QUOTA_PER_USER_PER_DAY: z.coerce.number().int().min(0).default(200),
  TURN_QUOTA_PER_TENANT_PER_DAY: z.coerce.number().int().min(0).default(1000),
  SCHEDULER_ENABLED: booleanFromEnvSchema.default(true),
  SCHEDULER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  SCHEDULER_MAX_CONCURRENT_JOBS: z.coerce.number().int().positive().default(2),
  SCHEDULER_JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  // Tier 3 LLM judge worker.
  // Off by default at the platform level — per-tenant judge config in
  // `tenant_settings` is the second gate. Set the platform flag, set tenant
  // skill_judge_provider/skill_judge_model, and the worker will start judging
  // that tenant's eligible sessions on the next tick.
  SKILL_JUDGE_WORKER_ENABLED: booleanFromEnvSchema.default(false),
  SKILL_JUDGE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(60 * 60_000),
  SKILL_JUDGE_INACTIVE_BEFORE_MS: z.coerce.number().int().positive().default(30 * 60_000),
  SKILL_JUDGE_MAX_SESSIONS_PER_TICK: z.coerce.number().int().positive().default(5),
  // How long a sync row can stay in `running` before the worker reaps it
  // back to `failed`. Sync providers should resolve in seconds; anything
  // older than this is an orphan from a crash/kill mid-tick. Batch rows
  // (`submitted`) are exempt — they have their own poll loop.
  SKILL_JUDGE_RUNNING_TIMEOUT_MS: z.coerce.number().int().positive().default(5 * 60_000),
  AUTH_MODE: z.enum(["workos", "dev-headers"]).default("dev-headers"),
  DATA_ENCRYPTION_SECRET: z.string().min(32).default(DEFAULT_DATA_ENCRYPTION_SECRET),
  WORKOS_API_KEY: z.string().trim().min(1).optional(),
  WORKOS_CLIENT_ID: z.string().trim().min(1).optional(),
  WORKOS_REDIRECT_URI: z.string().url().optional(),
  GITHUB_OAUTH_CLIENT_ID: z.string().trim().min(1).optional(),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().trim().min(1).optional(),
  GITHUB_OAUTH_REDIRECT_URI: z.string().url().optional(),
  NOTION_OAUTH_CLIENT_ID: z.string().trim().min(1).optional(),
  NOTION_OAUTH_CLIENT_SECRET: z.string().trim().min(1).optional(),
  NOTION_OAUTH_REDIRECT_URI: z.string().url().optional(),
  MIGRATION_DATABASE_URL: z.string().url().optional(),
  JWT_SECRET: z.string().min(32).default(DEFAULT_JWT_SECRET),
  // Forward-compat handle for JWT secret rotation. Stamped into the `kid`
  // header of every issued access/refresh token. Verification currently
  // ignores it; a future multi-key resolver will route on this value
  // without invalidating tokens already in flight.
  JWT_KEY_ID: z.string().trim().min(1).default("default"),
  REDIS_URL: z.string().url().optional(),
  RUNTIME_BACKEND: z.enum(["local", "e2b"]).default("local"),
  E2B_API_KEY: z.string().trim().min(1).optional(),
  E2B_TEMPLATE_ID: z.string().trim().min(1).default(codexRelease.e2bTemplateId),
  E2B_SANDBOX_TIMEOUT_MS: z.coerce.number().int().positive().default(30 * 60 * 1000),
  PII_PROVIDER_ENABLED: booleanFromEnvSchema.default(false),
  PII_OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  PII_OPENROUTER_API_KEY: z.string().trim().min(1).optional(),
  // Default model selection rationale:
  //   google/gemini-2.5-flash is routed by OpenRouter to Google's Vertex AI, which
  //   under OpenRouter's "Zero Data Retention" (ZDR) routing does not retain or
  //   train on inputs. Operators who want stronger guarantees should set
  //   PII_OPENROUTER_MODEL explicitly and verify the provider's posture at
  //   https://openrouter.ai/docs/features/privacy-and-logging and the upstream
  //   provider's own policy page.
  PII_OPENROUTER_MODEL: z.string().trim().min(1).default("google/gemini-2.5-flash"),
  PII_PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  // Hard cap on artifact bytes the PII service will read into memory before
  // a scan. Anything larger throws file_too_large (a permanent failure) and
  // the artifact is marked failed without burning retries.
  PII_ARTIFACT_MAX_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
  // CSVs are scanned in two passes: deterministic rules over the full file,
  // and an LLM scan of the header + first N rows for PII the rules can't
  // catch (person names, addresses in cells). The preview is byte-capped to
  // keep token costs predictable on wide tables.
  PII_CSV_PREVIEW_ROWS: z.coerce.number().int().positive().default(10),
  PII_CSV_PREVIEW_MAX_BYTES: z.coerce.number().int().positive().default(4096),
  // Global circuit breaker around the PII provider. Trips after THRESHOLD
  // failures within WINDOW_MS, stays open for COOLDOWN_MS, then permits a
  // single half-open probe before closing or re-opening. State is shared
  // across backend processes via Redis when REDIS_URL is set; otherwise it
  // falls back to per-process in-memory state.
  PII_BREAKER_ENABLED: booleanFromEnvSchema.default(true),
  PII_BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
  PII_BREAKER_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  PII_BREAKER_COOLDOWN_MS: z.coerce.number().int().positive().default(30_000),
  // Master key-encryption key (KEK) for the `reversible_encrypted` retention
  // mode. 32 bytes encoded as 64 hex characters (`openssl rand -hex 32`).
  // Each tenant gets its own data-encryption key (DEK) derived via
  // HKDF-SHA256(KEK, salt=tenantId). Required when any tenant has
  // `rawRetention='reversible_encrypted'` configured; otherwise that mode
  // throws `pii_kek_missing` instead of silently downgrading.
  PII_RETENTION_KEK: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
  MODEL_LIST_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  // Per-tenant TTL for the Anthropic /v1/models capability cache used by
  // GET /models. Capability data rarely changes; a 10-minute success TTL
  // keeps an authed client from triggering a billable upstream call on
  // every chat-screen render. Negative cache (timeouts, non-2xx) is kept
  // short so a freshly-fixed key isn't locked out for a full window.
  MODEL_LIST_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(600_000),
  MODEL_LIST_CACHE_NEGATIVE_TTL_MS: z.coerce.number().int().nonnegative().default(30_000)
});

type ParsedAppConfig = z.infer<typeof envSchema>;

export type AppConfig = Omit<ParsedAppConfig, "ADMIN_USER_IDS"> & {
  ADMIN_USER_IDS: string[];
};

/**
 * Minimal logger shape accepted by `loadConfig`. Compatible with Fastify's
 * `FastifyBaseLogger` (pino) so callers can pass `app.log` directly. A console
 * adapter is used when no logger is provided — which is the common case here,
 * because `loadConfig()` runs before the Fastify app is constructed.
 */
export type ConfigLogger = {
  warn(meta: object, msg: string): void;
};

const defaultConfigLogger: ConfigLogger = {
  warn(meta, msg) {
    console.warn(JSON.stringify({ level: "warn", msg, ...meta }));
  }
};

function resolveStoragePath(
  rawValue: string,
  envKey: string,
  defaultPath: string,
  warnSuffix: string,
  nodeEnv: string | undefined,
  logger: ConfigLogger
): string {
  const resolved = path.isAbsolute(rawValue)
    ? rawValue
    : path.resolve(projectRoot, rawValue);
  const insideProject =
    resolved === projectRoot || resolved.startsWith(`${projectRoot}${path.sep}`);

  if (nodeEnv !== "production" && insideProject && resolved !== defaultPath) {
    logger.warn(
      { envKey, resolvedPath: resolved, defaultPath, reason: warnSuffix },
      `${envKey} is inside the repo; overriding to ${defaultPath}.`
    );
  }

  return nodeEnv !== "production" && insideProject ? defaultPath : resolved;
}

export function loadConfig(
  source: NodeJS.ProcessEnv = process.env,
  logger: ConfigLogger = defaultConfigLogger
): AppConfig {
  try {
    process.loadEnvFile(envFilePath);
  } catch {
    // Local dev can rely on schema defaults when no .env file exists yet.
  }
  const parsed = envSchema.parse(source);

  const resolvedRuntimeWorkspaceRoot = resolveStoragePath(
    parsed.RUNTIME_WORKSPACE_ROOT,
    "RUNTIME_WORKSPACE_ROOT",
    defaultRuntimeWorkspaceRoot,
    "can restart dev watchers",
    source.NODE_ENV,
    logger
  );
  const resolvedArtifactStorageRoot = resolveStoragePath(
    parsed.ARTIFACT_STORAGE_ROOT,
    "ARTIFACT_STORAGE_ROOT",
    defaultArtifactStorageRoot,
    "can pollute the worktree",
    source.NODE_ENV,
    logger
  );
  const resolvedSkillBundleStorageRoot = resolveStoragePath(
    parsed.SKILL_BUNDLE_STORAGE_ROOT,
    "SKILL_BUNDLE_STORAGE_ROOT",
    defaultSkillBundleStorageRoot,
    "can pollute the worktree",
    source.NODE_ENV,
    logger
  );

  if (parsed.ARTIFACT_STORAGE_BACKEND === "bucket" && !parsed.ARTIFACT_BUCKET_NAME) {
    throw new Error("ARTIFACT_BUCKET_NAME is required when ARTIFACT_STORAGE_BACKEND=bucket.");
  }

  if (parsed.SKILL_BUNDLE_STORAGE_BACKEND === "bucket" && !parsed.SKILL_BUNDLE_BUCKET_NAME) {
    throw new Error("SKILL_BUNDLE_BUCKET_NAME is required when SKILL_BUNDLE_STORAGE_BACKEND=bucket.");
  }

  if (parsed.AUTH_MODE === "workos") {
    if (!parsed.WORKOS_API_KEY) throw new Error("WORKOS_API_KEY is required when AUTH_MODE=workos.");
    if (!parsed.WORKOS_CLIENT_ID) throw new Error("WORKOS_CLIENT_ID is required when AUTH_MODE=workos.");
    if (!parsed.WORKOS_REDIRECT_URI) throw new Error("WORKOS_REDIRECT_URI is required when AUTH_MODE=workos.");
    if (!parsed.MIGRATION_DATABASE_URL) {
      throw new Error("MIGRATION_DATABASE_URL is required when AUTH_MODE=workos.");
    }
    if (parsed.MIGRATION_DATABASE_URL === parsed.DATABASE_URL) {
      throw new Error("MIGRATION_DATABASE_URL must use a privileged connection distinct from DATABASE_URL when AUTH_MODE=workos.");
    }
    if (!parsed.REDIS_URL) {
      throw new Error("REDIS_URL is required when AUTH_MODE=workos.");
    }
    if (parsed.JWT_SECRET === DEFAULT_JWT_SECRET) {
      throw new Error("JWT_SECRET must be changed from the default value when AUTH_MODE=workos.");
    }
    if (parsed.DATA_ENCRYPTION_SECRET === DEFAULT_DATA_ENCRYPTION_SECRET) {
      throw new Error("DATA_ENCRYPTION_SECRET must be explicitly set to a non-default value when AUTH_MODE=workos.");
    }
  }

  // dev-headers mode trusts X-User-Id / X-Tenant-Id from request headers, which
  // lets any caller impersonate any user or tenant. It is intended for local
  // development only and must never be active in production.
  if (source.NODE_ENV === "production" && parsed.AUTH_MODE !== "workos") {
    throw new Error(
      `AUTH_MODE=${parsed.AUTH_MODE} is not permitted when NODE_ENV=production. ` +
        "Set AUTH_MODE=workos for production deployments."
    );
  }

  if (parsed.AUTH_MODE !== "workos" && parsed.JWT_SECRET === DEFAULT_JWT_SECRET) {
    logger.warn(
      { authMode: parsed.AUTH_MODE },
      "JWT_SECRET is using the well-known default value. " +
        "JWTs and runtime tokens (rt_*) are signed with a publicly known key. " +
        "Do not expose this instance outside localhost."
    );
  }

  if (parsed.AUTH_MODE !== "workos" && parsed.DATA_ENCRYPTION_SECRET === DEFAULT_DATA_ENCRYPTION_SECRET) {
    logger.warn(
      { authMode: parsed.AUTH_MODE },
      "DATA_ENCRYPTION_SECRET is using the well-known default value. " +
        "Stored OAuth credentials and runtime tokens (rt_*) use this key. " +
        "Do not expose this instance outside localhost."
    );
  }

  const githubOAuthConfigured = [
    parsed.GITHUB_OAUTH_CLIENT_ID,
    parsed.GITHUB_OAUTH_CLIENT_SECRET,
    parsed.GITHUB_OAUTH_REDIRECT_URI
  ].some(Boolean);
  if (githubOAuthConfigured) {
    if (!parsed.GITHUB_OAUTH_CLIENT_ID) {
      throw new Error("GITHUB_OAUTH_CLIENT_ID is required when GitHub OAuth is configured.");
    }
    if (!parsed.GITHUB_OAUTH_CLIENT_SECRET) {
      throw new Error("GITHUB_OAUTH_CLIENT_SECRET is required when GitHub OAuth is configured.");
    }
    if (!parsed.GITHUB_OAUTH_REDIRECT_URI) {
      throw new Error("GITHUB_OAUTH_REDIRECT_URI is required when GitHub OAuth is configured.");
    }
  }

  const notionOAuthConfigured = [
    parsed.NOTION_OAUTH_CLIENT_ID,
    parsed.NOTION_OAUTH_CLIENT_SECRET,
    parsed.NOTION_OAUTH_REDIRECT_URI
  ].some(Boolean);
  if (notionOAuthConfigured) {
    if (!parsed.NOTION_OAUTH_CLIENT_ID) {
      throw new Error("NOTION_OAUTH_CLIENT_ID is required when Notion OAuth is configured.");
    }
    if (!parsed.NOTION_OAUTH_CLIENT_SECRET) {
      throw new Error("NOTION_OAUTH_CLIENT_SECRET is required when Notion OAuth is configured.");
    }
    if (!parsed.NOTION_OAUTH_REDIRECT_URI) {
      throw new Error("NOTION_OAUTH_REDIRECT_URI is required when Notion OAuth is configured.");
    }
  }

  // Set E2B_TEMPLATE_ID via env after running `make e2b-build-codex`. The
  // default in codex-release.json is the placeholder string `replace-with-
  // your-template-id` — booting against E2B with the placeholder would fail
  // opaquely in `Sandbox.create()`, so we surface a clearer error here.
  const e2bTemplateIdLooksUnset =
    !parsed.E2B_TEMPLATE_ID || parsed.E2B_TEMPLATE_ID === "replace-with-your-template-id";

  if (parsed.RUNTIME_BACKEND === "e2b") {
    if (!parsed.E2B_API_KEY) {
      throw new Error("E2B_API_KEY is required when RUNTIME_BACKEND=e2b.");
    }
    if (e2bTemplateIdLooksUnset) {
      throw new Error(
        "E2B_TEMPLATE_ID is not configured for RUNTIME_BACKEND=e2b. " +
          "Run `make e2b-build-codex` to build a template in your own E2B account, " +
          "then set E2B_TEMPLATE_ID to the printed template id (or commit the updated " +
          "apps/backend/src/codex-release.json so the default picks it up)."
      );
    }
    const gatewayUrl = parsed.RUNTIME_GATEWAY_BASE_URL.toLowerCase();
    if (gatewayUrl.includes("127.0.0.1") || gatewayUrl.includes("localhost")) {
      logger.warn(
        { gatewayUrl: parsed.RUNTIME_GATEWAY_BASE_URL, runtimeBackend: parsed.RUNTIME_BACKEND },
        "RUNTIME_GATEWAY_BASE_URL points to localhost while RUNTIME_BACKEND=e2b. " +
          "E2B sandboxes cannot reach localhost — MCP tool calls from the agent will fail. " +
          "Use a tunnel (ngrok, cloudflared) or a public URL for full functionality."
      );
    }
  }

  if (parsed.CLAUDE_RUNTIME_BACKEND === "e2b") {
    if (!parsed.E2B_API_KEY) {
      throw new Error("E2B_API_KEY is required when CLAUDE_RUNTIME_BACKEND=e2b.");
    }
    if (e2bTemplateIdLooksUnset) {
      throw new Error(
        "E2B_TEMPLATE_ID is not configured for CLAUDE_RUNTIME_BACKEND=e2b. " +
          "Run `make e2b-build-codex` to build a template in your own E2B account, " +
          "then set E2B_TEMPLATE_ID to the printed template id (or commit the updated " +
          "apps/backend/src/codex-release.json so the default picks it up)."
      );
    }
  }

  if (parsed.PII_PROVIDER_ENABLED && !parsed.PII_OPENROUTER_API_KEY) {
    throw new Error(
      "PII_OPENROUTER_API_KEY is required when PII_PROVIDER_ENABLED=true."
    );
  }

  const hasBucketAccessKey = Boolean(parsed.ARTIFACT_BUCKET_ACCESS_KEY_ID);
  const hasBucketSecretKey = Boolean(parsed.ARTIFACT_BUCKET_SECRET_ACCESS_KEY);
  if (hasBucketAccessKey !== hasBucketSecretKey) {
    throw new Error(
      "ARTIFACT_BUCKET_ACCESS_KEY_ID and ARTIFACT_BUCKET_SECRET_ACCESS_KEY must be provided together."
    );
  }

  return {
    ...parsed,
    ADMIN_USER_IDS:
      parsed.ADMIN_USER_IDS?.split(",")
        .map((entry) => entry.trim())
        .filter(Boolean) ?? [parsed.LOCAL_DEV_USER_ID],
    RUNTIME_WORKSPACE_ROOT: resolvedRuntimeWorkspaceRoot,
    ARTIFACT_STORAGE_ROOT: resolvedArtifactStorageRoot,
    SKILL_BUNDLE_STORAGE_ROOT: resolvedSkillBundleStorageRoot
  };
}
