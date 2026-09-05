// The Deep Agents checkpointer round-trips as `app_user`.
//
// Two things can silently go wrong in `setupDeepAgentsCheckpointer`, and unit
// tests can see neither: the DDL for schema `deep_agents` may not have run, and
// `app_user` may lack DML on it. Either produces a runtime error on the first
// graph superstep, which is the worst place to find out. This test does what
// production does — connect as app_user, put a checkpoint, read it back — so
// both failures surface at CI time.
//
// It asserts no tenancy boundary, deliberately. The checkpointer tables have no
// tenant column and no RLS; isolation is app-layer, because thread_id IS the
// session id and every route resolves the session through the RLS-scoped
// `sessions` table first.

import { afterAll, describe, expect, test } from "vitest";
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph";

import { createDeepAgentsCheckpointer } from "../services/deep-agents/deep-agents-checkpointer.js";

import { adminDatabaseUrl, runAppUserUrl } from "./support/database.js";

describe.skipIf(!adminDatabaseUrl())("Deep Agents checkpointer", () => {
  // The saver owns its own pool (PostgresSaver constructs one), so it is not
  // part of the shared pool teardown in support/setup.ts.
  const saver = adminDatabaseUrl() ? createDeepAgentsCheckpointer(runAppUserUrl()) : null;

  afterAll(async () => {
    await saver?.end();
  });

  // `newVersions` is not optional in practice: PostgresSaver persists channel
  // VALUES into checkpoint_blobs keyed by the versions passed here, so `{}`
  // writes the checkpoint row with no values and getTuple returns an empty
  // channel_values. Keep this in sync with the checkpoint's channel_versions.
  const NEW_VERSIONS = { messages: 1 };
  const CHECKPOINT_METADATA: CheckpointMetadata = { source: "input", step: 1, parents: {} };

  function checkpoint(id: string): Checkpoint {
    return {
      v: 4,
      id,
      ts: new Date().toISOString(),
      channel_values: { messages: ["integration checkpoint"] },
      channel_versions: { messages: 1 },
      versions_seen: {}
    };
  }

  test("a checkpoint written as app_user reads back", async () => {
    const threadId = `it-thread-${Date.now()}`;
    const config = {
      configurable: { thread_id: threadId, checkpoint_ns: "" }
    };

    const written = await saver!.put(
      config,
      checkpoint("cp-1"),
      CHECKPOINT_METADATA,
      NEW_VERSIONS
    );
    expect(written.configurable?.thread_id).toBe(threadId);

    const tuple = await saver!.getTuple({
      configurable: { thread_id: threadId, checkpoint_ns: "" }
    });

    expect(tuple?.checkpoint.channel_values).toEqual({ messages: ["integration checkpoint"] });
  });

  test("deleteThread removes the thread's checkpoints", async () => {
    // Session deletion purges the thread this way (purgeSessionData). If the
    // grants were read-only, the write above would have failed but this would
    // be the first thing to notice a missing DELETE grant.
    const threadId = `it-thread-del-${Date.now()}`;
    const config = { configurable: { thread_id: threadId, checkpoint_ns: "" } };

    await saver!.put(config, checkpoint("cp-1"), CHECKPOINT_METADATA, NEW_VERSIONS);
    expect(await saver!.getTuple(config)).toBeDefined();

    await saver!.deleteThread(threadId);
    expect(await saver!.getTuple(config)).toBeUndefined();
  });

  test("threads are independent", async () => {
    // thread_id is the only key these tables have, so a bug that ignored it
    // would cross sessions — and, because thread_id IS the session id, tenants.
    //
    // Both threads get DISTINCT data and both are read back. An earlier version
    // wrote one thread and only queried a nonexistent second one, which passes
    // if `put` silently fails or `getTuple` always returns undefined.
    const first = `it-thread-a-${Date.now()}`;
    const second = `it-thread-b-${Date.now()}`;

    await saver!.put(
      { configurable: { thread_id: first, checkpoint_ns: "" } },
      { ...checkpoint("cp-a"), channel_values: { messages: ["thread A value"] } },
      CHECKPOINT_METADATA,
      NEW_VERSIONS
    );
    await saver!.put(
      { configurable: { thread_id: second, checkpoint_ns: "" } },
      { ...checkpoint("cp-b"), channel_values: { messages: ["thread B value"] } },
      CHECKPOINT_METADATA,
      NEW_VERSIONS
    );

    const tupleA = await saver!.getTuple({
      configurable: { thread_id: first, checkpoint_ns: "" }
    });
    const tupleB = await saver!.getTuple({
      configurable: { thread_id: second, checkpoint_ns: "" }
    });

    // Each thread sees only its own value. A key-ignoring bug would make these
    // equal, which no amount of "the other thread is empty" checking catches.
    expect(tupleA?.checkpoint.channel_values).toEqual({ messages: ["thread A value"] });
    expect(tupleB?.checkpoint.channel_values).toEqual({ messages: ["thread B value"] });

    // And an unwritten thread really is empty.
    const unwritten = await saver!.getTuple({
      configurable: { thread_id: `it-thread-none-${Date.now()}`, checkpoint_ns: "" }
    });
    expect(unwritten).toBeUndefined();
  });
});
