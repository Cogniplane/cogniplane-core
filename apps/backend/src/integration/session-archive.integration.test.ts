import { readFile } from "node:fs/promises";
import { afterAll, describe, expect, test } from "vitest";
import { SessionStore } from "../services/session-store.js";
import { createDeepAgentsCheckpointer } from "../services/deep-agents/deep-agents-checkpointer.js";
import { adminDatabaseUrl, appPool, runAppUserUrl, superuserPool } from "./support/database.js";
import { seedTenant, seedUser, seedSession, seedMessage, seedRuntimeSession, seedApproval } from "./support/fixtures.js";

describe.skipIf(!adminDatabaseUrl())("session archive persistence", () => {
  const saver = adminDatabaseUrl() ? createDeepAgentsCheckpointer(runAppUserUrl()) : null;
  afterAll(async () => { await saver?.end(); });

  test("archive and restore retain messages and checkpoints, filter lists, and enforce ownership", async () => {
    const tenant = await seedTenant();
    const foreignTenant = await seedTenant();
    const user = await seedUser();
    const foreignUser = await seedUser();
    const id = await seedSession(tenant, user);
    const messageId = await seedMessage(tenant, user, id);
    const store = new SessionStore(appPool());
    const config = { configurable: { thread_id: id, checkpoint_ns: "" } };
    await saver!.put(config, {
      v: 4, id: "cp-archive", ts: new Date().toISOString(),
      channel_values: { messages: ["preserved history"] }, channel_versions: { messages: 1 }, versions_seen: {}
    }, { source: "input", step: 1, parents: {} }, { messages: 1 });

    expect(await store.setArchived(foreignTenant, id, user, true)).toBeNull();
    expect(await store.setArchived(tenant, id, foreignUser, true)).toBeNull();
    const archived = await store.setArchived(tenant, id, user, true);
    expect(archived).toMatchObject({ status: "archived", archivedAt: expect.any(String) });
    expect(await store.list(tenant, user)).toEqual([]);
    expect(await store.list(tenant, user, { status: "archived" })).toEqual([{
      ...archived,
      hasPendingApprovals: false,
      canEdit: true,
      isRunning: false
    }]);
    expect(await store.list(foreignTenant, user, { status: "archived" })).toEqual([]);
    expect(await store.list(tenant, foreignUser, { status: "archived" })).toEqual([]);
    expect(await store.setArchived(foreignTenant, id, user, false)).toBeNull();
    expect(await store.setArchived(tenant, id, foreignUser, false)).toBeNull();
    expect((await saver!.getTuple(config))?.checkpoint.channel_values).toEqual({ messages: ["preserved history"] });
    expect((await superuserPool().query("SELECT message_id FROM messages WHERE session_id = $1", [id])).rows).toEqual([{ message_id: messageId }]);

    const restored = await store.setArchived(tenant, id, user, false);
    expect(restored?.status).toBe("active");
    expect(restored).not.toHaveProperty("archivedAt");
    expect(await store.list(tenant, user, { status: "archived" })).toEqual([]);
    expect((await store.list(tenant, user)).map((row) => row.sessionId)).toEqual([id]);
    expect((await saver!.getTuple(config))?.checkpoint.channel_values).toEqual({ messages: ["preserved history"] });
    await store.setArchived(tenant, id, user, true);
    expect(await store.remove(foreignTenant, id, user)).toBe(false);
    expect(await store.remove(tenant, id, foreignUser)).toBe(false);
    expect(await store.remove(tenant, id, user)).toBe(true);
    expect(await store.setArchived(tenant, id, user, false)).toBeNull();
    expect(await store.list(tenant, user, { status: "archived" })).toEqual([]);
    await saver!.deleteThread(id);
  });

  test("chat archive scope retains skill improvements and excludes scheduled runs even after restore", async () => {
    const tenant = await seedTenant();
    const user = await seedUser();
    const store = new SessionStore(appPool());
    const normal = await store.create(tenant, user, "Chat");
    const improvement = await store.create(tenant, user, "Improve a skill", { purpose: "skill_improvement" });
    const scheduled = await store.create(tenant, user, "[Scheduled] Report", { purpose: "scheduled" });
    for (const session of [normal, improvement, scheduled]) {
      await store.setArchived(tenant, session.sessionId, user, true);
    }
    const purposes = ["normal", "skill_improvement"];
    const archived = await store.list(tenant, user, { status: "archived", purposes });
    expect(archived.map((session) => session.sessionId).sort()).toEqual([normal.sessionId, improvement.sessionId].sort());
    expect(await store.list(tenant, user, { status: "archived", purposes: "all" })).toHaveLength(3);
    const restored = await store.setArchived(tenant, scheduled.sessionId, user, false);
    expect(restored?.purpose).toBe("scheduled");
    expect(await store.list(tenant, user, { purposes })).toEqual([]);
  });

  test("migration 013 can be replayed without losing archive metadata or status validation", async () => {
    const client = await superuserPool().connect();
    try {
      // Shadow the real table so replay tests do not change concurrent integration fixtures.
      await client.query(`CREATE TEMP TABLE sessions (
        tenant_id text, user_id text, status text NOT NULL DEFAULT 'active', updated_at timestamptz
      )`);
      const sql = await readFile(new URL("../../db/migrations/013_session_archive.sql", import.meta.url), "utf8");
      await client.query(sql);
      await client.query("INSERT INTO sessions VALUES ('tenant', 'user', 'archived', NOW(), '2026-09-01T00:00:00Z')");
      await client.query(sql);
      const result = await client.query("SELECT status, archived_at FROM sessions");
      expect(result.rows[0]).toEqual({ status: "archived", archived_at: new Date("2026-09-01T00:00:00Z") });
      await expect(client.query("UPDATE sessions SET status = 'invalid'"))
        .rejects.toMatchObject({ code: "23514", constraint: "sessions_status_check" });
    } finally {
      await client.query("DROP TABLE IF EXISTS pg_temp.sessions");
      client.release();
    }
  });

  test("the database rejects unknown session statuses", async () => {
    const tenant = await seedTenant();
    const user = await seedUser();
    const id = await seedSession(tenant, user);
    await expect(superuserPool().query("UPDATE sessions SET status = 'archvied' WHERE session_id = $1", [id]))
      .rejects.toMatchObject({ code: "23514", constraint: "sessions_status_check" });
    expect((await new SessionStore(appPool()).getOwned(tenant, id, user))?.status).toBe("active");
  });

  test("pending approvals prevent archive, including after runtime teardown", async () => {
    const tenant = await seedTenant();
    const user = await seedUser();
    const id = await seedSession(tenant, user);
    const runtimeId = await seedRuntimeSession(tenant, user, id);
    const approval = await seedApproval({ tenantId: tenant, userId: user, sessionId: id, runtimeId });
    const store = new SessionStore(appPool());
    expect(await store.setArchived(tenant, id, user, true)).toBeNull();
    expect((await store.getOwned(tenant, id, user))?.status).toBe("active");
    await superuserPool().query("UPDATE approvals SET status = 'rejected' WHERE approval_id = $1", [approval]);
    expect((await store.setArchived(tenant, id, user, true))?.status).toBe("archived");
  });
});
