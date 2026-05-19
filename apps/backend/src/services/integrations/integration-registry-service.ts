import type { AppConfig } from "../../config.js";
import {
  getIntegrationDescriptor,
  listIntegrationDescriptors,
  type IntegrationConnectionProbe,
  type IntegrationDescriptor,
  type IntegrationConfigField,
  type IntegrationPlatformStatus
} from "./integration-registry.js";
import type { IntegrationStateRecord, IntegrationStateStore } from "./integration-state-store.js";

// Optional override map keyed by integration id. When a probe is supplied
// here it takes precedence over the descriptor-attached probe — handy for
// tests that want to swap probes per test without re-registering the whole
// descriptor.
export type IntegrationConnectionProbes = Record<string, IntegrationConnectionProbe>;

export type AdminIntegrationView = {
  id: string;
  name: string;
  description: string;
  longDescription: string;
  logoSlug: string;
  status: IntegrationDescriptor["status"];
  category: string;
  readToolIds: string[];
  writeToolIds: string[];
  configMode: IntegrationDescriptor["configMode"];
  configFields: IntegrationConfigField[] | undefined;
  docsUrl: string | undefined;

  readsEnabled: boolean;
  writesEnabled: boolean;
  hasConfig: boolean;
  configSummary: Record<string, string>;
  updatedAt: string | null;
  updatedBy: string | null;

  platformConfigured: boolean;
  platformConfigMessage: string | null;
};

export type UserIntegrationView = {
  id: string;
  name: string;
  logoSlug: string;
  category: string;
  readsEnabled: boolean;
  writesEnabled: boolean;
};

// Public so the same checks can power the /me/*-connection status endpoints.
// Coming-soon and unregistered descriptors are treated as "configured at the
// platform level" so the admin view doesn't surface noise for stubs.
export function getPlatformStatus(integrationId: string, config: AppConfig): IntegrationPlatformStatus {
  const descriptor = getIntegrationDescriptor(integrationId);
  if (!descriptor || !descriptor.platformStatus) {
    return { configured: true, message: null };
  }
  return descriptor.platformStatus(config);
}

function summarizeConfig(
  descriptor: IntegrationDescriptor,
  config: Record<string, unknown>
): Record<string, string> {
  if (!descriptor.configFields) return {};
  const summary: Record<string, string> = {};
  for (const field of descriptor.configFields) {
    if (field.type === "password") continue; // never expose secrets
    const value = config[field.key];
    if (typeof value === "string" && value.length > 0) {
      summary[field.key] = value;
    }
  }
  return summary;
}

// Whether the per-tenant config row carries everything this integration
// needs to be enabled. Mode rules:
//  - "none":      no per-tenant config required at all (tenant just toggles)
//  - "oauth_app": every required field must be a non-empty string in `config`
function hasRequiredConfig(
  descriptor: IntegrationDescriptor,
  config: Record<string, unknown>
): boolean {
  if (descriptor.configMode === "none") return true;
  if (!descriptor.configFields) return false;
  for (const field of descriptor.configFields) {
    if (!field.required) continue;
    const value = config[field.key];
    if (typeof value !== "string" || value.length === 0) return false;
  }
  return true;
}

export class IntegrationRegistryService {
  constructor(
    private readonly config: AppConfig,
    private readonly stateStore: IntegrationStateStore,
    private readonly probeOverrides: IntegrationConnectionProbes = {}
  ) {}

  private resolveProbe(descriptor: IntegrationDescriptor): IntegrationConnectionProbe | null {
    return this.probeOverrides[descriptor.id] ?? descriptor.connectionProbe ?? null;
  }

  listDescriptors(): readonly IntegrationDescriptor[] {
    return listIntegrationDescriptors();
  }

  // True when the tenant has an explicit row in tenant_integrations for the
  // given integration — the new admin page is authoritative for that tenant
  // and any legacy ad-hoc tool injections elsewhere should defer to it.
  async hasIntegrationState(tenantId: string, integrationId: string): Promise<boolean> {
    const state = await this.stateStore.get(tenantId, integrationId);
    return state !== null;
  }

  // Public readiness check used by both the admin GET list and PUT validation.
  // Pass `prospectiveConfig` to evaluate the gate against a config the caller
  // is about to write, instead of the row currently in the database.
  async isReadyToEnable(
    tenantId: string,
    integrationId: string,
    prospectiveConfig?: Record<string, unknown>
  ): Promise<boolean> {
    const descriptor = getIntegrationDescriptor(integrationId);
    if (!descriptor) return false;
    let config = prospectiveConfig;
    if (config === undefined) {
      const state = await this.stateStore.get(tenantId, integrationId);
      config = state?.config ?? {};
    }
    return hasRequiredConfig(descriptor, config);
  }

  async getIntegrationsForAdmin(tenantId: string): Promise<AdminIntegrationView[]> {
    const states = await this.stateStore.list(tenantId);
    const stateById = new Map<string, IntegrationStateRecord>();
    for (const state of states) stateById.set(state.integrationId, state);

    return listIntegrationDescriptors().map((descriptor) => {
      const state = stateById.get(descriptor.id);
      const config = state?.config ?? {};
      const platform = getPlatformStatus(descriptor.id, this.config);
      const isAvailable = descriptor.status === "available";

      return {
        id: descriptor.id,
        name: descriptor.name,
        description: descriptor.description,
        longDescription: descriptor.longDescription,
        logoSlug: descriptor.logoSlug,
        status: descriptor.status,
        category: descriptor.category,
        readToolIds: [...descriptor.readToolIds],
        writeToolIds: [...descriptor.writeToolIds],
        configMode: descriptor.configMode,
        configFields: descriptor.configFields ? [...descriptor.configFields] : undefined,
        docsUrl: descriptor.docsUrl,

        readsEnabled: isAvailable && (state?.readsEnabled ?? false),
        writesEnabled: isAvailable && (state?.writesEnabled ?? false),
        hasConfig: hasRequiredConfig(descriptor, config),
        configSummary: summarizeConfig(descriptor, config),
        updatedAt: state?.updatedAt ?? null,
        updatedBy: state?.updatedBy ?? null,

        platformConfigured: platform.configured,
        platformConfigMessage: platform.message
      } satisfies AdminIntegrationView;
    });
  }

  async getIntegrationsForUser(
    tenantId: string,
    _userId: string
  ): Promise<UserIntegrationView[]> {
    const states = await this.stateStore.list(tenantId);
    const stateById = new Map<string, IntegrationStateRecord>();
    for (const state of states) stateById.set(state.integrationId, state);

    return listIntegrationDescriptors()
      .filter((descriptor) => descriptor.status === "available")
      .map((descriptor) => {
        const state = stateById.get(descriptor.id);
        return {
          id: descriptor.id,
          name: descriptor.name,
          logoSlug: descriptor.logoSlug,
          category: descriptor.category,
          readsEnabled: state?.readsEnabled ?? false,
          writesEnabled: state?.writesEnabled ?? false
        };
      })
      .filter((view) => view.readsEnabled || view.writesEnabled);
  }

  // Computes the integration tool ids for a session start. Toggle rule:
  //   reads_enabled  AND user has connection => include readToolIds
  //   writes_enabled AND user has connection => include writeToolIds
  // Coming-soon integrations contribute nothing (their tool id arrays are empty).
  async resolveSessionToolIds(tenantId: string, userId: string): Promise<string[]> {
    const states = await this.stateStore.list(tenantId);
    if (states.length === 0) return [];

    const collected: string[] = [];
    for (const state of states) {
      if (!state.readsEnabled && !state.writesEnabled) continue;
      const descriptor = getIntegrationDescriptor(state.integrationId);
      if (!descriptor || descriptor.status !== "available") continue;

      const probe = this.resolveProbe(descriptor);
      const connected = probe ? await probe.hasConnection(tenantId, userId) : true;
      if (!connected) continue;

      if (state.readsEnabled) collected.push(...descriptor.readToolIds);
      if (state.writesEnabled) collected.push(...descriptor.writeToolIds);
    }

    return Array.from(new Set(collected));
  }
}
