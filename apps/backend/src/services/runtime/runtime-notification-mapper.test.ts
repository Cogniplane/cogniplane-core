import { test, expect } from "vitest";

import { mapRuntimeNotification } from "./runtime-notification-mapper.js";

const activeTurn = { responseId: "r1", outputItemDone: false };

test("mapRuntimeNotification: item/completed commandExecution returns tool completed event", () => {
  const result = mapRuntimeNotification(activeTurn, {
    method: "item/completed",
    params: {
      item: {
        type: "commandExecution",
        id: "item-1",
        command: "ls -la",
        cwd: "/tmp",
        status: "completed",
        aggregatedOutput: "file1\nfile2",
        exitCode: 0,
        durationMs: 42
      }
    }
  });

  expect(result.kind).toBe("tool");
  if (result.kind !== "tool") return;
  expect(result.phase).toBe("completed");
  expect(result.toolCall.itemId).toBe("item-1");
  expect(result.toolCall.kind).toBe("command");
  expect(result.toolCall.command).toBe("ls -la");
  expect(result.toolCall.output).toBe("file1\nfile2");
  expect(result.events[0].type).toBe("response.tool.completed");
});

test("mapRuntimeNotification: item/completed mcpToolCall returns tool completed event", () => {
  const result = mapRuntimeNotification(activeTurn, {
    method: "item/completed",
    params: {
      item: {
        type: "mcpToolCall",
        id: "item-2",
        server: "my-server",
        tool: "search",
        status: "completed",
        arguments: { q: "hello" },
        result: { hits: 3 },
        durationMs: 99
      }
    }
  });

  expect(result.kind).toBe("tool");
  if (result.kind !== "tool") return;
  expect(result.phase).toBe("completed");
  expect(result.toolCall.itemId).toBe("item-2");
  expect(result.toolCall.kind).toBe("mcp");
  expect(result.toolCall.server).toBe("my-server");
  expect(result.toolCall.toolName).toBe("search");
});

test("mapRuntimeNotification: item/completed mcpToolCall with failed status returns phase=failed", () => {
  const result = mapRuntimeNotification(activeTurn, {
    method: "item/completed",
    params: {
      item: {
        type: "mcpToolCall",
        id: "item-3",
        server: "my-server",
        tool: "search",
        status: "failed",
        error: { message: "tool crashed" }
      }
    }
  });

  expect(result.kind).toBe("tool");
  if (result.kind !== "tool") return;
  expect(result.phase).toBe("failed");
});

test("mapRuntimeNotification: item/started commandExecution returns tool started event", () => {
  const result = mapRuntimeNotification(activeTurn, {
    method: "item/started",
    params: {
      item: {
        type: "commandExecution",
        id: "item-4",
        command: "echo hi",
        cwd: "/home",
        status: "in_progress"
      }
    }
  });

  expect(result.kind).toBe("tool");
  if (result.kind !== "tool") return;
  expect(result.phase).toBe("started");
  expect(result.toolCall.itemId).toBe("item-4");
  expect(result.toolCall.kind).toBe("command");
  expect(result.events[0].type).toBe("response.tool.started");
});

test("mapRuntimeNotification: item/started mcpToolCall returns tool started event", () => {
  const result = mapRuntimeNotification(activeTurn, {
    method: "item/started",
    params: {
      item: {
        type: "mcpToolCall",
        id: "item-5",
        server: "s1",
        tool: "fetch",
        status: "in_progress",
        arguments: { url: "https://example.com" }
      }
    }
  });

  expect(result.kind).toBe("tool");
  if (result.kind !== "tool") return;
  expect(result.phase).toBe("started");
  expect(result.toolCall.itemId).toBe("item-5");
  expect(result.toolCall.kind).toBe("mcp");
});

test("mapRuntimeNotification: item/completed with missing id returns none", () => {
  const result = mapRuntimeNotification(activeTurn, {
    method: "item/completed",
    params: {
      item: { type: "commandExecution" }
    }
  });
  expect(result.kind).toBe("none");
});

test("mapRuntimeNotification: item/started with missing id returns none", () => {
  const result = mapRuntimeNotification(activeTurn, {
    method: "item/started",
    params: {
      item: { type: "mcpToolCall" }
    }
  });
  expect(result.kind).toBe("none");
});

test("mapRuntimeNotification: reasoning summary delta is forwarded", () => {
  const result = mapRuntimeNotification(activeTurn, {
    method: "item/reasoning/summaryTextDelta",
    params: {
      delta: "I am checking the configured tools."
    }
  });

  expect(result.kind).toBe("events");
  if (result.kind !== "events") return;
  expect(result.events).toEqual([
        {
          type: "framework:reasoning_summary.delta",
          responseId: "r1",
          delta: "I am checking the configured tools."
        }
      ]);
});

test("mapRuntimeNotification: retryable runtime error returns runtime-error", () => {
  const result = mapRuntimeNotification(activeTurn, {
    method: "error",
    params: {
      error: { message: "Reconnecting... 1/5" },
      willRetry: true
    }
  });

  expect(result.kind).toBe("runtime-error");
  if (result.kind !== "runtime-error") return;
  expect(result.message).toBe("Reconnecting... 1/5");
  expect(result.retrying).toBe(true);
});

test("mapRuntimeNotification: non-retryable runtime error returns runtime-error", () => {
  const result = mapRuntimeNotification(activeTurn, {
    method: "error",
    params: {
      error: { message: "Reached the retry limit for responses." }
    }
  });

  expect(result.kind).toBe("runtime-error");
  if (result.kind !== "runtime-error") return;
  expect(result.message).toBe("Reached the retry limit for responses.");
  expect(result.retrying).toBe(false);
});

test("mapRuntimeNotification: stream error returns retryable runtime-error", () => {
  const result = mapRuntimeNotification(activeTurn, {
    method: "codex/event/stream_error",
    params: {
      msg: { message: "WebSocket disconnected while streaming." }
    }
  });

  expect(result.kind).toBe("runtime-error");
  if (result.kind !== "runtime-error") return;
  expect(result.message).toBe("WebSocket disconnected while streaming.");
  expect(result.retrying).toBe(true);
});

test("mapRuntimeNotification: agentMessage delta forwards a text delta event", () => {
  const result = mapRuntimeNotification(activeTurn, {
    method: "item/agentMessage/delta",
    params: { delta: "hello" }
  });
  expect(result.kind).toBe("events");
  if (result.kind === "events") {
    expect(result.events[0].type).toBe("response.output_text.delta");
  }
});

test("mapRuntimeNotification: agentMessage delta with no string delta returns none", () => {
  const result = mapRuntimeNotification(activeTurn, {
    method: "item/agentMessage/delta",
    params: { delta: 42 }
  });
  expect(result.kind).toBe("none");
});

test("mapRuntimeNotification: reasoning text delta returns framework reasoning event", () => {
  const result = mapRuntimeNotification(activeTurn, {
    method: "item/reasoning/textDelta",
    params: { delta: "thinking" }
  });
  expect(result.kind).toBe("events");
  if (result.kind === "events") {
    expect(result.events[0].type).toBe("framework:reasoning_text.delta");
  }
});

test("mapRuntimeNotification: reasoning textDelta returns none when delta missing", () => {
  const result = mapRuntimeNotification(activeTurn, {
    method: "item/reasoning/textDelta",
    params: {}
  });
  expect(result.kind).toBe("none");
});

test("mapRuntimeNotification: reasoning summaryDelta returns none when missing", () => {
  const result = mapRuntimeNotification(activeTurn, {
    method: "item/reasoning/summaryTextDelta",
    params: {}
  });
  expect(result.kind).toBe("none");
});

test("mapRuntimeNotification: item/completed agentMessage emits output_item.done when not yet done", () => {
  const result = mapRuntimeNotification(
    { responseId: "r1", outputItemDone: false },
    { method: "item/completed", params: { item: { type: "agentMessage", id: "m1" } } }
  );
  expect(result.kind).toBe("events");
  if (result.kind === "events") {
    expect(result.events[0].type).toBe("response.output_item.done");
  }
});

test("mapRuntimeNotification: item/completed agentMessage returns none when outputItemDone already true", () => {
  const result = mapRuntimeNotification(
    { responseId: "r1", outputItemDone: true },
    { method: "item/completed", params: { item: { type: "agentMessage" } } }
  );
  expect(result.kind).toBe("none");
});

test("mapRuntimeNotification: item/completed for fileChange emits tool completed", () => {
  const result = mapRuntimeNotification(activeTurn, {
    method: "item/completed",
    params: {
      item: {
        type: "fileChange",
        id: "f1",
        filePath: "/src/x.ts",
        status: "completed",
        aggregatedOutput: "+ x",
        durationMs: 1
      }
    }
  });
  expect(result.kind).toBe("tool");
  if (result.kind === "tool") {
    expect(result.toolCall.title).toBe("File: /src/x.ts");
    expect(result.phase).toBe("completed");
  }
});

test("mapRuntimeNotification: item/completed fileChange with status=failed → phase=failed", () => {
  const result = mapRuntimeNotification(activeTurn, {
    method: "item/completed",
    params: { item: { type: "fileChange", id: "f1", status: "failed" } }
  });
  expect(result.kind).toBe("tool");
  if (result.kind === "tool") {
    expect(result.phase).toBe("failed");
    expect(result.toolCall.title).toBe("File change"); // no filePath
  }
});

test("mapRuntimeNotification: item/started fileChange emits tool started", () => {
  const result = mapRuntimeNotification(activeTurn, {
    method: "item/started",
    params: { item: { type: "fileChange", id: "f1", filePath: "/src/y.ts" } }
  });
  expect(result.kind).toBe("tool");
  if (result.kind === "tool") {
    expect(result.phase).toBe("started");
    expect(result.toolCall.title).toBe("File: /src/y.ts");
  }
});

test("mapRuntimeNotification: unknown item type on item/started returns none", () => {
  const result = mapRuntimeNotification(activeTurn, {
    method: "item/started",
    params: { item: { type: "unknown", id: "u1" } }
  });
  expect(result.kind).toBe("none");
});

test("mapRuntimeNotification: commandExecution outputDelta forwards itemId+delta", () => {
  const result = mapRuntimeNotification(activeTurn, {
    method: "item/commandExecution/outputDelta",
    params: { itemId: "c1", delta: "chunk" }
  });
  expect(result.kind).toBe("events");
  if (result.kind === "events") {
    expect(result.events[0].type).toBe("response.tool.output.delta");
  }
});

test("mapRuntimeNotification: commandExecution outputDelta returns none when params malformed", () => {
  const result = mapRuntimeNotification(activeTurn, {
    method: "item/commandExecution/outputDelta",
    params: { itemId: 1 }
  });
  expect(result.kind).toBe("none");
});

test("mapRuntimeNotification: fileChange outputDelta forwards itemId+delta", () => {
  const result = mapRuntimeNotification(activeTurn, {
    method: "item/fileChange/outputDelta",
    params: { itemId: "f1", delta: "+1" }
  });
  expect(result.kind).toBe("events");
});

test("mapRuntimeNotification: fileChange outputDelta returns none when malformed", () => {
  const result = mapRuntimeNotification(activeTurn, {
    method: "item/fileChange/outputDelta",
    params: {}
  });
  expect(result.kind).toBe("none");
});

test("mapRuntimeNotification: plan delta forwards", () => {
  const result = mapRuntimeNotification(activeTurn, {
    method: "item/plan/delta",
    params: { delta: "plan" }
  });
  expect(result.kind).toBe("events");
  if (result.kind === "events") {
    expect(result.events[0].type).toBe("framework:plan.delta");
  }
});

test("mapRuntimeNotification: plan delta returns none when delta missing", () => {
  const result = mapRuntimeNotification(activeTurn, {
    method: "item/plan/delta",
    params: {}
  });
  expect(result.kind).toBe("none");
});

test("mapRuntimeNotification: mcpToolCall progress forwards message with trailing newline", () => {
  const result = mapRuntimeNotification(activeTurn, {
    method: "item/mcpToolCall/progress",
    params: { itemId: "m1", message: "doing work" }
  });
  expect(result.kind).toBe("events");
  if (result.kind === "events") {
    const event = result.events[0] as { itemId: string; delta: string };
    expect(event.itemId).toBe("m1");
    expect(event.delta).toMatch(/^doing work\n$/);
  }
});

test("mapRuntimeNotification: mcpToolCall progress returns none when malformed", () => {
  const result = mapRuntimeNotification(activeTurn, {
    method: "item/mcpToolCall/progress",
    params: { itemId: 1, message: 2 }
  });
  expect(result.kind).toBe("none");
});

test("mapRuntimeNotification: token usage update is dropped (proxy owns cost)", () => {
  // The LLM proxy is now the single source of truth for token usage and
  // cost; the runtime layer no longer maps token-usage notifications.
  const result = mapRuntimeNotification(activeTurn, {
    method: "thread/tokenUsage/updated",
    params: { tokenUsage: { last: { totalTokens: 5 } } }
  });
  expect(result.kind).toBe("none");
});

test("mapRuntimeNotification: codex/event/error returns non-retrying runtime-error", () => {
  const result = mapRuntimeNotification(activeTurn, {
    method: "codex/event/error",
    params: { error: { message: "fatal" } }
  });
  expect(result.kind).toBe("runtime-error");
  if (result.kind === "runtime-error") {
    expect(result.retrying).toBe(false);
    expect(result.message).toBe("fatal");
  }
});

test("mapRuntimeNotification: error fallback message when error has no message field", () => {
  const result = mapRuntimeNotification(activeTurn, {
    method: "error",
    params: { error: "raw string" }
  });
  expect(result.kind).toBe("runtime-error");
  if (result.kind === "runtime-error") {
    expect(result.message).toBe("Runtime error");
  }
});

test("mapRuntimeNotification: mcpServer/startupStatus updated returns mcp-server-status with error", () => {
  const result = mapRuntimeNotification(activeTurn, {
    method: "mcpServer/startupStatus/updated",
    params: { name: "srv", status: "failed", error: "boom" }
  });
  expect(result.kind).toBe("mcp-server-status");
  if (result.kind === "mcp-server-status") {
    expect(result.serverName).toBe("srv");
    expect(result.status).toBe("failed");
    expect(result.error).toBe("boom");
  }
});

test("mapRuntimeNotification: mcpServer/startupStatus returns none when name/status missing", () => {
  const result = mapRuntimeNotification(activeTurn, {
    method: "mcpServer/startupStatus/updated",
    params: { name: "srv" }
  });
  expect(result.kind).toBe("none");
});

test("mapRuntimeNotification: turn/completed reports success when status='completed'", () => {
  const result = mapRuntimeNotification(activeTurn, {
    method: "turn/completed",
    params: { turn: { status: "completed" } }
  });
  expect(result.kind).toBe("turn-completed");
  if (result.kind === "turn-completed") {
    expect(result.completed).toBe(true);
    expect(result.failureMessage).toBe("Turn failed");
  }
});

test("mapRuntimeNotification: turn/completed reports failure with carried error message", () => {
  const result = mapRuntimeNotification(activeTurn, {
    method: "turn/completed",
    params: { turn: { status: "failed", error: { message: "boom" } } }
  });
  expect(result.kind).toBe("turn-completed");
  if (result.kind === "turn-completed") {
    expect(result.completed).toBe(false);
    expect(result.failureMessage).toBe("boom");
  }
});

test("mapRuntimeNotification: unknown method returns none", () => {
  const result = mapRuntimeNotification(activeTurn, { method: "totally/unknown" });
  expect(result.kind).toBe("none");
});

test("mapRuntimeNotification: item/completed mcp tool call serializes error into output", () => {
  const result = mapRuntimeNotification(activeTurn, {
    method: "item/completed",
    params: {
      item: {
        type: "mcpToolCall",
        id: "m1",
        server: "srv",
        tool: "fn",
        status: "failed",
        error: { code: "denied", message: "no" }
      }
    }
  });
  expect(result.kind).toBe("tool");
  if (result.kind === "tool") {
    expect(result.toolCall.output).toBe(JSON.stringify({ code: "denied", message: "no" }));
    expect(result.toolCall.title).toBe("Tool: fn");
  }
});

test("mapRuntimeNotification: item/completed mcp tool call without server/tool uses defaults", () => {
  const result = mapRuntimeNotification(activeTurn, {
    method: "item/completed",
    params: { item: { type: "mcpToolCall", id: "m1", status: "completed" } }
  });
  expect(result.kind).toBe("tool");
  if (result.kind === "tool") {
    expect(result.toolCall.title).toBe("MCP tool call");
    expect(result.toolCall.output).toBe("");
    expect(result.toolCall.input).toBe("");
  }
});
