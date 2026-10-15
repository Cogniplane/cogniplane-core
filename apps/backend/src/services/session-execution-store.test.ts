import { describe, expect, test } from "vitest";

import { FakePool } from "../test-helpers/fake-pool.js";
import { ProjectAccessError } from "./project-access.js";
import { SessionExecutionError, SessionExecutionStore, type SessionExecution } from "./session-execution-store.js";

// Unit tests for turn admission and execution fencing decisions. The fake
// answers each statement from the values it binds; the access predicates,
// RLS and lock behavior are proven against Postgres in
// src/integration/session-executions.integration.test.ts.

type World = {
  // Project assignment seen by the first, unlocked read and by the locked read.
  session: { projectId: string | null; projectIdAfterLock?: string | null; deletedAfterFirstRead?: boolean } | null;
  projectRoles?: Record<string, "owner" | "editor" | "viewer">;
  projectArchived?: boolean;
  members: string[];
  canRun: string[];
  busy?: boolean;
  activeCounts?: { tenant: number; user: number };
};

const actor = { tenantId: "tenant-a", sessionId: "session-1", userId: "user-1" };
const none = { rows: [], rowCount: 0 };
const one = (row: Record<string, unknown>) => ({ rows: [row], rowCount: 1 });

function admissionPool(world: World) {
  const pool = new FakePool();
  return pool
    .onQuery(/FROM sessions WHERE tenant_id=\$1 AND session_id=\$2 FOR UPDATE/, () => {
      if (!world.session || world.session.deletedAfterFirstRead) return none;
      const projectId = "projectIdAfterLock" in world.session ? world.session.projectIdAfterLock : world.session.projectId;
      return one({ project_id: projectId });
    })
    .onQuery("SELECT project_id FROM sessions WHERE tenant_id=$1 AND session_id=$2", (_sql, [tenantId, sessionId]) =>
      world.session && tenantId === actor.tenantId && sessionId === actor.sessionId
        ? one({ project_id: world.session.projectId })
        : none)
    .onQuery("SELECT project_id FROM projects WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE", () => none)
    .onQuery("SELECT p.archived_at, p.visibility", (_sql, [, , userId]) => one({
      archived_at: world.projectArchived ? "2026-10-01T00:00:00.000Z" : null,
      visibility: "private",
      organization_role: "viewer",
      role: world.projectRoles?.[String(userId)] ?? null
    }))
    .onQuery("SELECT user_id FROM tenant_memberships", (_sql, [, userId]) =>
      world.members.includes(String(userId)) ? one({ user_id: userId }) : none)
    .onQuery("SELECT session_id FROM sessions s", (_sql, [, , userId]) =>
      world.canRun.includes(String(userId)) ? one({ session_id: actor.sessionId }) : none)
    .onQuery("AS tenant_count", () => one({
      tenant_count: world.activeCounts?.tenant ?? 0,
      user_count: world.activeCounts?.user ?? 0
    }))
    .onQuery("SELECT execution_id FROM session_executions", () => (world.busy ? one({ execution_id: "running" }) : none))
    .onQuery("WITH expired AS", () => one({ count: 0 }))
    .onQuery("INSERT INTO session_executions", () => one({ expires_at: "2026-10-01T12:00:30.000Z" }));
}

function insertValues(pool: FakePool): unknown[][] {
  return pool.queries.filter(query => query.text.includes("INSERT INTO session_executions")).map(query => query.values);
}

function expectRefusedWithoutWrite(pool: FakePool) {
  expect(insertValues(pool)).toEqual([]);
  expect(pool.queries.some(query => query.text.includes("WITH expired AS"))).toBe(false);
  const control = pool.queries.map(query => query.text.trim());
  expect(control).toContain("ROLLBACK");
  expect(control).not.toContain("COMMIT");
}

async function refusal(world: World, caps?: { perUser: number; perTenant: number }) {
  const pool = admissionPool(world);
  const error = await new SessionExecutionStore(pool.asPool(), "owner-a")
    .acquire(actor, 30_000, caps)
    .catch((caught: unknown) => caught);
  expectRefusedWithoutWrite(pool);
  return error;
}

const standalone = (overrides: Partial<World> = {}): World => ({
  session: { projectId: null },
  members: ["user-1"],
  canRun: ["user-1"],
  ...overrides
});

describe("SessionExecutionStore.acquire", () => {
  test("admits a standalone turn and writes the execution for the caller, owner and tenant", async () => {
    const pool = admissionPool(standalone());
    const store = new SessionExecutionStore(pool.asPool(), "owner-a");

    const execution = await store.acquire(actor, 30_000);

    expect(execution).toEqual({
      ...actor,
      executionId: expect.any(String),
      projectId: null,
      ownerId: "owner-a",
      expiresAt: "2026-10-01T12:00:30.000Z"
    });
    expect(insertValues(pool)).toEqual([
      ["tenant-a", "session-1", execution.executionId, "user-1", null, 30_000, "owner-a"]
    ]);
    expect(pool.queries.filter(query => query.text.includes("set_config")).map(query => query.values)).toEqual([["tenant-a"]]);
    // Without caps there is nothing to count, so admission takes no tenant-wide lock.
    expect(pool.queries.some(query => query.text.includes("pg_advisory_xact_lock"))).toBe(false);
    expect(pool.queries.at(-1)?.text).toBe("COMMIT");
  });

  test("admits an editor's turn in a project session and records the project", async () => {
    const pool = admissionPool({
      session: { projectId: "project-1" },
      projectRoles: { "user-1": "editor" },
      members: ["user-1"],
      canRun: ["user-1"]
    });

    const execution = await new SessionExecutionStore(pool.asPool(), "owner-a").acquire(actor, 30_000);

    expect(execution.projectId).toBe("project-1");
    expect(insertValues(pool)[0]?.[4]).toBe("project-1");
  });

  test("refuses an unknown session with 404", async () => {
    expect(await refusal(standalone({ session: null }))).toMatchObject({ code: "session_unavailable", statusCode: 404 });
  });

  test("refuses a project viewer before reading the session under lock", async () => {
    const error = await refusal({
      session: { projectId: "project-1" },
      projectRoles: { "user-1": "viewer" },
      members: ["user-1"],
      canRun: ["user-1"]
    });
    expect(error).toBeInstanceOf(ProjectAccessError);
    expect(error).toMatchObject({ code: "project_role_required", status: 403 });
  });

  test("refuses a turn in an archived project", async () => {
    const error = await refusal({
      session: { projectId: "project-1" },
      projectRoles: { "user-1": "owner" },
      projectArchived: true,
      members: ["user-1"],
      canRun: ["user-1"]
    });
    expect(error).toMatchObject({ code: "project_archived", status: 409 });
  });

  test.each([
    ["moved into a project", { projectId: null, projectIdAfterLock: "project-2" }],
    ["moved to another project", { projectId: "project-1", projectIdAfterLock: "project-2" }],
    ["deleted", { projectId: null, deletedAfterFirstRead: true }]
  ])("refuses with 409 when the session was %s between the first read and the lock", async (_label, session) => {
    const error = await refusal({
      session,
      projectRoles: { "user-1": "owner" },
      members: ["user-1"],
      canRun: ["user-1"]
    });
    expect(error).toBeInstanceOf(SessionExecutionError);
    expect(error).toMatchObject({ code: "session_unavailable", statusCode: 409 });
  });

  test("refuses a caller who has left the organization", async () => {
    expect(await refusal(standalone({ members: ["user-2"] }))).toMatchObject({ code: "session_unavailable", statusCode: 404 });
  });

  test("refuses a caller without run access to the session", async () => {
    expect(await refusal(standalone({ canRun: ["user-2"] }))).toMatchObject({ code: "session_unavailable", statusCode: 404 });
  });

  test("refuses a second turn while one is active", async () => {
    expect(await refusal(standalone({ busy: true }))).toMatchObject({ code: "session_busy", statusCode: 409 });
  });

  test.each([
    ["tenant", { tenant: 5, user: 0 }],
    ["user", { tenant: 1, user: 2 }]
  ])("refuses a turn when the %s cap is already reached", async (_label, activeCounts) => {
    const error = await refusal(standalone({ activeCounts }), { perUser: 2, perTenant: 5 });
    expect(error).toMatchObject({ code: "running_turn_limit", statusCode: 429 });
  });

  test("admits a turn one below both caps and serializes admission on the tenant lock", async () => {
    const pool = admissionPool(standalone({ activeCounts: { tenant: 4, user: 1 } }));

    await new SessionExecutionStore(pool.asPool(), "owner-a").acquire(actor, 30_000, { perUser: 2, perTenant: 5 });

    const lock = pool.queries.find(query => query.text.includes("pg_advisory_xact_lock"));
    expect(lock?.values).toEqual(["tenant-a"]);
    const firstRead = pool.queries.findIndex(query => query.text.startsWith("SELECT project_id FROM sessions"));
    expect(pool.queries.indexOf(lock!)).toBeLessThan(firstRead);
    expect(insertValues(pool)).toHaveLength(1);
  });
});

const execution: SessionExecution = {
  ...actor,
  executionId: "execution-1",
  projectId: null,
  ownerId: "owner-a",
  expiresAt: "2026-10-01T12:00:30.000Z"
};

// One live execution row; statements match it only through their bound values.
// The conditions of this fake (the owner, the lease, the sandbox that the write expects) are its own
// copy of the SQL, so a test that uses it cannot show that the SQL refuses what the fake refuses.
// The real statements run in integration/session-executions.integration.test.ts, in the test
// "the sandbox record is written only by the owner of a current lease, over the sandbox that it expects".
type LiveExecution = {
  executionId: string; userId: string; ownerId: string; runtimeId: string | null; sandboxId: string | null;
  /** The jsonb column: the policy hash and the sandbox it was created for. */
  networkPolicy?: { sandboxId: string; hash: string } | null;
};
function leasePool(live: LiveExecution) {
  const owns = (executionId: unknown, userId: unknown, ownerId?: unknown) =>
    executionId === live.executionId && userId === live.userId && (ownerId === undefined || ownerId === live.ownerId);
  return new FakePool()
    .onQuery("SELECT s.sandbox_id", (_sql, [, , executionId, ownerId, userId]) =>
      owns(executionId, userId, ownerId)
        ? one({ sandbox_id: live.sandboxId, sandbox_network_policy: live.networkPolicy ?? null }) : none)
    .onQuery("UPDATE sessions s SET sandbox_id", (_sql, [, , executionId, ownerId, userId, sandboxId, previousId, policy]) => {
      if (!owns(executionId, userId, ownerId) || previousId !== live.sandboxId) return none;
      live.sandboxId = String(sandboxId);
      live.networkPolicy = JSON.parse(String(policy));
      return one({ session_id: actor.sessionId });
    })
    .onQuery("SET runtime_id=$4", (_sql, [, executionId, userId, runtimeId]) => {
      if (!owns(executionId, userId) || (live.runtimeId !== null && live.runtimeId !== runtimeId)) return none;
      live.runtimeId = String(runtimeId);
      return one({ execution_id: executionId });
    })
    .onQuery("SET expires_at=clock_timestamp()", (_sql, [, , userId, executionId, , ownerId]) =>
      owns(executionId, userId, ownerId) ? one({ execution_id: executionId }) : none)
    .onQuery("SET status='finished'", (_sql, [, executionId, userId, ownerId]) =>
      owns(executionId, userId, ownerId) ? one({}) : none)
    .onQuery("SELECT e.execution_id FROM session_executions e", (_sql, [, , userId, executionId, runtimeId]) =>
      owns(executionId, userId) && (runtimeId === null || runtimeId === live.runtimeId) ? one({ execution_id: executionId }) : none);
}

describe("SessionExecutionStore fencing", () => {
  test("binds a runtime once and refuses a different runtime or a stale execution", async () => {
    const live = { executionId: "execution-1", userId: "user-1", ownerId: "owner-a", runtimeId: null, sandboxId: null };
    const store = new SessionExecutionStore(leasePool(live).asPool(), "owner-a");

    await store.bindRuntime(execution, "runtime-1");
    await store.bindRuntime(execution, "runtime-1");
    await expect(store.bindRuntime(execution, "runtime-2")).rejects.toMatchObject({ code: "execution_stopped", statusCode: 403 });
    await expect(store.bindRuntime({ ...execution, executionId: "execution-0" }, "runtime-1"))
      .rejects.toBeInstanceOf(SessionExecutionError);
    expect(live.runtimeId).toBe("runtime-1");
  });

  test("reads and replaces the sandbox only for the owning replica and the expected previous sandbox", async () => {
    const live = { executionId: "execution-1", userId: "user-1", ownerId: "owner-a", runtimeId: null, sandboxId: null };
    const store = new SessionExecutionStore(leasePool(live).asPool(), "owner-a");

    expect(await store.sandboxBinding(execution)).toBeNull();
    await store.bindSandboxId(execution, null, "sandbox-1", "hash-a");
    expect(await store.sandboxBinding(execution)).toEqual({ sandboxId: "sandbox-1", networkPolicyHash: "hash-a" });
    await expect(store.bindSandboxId(execution, null, "sandbox-2", "hash-a")).rejects.toMatchObject({ code: "execution_stopped" });
    await expect(store.sandboxBinding({ ...execution, ownerId: "owner-b" })).rejects.toMatchObject({ code: "execution_stopped" });
    expect(live.sandboxId).toBe("sandbox-1");
  });

  test("reads the policy hash as unknown when the record names another sandbox or is missing", async () => {
    // A replica from before the policy replaced the sandbox and left the old record.
    const stale: LiveExecution = {
      executionId: "execution-1", userId: "user-1", ownerId: "owner-a", runtimeId: null,
      sandboxId: "sandbox-2", networkPolicy: { sandboxId: "sandbox-1", hash: "hash-a" }
    };
    expect(await new SessionExecutionStore(leasePool(stale).asPool(), "owner-a").sandboxBinding(execution))
      .toEqual({ sandboxId: "sandbox-2", networkPolicyHash: null });
    // A sandbox saved before the column existed.
    const legacy: LiveExecution = {
      executionId: "execution-1", userId: "user-1", ownerId: "owner-a", runtimeId: null, sandboxId: "sandbox-3"
    };
    expect(await new SessionExecutionStore(leasePool(legacy).asPool(), "owner-a").sandboxBinding(execution))
      .toEqual({ sandboxId: "sandbox-3", networkPolicyHash: null });
    // A malformed record is not trusted either.
    const malformed = { ...legacy, networkPolicy: { sandboxId: "sandbox-3", hash: 7 } } as unknown as LiveExecution;
    expect(await new SessionExecutionStore(leasePool(malformed).asPool(), "owner-a").sandboxBinding(execution))
      .toEqual({ sandboxId: "sandbox-3", networkPolicyHash: null });
  });

  test("lets only the owning replica renew or release the lease", async () => {
    const live = { executionId: "execution-1", userId: "user-1", ownerId: "owner-a", runtimeId: "runtime-1", sandboxId: null };
    const pool = leasePool(live);
    const store = new SessionExecutionStore(pool.asPool(), "owner-a");
    const stale = { ...execution, ownerId: "owner-b" };

    expect(await store.heartbeat(execution, 30_000)).toBe(true);
    expect(await store.heartbeat(stale, 30_000)).toBe(false);
    expect(await store.isCurrent(execution)).toBe(true);
    expect(await store.isCurrent(execution, "runtime-1")).toBe(true);
    expect(await store.isCurrent(execution, "runtime-2")).toBe(false);
    await store.release(stale);
    await store.release(execution);
    const releases = pool.queries.filter(query => query.text.includes("SET status='finished'"));
    expect(releases.map(query => query.values[3])).toEqual(["owner-b", "owner-a"]);
  });
});

describe("SessionExecutionStore cancellation", () => {
  function cancelPool(stopped: Record<string, unknown> | null, auditError?: Error) {
    return new FakePool()
      .onQuery("SET status='stopped', stop_reason='cancelled'", () => (stopped ? one(stopped) : none))
      .onQuery("INSERT INTO audit_events", () => {
        if (auditError) throw auditError;
        return one({});
      });
  }

  test("writes a turn.interrupted audit event for the canceller in the same transaction", async () => {
    const pool = cancelPool({ execution_id: "execution-1", owner_id: "owner-b", user_id: "user-2", runtime_id: "runtime-9" });

    const owner = await new SessionExecutionStore(pool.asPool(), "owner-a").stopAndGetOwner(actor);

    expect(owner).toEqual({ executionId: "execution-1", ownerId: "owner-b" });
    const audit = pool.queries.find(query => query.text.includes("INSERT INTO audit_events"));
    expect(audit?.values.slice(0, 5)).toEqual(["tenant-a", "session-1", "user-1", null, "turn.interrupted"]);
    expect(JSON.parse(String(audit?.values[5]))).toEqual({
      executionId: "execution-1",
      initiatorUserId: "user-2",
      runtimeId: "runtime-9"
    });
    const texts = pool.queries.map(query => query.text.trim());
    expect(texts.indexOf("COMMIT")).toBeGreaterThan(pool.queries.indexOf(audit!));
  });

  test("returns false and writes no audit when no turn is active", async () => {
    const pool = cancelPool(null);

    expect(await new SessionExecutionStore(pool.asPool(), "owner-a").stop(actor)).toBe(false);
    expect(pool.queries.some(query => query.text.includes("INSERT INTO audit_events"))).toBe(false);
  });

  test("rolls back the stop when its audit event cannot be written", async () => {
    const failure = new Error("audit insert failed");
    const pool = cancelPool({ execution_id: "execution-1", owner_id: "owner-b", user_id: "user-1", runtime_id: null }, failure);

    await expect(new SessionExecutionStore(pool.asPool(), "owner-a").stop(actor)).rejects.toBe(failure);
    const texts = pool.queries.map(query => query.text.trim());
    expect(texts).toContain("ROLLBACK");
    expect(texts).not.toContain("COMMIT");
  });
});
