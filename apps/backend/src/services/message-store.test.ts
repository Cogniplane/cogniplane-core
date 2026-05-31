import { test, expect } from "vitest";

import type { Pool } from "../lib/db.js";

import {
  MAX_MESSAGE_CONTENT_LENGTH,
  MAX_TOOL_RESULT_TEXT_LENGTH,
  MessageStore
} from "./message-store.js";

class CaptureMessageDatabase {
  lastValues: unknown[] | null = null;

  async connect() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      async query(text: string, values: unknown[] = []) {
        return self._query(text, values);
      },
      async release() {},
    };
  }

  _query(text: string, values: unknown[] = []) {
    // Ignore transaction control and SET LOCAL statements used by withTenantScope
    if (
      text === "BEGIN" ||
      text === "COMMIT" ||
      text === "ROLLBACK" ||
      text.startsWith("SELECT set_config")
    ) {
      return { rows: [], rowCount: 0 };
    }

    if (text.includes("INSERT INTO messages")) {
      this.lastValues = values;
      const now = new Date().toISOString();
      return {
        rows: [
          {
            id: 1,
            message_id: String(values[0]),
            session_id: String(values[2]),
            user_id: String(values[3]),
            role: String(values[4]),
            status: String(values[5]),
            content_text: String(values[6]),
            reasoning_content: "",
            plan_content: "",
            input_tokens: null,
            cached_input_tokens: null,
            output_tokens: null,
            reasoning_output_tokens: null,
            total_tokens: null,
            model_name: null,
            cost_usd: null,
            feedback_rating: null,
            feedback_notes: null,
            feedback_given_at: null,
            detail_json: JSON.parse(String(values[7] ?? "{}")),
            created_at: now,
            updated_at: now
          }
        ],
        rowCount: 1
      };
    }

    if (text.includes("UPDATE messages") && text.includes("jsonb_set")) {
      this.lastValues = values;
      return { rows: [], rowCount: 1 };
    }

    if (text.includes("INSERT INTO message_tool_results")) {
      this.lastValues = values;
      return {
        rows: [
          {
            id: 1,
            tool_result_id: String(values[1]),
            message_id: String(values[2]),
            session_id: String(values[3]),
            user_id: String(values[4]),
            kind: String(values[5]),
            title: String(values[6]),
            status: String(values[7]),
            command_text: String(values[8]),
            cwd: String(values[9]),
            server_name: String(values[10]),
            tool_name: String(values[11]),
            input_text: String(values[12]),
            output_text: String(values[13]),
            exit_code: values[14],
            duration_ms: values[15],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }
        ],
        rowCount: 1
      };
    }

    throw new Error(`Unexpected query in test: ${text}`);
  }

  async query(text: string, values: unknown[] = []) {
    return this._query(text, values);
  }
}

test("MessageStore.upsertToolResult normalizes nullable tool fields for persistence", async () => {
  const db = new CaptureMessageDatabase();
  const store = new MessageStore(db as unknown as Pool);

  const result = await store.upsertToolResult({
    tenantId: "test-tenant",
    toolResultId: "tool-1",
    messageId: "message-1",
    sessionId: "session-1",
    userId: "user-1",
    kind: "command",
    title: "Shell command",
    status: "in_progress",
    command: "python fib.py",
    cwd: null,
    server: null,
    toolName: null,
    input: "",
    output: "",
    exitCode: null,
    durationMs: null
  });

  expect(db.lastValues).toBeTruthy();
  // The NOT-NULL coercion (null input → "" persisted, to satisfy the NOT NULL
  // text columns) is ONLY observable in the bound values: the RETURNING row
  // round-trips "" back through mapToolResult, which re-maps empty strings to
  // null — so the returned record below can't distinguish "coerced to ''" from
  // "passed through as null". The bind is the sole signal, hence positional
  // peeks here. [9] = cwd, [10] = server_name.
  expect(db.lastValues![9]).toBe("");
  expect(db.lastValues![10]).toBe("");
  // The mapped record surfaces the nullable fields as null (the observable
  // contract callers actually see).
  expect(result.server).toBe(null);
  expect(result.toolName).toBe(null);
  expect(result.cwd).toBe(null);
});

test("MessageStore.upsertToolResult truncates oversized tool output before persistence", async () => {
  const db = new CaptureMessageDatabase();
  const store = new MessageStore(db as unknown as Pool);

  const huge = "x".repeat(MAX_TOOL_RESULT_TEXT_LENGTH + 5000);
  const result = await store.upsertToolResult({
    tenantId: "test-tenant",
    toolResultId: "tool-1",
    messageId: "message-1",
    sessionId: "session-1",
    userId: "user-1",
    kind: "command",
    title: "Shell command",
    status: "completed",
    command: "cat huge.log",
    cwd: null,
    server: null,
    toolName: null,
    input: "",
    output: huge,
    exitCode: 0,
    durationMs: 1
  });

  // The fake's RETURNING echoes the persisted output_text, so the mapped
  // record's `output` is what actually reached storage.
  // Capped at MAX + the truncation marker, never the full GB-scale payload.
  expect(result.output.length).toBeLessThan(huge.length);
  expect(result.output.startsWith("x".repeat(MAX_TOOL_RESULT_TEXT_LENGTH))).toBe(true);
  expect(result.output).toContain("truncated");
});

test("MessageStore.create truncates oversized content before persistence", async () => {
  const db = new CaptureMessageDatabase();
  const store = new MessageStore(db as unknown as Pool);

  const huge = "y".repeat(MAX_MESSAGE_CONTENT_LENGTH + 5000);
  const record = await store.create({
    tenantId: "test-tenant",
    sessionId: "session-1",
    userId: "user-1",
    role: "assistant",
    status: "completed",
    content: huge
  });

  // The fake's RETURNING echoes the persisted content_text, so the mapped
  // record's `content` is what actually reached storage.
  expect(record.content.length).toBeLessThan(huge.length);
  expect(record.content).toContain("truncated");
});

test("MessageStore.create persists detail_json with PII metadata and system role", async () => {
  const db = new CaptureMessageDatabase();
  const store = new MessageStore(db as unknown as Pool);

  const record = await store.create({
    tenantId: "test-tenant",
    sessionId: "session-1",
    userId: "user-1",
    role: "system",
    status: "completed",
    content: "Message blocked by organization policy.",
    detail: {
      pii: { status: "blocked", blockReason: "email", modeApplied: "block" }
    }
  });

  // The fake's RETURNING echoes the persisted detail_json, so the mapped
  // record is the observable proof that PII metadata + the system role round-
  // trip through create() — no need to peek the raw bound JSON.
  expect(record.role).toBe("system");
  expect(record.detail.pii?.status).toBe("blocked");
  expect(record.detail.pii?.blockReason).toBe("email");
});

test("MessageStore.create defaults detail_json to an empty object", async () => {
  const db = new CaptureMessageDatabase();
  const store = new MessageStore(db as unknown as Pool);

  const record = await store.create({
    tenantId: "test-tenant",
    sessionId: "session-1",
    userId: "user-1",
    role: "user",
    status: "pending",
    content: "hi"
  });

  // Omitting `detail` yields an empty object on the returned record — the
  // fake derives detail_json from what create() bound, so the mapped record
  // is the observable proof of the default.
  expect(record.detail).toEqual({});
});

test("MessageStore.setPiiDetail issues a jsonb_set merge under detail_json.pii", async () => {
  const db = new CaptureMessageDatabase();
  const store = new MessageStore(db as unknown as Pool);

  await store.setPiiDetail("test-tenant", "msg-1", { status: "transformed", transformed: true });

  // setPiiDetail returns void, so the bound values are the ONLY observable
  // signal that the tenant/message scope and the merged patch reach the query.
  expect(db.lastValues).toBeTruthy();
  expect(db.lastValues).toContain("test-tenant");
  expect(db.lastValues).toContain("msg-1");
  const patch = JSON.parse(String(db.lastValues![2]));
  expect(patch.status).toBe("transformed");
  expect(patch.transformed).toBe(true);
});

// ── Configurable scripted DB for read paths ─────────────────────────────────

class ScriptedDatabase {
  scripts: Array<{ match: (text: string) => boolean; fn: (values: unknown[]) => { rows: Record<string, unknown>[]; rowCount?: number } }> = [];
  lastValuesByMatch: Map<string, unknown[]> = new Map();

  async connect() {
    return {
      query: this.query.bind(this),
      release: async () => {}
    };
  }

  async query(text: string, values: unknown[] = []) {
    if (
      text === "BEGIN" ||
      text === "COMMIT" ||
      text === "ROLLBACK" ||
      text.startsWith("SELECT set_config")
    ) {
      return { rows: [], rowCount: 0 };
    }
    for (const script of this.scripts) {
      if (script.match(text)) {
        return script.fn(values);
      }
    }
    throw new Error(`Unhandled query: ${text.slice(0, 80)}`);
  }
}

test("MessageStore.getOwned returns null when row missing", async () => {
  const db = new ScriptedDatabase();
  db.scripts = [
    {
      match: (t) => t.includes("FROM messages") && t.includes("AND user_id = $3"),
      fn: () => ({ rows: [], rowCount: 0 })
    }
  ];
  const store = new MessageStore(db as unknown as Pool);
  const result = await store.getOwned("t", "msg-1", "u");
  expect(result).toBe(null);
});

test("MessageStore.getOwned returns mapped record with token usage and feedback", async () => {
  const db = new ScriptedDatabase();
  db.scripts = [
    {
      match: (t) => t.includes("FROM messages") && t.includes("AND user_id = $3"),
      fn: () => ({
        rows: [
          {
            id: 1,
            message_id: "msg-1",
            session_id: "s",
            user_id: "u",
            role: "assistant",
            status: "completed",
            content_text: "hi",
            reasoning_content: "", // covers ?? ""
            plan_content: "",
            input_tokens: 10,
            cached_input_tokens: 2,
            output_tokens: 5,
            reasoning_output_tokens: 1,
            total_tokens: 15,
            model_name: "claude-sonnet",
            cost_usd: "0.003", // string -> Number()
            feedback_rating: "thumbs_up",
            detail_json: { foo: "bar" },
            created_at: "2026-01-01",
            updated_at: "2026-01-02"
          }
        ],
        rowCount: 1
      })
    }
  ];
  const store = new MessageStore(db as unknown as Pool);
  const r = await store.getOwned("t", "msg-1", "u");
  expect(r).toBeTruthy();
  expect(r!.role).toBe("assistant");
  expect(r!.feedbackRating).toBe("thumbs_up");
  expect(r!.modelName).toBe("claude-sonnet");
  expect(r!.costUsd).toBe(0.003);
  expect(r!.tokenUsage).toEqual({
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 5,
        reasoningOutputTokens: 1,
        totalTokens: 15
      });
  expect(r!.detail).toEqual({ foo: "bar" });
});

test("MessageStore.getOwned: tokenUsage is null when total_tokens is missing", async () => {
  const db = new ScriptedDatabase();
  db.scripts = [
    {
      match: (t) => t.includes("FROM messages") && t.includes("AND user_id = $3"),
      fn: () => ({
        rows: [
          {
            id: 1,
            message_id: "msg-1",
            session_id: "s",
            user_id: "u",
            role: "garbage", // unrecognized -> defaults to 'user'
            status: "weird",  // unrecognized -> defaults to 'completed'
            content_text: null,
            reasoning_content: null,
            plan_content: null,
            input_tokens: null,
            cached_input_tokens: null,
            output_tokens: null,
            reasoning_output_tokens: null,
            total_tokens: null,
            model_name: null,
            cost_usd: null,
            feedback_rating: "garbage",
            detail_json: "not-an-object",
            created_at: "2026-01-01",
            updated_at: "2026-01-02"
          }
        ],
        rowCount: 1
      })
    }
  ];
  const store = new MessageStore(db as unknown as Pool);
  const r = await store.getOwned("t", "msg-1", "u");
  expect(r).toBeTruthy();
  expect(r!.role).toBe("user");
  expect(r!.status).toBe("completed");
  expect(r!.tokenUsage).toBe(null);
  expect(r!.feedbackRating).toBe(null);
  expect(r!.detail).toEqual({});
  expect(r!.modelName).toBe(null);
  expect(r!.costUsd).toBe(null);
});

test("MessageStore.listBySession joins tool results onto messages and skips unrelated ones", async () => {
  const db = new ScriptedDatabase();
  db.scripts = [
    {
      match: (t) => t.includes("FROM messages") && t.includes("session_titling"),
      fn: () => ({
        rows: [
          {
            id: 1,
            message_id: "m-a",
            session_id: "s",
            user_id: "u",
            role: "user",
            status: "completed",
            content_text: "hi",
            reasoning_content: "",
            plan_content: "",
            input_tokens: null,
            cached_input_tokens: null,
            output_tokens: null,
            reasoning_output_tokens: null,
            total_tokens: null,
            model_name: null,
            cost_usd: null,
            feedback_rating: null,
            detail_json: {},
            created_at: "2026-01-01",
            updated_at: "2026-01-01"
          },
          {
            id: 2,
            message_id: "m-b",
            session_id: "s",
            user_id: "u",
            role: "assistant",
            status: "streaming",
            content_text: "ok",
            reasoning_content: "thinking",
            plan_content: "plan",
            input_tokens: 1, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0, total_tokens: 3,
            model_name: "x", cost_usd: 0.001, feedback_rating: "thumbs_down",
            detail_json: {},
            created_at: "2026-01-02",
            updated_at: "2026-01-02"
          }
        ],
        rowCount: 2
      })
    },
    {
      match: (t) => t.includes("FROM message_tool_results"),
      fn: () => ({
        rows: [
          {
            id: 1,
            tool_result_id: "tr-1",
            message_id: "m-a",
            session_id: "s",
            user_id: "u",
            kind: "command",
            title: "ls",
            status: "completed",
            command_text: "ls",
            cwd: "/tmp",
            server_name: null,
            tool_name: null,
            input_text: null,
            output_text: null,
            exit_code: 0,
            duration_ms: 100,
            created_at: "2026-01-01",
            updated_at: "2026-01-01"
          },
          {
            id: 2,
            tool_result_id: "tr-2",
            message_id: "m-orphan", // belongs to a message we did not return
            session_id: "s",
            user_id: "u",
            kind: "mcp",
            title: "do",
            status: "in_progress",
            command_text: null,
            cwd: null,
            server_name: "srv",
            tool_name: "fn",
            input_text: "{}",
            output_text: "result",
            exit_code: null,
            duration_ms: null,
            created_at: "2026-01-01",
            updated_at: "2026-01-01"
          }
        ],
        rowCount: 2
      })
    }
  ];
  const store = new MessageStore(db as unknown as Pool);
  const list = await store.listBySession("t", "s", "u");
  expect(list.length).toBe(2);
  expect(list[0].messageId).toBe("m-a");
  expect(list[0].toolResults.length).toBe(1);
  expect(list[0].toolResults[0].toolResultId).toBe("tr-1");
  // assistant message with no tool results gets []
  expect(list[1].toolResults).toEqual([]);
  expect(list[1].status).toBe("streaming");
});

test("MessageStore.updateContent returns null when no row matched", async () => {
  const db = new ScriptedDatabase();
  db.scripts = [
    {
      match: (t) => t.includes("UPDATE messages") && t.includes("content_text = $5"),
      fn: () => ({ rows: [], rowCount: 0 })
    }
  ];
  const store = new MessageStore(db as unknown as Pool);
  const result = await store.updateContent("t", "m-1", "u", "completed", "hello");
  expect(result).toBe(null);
});

test("MessageStore.updateContent returns mapped record on success", async () => {
  const db = new ScriptedDatabase();
  db.scripts = [
    {
      match: (t) => t.includes("UPDATE messages") && t.includes("content_text = $5"),
      fn: (vals) => ({
        rows: [
          {
            id: 1,
            message_id: vals[1],
            session_id: "s",
            user_id: vals[2],
            role: "assistant",
            status: vals[3],
            content_text: vals[4],
            reasoning_content: "",
            plan_content: "",
            input_tokens: null,
            cached_input_tokens: null,
            output_tokens: null,
            reasoning_output_tokens: null,
            total_tokens: null,
            model_name: null,
            cost_usd: null,
            feedback_rating: null,
            detail_json: {},
            created_at: "2026-01-01",
            updated_at: "2026-01-01"
          }
        ],
        rowCount: 1
      })
    }
  ];
  const store = new MessageStore(db as unknown as Pool);
  const r = await store.updateContent("t", "m-1", "u", "completed", "hello");
  expect(r).toBeTruthy();
  expect(r!.content).toBe("hello");
  expect(r!.status).toBe("completed");
  expect(r!.toolResults).toEqual([]);
});

test("MessageStore.updateStreamingContent: returns early when both fields are undefined", async () => {
  // ScriptedDatabase has no scripts; if the method tried to query it would throw.
  const db = new ScriptedDatabase();
  const store = new MessageStore(db as unknown as Pool);
  await store.updateStreamingContent("t", "m", "u", {});
});

test("MessageStore.updateStreamingContent: passes provided fields through and nulls absent ones", async () => {
  const db = new ScriptedDatabase();
  let captured: unknown[] | null = null;
  db.scripts = [
    {
      match: (t) => t.includes("UPDATE messages") && t.includes("reasoning_content"),
      fn: (vals) => {
        captured = vals;
        return { rows: [], rowCount: 1 };
      }
    }
  ];
  const store = new MessageStore(db as unknown as Pool);
  await store.updateStreamingContent("t", "m-1", "u", { reasoningContent: "thinking" });
  expect(captured).toBeTruthy();
  // [tenantId, messageId, userId, reasoningContent, planContent]
  expect(captured![3]).toBe("thinking");
  expect(captured![4]).toBe(null);
});

test("MessageStore.addTokenUsage increments token columns and returns the new totals", async () => {
  const db = new ScriptedDatabase();
  let captured: unknown[] | null = null;
  db.scripts = [
    {
      match: (t) => t.includes("UPDATE messages") && t.includes("input_tokens") && t.includes("+ $4"),
      fn: (vals) => {
        captured = vals;
        return {
          rows: [
            {
              input_tokens: 11,
              cached_input_tokens: 12,
              output_tokens: 13,
              reasoning_output_tokens: 14,
              total_tokens: 50
            }
          ],
          rowCount: 1
        };
      }
    }
  ];
  const store = new MessageStore(db as unknown as Pool);
  const result = await store.addTokenUsage(
    "t",
    "m-1",
    "u",
    { inputTokens: 1, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 4, totalTokens: 10 },
    "claude-haiku"
  );
  expect(captured).toBeTruthy();
  expect(captured![3]).toBe(1); // delta inputTokens
  expect(captured![7]).toBe(10); // delta totalTokens
  expect(captured![8]).toBe("claude-haiku");
  // RETURNING surfaces the post-UPDATE cumulative totals.
  expect(result).toEqual({
    inputTokens: 11,
    cachedInputTokens: 12,
    outputTokens: 13,
    reasoningOutputTokens: 14,
    totalTokens: 50
  });
});

test("MessageStore.setCostUsd forwards value to the UPDATE", async () => {
  const db = new ScriptedDatabase();
  let captured: unknown[] | null = null;
  db.scripts = [
    {
      match: (t) => t.includes("UPDATE messages") && t.includes("cost_usd"),
      fn: (vals) => {
        captured = vals;
        return { rows: [], rowCount: 1 };
      }
    }
  ];
  const store = new MessageStore(db as unknown as Pool);
  await store.setCostUsd("t", "m-1", "u", 0.0042);
  expect(captured).toBeTruthy();
  expect(captured![3]).toBe(0.0042);
});

test("MessageStore.updateFeedback: returns true when a row was updated", async () => {
  const db = new ScriptedDatabase();
  db.scripts = [
    {
      match: (t) => t.includes("UPDATE messages") && t.includes("feedback_rating"),
      fn: () => ({ rows: [], rowCount: 1 })
    }
  ];
  const store = new MessageStore(db as unknown as Pool);
  const ok = await store.updateFeedback("t", "m-1", "u", "thumbs_up", "good");
  expect(ok).toBe(true);
});

test("MessageStore.updateFeedback: returns false when no row was updated", async () => {
  const db = new ScriptedDatabase();
  db.scripts = [
    {
      match: (t) => t.includes("UPDATE messages") && t.includes("feedback_rating"),
      fn: () => ({ rows: [], rowCount: 0 })
    }
  ];
  const store = new MessageStore(db as unknown as Pool);
  const ok = await store.updateFeedback("t", "m-1", "u", "thumbs_down", null);
  expect(ok).toBe(false);
});

test("MessageStore.updateFeedback: returns false when rowCount is null/undefined", async () => {
  const db = new ScriptedDatabase();
  db.scripts = [
    {
      match: (t) => t.includes("UPDATE messages") && t.includes("feedback_rating"),
      fn: () => ({ rows: [] }) // no rowCount
    }
  ];
  const store = new MessageStore(db as unknown as Pool);
  const ok = await store.updateFeedback("t", "m-1", "u", "thumbs_up", null);
  expect(ok).toBe(false);
});

test("MessageStore.appendToolResultOutput: returns null when no row matched", async () => {
  const db = new ScriptedDatabase();
  db.scripts = [
    {
      match: (t) => t.includes("UPDATE message_tool_results") && t.includes("output_text"),
      fn: () => ({ rows: [], rowCount: 0 })
    }
  ];
  const store = new MessageStore(db as unknown as Pool);
  const r = await store.appendToolResultOutput("t", "tr-1", "u", "delta");
  expect(r).toBe(null);
});

test("MessageStore.appendToolResultOutput: returns mapped tool result on success", async () => {
  const db = new ScriptedDatabase();
  db.scripts = [
    {
      match: (t) => t.includes("UPDATE message_tool_results") && t.includes("output_text"),
      fn: (vals) => ({
        rows: [
          {
            id: 5,
            tool_result_id: vals[1],
            message_id: "m-1",
            session_id: "s",
            user_id: vals[2],
            kind: "mcp",
            title: "fn",
            status: "completed",
            command_text: null,
            cwd: null,
            server_name: "srv",
            tool_name: "fn",
            input_text: "{}",
            output_text: "ok",
            exit_code: null,
            duration_ms: null,
            created_at: "2026-01-01",
            updated_at: "2026-01-01"
          }
        ],
        rowCount: 1
      })
    }
  ];
  const store = new MessageStore(db as unknown as Pool);
  const r = await store.appendToolResultOutput("t", "tr-7", "u", "more");
  expect(r).toBeTruthy();
  expect(r!.toolResultId).toBe("tr-7");
  expect(r!.kind).toBe("mcp");
  expect(r!.command).toBe(null);
});

test("mapToolResult: unknown status falls back to in_progress", async () => {
  // Drive through the public path: appendToolResultOutput maps the row.
  const db = new ScriptedDatabase();
  db.scripts = [
    {
      match: (t) => t.includes("UPDATE message_tool_results"),
      fn: (vals) => ({
        rows: [
          {
            id: 1,
            tool_result_id: vals[1],
            message_id: "m",
            session_id: "s",
            user_id: vals[2],
            kind: "garbage", // unrecognized -> 'command'
            title: undefined, // -> ''
            status: "weird",  // unrecognized -> 'in_progress'
            command_text: null,
            cwd: null,
            server_name: null,
            tool_name: null,
            input_text: null,
            output_text: null,
            exit_code: undefined,
            duration_ms: undefined,
            created_at: "2026-01-01",
            updated_at: "2026-01-01"
          }
        ],
        rowCount: 1
      })
    }
  ];
  const store = new MessageStore(db as unknown as Pool);
  const r = await store.appendToolResultOutput("t", "tr", "u", "x");
  expect(r).toBeTruthy();
  expect(r!.kind).toBe("command");
  expect(r!.title).toBe("");
  expect(r!.status).toBe("in_progress");
  expect(r!.exitCode).toBe(null);
  expect(r!.durationMs).toBe(null);
});
