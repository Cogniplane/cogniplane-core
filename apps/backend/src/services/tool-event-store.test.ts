import { test, expect } from "vitest";

import type { Pool } from "../lib/db.js";
import { ToolEventStore } from "./tool-event-store.js";

type CapturedQuery = { text: string; values: unknown[] };

function fakeDatabase(): { db: Pool; queries: CapturedQuery[] } {
  const queries: CapturedQuery[] = [];
  const client = {
    async query(text: string, values: unknown[] = []) {
      queries.push({ text, values });
      return { rows: [], rowCount: 0 };
    },
    release() {}
  };
  const db = {
    async connect() {
      return client;
    }
  } as unknown as Pool;
  return { db, queries };
}

test("ToolEventStore.create redacts Bearer tokens inside payload before persisting", async () => {
  const { db, queries } = fakeDatabase();
  const store = new ToolEventStore(db);

  await store.create({
    tenantId: "tenant-1",
    sessionId: "sess-1",
    userId: "user-1",
    messageId: "msg-1",
    runtimeId: "rt-1",
    toolCallId: "tc-1",
    kind: "managed",
    title: "github_create_issue",
    phase: "failed",
    status: "error",
    durationMs: 42,
    payload: {
      output: "curl https://api.github.com/repos failed: Authorization: Bearer ghp_abcdef123"
    }
  });

  const insert = queries.find((q) => q.text.includes("INSERT INTO tool_events"));
  expect(insert).toBeDefined();
  const payloadJson = insert!.values[11] as string;
  expect(payloadJson).not.toContain("ghp_abcdef123");
  expect(payloadJson).not.toContain("ghp_");
  expect(JSON.parse(payloadJson)).toEqual({
    output: "curl https://api.github.com/repos failed: Authorization: Bearer [REDACTED]"
  });
});

test("ToolEventStore.create redacts secret-keyed nested fields", async () => {
  const { db, queries } = fakeDatabase();
  const store = new ToolEventStore(db);

  await store.create({
    tenantId: "tenant-1",
    sessionId: "sess-1",
    userId: "user-1",
    messageId: "msg-1",
    runtimeId: "rt-1",
    toolCallId: "tc-1",
    kind: "proxy",
    title: "upstream",
    phase: "completed",
    status: "ok",
    durationMs: 100,
    payload: {
      request: { headers: { authorization: "Bearer xyz" } },
      response: { ok: true }
    }
  });

  const insert = queries.find((q) => q.text.includes("INSERT INTO tool_events"));
  expect(insert).toBeDefined();
  const payload = JSON.parse(insert!.values[11] as string);
  expect(payload).toEqual({
    request: { headers: { authorization: "[REDACTED]" } },
    response: { ok: true }
  });
});

test("ToolEventStore.create leaves non-secret payloads unchanged", async () => {
  const { db, queries } = fakeDatabase();
  const store = new ToolEventStore(db);

  await store.create({
    tenantId: "tenant-1",
    sessionId: "sess-1",
    userId: "user-1",
    messageId: "msg-1",
    runtimeId: "rt-1",
    toolCallId: "tc-1",
    kind: "managed",
    title: "session_context",
    phase: "completed",
    status: "ok",
    durationMs: 12,
    payload: { result: { sessionId: "sess-1", messageCount: 3 } }
  });

  const insert = queries.find((q) => q.text.includes("INSERT INTO tool_events"));
  expect(insert).toBeDefined();
  const payload = JSON.parse(insert!.values[11] as string);
  expect(payload).toEqual({ result: { sessionId: "sess-1", messageCount: 3 } });
});
