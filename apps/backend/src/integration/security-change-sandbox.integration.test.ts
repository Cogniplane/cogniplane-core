// A security change of an account takes the sandboxes that the account's chats saved, in
// the transaction that changes the security version, and the handler kills them after
// the commit (services/auth/security-change.ts). The same transaction stops the lease of
// each normal chat of the account. Only real PostgreSQL shows that an older turn cannot
// write a record back after the commit, that a record write that holds the row lock
// first is the one taken, that the kill uses only the ids that the transaction took, and
// that the membership routes take their locks in an order that does not deadlock with a
// turn admission. The provider is a spy: the kill itself is tested in
// services/runtime/e2b-sandbox-disposal.test.ts.

import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { PoolClient } from "pg";
import { describe, expect, onTestFinished, test, vi } from "vitest";

import { PasswordHasher } from "../lib/password-hash.js";
import { registerTenantRoutes } from "../routes/tenant.js";
import type { RuntimeAdapter } from "../runtime-contracts.js";
import { bootstrapLocalTenant } from "../scripts/local-auth-commands-lib.js";
import { LocalAccountService, type RequestMeta } from "../services/auth/local-account-service.js";
import type { LocalAuth } from "../services/auth/local-auth.js";
import { type AfterSecurityChange, stopActiveWork } from "../services/auth/security-change.js";
import { ProjectStore } from "../services/project-store.js";
import type { ReleasedSandbox, SandboxDisposalOutcome } from "../services/runtime/e2b-sandbox-disposal.js";
import { SessionExecutionStore, type SessionExecution } from "../services/session-execution-store.js";
import { TenantOrgSettingsStore } from "../services/tenant-org-settings-store.js";
import { devDataRoutes } from "../test-helpers/data-routes.js";
import { adminDatabaseUrl, appPool, maintenancePool, superuserPool } from "./support/database.js";
import { seedSession } from "./support/fixtures.js";

const META: RequestMeta = { ipAddress: null, userAgent: "integration" };
const SECRET = "security-change-sandbox-secret-at-least-32-chars";
const PASSWORD = "purple elephants dance quietly";
const ORIGIN = "https://app.example.test";
const tokenOf = (url: string) => url.split("#token=")[1]!;

type Fixture = { tenantId: string; ownerId: string; memberId: string };

/** A local tenant with an active owner and an active member, both without a second factor. */
async function fixture(): Promise<Fixture> {
  const accounts = accountService(async () => {});
  const boot = await bootstrapLocalTenant(superuserPool(), ORIGIN, {
    tenantName: "Sandbox security", ownerEmail: `${randomUUID()}@example.test`, ownerName: null
  });
  await accounts.redeemLink("account_setup", tokenOf(boot.link.url), PASSWORD, META);
  const member = await accounts.createMember({
    tenantId: boot.tenantId, email: `${randomUUID()}@example.test`, displayName: null, role: "member", actorUserId: boot.userId, meta: META
  });
  await accounts.redeemLink("account_setup", tokenOf(member.link!.url), PASSWORD, META);
  return { tenantId: boot.tenantId, ownerId: boot.userId, memberId: member.userId };
}

function accountService(afterSecurityChange: AfterSecurityChange) {
  return new LocalAccountService({
    db: appPool(), lookupDb: maintenancePool(), hasher: new PasswordHasher(4), frontendOrigin: ORIGIN, afterSecurityChange
  });
}

/**
 * The server handler with no runtime of the account in this process: the turns of the
 * account run on another replica. The provider is a spy.
 */
function serverHandler(destroy: (input: ReleasedSandbox) => Promise<SandboxDisposalOutcome> = async () => "killed") {
  const destroySandbox = vi.fn(destroy);
  const runtimes: Pick<RuntimeAdapter, "invalidateRuntimesForUser" | "destroySandbox"> = {
    invalidateRuntimesForUser: vi.fn(async () => []),
    destroySandbox
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { after: stopActiveWork({ runtimes, logger }), destroySandbox, logger };
}

const executions = () => new SessionExecutionStore(appPool(), "replica-b");

/** A normal chat whose turn saved a sandbox, as the runtime saves it. The turn still runs unless `finished`. */
async function chatWithSandbox(tenantId: string, userId: string, sandboxId: string | null, options: { finished?: boolean } = {}) {
  const sessionId = await seedSession(tenantId, userId);
  const store = executions();
  const execution = await store.acquire({ tenantId, sessionId, userId }, 30_000);
  if (sandboxId) await store.bindSandboxId(execution, null, sandboxId, "policy-a");
  if (options.finished) await store.release(execution);
  return { tenantId, sessionId, userId, execution };
}

async function record(tenantId: string, sessionId: string) {
  return (await superuserPool().query(
    "SELECT sandbox_id, sandbox_network_policy FROM sessions WHERE tenant_id=$1 AND session_id=$2",
    [tenantId, sessionId])).rows[0];
}
const saved = (sandboxId: string) => ({ sandbox_id: sandboxId, sandbox_network_policy: { sandboxId, hash: "policy-a" } });
const cleared = { sandbox_id: null, sandbox_network_policy: null };

async function stopReason(execution: SessionExecution) {
  return (await superuserPool().query(
    "SELECT status, stop_reason FROM session_executions WHERE execution_id=$1", [execution.executionId])).rows[0];
}

const byId = (a: ReleasedSandbox, b: ReleasedSandbox) => a.sandboxId.localeCompare(b.sandboxId);
const killed = (spy: ReturnType<typeof serverHandler>["destroySandbox"]) => spy.mock.calls.map(([input]) => input).sort(byId);

async function versionOf(userId: string): Promise<number> {
  return (await superuserPool().query(`SELECT security_version FROM local_identities WHERE user_id = $1`, [userId])).rows[0].security_version;
}

/** Waits until a backend waits for a lock that the backend `pid` holds, and returns its pid. */
async function blockedBy(pid: number): Promise<number> {
  let blocked = 0;
  await vi.waitFor(async () => {
    const result = await superuserPool().query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [pid]);
    expect(result.rows).toHaveLength(1);
    blocked = result.rows[0]!.pid;
  });
  return blocked;
}

async function openTransaction(): Promise<{ client: PoolClient; pid: number }> {
  const client = await superuserPool().connect();
  await client.query("BEGIN");
  const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
  return { client, pid };
}

/** The tenant routes, called by the owner's local session, with a step-up that passes. */
async function tenantRoutes(t: Fixture, afterSecurityChange: AfterSecurityChange) {
  const app = Fastify();
  const ownerVersion = await versionOf(t.ownerId);
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: t.ownerId, tenantId: t.tenantId, role: "owner", isAdmin: true,
      session: { authSource: "local", familyId: "family-1", securityVersion: ownerVersion }
    };
  });
  const stepUp = {
    stepUp: { consume: async () => ["pwd"] },
    refreshTokens: { isActive: async () => true },
    mfa: { hasSecondFactor: async () => false }
  } as unknown as LocalAuth;
  await registerTenantRoutes(app, {
    db: appPool(), tenantOrgSettings: new TenantOrgSettingsStore(appPool(), SECRET), afterSecurityChange, localAuth: stepUp,
    dataRoutes: devDataRoutes()
  });
  await app.ready();
  onTestFinished(() => app.close());
  return app;
}

/** The two membership routes that change a security version. The role change promotes a member with no second factor under an MFA rule for admins. */
const MEMBERSHIP_ROUTES = {
  "DELETE /tenant/members/:userId": async (t: Fixture) => ({ method: "DELETE" as const, url: `/tenant/members/${t.memberId}` }),
  "PUT /tenant/members/:userId/role": async (t: Fixture) => {
    await superuserPool().query(`UPDATE tenants SET mfa_policy = 'required_for_admins' WHERE tenant_id = $1`, [t.tenantId]);
    return { method: "PUT" as const, url: `/tenant/members/${t.memberId}/role`, payload: { role: "admin" } };
  }
};

describe.skipIf(!adminDatabaseUrl())("a security change kills the sandboxes of the account's chats", () => {
  test("a manager disable takes the member's saved sandboxes, stops their leases, and kills them with no runtime in this process", async () => {
    const t = await fixture();
    const other = await fixture();
    const running = await chatWithSandbox(t.tenantId, t.memberId, "sandbox-running");
    const idle = await chatWithSandbox(t.tenantId, t.memberId, "sandbox-idle", { finished: true });
    const ownerChat = await chatWithSandbox(t.tenantId, t.ownerId, "sandbox-owner");
    const otherTenant = await chatWithSandbox(other.tenantId, other.memberId, "sandbox-other-tenant");
    const handler = serverHandler();

    await accountService(handler.after).disableMember(t.tenantId, t.memberId, t.ownerId, META);

    await vi.waitFor(() => expect(handler.destroySandbox).toHaveBeenCalledTimes(2));
    expect(killed(handler.destroySandbox)).toEqual([
      { tenantId: t.tenantId, sessionId: idle.sessionId, sandboxId: "sandbox-idle" },
      { tenantId: t.tenantId, sessionId: running.sessionId, sandboxId: "sandbox-running" }
    ]);
    expect(await record(t.tenantId, running.sessionId)).toEqual(cleared);
    expect(await record(t.tenantId, idle.sessionId)).toEqual(cleared);
    // Another member and another tenant keep their sandboxes and their turns.
    expect(await record(t.tenantId, ownerChat.sessionId)).toEqual(saved("sandbox-owner"));
    expect(await record(other.tenantId, otherTenant.sessionId)).toEqual(saved("sandbox-other-tenant"));
    expect(await executions().isCurrent(ownerChat.execution)).toBe(true);
    expect(await executions().isCurrent(otherTenant.execution)).toBe(true);

    // The older turn, on any replica, can neither load the old record nor save a new one.
    const store = executions();
    expect(await stopReason(running.execution)).toEqual({ status: "stopped", stop_reason: "security_change" });
    expect(await store.isCurrent(running.execution)).toBe(false);
    // So the turn reports the security change, on the replica that runs it.
    expect(await store.stoppedBySecurityChange(running.execution)).toBe(true);
    expect(await store.stoppedBySecurityChange(ownerChat.execution)).toBe(false);
    await expect(store.sandboxBinding(running.execution)).rejects.toMatchObject({ code: "execution_stopped" });
    await expect(store.bindSandboxId(running.execution, null, "sandbox-late", "policy-a"))
      .rejects.toMatchObject({ code: "execution_stopped" });
    await expect(store.bindSandboxId(running.execution, "sandbox-running", "sandbox-late", "policy-a"))
      .rejects.toMatchObject({ code: "execution_stopped" });
    await expect(store.releaseSandboxId(running.execution, "sandbox-running"))
      .rejects.toMatchObject({ code: "execution_stopped" });
    expect(await record(t.tenantId, running.sessionId)).toEqual(cleared);
  });

  test("a kill that fails does not undo the change, and the error names the sandbox", async () => {
    const t = await fixture();
    const chat = await chatWithSandbox(t.tenantId, t.memberId, "sandbox-one", { finished: true });
    const handler = serverHandler(async () => { throw new Error("provider unreachable"); });
    const before = await versionOf(t.memberId);

    // A password change returns the identity of the new session.
    const identity = await accountService(handler.after)
      .changeOwnPassword(t.tenantId, t.memberId, PASSWORD, "a different long passphrase", before, META);

    expect(identity.securityVersion).toBe(before + 1);
    expect(await versionOf(t.memberId)).toBe(before + 1);
    expect(await record(t.tenantId, chat.sessionId)).toEqual(cleared);
    await vi.waitFor(() => expect(handler.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: t.tenantId, userId: t.memberId, sessionId: chat.sessionId, sandboxId: "sandbox-one" }),
      expect.stringContaining("runs until the provider expires it")
    ));
  });

  test("a record write that holds the session row lock when the change starts is the one taken", async () => {
    const t = await fixture();
    const chat = await chatWithSandbox(t.tenantId, t.memberId, "sandbox-one");
    const handler = serverHandler();
    const writer = await openTransaction();
    let change: Promise<unknown> | undefined;
    try {
      // As bindSandboxId writes: the session row lock first, then the new record.
      await writer.client.query("SELECT session_id FROM sessions WHERE tenant_id=$1 AND session_id=$2 FOR UPDATE",
        [t.tenantId, chat.sessionId]);
      change = accountService(handler.after).revokeSessions(t.tenantId, t.memberId, t.memberId, META);
      await blockedBy(writer.pid);
      await writer.client.query(`UPDATE sessions SET sandbox_id='sandbox-two',
        sandbox_network_policy='{"sandboxId":"sandbox-two","hash":"policy-a"}'::jsonb
        WHERE tenant_id=$1 AND session_id=$2`, [t.tenantId, chat.sessionId]);
      await writer.client.query("COMMIT");
      await change;
    } finally {
      await writer.client.query("ROLLBACK").catch(() => undefined);
      writer.client.release();
      await change?.catch(() => undefined);
    }

    await vi.waitFor(() => expect(handler.destroySandbox).toHaveBeenCalledTimes(1));
    expect(killed(handler.destroySandbox)).toEqual([{ tenantId: t.tenantId, sessionId: chat.sessionId, sandboxId: "sandbox-two" }]);
    expect(await record(t.tenantId, chat.sessionId)).toEqual(cleared);
  });

  test("an older turn that saves its first sandbox while the change runs cannot save it after the commit", async () => {
    const t = await fixture();
    // The turn runs and has no sandbox yet: it saves its first one with no previous id.
    const chat = await chatWithSandbox(t.tenantId, t.memberId, null);
    const handler = serverHandler();
    const app = await tenantRoutes(t, handler.after);
    // Holds the route after it locked the member's chats, before it locks the membership.
    const holder = await openTransaction();
    let route: Promise<{ statusCode: number; body: string }> | undefined;
    let save: Promise<void> | undefined;
    try {
      await holder.client.query("SELECT 1 FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2 FOR SHARE",
        [t.tenantId, t.memberId]);
      route = app.inject(await MEMBERSHIP_ROUTES["PUT /tenant/members/:userId/role"](t));
      const routePid = await blockedBy(holder.pid);
      save = executions().bindSandboxId(chat.execution, null, "sandbox-late", "policy-a");
      // The save waits for the session row lock of the security change.
      await blockedBy(routePid);
      await holder.client.query("COMMIT");
      const response = await route;
      expect(response.statusCode, response.body).toBe(200);
      await expect(save).rejects.toMatchObject({ code: "execution_stopped" });
    } finally {
      await holder.client.query("ROLLBACK").catch(() => undefined);
      holder.client.release();
      await route?.catch(() => undefined);
      await save?.catch(() => undefined);
    }
    expect(await record(t.tenantId, chat.sessionId)).toEqual(cleared);
    expect(await stopReason(chat.execution)).toEqual({ status: "stopped", stop_reason: "security_change" });
    expect(handler.destroySandbox).not.toHaveBeenCalled();
  });

  test("the kill uses only the ids that the transaction took: a turn that starts after the commit keeps its new sandbox", async () => {
    const t = await fixture();
    const chat = await chatWithSandbox(t.tenantId, t.memberId, "sandbox-old", { finished: true });
    const store = executions();
    let next: SessionExecution | undefined;
    // The kill is slow. Meanwhile the member signs in again, starts a turn in the same
    // chat, and the turn saves a new sandbox.
    const handler = serverHandler(async () => {
      next = await store.acquire({ tenantId: t.tenantId, sessionId: chat.sessionId, userId: t.memberId }, 30_000);
      expect(await store.sandboxBinding(next)).toBeNull();
      await store.bindSandboxId(next, null, "sandbox-new", "policy-a");
      return "killed";
    });

    await accountService(handler.after).resetMemberPassword(t.tenantId, t.memberId, t.ownerId, META);

    await vi.waitFor(() => expect(next).toBeDefined());
    await vi.waitFor(async () => expect(await record(t.tenantId, chat.sessionId)).toEqual(saved("sandbox-new")));
    expect(killed(handler.destroySandbox)).toEqual([{ tenantId: t.tenantId, sessionId: chat.sessionId, sandboxId: "sandbox-old" }]);
    expect(await store.isCurrent(next!)).toBe(true);
  });

  test("a change that took no sandbox kills nothing and logs no kill", async () => {
    const t = await fixture();
    await chatWithSandbox(t.tenantId, t.memberId, null, { finished: true });
    const handler = serverHandler();

    await accountService(handler.after).revokeSessions(t.tenantId, t.memberId, t.memberId, META);

    await new Promise((resolve) => setImmediate(resolve));
    expect(handler.destroySandbox).not.toHaveBeenCalled();
    const logged = [...handler.logger.info.mock.calls, ...handler.logger.warn.mock.calls, ...handler.logger.error.mock.calls];
    expect(logged.filter(([fields]) => JSON.stringify(fields).includes("sandbox"))).toEqual([]);
  });

  test("project chats: a project turn keeps going, and only the member's own sandbox of a chat that moved into a project is taken", async () => {
    const t = await fixture();
    const projects = new ProjectStore(appPool());
    // The member's normal chat saved a sandbox, then moved into the member's project.
    const moved = await chatWithSandbox(t.tenantId, t.memberId, "sandbox-moved", { finished: true });
    const memberProject = await projects.create(t.tenantId, t.memberId, "Member work");
    expect(await projects.setSession(t.tenantId, t.memberId, memberProject.projectId, moved.sessionId)).toBe(true);
    // The owner's project chat, with a turn of the owner in it. A project turn saves no sandbox.
    const ownerProject = await projects.create(t.tenantId, t.ownerId, "Owner work");
    const projectChat = (await projects.createSession(t.tenantId, t.ownerId, ownerProject.projectId, "Shared chat"))!;
    const projectTurn = await executions().acquire({ tenantId: t.tenantId, sessionId: projectChat, userId: t.ownerId }, 30_000);
    const handler = serverHandler();

    await accountService(handler.after).disableMember(t.tenantId, t.memberId, t.ownerId, META);

    await vi.waitFor(() => expect(handler.destroySandbox).toHaveBeenCalledTimes(1));
    expect(killed(handler.destroySandbox)).toEqual([{ tenantId: t.tenantId, sessionId: moved.sessionId, sandboxId: "sandbox-moved" }]);
    expect(await record(t.tenantId, moved.sessionId)).toEqual(cleared);
    expect(await executions().isCurrent(projectTurn)).toBe(true);
  });

  test.each(Object.keys(MEMBERSHIP_ROUTES) as Array<keyof typeof MEMBERSHIP_ROUTES>)(
    "%s locks the member's chats before the membership, so a turn admission of the member does not deadlock with it",
    async (site) => {
      const t = await fixture();
      const chat = await chatWithSandbox(t.tenantId, t.memberId, "sandbox-one", { finished: true });
      const handler = serverHandler();
      const app = await tenantRoutes(t, handler.after);
      // As SessionExecutionStore.acquire locks: the session row, then the membership of the user.
      const admission = await openTransaction();
      let route: Promise<{ statusCode: number; body: string }> | undefined;
      try {
        await admission.client.query("SELECT project_id FROM sessions WHERE tenant_id=$1 AND session_id=$2 FOR UPDATE",
          [t.tenantId, chat.sessionId]);
        route = app.inject(await MEMBERSHIP_ROUTES[site](t));
        await blockedBy(admission.pid);
        // A deadlock would fail this statement or the route after deadlock_timeout.
        await admission.client.query("SELECT user_id FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2 FOR SHARE",
          [t.tenantId, t.memberId]);
        await admission.client.query("COMMIT");
        const response = await route;
        expect(response.statusCode, response.body).toBe(200);
      } finally {
        await admission.client.query("ROLLBACK").catch(() => undefined);
        admission.client.release();
        await route?.catch(() => undefined);
      }
      await vi.waitFor(() => expect(handler.destroySandbox).toHaveBeenCalledTimes(1));
      expect(killed(handler.destroySandbox)).toEqual([{ tenantId: t.tenantId, sessionId: chat.sessionId, sandboxId: "sandbox-one" }]);
      expect(await record(t.tenantId, chat.sessionId)).toEqual(cleared);
    }
  );
});
