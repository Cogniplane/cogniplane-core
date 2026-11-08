import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../../config.js";
import type { Pool } from "../../lib/db.js";
import type { getRedis } from "../../lib/redis.js";
import type { ArtifactStorage } from "../artifacts/artifact-storage.js";
import type { TenantOrgSettingsStore } from "../tenant-org-settings-store.js";

import { OpenAiCompatiblePiiProvider } from "./openai-compatible-pii-provider.js";
import { createPdfOcr } from "./pdf-ocr.js";
import {
  DisabledPiiCircuitBreaker,
  createPiiCircuitBreaker,
  type PiiCircuitBreaker
} from "./pii-circuit-breaker.js";
import { Aes256GcmFindingEncryptor } from "./pii-finding-encryption.js";
import type { PiiImportScopeRegistry } from "./pii-import-scopes.js";
import { PiiProtectionService, type PiiPolicyReader } from "./pii-protection-service.js";
import { PiiArtifactScanEnqueuer } from "./pii-artifact-scan-enqueuer.js";
import { PiiScanJobHandler } from "./pii-scan-job-handler.js";
import { DatabasePiiScanSubjectReader } from "./pii-scan-subject-reader.js";
import { RuleBasedPiiDetector } from "./rule-based-pii-detector.js";
import type { PdfTextExtractor } from "./scannable-text.js";

import type { Stores } from "../build-stores.js";

/** Reads the stored policy and its revision from one row read, so they always match. */
export function piiPolicyReader(settings: Pick<TenantOrgSettingsStore, "get">): PiiPolicyReader {
  return {
    async readPiiProtection(tenantId) {
      const record = await settings.get(tenantId);
      return { stored: record.storedPiiProtection, revision: record.piiProtectionRevision };
    }
  };
}

export function buildPiiServices(input: {
  config: AppConfig;
  logger: FastifyBaseLogger;
  db: Pool;
  stores: Stores;
  artifactStorage: ArtifactStorage;
  tenantOrgSettingsPrivileged: TenantOrgSettingsStore;
  redis: ReturnType<typeof getRedis>;
  extractPdfText: PdfTextExtractor;
  // Read at scan time: overlays register after this call, before requests.
  importScopes: PiiImportScopeRegistry;
}) {
  const { config, logger, db, stores, artifactStorage, tenantOrgSettingsPrivileged, redis, extractPdfText, importScopes } = input;

  const piiCircuitBreaker: PiiCircuitBreaker = config.PII_BREAKER_ENABLED
    ? createPiiCircuitBreaker({
        redis,
        name: "pii-llm",
        failureThreshold: config.PII_BREAKER_FAILURE_THRESHOLD,
        windowMs: config.PII_BREAKER_WINDOW_MS,
        cooldownMs: config.PII_BREAKER_COOLDOWN_MS,
        logger,
        events: stores.platformEvents
      })
    : new DisabledPiiCircuitBreaker();

  const piiProvider = config.PII_PROVIDER_ENABLED && config.PII_LLM_API_KEY
    ? new OpenAiCompatiblePiiProvider({
        baseUrl: config.PII_LLM_BASE_URL,
        apiKey: config.PII_LLM_API_KEY,
        model: config.PII_LLM_MODEL,
        timeoutMs: config.PII_PROVIDER_TIMEOUT_MS,
        wireFormat: config.PII_LLM_WIRE_FORMAT,
        disableThinking: config.PII_LLM_DISABLE_THINKING,
        breaker: piiCircuitBreaker
      })
    : undefined;

  // Local OCR of PDF pages. Off by default: the scan reads only PDF text.
  const pdfOcr = config.PII_PDF_OCR_ENABLED
    ? createPdfOcr({
        pdfinfoPath: config.PDFINFO_BINARY_PATH,
        pdftoppmPath: config.PDFTOPPM_BINARY_PATH,
        tesseractPath: config.TESSERACT_BINARY_PATH,
        languages: config.PII_PDF_OCR_LANGUAGES,
        maxPages: config.PII_PDF_OCR_MAX_PAGES,
        timeoutMs: config.PII_PDF_OCR_TIMEOUT_MS,
        maxConcurrent: config.PII_PDF_OCR_MAX_CONCURRENT,
        maxTextBytes: config.PII_ARTIFACT_MAX_BYTES,
        logger
      })
    : undefined;

  const piiSubjectReader = new DatabasePiiScanSubjectReader({
    db,
    artifacts: stores.artifacts,
    storage: artifactStorage,
    // Same source as the service-level cap, so the stream-time guard never
    // rejects an artifact the configured policy would otherwise allow.
    maxBytes: config.PII_ARTIFACT_MAX_BYTES,
    extractPdfText,
    ocrPdf: pdfOcr
  });

  const findingEncryptor = config.PII_RETENTION_KEK
    ? new Aes256GcmFindingEncryptor(config.PII_RETENTION_KEK)
    : undefined;

  const piiProtection = new PiiProtectionService({
    policyReader: piiPolicyReader(tenantOrgSettingsPrivileged),
    ruleDetector: new RuleBasedPiiDetector(),
    provider: piiProvider,
    timeoutMs: config.PII_PROVIDER_TIMEOUT_MS,
    artifactMaxBytes: config.PII_ARTIFACT_MAX_BYTES,
    ...(pdfOcr ? { pdfOcrBudgetMs: config.PII_PDF_OCR_TIMEOUT_MS } : {}),
    csvPreviewRows: config.PII_CSV_PREVIEW_ROWS,
    csvPreviewMaxBytes: config.PII_CSV_PREVIEW_MAX_BYTES,
    findingEncryptor,
    importScopes,
    logger
  });

  const piiScanJobHandler = new PiiScanJobHandler({
    piiProtection,
    piiScanRuns: stores.piiScanRuns,
    piiScanJobs: stores.piiScanJobs,
    messages: stores.messages,
    artifacts: stores.artifacts,
    storage: artifactStorage,
    subjectReader: piiSubjectReader,
    auditEvents: stores.auditEvents,
    logger,
    importScopes
  });

  const piiScanEnqueuer = new PiiArtifactScanEnqueuer({
    piiProtection,
    piiScanRuns: stores.piiScanRuns,
    piiScanJobs: stores.piiScanJobs,
    artifacts: stores.artifacts,
    storage: artifactStorage,
    subjectReader: piiSubjectReader,
    auditEvents: stores.auditEvents,
    logger,
    importScopes
  });

  return { piiProtection, piiCircuitBreaker, piiScanJobHandler, piiScanEnqueuer, pdfOcr };
}
