import type { FastifyBaseLogger } from "fastify";

import type { AppConfig } from "../../config.js";
import type { Pool } from "../../lib/db.js";
import type { getRedis } from "../../lib/redis.js";
import type { ArtifactStorage } from "../artifacts/artifact-storage.js";
import type { TenantOrgSettingsStore } from "../tenant-org-settings-store.js";

import { OpenRouterPiiProvider } from "./openrouter-pii-provider.js";
import {
  DisabledPiiCircuitBreaker,
  createPiiCircuitBreaker,
  type PiiCircuitBreaker
} from "./pii-circuit-breaker.js";
import { Aes256GcmFindingEncryptor } from "./pii-finding-encryption.js";
import { PiiProtectionService } from "./pii-protection-service.js";
import { PiiArtifactScanEnqueuer } from "./pii-artifact-scan-enqueuer.js";
import { PiiScanJobHandler } from "./pii-scan-job-handler.js";
import type { PiiProtectionSettings } from "./pii-policy.js";
import { DatabasePiiScanSubjectReader } from "./pii-scan-subject-reader.js";
import { RuleBasedPiiDetector } from "./rule-based-pii-detector.js";

import type { Stores } from "../build-stores.js";

export function buildPiiServices(input: {
  config: AppConfig;
  logger: FastifyBaseLogger;
  db: Pool;
  stores: Stores;
  artifactStorage: ArtifactStorage;
  tenantOrgSettingsPrivileged: TenantOrgSettingsStore;
  redis: ReturnType<typeof getRedis>;
}) {
  const { config, logger, db, stores, artifactStorage, tenantOrgSettingsPrivileged, redis } = input;

  const piiCircuitBreaker: PiiCircuitBreaker = config.PII_BREAKER_ENABLED
    ? createPiiCircuitBreaker({
        redis,
        name: "openrouter",
        failureThreshold: config.PII_BREAKER_FAILURE_THRESHOLD,
        windowMs: config.PII_BREAKER_WINDOW_MS,
        cooldownMs: config.PII_BREAKER_COOLDOWN_MS,
        logger,
        events: stores.platformEvents
      })
    : new DisabledPiiCircuitBreaker();

  const piiProvider = config.PII_PROVIDER_ENABLED && config.PII_OPENROUTER_API_KEY
    ? new OpenRouterPiiProvider({
        baseUrl: config.PII_OPENROUTER_BASE_URL,
        apiKey: config.PII_OPENROUTER_API_KEY,
        model: config.PII_OPENROUTER_MODEL,
        timeoutMs: config.PII_PROVIDER_TIMEOUT_MS,
        breaker: piiCircuitBreaker
      })
    : undefined;

  const piiSubjectReader = new DatabasePiiScanSubjectReader({
    db,
    messages: stores.messages,
    artifacts: stores.artifacts,
    storage: artifactStorage
  });

  const findingEncryptor = config.PII_RETENTION_KEK
    ? new Aes256GcmFindingEncryptor(config.PII_RETENTION_KEK)
    : undefined;

  const piiProtection = new PiiProtectionService({
    policyReader: {
      getPiiProtection: async (tenantId: string): Promise<PiiProtectionSettings | null> =>
        (await tenantOrgSettingsPrivileged.get(tenantId)).piiProtection
    },
    ruleDetector: new RuleBasedPiiDetector(),
    provider: piiProvider,
    timeoutMs: config.PII_PROVIDER_TIMEOUT_MS,
    artifactMaxBytes: config.PII_ARTIFACT_MAX_BYTES,
    csvPreviewRows: config.PII_CSV_PREVIEW_ROWS,
    csvPreviewMaxBytes: config.PII_CSV_PREVIEW_MAX_BYTES,
    findingEncryptor
  });

  const piiScanJobHandler = new PiiScanJobHandler({
    piiProtection,
    piiScanRuns: stores.piiScanRuns,
    piiScanJobs: stores.piiScanJobs,
    messages: stores.messages,
    artifacts: stores.artifacts,
    subjectReader: piiSubjectReader,
    auditEvents: stores.auditEvents,
    logger
  });

  const piiScanEnqueuer = new PiiArtifactScanEnqueuer({
    piiProtection,
    piiScanRuns: stores.piiScanRuns,
    piiScanJobs: stores.piiScanJobs,
    artifacts: stores.artifacts,
    subjectReader: piiSubjectReader,
    auditEvents: stores.auditEvents,
    logger
  });

  return { piiProtection, piiCircuitBreaker, piiScanJobHandler, piiScanEnqueuer };
}
