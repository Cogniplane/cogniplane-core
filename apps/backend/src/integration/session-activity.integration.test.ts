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
    expect(await sessions.list(tenantId, userId)).toMatchObject([{
      sessionId, latestTurnId: failed.messageId, latestTurnSequence: failed.id, hasTurnFailed: true
    }]);
    expect(await sessions.list(foreignTenant, userId)).toEqual([]);
    expect(await sessions.list(tenantId, otherUser)).toMatchObject([{ sessionId: otherSession, hasTurnFailed: false }]);
    const retry = await create("assistant", "pending");
    expect(retry.id).toBeGreaterThan(failed.id);
    await messages.updateContent(tenantId, retry.messageId, userId, "completed", "recovered");
    expect(await new SessionStore(appPool()).list(tenantId, userId)).toMatchObject([{
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
