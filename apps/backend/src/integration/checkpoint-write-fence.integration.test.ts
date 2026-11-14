// Checkpoint writes are fenced by the session lease (deep-agents-checkpointer.ts,
// lockExecutionForCheckpointWrite). Each store is a separate replica on one
// database. The saver is the production one, as app_user.
//
// The concurrent cases do not sleep. They hold a transaction open and wait
// until PostgreSQL reports the other backend as blocked by it
// (pg_blocking_pids), then let it go.

import { afterAll, describe, expect, test } from "vitest";
import type pg from "pg";
import { Annotation, Command, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph";

import { CHECKPOINT_FENCE_KEY, createDeepAgentsCheckpointer } from "../services/deep-agents/deep-agents-checkpointer.js";
import { CurrentSkillsCheckpointer } from "../services/deep-agents/current-skills-checkpointer.js";
import {
  SessionExecutionStore, type CheckpointWriteFence, type ExecutionActor, type SessionExecution
} from "../services/session-execution-store.js";
import { adminDatabaseUrl, appPool, runAppUserUrl, superuserPool } from "./support/database.js";
import { seedMembership, seedSession, seedTenant, seedUser } from "./support/fixtures.js";

async function personalSession() {
  const tenantId = await seedTenant(), userId = await seedUser();
  await seedMembership(tenantId, userId);
  const sessionId = await seedSession(tenantId, userId);
  return { tenantId, userId, sessionId, actor: { tenantId, sessionId, userId } };
}

const fenceOf = (execution: SessionExecution, runtimeId: string): CheckpointWriteFence => ({
  tenantId: execution.tenantId, sessionId: execution.sessionId, userId: execution.userId,
  executionId: execution.executionId, ownerId: execution.ownerId, runtimeId
});

/** What a turn passes to LangGraph (deep-agents-agui-backend.ts). */
const runConfig = (fence: CheckpointWriteFence, extra: Record<string, unknown> = {}) => ({
  configurable: { thread_id: fence.sessionId, checkpoint_ns: "", [CHECKPOINT_FENCE_KEY]: fence, ...extra }
});

async function startTurn(store: SessionExecutionStore, actor: ExecutionActor, runtimeId: string, leaseMs = 30_000) {
  const execution = await store.acquire(actor, leaseMs);
  await store.bindRuntime(execution, runtimeId);
  return { execution, fence: fenceOf(execution, runtimeId) };
}

const METADATA: CheckpointMetadata = { source: "loop", step: 1, parents: {} };
function checkpoint(id: string, value: string, version: number): Checkpoint {
  return {
    v: 4, id, ts: new Date().toISOString(),
    channel_values: { messages: [value] }, channel_versions: { messages: version }, versions_seen: {}
  };
}

const savedCheckpoints = async (threadId: string) => (await superuserPool().query<{ checkpoint_ns: string; checkpoint_id: string }>(
  "SELECT checkpoint_ns, checkpoint_id FROM deep_agents.checkpoints WHERE thread_id=$1 ORDER BY checkpoint_ns, checkpoint_id",
  [threadId])).rows;
const savedWrites = async (threadId: string) => (await superuserPool().query<{ checkpoint_ns: string; task_id: string; channel: string }>(
  "SELECT checkpoint_ns, task_id, channel FROM deep_agents.checkpoint_writes WHERE thread_id=$1 ORDER BY checkpoint_ns, task_id, idx",
  [threadId])).rows;
const lease = async (executionId: string) => (await superuserPool().query(
  "SELECT status, stop_reason FROM session_executions WHERE execution_id=$1", [executionId])).rows[0];

/** The backend that waits for a lock that `blockerPid` holds. Polls the database, with no fixed sleep. */
async function backendBlockedBy(blockerPid: number): Promise<number> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { rows } = await superuserPool().query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [blockerPid]);
    if (rows[0]) return rows[0].pid;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`No backend waited for backend ${blockerPid}.`);
}

/**
 * A transaction that holds the row of checkpoint_blobs which a `put` with
 * channel version `version` inserts. That `put` then waits inside its fenced
 * transaction, after the lease check and while it holds the lease row.
 */
async function holdBlobRow(threadId: string, version: number) {
  const client = await superuserPool().connect();
  await client.query("BEGIN");
  await client.query(`INSERT INTO deep_agents.checkpoint_blobs (thread_id, checkpoint_ns, channel, version, type, blob)
    VALUES ($1, '', 'messages', $2, 'empty', NULL)`, [threadId, String(version)]);
  const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
  let released = false;
  return {
    pid,
    async release() {
      if (released) return;
      released = true;
      try { await client.query("ROLLBACK"); } finally { client.release(); }
    }
  };
}

/** A pool whose transactions wait before COMMIT until the test opens the gate. */
function commitGate(pool: pg.Pool) {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  let reached!: (pid: number) => void;
  const waiting = new Promise<number>((resolve) => { reached = resolve; });
  const gated = {
    async connect() {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, property) {
          if (property === "query") {
            return async (text: string, values?: unknown[]) => {
              if (text === "COMMIT") {
                reached((await target.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid);
                await opened;
              }
              return target.query(text, values);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    }
  } as unknown as pg.Pool;
  return { pool: gated, waiting, open };
}

describe.skipIf(!adminDatabaseUrl())("checkpoint write fence", () => {
  const saver = adminDatabaseUrl() ? createDeepAgentsCheckpointer(runAppUserUrl()) : null;
  afterAll(async () => { await saver?.end(); });

  test("the turn that holds the lease saves checkpoints and pending writes, also in a subgraph namespace", async () => {
    const h = await personalSession();
    const owner = new SessionExecutionStore(appPool(), "replica-a");
    const { fence } = await startTurn(owner, h.actor, "runtime-1");
    // The runtime writes through CurrentSkillsCheckpointer (deep-agents-graph.ts).
    const runtimeSaver = new CurrentSkillsCheckpointer(saver!);
    const root = runConfig(fence);
    const nested = runConfig(fence, { checkpoint_ns: "tools:call-1" });

    const saved = await runtimeSaver.put(root, {
      ...checkpoint("cp-1", "hello", 1),
      channel_values: { messages: ["hello"], skillsMetadata: [{ name: "old listing" }] },
      channel_versions: { messages: 1, skillsMetadata: 1 }
    }, METADATA, { messages: 1, skillsMetadata: 1 });
    expect(saved.configurable).toMatchObject({ thread_id: h.sessionId, checkpoint_ns: "", checkpoint_id: "cp-1" });
    await runtimeSaver.putWrites({ configurable: { ...root.configurable, checkpoint_id: "cp-1" } },
      [["messages", "pending"], ["skillsMetadata", "pending listing"]], "task-1", "~0");
    await runtimeSaver.put(nested, checkpoint("cp-sub", "inside the subagent", 1), METADATA, { messages: 1 });
    await runtimeSaver.putWrites({ configurable: { ...nested.configurable, checkpoint_id: "cp-sub" } },
      [["messages", "subagent pending"]], "task-2");

    const read = { configurable: { thread_id: h.sessionId, checkpoint_ns: "" } };
    // The runtime reads the current skill catalog, not the saved listing.
    const tuple = await runtimeSaver.getTuple(read);
    expect(tuple?.checkpoint.channel_values).toEqual({ messages: ["hello"] });
    expect(tuple?.pendingWrites).toEqual([["task-1", "messages", "pending"]]);
    // The saver keeps the raw values.
    expect((await saver!.getTuple(read))?.checkpoint.channel_values)
      .toEqual({ messages: ["hello"], skillsMetadata: [{ name: "old listing" }] });
    const subTuple = await runtimeSaver.getTuple({ configurable: { thread_id: h.sessionId, checkpoint_ns: "tools:call-1" } });
    expect(subTuple?.checkpoint.channel_values).toEqual({ messages: ["inside the subagent"] });
    expect(subTuple?.pendingWrites).toEqual([["task-2", "messages", "subagent pending"]]);
    // A write holds the lease row only for its own transaction.
    expect(await owner.heartbeat(fenceAsExecution(fence), 30_000)).toBe(true);
  });

  test("a write with no fence, or with a fence of another thread, runtime, owner or user, fails", async () => {
    const h = await personalSession();
    const other = await personalSession();
    const owner = new SessionExecutionStore(appPool(), "replica-a");
    const { fence } = await startTurn(owner, h.actor, "runtime-1");
    const write = (config: { configurable: Record<string, unknown> }) =>
      saver!.put(config, checkpoint("cp-x", "x", 1), METADATA, { messages: 1 });

    await expect(write({ configurable: { thread_id: h.sessionId, checkpoint_ns: "" } }))
      .rejects.toThrow("A checkpoint write has no execution fence.");
    await expect(saver!.putWrites({ configurable: { thread_id: h.sessionId, checkpoint_ns: "", checkpoint_id: "cp-x" } },
      [["messages", "x"]], "task-1")).rejects.toThrow("A checkpoint write has no execution fence.");
    // thread_id is the session id: a fence cannot cover a thread of another session.
    await expect(write({ configurable: { ...runConfig(fence).configurable, thread_id: other.sessionId } }))
      .rejects.toThrow("A checkpoint write names a thread that is not the session of its execution.");
    for (const changed of [{ runtimeId: "runtime-2" }, { ownerId: "replica-b" }, { userId: other.userId },
      { tenantId: other.tenantId }, { executionId: "not-an-execution" }]) {
      await expect(write(runConfig({ ...fence, ...changed }))).rejects.toMatchObject({ code: "execution_stopped" });
    }
    expect(await savedCheckpoints(h.sessionId)).toEqual([]);
    expect(await savedCheckpoints(other.sessionId)).toEqual([]);
  });

  test("after a stop, a release or an expiry, the old execution writes nothing and the next one writes", async () => {
    const h = await personalSession();
    const replicaA = new SessionExecutionStore(appPool(), "replica-a");
    const replicaB = new SessionExecutionStore(appPool(), "replica-b");
    const first = await startTurn(replicaA, h.actor, "runtime-1");
    await saver!.put(runConfig(first.fence), checkpoint("cp-1", "first turn", 1), METADATA, { messages: 1 });
    const refused = async (fence: CheckpointWriteFence, id: string, version: number) => {
      await expect(saver!.put(runConfig(fence), checkpoint(id, "late", version), METADATA, { messages: version }))
        .rejects.toMatchObject({ code: "execution_stopped" });
      await expect(saver!.putWrites({ configurable: { ...runConfig(fence).configurable, checkpoint_id: "cp-1" } },
        [["messages", "late"]], `late-${id}`)).rejects.toMatchObject({ code: "execution_stopped" });
    };

    // Stop on another replica: the lease is `stopping` and has no authority.
    await replicaB.stop(h.actor);
    await refused(first.fence, "cp-after-stop", 2);
    // The owner releases after the turn settled.
    await replicaA.release(first.execution);
    expect(await lease(first.execution.executionId)).toEqual({ status: "stopped", stop_reason: "cancelled" });
    await refused(first.fence, "cp-after-release", 3);

    const second = await startTurn(replicaB, h.actor, "runtime-2");
    await saver!.put(runConfig(second.fence), checkpoint("cp-2", "second turn", 4), METADATA, { messages: 4 });
    await refused(first.fence, "cp-after-handoff", 5);

    // The second lease expires while it still looks active.
    await superuserPool().query("UPDATE session_executions SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE execution_id=$1",
      [second.execution.executionId]);
    await refused(second.fence, "cp-after-expiry", 6);
    const third = await startTurn(replicaA, h.actor, "runtime-3");
    expect(await lease(third.execution.executionId)).toEqual({ status: "active", stop_reason: null });
    await saver!.put(runConfig(third.fence), checkpoint("cp-3", "third turn", 7), METADATA, { messages: 7 });
    await refused(second.fence, "cp-after-expiry-handoff", 8);

    expect((await savedCheckpoints(h.sessionId)).map((row) => row.checkpoint_id)).toEqual(["cp-1", "cp-2", "cp-3"]);
    expect(await savedWrites(h.sessionId)).toEqual([]);
  });

  test("a stop waits for a write that holds the lease; the next write of that execution fails", async () => {
    const h = await personalSession();
    const owner = new SessionExecutionStore(appPool(), "replica-a");
    const other = new SessionExecutionStore(appPool(), "replica-b");
    const turn = await startTurn(owner, h.actor, "runtime-1");
    const blob = await holdBlobRow(h.sessionId, 1);
    try {
      const write = saver!.put(runConfig(turn.fence), checkpoint("cp-held", "held", 1), METADATA, { messages: 1 });
      // The write passed the lease check and waits on the blob row, in its transaction.
      const writer = await backendBlockedBy(blob.pid);
      const stop = other.stopAndGetOwner(h.actor);
      // The stop waits for the write, because the write holds the lease row.
      await backendBlockedBy(writer);
      expect(await lease(turn.execution.executionId)).toEqual({ status: "active", stop_reason: null });
      await blob.release();

      // The write was authorized before the stop, so it commits first.
      await expect(write).resolves.toMatchObject({ configurable: { checkpoint_id: "cp-held" } });
      await expect(stop).resolves.toEqual({ executionId: turn.execution.executionId, ownerId: "replica-a" });
    } finally {
      await blob.release();
    }
    await expect(saver!.put(runConfig(turn.fence), checkpoint("cp-late", "late", 2), METADATA, { messages: 2 }))
      .rejects.toMatchObject({ code: "execution_stopped" });
    expect((await savedCheckpoints(h.sessionId)).map((row) => row.checkpoint_id)).toEqual(["cp-held"]);
  });

  test("a write that comes during a stop waits for the stop to commit, then fails", async () => {
    const h = await personalSession();
    const owner = new SessionExecutionStore(appPool(), "replica-a");
    const gate = commitGate(appPool());
    const stopper = new SessionExecutionStore(gate.pool, "replica-b");
    const turn = await startTurn(owner, h.actor, "runtime-1");

    const stop = stopper.stopAndGetOwner(h.actor);
    // The stop changed the lease row and waits before its COMMIT.
    const stopperPid = await gate.waiting;
    const write = saver!.put(runConfig(turn.fence), checkpoint("cp-racing", "racing", 1), METADATA, { messages: 1 });
    const writes = saver!.putWrites({ configurable: { ...runConfig(turn.fence).configurable, checkpoint_id: "cp-racing" } },
      [["messages", "racing"]], "task-1");
    const outcomes = Promise.allSettled([write, writes]);
    // The writes wait for the stop.
    await backendBlockedBy(stopperPid);
    gate.open();

    await expect(stop).resolves.toEqual({ executionId: turn.execution.executionId, ownerId: "replica-a" });
    for (const outcome of await outcomes) {
      expect(outcome).toMatchObject({ status: "rejected", reason: { code: "execution_stopped" } });
    }
    expect(await savedCheckpoints(h.sessionId)).toEqual([]);
    expect(await savedWrites(h.sessionId)).toEqual([]);
  });

  test("a replacement after an expiry waits for a write that started before the expiry; later old writes fail", async () => {
    const h = await personalSession();
    const replicaA = new SessionExecutionStore(appPool(), "replica-a");
    const replicaB = new SessionExecutionStore(appPool(), "replica-b");
    const turn = await startTurn(replicaA, h.actor, "runtime-1", 2_000);
    const blob = await holdBlobRow(h.sessionId, 1);
    let replacement: SessionExecution;
    try {
      const write = saver!.put(runConfig(turn.fence), checkpoint("cp-before-expiry", "held", 1), METADATA, { messages: 1 });
      const writer = await backendBlockedBy(blob.pid);
      // Wait until the database clock passes the lease expiry. The write still holds the row.
      const deadline = Date.now() + 15_000;
      while (!(await superuserPool().query("SELECT expires_at<=clock_timestamp() AS expired FROM session_executions WHERE execution_id=$1",
        [turn.execution.executionId])).rows[0].expired) {
        if (Date.now() > deadline) throw new Error("The lease did not expire.");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const acquire = replicaB.acquire(h.actor, 30_000);
      // The expiry step of the admission waits for the write.
      await backendBlockedBy(writer);
      await blob.release();

      await expect(write).resolves.toMatchObject({ configurable: { checkpoint_id: "cp-before-expiry" } });
      replacement = await acquire;
    } finally {
      await blob.release();
    }
    expect(await lease(replacement.executionId)).toEqual({ status: "active", stop_reason: null });
    await expect(saver!.put(runConfig(turn.fence), checkpoint("cp-old", "old", 2), METADATA, { messages: 2 }))
      .rejects.toMatchObject({ code: "execution_stopped" });
    await replicaB.bindRuntime(replacement, "runtime-2");
    await saver!.put(runConfig(fenceOf(replacement, "runtime-2")), checkpoint("cp-new", "new", 3), METADATA, { messages: 3 });
    expect((await savedCheckpoints(h.sessionId)).map((row) => row.checkpoint_id)).toEqual(["cp-before-expiry", "cp-new"]);
  });

  test("a graph step that ignores the stop cannot write after the handoff, even on the same warm runtime", async () => {
    const h = await personalSession();
    const replica = new SessionExecutionStore(appPool(), "replica-a");
    const other = new SessionExecutionStore(appPool(), "replica-b");
    const State = Annotation.Root({
      log: Annotation<string[]>({ reducer: (left, right) => left.concat(right), default: () => [] })
    });
    let entered!: () => void;
    const stepEntered = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void;
    const stepFinishes = new Promise<void>((resolve) => { finish = resolve; });
    const subagent = new StateGraph(State)
      .addNode("inner", async () => ({ log: ["subagent"] }))
      .addEdge(START, "inner").addEdge("inner", END)
      .compile();
    const graph = new StateGraph(State)
      .addNode("first", async () => ({ log: ["first"] }))
      .addNode("subagent", subagent)
      // Ignores every abort signal, like a stuck tool or provider call.
      .addNode("slow", async () => { entered(); await stepFinishes; return { log: ["slow"] }; })
      .addEdge(START, "first").addEdge("first", "subagent").addEdge("subagent", "slow").addEdge("slow", END)
      .compile({ checkpointer: new CurrentSkillsCheckpointer(saver!) });

    const firstTurn = await startTurn(replica, h.actor, "runtime-1");
    const oldRun = graph.invoke({ log: ["input"] }, runConfig(firstTurn.fence));
    oldRun.catch(() => {});
    await stepEntered;

    // Stop, then the fallback release, then a new turn on the same runtime.
    await other.stop(h.actor);
    await replica.release(firstTurn.execution);
    const secondTurn = await startTurn(replica, h.actor, "runtime-1");
    const atHandoff = { checkpoints: await savedCheckpoints(h.sessionId), writes: await savedWrites(h.sessionId) };
    // The old run wrote its earlier steps, also in the namespace of the subgraph.
    expect(atHandoff.checkpoints.some((row) => row.checkpoint_ns.startsWith("subagent:"))).toBe(true);

    finish();
    await expect(oldRun).rejects.toMatchObject({ code: "execution_stopped" });
    expect(await savedCheckpoints(h.sessionId)).toEqual(atHandoff.checkpoints);
    expect(await savedWrites(h.sessionId)).toEqual(atHandoff.writes);

    // The new turn continues from the last saved checkpoint, under its own
    // execution, and ends as a run that was never stopped.
    const result = await graph.invoke(null, runConfig(secondTurn.fence));
    const reference = await personalSession();
    const referenceTurn = await startTurn(replica, reference.actor, "runtime-reference");
    expect(result.log).toEqual((await graph.invoke({ log: ["input"] }, runConfig(referenceTurn.fence))).log);
    expect(result.log.at(-1)).toBe("slow");
    expect((await savedCheckpoints(h.sessionId)).length).toBeGreaterThan(atHandoff.checkpoints.length);
  });

  test("a resume after an interrupt in a subgraph writes under the current execution only", async () => {
    const h = await personalSession();
    const replica = new SessionExecutionStore(appPool(), "replica-a");
    const State = Annotation.Root({
      log: Annotation<string[]>({ reducer: (left, right) => left.concat(right), default: () => [] })
    });
    const approval = new StateGraph(State)
      .addNode("ask", async () => ({ log: [`answer:${String(interrupt("approve?"))}`] }))
      .addEdge(START, "ask").addEdge("ask", END)
      .compile();
    const graph = new StateGraph(State)
      .addNode("approval", approval)
      .addEdge(START, "approval").addEdge("approval", END)
      .compile({ checkpointer: new CurrentSkillsCheckpointer(saver!) });

    // The same turn resumes after the decision (the approval round of a turn).
    const turn = await startTurn(replica, h.actor, "runtime-1");
    await graph.invoke({ log: [] }, runConfig(turn.fence));
    expect((await graph.getState(runConfig(turn.fence))).next).toEqual(["approval"]);
    expect((await savedCheckpoints(h.sessionId)).some((row) => row.checkpoint_ns.startsWith("approval:"))).toBe(true);

    // A resume under an execution that has ended fails and changes nothing.
    await replica.release(turn.execution);
    const before = { checkpoints: await savedCheckpoints(h.sessionId), writes: await savedWrites(h.sessionId) };
    await expect(graph.invoke(new Command({ resume: "late" }), runConfig(turn.fence)))
      .rejects.toMatchObject({ code: "execution_stopped" });
    expect(await savedCheckpoints(h.sessionId)).toEqual(before.checkpoints);
    expect(await savedWrites(h.sessionId)).toEqual(before.writes);

    const next = await startTurn(replica, h.actor, "runtime-1");
    const result = await graph.invoke(new Command({ resume: "yes" }), runConfig(next.fence));
    expect(result.log).toEqual(["answer:yes"]);
    expect((await graph.getState(runConfig(next.fence))).next).toEqual([]);
  });
});

function fenceAsExecution(fence: CheckpointWriteFence): SessionExecution {
  return { ...fence, projectId: null, expiresAt: new Date().toISOString() };
}
