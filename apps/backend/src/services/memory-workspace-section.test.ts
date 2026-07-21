import { test, expect } from "vitest";

import type { MemoryRecord, MemoryStore } from "./memory-store.js";

import {
  buildMemorySectionLines,
  loadWorkspaceMemories,
  WORKSPACE_MEMORY_LIMIT
} from "./memory-workspace-section.js";

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

// buildMemorySectionLines

test("section is omitted entirely when memory tools are not enabled", () => {
  expect(buildMemorySectionLines([record()], ["session_context"])).toEqual([]);
});

test("section advertises only the enabled memory tools", () => {
  const text = buildMemorySectionLines([record()], ["memory_save"]).join("\n");
  expect(text).toContain("## Long-term memory");
  expect(text).toContain("`memory_save`");
  expect(text).not.toContain("`memory_search`");
  expect(text).not.toContain("`memory_delete`");
});

test("memory contents are never rendered without memory_search (write-only posture)", () => {
  const text = buildMemorySectionLines([record()], ["memory_save", "memory_delete"]).join("\n");
  expect(text).not.toContain("Recently saved memories");
  expect(text).not.toContain("prefers-pnpm");
});

test("section documents the tools even with no saved memories", () => {
  const lines = buildMemorySectionLines([], ["memory_search", "memory_save"]);
  const text = lines.join("\n");
  expect(text).toContain("## Long-term memory");
  expect(text).toContain("memory_search");
  expect(text).toContain("memory_save");
  expect(text).not.toContain("Recently saved memories");
});

test("section lists recent memories with single-line excerpts", () => {
  const lines = buildMemorySectionLines(
    [record({ slug: "long-note", content: `line1\nline2 ${"x".repeat(300)}` })],
    ["memory_search"]
  );
  const text = lines.join("\n");
  expect(text).toContain("Recently saved memories:");
  expect(text).toContain("**long-note**: line1 line2");
  expect(text).toContain("…");
  // excerpt collapses newlines — each memory stays on one bullet line
  const bullet = lines.find((line) => line.startsWith("- **long-note**"))!;
  expect(bullet.includes("\n")).toBe(false);
});

// loadWorkspaceMemories

test("loadWorkspaceMemories skips the store unless memory_search is enabled", async () => {
  let called = false;
  const memories = {
    async search() {
      called = true;
      return [record()];
    }
  } as unknown as MemoryStore;

  // No memory tool at all, and write-only (save/delete without search): the
  // read gate must hold in both cases so stored contents never reach the prompt.
  for (const enabledToolIds of [["session_context"], ["memory_save", "memory_delete"]]) {
    const result = await loadWorkspaceMemories(memories, {
      tenantId: "t1",
      userId: "u1",
      enabledToolIds
    });
    expect(result).toEqual([]);
  }
  expect(called).toBe(false);
});

test("loadWorkspaceMemories fetches with the workspace limit when enabled", async () => {
  let seenLimit: number | null = null;
  const memories = {
    async search(_tenantId: string, _userId: string, options: { limit?: number }) {
      seenLimit = options.limit ?? null;
      return [record()];
    }
  } as unknown as MemoryStore;

  const result = await loadWorkspaceMemories(memories, {
    tenantId: "t1",
    userId: "u1",
    enabledToolIds: ["memory_search"]
  });

  expect(result).toHaveLength(1);
  expect(seenLimit).toBe(WORKSPACE_MEMORY_LIMIT);
});

test("loadWorkspaceMemories degrades to empty on store failure", async () => {
  const memories = {
    async search() {
      throw new Error("db down");
    }
  } as unknown as MemoryStore;
  const warnings: unknown[] = [];
  const log = { warn: (...args: unknown[]) => warnings.push(args) };

  const result = await loadWorkspaceMemories(
    memories,
    { tenantId: "t1", userId: "u1", enabledToolIds: ["memory_search"] },
    log as never
  );

  expect(result).toEqual([]);
  expect(warnings).toHaveLength(1);
});

test("loadWorkspaceMemories suppresses injection when a Policy Center rule gates memory_search in enforce mode", async () => {
  let storeCalled = false;
  const memories = {
    async search() {
      storeCalled = true;
      return [record()];
    }
  } as unknown as MemoryStore;
  const seenActions: Array<{ toolName: string; turnContext: string | null }> = [];

  const result = await loadWorkspaceMemories(memories, {
    tenantId: "t1",
    userId: "u1",
    enabledToolIds: ["memory_search"],
    readPolicy: {
      enforcementMode: "enforce",
      policy: {
        async evaluate(_tenantId, action) {
          seenActions.push({ toolName: action.toolName, turnContext: action.turnContext });
          return {
            outcome: "require_approval",
            matchedRuleId: "r1",
            matchedRuleName: "gate memory reads",
            gating: true,
            explanation: null
          };
        }
      }
    }
  });

  expect(result).toEqual([]);
  expect(storeCalled).toBe(false);
  expect(seenActions[0]).toEqual({ toolName: "memory_search", turnContext: "interactive" });
});

test("loadWorkspaceMemories injects when rules allow, and always in monitor mode", async () => {
  const memories = {
    async search() {
      return [record()];
    }
  } as unknown as MemoryStore;

  const allowPolicy = {
    async evaluate() {
      return {
        outcome: "allow" as const,
        matchedRuleId: null,
        matchedRuleName: null,
        gating: false,
        explanation: null
      };
    }
  };
  const gatingPolicy = {
    async evaluate() {
      return {
        outcome: "block" as const,
        matchedRuleId: "r1",
        matchedRuleName: "block",
        gating: true,
        explanation: null
      };
    }
  };

  const allowed = await loadWorkspaceMemories(memories, {
    tenantId: "t1",
    userId: "u1",
    enabledToolIds: ["memory_search"],
    readPolicy: { enforcementMode: "enforce", policy: allowPolicy }
  });
  expect(allowed).toHaveLength(1);

  // Monitor mode records-only at the gateway; injection is likewise not gated.
  const monitored = await loadWorkspaceMemories(memories, {
    tenantId: "t1",
    userId: "u1",
    enabledToolIds: ["memory_search"],
    readPolicy: { enforcementMode: "monitor", policy: gatingPolicy }
  });
  expect(monitored).toHaveLength(1);
});

test("loadWorkspaceMemories returns empty without a store", async () => {
  expect(
    await loadWorkspaceMemories(undefined, {
      tenantId: "t1",
      userId: "u1",
      enabledToolIds: ["memory_search"]
    })
  ).toEqual([]);
});
