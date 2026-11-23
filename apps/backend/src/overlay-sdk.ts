// Host entry point for overlay packages.
//
// An overlay imports backend code only from this file and from
// `overlay-contracts.ts`. `overlay-sdk.test.ts` enforces that. So a file in
// core can move or change its name without a change in an overlay: only the
// paths in this file change.
//
// Each name here is a supported surface. Before you change the behavior or the
// signature of one, check the overlays that use it. Add a name when an overlay
// needs it; do not export a whole module. Core does not import this file.
//
// Overlay tests get their fakes and fixtures from
// `test-helpers/overlay-testing.ts` and `integration/support/overlay-testing.ts`.

// Database and tenant scope.
export { ensureUser, withTenantScope, type Pool } from "./lib/db.js";
export { uuidv7 } from "./lib/uuid.js";

// Routes: validation, responses, public errors, roles and audit events.
export { apiError, notFoundError } from "./lib/http-errors.js";
export { requireRole } from "./lib/rbac.js";
export { sessionIdParams } from "./lib/route-schemas.js";
export { parseRequestInput } from "./lib/route-validation.js";
export { serialize } from "./lib/serialize-response.js";
export { adminAuditEvent } from "./routes/admin/admin-route-helpers.js";
export { AuditEventStore, type AuditEventInput } from "./services/audit-event-store.js";
export type { RequestLimitsInterface } from "./services/request-limits.js";

// Stored secrets and the owner security version of a connection.
export { decrypt, encrypt } from "./lib/crypto-utils.js";
export {
  assertOwnerSecurityVersion,
  ConnectionConfirmError,
  connectionConfirmErrorStatus,
  connectionSaverVersion,
  OwnerSecurityVersionChangedError,
  ownerSecurityVersionSql
} from "./services/auth/security-change.js";

// Integration descriptor, state and connected account.
export type { RuntimeInvalidator, TenantRuntimeInvalidator } from "./services/integrations/contracts.js";
export {
  assertBoundIntegrationAccount,
  boundIntegrationAccount
} from "./services/integrations/integration-account-binding.js";
export {
  getIntegrationDescriptor,
  registerIntegration,
  type IntegrationConnectionProbe,
  type IntegrationOAuthRoutes
} from "./services/integrations/integration-registry.js";
export type { IntegrationStateStore } from "./services/integrations/integration-state-store.js";

// OAuth flow.
export {
  buildIntegrationRedirectUrl,
  createOAuthBrowserBinding,
  getSecretKey,
  getVerificationKey,
  mapOAuthProviderError,
  oauthBrowserBindingMatches,
  takeOAuthBrowserNonce,
  type OAuthBrowserBindingCookie
} from "./services/integrations/integration-oauth-helpers.js";
export { IntegrationOAuthStateStore } from "./services/integrations/integration-oauth-state-store.js";
export { enforceOAuthCallbackRateLimit } from "./services/integrations/oauth-callback-rate-limit.js";

// Managed tools.
export type { ManagedToolCatalogEntry } from "./services/managed-tools/catalog.js";
export {
  allRequiredObjectSchema,
  arraySchema,
  nullableNumberSchema,
  nullableStringSchema,
  safeJsonBody,
  strictObjectSchema,
  withManagedToolErrorSchema,
  type ManagedToolDefinition
} from "./services/managed-tools/types.js";

// File imports: artifacts, upload admission and their errors.
export { ALLOWED_ARTIFACT_MIME_TYPES } from "./lib/allowed-mime-types.js";
export type { ArtifactStorage } from "./services/artifacts/artifact-storage.js";
export { isArtifactPiiEligible, type ArtifactRecord } from "./services/artifacts/artifact-store.js";
export type { UploadAdmission } from "./services/artifacts/upload-admission.js";
export { PERMANENT_PII_ERROR_CODES } from "./services/pii/pii-scan-job-handler.js";
export { ProjectAccessError } from "./services/project-access.js";
export { SessionUploadAccessError } from "./services/session-upload-access.js";
