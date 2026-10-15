import { createHmac } from "node:crypto";

import { z } from "zod";

import type { AppConfig } from "../../../config.js";
import type { AuditEventStore } from "../../audit-event-store.js";
import type { AuditEventType } from "../../audit-event-types.js";
import type { RuntimeInvalidator } from "../contracts.js";
import { buildIntegrationRedirectUrl } from "../integration-oauth-helpers.js";
import type { IntegrationStateStore } from "../integration-state-store.js";
import {
  JiraLifecycleConflictError,
  type JiraCleanupReason,
  type JiraCleanupRecord,
  type JiraConnectionRecord,
  type JiraConnectionStore,
  type JiraIdentity,
  type PipedreamBinding
} from "./jira-connection-store.js";
import {
  buildJiraReadUrl,
  isJiraCloudId,
  JIRA_ACCESSIBLE_RESOURCES_URL,
  JiraReadRequestError,
  type JiraReadRequest
} from "./jira-read-endpoints.js";
import {
  PipedreamConnectClient,
  PipedreamRequestError,
  readPipedreamSettings,
  type PipedreamAccount
} from "./pipedream-client.js";
import { integrationAccountChangedMessage } from "../integration-account-binding.js";

export const JIRA_INTEGRATION_ID = "jira";
const PIPEDREAM_JIRA_APP = "jira";
const CONNECT_TOKEN_TTL_SECONDS = 10 * 60;
// List-and-delete passes per cleanup. The last pass that finds no account
// proves completion; accounts that keep appearing make the cleanup fail.
const MAX_CLEANUP_ROUNDS = 3;

// Fixed cleanup failure messages. They are stored and shown to
// administrators, so they never contain upstream content.
const CLEANUP_FAILURE = {
  notConfigured: "Pipedream is not configured on this deployment.",
  projectChanged: "This cleanup belongs to another Pipedream project or environment than the current configuration.",
  unavailable: "Pipedream is unavailable. Try again later.",
  incompleteListing: "Pipedream did not return a complete account list.",
  accountsRemain: "Jira accounts remained in Pipedream after deletion.",
  morePending: "More Jira cleanups are pending. Try again."
} as const;

const AccessibleResourcesSchema = z.array(z.object({
  id: z.string(),
  name: z.string().max(300),
  url: z.string().url().max(2048)
}).passthrough());

export type JiraSiteView = { siteId: string; name: string; url: string };

export type JiraConnectionSummary = {
  accountId: string;
  accountName: string | null;
  site: JiraSiteView;
  connectedAt: string;
  updatedAt: string;
};

export type JiraAccountCandidate = {
  accountId: string;
  accountName: string | null;
  healthy: boolean;
  createdAt: string | null;
};

export type JiraCleanupView = {
  cleanupId: string;
  userId: string;
  accountId: string | null;
  reason: JiraCleanupReason;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type JiraCleanupOutcome =
  | { status: "completed"; remoteAccountsDeleted: number }
  | { status: "failed"; cleanup: JiraCleanupView };

export type JiraReadResult =
  | { ok: true; data: unknown; site: JiraSiteView }
  | { ok: false; error: string; status?: number };

/** Stable codes the routes map to HTTP statuses. Messages are safe to show. */
export class JiraConnectionError extends Error {
  constructor(
    readonly code:
      | "not_configured"
      | "account_not_found"
      | "account_unhealthy"
      | "site_not_accessible"
      | "upstream_unavailable"
      | "connection_changed"
      | "cleanup_not_found"
      | "cleanup_incomplete",
    message: string
  ) {
    super(message);
    this.name = "JiraConnectionError";
  }
}

function toSummary(record: JiraConnectionRecord): JiraConnectionSummary {
  return {
    accountId: record.accountId,
    accountName: record.accountName,
    site: { siteId: record.cloudId, name: record.siteName, url: record.siteUrl },
    connectedAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

// Fixed messages only: Jira error bodies can echo issue data and other
// upstream content, so none of it reaches the model.
function toCleanupView(record: JiraCleanupRecord): JiraCleanupView {
  return {
    cleanupId: record.cleanupId,
    userId: record.userId,
    accountId: record.accountId,
    reason: record.reason,
    attempts: record.attempts,
    lastError: record.lastError,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function upstreamFailure(status: number): JiraReadResult {
  if (status === 400) {
    return { ok: false, status, error: "Jira rejected the request. Check the JQL query and the field IDs." };
  }
  if (status === 401 || status === 403) {
    return { ok: false, status, error: "Jira denied access. Reconnect Jira in settings or check your Jira permissions." };
  }
  if (status === 404) return { ok: false, status, error: "Jira resource not found, or you cannot see it." };
  if (status === 429) return { ok: false, status, error: "Jira rate limit reached. Try again later." };
  return { ok: false, status, error: "Jira request failed." };
}

function transportFailure(error: PipedreamRequestError): JiraReadResult {
  if (error.reason === "timeout") return { ok: false, error: "Jira request timed out." };
  if (error.reason === "too_large") {
    return { ok: false, error: "Jira response exceeded the size limit. Request fewer fields or a smaller page." };
  }
  return { ok: false, error: "Jira is unavailable through the connection service." };
}

export class JiraConnectionService {
  private readonly client: PipedreamConnectClient | null;
  private readonly binding: PipedreamBinding | null;

  constructor(
    private readonly config: AppConfig,
    private readonly store: Pick<
      JiraConnectionStore,
      | "get" | "getIdentity" | "bindIdentity" | "upsert" | "retire"
      | "listCleanups" | "getCleanup" | "completeCleanup" | "recordCleanupFailure"
    >,
    private readonly integrationStates: Pick<IntegrationStateStore, "get">,
    private readonly auditEvents?: Pick<AuditEventStore, "create">,
    private readonly runtimeManager?: RuntimeInvalidator,
    private readonly logger: Pick<Console, "warn"> = console,
    client?: PipedreamConnectClient | null
  ) {
    const settings = readPipedreamSettings(config);
    this.binding = settings ? { projectId: settings.projectId, environment: settings.environment } : null;
    this.client = !settings ? null : client !== undefined ? client : new PipedreamConnectClient(settings);
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  /**
   * Pipedream external user ID for one tenant member. Derived only on the
   * server from the authenticated tenant and user, keyed so that the vendor
   * does not see raw IDs. It labels accounts inside one shared Pipedream
   * project; it is not a tenant boundary. Ownership is enforced by comparing
   * it with each account before use, and by the RLS-scoped stored row.
   * Each disconnect or member removal moves the member to the next
   * generation, which gives a new ID. Generation 0 keeps the original input.
   */
  externalUserIdFor(tenantId: string, userId: string, generation = 0): string {
    const input = generation === 0
      ? `pipedream-external-user:v1:${tenantId}:${userId}`
      : `pipedream-external-user:v2:${JSON.stringify([tenantId, userId, generation])}`;
    const digest = createHmac("sha256", this.config.DATA_ENCRYPTION_SECRET).update(input).digest("base64url");
    return `cp1_${digest}`;
  }

  /**
   * `authorizationStarted` is true when the member created a Connect link for
   * the current identity, so Pipedream can hold accounts that have no
   * selected site. `cleanupPending` is true when an earlier removal did not
   * finish. Both keep account management reachable when Jira is off.
   */
  async getConnectionStatus(tenantId: string, userId: string): Promise<{
    configured: boolean;
    userConnection: JiraConnectionSummary | null;
    authorizationStarted: boolean;
    cleanupPending: boolean;
  }> {
    const [record, identity, cleanups] = await Promise.all([
      this.store.get(tenantId, userId),
      this.store.getIdentity(tenantId, userId),
      this.store.listCleanups(tenantId, userId)
    ]);
    return {
      configured: this.isConfigured(),
      userConnection: record ? toSummary(record) : null,
      authorizationStarted: identity !== null,
      cleanupPending: cleanups.length > 0
    };
  }

  /** `IntegrationConnectionProbe.connectedAccountId`: the stored Pipedream account. */
  async connectedAccountId(tenantId: string, userId: string): Promise<string | null> {
    return (await this.store.get(tenantId, userId))?.accountId ?? null;
  }

  /** `IntegrationConnectionProbe.hasConnection`, read at session start. */
  async hasConnection(tenantId: string, userId: string): Promise<boolean> {
    if (!this.isConfigured()) return false;
    return (await this.store.get(tenantId, userId)) !== null;
  }

  /**
   * `IntegrationConnectionProbe.deleteConnection`, called after member
   * removal. The membership delete trigger is the only retirement for a
   * removal: it removed the mapping and recorded the cleanup in the same
   * transaction. This call never retires anything, because the member can be
   * added again and authorize a new identity before it runs. It only runs the
   * pending cleanups, which target retired IDs, and throws when one stays
   * incomplete, so that the caller logs it. The pending record stays for an
   * administrator retry.
   */
  async deleteConnection(tenantId: string, userId: string): Promise<boolean> {
    const outcome = await this.runMemberCleanups(tenantId, userId);
    if (outcome.failure) throw new JiraConnectionError("cleanup_incomplete", outcome.failure);
    return outcome.completed > 0;
  }

  async getAuthorizationUrl(input: { tenantId: string; userId: string }): Promise<{ url: string }> {
    const client = this.requireClient();
    const identity = await this.identity(input.tenantId, input.userId, true);
    const result = await this.upstream(() => client.createConnectToken({
      externalUserId: identity.externalUserId,
      successRedirectUri: buildIntegrationRedirectUrl(this.config, "/settings/jira", { jiraAuth: "return" }),
      errorRedirectUri: buildIntegrationRedirectUrl(this.config, "/settings/jira", { jiraAuth: "error" }),
      expiresInSeconds: CONNECT_TOKEN_TTL_SECONDS
    }));
    const url = new URL(result.connectLinkUrl);
    if (url.protocol !== "https:") {
      throw new JiraConnectionError("upstream_unavailable", "Pipedream returned an unexpected connect link.");
    }
    url.searchParams.set("app", PIPEDREAM_JIRA_APP);
    return { url: url.toString() };
  }

  /** Jira accounts that the member authorized for the current identity. Sites load per account. */
  async listCandidates(tenantId: string, userId: string): Promise<JiraAccountCandidate[]> {
    const client = this.requireClient();
    const identity = await this.identity(tenantId, userId, false);
    if (!identity) return [];
    const accounts = await this.upstream(() => client.listAccounts({
      externalUserId: identity.externalUserId,
      app: PIPEDREAM_JIRA_APP
    }));
    return accounts
      .filter((account) => this.isOwnedJiraAccount(account, identity.externalUserId))
      .map((account) => ({
        accountId: account.id,
        accountName: account.name ?? null,
        healthy: account.healthy !== false && account.dead !== true,
        createdAt: account.created_at ?? null
      }));
  }

  /** Sites of one owned, healthy account. One account lookup and one site lookup. */
  async listAccountSites(tenantId: string, userId: string, accountId: string): Promise<JiraSiteView[]> {
    const identity = await this.identity(tenantId, userId, false);
    if (!identity) throw new JiraConnectionError("account_not_found", "Jira account not found.");
    const account = await this.requireUsableAccount(identity, accountId);
    return this.upstream(() => this.listSites(identity.externalUserId, account.id));
  }

  /**
   * Binds one Pipedream account and one Jira site to the member. Nothing from
   * the browser is trusted beyond the two IDs: the account must belong to the
   * member's current external ID and the Jira app, and the site must be in
   * that account's accessible resources. The save fails when a disconnect or
   * a member removal changed the identity during the remote checks.
   */
  async selectConnection(
    tenantId: string,
    userId: string,
    input: { accountId: string; siteId: string }
  ): Promise<JiraConnectionSummary> {
    this.requireClient();
    const identity = await this.identity(tenantId, userId, false);
    if (!identity) throw new JiraConnectionError("account_not_found", "Jira account not found.");
    const account = await this.requireUsableAccount(identity, input.accountId);

    const site = (await this.upstream(() => this.listSites(identity.externalUserId, account.id)))
      .find((candidate) => candidate.siteId === input.siteId.toLowerCase());
    if (!site) {
      throw new JiraConnectionError("site_not_accessible", "This Jira site is not available to the selected account.");
    }

    let record: JiraConnectionRecord;
    try {
      record = await this.store.upsert({
        tenantId,
        userId,
        externalUserId: identity.externalUserId,
        accountId: account.id,
        accountName: account.name ?? null,
        cloudId: site.siteId,
        siteName: site.name,
        siteUrl: site.url
      }, identity);
    } catch (error) {
      throw this.lifecycleError(error);
    }
    await this.audit(tenantId, userId, "user.jira.connected", { accountId: account.id, siteId: site.siteId });
    await this.invalidate(tenantId, userId);
    return toSummary(record);
  }

  /**
   * Removes the member's Jira connection. First, one short transaction
   * removes the local mapping, retires the external ID, and records a pending
   * cleanup. A remote failure cannot undo that step. Then every pending
   * cleanup of the member runs: it deletes all Jira accounts of the retired
   * IDs in Pipedream. Accounts authorized later use a new ID and are not
   * touched. Throws `cleanup_incomplete` when a cleanup stays pending; a
   * retry continues it. This removes Pipedream's stored credentials; it does
   * not prove that Atlassian revoked the grant.
   */
  async disconnect(tenantId: string, userId: string): Promise<boolean> {
    const retired = await this.store.retire(tenantId, userId, "user_disconnect", this.binding);
    if (retired) {
      await this.audit(tenantId, userId, "user.jira.disconnected", {
        accountId: retired.accountId,
        cleanupId: retired.cleanupId
      });
      await this.invalidate(tenantId, userId);
    }
    const outcome = await this.runMemberCleanups(tenantId, userId);
    if (outcome.failure) {
      throw new JiraConnectionError(
        "cleanup_incomplete",
        `Cogniplane removed your Jira connection, but some Jira accounts are still stored in Pipedream. ${outcome.failure}`
      );
    }
    return retired !== null || outcome.completed > 0;
  }

  /** Pending cleanups in the tenant, oldest first, for administrators. */
  async listPendingCleanups(tenantId: string): Promise<JiraCleanupView[]> {
    return (await this.store.listCleanups(tenantId)).map(toCleanupView);
  }

  /** Runs one pending cleanup again. Only the retired external ID is affected. */
  async retryCleanup(tenantId: string, cleanupId: string): Promise<JiraCleanupOutcome> {
    const cleanup = await this.store.getCleanup(tenantId, cleanupId);
    if (!cleanup) throw new JiraConnectionError("cleanup_not_found", "Jira cleanup not found.");
    return this.runCleanup(cleanup);
  }

  /**
   * The only Jira read path for tools. Checks live tenant enablement, the
   * stored connection, and the stored account's upstream owner on every
   * call, then sends one allowlisted GET.
   */
  async read(tenantId: string, userId: string, request: JiraReadRequest | { kind: "sites" },
    // The account the turn recorded (see boundIntegrationAccount).
    expectedAccountId?: string | null): Promise<JiraReadResult> {
    const client = this.client;
    if (!client) return { ok: false, error: "Jira is not configured on this deployment." };
    const state = await this.integrationStates.get(tenantId, JIRA_INTEGRATION_ID);
    if (!state?.readsEnabled) return { ok: false, error: "Jira reads are disabled for this organization." };
    const record = await this.store.get(tenantId, userId);
    if (expectedAccountId !== undefined && expectedAccountId !== (record?.accountId ?? null)) {
      return { ok: false, error: integrationAccountChangedMessage("Jira") };
    }
    if (!record) {
      return { ok: false, error: "No Jira connection found. Connect Jira in Settings > Connected accounts." };
    }
    const site = toSummary(record).site;

    try {
      // Compare with the stored identity, not a newly derived one, so rows
      // made before a DATA_ENCRYPTION_SECRET rotation keep working.
      const account = await client.getAccount(record.accountId);
      if (!account || !this.isOwnedJiraAccount(account, record.externalUserId)) {
        return { ok: false, error: "Your Jira connection is no longer available. Connect Jira again in Settings > Connected accounts." };
      }
      if (account.healthy === false || account.dead === true) {
        return { ok: false, error: "Your Jira account needs to be reconnected in Settings > Connected accounts." };
      }
      if (request.kind === "sites") {
        return { ok: true, data: await this.listSites(record.externalUserId, record.accountId), site };
      }
      const url = buildJiraReadUrl(record.cloudId, request);
      const result = await client.proxyGet({ externalUserId: record.externalUserId, accountId: record.accountId, url });
      if (result.status < 200 || result.status >= 300) return upstreamFailure(result.status);
      return { ok: true, data: result.body, site };
    } catch (error) {
      if (error instanceof PipedreamRequestError) return transportFailure(error);
      if (error instanceof JiraConnectionError || error instanceof JiraReadRequestError) {
        return { ok: false, error: error.message };
      }
      throw error;
    }
  }

  private async listSites(externalUserId: string, accountId: string): Promise<JiraSiteView[]> {
    const client = this.requireClient();
    const result = await client.proxyGet({ externalUserId, accountId, url: JIRA_ACCESSIBLE_RESOURCES_URL });
    if (result.status < 200 || result.status >= 300) {
      throw new JiraConnectionError("upstream_unavailable", "Could not list Jira sites for this account.");
    }
    const parsed = AccessibleResourcesSchema.safeParse(result.body);
    if (!parsed.success) {
      throw new JiraConnectionError("upstream_unavailable", "Could not list Jira sites for this account.");
    }
    return parsed.data
      .filter((resource) => isJiraCloudId(resource.id) && new URL(resource.url).protocol === "https:")
      .map((resource) => ({ siteId: resource.id.toLowerCase(), name: resource.name, url: resource.url }));
  }

  /**
   * Runs one bounded batch of the member's pending cleanups. When cleanups
   * remain after the batch (more than one batch, or new ones), the result
   * is a failure, so that a caller never reports a complete cleanup.
   */
  private async runMemberCleanups(tenantId: string, userId: string): Promise<{ completed: number; failure: string | null }> {
    let completed = 0;
    let failure: string | null = null;
    for (const cleanup of await this.store.listCleanups(tenantId, userId)) {
      const outcome = await this.runCleanup(cleanup);
      if (outcome.status === "completed") completed += 1;
      else failure ??= outcome.cleanup.lastError;
    }
    if (!failure && (await this.store.listCleanups(tenantId, userId)).length > 0) failure = CLEANUP_FAILURE.morePending;
    return { completed, failure };
  }

  /**
   * Deletes every Jira account of the cleanup's external ID, then deletes the
   * record. On failure the record stays, with a fixed error message. Two
   * concurrent runs of one record are safe: deletion is idempotent.
   */
  private async runCleanup(cleanup: JiraCleanupRecord): Promise<JiraCleanupOutcome> {
    const fail = async (error: string): Promise<JiraCleanupOutcome> => {
      const updated = await this.store.recordCleanupFailure(cleanup.tenantId, cleanup.cleanupId, error);
      await this.audit(cleanup.tenantId, cleanup.userId, "user.jira.cleanup_failed", {
        cleanupId: cleanup.cleanupId,
        reason: cleanup.reason,
        error
      });
      return { status: "failed", cleanup: toCleanupView(updated ?? { ...cleanup, lastError: error }) };
    };
    const client = this.client;
    const binding = this.binding;
    if (!client || !binding) return fail(CLEANUP_FAILURE.notConfigured);
    // Records without a binding come from migration 060 data. They use the
    // current project.
    if (cleanup.binding && (cleanup.binding.projectId !== binding.projectId
      || cleanup.binding.environment !== binding.environment)) {
      return fail(CLEANUP_FAILURE.projectChanged);
    }

    let deleted: number;
    try {
      deleted = await this.deleteAllAccounts(client, cleanup.externalUserId, cleanup.accountId);
    } catch (error) {
      if (error instanceof PipedreamRequestError) {
        return fail(error.reason === "incomplete_listing" ? CLEANUP_FAILURE.incompleteListing : CLEANUP_FAILURE.unavailable);
      }
      if (error instanceof JiraConnectionError && error.code === "cleanup_incomplete") return fail(error.message);
      throw error;
    }
    await this.store.completeCleanup(cleanup.tenantId, cleanup.cleanupId);
    await this.audit(cleanup.tenantId, cleanup.userId, "user.jira.cleanup_completed", {
      cleanupId: cleanup.cleanupId,
      reason: cleanup.reason,
      remoteAccountsDeleted: deleted
    });
    return { status: "completed", remoteAccountsDeleted: deleted };
  }

  /**
   * Lists all accounts first, then deletes them, so that deletion cannot
   * shift pages. Completes only when a full listing finds no owned account.
   * A stored account that is gone or now foreign is skipped.
   */
  private async deleteAllAccounts(
    client: PipedreamConnectClient,
    externalUserId: string,
    storedAccountId: string | null
  ): Promise<number> {
    let deleted = 0;
    for (let round = 0; round < MAX_CLEANUP_ROUNDS; round += 1) {
      const accountIds = new Set((await client.listAccounts({ externalUserId, app: PIPEDREAM_JIRA_APP }))
        .filter((account) => this.isOwnedJiraAccount(account, externalUserId))
        .map((account) => account.id));
      if (round === 0 && storedAccountId && !accountIds.has(storedAccountId)) {
        const stored = await client.getAccount(storedAccountId);
        if (stored && this.isOwnedJiraAccount(stored, externalUserId)) accountIds.add(stored.id);
      }
      if (accountIds.size === 0) return deleted;
      for (const accountId of accountIds) {
        if (await client.deleteAccount(accountId)) deleted += 1;
      }
    }
    throw new JiraConnectionError("cleanup_incomplete", CLEANUP_FAILURE.accountsRemain);
  }

  /**
   * The member's current identity. With `create`, a new one is made when the
   * member has none; otherwise null means that no authorization was started.
   */
  private async identity(tenantId: string, userId: string, create: true): Promise<JiraIdentity>;
  private async identity(tenantId: string, userId: string, create: false): Promise<JiraIdentity | null>;
  private async identity(tenantId: string, userId: string, create: boolean): Promise<JiraIdentity | null> {
    const binding = this.binding;
    if (!binding) throw new JiraConnectionError("not_configured", "Jira is not configured on this deployment.");
    try {
      return await this.store.bindIdentity(tenantId, userId, binding,
        (generation) => this.externalUserIdFor(tenantId, userId, generation), create);
    } catch (error) {
      throw this.lifecycleError(error);
    }
  }

  private async requireUsableAccount(identity: JiraIdentity, accountId: string): Promise<PipedreamAccount> {
    const client = this.requireClient();
    const account = await this.upstream(() => client.getAccount(accountId));
    // One error for missing and foreign accounts, so IDs cannot be probed.
    if (!account || !this.isOwnedJiraAccount(account, identity.externalUserId)) {
      throw new JiraConnectionError("account_not_found", "Jira account not found.");
    }
    if (account.healthy === false || account.dead === true) {
      throw new JiraConnectionError("account_unhealthy", "This Jira account needs to be reconnected.");
    }
    return account;
  }

  private lifecycleError(error: unknown): unknown {
    if (!(error instanceof JiraLifecycleConflictError)) return error;
    return new JiraConnectionError(
      "connection_changed",
      "Your Jira connection changed while this request ran. Reload the page and try again."
    );
  }

  private isOwnedJiraAccount(account: PipedreamAccount, externalUserId: string): boolean {
    return account.external_id === externalUserId && account.app?.name_slug === PIPEDREAM_JIRA_APP;
  }

  private requireClient(): PipedreamConnectClient {
    if (!this.client) throw new JiraConnectionError("not_configured", "Jira is not configured on this deployment.");
    return this.client;
  }

  private async upstream<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof PipedreamRequestError) {
        throw new JiraConnectionError("upstream_unavailable", "Pipedream is unavailable. Try again later.");
      }
      throw error;
    }
  }

  private async audit(tenantId: string, userId: string, type: AuditEventType, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.auditEvents?.create({ tenantId, sessionId: null, userId, type, payload });
    } catch (err) {
      this.logger.warn({ err }, "Failed to audit Jira connection change");
    }
  }

  private async invalidate(tenantId: string, userId: string): Promise<void> {
    try {
      await this.runtimeManager?.invalidateRuntimesForIntegration(tenantId, userId, JIRA_INTEGRATION_ID);
    } catch (err) {
      this.logger.warn({ err }, "Failed to refresh runtimes after Jira connection change");
    }
  }
}
