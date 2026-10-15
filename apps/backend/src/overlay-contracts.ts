// Core-owned overlay contract.
//
// Core owns these types. `overlays.ts` (private shim or public no-op stub) and
// every overlay `bootstrap` implement `OverlayBootstrap`. Do not import overlay
// packages or `private/` paths here: the public mirror ships this file.
//
// Each capability is the narrow set of methods that current overlays call.
// These types keep the compile-time surface small. They are not a sandbox: an
// overlay runs in the backend process and can import any backend module.

import type { FastifyInstance } from "fastify";

import type { AppConfig } from "./config.js";
import type { Pool } from "./lib/db.js";
import type { UploadAdmission } from "./services/artifacts/upload-admission.js";
import type { AuditEventStore } from "./services/audit-event-store.js";
import type { RuntimeInvalidator, TenantRuntimeInvalidator } from "./services/integrations/contracts.js";
import type { IntegrationEnablement } from "./services/integrations/integration-enablement.js";
import type { IntegrationOAuthStateStore } from "./services/integrations/integration-oauth-state-store.js";
import type { IntegrationRegistry } from "./services/integrations/integration-registry.js";
import type { IntegrationStateStore } from "./services/integrations/integration-state-store.js";
import type { ManagedToolCatalog } from "./services/managed-tools/catalog.js";
import type { ManagedToolFactoryRegistry } from "./services/managed-tools/factory.js";
import type { RequestLimitsInterface } from "./services/request-limits.js";

/** Settings an overlay needs for OAuth state JWTs, secret encryption, and redirects. */
export type OverlayConfig = Pick<
  AppConfig,
  | "API_ORIGIN"
  | "DATA_ENCRYPTION_SECRET"
  | "JWT_SECRET"
  | "JWT_KEY_ID"
  | "JWT_VERIFICATION_KEYS"
  | "ARTIFACT_MAX_UPLOAD_BYTES"
>;

export type AttachOverlaysInput = {
  config: OverlayConfig;
  // RLS-constrained pool for overlay-owned tables. Use `withTenantScope`.
  db: Pool;
  // The only way an overlay adds files to a session: access checks and the
  // PII scan come with it.
  uploadAdmission: Pick<UploadAdmission, "begin" | "admit">;
  stores: {
    auditEvents: Pick<AuditEventStore, "create">;
    integrationStates: Pick<IntegrationStateStore, "get" | "upsert">;
  };
  // Per-app registry. Attach live probes and OAuth routes here; the static
  // catalog (`registerIntegration`) stays module-global for auth allowlists.
  integrationDescriptors: Pick<IntegrationRegistry, "get" | "register" | "setRuntimeWiring">;
  // Tenant toggles plus platform status, resolved with the full core config.
  loadIntegrationEnablement: (tenantId: string, integrationId: string) => Promise<IntegrationEnablement>;
  // Shared single-use OAuth state store (Redis-backed when Redis is set).
  oauthStates: Pick<IntegrationOAuthStateStore, "issue" | "consume">;
  runtimeInvalidator: RuntimeInvalidator & TenantRuntimeInvalidator;
  managedToolCatalog: Pick<ManagedToolCatalog, "register">;
  managedToolFactoryRegistry: Pick<ManagedToolFactoryRegistry, "register">;
  // Shared rate limiter for overlay routes (OAuth callbacks, file imports).
  limits?: Pick<RequestLimitsInterface, "consumeRateLimit">;
};

export type OverlayHandles = {
  // `app-bootstrap.ts` calls this once, after every core route group.
  attachRoutes: (app: FastifyInstance) => void;
  // Optional probe for the tenant settings response. Absent in the OSS build.
  getMicrosoftConfigured?: (tenantId: string, userId: string) => Promise<boolean>;
};

/** Called once per `buildAppDependencies()`. Each call must return handles for that app only. */
export type OverlayBootstrap = (input: AttachOverlaysInput) => OverlayHandles;
