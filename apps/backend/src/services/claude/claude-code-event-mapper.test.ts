import { test, expect } from "vitest";

import {
  createClaudeEventMapperState,
  mapClaudeEvent,
  type ClaudeEventMapperState
} from "./claude-code-event-mapper.js";

function freshState(): ClaudeEventMapperState {
  return createClaudeEventMapperState("r1");
}

// ── 1. system init → response.created ────────────────────────────────────────

test("mapClaudeEvent: system init emits response.created", () => {
  const state = freshState();
  const events = mapClaudeEvent(state, { type: "system", subtype: "init" });

  expect(events.length).toBe(1);
  expect(events[0]).toEqual({ type: "response.created", responseId: "r1" });
});

test("mapClaudeEvent: system with unknown subtype returns empty", () => {
  const state = freshState();
  const events = mapClaudeEvent(state, { type: "system", subtype: "other" });
  expect(events.length).toBe(0);
});

// ── 2. stream_event text delta → response.output_text.delta ──────────────────

test("mapClaudeEvent: text_delta emits output_text.delta", () => {
  const state = freshState();
  const events = mapClaudeEvent(state, {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "Hello world" }
    }
  } as Record<string, unknown>);

  expect(events.length).toBe(1);
  expect(events[0]).toEqual({
        type: "response.output_text.delta",
        responseId: "r1",
        delta: "Hello world"
      });
});

// ── 3. stream_event thinking delta → framework:reasoning_summary.delta ───────

test("mapClaudeEvent: thinking_delta emits reasoning_summary.delta", () => {
  const state = freshState();
  const events = mapClaudeEvent(state, {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "thinking_delta", thinking: "Let me think about this..." }
    }
  } as Record<string, unknown>);

  expect(events.length).toBe(1);
  expect(events[0]).toEqual({
        type: "framework:reasoning_summary.delta",
        responseId: "r1",
        delta: "Let me think about this..."
      });
});

// ── 4. content_block_start tool_use → response.tool.started (command) ────────

test("mapClaudeEvent: content_block_start tool_use emits tool.started with kind command", () => {
  const state = freshState();
  const events = mapClaudeEvent(state, {
    type: "stream_event",
    event: {
      type: "content_block_start",
      content_block: {
        type: "tool_use",
        id: "tu_1",
        name: "bash",
        input: { command: "ls -la" }
      }
    }
  } as Record<string, unknown>);

  expect(events.length).toBe(1);
  const ev = events[0] as { type: string; toolCall: { itemId: string; kind: string; command: string | null; toolName: string | null; input: string } };
  expect(ev.type).toBe("response.tool.started");
  expect(ev.toolCall.itemId).toBe("tu_1");
  expect(ev.toolCall.kind).toBe("command");
  // Bash/Shell tools promote input.command onto toolCall.command so the UI
  // renders the actual shell command (parity with the Codex runtime) instead
  // of the generic tool name.
  expect(ev.toolCall.command).toBe("ls -la");
  expect(ev.toolCall.toolName).toBe("bash");
  expect(ev.toolCall.input).toBe(JSON.stringify({ command: "ls -la" }));
  // Should update lastToolUseId
  expect(state.lastToolUseId).toBe("tu_1");
  expect(state.pendingToolCalls.has("tu_1")).toBe(true);
});

test("mapClaudeEvent: content_block_start tool_use for non-bash keeps tool name as command", () => {
  const state = freshState();
  const events = mapClaudeEvent(state, {
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "tu_write_1",
        name: "Write",
        input: {}
      }
    }
  } as Record<string, unknown>);
  const ev = events[0] as { toolCall: { command: string | null; toolName: string | null } };
  expect(ev.toolCall.command).toBe("Write");
  expect(ev.toolCall.toolName).toBe("Write");
});

// ── 5. content_block_start mcp_tool_use → response.tool.started (mcp) ───────

test("mapClaudeEvent: content_block_start mcp_tool_use emits tool.started with kind mcp", () => {
  const state = freshState();
  const events = mapClaudeEvent(state, {
    type: "stream_event",
    event: {
      type: "content_block_start",
      content_block: {
        type: "mcp_tool_use",
        id: "mcp_1",
        name: "search",
        server_name: "my-server",
        input: { query: "test" }
      }
    }
  } as Record<string, unknown>);

  expect(events.length).toBe(1);
  const ev = events[0] as { type: string; toolCall: { itemId: string; kind: string; server: string | null; toolName: string | null } };
  expect(ev.type).toBe("response.tool.started");
  expect(ev.toolCall.itemId).toBe("mcp_1");
  expect(ev.toolCall.kind).toBe("mcp");
  expect(ev.toolCall.server).toBe("my-server");
  expect(ev.toolCall.toolName).toBe("search");
  expect(state.lastToolUseId).toBe("mcp_1");
});

test("mapClaudeEvent: content_block_start server_tool_use also maps to mcp", () => {
  const state = freshState();
  const events = mapClaudeEvent(state, {
    type: "stream_event",
    event: {
      type: "content_block_start",
      content_block: {
        type: "server_tool_use",
        id: "stu_1",
        name: "fetch",
        server_name: "s2"
      }
    }
  } as Record<string, unknown>);

  expect(events.length).toBe(1);
  const ev = events[0] as { type: string; toolCall: { kind: string } };
  expect(ev.toolCall.kind).toBe("mcp");
});

// ── 6. input_json_delta — suppressed (tool input composition, not output) ─────

test("mapClaudeEvent: input_json_delta is suppressed", () => {
  const state = freshState();
  state.lastToolUseId = "tu_1";
  const events = mapClaudeEvent(state, {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "input_json_delta", partial_json: '{"key":' }
    }
  } as Record<string, unknown>);

  expect(events.length).toBe(0);
});

// ── 6b. input_json_delta accumulates, content_block_stop re-emits with input ─

test("mapClaudeEvent: input_json_delta accumulates and content_block_stop re-emits tool.started", () => {
  const state = freshState();
  // Start the tool with empty input (matches how Claude streams in practice).
  mapClaudeEvent(state, {
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "tu_acc", name: "Bash", input: {} }
    }
  } as Record<string, unknown>);

  // Deltas build the JSON argument.
  mapClaudeEvent(state, {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"command":"ec' }
    }
  } as Record<string, unknown>);
  mapClaudeEvent(state, {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: 'ho hi"}' }
    }
  } as Record<string, unknown>);

  // content_block_stop finalizes the input and re-emits tool.started with it.
  const stopEvents = mapClaudeEvent(state, {
    type: "stream_event",
    event: { type: "content_block_stop", index: 1 }
  } as Record<string, unknown>);

  expect(stopEvents.length).toBe(1);
  const ev = stopEvents[0] as { type: string; toolCall: { itemId: string; command: string | null; input: string } };
  expect(ev.type).toBe("response.tool.started");
  expect(ev.toolCall.itemId).toBe("tu_acc");
  expect(ev.toolCall.input).toBe('{"command":"echo hi"}');
  // Bash command is promoted to toolCall.command.
  expect(ev.toolCall.command).toBe("echo hi");
});

// ── 6c. user message tool_result → tool.completed ─────────────────────────────

test("mapClaudeEvent: user tool_result emits tool.completed with output and completed status", () => {
  const state = freshState();
  mapClaudeEvent(state, {
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "tu_ok", name: "Bash", input: { command: "ls" } }
    }
  } as Record<string, unknown>);

  const events = mapClaudeEvent(state, {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_ok", content: "file.txt\n", is_error: false }
      ]
    }
  });

  expect(events.length).toBe(1);
  const ev = events[0] as { type: string; toolCall: { itemId: string; status: string; output: string; durationMs: number | null; command: string | null } };
  expect(ev.type).toBe("response.tool.completed");
  expect(ev.toolCall.itemId).toBe("tu_ok");
  expect(ev.toolCall.status).toBe("completed");
  expect(ev.toolCall.output).toBe("file.txt\n");
  expect(typeof ev.toolCall.durationMs).toBe("number");
  expect(ev.toolCall.command).toBe("ls");
  // Pending entry is cleaned up.
  expect(state.pendingToolCalls.has("tu_ok")).toBe(false);
});

test("mapClaudeEvent: user tool_result with is_error sets failed status", () => {
  const state = freshState();
  mapClaudeEvent(state, {
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "tu_err", name: "Bash", input: {} }
    }
  } as Record<string, unknown>);

  const events = mapClaudeEvent(state, {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_err",
          content: [{ type: "text", text: "command not found" }],
          is_error: true
        }
      ]
    }
  });

  expect(events.length).toBe(1);
  const ev = events[0] as { toolCall: { status: string; output: string } };
  expect(ev.toolCall.status).toBe("failed");
  expect(ev.toolCall.output).toBe("command not found");
});

test("mapClaudeEvent: user tool_result for unknown tool_use_id is ignored", () => {
  const state = freshState();
  const events = mapClaudeEvent(state, {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_never_started", content: "ignored" }
      ]
    }
  });
  expect(events.length).toBe(0);
});

// ── 7c. assistant snapshot path emits tool.started for non-streaming callers ──

test("mapClaudeEvent: assistant snapshot emits tool.started for unseen tool_use blocks", () => {
  const state = freshState();
  const events = mapClaudeEvent(state, {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Running a command." },
        { type: "tool_use", id: "tu_snap", name: "Bash", input: { command: "pwd" } }
      ]
    }
  });

  // text_delta (fallback) + tool.started + output_item.done
  expect(events.length).toBe(3);
  expect(events[0].type).toBe("response.output_text.delta");
  expect(events[1].type).toBe("response.tool.started");
  const toolEvent = events[1] as { toolCall: { itemId: string; command: string | null } };
  expect(toolEvent.toolCall.itemId).toBe("tu_snap");
  expect(toolEvent.toolCall.command).toBe("pwd");
  expect(events[2].type).toBe("response.output_item.done");
  expect(state.pendingToolCalls.has("tu_snap")).toBe(true);
});

// ── 7. assistant → response.output_item.done ─────────────────────────────────

test("mapClaudeEvent: assistant emits output_item.done", () => {
  const state = freshState();
  const events = mapClaudeEvent(state, { type: "assistant" });

  expect(events.length).toBe(1);
  expect(events[0]).toEqual({ type: "response.output_item.done", responseId: "r1" });
});

test("mapClaudeEvent: assistant snapshot text is emitted when no stream_event delta arrived", () => {
  const state = freshState();
  const events = mapClaudeEvent(state, {
    type: "assistant",
    message: {
      content: [{ type: "text", text: "Hi! How can I help?" }]
    }
  });

  expect(events.length).toBe(2);
  expect(events[0]).toEqual({
        type: "response.output_text.delta",
        responseId: "r1",
        delta: "Hi! How can I help?"
      });
  expect(events[1]).toEqual({ type: "response.output_item.done", responseId: "r1" });
});

test("mapClaudeEvent: assistant snapshot text is suppressed after stream_event text_delta", () => {
  const state = freshState();
  // Simulate a streaming text delta first.
  mapClaudeEvent(state, {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "Hi! " }
    }
  } as Record<string, unknown>);
  expect(state.assistantTextStreamed).toBe(true);

  // Now the assistant snapshot arrives — it must NOT replay the text.
  const events = mapClaudeEvent(state, {
    type: "assistant",
    message: {
      content: [{ type: "text", text: "Hi! How can I help?" }]
    }
  });

  expect(events.length).toBe(1);
  expect(events[0]).toEqual({ type: "response.output_item.done", responseId: "r1" });
  // Flag resets so the next assistant message starts fresh.
  expect(state.assistantTextStreamed).toBe(false);
});

// ── 8. tool_progress → response.tool.output.delta ───────────────────────────

test("mapClaudeEvent: tool_progress emits tool.output.delta", () => {
  const state = freshState();
  state.lastToolUseId = "tu_2";
  const events = mapClaudeEvent(state, {
    type: "tool_progress",
    content: "Processing 50%..."
  });

  expect(events.length).toBe(1);
  expect(events[0]).toEqual({
        type: "response.tool.output.delta",
        responseId: "r1",
        itemId: "tu_2",
        delta: "Processing 50%..."
      });
});

// ── 9. result success → [output_item.done, response.completed] ──────────────

test("mapClaudeEvent: result success emits output_item.done and response.completed (no tokenUsage)", () => {
  // Token usage is captured by the LLM proxy now (single source of truth).
  // The SDK's usage in the result message is ignored; response.completed
  // no longer carries a tokenUsage field.
  const state = freshState();
  const events = mapClaudeEvent(state, {
    type: "result",
    subtype: "success",
    usage: {
      input_tokens: 100,
      cache_read_input_tokens: 20,
      output_tokens: 50
    }
  });

  expect(events.length).toBe(2);
  expect(events[0].type).toBe("response.output_item.done");

  const completed = events[1] as Record<string, unknown>;
  expect(completed.type).toBe("response.completed");
  expect(completed.tokenUsage).toBe(undefined);
});

// ── 10. result error → [output_item.done, response.failed] ──────────────────

test("mapClaudeEvent: result error emits output_item.done and response.failed", () => {
  const state = freshState();
  const events = mapClaudeEvent(state, {
    type: "result",
    subtype: "error_max_turns",
    error: "Maximum turns exceeded"
  });

  expect(events.length).toBe(2);
  expect(events[0].type).toBe("response.output_item.done");

  const failed = events[1] as { type: string; message: string };
  expect(failed.type).toBe("response.failed");
  expect(failed.message).toBe("Maximum turns exceeded");
});

test("mapClaudeEvent: result error uses message field as fallback", () => {
  const state = freshState();
  const events = mapClaudeEvent(state, {
    type: "result",
    subtype: "error_tool",
    message: "Tool execution failed"
  });

  expect(events.length).toBe(2);
  const failed = events[1] as { type: string; message: string };
  expect(failed.type).toBe("response.failed");
  expect(failed.message).toBe("Tool execution failed");
});

// ── 11. unknown message type → empty array ───────────────────────────────────

test("mapClaudeEvent: unknown message type returns empty array", () => {
  const state = freshState();
  const events = mapClaudeEvent(state, { type: "unknown_type", data: "whatever" });
  expect(events.length).toBe(0);
});

test("mapClaudeEvent: message with no type returns empty array", () => {
  const state = freshState();
  const events = mapClaudeEvent(state, { foo: "bar" });
  expect(events.length).toBe(0);
});
