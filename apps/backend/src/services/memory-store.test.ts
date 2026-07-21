import { test, expect } from "vitest";

import type { Pool } from "../lib/db.js";

import {
  MAX_MEMORY_CONTENT_LENGTH,
  MAX_MEMORY_SEARCH_LIMIT,
  MemoryStore
} from "./memory-store.js";

class CaptureMemoryDatabase {
  lastText: string | null = null;
  lastValues: unknown[] | null = null;
  nextRows: Record<string, unknown>[] = [];
  nextRowCount = 0;

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
    metadata: { source: "chat" }
  });

  expect(db.lastText).toContain("INSERT INTO agent_memories");
  expect(db.lastText).toContain("ON CONFLICT (tenant_id, user_id, slug) DO UPDATE");
  expect(db.lastValues?.slice(1, 5)).toEqual(["t1", "u1", "prefers-pnpm", "User prefers pnpm."]);
  expect(saved.slug).toBe("prefers-pnpm");
  expect(saved.metadata).toEqual({ source: "chat" });
  expect(saved.updatedAt).toBe("2026-07-02T00:00:00.000Z");
});

test("save rejects invalid slugs", async () => {
  const { store } = makeStore();
  for (const slug of ["", "Has-Upper", "../escape", "a".repeat(200), "-starts-with-dash"]) {
    await expect(store.save("t1", "u1", { slug, content: "x" })).rejects.toThrow(/slug/i);
  }
});

test("save rejects empty and oversized content", async () => {
  const { store } = makeStore();
  await expect(store.save("t1", "u1", { slug: "ok", content: "   " })).rejects.toThrow(/empty/i);
  await expect(
    store.save("t1", "u1", { slug: "ok", content: "x".repeat(MAX_MEMORY_CONTENT_LENGTH + 1) })
  ).rejects.toThrow(/exceeds/i);
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

test("remove returns true only when a row was deleted", async () => {
  const { db, store } = makeStore();

  db.nextRowCount = 1;
  expect(await store.remove("t1", "u1", "prefers-pnpm")).toBe(true);
  expect(db.lastText).toContain("DELETE FROM agent_memories");
  expect(db.lastValues).toEqual(["t1", "u1", "prefers-pnpm"]);

  db.nextRowCount = 0;
  expect(await store.remove("t1", "u1", "missing")).toBe(false);
});
