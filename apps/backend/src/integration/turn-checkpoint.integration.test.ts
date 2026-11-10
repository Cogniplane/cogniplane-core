import { EventType, type BaseEvent } from "@ag-ui/client";
import { describe, expect, test } from "vitest";

import { MessageStore } from "../services/message-store.js";
import {
  streamAssistantReplyAGUI,
  type StreamAssistantReplyAGUIInput
} from "../services/sse-stream-writer-agui.js";
import { adminDatabaseUrl, appPool } from "./support/database.js";
import { seedSession, seedTenant, seedUser } from "./support/fixtures.js";

// A mid-turn checkpoint writes "streaming" and the text it had when it started.
// The turn waits for it only for a short time before it writes the final
// status. A checkpoint that the database applies after that final write must
// not change the row.

async function seedOwner() {
  const tenantId = await seedTenant();
  const userId = await seedUser();
  const sessionId = await seedSession(tenantId, userId);
  const messages = new MessageStore(appPool());
  const saved = async (messageId: string) =>
    (await messages.listBySession(tenantId, sessionId, userId)).messages.find((row) => row.messageId === messageId);
  return { tenantId, userId, sessionId, messages, saved };
}

async function seedTurn() {
  const owner = await seedOwner();
  const { tenantId, userId, sessionId, messages } = owner;
  const { messageId } = await messages.create({
    tenantId, sessionId, userId, role: "assistant", status: "pending", content: ""
  });
  return { ...owner, messageId, saved: () => owner.saved(messageId) };
}

describe.skipIf(!adminDatabaseUrl())("late mid-turn checkpoint", () => {
  test.each([
    ["completed", undefined],
    ["error", undefined],
    ["interrupted", "security_change"]
  ] as const)("does not replace a %s row", async (status, stopReason) => {
    const { tenantId, userId, messages, messageId, saved } = await seedTurn();
    await messages.updateContent(tenantId, messageId, userId, "streaming", "first half");
    await messages.updateContent(
      tenantId, messageId, userId, status, "first half second half", 4200, ...(stopReason ? [stopReason] as const : []));

    expect(await messages.updateContent(tenantId, messageId, userId, "streaming", "first half")).toBeNull();
    expect(await saved()).toMatchObject({
      status, content: "first half second half", durationMs: 4200, stopReason: stopReason ?? null
    });
  });

  test("updates an active row only for its owner, and stops after a shutdown marks it interrupted", async () => {
    const { tenantId, userId, messages, messageId, saved } = await seedTurn();
    const otherTenant = await seedTenant();
    const otherUser = await seedUser();
    const token = `ghp_${"A".repeat(36)}`;

    expect(await messages.updateContent(tenantId, messageId, userId, "streaming", `key ${token}`))
      .toMatchObject({ status: "streaming", content: "key [REDACTED]" });
    expect(await messages.updateContent(tenantId, messageId, userId, "streaming", "longer text"))
      .toMatchObject({ status: "streaming", content: "longer text" });
    expect(await messages.updateContent(otherTenant, messageId, userId, "streaming", "foreign")).toBeNull();
    expect(await messages.updateContent(tenantId, messageId, otherUser, "streaming", "foreign")).toBeNull();
    expect(await saved()).toMatchObject({ status: "streaming", content: "longer text", durationMs: null });

    // Shutdown marks the live row interrupted. A checkpoint after it cannot make
    // the row look live again, but the turn's own final write still lands.
    await messages.markInterruptedIfActive(tenantId, messageId, userId);
    expect(await messages.updateContent(tenantId, messageId, userId, "streaming", "longer text")).toBeNull();
    expect(await saved()).toMatchObject({ status: "interrupted", content: "longer text" });
    expect(await messages.updateContent(tenantId, messageId, userId, "completed", "final text", 900))
      .toMatchObject({ status: "completed", content: "final text", durationMs: 900 });
  });

  test("a checkpoint that outlives the turn's drain deadline leaves the saved turn complete", async () => {
    const { tenantId, userId, sessionId, messages, saved } = await seedOwner();
    let messageId = "";
    let checkpointStarted!: () => void;
    const started = new Promise<void>((resolve) => { checkpointStarted = resolve; });
    let openCheckpoint!: () => void;
    const gate = new Promise<void>((resolve) => { openCheckpoint = resolve; });
    let lateCheckpoint: ReturnType<MessageStore["updateContent"]> | undefined;
    const store = Object.assign(Object.create(messages) as MessageStore, {
      updateContent: (...args: Parameters<MessageStore["updateContent"]>) => {
        if (args[3] !== "streaming" || lateCheckpoint) return messages.updateContent(...args);
        // The first checkpoint waits, like a stalled connection, until the turn has ended.
        lateCheckpoint = gate.then(() => messages.updateContent(...args));
        checkpointStarted();
        return lateCheckpoint;
      }
    });
    const writes: string[] = [];
    let ended = false;

    let turn: Promise<void> | undefined;
    try {
      turn = streamAssistantReplyAGUI({
        reply: {
          raw: {
            write: (chunk: string) => { writes.push(chunk); return true; },
            end: () => { ended = true; },
            get writableEnded() { return ended; }
          }
        } as unknown as StreamAssistantReplyAGUIInput["reply"],
        messages: store,
        toolContexts: { create: async () => ({ toolContextId: "ctx-1" }) } as never,
        runtimeAdapter: {
          createSession: async () => ({ sessionId, runtimeId: "runtime-1", runtimePolicy: { id: "default" } }) as never,
          async *runMessageAGUI() {
            yield { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant" } as BaseEvent;
            yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "first half " } as BaseEvent;
            await started;
            yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "second half" } as BaseEvent;
            yield { type: EventType.RUN_FINISHED, threadId: sessionId, runId: "run-1" } as BaseEvent;
          }
        },
        tenantId,
        sessionId,
        userId,
        modelName: "zai/glm-4.7",
        prompt: "hi",
        ownerSecurityVersion: null,
        onTurnCreated: (created) => { messageId = created.messageId; },
        streamingPersistIntervalMs: 5,
        checkpointDrainDeadlineMs: 20
      });
      await turn;
      expect(writes.join("")).toContain('"type":"RUN_FINISHED"');
      const finished = await saved(messageId);
      expect(finished).toMatchObject({ status: "completed", content: "first half second half" });
      expect(finished?.durationMs).toEqual(expect.any(Number));

      openCheckpoint();
      // The stalled checkpoint reached the database and changed no row.
      expect(await lateCheckpoint).toBeNull();
      expect(await saved(messageId)).toMatchObject({
        status: "completed", content: "first half second half", durationMs: finished?.durationMs
      });
    } finally {
      openCheckpoint();
      await Promise.allSettled([turn, lateCheckpoint]);
    }
  });
});
