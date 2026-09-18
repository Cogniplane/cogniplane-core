import { test, expect, it } from "vitest";

import type { Pool } from "../lib/db.js";
import { FakePool } from "../test-helpers/fake-pool.js";
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
    type: "scheduler.job.run.failed",
    payload: {
      error: { message: "upstream returned: Authorization: Bearer top-secret-token" }
    }
  });

  const insert = queries.find((q) => q.text.includes("INSERT INTO audit_events"));
  expect(insert).toBeDefined();
  const payloadJson = insert!.values[5] as string;
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
    type: "user.github.connected",
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
    type: "scheduler.job.run.completed",
    payload: { provider: "deep-agents", model: "deepagents/claude-sonnet-5", messageCount: 0 }
  });

  const insert = queries.find((q) => q.text.includes("INSERT INTO audit_events"));
  expect(insert).toBeDefined();
  const payload = JSON.parse(insert!.values[5] as string);
  expect(payload).toEqual({ provider: "deep-agents", model: "deepagents/claude-sonnet-5", messageCount: 0 });
});

it("scopes project activity to allowlisted lifecycle events and omits payloads", async () => {
  let values: unknown[] = [];
  const db = new FakePool().onQuery("FROM audit_events", (_text, queryValues) => {
    values = queryValues;
    return {
      rows: [{
        id: "event-1",
        event_type: "project_member_changed",
        user_id: "user-1",
        created_at: new Date("2026-01-01T00:00:00.000Z"),
        payload: { secret: "must not leave this store" },
      }],
      rowCount: 1,
    };
  });

  const activity = await new AuditEventStore(db.asPool()).listProjectActivity("tenant-1", "project-1", 10);

  expect(activity).toEqual([{
    eventId: "event-1",
    type: "project_member_changed",
    userId: "user-1",
    createdAt: "2026-01-01T00:00:00.000Z",
  }]);
  expect(values[0]).toBe("tenant-1");
  expect(values[1]).toBe("project-1");
  expect(values[2]).toContain("project_member_changed");
  expect(values[2]).not.toContain("admin.policy_rule.updated");
});
