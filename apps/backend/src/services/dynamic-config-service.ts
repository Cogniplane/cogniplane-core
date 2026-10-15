import { acceptsPersonalCredential, personalServersToCheck } from "./capability-selection.js";
import { fetch as undiciFetch } from "undici";
import type { PoolClient } from "pg";
import type { AppConfig } from "../config.js";
import { unique } from "../lib/crypto-utils.js";
import { AdminConfigError } from "./admin-config-error.js";
import {
  compileRuntimeConfig as compileRuntimeConfigBundle,
  normalizeMcpServer
} from "./dynamic-config-runtime-compiler.js";
import {
  createMcpServer as createMcpServerMutation,
  updateMcpServer as updateMcpServerMutation,
  validateMcpServerInput,
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
  type RuntimeSkillDefinition,
  type SkillRevisionCleanupReport,
  tenantSettingsToRuntimePolicy
} from "./admin-config-records.js";
import { AuditEventStore, type AuditEventInput } from "./audit-event-store.js";
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
import type { ManagedToolCatalog } from "./managed-tools/catalog.js";
import type { IntegrationRegistryService } from "./integrations/integration-registry-service.js";
import type { McpUpstreamAuth } from "../lib/mcp-upstream-client.js";
import type { McpCredentialStatus, AdminSkillReleaseSnapshot } from "@cogniplane/shared-types";

type IntegrationToolSource = Pick<IntegrationRegistryService, "resolveSessionIntegrations">;

export { parseGitHubSkillSource } from "./skills/skill-import-service.js";
export type {
  McpServerRegistration,
  ResolvedRuntimePolicy,
  RuntimeConfigBundle,
  SkillRevisionCleanupReport
} from "./admin-config-records.js";

type OwnedSkills = { personalSkills?: RuntimeSkillDefinition[]; projectSkills?: RuntimeSkillDefinition[] };

type DynamicConfigStores = {
  sessions?: Pick<import("./session-store.js").SessionStore, "getCapabilitySelection"> &
    Partial<Pick<import("./session-store.js").SessionStore, "getRuntimeCapabilities">>;
  personalSkills?: { listRuntimeSkills(tenantId: string, userId: string): Promise<RuntimeSkillDefinition[]> };
  projectSkills?: { listRuntimeSkills(tenantId: string, projectId: string, userId: string, forExecution?: boolean): Promise<RuntimeSkillDefinition[]> };
  memberMcpCredentials?: {
    listStatuses(tenantId: string, userId: string, servers: readonly AdminMcpServerRecord[]):
      Promise<Map<string, McpCredentialStatus>>;
    getRuntimeCredential(tenantId: string, userId: string, server: AdminMcpServerRecord):
      Promise<{ auth: McpUpstreamAuth; version: number } | null>;
  };
  tenantMembers?: {
    getRole(tenantId: string, userId: string): Promise<unknown | null>;
    isUserBetaTester(tenantId: string, userId: string): Promise<boolean>;
  };
  skills: Pick<
    SkillConfigStore,
    "listSkills" | "disableSkill" | "getSkillOwnerTenantId" | "setSkillPublished"
  >;
  skillRevisions: Pick<
    SkillRevisionStore,
    | "listSkillRevisions"
    | "getSkillRevision"
    | "activateSkillRevision"
    | "listAllSkillRevisions"
    | "listActiveRuntimeSkillReferences"
    | "deleteSkillRevision"
    | "countSkillRevisionsByBundleStorageUri"
    | "importSkillBundle"
  >;
  mcpServers: Pick<
    McpServerStore,
    | "listMcpServers"
    | "getMcpServer"
    | "getAdminMcpServer"
    | "createMcpServer"
    | "updateMcpServer"
    | "disableMcpServer"
    | "setMcpServerPublished"
    | "withTransaction"
  >;
  tenantSettings: Pick<TenantSettingsStore, "get" | "upsert" | "setMcpServerAllowed">;
};

type DynamicConfigSkillBundleStorage = Pick<SkillBundleStorage, "storeBundle" | "deleteBundle">;

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
    private readonly skillBundleStorage: DynamicConfigSkillBundleStorage,
    private readonly managedToolCatalog: ManagedToolCatalog,
    private readonly fetchFn: typeof undiciFetch = undiciFetch
  ) {}

  private integrationTools: IntegrationToolSource | null = null;

  // Set after construction: the integration services depend on the runtime
  // adapter, which depends on this service.
  setIntegrationToolSource(source: IntegrationToolSource): void {
    this.integrationTools = source;
  }

  private async resolveIntegrations(source: IntegrationToolSource, tenantId: string, userId: string) {
    const resolved = await source.resolveSessionIntegrations(tenantId, userId);
    return { integrationToolIds: resolved.toolIds, integrationAccounts: resolved.accounts };
  }

  listSkills(tenantId: string, includeDisabled = true): Promise<AdminSkillRecord[]> {
    return this.stores.skills.listSkills(tenantId, includeDisabled);
  }

  listMcpServers(tenantId: string, includeDisabled = true): Promise<AdminMcpServerRecord[]> {
    return this.stores.mcpServers.listMcpServers(tenantId, includeDisabled);
  }

  // --- Tenant Settings ---

  // The audit event, when given, commits in the same transaction as the change.
  async updateTenantSettings(
    tenantId: string,
    input: TenantSettingsInput,
    audit?: (settings: TenantSettingsRecord) => AuditEventInput,
    transactionClient?: PoolClient
  ): Promise<TenantSettingsRecord> {
    await this.validateTenantSettingsReferences(tenantId, input);
    return this.stores.tenantSettings.upsert(tenantId, input, transactionClient, audit);
  }

  /**
   * Takes the tenant settings lock in `client`'s transaction and reads the
   * settings under it, so a read-modify-write in that transaction cannot lose
   * a concurrent save.
   */
  async lockTenantSettings(tenantId: string, client: PoolClient): Promise<TenantSettingsRecord> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('tenant_settings:' || $1, 0))", [tenantId]);
    return (await this.stores.tenantSettings.get(tenantId, client)) ??
      this.stores.tenantSettings.upsert(tenantId, {}, client);
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
      throw new AdminConfigError(`Unknown MCP server: ${serverId}`);
    }

    return normalizeMcpServer(server);
  }

  async getMcpServerForUser(tenantId: string, serverId: string, userId: string): Promise<McpServerRegistration> {
    if (!this.stores.tenantMembers || !await this.stores.tenantMembers.getRole(tenantId, userId)) {
      throw new AdminConfigError(`Unknown MCP server: ${serverId}`);
    }
    const isBetaTester = await this.stores.tenantMembers.isUserBetaTester(tenantId, userId);
    // The gateway calls this on every JSON-RPC request, so read only the target
    // row. getMcpServer prefers the tenant row over the system row, as
    // listMcpServers does. When that row is enabled and visible to this member,
    // it is also the row that listMcpServers would return.
    const [policy, server] = await Promise.all([
      this.getRuntimePolicy(tenantId),
      this.stores.mcpServers.getMcpServer(tenantId, serverId)
    ]);
    if (!server || !server.enabled || (!server.isPublished && !isBetaTester) ||
        !policy.enabledMcpServers.includes(serverId)) {
      throw new AdminConfigError(`Unknown MCP server: ${serverId}`);
    }
    const resolved = normalizeMcpServer(server);
    if (server.credentialScope !== "personal") return resolved;
    if (!this.stores.memberMcpCredentials) {
      throw new AdminConfigError(`MCP credential unavailable: ${serverId}`);
    }
    const credential = await this.stores.memberMcpCredentials.getRuntimeCredential(tenantId, userId, server);
    if (!credential) throw new AdminConfigError(`MCP credential unavailable: ${serverId}`);
    return { ...resolved, upstreamAuth: credential.auth, credentialVersion: credential.version };
  }

  async compileRuntimeConfig(
    tenantId: string,
    isBetaTester: boolean,
    session?: { sessionId: string; userId: string }
  ): Promise<RuntimeConfigBundle> {
    let selection = null;
    let owned: OwnedSkills = {};
    const needsAudience = Boolean(this.stores.personalSkills || this.stores.projectSkills);
    if (session && this.stores.sessions) {
      if (needsAudience) {
        if (!this.stores.sessions.getRuntimeCapabilities) {
          throw new Error("Session audience is unavailable while resolving personal or project skills");
        }
        // One row supplies the selection, owner, purpose, and current project assignment.
        const context = await this.stores.sessions.getRuntimeCapabilities(tenantId, session.sessionId, session.userId);
        selection = context.selection;
        if (context.personalUserId && this.stores.personalSkills) {
          owned = { personalSkills: await this.stores.personalSkills.listRuntimeSkills(tenantId, context.personalUserId) };
        } else if (context.projectId && this.stores.projectSkills) {
          owned = { projectSkills: await this.stores.projectSkills.listRuntimeSkills(tenantId, context.projectId, session.userId, true) };
        }
      } else {
        selection = await this.stores.sessions.getCapabilitySelection(tenantId, session.sessionId, session.userId);
      }
    } else if (session && needsAudience) {
      throw new Error("Session audience is unavailable while resolving personal or project skills");
    }
    return this.compileForSelection(tenantId, isBetaTester, selection, owned, session);
  }

  async compilePersonalCatalog(tenantId: string, isBetaTester: boolean, userId: string): Promise<RuntimeConfigBundle> {
    const personalSkills = this.stores.personalSkills
      ? await this.stores.personalSkills.listRuntimeSkills(tenantId, userId) : [];
    return this.compileForSelection(tenantId, isBetaTester, null, { personalSkills });
  }

  /** The skill read checks the member's current project role. */
  async compileProjectCatalog(tenantId: string, isBetaTester: boolean, projectId: string, userId: string): Promise<RuntimeConfigBundle> {
    const projectSkills = this.stores.projectSkills
      ? await this.stores.projectSkills.listRuntimeSkills(tenantId, projectId, userId) : [];
    return this.compileForSelection(tenantId, isBetaTester, null, { projectSkills });
  }

  private async compileForSelection(
    tenantId: string,
    isBetaTester: boolean,
    selection: Awaited<ReturnType<import("./session-store.js").SessionStore["getCapabilitySelection"]>>,
    owned: OwnedSkills,
    session?: { sessionId: string; userId: string }
  ): Promise<RuntimeConfigBundle> {
    const tenantPolicy = await this.getRuntimePolicy(tenantId);
    const personalCredentialVersions = new Map<string, number>();
    if (session && this.stores.memberMcpCredentials) {
      const personalServers = personalServersToCheck(
        await this.stores.mcpServers.listMcpServers(tenantId, false, isBetaTester), tenantPolicy.enabledMcpServers);
      const statuses = await this.stores.memberMcpCredentials.listStatuses(tenantId, session.userId, personalServers);
      for (const [serverId, status] of statuses) {
        if (acceptsPersonalCredential(status.status)) personalCredentialVersions.set(serverId, status.credentialVersion);
      }
    }
    // Integration tools come only from the integration toggles. Stored tenant
    // settings can still hold integration tool IDs, so remove them here.
    const runtimePolicy = {
      ...tenantPolicy,
      enabledToolIds: tenantPolicy.enabledToolIds.filter((toolId) =>
        this.managedToolCatalog.get(toolId)?.tenantConfigurable !== false)
    };
    return compileRuntimeConfigBundle({
      tenantId,
      skills: this.stores.skills,
      mcpServers: this.stores.mcpServers,
      runtimePolicy,
      isBetaTester,
      selection,
      ...owned,
      personalCredentialVersions,
      executingSession: Boolean(session),
      ...(session && this.integrationTools
        ? await this.resolveIntegrations(this.integrationTools, tenantId, session.userId)
        : { integrationToolIds: [], integrationAccounts: {} })
    });
  }

  disableSkill(tenantId: string, skillId: string, expectedSnapshot?: AdminSkillReleaseSnapshot): Promise<AdminSkillRecord | null> {
    return this.stores.skills.disableSkill(tenantId, skillId, expectedSnapshot);
  }

  setSkillPublished(tenantId: string, skillId: string, isPublished: boolean,
    expectedSnapshot?: AdminSkillReleaseSnapshot): Promise<AdminSkillRecord | null> {
    return this.stores.skills.setSkillPublished(tenantId, skillId, isPublished, expectedSnapshot);
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
    audience?: "test-users" | "members";
    expectedSnapshot?: AdminSkillReleaseSnapshot;
  }): Promise<ActivatedSkillRevisionRecord | null> {
    return this.stores.skillRevisions.activateSkillRevision(tenantId, {
      skillId: input.skillId,
      skillRevisionId: input.skillRevisionId,
      reviewedBy: input.actorUserId,
      reviewNotes: input.reviewNotes ?? null,
      audience: input.audience,
      expectedSnapshot: input.expectedSnapshot
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
        throw new AdminConfigError(
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

  // The audit event, when given, commits in the same transaction as the change.
  async createMcpServer(
    tenantId: string,
    input: CreateMcpServerPayload,
    audit?: (server: AdminMcpServerRecord) => AuditEventInput
  ): Promise<AdminMcpServerRecord> {
    return this.stores.mcpServers.withTransaction(tenantId, async (client) => {
      const server = await createMcpServerMutation({
        tenantId,
        store: this.stores.mcpServers,
        payload: input,
        client
      });
      if (audit) await AuditEventStore.createInTransaction(client, audit(server));
      return server;
    });
  }

  async updateMcpServer(
    tenantId: string,
    input: UpdateMcpServerPayload,
    audit?: (server: AdminMcpServerRecord) => AuditEventInput
  ): Promise<AdminMcpServerRecord | null> {
    return this.stores.mcpServers.withTransaction(tenantId, async (client) => {
      const server = await updateMcpServerMutation({
        tenantId,
        store: this.stores.mcpServers,
        payload: input,
        client
      });
      if (server && audit) await AuditEventStore.createInTransaction(client, audit(server));
      return server;
    });
  }

  async saveMcpServerWithAudience(
    tenantId: string,
    // An edit keeps each omitted upstream field. A create uses the defaults.
    input: UpdateMcpServerPayload & { actorUserId: string },
    audience: "off" | "test_users" | "members",
    editingId?: string,
    audit?: (server: AdminMcpServerRecord) => AuditEventInput
  ): Promise<AdminMcpServerRecord | null> {
    validateMcpServerInput(input, { requireUrlAndSecret: !editingId });
    const enabled = audience !== "off";
    return this.stores.mcpServers.withTransaction(tenantId, async (client) => {
      const saved = editingId
        ? await this.stores.mcpServers.updateMcpServer(tenantId, {
            ...input,
            serverId: editingId,
            enabled
          }, client)
        : await this.stores.mcpServers.createMcpServer(tenantId, {
            ...input,
            upstreamUrl: input.upstreamUrl ?? null,
            upstreamAuthType: input.upstreamAuthType ?? "none",
            upstreamAuthName: input.upstreamAuthName ?? null,
            upstreamAuthSecret: input.upstreamAuthSecret ?? null,
            enabled,
            createdBy: input.actorUserId
          }, client);
      if (!saved) return null;
      const published = await this.stores.mcpServers.setMcpServerPublished(
        tenantId,
        saved.serverId,
        audience === "members",
        client
      );
      if (!published) throw new AdminConfigError("MCP server was not saved.");
      await this.stores.tenantSettings.setMcpServerAllowed(
        tenantId,
        saved.serverId,
        enabled,
        client
      );
      if (audit) await AuditEventStore.createInTransaction(client, audit(published));
      return published;
    });
  }

  async setInheritedMcpAudience(
    tenantId: string,
    serverId: string,
    audience: "off" | "test_users" | "members",
    audit?: (server: AdminMcpServerRecord) => AuditEventInput
  ): Promise<AdminMcpServerRecord> {
    return this.stores.mcpServers.withTransaction(tenantId, async (client) => {
      const server = await this.stores.mcpServers.getAdminMcpServer(tenantId, serverId, client);
      if (!server || server.ownerTenantId !== "system" || tenantId === "system") {
        throw new AdminConfigError("This connection is not an inherited system connection.");
      }
      if (audience !== "off" && !server.enabled) {
        throw new AdminConfigError("This connection is disabled by the system.");
      }
      if (audience === "members" && !server.isPublished) {
        throw new AdminConfigError("This connection is available only to test users.");
      }
      if (audience === "test_users" && server.isPublished) {
        throw new AdminConfigError("This connection is published for all members.");
      }
      await this.stores.tenantSettings.setMcpServerAllowed(
        tenantId,
        serverId,
        audience !== "off",
        client
      );
      if (audit) await AuditEventStore.createInTransaction(client, audit(server));
      return server;
    });
  }

  async disableMcpServer(
    tenantId: string,
    serverId: string,
    audit?: (server: AdminMcpServerRecord) => AuditEventInput
  ): Promise<AdminMcpServerRecord | null> {
    const settings = await this.stores.tenantSettings.get(tenantId);
    const enabledMcpServerIds = settings?.enabledMcpServerIds
      ?? buildDefaultTenantSettingsInput().enabledMcpServerIds;

    if (enabledMcpServerIds.includes(serverId)) {
      throw new AdminConfigError(
        `Cannot disable MCP server "${serverId}" — it is referenced by the tenant's active settings. Remove it from enabled MCP servers first.`
      );
    }
    return this.stores.mcpServers.withTransaction(tenantId, async (client) => {
      const server = await this.stores.mcpServers.disableMcpServer(tenantId, serverId, client);
      if (server && audit) await AuditEventStore.createInTransaction(client, audit(server));
      return server;
    });
  }

  setMcpServerPublished(
    tenantId: string,
    serverId: string,
    isPublished: boolean,
    audit?: (server: AdminMcpServerRecord) => AuditEventInput
  ): Promise<AdminMcpServerRecord | null> {
    return this.stores.mcpServers.withTransaction(tenantId, async (client) => {
      const server = await this.stores.mcpServers.setMcpServerPublished(tenantId, serverId, isPublished, client);
      if (server && audit) await AuditEventStore.createInTransaction(client, audit(server));
      return server;
    });
  }

  private async validateTenantSettingsReferences(
    tenantId: string,
    input: TenantSettingsInput
  ): Promise<void> {
    if (!Object.hasOwn(input, "enabledToolIds") && !Object.hasOwn(input, "enabledMcpServerIds")) {
      return;
    }

    const defaults = buildDefaultTenantSettingsInput();
    const existing = await this.stores.tenantSettings.get(tenantId);
    const enabledToolIds = Object.hasOwn(input, "enabledToolIds")
      ? (input.enabledToolIds ?? defaults.enabledToolIds)
      : (existing?.enabledToolIds ?? defaults.enabledToolIds);
    const enabledMcpServerIds = Object.hasOwn(input, "enabledMcpServerIds")
      ? (input.enabledMcpServerIds ?? defaults.enabledMcpServerIds)
      : (existing?.enabledMcpServerIds ?? defaults.enabledMcpServerIds);
    const availableMcpServers = await this.stores.mcpServers.listMcpServers(tenantId, true);
    const validMcpServerIds = collectValidMcpServerIds(defaults, availableMcpServers);

    validateEnabledMcpServerIds(enabledMcpServerIds, validMcpServerIds);
    validateEnabledToolIds(
      enabledToolIds,
      existing?.enabledToolIds ?? [],
      defaults,
      validMcpServerIds,
      this.managedToolCatalog
    );
  }
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
  const invalid = unique(enabledMcpServerIds.filter((serverId) => !validMcpServerIds.has(serverId)));
  if (invalid.length > 0) {
    throw new AdminConfigError(`Unknown enabled MCP server IDs: ${invalid.join(", ")}.`);
  }
}

// Integration-owned tools are enabled from /admin/integrations only. Stored
// settings can still hold them from before that rule. The admin form sends
// the stored list back, so those IDs are accepted but grant nothing at runtime
// (see compileRuntimeConfig). A new integration tool ID is rejected.
function validateEnabledToolIds(
  enabledToolIds: string[],
  storedToolIds: readonly string[],
  defaults: TenantSettingsInput,
  validMcpServerIds: Set<string>,
  managedToolCatalog: ManagedToolCatalog
): void {
  const integrationOwned = unique(enabledToolIds.filter((toolId) =>
    managedToolCatalog.get(toolId)?.tenantConfigurable === false && !storedToolIds.includes(toolId)));
  if (integrationOwned.length > 0) {
    throw new AdminConfigError(
      `Tool IDs owned by an integration cannot be enabled in tenant settings: ${integrationOwned.join(", ")}. ` +
        "Use the integration read and write toggles."
    );
  }

  const validToolIds = new Set([
    ...(defaults.enabledToolIds ?? []),
    ...managedToolCatalog.listIds(),
    ...validMcpServerIds
  ]);
  const invalid = unique(enabledToolIds.filter((toolId) => !validToolIds.has(toolId)));
  if (invalid.length > 0) {
    throw new AdminConfigError(`Unknown enabled tool IDs: ${invalid.join(", ")}.`);
  }
}
