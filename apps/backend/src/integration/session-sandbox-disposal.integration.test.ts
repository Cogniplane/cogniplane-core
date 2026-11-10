// Archive, delete and purge of a normal chat take its saved sandbox, so that the
// caller can kill it. The store reads `sessions.sandbox_id` under the session row
// lock and clears it in the transaction that changes the status, and the status
// change stops the turn that holds the lease. Only real PostgreSQL shows that the
// record is cleared in that transaction, that a stopped lease cannot write it
// back, and that a record write that holds the lock first is the one taken.

import { describe, expect, test, vi } from "vitest";

import { ProjectStore } from "../services/project-store.js";
import { SessionExecutionStore } from "../services/session-execution-store.js";
import { SessionStore } from "../services/session-store.js";
import { adminDatabaseUrl, appPool, maintenancePool, superuserPool } from "./support/database.js";
import { seedMembership, seedSession, seedTenant, seedUser } from "./support/fixtures.js";

/** A normal chat whose turn saved a sandbox, as the runtime saves it. */
async function chatWithSandbox() {
  const tenantId = await seedTenant(), userId = await seedUser();
  await seedMembership(tenantId, userId);
  const sessionId = await seedSession(tenantId, userId);
  const actor = { tenantId, sessionId, userId };
  const executions = new SessionExecutionStore(appPool(), "replica-a");
  const execution = await executions.acquire(actor, 30_000);
  await executions.bindSandboxId(execution, null, "sandbox-one", "policy-a");
  return { ...actor, actor, executions, execution, sessions: new SessionStore(appPool(), maintenancePool()) };
}

async function record(tenantId: string, sessionId: string) {
  return (await superuserPool().query(
    "SELECT sandbox_id, sandbox_network_policy FROM sessions WHERE tenant_id=$1 AND session_id=$2",
    [tenantId, sessionId])).rows[0];
}
const saved = (sandboxId: string, hash: string) => ({ sandbox_id: sandboxId, sandbox_network_policy: { sandboxId, hash } });
const cleared = { sandbox_id: null, sandbox_network_policy: null };

describe.skipIf(!adminDatabaseUrl())("sandbox of a disposed session", () => {
  test("archive takes the saved sandbox once, and the stopped turn cannot write a record back", async () => {
    const c = await chatWithSandbox();
    const foreignTenant = await seedTenant(), foreignUser = await seedUser();
    expect(await c.sessions.setArchived(foreignTenant, c.sessionId, c.userId, true)).toBeNull();
    expect(await c.sessions.setArchived(c.tenantId, c.sessionId, foreignUser, true)).toBeNull();
    expect(await record(c.tenantId, c.sessionId)).toEqual(saved("sandbox-one", "policy-a"));

    const archived = await c.sessions.setArchived(c.tenantId, c.sessionId, c.userId, true);
    expect(archived).toMatchObject({ session: { sessionId: c.sessionId, status: "archived" }, releasedSandboxId: "sandbox-one" });
    expect(await record(c.tenantId, c.sessionId)).toEqual(cleared);

    // The same transaction stopped the execution. Its runtime can neither save a new
    // sandbox, nor release the old one, nor load a record.
    expect(await c.executions.isCurrent(c.execution)).toBe(false);
    await expect(c.executions.bindSandboxId(c.execution, null, "sandbox-late", "policy-a"))
      .rejects.toMatchObject({ code: "execution_stopped" });
    await expect(c.executions.releaseSandboxId(c.execution, "sandbox-one"))
      .rejects.toMatchObject({ code: "execution_stopped" });
    await expect(c.executions.sandboxBinding(c.execution)).rejects.toMatchObject({ code: "execution_stopped" });
    expect(await record(c.tenantId, c.sessionId)).toEqual(cleared);

    // A retry takes nothing, so the sandbox is killed once.
    expect(await c.sessions.setArchived(c.tenantId, c.sessionId, c.userId, true))
      .toMatchObject({ session: { status: "archived" }, releasedSandboxId: null });
    // Restore gives nothing back: the next turn finds no sandbox to adopt.
    expect(await c.sessions.setArchived(c.tenantId, c.sessionId, c.userId, false))
      .toMatchObject({ session: { status: "active" }, releasedSandboxId: null });
    const next = await c.executions.acquire(c.actor, 30_000);
    expect(await c.executions.sandboxBinding(next)).toBeNull();
  });

  test("delete takes the saved sandbox once, and an archived chat already gave it up", async () => {
    const c = await chatWithSandbox();
    const foreignTenant = await seedTenant(), foreignUser = await seedUser();
    expect(await c.sessions.remove(foreignTenant, c.sessionId, c.userId)).toBeNull();
    expect(await c.sessions.remove(c.tenantId, c.sessionId, foreignUser)).toBeNull();
    expect(await record(c.tenantId, c.sessionId)).toEqual(saved("sandbox-one", "policy-a"));

    expect(await c.sessions.remove(c.tenantId, c.sessionId, c.userId)).toEqual({ releasedSandboxId: "sandbox-one" });
    expect(await record(c.tenantId, c.sessionId)).toEqual(cleared);
    expect(await c.executions.isCurrent(c.execution)).toBe(false);
    await expect(c.executions.bindSandboxId(c.execution, null, "sandbox-late", "policy-a"))
      .rejects.toMatchObject({ code: "execution_stopped" });
    expect(await c.sessions.remove(c.tenantId, c.sessionId, c.userId)).toBeNull();
    expect(await c.sessions.restoreDeleted(c.tenantId, c.sessionId, c.userId)).toMatchObject({ status: "active" });
    expect(await record(c.tenantId, c.sessionId)).toEqual(cleared);

    const archivedFirst = await chatWithSandbox();
    expect((await archivedFirst.sessions.setArchived(archivedFirst.tenantId, archivedFirst.sessionId, archivedFirst.userId, true))
      ?.releasedSandboxId).toBe("sandbox-one");
    expect(await archivedFirst.sessions.remove(archivedFirst.tenantId, archivedFirst.sessionId, archivedFirst.userId))
      .toEqual({ releasedSandboxId: null });
  });

  test("the sandbox that replaced the first one is the one taken", async () => {
    const replaced = await chatWithSandbox();
    // The first sandbox expired at the provider, and the runtime saved its replacement.
    await replaced.executions.bindSandboxId(replaced.execution, "sandbox-one", "sandbox-two", "policy-b");
    expect(await replaced.sessions.remove(replaced.tenantId, replaced.sessionId, replaced.userId))
      .toEqual({ releasedSandboxId: "sandbox-two" });

    // The first sandbox did not match the policy: the runtime released it, killed it, and saved a new one.
    const retired = await chatWithSandbox();
    await retired.executions.releaseSandboxId(retired.execution, "sandbox-one");
    await retired.executions.bindSandboxId(retired.execution, null, "sandbox-two", "policy-b");
    expect(await retired.sessions.setArchived(retired.tenantId, retired.sessionId, retired.userId, true))
      .toMatchObject({ releasedSandboxId: "sandbox-two" });
  });

  test("a record write that holds the session row lock when the delete starts is the one taken", async () => {
    const c = await chatWithSandbox();
    const writer = await superuserPool().connect();
    let disposal: ReturnType<SessionStore["remove"]> | undefined;
    try {
      // As bindSandboxId writes: the session row lock first, then the new record.
      await writer.query("BEGIN");
      await writer.query("SELECT session_id FROM sessions WHERE tenant_id=$1 AND session_id=$2 FOR UPDATE",
        [c.tenantId, c.sessionId]);
      const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      disposal = c.sessions.remove(c.tenantId, c.sessionId, c.userId);
      await vi.waitFor(async () => {
        const blocked = await superuserPool().query(
          "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [pid]);
        expect(blocked.rows[0].count).toBeGreaterThan(0);
      });
      await writer.query(`UPDATE sessions SET sandbox_id='sandbox-two',
        sandbox_network_policy='{"sandboxId":"sandbox-two","hash":"policy-b"}'::jsonb
        WHERE tenant_id=$1 AND session_id=$2`, [c.tenantId, c.sessionId]);
      await writer.query("COMMIT");

      expect(await disposal).toEqual({ releasedSandboxId: "sandbox-two" });
      expect(await record(c.tenantId, c.sessionId)).toEqual(cleared);
    } finally {
      await writer.query("ROLLBACK").catch(() => undefined);
      writer.release();
      await disposal?.catch(() => undefined);
    }
  });

  test("a project chat saves no sandbox, so its archive and delete take none", async () => {
    const tenantId = await seedTenant(), userId = await seedUser();
    await seedMembership(tenantId, userId);
    const projects = new ProjectStore(appPool());
    const project = await projects.create(tenantId, userId, "Shared work");
    const sessionId = (await projects.createSession(tenantId, userId, project.projectId, "Shared chat"))!;
    const executions = new SessionExecutionStore(appPool(), "replica-a");
    const execution = await executions.acquire({ tenantId, sessionId, userId }, 30_000);
    // The runtime of a project turn has no record to write.
    await expect(executions.bindSandboxId(execution, null, "sandbox-project", "policy-a"))
      .rejects.toMatchObject({ code: "execution_stopped" });
    await executions.release(execution);
    const sessions = new SessionStore(appPool(), maintenancePool());

    expect(await sessions.setArchived(tenantId, sessionId, userId, true))
      .toMatchObject({ session: { status: "archived", projectId: project.projectId }, releasedSandboxId: null });
    expect(await sessions.setArchived(tenantId, sessionId, userId, false)).toMatchObject({ releasedSandboxId: null });
    expect(await sessions.remove(tenantId, sessionId, userId)).toEqual({ releasedSandboxId: null });
  });

  test("a chat that moved into a project gives up the sandbox of its normal chat, which no project turn loads", async () => {
    const c = await chatWithSandbox();
    await c.executions.release(c.execution);
    const projects = new ProjectStore(appPool());
    const project = await projects.create(c.tenantId, c.userId, "Moved");
    expect(await projects.setSession(c.tenantId, c.userId, project.projectId, c.sessionId)).toBe(true);
    const projectTurn = await c.executions.acquire(c.actor, 30_000);
    await expect(c.executions.sandboxBinding(projectTurn)).rejects.toMatchObject({ code: "execution_stopped" });
    await c.executions.release(projectTurn);

    expect(await c.sessions.remove(c.tenantId, c.sessionId, c.userId)).toEqual({ releasedSandboxId: "sandbox-one" });
    expect(await record(c.tenantId, c.sessionId)).toEqual(cleared);
  });

  test("purge takes a sandbox that a trashed row still names, after the row is gone", async () => {
    const tenantId = await seedTenant(), userId = await seedUser();
    const legacy = await seedSession(tenantId, userId);
    const withoutSandbox = await seedSession(tenantId, userId);
    const recent = await seedSession(tenantId, userId);
    // A version before this change trashed a chat and kept its record.
    const trash = async (sessionId: string, age: string, sandboxId: string | null) => superuserPool().query(
      `UPDATE sessions SET status='deleted', deleted_at=NOW() - $2::interval, sandbox_id=$3,
         sandbox_network_policy=CASE WHEN $3::text IS NULL THEN NULL ELSE jsonb_build_object('sandboxId', $3::text, 'hash', 'policy-a') END
       WHERE tenant_id=$1 AND session_id=$4`, [tenantId, age, sandboxId, sessionId]);
    await trash(legacy, "400 days", "sandbox-legacy");
    await trash(withoutSandbox, "400 days", null);
    await trash(recent, "0 days", "sandbox-recent");

    const rowGoneAtKill: boolean[] = [];
    const destroySandbox = vi.fn(async (input: { tenantId: string; sessionId: string; sandboxId: string }) => {
      if (input.tenantId !== tenantId) return;
      const row = await superuserPool().query("SELECT 1 FROM sessions WHERE session_id=$1", [input.sessionId]);
      rowGoneAtKill.push(row.rowCount === 0);
    });
    const store = new SessionStore(appPool(), maintenancePool());
    await store.cleanupExpired({ delete: async () => undefined }, { destroySandbox });

    expect(destroySandbox.mock.calls.filter(([input]) => input.tenantId === tenantId))
      .toEqual([[{ tenantId, sessionId: legacy, sandboxId: "sandbox-legacy" }]]);
    expect(rowGoneAtKill).toEqual([true]);
    // The retention of the recent row has not passed: it keeps its record for a restore.
    expect(await record(tenantId, recent)).toEqual(saved("sandbox-recent", "policy-a"));
    expect((await superuserPool().query("SELECT 1 FROM sessions WHERE session_id = ANY($1)", [[legacy, withoutSandbox]])).rowCount).toBe(0);
  });
});
