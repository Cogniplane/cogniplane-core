import type { AppConfig } from "../../config.js";
import {
  getIntegrationDescriptor,
  IntegrationRegistry,
  type IntegrationConnectionProbe,
  type IntegrationDescriptor,
  type IntegrationConfigField,
  type IntegrationPlatformStatus
} from "./integration-registry.js";
import type { IntegrationStateRecord, IntegrationStateStore } from "./integration-state-store.js";
import { boundIntegrationAccount, integrationAccountChangedMessage } from "./integration-account-binding.js";

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
    private readonly stateStore: Pick<IntegrationStateStore, "get" | "list">,
    private readonly probeOverrides: IntegrationConnectionProbes = {},
    private readonly descriptors: IntegrationRegistry = new IntegrationRegistry()
  ) {}

  private resolveProbe(descriptor: IntegrationDescriptor): IntegrationConnectionProbe | null {
    return this.probeOverrides[descriptor.id] ?? descriptor.connectionProbe ?? null;
  }

  // Public readiness check used by both the admin GET list and PUT validation.
  // Pass `prospectiveConfig` to evaluate the gate against a config the caller
  // is about to write, instead of the row currently in the database.
  async isReadyToEnable(
    tenantId: string,
    integrationId: string,
    prospectiveConfig?: Record<string, unknown>
  ): Promise<boolean> {
    const descriptor = this.descriptors.get(integrationId);
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

    return this.descriptors.list().map((descriptor) => {
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

    return this.descriptors.list()
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
    return (await this.resolveSessionIntegrations(tenantId, userId)).toolIds;
  }

  /**
   * The integration tools a session may use, and the upstream account of each
   * integration that grants them. One pass decides both: an integration whose
   * probe can name its account grants tools only with that account recorded,
   * so a turn never holds tools without the account they were granted for.
   * `checkToolCall` and the credential lookups compare later calls with it.
   */
  async resolveSessionIntegrations(tenantId: string, userId: string): Promise<{
    toolIds: string[];
    accounts: Record<string, string>;
  }> {
    const collected: string[] = [];
    const accounts: Record<string, string> = {};
    for (const state of await this.stateStore.list(tenantId)) {
      if (!state.readsEnabled && !state.writesEnabled) continue;
      const descriptor = this.descriptors.get(state.integrationId);
      if (!descriptor || descriptor.status !== "available") continue;

      const probe = this.resolveProbe(descriptor);
      if (probe?.connectedAccountId) {
        const accountId = await probe.connectedAccountId(tenantId, userId);
        if (!accountId || !await probe.hasConnection(tenantId, userId)) continue;
        accounts[descriptor.id] = accountId;
      } else if (probe && !await probe.hasConnection(tenantId, userId)) {
        continue;
      }

      if (state.readsEnabled) collected.push(...descriptor.readToolIds);
      if (state.writesEnabled) collected.push(...descriptor.writeToolIds);
    }

    return { toolIds: Array.from(new Set(collected)), accounts };
  }

  /**
   * Checks an integration tool call when it runs, not only when the turn
   * started: the tenant toggle for the tool's access must still be on, and the
   * connected account must be the one the turn recorded. A turn can wait for
   * an approval while an administrator turns the integration off or the user
   * connects another account. Returns the refusal message, or null when the
   * call may run or the tool belongs to no integration.
   */
  async checkToolCall(input: {
    tenantId: string;
    userId: string;
    toolName: string;
    boundAccounts: Readonly<Record<string, unknown>> | undefined;
  }): Promise<string | null> {
    // Every integration that lists the tool must allow it, so the result never
    // depends on the order in which descriptors were registered.
    const owners = this.descriptors.list().filter((entry) =>
      entry.readToolIds.includes(input.toolName) || entry.writeToolIds.includes(input.toolName));
    for (const descriptor of owners) {
      const write = descriptor.writeToolIds.includes(input.toolName);
      const state = await this.stateStore.get(input.tenantId, descriptor.id);
      if (descriptor.status !== "available" || !(write ? state?.writesEnabled : state?.readsEnabled)) {
        return `${descriptor.name} ${write ? "writes" : "reads"} are disabled for this organization.`;
      }

      // An early refusal: the credential lookup compares the same account
      // again on the row that holds the token.
      const probe = this.resolveProbe(descriptor);
      const expected = boundIntegrationAccount(
        input.boundAccounts ? { integrationAccounts: input.boundAccounts } : undefined, descriptor.id);
      if (expected === undefined || !probe?.connectedAccountId) continue;
      if (await probe.connectedAccountId(input.tenantId, input.userId) !== expected) {
        return integrationAccountChangedMessage(descriptor.name);
      }
    }
    return null;
  }
}
