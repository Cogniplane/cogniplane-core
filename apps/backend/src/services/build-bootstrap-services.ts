import type { FastifyBaseLogger } from "fastify";

import type { AppConfig } from "../config.js";
import type { Pool } from "../lib/db.js";
import { getRedis } from "../lib/redis.js";
import { ArtifactProcessor } from "./artifacts/artifact-processor.js";
import { createArtifactStorage } from "./artifacts/artifact-storage.js";
import { DynamicConfigService } from "./dynamic-config-service.js";
import type { ManagedToolCatalog } from "./managed-tools/catalog.js";
import { RedisRequestLimits } from "./redis-request-limits.js";
import { RequestLimits, type RequestLimitsInterface } from "./request-limits.js";
import { createSkillBundleStorage } from "./skills/skill-bundle-storage.js";
import { SkillMarketplaceService } from "./skills/skill-marketplace-service.js";
import { TenantOrgSettingsStore } from "./tenant-org-settings-store.js";

import type { Stores } from "./build-stores.js";

// Bootstrap-layer services that depend only on `config`, `db`, `logger`, and
// already-built stores: storage backends, dynamic config compiler, redis +
// rate limits, tenant-org-settings stores (RLS + privileged), per-tenant key
// getters. These are constructed once before the integration/runtime/PII
// builders run because everything downstream needs them.
export function buildBootstrapServices(input: {
  config: AppConfig;
  db: Pool;
  privilegedDb: Pool;
  logger: FastifyBaseLogger;
  stores: Stores;
  managedToolCatalog: ManagedToolCatalog;
}) {
  const { config, db, privilegedDb, logger, stores, managedToolCatalog } = input;

  const skillBundleStorage = createSkillBundleStorage(config);
  const artifactStorage = createArtifactStorage(config);
  const skillMarketplace = new SkillMarketplaceService(config);
  const dynamicConfig = new DynamicConfigService(
    config,
    {
      skills: stores.skills,
      skillRevisions: stores.skillRevisions,
      mcpServers: stores.mcpServers,
      tenantSettings: stores.tenantSettings,
      sessionRuntimeOverrides: stores.sessionRuntimeOverrides
    },
    skillBundleStorage,
    managedToolCatalog
  );
  const redis = getRedis(config, logger);
  const limits: RequestLimitsInterface = redis
    ? RedisRequestLimits.fromAppConfig(redis, config)
    : RequestLimits.fromAppConfig(config);
  if (!redis) {
    logger.warn(
      { authMode: config.AUTH_MODE },
      "Rate limits are running in per-process (in-memory) mode because REDIS_URL is not set. " +
        "Quotas will NOT be shared across backend instances — each instance enforces its own counter."
    );
  }
  const artifactProcessor = new ArtifactProcessor({
    config,
    logger,
    storage: artifactStorage
  });

  // Two TenantOrgSettingsStore instances are intentional: route-scoped reads
  // and writes go through `db` so they're subject to RLS, but bootstrap-time
  // reads (Anthropic key for `/models`, PII policy for the background scan
  // worker, OpenAI key forwarded into the runtime manager) run outside any
  // per-request tenant scope and need `privilegedDb` to bypass RLS.
  const tenantOrgSettings = new TenantOrgSettingsStore(db, config.DATA_ENCRYPTION_SECRET);
  const tenantOrgSettingsPrivileged = new TenantOrgSettingsStore(
    privilegedDb,
    config.DATA_ENCRYPTION_SECRET
  );

  const getTenantAnthropicApiKey = (tenantId: string): Promise<string | null> =>
    tenantOrgSettingsPrivileged.getDecryptedAnthropicApiKey(tenantId);
  const getTenantOpenaiApiKey = (tenantId: string): Promise<string | null> =>
    tenantOrgSettingsPrivileged.getDecryptedOpenaiApiKey(tenantId);

  return {
    skillBundleStorage,
    artifactStorage,
    skillMarketplace,
    dynamicConfig,
    redis,
    limits,
    artifactProcessor,
    tenantOrgSettings,
    tenantOrgSettingsPrivileged,
    getTenantAnthropicApiKey,
    getTenantOpenaiApiKey
  };
}

export type BootstrapServices = ReturnType<typeof buildBootstrapServices>;
