import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, onTestFinished, test, vi } from "vitest";

import type { LocalSessionIdentity } from "../services/auth/local-account-service.js";
import type { LocalAuth } from "../services/auth/local-auth.js";
import { LoginFlowStore } from "../services/auth/login-flow-store.js";
import { InMemoryLoginThrottle } from "../services/auth/login-throttle.js";
import { PasskeyChallengeStore } from "../services/auth/passkey-challenge-store.js";
import { RefreshTokenRotationService } from "../services/auth/refresh-token-rotation-service.js";
import { OVERLAY_STEP_UP_ACTIONS, STEP_UP_ROUTES, type StepUpRoute } from "../services/auth/step-up-routes.js";
import { STEP_UP_ACTIONS, StepUpStore } from "../services/auth/step-up-store.js";
import type { AuditEventInput } from "../services/audit-event-store.js";
import { DataRouteControl } from "../services/data-route-control.js";
import type { EvaluableRule } from "../services/policy/policy-engine.js";
import { PolicyRuleConflictError, type PolicyRuleWriteOptions } from "../services/policy/policy-rule-store.js";
import { weakensPolicy } from "../services/policy/policy-weakening.js";
import { WeakerChangeError } from "../services/weaker-change-error.js";
import { getIntegrationDescriptor, registerIntegration } from "../services/integrations/integration-registry.js";
import type { DataSettingChange } from "../services/mail/setting-change-notices.js";
import type { TenantOrgSettingsStore } from "../services/tenant-org-settings-store.js";
import type { TenantSettingsRecord } from "../services/tenant-settings-store.js";
import { FakePool } from "../test-helpers/fake-pool.js";
import { guardedAuthRedis } from "../test-helpers/redis-write-guard.js";
import { createFakeWorkOS } from "../test-helpers/fake-workos.js";
import { InMemoryAuditEventStore } from "../test-helpers/in-memory-audit-events.js";
import { createTestConfig } from "../test-helpers/test-config.js";
import { registerAdminRoutes, type AdminRouteStores } from "./admin.js";
import { registerAuthRoutes } from "./auth.js";
import { registerOrganizationSkillSubmissionRoutes, type SubmissionStores } from "./organization-skill-submissions.js";
import { registerProjectSkillRoutes, type ProjectSkillStores } from "./project-skills.js";
import { registerTenantRoutes } from "./tenant.js";
import { IGNORE_SECURITY_CHANGE } from "../test-helpers/security-change.js";
import { DEFAULT_PII_PROTECTION, type PiiProtectionSettings, type PolicyRule } from "@cogniplane/shared-types";

// The list of step-up routes (services/auth/step-up-routes.ts), checked
// against the real route plugins: auth (session, WorkOS, local accounts,
// passkeys, email recovery), tenant (members, local member actions, the
// provider key, PII protection, the skill marketplace), admin (tenant
// settings, MCP servers, integrations, Policy Center rules, skill release,
// and the rest of the admin console), skill submissions, and project skills
// (a project skill release gives instructions to the project's editors). The
// service dependencies
// are fakes that record each call; the step-up store, refresh families,
// challenges, and flows are the real classes on a fake Redis. The data
// routes use the real DataRouteControl, and the fakes of the Policy Center
// and PII stores classify a change with the real policy-weakening.ts and
// pii-weakening.ts.
//
// 1. Every route in the list refuses a request that carries only a valid
//    access token of a live local session (no X-Step-Up): 403
//    step_up_required with the action, a step-up check for the route's
//    action, and no write.
// 2. Every data route (and every route that can make a control weaker or
//    releases a skill) succeeds with a step-up token for its action, and
//    queues the owner notice in the change's transaction. A WorkOS session
//    makes the change with no step-up, and the notice is queued too.
// Full application registration and reviewed exceptions are checked in
// full-app-step-up-census.test.ts.

const CONFIG = createTestConfig({
  AUTH_MODE: "jwt",
  AUTH_LOGIN_TYPES: ["workos", "local"],
  WORKOS_API_KEY: "test-workos-api-key",
  WORKOS_CLIENT_ID: "test-client-id",
  WORKOS_REDIRECT_URI: "https://test.example/auth/callback",
  SMTP_URL: "smtps://smtp.example.test",
  MAIL_FROM: "no-reply@example.test"
});
const ORIGIN = CONFIG.API_ORIGIN;

const IDENTITY: LocalSessionIdentity = {
  tenantId: "tenant-1", userId: "owner-1", role: "owner", email: "owner@example.test", displayName: "Owner", securityVersion: 3
};

type Case = { url: string; payload?: object };

const MCP_SERVER_ID = "census-mcp";
const MCP_BODY = {
  serverId: MCP_SERVER_ID,
  serverName: "Census server",
  mode: "proxy",
  routePath: "/mcp/census",
  upstreamUrl: "https://mcp.example.test/mcp"
};
const SHARED_SERVER_ID = "census-shared";
const INTEGRATION_ID = "census-app";
const PROVIDER_KEY = "sk-census-secret-key-0001";
const SKILL_ID = "census-skill";
const SUBMISSION_ID = "00000000-0000-4000-8000-0000000000c5";
const MARKETPLACE_URL = "https://skills.example.com/census/manifest.json";
const SNAPSHOT = { version: 3, activeRevisionId: 6, latestRevisionId: 7, enabled: true, isPublished: false };
const PROJECT_ID = "0198c0de-0000-7000-8000-0000000000c5";
const PROJECT_SKILL_ID = "project-skill-00000000-0000-4000-8000-0000000000c5";
const PROJECT_SCOPE = { tenantId: "tenant-1", userId: "owner-1", projectId: PROJECT_ID };

/**
 * The stored Policy Center rules: a block rule for one tool, then a rule that
 * allows the rest. Each policy case below makes the export tool less strict.
 */
const BLOCK_RULE: PolicyRule = {
  ruleId: "pol_census_block", tenantId: "tenant-1", name: "Block exports", description: null, priority: 10, enabled: true,
  effect: "block", conditions: { toolNames: ["export_customers"] }, reason: null, createdBy: "owner-1", revision: 1,
  createdAt: "2026-10-28T00:00:00.000Z", updatedAt: "2026-10-28T00:00:00.000Z"
};
const ALLOW_RULE: PolicyRule = { ...BLOCK_RULE, ruleId: "pol_census_allow", name: "Allow the rest", priority: 20, effect: "allow", conditions: {} };

/** The stored PII policy: on, in block mode. */
const PII_ON: PiiProtectionSettings = { ...DEFAULT_PII_PROTECTION, enabled: true, mode: "block" };

/**
 * One request per listed route, in the state where it needs step-up: the
 * caller is an owner of a local tenant with a second factor, the target is a
 * local member, and the MFA rule becomes weaker. The type makes a case
 * necessary for every route in the list.
 */
const CASES: Record<StepUpRoute, Case> = {
  "POST /tenant/members": { url: "/tenant/members", payload: { email: "new@example.test", role: "admin" } },
  "PUT /tenant/members/:userId/role": { url: "/tenant/members/target-1/role", payload: { role: "owner" } },
  "POST /tenant/members/:userId/password-reset": { url: "/tenant/members/target-1/password-reset" },
  "POST /tenant/members/:userId/disable": { url: "/tenant/members/target-1/disable" },
  "POST /tenant/members/:userId/enable": { url: "/tenant/members/target-1/enable" },
  "DELETE /tenant/members/:userId": { url: "/tenant/members/target-1" },
  "POST /tenant/members/:userId/mfa-reset": { url: "/tenant/members/target-1/mfa-reset" },
  "PUT /tenant/settings/security": { url: "/tenant/settings/security", payload: { mfaPolicy: "optional" } },
  "POST /me/security/password": {
    url: "/me/security/password", payload: { currentPassword: "a long passphrase here", newPassword: "another long passphrase" }
  },
  "POST /me/security/totp/start": { url: "/me/security/totp/start" },
  "DELETE /me/security/totp": { url: "/me/security/totp" },
  "POST /me/security/recovery-codes": { url: "/me/security/recovery-codes" },
  "POST /me/security/passkeys/options": { url: "/me/security/passkeys/options" },
  "DELETE /me/security/passkeys/:credentialId": { url: "/me/security/passkeys/cred-1" },
  "PUT /tenant/settings": { url: "/tenant/settings", payload: { provider: "openai", apiKey: PROVIDER_KEY } },
  // A change of a field that routes data: unprotected fields need no step-up.
  "PUT /admin/tenant-settings": { url: "/admin/tenant-settings", payload: { approvedSandboxEgressDomains: ["data.example.net"] } },
  "POST /admin/mcp-servers": { url: "/admin/mcp-servers", payload: MCP_BODY },
  "PUT /admin/mcp-servers/:serverId": { url: `/admin/mcp-servers/${MCP_SERVER_ID}`, payload: MCP_BODY },
  "POST /admin/mcp-servers/setup": { url: "/admin/mcp-servers/setup", payload: { ...MCP_BODY, audience: "members" } },
  "PUT /admin/mcp-servers/:serverId/setup": {
    url: `/admin/mcp-servers/${MCP_SERVER_ID}/setup`, payload: { ...MCP_BODY, audience: "members", expectedVersion: 1 }
  },
  "PUT /admin/mcp-servers/:serverId/inherited-availability": {
    url: `/admin/mcp-servers/${SHARED_SERVER_ID}/inherited-availability`, payload: { audience: "members" }
  },
  "POST /admin/mcp-servers/:serverId/publish": { url: `/admin/mcp-servers/${MCP_SERVER_ID}/publish` },
  "POST /admin/mcp-servers/:serverId/widget-domains/approve": {
    url: `/admin/mcp-servers/${MCP_SERVER_ID}/widget-domains/approve`,
    payload: { directive: "connectDomains", source: "https://api.example.com" }
  },
  // Turning access on: turning it off needs no step-up.
  "PUT /admin/integrations/:integrationId": { url: `/admin/integrations/${INTEGRATION_ID}`, payload: { readsEnabled: true } },
  // Changes that make the policy weaker: an allow rule before the block
  // rule, the block rule off or removed, the allow rule moved first.
  "POST /admin/policy/rules": { url: "/admin/policy/rules", payload: { name: "Allow all", effect: "allow", priority: 0 } },
  "PATCH /admin/policy/rules/:ruleId": { url: `/admin/policy/rules/${BLOCK_RULE.ruleId}`, payload: { enabled: false, expectedRevision: 1 } },
  "DELETE /admin/policy/rules/:ruleId": { url: `/admin/policy/rules/${BLOCK_RULE.ruleId}` },
  "PUT /admin/policy/rules/order": { url: "/admin/policy/rules/order", payload: { ruleIds: [ALLOW_RULE.ruleId, BLOCK_RULE.ruleId] } },
  // PII protection turned off, with the stored revision.
  "PUT /tenant/settings/pii": { url: "/tenant/settings/pii", payload: { ...DEFAULT_PII_PROTECTION, expectedRevision: 4 } },
  "PUT /tenant/settings/marketplace": { url: "/tenant/settings/marketplace", payload: { skillMarketplaceManifestUrl: MARKETPLACE_URL } },
  "POST /admin/skills/:skillId/revisions/:skillRevisionId/activate": {
    url: `/admin/skills/${SKILL_ID}/revisions/7/activate`, payload: { audience: "members", expectedSnapshot: SNAPSHOT }
  },
  "POST /admin/skills/:skillId/publish": { url: `/admin/skills/${SKILL_ID}/publish`, payload: { expectedSnapshot: SNAPSHOT } },
  "POST /admin/skill-submissions/:id/release": {
    url: `/admin/skill-submissions/${SUBMISSION_ID}/release`,
    payload: {
      scope: { tenantId: "tenant-1", userId: "owner-1" }, expectedOrganizationVersion: 3, expectedActiveRevisionId: 6,
      expectedDraftRevisionId: 7, audience: "test-users"
    }
  },
  // A release; turning the skill off needs no step-up.
  "POST /projects/:projectId/skills/:skillId/action": {
    url: `/projects/${PROJECT_ID}/skills/${PROJECT_SKILL_ID}/action`, payload: { scope: PROJECT_SCOPE, version: 1, action: "release" }
  }
};

/**
 * The routes with an owner notice: the data routes (tenant settings that
 * change where data goes), the changes that make a control weaker, and the
 * skill releases, with the notice that each change queues. Every route in
 * the list that does not act on an account is one of them.
 */
const DATA_ROUTES: Partial<Record<StepUpRoute, DataSettingChange>> = {
  "PUT /tenant/settings": { setting: "provider_key", provider: "openai", removed: false },
  "PUT /admin/tenant-settings": { setting: "tenant_settings", fields: ["Sandbox network hosts"] },
  "POST /admin/mcp-servers": { setting: "mcp_server", serverId: MCP_SERVER_ID, created: true },
  "PUT /admin/mcp-servers/:serverId": { setting: "mcp_server", serverId: MCP_SERVER_ID, created: false },
  "POST /admin/mcp-servers/setup": { setting: "mcp_server", serverId: MCP_SERVER_ID, created: true },
  "PUT /admin/mcp-servers/:serverId/setup": { setting: "mcp_server", serverId: MCP_SERVER_ID, created: false },
  "PUT /admin/mcp-servers/:serverId/inherited-availability": { setting: "mcp_server_audience", serverId: SHARED_SERVER_ID },
  "POST /admin/mcp-servers/:serverId/publish": { setting: "mcp_server_audience", serverId: MCP_SERVER_ID },
  "POST /admin/mcp-servers/:serverId/widget-domains/approve": { setting: "mcp_widget_domain", serverId: MCP_SERVER_ID },
  "PUT /admin/integrations/:integrationId": { setting: "integration", integrationName: "Census app", fields: ["Read access turned on"] },
  "POST /admin/policy/rules": { setting: "policy_rules", change: "rule_added", ruleId: "pol_census_new", ruleName: "Allow all" },
  "PATCH /admin/policy/rules/:ruleId": { setting: "policy_rules", change: "rule_changed", ruleId: BLOCK_RULE.ruleId, ruleName: "Block exports" },
  "DELETE /admin/policy/rules/:ruleId": { setting: "policy_rules", change: "rule_removed", ruleId: BLOCK_RULE.ruleId, ruleName: "Block exports" },
  "PUT /admin/policy/rules/order": { setting: "policy_rules", change: "order_changed", ruleId: null, ruleName: null },
  "PUT /tenant/settings/pii": { setting: "pii_protection", fields: ["Protection", "Mode"] },
  "PUT /tenant/settings/marketplace": { setting: "skill_marketplace" },
  "POST /admin/skills/:skillId/revisions/:skillRevisionId/activate": {
    setting: "skill_release", skillId: SKILL_ID, change: "revision_activated", audience: "members"
  },
  "POST /admin/skills/:skillId/publish": { setting: "skill_release", skillId: SKILL_ID, change: "published", audience: "members" },
  "POST /admin/skill-submissions/:id/release": {
    setting: "skill_release", skillId: SKILL_ID, change: "submission_released", audience: "test-users"
  },
  "POST /projects/:projectId/skills/:skillId/action": {
    setting: "skill_release", skillId: PROJECT_SKILL_ID, change: "project_released", audience: null, projectId: PROJECT_ID
  }
};
const DATA_ROUTE_KEYS = Object.keys(DATA_ROUTES) as StepUpRoute[];

function isAccountRoute(route: string): boolean {
  return route.includes(" /tenant/members") || route.includes(" /me/security") || route === "PUT /tenant/settings/security";
}

/**
 * Service calls that only read. Any other call is a change. A store write
 * that classifies the change in its transaction and refuses it
 * (WeakerChangeError: the Policy Center and PII stores) changes nothing,
 * because the transaction rolls back; the fakes of those stores record a
 * write only when it commits.
 * `dynamicConfig.listMcpServers`: the MCP routes find the server before the
 * step-up check (a missing server answers 404 and spends no token).
 * `dynamicConfig.getOrCreateTenantSettings`: the tenant settings route
 * compares the save with the stored settings (it writes the default row
 * only when the tenant has none).
 */
const READS = new Set([
  "accounts.getMemberState", "mfa.hasSecondFactor", "mfa.factorState", "mfa.getPolicy",
  "customModels.list", "dynamicConfig.listMcpServers", "dynamicConfig.getOrCreateTenantSettings",
  "integrationStates.get", "integrationRegistry.isReadyToEnable"
]);

/** SQL that may run before the step-up check: the target's login path, and the idempotent user row of every admin route. */
const READ_SQL = ["SELECT user_auth_source FROM tenant_memberships", "INSERT INTO users"];

/** Wraps each method so that a call records `name.method`. */
function recorded<T extends Record<string, (...args: never[]) => unknown>>(calls: string[], name: string, methods: T): T {
  return Object.fromEntries(
    Object.entries(methods).map(([method, fn]) => [method, (...args: never[]) => {
      calls.push(`${name}.${method}`);
      return fn(...args);
    }])
  ) as T;
}

type Fakes = Record<string, (...args: unknown[]) => unknown>;

/**
 * A store whose every method records `name.method` and returns what `fakes`
 * gives (undefined for any other method). A call of the store itself (a
 * function dependency such as `providerKeySources`) records `name`. A method
 * in `recordsItself` records its call itself, when its change commits.
 */
function recordingStore<T>(calls: string[], name: string, fakes: Fakes = {}, recordsItself: readonly string[] = []): T {
  return new Proxy(() => undefined, {
    get: (_target, method) => {
      if (typeof method !== "string" || method === "then") return undefined;
      return (...args: unknown[]) => {
        if (!recordsItself.includes(method)) calls.push(`${name}.${method}`);
        return fakes[method]?.(...args);
      };
    },
    apply: (_target, _self, args: unknown[]) => {
      calls.push(name);
      return fakes["()"]?.(...args);
    }
  }) as T;
}

/** Stands for the transaction client of a change. */
const CHANGE_TRANSACTION = { transaction: "change" };

/**
 * What a store does when it writes a change: it writes the change's audit
 * event, in the change's transaction, which runs the event's
 * `alsoInTransaction` (the owner notice). The audit argument is the last
 * function or audit event in the call.
 */
async function commitChange<T>(args: unknown[], saved: T): Promise<T> {
  const audit = [...args].reverse().find((arg) =>
    typeof arg === "function" || (typeof arg === "object" && arg !== null && "type" in arg && "tenantId" in arg));
  const event = (typeof audit === "function" ? audit(saved) : audit) as AuditEventInput | undefined;
  await event?.alsoInTransaction?.(CHANGE_TRANSACTION as never);
  return saved;
}

const MCP_SERVER = {
  serverId: MCP_SERVER_ID, ownerTenantId: IDENTITY.tenantId, serverName: "Census server", description: null, transportKind: "http",
  mode: "proxy", routePath: "/mcp/census", upstreamUrl: "https://mcp.example.test/mcp", upstreamAuthType: "none",
  upstreamAuthName: null, upstreamAuthConfigured: false, credentialScope: "organization", credentialBindingId: undefined,
  version: 1, configHash: "hash", enabled: true, isPublished: true, createdBy: "owner-1",
  createdAt: "2026-10-28T00:00:00.000Z", updatedAt: "2026-10-28T00:00:00.000Z"
};

/** A shared system server: the tenant chooses only who can use it. */
const SHARED_SERVER = { ...MCP_SERVER, serverId: SHARED_SERVER_ID, ownerTenantId: "system" };

const SETTINGS: TenantSettingsRecord = {
  tenantId: IDENTITY.tenantId, showEffortSelector: true, webSearchMode: "disabled", approvalPolicy: "on-request",
  approvalReviewer: "user", allowCommandExecution: false, autoApproveReadOnlyTools: true,
  policyEnforcementMode: "monitor", developerInstructions: null, enabledToolIds: [], enabledMcpServerIds: [],
  enabledProviders: ["openai"], enabledModelIds: null, defaultModelId: null, modelDefaultEfforts: {},
  approvedSandboxEgressDomains: [], version: 2, configHash: "hash", updatedAt: "2026-10-28T00:00:00.000Z"
};

const INTEGRATION_VIEW = {
  id: INTEGRATION_ID, name: "Census app", description: "", longDescription: "", logoSlug: "census", status: "available",
  category: "Test", readToolIds: [], writeToolIds: [], configMode: "none", readsEnabled: false, writesEnabled: false,
  hasConfig: false, configSummary: {}, updatedAt: null, updatedBy: null, platformConfigured: true, platformConfigMessage: null
};

// The integration that the integration route changes. The registry is module
// state, so register it once.
if (!getIntegrationDescriptor(INTEGRATION_ID)) {
  registerIntegration({
    id: INTEGRATION_ID, name: "Census app", description: "", longDescription: "", logoSlug: "census",
    status: "available", category: "Test", readToolIds: [], writeToolIds: [], configMode: "none"
  });
}

const SKILL = {
  skillId: SKILL_ID, skillName: "Census skill", description: null, instructions: "Do the census.", version: 4, contentHash: "hash",
  enabled: true, isPublished: true, createdBy: "owner-1", createdAt: "2026-10-28T00:00:00.000Z", updatedAt: "2026-10-28T00:00:00.000Z",
  activeRevisionId: 7, activeSourceType: "inline", activeBundleName: null, activeBundleStorageUri: null, activeBundleHash: null,
  activeValidationStatus: "valid", activeReviewStatus: "active", isInherited: false
};
const ACTIVATED = {
  skill: SKILL,
  revision: {
    skillRevisionId: 7, skillId: SKILL_ID, revisionNumber: 2, sourceType: "inline", sourceLabel: null, bundleName: null,
    bundleStorageUri: null, bundleHash: "hash", validationStatus: "valid", validationMessages: [], reviewStatus: "active",
    reviewNotes: null, metadata: {}, createdBy: "owner-1", createdAt: "2026-10-28T00:00:00.000Z", reviewedBy: "owner-1",
    reviewedAt: "2026-10-28T00:00:00.000Z", activatedAt: "2026-10-28T00:00:00.000Z"
  },
  previousActiveRevisionId: 6,
  previousActiveRevisionNumber: 1
};
const SUBMISSION_ATTEMPT = {
  attempt: 1, status: "accepted", note: "", submittedAt: "2026-10-28T00:00:00.000Z", decidedAt: null, decidedBy: null,
  decidedByName: null, feedback: null, acceptedRevisionId: 7,
  snapshot: { content: { name: "notes", description: "Notes", instructions: "Write notes." }, sourceRevision: 1, contentHash: "a".repeat(64), validationMessages: [] }
};
const SUBMISSION = {
  id: SUBMISSION_ID, version: 2, status: "accepted", authorUserId: "member-1", authorName: "Member", authorEmail: null,
  sourceSkillId: "personal-skill-00000000-0000-4000-8000-000000000000", targetOrganizationSkillId: null,
  acceptedOrganizationSkillId: SKILL_ID, latest: SUBMISSION_ATTEMPT, createdAt: "2026-10-28T00:00:00.000Z",
  updatedAt: "2026-10-28T00:00:00.000Z", attempts: [SUBMISSION_ATTEMPT], updates: [], organizationSkill: null
};

const PROJECT_SKILL_REVISION = {
  revision: 1, content: { name: "notes", description: "Notes", instructions: "Write notes." },
  validationMessages: [], copiedFromRevision: null, createdAt: "2026-10-28T00:00:00.000Z"
};
const PROJECT_SKILL = {
  id: PROJECT_SKILL_ID, version: 2, enabled: true, latest: PROJECT_SKILL_REVISION, active: PROJECT_SKILL_REVISION,
  copiedFrom: null, updatedAt: "2026-10-28T00:00:00.000Z"
};

function byEvaluationOrder(rules: PolicyRule[]): PolicyRule[] {
  return [...rules].sort((a, b) => a.priority - b.priority || a.ruleId.localeCompare(b.ruleId));
}

/**
 * The Policy Center store, as the real one behaves in its transaction: it
 * classifies the change with the real weakensPolicy against the stored rules,
 * refuses a weaker change unless allowed (the transaction rolls back: no
 * change, no record), and writes the audit event, with its owner notice, in
 * the change's transaction.
 */
function policyRuleStore(calls: string[]) {
  let rules = [BLOCK_RULE, ALLOW_RULE];
  const commit = async <T>(method: string, next: PolicyRule[], changed: EvaluableRule[], saved: T, options: PolicyRuleWriteOptions<T>) => {
    const weaker = weakensPolicy(rules, next, changed);
    if (weaker && !options.allowWeaker) throw new WeakerChangeError();
    rules = next;
    calls.push(`policyRules.${method}`);
    await options.audit?.(saved, weaker).alsoInTransaction?.(CHANGE_TRANSACTION as never);
    return saved;
  };
  const find = (ruleId: string) => rules.find((rule) => rule.ruleId === ruleId);
  return {
    list: async () => byEvaluationOrder(rules),
    listForLint: async () => [],
    create: (_tenantId: string, input: Partial<PolicyRule>, _createdBy: string | null, options: PolicyRuleWriteOptions<PolicyRule>) => {
      const rule: PolicyRule = { ...ALLOW_RULE, ruleId: "pol_census_new", priority: 30, enabled: true, conditions: {}, ...input };
      return commit("create", [...rules, rule], [rule], rule, options);
    },
    update: async (_tenantId: string, ruleId: string, input: Partial<PolicyRule> & { expectedRevision: number },
      options: PolicyRuleWriteOptions<PolicyRule>) => {
      const existing = find(ruleId);
      if (!existing) return null;
      // As in the real store: an older revision is refused before the change is classified.
      const { expectedRevision, ...patch } = input;
      if (expectedRevision !== existing.revision) throw new PolicyRuleConflictError();
      const rule = { ...existing, ...patch, revision: existing.revision + 1 };
      return commit("update", rules.map((candidate) => (candidate.ruleId === ruleId ? rule : candidate)), [existing, rule], rule, options);
    },
    delete: async (_tenantId: string, ruleId: string, options: PolicyRuleWriteOptions<PolicyRule>) => {
      const existing = find(ruleId);
      if (!existing) return null;
      return commit("delete", rules.filter((rule) => rule.ruleId !== ruleId), [existing], existing, options);
    },
    reorder: (_tenantId: string, ruleIds: string[], options: PolicyRuleWriteOptions<PolicyRule[]>) => {
      const next = rules.map((rule) => ({ ...rule, priority: ruleIds.indexOf(rule.ruleId) * 10 }));
      const moved = rules.filter((rule) => find(rule.ruleId)?.priority !== next.find((candidate) => candidate.ruleId === rule.ruleId)?.priority);
      return commit("reorder", next, moved, byEvaluationOrder(next), options);
    }
  };
}

/** The admin stores: fakes for what the data routes read and write; every other call is recorded and returns nothing. */
function adminStores(calls: string[], writes: Array<{ method: string; args: unknown[] }>, dataRoutes: DataRouteControl): AdminRouteStores {
  const fixed: Record<string, unknown> = { config: CONFIG, dataRoutes, policyRules: policyRuleStore(calls) };
  const fakes: Record<string, Fakes> = {
    customModels: { list: async () => [] },
    dynamicConfig: {
      listMcpServers: async () => [MCP_SERVER, SHARED_SERVER],
      getOrCreateTenantSettings: async () => SETTINGS,
      updateTenantSettings: (...args) => {
        writes.push({ method: "updateTenantSettings", args });
        return commitChange(args, SETTINGS);
      },
      createMcpServer: (...args) => commitChange(args, MCP_SERVER),
      updateMcpServer: (...args) => commitChange(args, MCP_SERVER),
      saveMcpServerWithAudience: (...args) => commitChange(args, MCP_SERVER),
      setInheritedMcpAudience: (...args) => commitChange(args, SHARED_SERVER),
      setMcpServerPublished: (...args) => commitChange(args, MCP_SERVER),
      // A release runs the owner notice in its transaction.
      activateSkillRevision: async (_tenantId, input) => {
        await (input as { alsoInTransaction?: (client: unknown) => Promise<void> }).alsoInTransaction?.(CHANGE_TRANSACTION);
        return ACTIVATED;
      },
      setSkillPublished: async (_tenantId, _skillId, _published, _snapshot, options) => {
        await (options as { alsoInTransaction?: (client: unknown) => Promise<void> } | undefined)?.alsoInTransaction?.(CHANGE_TRANSACTION);
        return SKILL;
      }
    },
    mcpAppCsp: { approve: (...args) => commitChange(args, true), listForAdmin: async () => [] },
    integrationStates: {
      get: async () => null,
      applyChanges: (...args) => commitChange(args, { readsEnabled: false, writesEnabled: false, config: {} })
    },
    integrationRegistry: { getIntegrationsForAdmin: async () => [INTEGRATION_VIEW], isReadyToEnable: async () => true }
  };
  return new Proxy({}, {
    get: (_target, key) => {
      if (typeof key !== "string" || key === "then") return undefined;
      return key in fixed ? fixed[key] : recordingStore(calls, key, fakes[key]);
    }
  }) as AdminRouteStores;
}

type QueuedNotice = { client: unknown; tenantId: string; actorUserId: string; change: DataSettingChange };

async function buildApp(options: { authSource?: "local" | "workos" } = {}) {
  const calls: string[] = [];
  const notices: QueuedNotice[] = [];
  const writes: Array<{ method: string; args: unknown[] }> = [];
  const { redis, checkpoint } = guardedAuthRedis();
  const refreshTokens = new RefreshTokenRotationService(redis, 60);
  await refreshTokens.issue({ jti: "jti-1", familyId: "family-1" });
  const stepUp = new StepUpStore(redis);
  const consume = vi.spyOn(stepUp, "consume");

  const created = { userId: "new-user", link: { url: "https://app.test/auth/setup#token=x", expiresAt: "2026-11-01T00:00:00.000Z", purpose: "account_setup" }, email: null };
  const accounts = recorded(calls, "accounts", {
    getMemberState: async () => ({ role: "member", status: "active" }),
    createMember: async () => created,
    resetMemberPassword: async () => ({ link: created.link, email: null }),
    resendMemberLink: async () => null,
    disableMember: async () => undefined,
    enableMember: async () => "active",
    revokeSessions: async () => undefined,
    changeOwnPassword: async () => IDENTITY,
    verifyOwnPassword: async () => ({ email: IDENTITY.email, passwordHash: "x" }),
    signInWithPassword: async () => IDENTITY,
    redeemLink: async () => IDENTITY,
    requestPasswordReset: async () => "sent"
  });
  const mfa = recorded(calls, "mfa", {
    // The caller has a second factor: password change then needs step-up.
    hasSecondFactor: async () => true,
    factorState: async () => ({ totpEnabled: true, passkeyCount: 1, recoveryCodesRemaining: 10, mfaRequired: false }),
    // The rule becomes weaker: only an owner, with step-up.
    getPolicy: async () => "required_for_all",
    setPolicy: async () => ({ previous: "required_for_all" }),
    resetMemberFactors: async () => undefined,
    startTotpEnrollment: async () => ({ secret: "JBSWY3DPEHPK3PXP", otpauthUri: "otpauth://totp/x" }),
    confirmTotpEnrollment: async () => ({ identity: IDENTITY, recoveryCodes: [] }),
    removeOwnTotp: async () => ({ identity: IDENTITY, factorsLeft: true }),
    regenerateRecoveryCodes: async () => [],
    verifyTotp: async () => IDENTITY,
    checkRecoveryCode: async () => ({ identity: IDENTITY, codeHash: "x" })
  });
  const passkeys = recorded(calls, "passkeys", {
    registrationOptions: async () => ({ challenge: "reg-1", user: { id: "dXNlci0x" } }),
    authenticationOptions: async () => ({ challenge: "auth-1", allowCredentials: [] }),
    verifyAssertion: async () => IDENTITY,
    register: async () => ({ identity: IDENTITY, passkey: null, recoveryCodes: null }),
    list: async () => [],
    rename: async () => null,
    remove: async () => ({ identity: IDENTITY, factorsLeft: true })
  });
  const localAuth = {
    accounts, mfa, passkeys, stepUp, refreshTokens,
    challenges: new PasskeyChallengeStore(redis),
    flows: new LoginFlowStore(redis),
    throttle: new InMemoryLoginThrottle()
  } as unknown as LocalAuth;
  // The real checks of the data routes, with a queue that records each notice
  // and the transaction it was queued in.
  const dataRoutes = new DataRouteControl({
    authMode: "jwt",
    localAuth,
    ownerNotices: {
      async queueOwnerNotice(client, tenantId, input) {
        notices.push({ client, tenantId, ...input });
        return 1;
      }
    }
  });

  // Only the target's login path may be read before the step-up check, and
  // the user row that every admin route makes sure of.
  const pool = new FakePool();
  pool.onQuery("SELECT user_auth_source FROM tenant_memberships", () => ({ rows: [{ user_auth_source: "local" }], rowCount: 1 }));
  pool.onQuery("INSERT INTO users", () => ({ rows: [], rowCount: 0 }));

  const app = Fastify();
  onTestFinished(() => app.close());
  app.decorate("redis", redis.asAppRedis());
  app.decorate("db", pool.asPool());
  app.decorate("config", CONFIG);
  await app.register(cookie);
  // A valid access token of a live session: what a stolen token gives.
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: IDENTITY.userId, tenantId: IDENTITY.tenantId, role: "owner", isAdmin: true, email: IDENTITY.email,
      session: options.authSource === "workos"
        ? { authSource: "workos", familyId: "family-1", amr: ["workos"] }
        : { authSource: "local", familyId: "family-1", securityVersion: IDENTITY.securityVersion, amr: ["pwd"] }
    };
  });
  await registerAuthRoutes(app, {
    db: pool.asPool(),
    appDb: pool.asPool(),
    localAuth,
    config: CONFIG,
    auditEvents: new InMemoryAuditEventStore() as never,
    workos: createFakeWorkOS().workos
  });
  await registerTenantRoutes(app, { afterSecurityChange: IGNORE_SECURITY_CHANGE,
    db: pool.asPool(),
    tenantOrgSettings: recordingStore<TenantOrgSettingsStore>(calls, "tenantOrgSettings", {
      setApiKey: (...args) => commitChange(args, undefined),
      setMarketplaceUrl: (...args) => commitChange(args, undefined),
      // As the store: the save is classified against the stored policy (on,
      // in block mode) and refused when weaker unless allowed; only a save
      // that commits is recorded.
      setPiiProtection: async (_tenantId, policy, options) => {
        const save = options as Parameters<TenantOrgSettingsStore["setPiiProtection"]>[2];
        const weaker = save.weakerFields(PII_ON, policy as PiiProtectionSettings);
        if (weaker.length > 0 && !save.allowWeaker) throw new WeakerChangeError();
        calls.push("tenantOrgSettings.setPiiProtection");
        return commitChange([save.audit?.(policy as PiiProtectionSettings, 5, weaker)], { stored: policy, revision: 5 });
      },
      get: async () => ({ providerKeys: { openai: true } })
    }, ["setPiiProtection"]),
    localAuth,
    dataRoutes
  });
  await registerAdminRoutes(app, adminStores(calls, writes, dataRoutes));
  await registerOrganizationSkillSubmissionRoutes(app, {
    organizationSkillSubmissions: recordingStore<SubmissionStores["organizationSkillSubmissions"]>(calls, "organizationSkillSubmissions", {
      // The release runs the owner notice in its transaction.
      release: async (_tenantId, _userId, _id, _input, options) => {
        await (options as { alsoInTransaction?: (client: unknown, skillId: string) => Promise<void> }).alsoInTransaction?.(CHANGE_TRANSACTION, SKILL_ID);
      },
      get: async () => SUBMISSION
    }),
    dataRoutes
  });
  await registerProjectSkillRoutes(app, {
    projectSkills: recordingStore<ProjectSkillStores["projectSkills"]>(calls, "projectSkills", {
      // The release runs the owner notice in its transaction.
      action: async (_tenantId, _userId, _projectId, _skillId, _action, _version, options) => {
        await (options as { alsoInTransaction?: (client: unknown) => Promise<void> }).alsoInTransaction?.(CHANGE_TRANSACTION);
        return PROJECT_SKILL;
      }
    }),
    dataRoutes
  });
  await app.ready();
  return { app, calls, consume, pool, stepUp, notices, writes, checkpoint };
}

async function send(app: FastifyInstance, route: StepUpRoute, stepUpToken?: string) {
  const method = route.split(" ", 1)[0] as "POST" | "PUT" | "PATCH" | "DELETE";
  const { url, payload } = CASES[route];
  return app.inject({
    method, url,
    headers: { origin: ORIGIN, ...(stepUpToken ? { "x-step-up": stepUpToken } : {}) },
    ...(payload ? { payload } : {})
  });
}

describe("step-up routes", () => {
  test.each(Object.keys(STEP_UP_ROUTES) as StepUpRoute[])("%s refuses a request that carries only an access token", async (route) => {
    const { app, calls, consume, pool, notices, checkpoint } = await buildApp();
    const assertRedisUnchanged = checkpoint();
    const res = await send(app, route);

    expect(res.statusCode).toBe(403);
    // The answer names the action, so the browser can ask for the proof.
    expect(res.json()).toEqual({ error: "step_up_required", action: STEP_UP_ROUTES[route] });
    // The route asked for a step-up token for its own action.
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledWith(undefined, expect.objectContaining({ action: STEP_UP_ROUTES[route], familyId: "family-1" }));
    // This fixture supplies an admitted session. The real app's admin limiter
    // writes rl:admin_query:{user,tenant}:* counters through EVAL before proof.
    // The proof endpoints also write login_throttle:* and login_in_flight:*
    // attempt counters. Those endpoints are not sensitive-action refusals.
    // These accounting layers are not installed here. This checkpoint covers
    // route writes to refresh families, challenges, flows and security state.
    // The SQL and service assertions cover credentials, owners and contexts.
    expect(calls.filter((call) => !READS.has(call))).toEqual([]);
    const statements = pool.queries.map((query) => query.text.trim())
      .filter((text) => !["BEGIN", "COMMIT", "ROLLBACK"].includes(text) && !text.startsWith("SELECT set_config("));
    expect(statements.filter((text) => !READ_SQL.some((allowed) => text.startsWith(allowed)))).toEqual([]);
    expect(notices).toEqual([]);
    assertRedisUnchanged();
    await app.close();
  });

  test.each(DATA_ROUTE_KEYS)("%s changes the setting with a step-up token and queues the owner notice with the change", async (route) => {
    const { app, calls, stepUp, notices } = await buildApp();
    const { token } = await stepUp.create({
      userId: IDENTITY.userId, tenantId: IDENTITY.tenantId, familyId: "family-1",
      securityVersion: IDENTITY.securityVersion, action: STEP_UP_ROUTES[route]
    }, ["pwd", "otp"]);

    const res = await send(app, route, token);

    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(calls.filter((call) => !READS.has(call)).length).toBeGreaterThan(0);
    // One notice, in the transaction of the change's audit event, with no value.
    expect(notices).toEqual([{ client: CHANGE_TRANSACTION, tenantId: IDENTITY.tenantId, actorUserId: IDENTITY.userId, change: DATA_ROUTES[route] }]);
    expect(JSON.stringify(notices)).not.toContain(PROVIDER_KEY);
  });

  test.each(DATA_ROUTE_KEYS)("%s refuses a step-up token for another action", async (route) => {
    const { app, stepUp, notices } = await buildApp();
    const { token } = await stepUp.create({
      userId: IDENTITY.userId, tenantId: IDENTITY.tenantId, familyId: "family-1",
      securityVersion: IDENTITY.securityVersion, action: "member.create"
    }, ["pwd", "otp"]);

    const res = await send(app, route, token);

    expect(res.statusCode).toBe(403);
    expect(notices).toEqual([]);
  });

  // WorkOS owns that sign-in, and Cogniplane cannot ask WorkOS for a fresh
  // proof: the change goes through, and the owners get the notice.
  test.each(DATA_ROUTE_KEYS)("%s from a WorkOS session needs no step-up and queues the owner notice", async (route) => {
    const { app, consume, notices } = await buildApp({ authSource: "workos" });

    const res = await send(app, route);

    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(consume).not.toHaveBeenCalled();
    expect(notices).toEqual([{ client: CHANGE_TRANSACTION, tenantId: IDENTITY.tenantId, actorUserId: IDENTITY.userId, change: DATA_ROUTES[route] }]);
  });

  // A small change must not ask for a password or send email.
  test("a tenant settings save that changes no field that routes data needs no step-up and sends no notice", async () => {
    const { app, consume, notices, writes } = await buildApp();
    const res = await app.inject({
      method: "PUT", url: "/admin/tenant-settings", headers: { origin: ORIGIN },
      // The stored hosts again, and a new effort selector.
      payload: { showEffortSelector: false, approvedSandboxEgressDomains: [], policyEnforcementMode: "monitor" }
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(consume).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
    // The unchanged protected fields are not written.
    expect(writes).toEqual([{ method: "updateTenantSettings", args: [IDENTITY.tenantId, { showEffortSelector: false }, expect.any(Function)] }]);
  });

  test("an integration turned off needs no step-up and sends no notice", async () => {
    const { app, consume, notices } = await buildApp();
    const res = await app.inject({
      method: "PUT", url: `/admin/integrations/${INTEGRATION_ID}`, headers: { origin: ORIGIN }, payload: { readsEnabled: false }
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(consume).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  });

  // A request for a server that does not exist answers 404 before the
  // step-up check, so the user's proof stays usable.
  test.each([
    ["PUT /admin/mcp-servers/:serverId", "/admin/mcp-servers/no-such-server", { ...MCP_BODY, serverId: "no-such-server" }],
    ["PUT /admin/mcp-servers/:serverId/setup", "/admin/mcp-servers/no-such-server/setup", { ...MCP_BODY, serverId: "no-such-server", audience: "members", expectedVersion: 1 }],
    ["PUT /admin/mcp-servers/:serverId/inherited-availability", `/admin/mcp-servers/${MCP_SERVER_ID}/inherited-availability`, { audience: "members" }],
    ["POST /admin/mcp-servers/:serverId/publish", "/admin/mcp-servers/no-such-server/publish", undefined]
  ] as const)("%s: a missing server answers 404 and does not spend the step-up token", async (route, url, payload) => {
    const { app, consume, stepUp, notices } = await buildApp();
    const { token } = await stepUp.create({
      userId: IDENTITY.userId, tenantId: IDENTITY.tenantId, familyId: "family-1",
      securityVersion: IDENTITY.securityVersion, action: STEP_UP_ROUTES[route]
    }, ["pwd", "otp"]);
    const method = route.startsWith("POST ") ? "POST" : "PUT";
    const missing = await app.inject({ method, url, payload, headers: { origin: ORIGIN, "x-step-up": token } });
    expect(missing.statusCode).toBe(404);
    expect(consume).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
    // The same token still works for the server that exists.
    expect((await send(app, route, token)).statusCode).toBeLessThan(300);
  });

  // A connection edit from an old draft answers 409 before the step-up check,
  // so the user's proof stays usable for the save after the review.
  test("PUT /admin/mcp-servers/:serverId/setup: a stale version answers 409 and does not spend the step-up token", async () => {
    const route = "PUT /admin/mcp-servers/:serverId/setup";
    const { app, consume, stepUp, notices } = await buildApp();
    const { token } = await stepUp.create({
      userId: IDENTITY.userId, tenantId: IDENTITY.tenantId, familyId: "family-1",
      securityVersion: IDENTITY.securityVersion, action: STEP_UP_ROUTES[route]
    }, ["pwd", "otp"]);
    const stale = await app.inject({
      method: "PUT", url: `/admin/mcp-servers/${MCP_SERVER_ID}/setup`,
      payload: { ...MCP_BODY, audience: "off", expectedVersion: MCP_SERVER.version + 1 },
      headers: { origin: ORIGIN, "x-step-up": token }
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: "mcp_server_conflict" });
    expect(consume).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
    expect((await send(app, route, token)).statusCode).toBeLessThan(300);
  });

  // A Policy Center change that makes the policy no weaker must not ask for
  // a password or send email (policy-weakening.ts).
  test.each([
    ["a new block rule", "POST", "/admin/policy/rules", { name: "Block deletes", effect: "block", priority: 0 }],
    ["a new allow rule after the block rule", "POST", "/admin/policy/rules", { name: "Allow reads", effect: "allow", priority: 15 }],
    ["a renamed block rule", "PATCH", `/admin/policy/rules/${BLOCK_RULE.ruleId}`, { name: "Block customer exports", expectedRevision: 1 }],
    ["a stricter effect", "PATCH", `/admin/policy/rules/${ALLOW_RULE.ruleId}`, { effect: "require_approval", expectedRevision: 1 }],
    ["the allow rule removed", "DELETE", `/admin/policy/rules/${ALLOW_RULE.ruleId}`, undefined],
    ["the same order", "PUT", "/admin/policy/rules/order", { ruleIds: [BLOCK_RULE.ruleId, ALLOW_RULE.ruleId] }]
  ] as const)("%s needs no step-up and sends no notice", async (_name, method, url, payload) => {
    const { app, calls, consume, notices } = await buildApp();
    const res = await app.inject({ method, url, headers: { origin: ORIGIN }, ...(payload ? { payload } : {}) });
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(consume).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
    expect(calls.some((call) => call.startsWith("policyRules."))).toBe(true);
  });

  // A save from an older revision of the rule answers 409 before the change
  // is classified, so the user's proof stays usable for the next save.
  test("PATCH /admin/policy/rules/:ruleId: a stale save answers 409 and does not spend the step-up token", async () => {
    const route = "PATCH /admin/policy/rules/:ruleId";
    const { app, consume, stepUp, notices } = await buildApp();
    const { token } = await stepUp.create({
      userId: IDENTITY.userId, tenantId: IDENTITY.tenantId, familyId: "family-1",
      securityVersion: IDENTITY.securityVersion, action: STEP_UP_ROUTES[route]
    }, ["pwd", "otp"]);
    const url = `/admin/policy/rules/${BLOCK_RULE.ruleId}`;
    // Another admin renames the rule (not weaker): it is now at revision 2.
    expect((await app.inject({ method: "PATCH", url, headers: { origin: ORIGIN },
      payload: { name: "Block customer exports", expectedRevision: 1 } })).statusCode).toBe(200);
    // This save turns the rule off from revision 1.
    const stale = await app.inject({ method: "PATCH", url, headers: { origin: ORIGIN, "x-step-up": token },
      payload: { enabled: false, expectedRevision: 1 } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("policy_rule_conflict");
    expect(consume).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
    const fresh = await app.inject({ method: "PATCH", url, headers: { origin: ORIGIN, "x-step-up": token },
      payload: { enabled: false, expectedRevision: 2 } });
    expect(fresh.statusCode, fresh.body).toBeLessThan(300);
  });

  test.each([
    ["PATCH /admin/policy/rules/:ruleId", "PATCH", { enabled: false, expectedRevision: 1 }],
    ["DELETE /admin/policy/rules/:ruleId", "DELETE", undefined]
  ] as const)("%s: a missing rule answers 404 and does not spend the step-up token", async (route, method, payload) => {
    const { app, consume, stepUp, notices } = await buildApp();
    const { token } = await stepUp.create({
      userId: IDENTITY.userId, tenantId: IDENTITY.tenantId, familyId: "family-1",
      securityVersion: IDENTITY.securityVersion, action: STEP_UP_ROUTES[route]
    }, ["pwd", "otp"]);
    const missing = await app.inject({
      method, url: "/admin/policy/rules/pol_missing", headers: { origin: ORIGIN, "x-step-up": token }, ...(payload ? { payload } : {})
    });
    expect(missing.statusCode).toBe(404);
    expect(consume).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
    expect((await send(app, route, token)).statusCode).toBeLessThan(300);
  });

  test("a PII save that makes the protection no weaker needs no step-up and sends no notice", async () => {
    const { app, calls, consume, notices } = await buildApp();
    // The stored policy again, with protection on in block mode.
    const res = await app.inject({ method: "PUT", url: "/tenant/settings/pii", headers: { origin: ORIGIN }, payload: { ...PII_ON, expectedRevision: 4 } });
    expect(res.statusCode, res.body).toBe(200);
    expect(consume).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
    expect(calls).toContain("tenantOrgSettings.setPiiProtection");
  });

  test("removing the skill marketplace address needs no step-up and sends no notice", async () => {
    const { app, calls, consume, notices } = await buildApp();
    const res = await app.inject({
      method: "PUT", url: "/tenant/settings/marketplace", headers: { origin: ORIGIN }, payload: { skillMarketplaceManifestUrl: null }
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(consume).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
    expect(calls).toContain("tenantOrgSettings.setMarketplaceUrl");
  });

  // Turning the PII protection off sends the field names, never a value.
  test("the PII notice names the weaker fields only", async () => {
    const { app, stepUp, notices } = await buildApp();
    const { token } = await stepUp.create({
      userId: IDENTITY.userId, tenantId: IDENTITY.tenantId, familyId: "family-1",
      securityVersion: IDENTITY.securityVersion, action: "tenant.pii_settings"
    }, ["pwd", "otp"]);
    const payload = { ...PII_ON, scopes: { chatPrompts: true, uploads: false }, provider: { type: "openai-compatible", model: "census-model-v2" } };
    const res = await app.inject({ method: "PUT", url: "/tenant/settings/pii", headers: { origin: ORIGIN, "x-step-up": token }, payload });
    expect(res.statusCode, res.body).toBe(200);
    expect(notices.map((notice) => notice.change)).toEqual([
      { setting: "pii_protection", fields: ["Scanned content: Uploads", "Detection model"] }
    ]);
    expect(JSON.stringify(notices)).not.toContain("census-model-v2");
  });

  test("every route in the list that does not act on an account is a data route with a notice", () => {
    const routes = Object.keys(STEP_UP_ROUTES).filter((route) => !isAccountRoute(route));
    expect(routes.sort()).toEqual([...DATA_ROUTE_KEYS].sort());
  });

  test("turning a project skill off needs no step-up and sends no notice", async () => {
    const { app, calls, consume, notices } = await buildApp();
    const res = await app.inject({
      method: "POST", url: `/projects/${PROJECT_ID}/skills/${PROJECT_SKILL_ID}/action`, headers: { origin: ORIGIN },
      payload: { scope: PROJECT_SCOPE, version: 1, action: "disable" }
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(consume).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
    expect(calls).toContain("projectSkills.action");
  });

  // A proof for one route cannot be spent on another, and no action waits
  // without a route. An overlay's actions belong to the overlay's routes.
  test("each step-up action belongs to exactly one route", () => {
    const actions = [...Object.values(STEP_UP_ROUTES), ...OVERLAY_STEP_UP_ACTIONS];
    expect(new Set(actions).size).toBe(actions.length);
    expect([...actions].sort()).toEqual([...STEP_UP_ACTIONS].sort());
  });
});
