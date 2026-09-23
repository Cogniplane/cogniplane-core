import { describe, expect, test } from "vitest";
import { SessionStore } from "../services/session-store.js";
import { MessageStore } from "../services/message-store.js";
import { adminDatabaseUrl, appPool } from "./support/database.js";
import { seedTenant, seedUser, seedSession } from "./support/fixtures.js";

describe.skipIf(!adminDatabaseUrl())("persisted session activity", () => {
  test("returns the latest assistant outcome after reopening, without crossing ownership boundaries", async () => {
    const tenantId = await seedTenant();
    const foreignTenant = await seedTenant();
    const userId = await seedUser();
    const otherUser = await seedUser();
    const sessionId = await seedSession(tenantId, userId);
    const otherSession = await seedSession(tenantId, otherUser);
    const messages = new MessageStore(appPool());
    const create = (role: "assistant" | "user", status: "pending" | "completed" | "error") =>
      messages.create({ tenantId, userId, sessionId, role, status, content: "test" });
    const failed = await create("assistant", "error");
    await create("user", "completed");
    await messages.create({ tenantId, userId: otherUser, sessionId: otherSession, role: "assistant", status: "completed", content: "private" });

    const sessions = new SessionStore(appPool());
    expect((await sessions.listPage(tenantId, userId)).sessions).toMatchObject([{
      sessionId, latestTurnId: failed.messageId, latestTurnSequence: failed.id, hasTurnFailed: true
    }]);
    expect((await sessions.listPage(foreignTenant, userId)).sessions).toEqual([]);
    expect((await sessions.listPage(tenantId, otherUser)).sessions).toMatchObject([{ sessionId: otherSession, hasTurnFailed: false }]);
    const retry = await create("assistant", "pending");
    expect(retry.id).toBeGreaterThan(failed.id);
    await messages.updateContent(tenantId, retry.messageId, userId, "completed", "recovered");
    expect((await new SessionStore(appPool()).listPage(tenantId, userId)).sessions).toMatchObject([{
      sessionId, latestTurnId: retry.messageId, latestTurnSequence: retry.id, hasTurnFailed: false
    }]);
  });
});

describe.skipIf(!adminDatabaseUrl())("persisted whole-turn duration", () => {
  test("reloads duration, preserves metadata, and enforces tenant and user ownership", async () => {
    const tenantId = await seedTenant();
    const otherTenant = await seedTenant();
    const userId = await seedUser();
    const otherUser = await seedUser();
    const sessionId = await seedSession(tenantId, userId);
    const messages = new MessageStore(appPool());
    const projectInstructions = { projectId: "project-1", revision: 4, instructions: "Use CAD" };
    const message = await messages.create({ tenantId, userId, sessionId, role: "assistant", status: "pending", content: "", detail: { pii: { status: "scanned" }, projectInstructions } });
    expect(message.durationMs).toBeNull();
    expect(await messages.updateContent(otherTenant, message.messageId, userId, "completed", "wrong tenant", 1)).toBeNull();
    expect(await messages.updateContent(tenantId, message.messageId, otherUser, "completed", "wrong owner", 1)).toBeNull();
    await messages.updateContent(tenantId, message.messageId, userId, "completed", "done", 84000);
    await messages.updateStreamingContent(tenantId, message.messageId, userId, { reasoningContent: "thought" });
    const reloaded = await new MessageStore(appPool()).listBySession(tenantId, sessionId, userId);
    expect(reloaded.messages).toMatchObject([{ status: "completed", content: "done", durationMs: 84000, detail: { pii: { status: "scanned" } } }]);
    expect(reloaded.messages[0].projectInstructions).toEqual(projectInstructions);
    expect((await messages.listBySession(otherTenant, sessionId, userId)).messages).toEqual([]);
    expect((await messages.listBySession(tenantId, sessionId, otherUser)).messages).toEqual([]);
    expect(reloaded.messages[0].detail).not.toHaveProperty("durationMs");
    await messages.updateContent(tenantId, message.messageId, userId, "completed", "edited");
    expect((await messages.listBySession(tenantId, sessionId, userId)).messages[0].durationMs).toBe(84000);
  });
});

describe.skipIf(!adminDatabaseUrl())("detached turn persistence", () => {
  test("saves notices and finalizes a live row without exposing it to another user", async () => {
    const tenantId = await seedTenant();
    const userId = await seedUser();
    const otherUser = await seedUser();
    const sessionId = await seedSession(tenantId, userId);
    const messages = new MessageStore(appPool());
    const row = await messages.create({ tenantId, sessionId, userId, role: "assistant", status: "streaming", content: "partial" });
    const token = `ghp_${"A".repeat(36)}`;

    await messages.setRuntimeNotices(tenantId, row.messageId, otherUser, [{ message: "wrong owner" }]);
    await messages.setRuntimeNotices(tenantId, row.messageId, userId, [{ message: `expired ${token}` }]);
    await messages.upsertToolResult({
      tenantId, messageId: row.messageId, sessionId, userId,
      toolResultId: `tool-${row.messageId}`, kind: "command", title: "execute",
      status: "completed", command: "ls", cwd: null, server: null,
      toolName: "execute", input: "{}", output: "ok", exitCode: 0,
      durationMs: 1, textOffset: 0
    });
    await messages.deleteToolResult(tenantId, row.messageId, otherUser, `tool-${row.messageId}`);
    expect((await messages.listBySession(tenantId, sessionId, userId)).messages[0].toolResults).toHaveLength(1);
    await messages.deleteToolResult(tenantId, row.messageId, userId, `tool-${row.messageId}`);
    expect((await messages.listBySession(tenantId, sessionId, userId)).messages[0].toolResults).toEqual([]);
    await messages.upsertToolResult({
      tenantId, messageId: row.messageId, sessionId, userId,
      toolResultId: `unfinished-${row.messageId}`, kind: "command", title: "execute",
      status: "in_progress", command: "sleep", cwd: null, server: null,
      toolName: "execute", input: "{}", output: "", exitCode: null,
      durationMs: null, textOffset: 0
    });
    await messages.markInterruptedIfActive(tenantId, row.messageId, otherUser);
    expect((await messages.listBySession(tenantId, sessionId, userId)).messages[0]).toMatchObject({
      status: "streaming", detail: { runtimeNotices: [{ message: "expired [REDACTED]" }] }
    });

    await messages.markInterruptedIfActive(tenantId, row.messageId, userId);
    await messages.markInterruptedIfActive(tenantId, row.messageId, userId);
    expect((await messages.listBySession(tenantId, sessionId, userId)).messages[0]).toMatchObject({
      status: "interrupted", content: "partial",
      toolResults: [{ status: "failed" }]
    });
  });
});
