import { test, expect } from "vitest";

import type { Pool } from "../lib/db.js";

import {
  MAX_MEMORY_CONTENT_LENGTH,
  MAX_MEMORY_SEARCH_LIMIT,
  MemoryConflictError,
  MemoryNotFoundError,
  MemoryStore,
  memoryContentSha256,
  type AgentApprovedProvenance
} from "./memory-store.js";

const provenance: AgentApprovedProvenance = {
  sourceSessionId: "session-1",
  approvedByUserId: "u1",
  approvalId: "polapr_1",
  approvedAt: "2026-07-03T00:00:00.000Z"
};

class CaptureMemoryDatabase {
  lastText: string | null = null;
  lastValues: unknown[] | null = null;
  nextRows: Record<string, unknown>[] = [];
  nextRowCount = 0;
  /** Results for the next statements, in order. Once empty, `nextRows` answers. */
  script: Array<{ rows: Record<string, unknown>[]; rowCount?: number }> = [];
  statements: string[] = [];

  async connect() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      async query(text: string, values: unknown[] = []) {
        return self._query(text, values);
      },
      async release() {}
    };
  }

  _query(text: string, values: unknown[] = []) {
    if (
      text === "BEGIN" ||
      text === "COMMIT" ||
      text === "ROLLBACK" ||
      text.startsWith("SELECT set_config")
    ) {
      return { rows: [], rowCount: 0 };
    }
    this.lastText = text;
    this.lastValues = values;
    this.statements.push(text);
    const scripted = this.script.shift();
    if (scripted) return { rows: scripted.rows, rowCount: scripted.rowCount ?? scripted.rows.length };
    return { rows: this.nextRows, rowCount: this.nextRowCount };
  }
}

function memoryRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    memory_id: "m1",
    user_id: "u1",
    slug: "prefers-pnpm",
    content: "User prefers pnpm.",
    metadata: { source: "chat" },
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-02T00:00:00.000Z",
    version: 1,
    provenance: "agent_approved",
    source_session_id: "session-1",
    approved_at: "2026-07-03T00:00:00.000Z",
    ...overrides
  };
}

function makeStore() {
  const db = new CaptureMemoryDatabase();
  return { db, store: new MemoryStore(db as unknown as Pool) };
}

// save

test("save upserts by (tenant, user, slug) and maps the returned row", async () => {
  const { db, store } = makeStore();
  db.nextRows = [memoryRow()];

  const saved = await store.save("t1", "u1", {
    slug: "prefers-pnpm",
    content: "User prefers pnpm.",
    metadata: { source: "chat" },
    provenance
  });

  expect(db.lastText).toContain("INSERT INTO agent_memories");
  expect(db.lastText).toContain("ON CONFLICT (tenant_id, user_id, slug) DO UPDATE");
  expect(db.lastValues?.slice(1, 5)).toEqual(["t1", "u1", "prefers-pnpm", "User prefers pnpm."]);
  // The server's proof of approval is written with the row.
  expect(db.lastValues?.slice(6)).toEqual(["session-1", "u1", "polapr_1", "2026-07-03T00:00:00.000Z"]);
  expect(saved.slug).toBe("prefers-pnpm");
  expect(saved.metadata).toEqual({ source: "chat" });
  expect(saved.updatedAt).toBe("2026-07-02T00:00:00.000Z");
  expect(saved).toMatchObject({ version: 1, provenance: "agent_approved", sourceSessionId: "session-1" });
});

test("rows from before provenance was recorded read back as unverified", async () => {
  const { db, store } = makeStore();
  db.nextRows = [memoryRow({ provenance: "unverified", source_session_id: null, approved_at: null })];

  const [memory] = await store.search("t1", "u1");

  expect(memory).toMatchObject({ provenance: "unverified", sourceSessionId: null, approvedAt: null });
});

test("save without a check runs one upsert", async () => {
  const { db, store } = makeStore();
  db.nextRows = [memoryRow()];

  await store.save("t1", "u1", { slug: "prefers-pnpm", content: "Text.", provenance });

  expect(db.statements).toHaveLength(1);
});

test("a save that expects no earlier memory conflicts when one exists", async () => {
  const { db, store } = makeStore();
  db.script = [{ rows: [] }]; // INSERT ... ON CONFLICT DO NOTHING inserted nothing

  await expect(
    store.save("t1", "u1", { slug: "prefers-pnpm", content: "Text.", provenance, expectedPreviousContentSha256: null })
  ).rejects.toBeInstanceOf(MemoryConflictError);
});

test("a save that expects an earlier text conflicts when the stored text differs or is gone", async () => {
  const { db, store } = makeStore();
  const input = {
    slug: "prefers-pnpm", content: "New.", provenance,
    expectedPreviousContentSha256: memoryContentSha256("Approved old text.")
  };

  db.script = [{ rows: [{ content: "Edited since the approval." }] }];
  await expect(store.save("t1", "u1", input)).rejects.toBeInstanceOf(MemoryConflictError);
  // The conflict is raised before any write.
  expect(db.statements).toHaveLength(1);

  db.script = [{ rows: [] }];
  await expect(store.save("t1", "u1", input)).rejects.toBeInstanceOf(MemoryConflictError);
});

test("a save that expects an earlier text writes only when the stored text is that text", async () => {
  const { db, store } = makeStore();
  db.statements = [];
  db.script = [{ rows: [{ content: "Approved old text." }] }, { rows: [memoryRow({ version: 2 })] }];

  const saved = await store.save("t1", "u1", {
    slug: "prefers-pnpm", content: "New.", provenance,
    expectedPreviousContentSha256: memoryContentSha256("Approved old text.")
  });

  expect(db.statements).toHaveLength(2);
  expect(db.statements[0]).toContain("FOR UPDATE");
  expect(saved.version).toBe(2);
});

test("save rejects invalid slugs", async () => {
  const { store } = makeStore();
  for (const slug of ["", "Has-Upper", "../escape", "a".repeat(200), "-starts-with-dash"]) {
    await expect(store.save("t1", "u1", { slug, content: "x", provenance })).rejects.toThrow(/slug/i);
  }
});

test("save rejects empty and oversized content", async () => {
  const { store } = makeStore();
  await expect(store.save("t1", "u1", { slug: "ok", content: "   ", provenance })).rejects.toThrow(/empty/i);
  await expect(
    store.save("t1", "u1", { slug: "ok", content: "x".repeat(MAX_MEMORY_CONTENT_LENGTH + 1), provenance })
  ).rejects.toThrow(/exceeds/i);
});

// list / updateByUser

test("list returns the most recent memories with the full count", async () => {
  const { db, store } = makeStore();
  db.script = [{ rows: [memoryRow(), memoryRow({ slug: "units" })] }, { rows: [{ total: 7 }] }];

  const result = await store.list("t1", "u1");

  expect(result.memories.map((memory) => memory.slug)).toEqual(["prefers-pnpm", "units"]);
  expect(result.total).toBe(7);
  expect(db.statements[0]).toContain("LIMIT $3");
});

test("an edit records the user as author and returns the new version", async () => {
  const { db, store } = makeStore();
  db.nextRows = [memoryRow({ content: "Edited.", provenance: "user_authored", source_session_id: null, version: 2 })];

  const updated = await store.updateByUser("t1", "u1", "m1", { content: "Edited.", expectedVersion: 1 });

  expect(db.lastValues).toEqual(["t1", "u1", "m1", "Edited.", 1]);
  expect(updated).toMatchObject({ provenance: "user_authored", version: 2, sourceSessionId: null });
});

test("an edit of a changed memory conflicts and an edit of a missing one is not found", async () => {
  const { db, store } = makeStore();
  const edit = () => store.updateByUser("t1", "u1", "m1", { content: "Edited.", expectedVersion: 1 });

  db.script = [{ rows: [] }, { rows: [{ slug: "prefers-pnpm" }] }]; // no row at that version, but the memory exists
  await expect(edit()).rejects.toBeInstanceOf(MemoryConflictError);

  db.script = [{ rows: [] }, { rows: [] }];
  await expect(edit()).rejects.toBeInstanceOf(MemoryNotFoundError);
});

test("an edit rejects empty and oversized text before it writes", async () => {
  const { db, store } = makeStore();
  await expect(store.updateByUser("t1", "u1", "ok", { content: " ", expectedVersion: 1 })).rejects.toThrow(/empty/i);
  await expect(
    store.updateByUser("t1", "u1", "ok", { content: "x".repeat(MAX_MEMORY_CONTENT_LENGTH + 1), expectedVersion: 1 })
  ).rejects.toThrow(/exceeds/i);
  expect(db.statements).toHaveLength(0);
});

// search

test("search escapes ILIKE wildcards and passes the pattern once", async () => {
  const { db, store } = makeStore();
  db.nextRows = [memoryRow()];

  const results = await store.search("t1", "u1", { query: "100%_done\\now" });

  expect(db.lastText).toContain("ILIKE");
  expect(db.lastValues?.[2]).toBe("%100\\%\\_done\\\\now%");
  expect(results).toHaveLength(1);
  expect(results[0].slug).toBe("prefers-pnpm");
});

test("search without a query lists recent memories and clamps the limit", async () => {
  const { db, store } = makeStore();
  db.nextRows = [];

  await store.search("t1", "u1", { limit: 10_000 });

  expect(db.lastText).not.toContain("ILIKE");
  expect(db.lastValues).toEqual(["t1", "u1", MAX_MEMORY_SEARCH_LIMIT]);
});

test("search floors fractional limits and defaults NaN — LIMIT binds must be integers", async () => {
  const { db, store } = makeStore();
  db.nextRows = [];

  await store.search("t1", "u1", { limit: 2.5 });
  expect(db.lastValues?.[2]).toBe(2);

  await store.search("t1", "u1", { limit: Number.NaN });
  expect(db.lastValues?.[2]).toBe(10);
});

// remove

test("a user's delete by id returns the name of the removed memory, or null", async () => {
  const { db, store } = makeStore();

  db.nextRows = [{ slug: "prefers-pnpm" }];
  expect(await store.removeById("t1", "u1", "m1")).toEqual({ slug: "prefers-pnpm" });
  expect(db.lastValues).toEqual(["t1", "u1", "m1"]);

  db.nextRows = [];
  expect(await store.removeById("t1", "u1", "gone")).toBeNull();
});

test("remove returns true only when a row was deleted", async () => {
  const { db, store } = makeStore();

  db.nextRowCount = 1;
  expect(await store.remove("t1", "u1", "prefers-pnpm")).toBe(true);
  expect(db.lastText).toContain("DELETE FROM agent_memories");
  expect(db.lastValues).toEqual(["t1", "u1", "prefers-pnpm"]);

  db.nextRowCount = 0;
  expect(await store.remove("t1", "u1", "missing")).toBe(false);
});
