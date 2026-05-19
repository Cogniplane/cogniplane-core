import { test, expect } from "vitest";

import type { Pool } from "../lib/db.js";
import { AuditEventStore } from "./audit-event-store.js";

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

test("AuditEventStore.create redacts Bearer tokens inside payload before persisting", async () => {
  const { db, queries } = fakeDatabase();
  const store = new AuditEventStore(db);

  await store.create({
    tenantId: "tenant-1",
    sessionId: "sess-1",
    userId: "user-1",
    type: "tool.failed",
    payload: {
      error: { message: "upstream returned: Authorization: Bearer top-secret-token" }
    }
  });

  const insert = queries.find((q) => q.text.includes("INSERT INTO audit_events"));
  expect(insert).toBeDefined();
  const payloadJson = (insert!.values[5] as string);
  expect(payloadJson).not.toContain("top-secret-token");
  expect(JSON.parse(payloadJson)).toEqual({
    error: { message: "upstream returned: Authorization: Bearer [REDACTED]" }
  });
});

test("AuditEventStore.create redacts secret-keyed fields recursively", async () => {
  const { db, queries } = fakeDatabase();
  const store = new AuditEventStore(db);

  await store.create({
    tenantId: "tenant-1",
    sessionId: null,
    userId: "user-1",
    type: "integration.connected",
    payload: {
      provider: "github",
      headers: { authorization: "Bearer raw-token", "x-trace-id": "trace-123" },
      apiKey: "example-api-key",
      note: "keep this visible"
    }
  });

  const insert = queries.find((q) => q.text.includes("INSERT INTO audit_events"));
  expect(insert).toBeDefined();
  const payload = JSON.parse(insert!.values[5] as string);
  expect(payload).toEqual({
    provider: "github",
    headers: { authorization: "[REDACTED]", "x-trace-id": "trace-123" },
    apiKey: "[REDACTED]",
    note: "keep this visible"
  });
});

test("AuditEventStore.create leaves payloads with no secrets unchanged", async () => {
  const { db, queries } = fakeDatabase();
  const store = new AuditEventStore(db);

  await store.create({
    tenantId: "tenant-1",
    sessionId: "sess-1",
    userId: "user-1",
    type: "session.created",
    payload: { provider: "codex", model: "gpt-5", messageCount: 0 }
  });

  const insert = queries.find((q) => q.text.includes("INSERT INTO audit_events"));
  expect(insert).toBeDefined();
  const payload = JSON.parse(insert!.values[5] as string);
  expect(payload).toEqual({ provider: "codex", model: "gpt-5", messageCount: 0 });
});
