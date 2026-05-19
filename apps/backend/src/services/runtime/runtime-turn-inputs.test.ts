import { test, expect } from "vitest";

import type { ResolvedRuntimePolicy } from "../admin-config-records.js";

import { buildTurnInputs } from "./runtime-turn-inputs.js";

function profile(overrides: Partial<ResolvedRuntimePolicy> = {}): ResolvedRuntimePolicy {
  return {
    id: "default",
    label: "Default",
    description: null,
    runtimeProvider: "codex",
    approvalPolicy: "auto",
    approvalReviewer: "user",
    sandboxMode: "workspace-write",
    networkMode: "restricted",
    allowCommandExecution: true,
    allowUserTokenForwarding: false,
    autoApproveReadOnlyTools: false,
    developerInstructions: null,
    enabledToolIds: [],
    enabledMcpServers: [],
    version: 1,
    hash: "h",
    ...overrides
  };
}

test("uses bare prompt when there are no enabled MCP servers", () => {
  const out = buildTurnInputs({
    prompt: "do thing",
    runtimePolicy: profile({ enabledMcpServers: [] }),
    toolContextId: "ctx-1"
  });
  expect(out.length).toBe(1);
  expect(out[0].type).toBe("text");
  if (out[0].type === "text") {
    expect(out[0].text).toBe("do thing");
    expect(out[0].text_elements).toEqual([]);
  }
});

test("uses bare prompt when toolContextId is null even if MCP servers are enabled", () => {
  const out = buildTurnInputs({
    prompt: "ask",
    runtimePolicy: profile({ enabledMcpServers: ["srv"] }),
    toolContextId: null
  });
  expect(out.length).toBe(1);
  if (out[0].type === "text") {
    expect(out[0].text).toBe("ask");
  }
});

test("prepends framework context when MCP servers are enabled and a tool context exists", () => {
  const out = buildTurnInputs({
    prompt: "do",
    runtimePolicy: profile({ id: "prof-7", enabledMcpServers: ["srv"] }),
    toolContextId: "ctx-9"
  });
  expect(out.length).toBe(1);
  if (out[0].type === "text") {
    expect(out[0].text).toMatch(/Framework turn context:/);
    expect(out[0].text).toMatch(/runtimePolicyId: prof-7/);
    expect(out[0].text).toMatch(/toolContextId: ctx-9/);
    // Original prompt comes last
    expect(out[0].text).toMatch(/\ndo$/);
  }
});

test("preserves provided userInputs and only wraps the FIRST text entry with framework context", () => {
  const out = buildTurnInputs({
    prompt: "ignored when userInputs present",
    userInputs: [
      { type: "text", text: "first text" },
      { type: "text", text: "second text" },
      { type: "image", url: "https://example.com/x.png" },
      { type: "localImage", path: "/tmp/y.png" }
    ],
    runtimePolicy: profile({ enabledMcpServers: ["srv"] }),
    toolContextId: "ctx-1"
  });
  expect(out.length).toBe(4);
  if (out[0].type === "text") {
    expect(out[0].text).toMatch(/Framework turn context:/);
    expect(out[0].text).toMatch(/\nfirst text$/);
  }
  if (out[1].type === "text") {
    // Subsequent texts are passed through unchanged
    expect(out[1].text).toBe("second text");
  }
  expect(out[2]).toEqual({ type: "image", url: "https://example.com/x.png" });
  expect(out[3]).toEqual({ type: "localImage", path: "/tmp/y.png" });
});

test("falls back to the prompt when userInputs is an empty array", () => {
  const out = buildTurnInputs({
    prompt: "fallback",
    userInputs: [],
    runtimePolicy: profile(),
    toolContextId: null
  });
  expect(out.length).toBe(1);
  if (out[0].type === "text") {
    expect(out[0].text).toBe("fallback");
  }
});

test("first text element of userInputs gets wrapped even at index 0", () => {
  const out = buildTurnInputs({
    prompt: "x",
    userInputs: [{ type: "text", text: "wrap me" }],
    runtimePolicy: profile({ enabledMcpServers: ["srv"] }),
    toolContextId: "ctx"
  });
  if (out[0].type === "text") {
    expect(out[0].text).toMatch(/wrap me$/);
    expect(out[0].text).toMatch(/Framework turn context:/);
  }
});
