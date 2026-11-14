import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { CHECKPOINT_FENCE_KEY, ExecutionFencedCheckpointSaver } from "./deep-agents-checkpointer.js";

const fence = {
  tenantId: "tenant-1", sessionId: "session-1", userId: "user-1",
  executionId: "execution-1", ownerId: "replica-1", runtimeId: "runtime-1"
};
const config = { configurable: { thread_id: "session-1", checkpoint_ns: "", [CHECKPOINT_FENCE_KEY]: fence } };
const checkpoint = {
  v: 4, id: "cp-1", ts: "2026-11-14T00:00:00.000Z",
  channel_values: { messages: ["hello"] }, channel_versions: { messages: 1 }, versions_seen: {}
};
const metadata = { source: "loop" as const, step: 1, parents: {} };

/** A pool that records statements. The lease check finds a row only while `leaseHeld` is true. */
function recordingPool(leaseHeld = true) {
  const statements: string[] = [];
  const release = vi.fn();
  const query = vi.fn(async (text: string) => {
    statements.push(text.trim().split(/\s+/).slice(0, 3).join(" "));
    if (text.includes("FROM session_executions")) return { rows: leaseHeld ? [{ "?column?": 1 }] : [] };
    return { rows: [] };
  });
  const pool = {
    connect: vi.fn(async () => ({ query, release })),
    query: vi.fn(async () => { throw new Error("The saver must not write through pool.query."); }),
    end: vi.fn(async () => {})
  };
  return { pool: pool as unknown as Pool, raw: pool, statements, release, query };
}

describe("ExecutionFencedCheckpointSaver", () => {
  it("checks the lease first in the transaction of each put and putWrites", async () => {
    const { pool, statements, release } = recordingPool();
    const saver = new ExecutionFencedCheckpointSaver(pool);

    await saver.put(config, checkpoint, metadata, { messages: 1 });
    await saver.putWrites({ configurable: { ...config.configurable, checkpoint_id: "cp-1" } }, [["messages", "x"]], "task-1");

    expect(statements).toEqual([
      "BEGIN", "SELECT set_config('app.current_tenant_id', $1,", "SELECT 1 FROM",
      "INSERT INTO \"deep_agents\".checkpoint_blobs", "INSERT INTO \"deep_agents\".checkpoints", "COMMIT",
      "BEGIN", "SELECT set_config('app.current_tenant_id', $1,", "SELECT 1 FROM",
      "INSERT INTO \"deep_agents\".checkpoint_writes", "COMMIT"
    ]);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("rolls back before any write when the execution no longer holds the lease", async () => {
    const { pool, statements, release } = recordingPool(false);
    const saver = new ExecutionFencedCheckpointSaver(pool);

    await expect(saver.put(config, checkpoint, metadata, { messages: 1 })).rejects.toMatchObject({ code: "execution_stopped" });
    await expect(saver.putWrites(config, [["messages", "x"]], "task-1")).rejects.toMatchObject({ code: "execution_stopped" });

    expect(statements.filter((statement) => statement.startsWith("INSERT"))).toEqual([]);
    expect(statements.filter((statement) => statement === "ROLLBACK")).toHaveLength(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("refuses a write with no fence, or with a fence of another session, before it connects", async () => {
    const { pool, raw } = recordingPool();
    const saver = new ExecutionFencedCheckpointSaver(pool);

    await expect(saver.put({ configurable: { thread_id: "session-1" } }, checkpoint, metadata, {}))
      .rejects.toThrow("A checkpoint write has no execution fence.");
    await expect(saver.putWrites({ configurable: { thread_id: "session-1", [CHECKPOINT_FENCE_KEY]: { ...fence, ownerId: "" } } },
      [], "task-1")).rejects.toThrow("A checkpoint write has no execution fence.");
    await expect(saver.put({ configurable: { ...config.configurable, thread_id: "session-2" } }, checkpoint, metadata, {}))
      .rejects.toThrow("A checkpoint write names a thread that is not the session of its execution.");
    expect(raw.connect).not.toHaveBeenCalled();
  });

  it("refuses a statement that the saver sends outside the fenced transaction", async () => {
    const { pool, query } = recordingPool();
    const saver = new ExecutionFencedCheckpointSaver(pool);
    // A later saver version that writes before BEGIN.
    const writer = (saver as unknown as { writer(config: unknown): { pool: Pool } }).writer(config);
    const client = await writer.pool.connect();

    await expect(client.query("INSERT INTO deep_agents.checkpoints VALUES (1)"))
      .rejects.toThrow("A checkpoint write ran outside its fenced transaction.");
    await expect(writer.pool.query("INSERT INTO deep_agents.checkpoints VALUES (1)"))
      .rejects.toThrow("A checkpoint write must run in a fenced transaction.");
    await expect(writer.pool.end()).rejects.toThrow("Only the shared saver closes the checkpoint pool.");
    expect(query).not.toHaveBeenCalled();
  });

  it("reads, deletes threads and closes the pool without a fence", async () => {
    const { pool, raw, statements } = recordingPool();
    const saver = new ExecutionFencedCheckpointSaver(pool);
    raw.query.mockImplementation(async () => ({ rows: [] }) as never);

    expect(await saver.getTuple({ configurable: { thread_id: "session-1", checkpoint_ns: "" } })).toBeUndefined();
    await saver.deleteThread("session-1");
    await saver.end();

    expect(statements).toEqual([
      "BEGIN", "DELETE FROM \"deep_agents\".checkpoint_blobs", "DELETE FROM \"deep_agents\".checkpoints",
      "DELETE FROM \"deep_agents\".checkpoint_writes", "COMMIT"
    ]);
    expect(raw.end).toHaveBeenCalledOnce();
  });
});
