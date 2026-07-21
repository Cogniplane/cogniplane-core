import { test, expect } from "vitest";

import type { MemoryRecord, MemoryStore } from "../memory-store.js";
import type { ToolExecutionContext } from "../auth/tool-execution-context-store.js";

import { createMemoryTools, MEMORY_TOOL_CATALOG } from "./memory-tools.js";

function ctx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    toolContextId: "ctx-1",
    tenantId: "t1",
    sessionId: "s1",
    userId: "u1",
    runtimeId: "rt1",
    runtimePolicyId: "default",
    messageId: null,
    credentialEnvelope: {},
    metadata: {},
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    memoryId: "m1",
    userId: "u1",
    slug: "prefers-pnpm",
    content: "User prefers pnpm.",
    metadata: {},
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    ...overrides
  };
}

type FakeMemories = Pick<MemoryStore, "search" | "save" | "remove"> & {
  calls: Array<{ method: string; args: unknown[] }>;
};

function makeFakeMemories(overrides: Partial<Pick<MemoryStore, "search" | "save" | "remove">> = {}): FakeMemories {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    async search(...args) {
      calls.push({ method: "search", args });
      return [record()];
    },
    async save(tenantId, userId, input) {
      calls.push({ method: "save", args: [tenantId, userId, input] });
      return record({ slug: input.slug, content: input.content, metadata: input.metadata ?? {} });
    },
    async remove(...args) {
      calls.push({ method: "remove", args });
      return true;
    },
    ...overrides
  };
}

function findTool(memories: FakeMemories, name: string) {
  return createMemoryTools({ memories: memories as unknown as MemoryStore }).find(
    (tool) => tool.name === name
  )!;
}

// catalog metadata

test("catalog marks memory_search read-only and the write tools not", () => {
  const byName = new Map(MEMORY_TOOL_CATALOG.map((entry) => [entry.name, entry]));
  expect(byName.get("memory_search")?.readOnly).toBe(true);
  expect(byName.get("memory_save")?.readOnly).toBe(false);
  expect(byName.get("memory_delete")?.readOnly).toBe(false);
});

// memory_search

test("memory_search scopes to the context tenant/user and maps records", async () => {
  const memories = makeFakeMemories();
  const tool = findTool(memories, "memory_search");

  const result = await tool.handler({
    context: ctx(),
    arguments: { toolContextId: "ctx-1", query: "pnpm", limit: 5 }
  });

  expect(memories.calls).toEqual([
    { method: "search", args: ["t1", "u1", { query: "pnpm", limit: 5 }] }
  ]);
  expect(result).toEqual({
    memories: [
      {
        name: "prefers-pnpm",
        content: "User prefers pnpm.",
        metadata: {},
        updatedAt: "2026-07-02T00:00:00.000Z"
      }
    ]
  });
});

test("memory_search works without a query (recent listing)", async () => {
  const memories = makeFakeMemories();
  const tool = findTool(memories, "memory_search");

  await tool.handler({ context: ctx(), arguments: { toolContextId: "ctx-1" } });

  expect(memories.calls[0].args[2]).toEqual({ query: undefined, limit: undefined });
});

// memory_save

test("memory_save persists via the store and returns the saved record", async () => {
  const memories = makeFakeMemories();
  const tool = findTool(memories, "memory_save");

  const result = await tool.handler({
    context: ctx(),
    arguments: {
      toolContextId: "ctx-1",
      name: "team-standup-time",
      content: "Standup is at 9:30 EST.",
      metadata: { source: "chat" }
    }
  });

  expect(memories.calls).toEqual([
    {
      method: "save",
      args: [
        "t1",
        "u1",
        { slug: "team-standup-time", content: "Standup is at 9:30 EST.", metadata: { source: "chat" } }
      ]
    }
  ]);
  expect((result.saved as { name: string }).name).toBe("team-standup-time");
});

test("memory_save requires a name", async () => {
  const memories = makeFakeMemories();
  const tool = findTool(memories, "memory_save");

  await expect(
    tool.handler({ context: ctx(), arguments: { toolContextId: "ctx-1", name: "  ", content: "x" } })
  ).rejects.toThrow(/name is required/i);
  expect(memories.calls).toHaveLength(0);
});

test("memory_save ignores non-object metadata", async () => {
  const memories = makeFakeMemories();
  const tool = findTool(memories, "memory_save");

  await tool.handler({
    context: ctx(),
    arguments: { toolContextId: "ctx-1", name: "n", content: "c", metadata: ["not", "an", "object"] }
  });

  expect((memories.calls[0].args[2] as { metadata?: unknown }).metadata).toBeUndefined();
});

// memory_delete

test("memory_delete removes by name and reports the outcome", async () => {
  const memories = makeFakeMemories({
    async remove() {
      return false;
    }
  });
  const tool = findTool(memories, "memory_delete");

  const result = await tool.handler({
    context: ctx(),
    arguments: { toolContextId: "ctx-1", name: "gone" }
  });

  expect(result).toEqual({ deleted: false, name: "gone" });
});

test("memory_delete requires a name", async () => {
  const memories = makeFakeMemories();
  const tool = findTool(memories, "memory_delete");

  await expect(
    tool.handler({ context: ctx(), arguments: { toolContextId: "ctx-1" } })
  ).rejects.toThrow(/name is required/i);
});
