// Host entry point for the unit tests of overlay packages: the fakes, and the
// core classes that a test needs to build an overlay input or a route control.
// Overlay source files import from `overlay-sdk.ts`, not from this file.
// `overlay-sdk.test.ts` enforces both rules.

export { createTestConfig } from "./test-config.js";
export { devDataRoutes } from "./data-routes.js";
export { FakeRefreshTokenRedis } from "./fake-refresh-token-redis.js";
export { InMemoryAuditEventStore } from "./in-memory-audit-events.js";

// The parts of an overlay input.
export type { ArtifactStore } from "../services/artifacts/artifact-store.js";
export { UploadAdmission } from "../services/artifacts/upload-admission.js";
export {
  __resetIntegrationRegistryForTesting,
  IntegrationRegistry
} from "../services/integrations/integration-registry.js";
export {
  IntegrationStateStore,
  type IntegrationStateRecord
} from "../services/integrations/integration-state-store.js";
export { ManagedToolCatalog } from "../services/managed-tools/catalog.js";
export {
  ManagedToolFactoryRegistry,
  type ManagedToolFactoryDeps
} from "../services/managed-tools/factory.js";
export { PiiImportScopeRegistry } from "../services/pii/pii-import-scopes.js";
export type { LimitExceededErrorPayload } from "../services/request-limits.js";
export type { ToolExecutionContext } from "../services/auth/tool-execution-context-store.js";

// Step-up and owner notice of a data route.
export type { LocalAuth } from "../services/auth/local-auth.js";
export { RefreshTokenRotationService } from "../services/auth/refresh-token-rotation-service.js";
export { OVERLAY_STEP_UP_ACTIONS, type OverlayStepUpAction } from "../services/auth/step-up-routes.js";
export { StepUpStore } from "../services/auth/step-up-store.js";
export { DataRouteControl } from "../services/data-route-control.js";
export { MailOutbox, type OwnerNoticeQueue } from "../services/mail/mail-outbox.js";
export type { DataSettingChange } from "../services/mail/setting-change-notices.js";
