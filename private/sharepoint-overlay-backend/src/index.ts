import type { FastifyInstance } from "fastify";

import type {
  AttachOverlaysInput,
  OverlayHandles,
  OverlayRouteControls
} from "../../../apps/backend/src/overlay-contracts.js";
import { getIntegrationDescriptor } from "../../../apps/backend/src/services/integrations/integration-registry.js";

import {
  attachMicrosoftRuntimeWiring,
  registerMicrosoftDescriptor
} from "./integrations/register-microsoft-descriptor.js";
import type { ManagedToolCatalogEntry } from "../../../apps/backend/src/services/managed-tools/catalog.js";
import { createSharepointTools, SHAREPOINT_TOOL_CATALOG } from "./managed-tools/sharepoint-tools.js";
import { loadOverlayConfig } from "./config.js";
import { registerMicrosoftFileRoutes } from "./routes/microsoft-files.js";
import { registerMicrosoftSettingsRoutes } from "./routes/microsoft-settings-routes.js";
import { registerMicrosoftTenantRoutes } from "./routes/microsoft-tenant-routes.js";
import { MicrosoftConnectionService } from "./services/microsoft-connection-service.js";
import { MicrosoftConnectionStore } from "./services/microsoft-connection-store.js";
import { MICROSOFT_IMPORT_PII_SCOPE, MicrosoftFilesService } from "./services/microsoft-files-service.js";

// Bootstrap the SharePoint / Microsoft 365 overlay. Implements the core-owned
// `OverlayBootstrap` contract; the host shim `apps/backend/src/overlays.ts`
// assigns it to `attachOverlays`. Core receives only `OverlayHandles`. The
// connection and files services stay inside this package.
//
// On the OSS subset (no overlay), the host's shim is the public-overrides
// stub that does nothing; the descriptor isn't registered, no SharePoint
// catalog/factory are added, and no Microsoft routes appear.

// Policy Center category of every SharePoint tool.
const SHAREPOINT_TOOL_DOMAIN = "sharepoint";

export function bootstrap(input: AttachOverlaysInput): OverlayHandles {
  const overlayConfig = loadOverlayConfig();
  const microsoftConnectionStore = new MicrosoftConnectionStore(input.db);
  const microsoftConnectionService = new MicrosoftConnectionService(
    input.config,
    microsoftConnectionStore,
    input.stores.auditEvents,
    input.runtimeInvalidator,
    input.stores.integrationStates,
    overlayConfig.MICROSOFT_OAUTH_REDIRECT_URI,
    input.oauthStates
  );
  const microsoftFilesService = new MicrosoftFilesService({
    microsoftConnections: microsoftConnectionService,
    uploadAdmission: input.uploadAdmission,
    maxImportBytes: input.config.ARTIFACT_MAX_UPLOAD_BYTES
  });

  // Microsoft imports have their own toggle in the tenant PII policy.
  input.piiImportScopes.register(MICROSOFT_IMPORT_PII_SCOPE);

  if (!getIntegrationDescriptor("microsoft")) {
    registerMicrosoftDescriptor();
  }
  attachMicrosoftRuntimeWiring(input.integrationDescriptors, {
    probe: microsoftConnectionService,
    oauthCallback: microsoftConnectionService,
    limits: input.limits
  });

  // Tool catalog + factory live on shared instances constructed once per app
  // build; registering here is a fresh-instance operation, not idempotent
  // global state.
  // The catalog category and the factory domain key must be the same value.
  // The graph evaluates Policy Center before a call with the catalog category,
  // and the gateway evaluates it again with the factory domain key.
  input.managedToolCatalog.register(
    SHAREPOINT_TOOL_CATALOG.map((entry): ManagedToolCatalogEntry => ({
      name: entry.name,
      description: entry.description,
      readOnly: entry.readOnly,
      tenantConfigurable: false,
      category: SHAREPOINT_TOOL_DOMAIN
    }))
  );
  input.managedToolFactoryRegistry.register(SHAREPOINT_TOOL_DOMAIN, (coreDeps) =>
    createSharepointTools({
      microsoftConnections: microsoftConnectionService,
      microsoftFiles: microsoftFilesService,
      storage: coreDeps.storage,
      writeRuntimeFile: coreDeps.writeRuntimeFile
    })
  );

  const attachRoutes = (app: FastifyInstance, controls: OverlayRouteControls): void => {
    registerMicrosoftSettingsRoutes(app, {
      microsoftConnections: microsoftConnectionService,
      loadIntegrationEnablement: input.loadIntegrationEnablement
    });
    registerMicrosoftTenantRoutes(app, {
      microsoftConnections: microsoftConnectionService,
      auditEvents: input.stores.auditEvents,
      runtimeInvalidator: input.runtimeInvalidator,
      dataRoutes: controls.dataRoutes
    });
    registerMicrosoftFileRoutes(app, {
      microsoftFiles: microsoftFilesService,
      limits: input.limits,
      loadIntegrationEnablement: input.loadIntegrationEnablement
    });
  };

  return { attachRoutes };
}
