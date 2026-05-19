import type { AppConfig } from "../config.js";
import {
  compileRuntimeConfig as compileRuntimeConfigBundle,
  normalizeMcpServer
} from "./dynamic-config-runtime-compiler.js";
import {
  createMcpServer as createMcpServerMutation,
  updateMcpServer as updateMcpServerMutation,
  type CreateMcpServerPayload,
  type UpdateMcpServerPayload
} from "./dynamic-config-mutation-service.js";
import {
  importSkillBundleFromGithub as importGithubSkillBundle,
  importSkillBundleFromInline as importInlineSkillBundle,
  importSkillBundleFromZip as importZipSkillBundle
} from "./skills/skill-import-service.js";
import { cleanupInactiveSkillRevisions as cleanupInactiveSkillRevisionsReport } from "./skills/skill-revision-cleanup-service.js";
import {
  type ActivatedSkillRevisionRecord,
  type AdminSkillRevisionRecord,
  type AdminMcpServerRecord,
  type AdminSkillRecord,
  type McpServerRegistration,
  type ResolvedRuntimePolicy,
  type RuntimeConfigBundle,
  type SkillRevisionCleanupReport,
  tenantSettingsToRuntimePolicy
} from "./admin-config-records.js";
import type { McpServerStore } from "./mcp-server-store.js";
import type { SkillConfigStore } from "./skills/skill-config-store.js";
import type { SkillRevisionStore } from "./skills/skill-revision-store.js";
import type { SkillBundleStorage } from "./skills/skill-bundle-storage.js";
import {
  buildDefaultTenantSettingsInput,
  type TenantSettingsStore,
  type TenantSettingsInput,
  type TenantSettingsRecord
} from "./tenant-settings-store.js";
import type { SessionRuntimeOverrideStore } from "./session-runtime-override-store.js";
import type { ManagedToolCatalog } from "./managed-tools/catalog.js";

export { parseGitHubSkillSource } from "./skills/skill-import-service.js";
export type {
  McpServerRegistration,
  ResolvedRuntimePolicy,
  RuntimeConfigBundle,
  SkillRevisionCleanupReport
} from "./admin-config-records.js";

type DynamicConfigStores = {
  skills: SkillConfigStore;
  skillRevisions: SkillRevisionStore;
  mcpServers: McpServerStore;
  tenantSettings: TenantSettingsStore;
  // Optional: when absent, compileRuntimeConfig never narrows the resolved
  // runtime policy. Wired in by app-dependencies.ts; left out by the
  // narrower test-helpers that only need skills + MCP servers.
  sessionRuntimeOverrides?: SessionRuntimeOverrideStore;
};

/**
 * Facade that provides a single entry point for all admin-config operations.
 *
 * Design decision (2026-03-21): this class intentionally delegates every
 * method to a focused collaborator module. The facade exists so that
 * consumers (routes, runtime manager, scheduler) import one service
 * instead of wiring individual stores and modules themselves. The cost is
 * duplicated method signatures; the benefit is a stable, narrow API
 * surface that decouples consumers from internal module boundaries.
 */
export class DynamicConfigService {
  constructor(
    private readonly config: AppConfig,
    private readonly stores: DynamicConfigStores,
    private readonly skillBundleStorage: SkillBundleStorage,
    private readonly managedToolCatalog: ManagedToolCatalog,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  listSkills(tenantId: string, includeDisabled = true): Promise<AdminSkillRecord[]> {
    return this.stores.skills.listSkills(tenantId, includeDisabled);
  }

  listMcpServers(tenantId: string, includeDisabled = true): Promise<AdminMcpServerRecord[]> {
    return this.stores.mcpServers.listMcpServers(tenantId, includeDisabled);
  }

  // --- Tenant Settings ---

  async getTenantSettings(tenantId: string): Promise<TenantSettingsRecord | null> {
    return this.stores.tenantSettings.get(tenantId);
  }

  async updateTenantSettings(tenantId: string, input: TenantSettingsInput): Promise<TenantSettingsRecord> {
    await this.validateTenantSettingsReferences(tenantId, input);
    return this.stores.tenantSettings.upsert(tenantId, input);
  }

  async getOrCreateTenantSettings(tenantId: string): Promise<TenantSettingsRecord> {
    const existing = await this.stores.tenantSettings.get(tenantId);
    if (existing) return existing;
    return this.stores.tenantSettings.upsert(tenantId, {});
  }

  async getRuntimePolicy(tenantId: string): Promise<ResolvedRuntimePolicy> {
    const settings = await this.getOrCreateTenantSettings(tenantId);
    return tenantSettingsToRuntimePolicy(settings);
  }

  async getMcpServer(tenantId: string, serverId: string): Promise<McpServerRegistration> {
    const server = await this.stores.mcpServers.getMcpServer(tenantId, serverId);
    if (!server || !server.enabled) {
      throw new Error(`Unknown MCP server: ${serverId}`);
    }

    return normalizeMcpServer(server);
  }

  async compileRuntimeConfig(
    tenantId: string,
    isBetaTester = true,
    sessionId?: string | null
  ): Promise<RuntimeConfigBundle> {
    const runtimePolicy = await this.getRuntimePolicy(tenantId);
    const sessionOverride = sessionId && this.stores.sessionRuntimeOverrides
      ? await this.stores.sessionRuntimeOverrides.get(tenantId, sessionId)
      : null;
    return compileRuntimeConfigBundle({
      tenantId,
      skills: this.stores.skills,
      mcpServers: this.stores.mcpServers,
      runtimePolicy,
      isBetaTester,
      sessionOverride
    });
  }

  disableSkill(tenantId: string, skillId: string): Promise<AdminSkillRecord | null> {
    return this.stores.skills.disableSkill(tenantId, skillId);
  }

  setSkillPublished(tenantId: string, skillId: string, isPublished: boolean): Promise<AdminSkillRecord | null> {
    return this.stores.skills.setSkillPublished(tenantId, skillId, isPublished);
  }

  listSkillRevisions(tenantId: string, skillId: string): Promise<AdminSkillRevisionRecord[]> {
    return this.stores.skillRevisions.listSkillRevisions(tenantId, skillId);
  }

  getSkillRevision(
    tenantId: string,
    skillId: string,
    skillRevisionId: number
  ): Promise<AdminSkillRevisionRecord | null> {
    return this.stores.skillRevisions.getSkillRevision(tenantId, skillId, skillRevisionId);
  }

  async activateSkillRevision(tenantId: string, input: {
    skillId: string;
    skillRevisionId: number;
    actorUserId: string;
    reviewNotes?: string | null;
  }): Promise<ActivatedSkillRevisionRecord | null> {
    return this.stores.skillRevisions.activateSkillRevision(tenantId, {
      skillId: input.skillId,
      skillRevisionId: input.skillRevisionId,
      reviewedBy: input.actorUserId,
      reviewNotes: input.reviewNotes ?? null
    });
  }

  async cleanupInactiveSkillRevisions(tenantId: string, input: {
    dryRun?: boolean;
  }): Promise<SkillRevisionCleanupReport> {
    return cleanupInactiveSkillRevisionsReport({
      tenantId,
      config: this.config,
      skills: this.stores.skills,
      skillRevisions: this.stores.skillRevisions,
      skillBundleStorage: this.skillBundleStorage,
      dryRun: input.dryRun
    });
  }

  async importSkillBundleFromZip(tenantId: string, input: {
    archiveBuffer: Buffer;
    originalFileName: string;
    actorUserId: string;
  }): Promise<{ skill: AdminSkillRecord; revision: AdminSkillRevisionRecord }> {
    return importZipSkillBundle({
      tenantId,
      config: this.config,
      skillRevisions: this.stores.skillRevisions,
      skillBundleStorage: this.skillBundleStorage,
      archiveBuffer: input.archiveBuffer,
      originalFileName: input.originalFileName,
      actorUserId: input.actorUserId
    });
  }

  async importSkillBundleFromGithub(tenantId: string, input: {
    githubUrl: string;
    ref?: string;
    subdirectory?: string;
    actorUserId: string;
    githubToken?: string;
  }): Promise<{ skill: AdminSkillRecord; revision: AdminSkillRevisionRecord }> {
    return importGithubSkillBundle({
      tenantId,
      config: this.config,
      skillRevisions: this.stores.skillRevisions,
      skillBundleStorage: this.skillBundleStorage,
      githubUrl: input.githubUrl,
      ref: input.ref,
      subdirectory: input.subdirectory,
      actorUserId: input.actorUserId,
      githubToken: input.githubToken,
      fetchFn: this.fetchFn
    });
  }

  async importSkillBundleFromInline(tenantId: string, input: {
    skillId: string;
    skillName: string;
    description: string;
    instructions: string;
    actorUserId: string;
  }): Promise<{ skill: AdminSkillRecord; revision: AdminSkillRevisionRecord }> {
    // Reject inline edits of inherited (`system`) skills. Without this guard
    // the (tenant_id, skill_id) FK on admin_skill_revisions rejects the insert
    // with a generic constraint error. Tenants who want to customize a system
    // skill must instead create their own copy under a different `skillId`.
    if (tenantId !== "system") {
      const ownerTenantId = await this.stores.skills.getSkillOwnerTenantId(tenantId, input.skillId);
      if (ownerTenantId === "system") {
        throw new Error(
          `Skill "${input.skillId}" is a system-provided skill and cannot be edited. ` +
            "Create a copy under a different skill id to customize it."
        );
      }
    }

    return importInlineSkillBundle({
      tenantId,
      skillRevisions: this.stores.skillRevisions,
      skillId: input.skillId,
      skillName: input.skillName,
      description: input.description,
      instructions: input.instructions,
      actorUserId: input.actorUserId
    });
  }

  async createMcpServer(tenantId: string, input: CreateMcpServerPayload): Promise<AdminMcpServerRecord> {
    return createMcpServerMutation({
      tenantId,
      store: this.stores.mcpServers,
      payload: input
    });
  }

  async updateMcpServer(tenantId: string, input: UpdateMcpServerPayload): Promise<AdminMcpServerRecord | null> {
    return updateMcpServerMutation({
      tenantId,
      store: this.stores.mcpServers,
      payload: input
    });
  }

  async disableMcpServer(tenantId: string, serverId: string): Promise<AdminMcpServerRecord | null> {
    const settings = await this.stores.tenantSettings.get(tenantId);
    const enabledMcpServerIds = settings?.enabledMcpServerIds
      ?? buildDefaultTenantSettingsInput().enabledMcpServerIds;

    if (enabledMcpServerIds.includes(serverId)) {
      throw new Error(
        `Cannot disable MCP server "${serverId}" — it is referenced by the tenant's active settings. Remove it from enabled MCP servers first.`
      );
    }
    return this.stores.mcpServers.disableMcpServer(tenantId, serverId);
  }

  setMcpServerPublished(tenantId: string, serverId: string, isPublished: boolean): Promise<AdminMcpServerRecord | null> {
    return this.stores.mcpServers.setMcpServerPublished(tenantId, serverId, isPublished);
  }

  private async validateTenantSettingsReferences(
    tenantId: string,
    input: TenantSettingsInput
  ): Promise<void> {
    if (!hasOwn(input, "enabledToolIds") && !hasOwn(input, "enabledMcpServerIds")) {
      return;
    }

    const defaults = buildDefaultTenantSettingsInput();
    const existing = await this.stores.tenantSettings.get(tenantId);
    const enabledToolIds = hasOwn(input, "enabledToolIds")
      ? (input.enabledToolIds ?? defaults.enabledToolIds)
      : (existing?.enabledToolIds ?? defaults.enabledToolIds);
    const enabledMcpServerIds = hasOwn(input, "enabledMcpServerIds")
      ? (input.enabledMcpServerIds ?? defaults.enabledMcpServerIds)
      : (existing?.enabledMcpServerIds ?? defaults.enabledMcpServerIds);
    const availableMcpServers = await this.stores.mcpServers.listMcpServers(tenantId, true);
    const validMcpServerIds = collectValidMcpServerIds(defaults, availableMcpServers);

    validateEnabledMcpServerIds(enabledMcpServerIds, validMcpServerIds);
    validateEnabledToolIds(enabledToolIds, defaults, validMcpServerIds, this.managedToolCatalog);
  }
}

function hasOwn(input: TenantSettingsInput, key: keyof TenantSettingsInput): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function uniqueIds(ids: string[]): string[] {
  return Array.from(new Set(ids));
}

function collectValidMcpServerIds(
  defaults: TenantSettingsInput,
  availableMcpServers: AdminMcpServerRecord[]
): Set<string> {
  return new Set([
    ...(defaults.enabledMcpServerIds ?? []),
    ...availableMcpServers.map((server) => server.serverId)
  ]);
}

function validateEnabledMcpServerIds(
  enabledMcpServerIds: string[],
  validMcpServerIds: Set<string>
): void {
  const invalid = uniqueIds(enabledMcpServerIds.filter((serverId) => !validMcpServerIds.has(serverId)));
  if (invalid.length > 0) {
    throw new Error(`Unknown enabled MCP server IDs: ${invalid.join(", ")}.`);
  }
}

function validateEnabledToolIds(
  enabledToolIds: string[],
  defaults: TenantSettingsInput,
  validMcpServerIds: Set<string>,
  managedToolCatalog: ManagedToolCatalog
): void {
  const validToolIds = new Set([
    ...(defaults.enabledToolIds ?? []),
    ...managedToolCatalog.listIds(),
    ...validMcpServerIds
  ]);
  const invalid = uniqueIds(enabledToolIds.filter((toolId) => !validToolIds.has(toolId)));
  if (invalid.length > 0) {
    throw new Error(`Unknown enabled tool IDs: ${invalid.join(", ")}.`);
  }
}
