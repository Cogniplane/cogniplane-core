import { expect, it, vi } from "vitest";
import { FakePool } from "../test-helpers/fake-pool.js";
import { SessionStore } from "./session-store.js";

it.each(["archvied", "", null, undefined])("rejects invalid persisted status %s instead of treating the session as active", async (status) => {
  const db = new FakePool().onQuery("FROM sessions", () => ({
    rows: [{ session_id: "session", user_id: "user", session_name: "Research", status,
      created_at: new Date(), updated_at: new Date() }], rowCount: 1
  }));
  await expect(new SessionStore(db.asPool()).getOwned("tenant", "session", "user"))
    .rejects.toThrow("Invalid session status in database");
});

it("removes legacy child rows before the session and retries storage GC after commit", async () => {
  const events: string[] = [];
  let candidatePending = true;
  let storageGcPending = true;
  const db = new FakePool()
    .onQuery(/SELECT tenant_id, session_id, user_id[\s\S]*FROM sessions/, () => {
      if (!candidatePending) return { rows: [], rowCount: 0 };
      candidatePending = false;
      return { rows: [{ tenant_id: "tenant", session_id: "session", user_id: "user" }], rowCount: 1 };
    })
    .onQuery("SELECT DISTINCT storage_key FROM artifacts", () => ({
      rows: [{ storage_key: "artifact-key" }], rowCount: 1,
    }))
    .onQuery("INSERT INTO session_storage_gc", () => ({ rows: [], rowCount: 1 }))
    .onQuery("INSERT INTO session_runtime_gc", () => ({ rows: [], rowCount: 1 }))
    .onQuery("DELETE FROM messages", () => { events.push("messages"); return { rows: [], rowCount: 1 }; })
    .onQuery("DELETE FROM runtime_sessions", () => { events.push("runtime_sessions"); return { rows: [], rowCount: 1 }; })
    .onQuery("DELETE FROM session_executions", () => { events.push("session_executions"); return { rows: [], rowCount: 1 }; })
    .onQuery("DELETE FROM sessions", () => { events.push("session"); return { rows: [], rowCount: 1 }; })
    .onQuery(/SELECT tenant_id, session_id, storage_key[\s\S]*FROM session_storage_gc/, () => storageGcPending
      ? { rows: [{ tenant_id: "tenant", session_id: "session", storage_key: "artifact-key" }], rowCount: 1 }
      : { rows: [], rowCount: 0 })
    .onQuery(/SELECT tenant_id, session_id, user_id[\s\S]*FROM session_runtime_gc/, () => ({
      rows: [{ tenant_id: "tenant", session_id: "session", user_id: "user" }], rowCount: 1,
    }))
    .onQuery("DELETE FROM session_storage_gc", () => { events.push("storage_gc_remove"); storageGcPending = false; return { rows: [], rowCount: 1 }; })
    .onQuery(/^\s*SELECT 1 FROM project_file_versions/, () => ({ rows: [], rowCount: 0 }))
    .onQuery("UPDATE session_storage_gc", () => ({ rows: [], rowCount: 1 }))
    .onQuery("DELETE FROM session_runtime_gc", () => ({ rows: [], rowCount: 1 }))
    .onQuery("UPDATE session_runtime_gc", () => ({ rows: [], rowCount: 1 }));

  let failStorage = true;
  const storage = { delete: vi.fn(async () => {
    events.push("storage");
    if (failStorage) {
      failStorage = false;
      throw new Error("temporary storage outage");
    }
  }) };
  const purgeRuntime = vi.fn(async () => { events.push("runtime_purge"); });
  const store = new SessionStore(db.asPool(), db.asPool(), { retentionDays: 0 });

  await expect(store.cleanupExpired(storage, { batchSize: 1, purgeRuntime }))
    .resolves.toEqual({ deletedSessions: 1, deletedObjects: 0, purgedRuntimes: 1 });
  expect(events.indexOf("messages")).toBeLessThan(events.indexOf("session"));
  expect(events.indexOf("runtime_sessions")).toBeLessThan(events.indexOf("session"));
  expect(events.indexOf("session")).toBeLessThan(events.indexOf("storage"));

  await expect(store.cleanupExpired(storage, { batchSize: 1, purgeRuntime }))
    .resolves.toEqual({ deletedSessions: 0, deletedObjects: 1, purgedRuntimes: 1 });
  expect(events).toEqual(["messages", "runtime_sessions", "session_executions", "session", "storage", "runtime_purge", "storage", "storage_gc_remove", "runtime_purge"]);
  expect(storage.delete).toHaveBeenCalledTimes(2);
});

it("does not offer restoration when the configured retention window is zero", async () => {
  const db = new FakePool();
  const store = new SessionStore(db.asPool(), db.asPool(), { retentionDays: 0 });

  await expect(store.restoreDeleted("tenant", "session", "user")).resolves.toBeNull();
  expect(db.queries.some(({ text }) => text.includes("FROM sessions"))).toBe(false);
});
