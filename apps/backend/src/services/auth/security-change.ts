import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import type { AppConfig } from "../../config.js";
import { type Pool, withTenantScope } from "../../lib/db.js";
import type { RuntimeAdapter } from "../../runtime-contracts.js";
import { lockAccountChats, type ReleasedAccountSandbox, releaseAccountSandboxes } from "../session-execution-store.js";

// A security change of a local account increments
// local_identities.security_version: password change or reset, manager reset,
// disable, enable, sign out everywhere, removal, operator recovery, a factor
// change, a stricter MFA rule. The new version ends the account's sessions
// (lib/auth-admission.ts). Work that already started under the old version
// must stop too, so three layers apply:
//
// 1. After the commit, `stopActiveWork` stops the account's runtimes in this
//    process: interactive turns and scheduled turns. It cannot reach other
//    replicas, and a failure is logged and never undoes the change.
// 2. Every tool execution context keeps the version that admitted its turn
//    (migration 081), and every lookup of a context compares it with the
//    account's version now (tool-execution-context-store.ts). The MCP gateway
//    looks up a context for each tool call and each tool list, so it refuses
//    the turn on every replica, also when layer 1 failed. A runtime token
//    without a live context can call no tool. The runtime reads its context
//    at each model start (summaries included), before each native tool and
//    at each approval round, so the turn itself stops at its next step on
//    every replica.
// 3. The sandboxes of the account's chats. Processes that an older turn
//    started in a sandbox go on when the turn stops, and the next turn would
//    reconnect to that sandbox. So the transaction of the change stops the
//    lease of each normal chat of the account, and takes the sandbox ids that
//    the account's chats saved (releaseAccountSandboxes in
//    session-execution-store.ts). A turn whose lease stopped ends at its next
//    lease check or heartbeat, on any replica, with the reason
//    `security_change`. After the commit, the handler kills the taken
//    sandboxes by id: `stopActiveWork` on a server, `operatorSecurityChange`
//    in an operator command. A kill that fails, or a process that stops before it, leaves
//    the sandbox running until the provider expires it; no turn reconnects to
//    it. The next turn of the chat starts a new, empty sandbox.
//
// Only the helpers that take a `SecurityChange` write security_version, and
// each records the account it changed. A `SecurityChange` comes only from
// `withSecurityChange`, which calls the after-commit handler with the
// recorded accounts. security-change-sites.test.ts lists every increment in
// the source, so a new one fails until it is listed and tested.
//
// WorkOS accounts have no security version in this database. Nothing here
// changes for them: their contexts are not compared, and only a member
// removal stops their runtimes.

/**
 * The accounts of one tenant whose active work must stop, and the sandboxes that the
 * transaction took from their chats (layer 3 above), which the handler kills.
 */
export type ChangedAccounts = { tenantId: string; userIds: string[]; releasedSandboxes: ReleasedAccountSandbox[] };

/**
 * Runs after the commit of a security change. It should not reject: the
 * change is committed, and the caller must still get its result (for example
 * the new session after a password change). withSecurityChange logs a
 * rejection and does not pass it on.
 */
export type AfterSecurityChange = (changed: ChangedAccounts) => Promise<void>;

/**
 * For the operator commands, which run in their own process with no runtimes:
 * layer 2 stops the turns. The sandboxes that the change took are killed when
 * E2B is configured (`sandboxes`), and the command waits for the kills. With no
 * E2B configuration the log names each sandbox that runs until the provider expires it.
 */
export function operatorSecurityChange(deps: {
  sandboxes: Pick<RuntimeAdapter, "destroySandbox"> | null;
  logger: SecurityChangeLogger;
}): AfterSecurityChange {
  const runtimes = deps.sandboxes ?? { destroySandbox: async () => "skipped" as const };
  return async ({ releasedSandboxes }) => {
    await Promise.all(releasedSandboxes.map((released) => killReleasedSandbox(runtimes, deps.logger, released)));
  };
}

class SecurityChangeScope {
  readonly #userIds = new Set<string>();

  constructor(
    /** The transaction, in the tenant's scope. */
    readonly client: PoolClient,
    readonly tenantId: string
  ) {}

  /** After the commit, stop the active work of this account. */
  endActiveWork(userId: string): void {
    this.#userIds.add(userId);
  }

  /**
   * The change takes the sandboxes of the account's chats under their row locks
   * before the commit (layer 3 above). A transaction that also locks a membership
   * row of the account calls this before it locks that row, so that its locks
   * come in the order that turn admission takes them (lockAccountChats).
   */
  async lockChatsBeforeMembership(userId: string): Promise<void> {
    await lockAccountChats(this.client, this.tenantId, [userId]);
  }

  get userIds(): string[] {
    return [...this.#userIds];
  }
}

/**
 * A transaction that can change security versions. Type only: the value is
 * made only by `withSecurityChange`.
 */
export type { SecurityChangeScope as SecurityChange };

/**
 * Runs `fn` in one transaction in the tenant's scope (withTenantScope). When
 * `fn` changed accounts, the same transaction then takes the sandboxes of their
 * chats (layer 3 above). After the commit, calls `afterCommit` with the accounts
 * and the sandboxes. Not on a rollback: then nothing changed. A rejection of
 * `afterCommit` is logged and does not reject: the change is committed, so the
 * caller gets its result, and the gateway check (layer 2) still refuses the
 * older turns.
 */
export async function withSecurityChange<T>(
  db: Pool,
  tenantId: string,
  afterCommit: AfterSecurityChange,
  fn: (client: PoolClient, change: SecurityChangeScope) => Promise<T>
): Promise<T> {
  const changes: ChangedAccounts[] = [];
  const result = await withTenantScope(db, tenantId, async (client) => {
    const scope = new SecurityChangeScope(client, tenantId);
    const value = await fn(client, scope);
    const userIds = scope.userIds;
    if (userIds.length > 0) {
      changes.push({ tenantId, userIds, releasedSandboxes: await releaseAccountSandboxes(client, tenantId, userIds) });
    }
    return value;
  });
  const changed = changes[0];
  if (changed) {
    const { userIds } = changed;
    try {
      await afterCommit(changed);
    } catch (error) {
      // No request logger here (services and operator commands call this).
      // Same structured line as lib/redis.ts.
      console.error(JSON.stringify({
        level: "error",
        msg: "security change: the after-commit handler failed; the change stays",
        tenantId,
        userIds,
        err: error instanceof Error ? error.message : String(error)
      }));
    }
  }
  return result;
}

type SecurityChangeLogger = Pick<FastifyBaseLogger, "error" | "info" | "warn">;

const SANDBOX_NOT_KILLED =
  "security change: the sandbox of a chat of the account was not killed; it runs until the provider expires it";

/**
 * Kills one sandbox that the change took, by id (RuntimeAdapter.destroySandbox),
 * and logs the outcome with the account. It never rejects.
 */
async function killReleasedSandbox(
  runtimes: Pick<RuntimeAdapter, "destroySandbox">,
  logger: SecurityChangeLogger,
  released: ReleasedAccountSandbox
): Promise<void> {
  const { tenantId, userId, sessionId, sandboxId } = released;
  const fields = { tenantId, userId, sessionId, sandboxId };
  try {
    const outcome = await runtimes.destroySandbox({ tenantId, sessionId, sandboxId });
    if (outcome === "killed" || outcome === "not_found") {
      logger.info({ ...fields, outcome }, "security change: the sandbox of a chat of the account is gone");
    } else if (outcome === "skipped") {
      logger.warn({ ...fields, outcome }, SANDBOX_NOT_KILLED);
    } else {
      logger.error({ ...fields, outcome }, SANDBOX_NOT_KILLED);
    }
  } catch (error) {
    logger.error({ err: error, ...fields }, SANDBOX_NOT_KILLED);
  }
}

/**
 * The after-commit handler of the server: layers 1 and 3 above. Stops the
 * runtimes of each account in this process, which ends their interactive and
 * scheduled turns (an interrupted scheduled turn records a failed run). Then
 * kills each sandbox that the transaction took.
 *
 * It does not wait for the result, so the request that made the change does
 * not wait for the disposal of the runtimes (the MCP client close, and one
 * E2B kill request for a sandbox without a saved binding), nor for the kills.
 * The turns stop before it returns: invalidateRuntimesForUser aborts each turn
 * before its first await, and only the disposal continues. So a turn of this
 * process has stopped before the kill of its sandbox is sent, and does not
 * replace the sandbox when the kill ends a command. The results are logged: a
 * failure as an error, and it never rejects.
 */
export function stopActiveWork(deps: {
  runtimes: Pick<RuntimeAdapter, "invalidateRuntimesForUser" | "destroySandbox">;
  logger: SecurityChangeLogger;
}): AfterSecurityChange {
  const stopAccount = async (tenantId: string, userId: string) => {
    try {
      const sessionIds = await deps.runtimes.invalidateRuntimesForUser(tenantId, userId, { reason: "security_change" });
      if (sessionIds.length > 0) {
        deps.logger.info({ tenantId, userId, sessionIds }, "security change: stopped the account's runtimes");
      }
    } catch (error) {
      // The change is committed. The gateway refuses the tool calls of the
      // account's older turns (layer 2), and each turn stops at its next
      // model call or approval round.
      deps.logger.error(
        { err: error, tenantId, userId },
        "security change: failed to stop the account's runtimes; their tool calls are refused"
      );
    }
  };
  return async ({ tenantId, userIds, releasedSandboxes }) => {
    for (const userId of userIds) void stopAccount(tenantId, userId);
    for (const released of releasedSandboxes) void killReleasedSandbox(deps.runtimes, deps.logger, released);
  };
}

/**
 * The security version that admits work for a request: the version that the
 * session carries. Null for a WorkOS session: WorkOS accounts have no
 * security version in this database. A local account compares null as a
 * change, so its work is refused.
 *
 * AUTH_MODE=dev-headers has no session: the request headers name the user.
 * There the work gets the account's version now, or a local account could
 * not use its tools at all. In jwt mode a request without a session gets
 * null.
 */
export async function requestSecurityVersion(
  auth: { tenantId: string; userId: string; session?: { securityVersion?: number } },
  authMode: AppConfig["AUTH_MODE"],
  readCurrent: (tenantId: string, userId: string) => Promise<number | null>
): Promise<number | null> {
  if (auth.session) return auth.session.securityVersion ?? null;
  if (authMode === "dev-headers") return readCurrent(auth.tenantId, auth.userId);
  return null;
}

// Saved work and personal connections. What a session saves to act as its
// owner later (a scheduled job, a personal connection) keeps the security
// version of that session in `owner_security_version`, and so does each tool
// execution context (layer 2 above). A row with another version than the
// owner's version now stops acting: the scheduler pauses the job, the read
// for use does not return the connection, the gateway refuses the context.
// The owner saves or confirms it again from a current session. So what a
// stolen access token saved does not outlive the revocation. WorkOS owners
// store NULL and are never compared.

/**
 * SQL condition: the row's owner has no local account (WorkOS), or the
 * account still has the row's `owner_security_version`. A security change
 * increments the version, so every row of the account's older sessions stops
 * matching at once, on every replica, in the same commit as the change. For a
 * local owner, a null version is a mismatch. One read of local_identities by
 * its primary key. `row` must be a constant table name or alias with the
 * columns `tenant_id`, `user_id` and `owner_security_version`; never pass
 * input. `NOT ownerSecurityVersionSql(row)` is "suspended".
 */
export function ownerSecurityVersionSql(row: string): string {
  return `NOT EXISTS (SELECT 1 FROM local_identities owner_identity
    WHERE owner_identity.tenant_id=${row}.tenant_id AND owner_identity.user_id=${row}.user_id
      AND owner_identity.security_version IS DISTINCT FROM ${row}.owner_security_version)`;
}

/**
 * A write without a session (an OAuth callback) carried a security version
 * that is not the owner's current one: a security change happened after the
 * session that started it. The write must not happen.
 */
export class OwnerSecurityVersionChangedError extends Error {
  constructor() {
    super("The account security changed after this authorization started.");
    this.name = "OwnerSecurityVersionChangedError";
  }
}

/**
 * Binds a write without a session to the version it started from. Locks the
 * owner's local identity (FOR SHARE, so a concurrent security change waits for
 * the caller's transaction) and throws OwnerSecurityVersionChangedError when
 * the current version is not `expected`. A local owner with `expected` NULL is
 * a difference. An owner without a local identity (WorkOS) passes only with
 * NULL. Call it in the transaction that writes, before the write.
 */
export async function assertOwnerSecurityVersion(
  client: PoolClient,
  tenantId: string,
  userId: string,
  expected: number | null
): Promise<void> {
  const result = await client.query<{ security_version: number }>(
    `SELECT security_version FROM local_identities WHERE tenant_id = $1 AND user_id = $2 FOR SHARE`,
    [tenantId, userId]
  );
  const current = result.rows[0] ? Number(result.rows[0].security_version) : null;
  if (current !== expected) throw new OwnerSecurityVersionChangedError();
}

/** The current security version of a local account, or null for a WorkOS account. */
export async function currentLocalSecurityVersion(db: Pool, tenantId: string, userId: string): Promise<number | null> {
  return withTenantScope(db, tenantId, async (client) => {
    const result = await client.query<{ security_version: number }>(
      `SELECT security_version FROM local_identities WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId]
    );
    return result.rows[0] ? Number(result.rows[0].security_version) : null;
  });
}

/**
 * The security version of the session that makes `request`, for a personal
 * connection route. An app without a config (a route test) has no
 * dev-headers mode, so a request without a session stores NULL.
 */
export function connectionSaverVersion(
  request: Pick<FastifyRequest, "auth">,
  app: { config?: Pick<AppConfig, "AUTH_MODE">; db: Pool }
): Promise<number | null> {
  return requestSecurityVersion(request.auth, app.config?.AUTH_MODE ?? "jwt",
    (tenantId, userId) => currentLocalSecurityVersion(app.db, tenantId, userId));
}

/**
 * A confirm of a suspended connection found no connection, found another
 * account than the one the owner saw (a reconnect happened meanwhile), or
 * found a connection with no identity that the provider attests. A confirm is
 * safe only when the page shows such an identity: otherwise the owner cannot
 * tell their own account from one that a stolen session connected.
 */
export class ConnectionConfirmError extends Error {
  constructor(readonly code: "not_connected" | "account_changed" | "not_attested", provider: string) {
    super(code === "not_connected"
      ? `${provider} is not connected.`
      : code === "not_attested"
        ? `${provider} did not confirm an email for this account. Connect again, or disconnect it.`
        : `The connected ${provider} account changed. Reload the page and check the account again.`);
    this.name = "ConnectionConfirmError";
  }
}

/** The HTTP status for a ConnectionConfirmError. */
export function connectionConfirmErrorStatus(error: ConnectionConfirmError): 404 | 409 {
  return error.code === "not_connected" ? 404 : 409;
}
