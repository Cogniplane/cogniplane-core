import type { FastifyBaseLogger } from "fastify";

import type { ModelProvider } from "@cogniplane/shared-types";

import type { AppConfig } from "../config.js";
import { buildProviderCredentials } from "./runtime/provider-credentials.js";
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
      sessions: stores.sessions,
      skillRevisions: stores.skillRevisions,
      mcpServers: stores.mcpServers,
      tenantSettings: stores.tenantSettings
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

  // Request stores use the RLS pool. Provider-key resolution and background PII
  // policy reads use the privileged pool because they run outside request scope.
  const tenantOrgSettings = new TenantOrgSettingsStore(db, config.DATA_ENCRYPTION_SECRET);
  const tenantOrgSettingsPrivileged = new TenantOrgSettingsStore(
    privilegedDb,
    config.DATA_ENCRYPTION_SECRET
  );

  const getTenantAnthropicApiKey = (tenantId: string): Promise<string | null> =>
    tenantOrgSettingsPrivileged.getDecryptedApiKey(tenantId, "anthropic");
  // Provider-aware tenant key lookup (privileged — bypasses RLS like the
  // Anthropic-only lookup above). Feeds the ProviderCredentials resolver used
  // by the runtime and the presence checkers.
  const getTenantProviderKey = (
    tenantId: string,
    provider: ModelProvider
  ): Promise<string | null> => tenantOrgSettingsPrivileged.getDecryptedApiKey(tenantId, provider);
  const providerCredentials = buildProviderCredentials({
    config,
    getTenantProviderKey
  });

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
    getTenantProviderKey,
    providerCredentials
  };
}
