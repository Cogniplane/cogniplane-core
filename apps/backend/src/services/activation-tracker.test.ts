import { test, expect } from "vitest";

import type { Pool } from "../lib/db.js";
import { ActivationTracker } from "./activation-tracker.js";

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

test("ActivationTracker.recordEvents inserts a single multi-row insert", async () => {
  const { db, queries } = fakeDatabase();
  const tracker = new ActivationTracker(db);

  await tracker.recordEvents(
    { tenantId: "tenant-1", sessionId: "sess-1", messageId: "msg-1" },
    [
      { resourceType: "skill", resourceId: "skill-improver", eventType: "materialized" },
      { resourceType: "mcp_server", resourceId: "managed-session-context", eventType: "invoked", metadata: { toolId: "session_context" } }
    ]
  );

  // BEGIN, set_config, INSERT, COMMIT
  const inserts = queries.filter((q) => q.text.includes("INSERT INTO resource_activations"));
  expect(inserts.length).toBe(1);
  const [tenantId, sessionId, messageId, resourceTypes, resourceIds, eventTypes, metadatas] = inserts[0]
    .values as [string, string, string | null, string[], string[], string[], string[]];
  expect(tenantId).toBe("tenant-1");
  expect(sessionId).toBe("sess-1");
  expect(messageId).toBe("msg-1");
  expect(resourceTypes).toEqual(["skill", "mcp_server"]);
  expect(resourceIds).toEqual(["skill-improver", "managed-session-context"]);
  expect(eventTypes).toEqual(["materialized", "invoked"]);
  expect(JSON.parse(metadatas[0])).toEqual({});
  expect(JSON.parse(metadatas[1])).toEqual({ toolId: "session_context" });
});

test("ActivationTracker.recordFailure redacts Bearer tokens in error metadata before persisting", async () => {
  const { db, queries } = fakeDatabase();
  const tracker = new ActivationTracker(db);

  await tracker.recordFailure(
    { tenantId: "tenant-1", sessionId: "sess-1" },
    "mcp_server",
    "managed-github",
    {
      message: "upstream 401: Authorization: Bearer ghp_leaked_token_123",
      code: -32000,
      toolName: "github_create_issue"
    }
  );

  const inserts = queries.filter((q) => q.text.includes("INSERT INTO resource_activations"));
  expect(inserts.length).toBe(1);
  const metadatas = inserts[0].values[6] as string[];
  expect(metadatas[0]).not.toContain("ghp_leaked_token_123");
  expect(JSON.parse(metadatas[0])).toEqual({
    error: {
      message: "upstream 401: Authorization: Bearer [REDACTED]",
      code: -32000,
      toolName: "github_create_issue"
    }
  });
});

test("ActivationTracker is best-effort: a DB error is swallowed and logged", async () => {
  const failingDb = {
    async connect() {
      throw new Error("connection refused");
    }
  } as unknown as Pool;
  const warnings: string[] = [];
  const tracker = new ActivationTracker(failingDb, {
    warn: (msg) => warnings.push(msg)
  });

  await tracker.recordInvocation(
    { tenantId: "tenant-1", sessionId: "sess-1" },
    "skill",
    "skill-improver"
  );

  expect(warnings.length).toBe(1);
  expect(warnings[0]).toMatch(/failed to record events/);
});

test("ActivationTracker.recordEvents on empty list is a no-op", async () => {
  const { db, queries } = fakeDatabase();
  const tracker = new ActivationTracker(db);
  await tracker.recordEvents({ tenantId: "tenant-1", sessionId: "sess-1" }, []);
  expect(queries.length).toBe(0);
});

test("recordSkillInvocationsForTool credits each materialized skill that lists the tool", async () => {
  const queries: CapturedQuery[] = [];
  const inserts: CapturedQuery[] = [];
  const client = {
    async query(text: string, values: unknown[] = []) {
      queries.push({ text, values });
      if (text.includes("INSERT INTO resource_activations")) {
        inserts.push({ text, values });
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("FROM resource_activations") && text.includes("associatedToolIds")) {
        return {
          rows: [
            { resource_id: "write-artifact-skill" },
            { resource_id: "skill-improver" }
          ],
          rowCount: 2
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {}
  };
  const db = {
    async connect() {
      return client;
    }
  } as unknown as Pool;
  const tracker = new ActivationTracker(db);

  const credited = await tracker.recordSkillInvocationsForTool(
    { tenantId: "tenant-1", sessionId: "sess-1", messageId: "msg-1" },
    "write_artifact",
    { mcpServerId: "managed-session-context" }
  );

  expect(credited).toEqual(["write-artifact-skill", "skill-improver"]);
  expect(inserts.length).toBe(1);
  const [, , , resourceTypes, resourceIds, eventTypes, metadatas] = inserts[0].values as [
    string,
    string,
    string | null,
    string[],
    string[],
    string[],
    string[]
  ];
  expect(resourceTypes).toEqual(["skill", "skill"]);
  expect(resourceIds).toEqual(["write-artifact-skill", "skill-improver"]);
  expect(eventTypes).toEqual(["invoked", "invoked"]);
  expect(JSON.parse(metadatas[0])).toEqual({
        source: "tier1_tool_match",
        toolName: "write_artifact",
        mcpServerId: "managed-session-context"
      });
});

test("recordSkillInvocationsForTool emits no insert when no skill matches", async () => {
  const inserts: CapturedQuery[] = [];
  const client = {
    async query(text: string, values: unknown[] = []) {
      if (text.includes("INSERT INTO resource_activations")) {
        inserts.push({ text, values });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {}
  };
  const db = {
    async connect() {
      return client;
    }
  } as unknown as Pool;
  const tracker = new ActivationTracker(db);

  const credited = await tracker.recordSkillInvocationsForTool(
    { tenantId: "tenant-1", sessionId: "sess-1" },
    "write_artifact"
  );

  expect(credited).toEqual([]);
  expect(inserts.length).toBe(0);
});

test("countMcpServerActivations filters by mcp_server resource type", async () => {
  const queries: CapturedQuery[] = [];
  const client = {
    async query(text: string, values: unknown[] = []) {
      queries.push({ text, values });
      if (text.includes("FROM resource_activations") && text.includes("GROUP BY resource_id")) {
        return {
          rows: [
            { resource_id: "managed-session-context", invoked_sessions: "5", materialized_sessions: "12" },
            { resource_id: "managed-write-artifact", invoked_sessions: "0", materialized_sessions: "8" }
          ],
          rowCount: 2
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {}
  };
  const db = {
    async connect() {
      return client;
    }
  } as unknown as Pool;
  const tracker = new ActivationTracker(db);

  const counts = await tracker.countMcpServerActivations("tenant-1", 30 * 24 * 60 * 60 * 1000);

  const select = queries.find((q) => q.text.includes("FROM resource_activations") && q.text.includes("GROUP BY"));
  expect(select).toBeTruthy();
  expect(select!.values).toEqual(["tenant-1", "mcp_server", 30 * 24 * 60 * 60 * 1000]);

  expect(counts.size).toBe(2);
  expect(counts.get("managed-session-context")).toEqual({ invokedSessions: 5, materializedSessions: 12 });
  expect(counts.get("managed-write-artifact")).toEqual({ invokedSessions: 0, materializedSessions: 8 });
});
