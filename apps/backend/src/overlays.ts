// OSS stub. The private working tree carries a real `overlays.ts` that
// imports private overlay packages (e.g. SharePoint). When the sync script
// builds the public mirror, it replaces the private file with this stub so
// the OSS build has nothing to import.
//
// Adding your own overlay? See docs/overlays.md for the full walkthrough
// (registries, descriptor lifecycle, OAuth allowlist propagation, package
// layout). Short version: import your overlay package's `bootstrap`, call
// it with the supplied input, and have `attachRoutes` register its routes
// against the host Fastify app.

import type { FastifyInstance } from "fastify";

import type { AppConfig } from "./config.js";
import type { Pool } from "./lib/db.js";
import type { ArtifactStorage } from "./services/artifacts/artifact-storage.js";
import type { ArtifactStore } from "./services/artifacts/artifact-store.js";
import type { AuditEventStore } from "./services/audit-event-store.js";
import type { IntegrationStateStore } from "./services/integrations/integration-state-store.js";
import type { RuntimeInvalidator } from "./services/integrations/contracts.js";
import type { SessionStore } from "./services/session-store.js";
import type { ManagedToolCatalog } from "./services/managed-tools/catalog.js";
import type { ManagedToolFactoryRegistry } from "./services/managed-tools/factory.js";
import type { PiiArtifactScanEnqueuer } from "./services/pii/pii-artifact-scan-enqueuer.js";

export type AttachOverlaysInput = {
  config: AppConfig;
  db: Pool;
  artifactStorage: ArtifactStorage;
  stores: {
    artifacts: ArtifactStore;
    auditEvents: AuditEventStore;
    integrationStates: IntegrationStateStore;
    sessions: SessionStore;
  };
  piiScanEnqueuer: PiiArtifactScanEnqueuer;
  runtimeInvalidator: RuntimeInvalidator;
  managedToolCatalog: ManagedToolCatalog;
  managedToolFactoryRegistry: ManagedToolFactoryRegistry;
};

export type OverlayHandles = {
  attachRoutes: (app: FastifyInstance) => void;
  // Optional probe — overlays that integrate Microsoft tenants populate
  // this so core can answer "is Microsoft configured?" without knowing
  // the overlay's internals. Absent in the OSS build.
  getMicrosoftConfigured?: (tenantId: string, userId: string) => Promise<boolean>;
};

export function attachOverlays(_input: AttachOverlaysInput): OverlayHandles {
  return {
    attachRoutes: () => {}
  };
}
