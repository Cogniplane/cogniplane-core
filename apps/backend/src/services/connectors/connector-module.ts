// Core-owned shape of a built-in connector module.
//
// A built-in connector (GitHub, Notion, Jira) registers through the same steps
// as an overlay `bootstrap` (see `overlay-contracts.ts`). It builds its own
// store and service, registers its integration descriptor and live hooks,
// registers its managed tools, and returns `attachRoutes`. Core stores, tool
// factory dependencies, and route wiring have no slot for one connector.
//
// The input is the overlay input with the full core config and a logger:
// built-in connectors read their settings from `AppConfig`. Overlays keep the
// narrow `OverlayConfig`.

import type { FastifyBaseLogger, FastifyInstance } from "fastify";

import type { AppConfig } from "../../config.js";
import type { AttachOverlaysInput } from "../../overlay-contracts.js";
import {
  getIntegrationDescriptor,
  registerIntegration,
  type IntegrationDescriptor
} from "../integrations/integration-registry.js";
import type { ManagedToolFactory } from "../managed-tools/factory.js";
import { asCatalogEntries, type RawCatalogEntry } from "../managed-tools/register-builtin-managed-tools.js";

export type BuiltinConnectorInput = Omit<AttachOverlaysInput, "config"> & {
  config: AppConfig;
  logger: Pick<FastifyBaseLogger, "warn">;
};

export type BuiltinConnectorHandles = {
  // `app-bootstrap.ts` calls this once, with the other core route groups.
  // OAuth callbacks are not here: they register from the integration registry.
  attachRoutes: (app: FastifyInstance) => void | Promise<void>;
};

/** Called once per `buildAppDependencies()`. Each call must return handles for that app only. */
export type BuiltinConnectorModule<THandles extends BuiltinConnectorHandles = BuiltinConnectorHandles> =
  (input: BuiltinConnectorInput) => THandles;

export type ConnectorCatalogDescriptor = Parameters<typeof registerIntegration>[0];

// Same steps as an overlay: add the static catalog entry once per process,
// add it to this app's registry, then attach this app's live hooks.
export function registerConnectorIntegration(
  registry: BuiltinConnectorInput["integrationDescriptors"],
  descriptor: ConnectorCatalogDescriptor,
  wiring: Pick<IntegrationDescriptor, "connectionProbe" | "oauthRoutes">
): void {
  if (!getIntegrationDescriptor(descriptor.id)) registerIntegration(descriptor);
  if (!registry.get(descriptor.id)) registry.register(descriptor);
  registry.setRuntimeWiring(descriptor.id, wiring);
}

// The catalog category and the factory domain key must be the same value. The
// graph evaluates Policy Center before a call with the catalog category, and
// the gateway evaluates it again with the factory domain key. Integration
// tools are not tenant-configurable: the integration toggles govern them.
export function registerConnectorTools(
  registries: Pick<BuiltinConnectorInput, "managedToolCatalog" | "managedToolFactoryRegistry">,
  domain: string,
  catalog: ReadonlyArray<RawCatalogEntry>,
  factory: ManagedToolFactory
): void {
  registries.managedToolCatalog.register(asCatalogEntries(catalog, false, domain));
  registries.managedToolFactoryRegistry.register(domain, factory);
}
