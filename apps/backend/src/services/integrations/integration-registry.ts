// Integration descriptor registry.
//
// Each integration the platform knows about is registered here at boot.
// Per-tenant enablement lives in tenant_integrations (see migration 033);
// this registry declares what's available to enable in the first place.
//
// Adding a new integration:
//   1. Define an IntegrationDescriptor (typically near the connection
//      service, or in a dedicated module like ./github/github-integration.ts).
//   2. Register it from a bootstrap module (registerIntegration(...)).
//   3. (If status="available") register the matching tool catalog/factory
//      via managed-tools/factory.ts and managed-tools/catalog.ts so the
//      listed read/write tool ids resolve.
//   4. Drop the logo SVG at apps/frontend/public/integrations/<id>.svg
//      (frontend integration-logo.tsx already loads any slug dynamically).
//
// A private overlay package can register additional descriptors during its
// own boot init — without forking core.

import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../../config.js";

export type IntegrationStatus = "available" | "coming_soon";

export type IntegrationConfigMode = "none" | "oauth_app";

export type IntegrationConfigField = {
  key: string;
  label: string;
  type: "text" | "password" | "url";
  required: boolean;
  helpText?: string;
};

// Connection-presence probe used by `resolveSessionToolIds`. Returns true
// when the user has an active connection for this integration. Coming-soon
// descriptors and integrations that need no per-user connection (none today)
// can omit the probe entirely.
export type IntegrationConnectionProbe = {
  hasConnection(tenantId: string, userId: string): Promise<boolean>;
};

export type IntegrationPlatformStatus = {
  configured: boolean;
  // Operator-facing message describing what to set in env or per-tenant
  // config to flip the integration to `configured: true`. Null when the
  // integration is already configured (or has no platform-level setup).
  message: string | null;
};

// OAuth callback registration. Integrations that initiate OAuth flows
// receive callback paths through `registerOAuthRoutes`; the bootstrap
// owns the route registration so a private overlay's descriptor can ship
// its own callbacks without touching `routes/auth.ts`.
//
// `paths` is the static list of public callback URLs the auth middleware
// must let through. Both `paths` and `registerOAuthRoutes` are optional —
// integrations that don't use OAuth (e.g. coming-soon stubs, or future
// shared-secret integrations) can omit them.
export type IntegrationOAuthRoutes = {
  paths: readonly string[];
  register: (app: FastifyInstance) => void | Promise<void>;
};

export type IntegrationDescriptor = {
  id: string;
  name: string;
  description: string;
  longDescription: string;
  logoSlug: string;
  status: IntegrationStatus;
  category: string;
  readToolIds: readonly string[];
  writeToolIds: readonly string[];
  configMode: IntegrationConfigMode;
  configFields?: readonly IntegrationConfigField[];
  docsUrl?: string;
  // Hooks. The descriptor stays a plain data record; live wiring is
  // attached lazily by the bootstrap module so descriptors can ship from
  // a private overlay without dragging the connection service into core.
  connectionProbe?: IntegrationConnectionProbe;
  platformStatus?: (config: AppConfig) => IntegrationPlatformStatus;
  oauthRoutes?: IntegrationOAuthRoutes;
};

const registry = new Map<string, IntegrationDescriptor>();

export function registerIntegration(descriptor: IntegrationDescriptor): void {
  if (registry.has(descriptor.id)) {
    throw new Error(`Integration already registered: ${descriptor.id}`);
  }
  registry.set(descriptor.id, descriptor);
}

export function getIntegrationDescriptor(integrationId: string): IntegrationDescriptor | null {
  return registry.get(integrationId) ?? null;
}

export function listIntegrationDescriptors(): readonly IntegrationDescriptor[] {
  return Array.from(registry.values());
}

// Replace the live wiring (connection probe + OAuth routes) on an already-
// registered descriptor. Used by the bootstrap module to attach per-app
// hooks after the static descriptor data has been registered, and to
// re-attach hooks when a fresh `buildAppDependencies()` runs (e.g. tests
// that build multiple Fastify apps in one process). The static fields
// (id/name/readToolIds/...) are not touched.
export type IntegrationRuntimeWiring = Pick<
  IntegrationDescriptor,
  "connectionProbe" | "oauthRoutes"
>;

export function setIntegrationRuntimeWiring(
  integrationId: string,
  wiring: IntegrationRuntimeWiring
): void {
  const existing = registry.get(integrationId);
  if (!existing) {
    throw new Error(
      `Cannot attach runtime wiring to unregistered integration: ${integrationId}`
    );
  }
  registry.set(integrationId, {
    ...existing,
    connectionProbe: wiring.connectionProbe,
    oauthRoutes: wiring.oauthRoutes
  });
}

// Aggregated OAuth callback paths across every registered integration.
// Used by the auth middlewares to extend their public-path allowlist
// without hard-coding individual integration ids.
export function listIntegrationOAuthCallbackPaths(): readonly string[] {
  const paths: string[] = [];
  for (const descriptor of registry.values()) {
    if (!descriptor.oauthRoutes) continue;
    for (const path of descriptor.oauthRoutes.paths) paths.push(path);
  }
  return paths;
}

// Test-only: clear the registry between unit tests that exercise registration.
export function __resetIntegrationRegistryForTesting(): void {
  registry.clear();
}
