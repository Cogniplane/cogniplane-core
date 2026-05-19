import type { AppConfig } from "../../config.js";
import type { Pool } from "../../lib/db.js";
import type { RuntimeInvalidator } from "./contracts.js";
import { GithubConnectionService } from "./github/github-connection-service.js";
import { IntegrationRegistryService } from "./integration-registry-service.js";
import { NotionConnectionService } from "./notion/notion-connection-service.js";
import {
  attachBuiltinIntegrationRuntime,
  registerBuiltinIntegrations
} from "./register-builtin-integrations.js";

import type { Stores } from "../build-stores.js";

export function buildIntegrationServices(
  config: AppConfig,
  db: Pool,
  stores: Stores,
  // Lazy getter that returns the live `RuntimeInvalidator` once it's been
  // constructed. Called only inside async OAuth/disconnect paths, never at
  // module load — so the runtime manager can be wired *after* this builder
  // runs without any setter dance. Throws if invoked before the runtime
  // manager exists, which would indicate a wiring bug.
  resolveRuntimeInvalidator: () => RuntimeInvalidator
) {
  const runtimeInvalidator: RuntimeInvalidator = {
    invalidateRuntimesForIntegration(tenantId, userId, integrationId) {
      return resolveRuntimeInvalidator().invalidateRuntimesForIntegration(
        tenantId,
        userId,
        integrationId
      );
    }
  };

  const githubConnectionService = new GithubConnectionService(
    config,
    db,
    stores.githubConnections,
    stores.auditEvents,
    runtimeInvalidator
  );
  const notionConnectionService = new NotionConnectionService(
    config,
    stores.notionConnections,
    stores.auditEvents,
    runtimeInvalidator
  );

  // Register the built-in integration descriptors (idempotent across
  // multiple `buildAppDependencies()` calls) and attach this app's live
  // wiring (connection probes + OAuth callback handlers). The attach
  // step always runs so a fresh app-dependencies build replaces any
  // wiring captured by a previous build (matters in tests that spin up
  // multiple Fastify apps in one process). Private overlay packages
  // (e.g. SharePoint) register their additional descriptors via the
  // overlay shim in `attachOverlays` below.
  registerBuiltinIntegrations();
  attachBuiltinIntegrationRuntime({
    probes: {
      notion: notionConnectionService,
      github: githubConnectionService
    },
    oauth: {
      notion: notionConnectionService,
      github: githubConnectionService
    }
  });

  const integrationRegistry = new IntegrationRegistryService(config, stores.integrationStates);

  return {
    githubConnectionService,
    runtimeInvalidator,
    notionConnectionService,
    integrationRegistry
  };
}

export type IntegrationServices = ReturnType<typeof buildIntegrationServices>;
