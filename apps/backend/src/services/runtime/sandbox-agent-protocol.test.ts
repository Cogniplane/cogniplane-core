import { test, expect } from "vitest";
import {
  encodeInboundFrame,
  parseOutboundFrame,
  type SandboxInboundFrame
} from "./sandbox-agent-protocol.js";

test("parseOutboundFrame returns ready frame with sdk + node versions", () => {
  const frame = parseOutboundFrame(
    JSON.stringify({ type: "ready", sdkVersion: "0.2.109", nodeVersion: "v24.0.0" })
  );
  expect(frame).toBeTruthy();
  expect(frame.type).toBe("ready");
  if (frame.type === "ready") {
    expect(frame.sdkVersion).toBe("0.2.109");
    expect(frame.nodeVersion).toBe("v24.0.0");
  }
});

test("parseOutboundFrame accepts sdk_message with arbitrary payload", () => {
  const frame = parseOutboundFrame(
    JSON.stringify({
      type: "sdk_message",
      turnId: "t-1",
      payload: { type: "system", subtype: "init", tools: [] }
    })
  );
  expect(frame).toBeTruthy();
  expect(frame.type).toBe("sdk_message");
});

test("parseOutboundFrame accepts approval_request and preserves toolInput", () => {
  const input = { command: "rm -rf /", reason: "cleanup" };
  const frame = parseOutboundFrame(
    JSON.stringify({
      type: "approval_request",
      approvalId: "a-1",
      toolName: "Bash",
      toolInput: input,
      kind: "command_execution"
    })
  );
  expect(frame).toBeTruthy();
  expect(frame.type).toBe("approval_request");
  if (frame.type === "approval_request") {
    expect(frame.toolInput).toEqual(input);
    expect(frame.kind).toBe("command_execution");
  }
});

test("parseOutboundFrame returns null for unknown type", () => {
  const frame = parseOutboundFrame(JSON.stringify({ type: "mystery", x: 1 }));
  expect(frame).toBe(null);
});

test("parseOutboundFrame returns null for non-JSON lines", () => {
  // The harness may see stray stdout from the SDK or Node itself. The
  // parser must not throw on these — it just returns null and the caller
  // logs the line for diagnostics.
  expect(parseOutboundFrame("not json")).toBe(null);
  expect(parseOutboundFrame("")).toBe(null);
  expect(parseOutboundFrame("   ")).toBe(null);
  expect(parseOutboundFrame("(node:123) warning: something")).toBe(null);
});

test("encodeInboundFrame appends newline for stdin dispatch", () => {
  const frame: SandboxInboundFrame = {
    type: "approval_response",
    approvalId: "a-1",
    decision: "approve"
  };
  const encoded = encodeInboundFrame(frame);
  expect(encoded.endsWith("\n")).toBeTruthy();
  expect(JSON.parse(encoded.trim())).toEqual(frame);
});

test("encodeInboundFrame roundtrips a turn frame", () => {
  const turn: SandboxInboundFrame = {
    type: "turn",
    turnId: "t-1",
    prompt: "hello",
    contentBlocks: [{ type: "text", text: "hello" }],
    toolContextId: "ctx-1",
    resumeSessionId: null,
    model: "claude-sonnet-4-6",
    developerInstructions: null,
    mcpServers: [],
    enabledToolIds: ["write_artifact"],
    bypass: false,
    autoApproveReadOnly: true,
    readOnlyManagedToolNames: ["list_artifacts"]
  };
  const encoded = encodeInboundFrame(turn);
  expect(JSON.parse(encoded.trim())).toEqual(turn);
});
