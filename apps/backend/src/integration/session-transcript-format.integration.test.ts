// The session history format (migration 064) against PostgreSQL: the
// migration leaves existing sessions in the previous format without updating
// them, every insert path writes the current format, the stores report it
// under RLS, and the routes refuse to continue or reopen an older session
// before any turn work, while its rows stay readable.

import { describe, expect, test, vi } from "vitest";

import { registerAdminSessionDetailRoute } from "../routes/admin/admin-session-detail.js";
import { createDeepAgentsCheckpointer } from "../services/deep-agents/deep-agents-checkpointer.js";
import { ProjectStore } from "../services/project-store.js";
import { CURRENT_TRANSCRIPT_FORMAT, SessionStore } from "../services/session-store.js";
import { adminDatabaseUrl, appPool, runAppUserUrl, superuserPool } from "./support/database.js";
import { seedMembership, seedMessage, seedSession, seedTenant, seedUser } from "./support/fixtures.js";
import { buildMessageApp } from "./support/message-app.js";
import { withStagedDatabase } from "./support/staged-migrations.js";

vi.mock("langchain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("langchain")>();
  const { FakeStreamingChatModel } = await import("@langchain/core/utils/testing");
  const { AIMessage } = await import("@langchain/core/messages");
  class ReplyModel extends FakeStreamingChatModel {
    override bindTools() { return this.withConfig({}); }
  }
  return { ...actual, initChatModel: async () => new ReplyModel({ sleep: 0, responses: [new AIMessage("Saved reply.")] }) };
});

const MIGRATION = "064_session_transcript_format.sql";

/** Marks a seeded session as a row from before migration 064, or a later format. */
async function setFormat(sessionId: string, format: number | null) {
  await superuserPool().query("UPDATE sessions SET transcript_format = $2 WHERE session_id = $1", [sessionId, format]);
}

async function storedFormat(sessionId: string): Promise<number | null> {
  const result = await superuserPool().query("SELECT transcript_format FROM sessions WHERE session_id = $1", [sessionId]);
  return result.rows[0].transcript_format;
}

describe.skipIf(!adminDatabaseUrl())("session history format", () => {
  test("migration 064 keeps existing sessions NULL without updating a row, and new sessions get the current format", async () => {
    await withStagedDatabase(async ({ db, migrate }) => {
      await migrate((file) => file < MIGRATION);

      // A conversation saved before 064: reasoning without segments, and a
      // tool result without a text offset.
      const tenant = "tenant-064", user = "user-064", sessionId = "session-064", messageId = "message-064";
      await db.query("INSERT INTO tenants (tenant_id, tenant_name, slug) VALUES ($1, $1, $1)", [tenant]);
      await db.query("INSERT INTO users (user_id, email) VALUES ($1, 'old@example.test')", [user]);
      await db.query("INSERT INTO sessions (session_id, tenant_id, user_id, session_name) VALUES ($1, $2, $3, 'Old chat')",
        [sessionId, tenant, user]);
      await db.query(
        `INSERT INTO messages (message_id, tenant_id, session_id, user_id, role, status, content_text, reasoning_content)
         VALUES ($1, $2, $3, $4, 'assistant', 'completed', 'Old answer', 'Old thinking')`,
        [messageId, tenant, sessionId, user]
      );
      await db.query(
        `INSERT INTO message_tool_results (tenant_id, message_id, session_id, user_id, tool_result_id, kind, title, status, input_text, output_text)
         VALUES ($1, $2, $3, $4, 'tool-064', 'command', 'execute', 'completed', '{}', 'ok')`,
        [tenant, messageId, sessionId, user]
      );
      const sessionBefore = await db.query("SELECT xmin::text AS xmin, * FROM sessions WHERE session_id = $1", [sessionId]);
      const messagesBefore = await db.query("SELECT xmin::text AS xmin, * FROM messages WHERE session_id = $1", [sessionId]);
      const toolsBefore = await db.query("SELECT xmin::text AS xmin, * FROM message_tool_results WHERE message_id = $1", [messageId]);

      await migrate((file) => file >= MIGRATION);

      const sessionAfter = await db.query("SELECT xmin::text AS xmin, * FROM sessions WHERE session_id = $1", [sessionId]);
      // The same row version: the migration added a column and updated nothing.
      // Compare only the columns that existed before: later migrations, which
      // also run here, can add more.
      const sessionAfterKnown = Object.fromEntries(
        [...Object.keys(sessionBefore.rows[0]), "transcript_format"].map((key) => [key, sessionAfter.rows[0][key]])
      );
      expect(sessionAfterKnown).toEqual({ ...sessionBefore.rows[0], transcript_format: null });
      expect((await db.query("SELECT xmin::text AS xmin, * FROM messages WHERE session_id = $1", [sessionId])).rows)
        .toEqual(messagesBefore.rows);
      expect((await db.query("SELECT xmin::text AS xmin, * FROM message_tool_results WHERE message_id = $1", [messageId])).rows)
        .toEqual(toolsBefore.rows);
      const column = await db.query(
        `SELECT data_type, is_nullable, column_default FROM information_schema.columns
         WHERE table_name = 'sessions' AND column_name = 'transcript_format'`
      );
      expect(column.rows).toEqual([{ data_type: "smallint", is_nullable: "YES", column_default: String(CURRENT_TRANSCRIPT_FORMAT) }]);

      const store = new SessionStore(db);
      expect((await store.getReadable(tenant, sessionId, user))?.transcriptFormat).toBe("legacy");
      const created = await store.create(tenant, user, "New chat");
      expect(created.transcriptFormat).toBe("current");
      expect((await db.query("SELECT transcript_format FROM sessions WHERE session_id = $1", [created.sessionId])).rows[0])
        .toEqual({ transcript_format: CURRENT_TRANSCRIPT_FORMAT });
    });
  });

  test("the stores report each format under RLS, and every insert path writes the current one", async () => {
    const tenant = await seedTenant(), foreignTenant = await seedTenant();
    const user = await seedUser(), foreignUser = await seedUser();
    await seedMembership(tenant, user);
    const sessions = new SessionStore(appPool()), projects = new ProjectStore(appPool());

    const chat = await sessions.create(tenant, user, "Chat");
    const scheduled = await sessions.create(tenant, user, "[Scheduled] Report", { purpose: "scheduled" });
    expect([chat.transcriptFormat, scheduled.transcriptFormat]).toEqual(["current", "current"]);
    const project = await projects.create(tenant, user, "Project");
    const projectChat = (await projects.createSession(tenant, user, project.projectId, "Project chat"))!;
    const projectRows = await superuserPool().query(
      "SELECT purpose, transcript_format FROM sessions WHERE project_id = $1 ORDER BY purpose", [project.projectId]
    );
    // The reference session and the project chat.
    expect(projectRows.rows).toEqual([
      { purpose: "normal", transcript_format: CURRENT_TRANSCRIPT_FORMAT },
      { purpose: "project_reference", transcript_format: CURRENT_TRANSCRIPT_FORMAT }
    ]);
    expect((await sessions.getReadable(tenant, projectChat, user))?.transcriptFormat).toBe("current");

    const legacy = await seedSession(tenant, user);
    await setFormat(legacy, null);
    const unsupported = await seedSession(tenant, user);
    await setFormat(unsupported, CURRENT_TRANSCRIPT_FORMAT + 1);
    expect((await sessions.getReadable(tenant, legacy, user))?.transcriptFormat).toBe("legacy");
    expect((await sessions.getReadable(tenant, unsupported, user))?.transcriptFormat).toBe("unsupported");
    const listed = new Map((await sessions.listPage(tenant, user)).sessions.map((row) => [row.sessionId, row.transcriptFormat]));
    expect(Object.fromEntries([legacy, unsupported, chat.sessionId].map((id) => [id, listed.get(id)])))
      .toEqual({ [legacy]: "legacy", [unsupported]: "unsupported", [chat.sessionId]: "current" });

    // Lifecycle changes and a move into a project keep the stored format:
    // the old transcript and checkpoint move with the session.
    expect((await sessions.rename(tenant, legacy, user, "Renamed"))?.transcriptFormat).toBe("legacy");
    expect((await sessions.setArchived(tenant, legacy, user, true))?.transcriptFormat).toBe("legacy");
    expect((await sessions.setArchived(tenant, legacy, user, false))?.transcriptFormat).toBe("legacy");
    expect(await projects.setSession(tenant, user, project.projectId, legacy)).toBe(true);
    expect(await storedFormat(legacy)).toBeNull();
    expect((await sessions.getReadable(tenant, legacy, user))?.transcriptFormat).toBe("legacy");

    // Another tenant or user sees neither the session nor its format.
    expect(await sessions.getReadable(foreignTenant, legacy, user)).toBeNull();
    expect(await sessions.getReadable(tenant, unsupported, foreignUser)).toBeNull();
  });

  test("the routes refuse an older or unknown format before turn work, keep its rows readable, and continue a current session", async () => {
    const tenantId = await seedTenant(), userId = await seedUser(), otherUser = await seedUser();
    await seedMembership(tenantId, userId);
    const checkpointer = createDeepAgentsCheckpointer(runAppUserUrl());
    const auth = { userId, admin: false };
    const { app, stores: { sessions }, created, quota, evaluateText, send: post } =
      await buildMessageApp({ tenantId, auth, checkpointer });
    await registerAdminSessionDetailRoute(app);
    const send = (sessionId: string) => post(sessionId, "Continue");
    const rowsOf = async (sessionId: string) =>
      (await superuserPool().query("SELECT message_id, role, content_text FROM messages WHERE session_id = $1 ORDER BY id", [sessionId])).rows;

    // An old conversation with its saved rows and its LangGraph checkpoint.
    // The routes take UUID session ids, as the store creates them.
    const legacy = (await sessions.create(tenantId, userId, "Old chat")).sessionId;
    await setFormat(legacy, null);
    const unsupported = (await sessions.create(tenantId, userId, "Later chat")).sessionId;
    await setFormat(unsupported, CURRENT_TRANSCRIPT_FORMAT + 1);
    for (const sessionId of [legacy, unsupported]) {
      await seedMessage(tenantId, userId, sessionId);
      await checkpointer.put({ configurable: { thread_id: sessionId, checkpoint_ns: "" } }, {
        v: 4, id: `cp-${sessionId}`, ts: new Date().toISOString(),
        channel_values: { messages: ["old context"] }, channel_versions: { messages: 1 }, versions_seen: {}
      }, { source: "input", step: 1, parents: {} }, { messages: 1 });
    }
    const savedRows = { [legacy]: await rowsOf(legacy), [unsupported]: await rowsOf(unsupported) };

    for (const sessionId of [legacy, unsupported]) {
      const sent = await send(sessionId);
      expect(sent.statusCode).toBe(409);
      expect(sent.json()).toMatchObject({ error: "unsupported_transcript_format" });
      const connected = await app.inject({ method: "GET", url: `/sessions/${sessionId}/connect` });
      expect(connected.statusCode).toBe(409);
      // The rows stay stored and readable through the message route.
      expect(await rowsOf(sessionId)).toEqual(savedRows[sessionId]);
      const listed = await app.inject({ method: "GET", url: `/sessions/${sessionId}/messages` });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().messages.map((row: { messageId: string }) => row.messageId))
        .toEqual(savedRows[sessionId]!.map((row) => row.message_id));
      const checkpoint = await checkpointer.getTuple({ configurable: { thread_id: sessionId, checkpoint_ns: "" } });
      expect(checkpoint?.checkpoint.id).toBe(`cp-${sessionId}`);
    }
    // Nothing started: no runtime, lease, quota, or PII scan.
    expect(created).toEqual([]);
    expect(quota).not.toHaveBeenCalled();
    expect(evaluateText).not.toHaveBeenCalled();
    const leases = await superuserPool().query("SELECT count(*)::int AS count FROM session_executions WHERE session_id = ANY($1)", [[legacy, unsupported]]);
    expect(leases.rows[0].count).toBe(0);

    // An admin still reads the old transcript through the audit route.
    auth.admin = true;
    const audit = await app.inject({ method: "GET", url: `/admin/sessions/${legacy}` });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().messages.map((row: { messageId: string }) => row.messageId))
      .toEqual(savedRows[legacy]!.map((row) => row.message_id));
    auth.admin = false;

    // Another user cannot learn whether the session exists.
    auth.userId = otherUser;
    expect((await send(legacy)).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/sessions/${legacy}/connect` })).statusCode).toBe(404);
    auth.userId = userId;

    // A current session continues, and its connection restores the turn.
    const current = await sessions.create(tenantId, userId, "New chat");
    const sent = await send(current.sessionId);
    expect(sent.statusCode).toBe(200);
    expect(sent.body).toContain("RUN_FINISHED");
    expect((await rowsOf(current.sessionId)).map((row) => [row.role, row.content_text])).toEqual([
      ["user", "Continue"],
      ["assistant", "Saved reply."]
    ]);
    expect(created).toHaveLength(1);
    expect(await checkpointer.getTuple({ configurable: { thread_id: current.sessionId, checkpoint_ns: "" } })).toBeTruthy();
    const connected = await app.inject({ method: "GET", url: `/sessions/${current.sessionId}/connect` });
    expect(connected.statusCode).toBe(200);
    expect(connected.body).toContain("Saved reply.");
    expect(connected.body).toContain('"activeTurn":"none"');
  });
});
