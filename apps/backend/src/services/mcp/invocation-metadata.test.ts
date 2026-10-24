import { describe, expect, it } from "vitest";

import {
  MCP_INVOCATION_META_KEY,
  readInvocationMetadata,
  withInvocationMetadata,
  withoutInvocationMetadata
} from "./invocation-metadata.js";

describe("readInvocationMetadata", () => {
  it("reads the trusted entry and ignores other request metadata", () => {
    expect(readInvocationMetadata({ name: "echo", _meta: { progressToken: 1,
      [MCP_INVOCATION_META_KEY]: { toolContextId: "ctx_1", policyApprovalId: "polapr_1" } } }))
      .toEqual({ ok: true, metadata: { toolContextId: "ctx_1", policyApprovalId: "polapr_1" } });
    expect(readInvocationMetadata({ name: "echo", _meta: { progressToken: 1 } })).toEqual({ ok: true, metadata: null });
    expect(readInvocationMetadata({ name: "echo" })).toEqual({ ok: true, metadata: null });
    expect(readInvocationMetadata(undefined)).toEqual({ ok: true, metadata: null });
  });

  it("does not read an inherited key", () => {
    const meta = Object.create({ [MCP_INVOCATION_META_KEY]: { toolContextId: "ctx_inherited" } }) as Record<string, unknown>;
    expect(readInvocationMetadata({ _meta: meta })).toEqual({ ok: true, metadata: null });
  });

  it.each([
    ["_meta is not an object", "ctx_1"],
    ["_meta is an array", []],
    ["the entry is not an object", { [MCP_INVOCATION_META_KEY]: "ctx_1" }],
    ["the entry is null", { [MCP_INVOCATION_META_KEY]: null }],
    ["a field is unknown", { [MCP_INVOCATION_META_KEY]: { toolContextId: "ctx_1", sessionId: "s" } }],
    ["the context id is not a string", { [MCP_INVOCATION_META_KEY]: { toolContextId: 1 } }],
    ["the context id has no ctx_ prefix", { [MCP_INVOCATION_META_KEY]: { toolContextId: "context-1" } }],
    ["the context id has other characters", { [MCP_INVOCATION_META_KEY]: { toolContextId: "ctx_1 OR 1=1" } }],
    ["the approval id has no polapr_ prefix", { [MCP_INVOCATION_META_KEY]: { toolContextId: "ctx_1", policyApprovalId: "approval-1" } }],
    ["an approval comes without its context", { [MCP_INVOCATION_META_KEY]: { policyApprovalId: "polapr_1" } }],
    ["an id is too long", { [MCP_INVOCATION_META_KEY]: { toolContextId: `ctx_${"a".repeat(201)}` } }]
  ])("is malformed when %s", (_case, meta) => {
    expect(readInvocationMetadata({ _meta: meta })).toEqual({ ok: false });
  });
});

describe("withoutInvocationMetadata", () => {
  it("removes only the trusted entry", () => {
    expect(withoutInvocationMetadata({ name: "echo", arguments: { a: 1 },
      _meta: { progressToken: 1, [MCP_INVOCATION_META_KEY]: { toolContextId: "ctx_1" } } }))
      .toEqual({ name: "echo", arguments: { a: 1 }, _meta: { progressToken: 1 } });
  });

  it("drops a _meta that held only the trusted entry", () => {
    expect(withoutInvocationMetadata({ name: "echo", _meta: { [MCP_INVOCATION_META_KEY]: { toolContextId: "ctx_1" } } }))
      .toEqual({ name: "echo" });
  });

  it("returns params without the entry unchanged", () => {
    const params = { name: "echo", _meta: { progressToken: 1 } };
    expect(withoutInvocationMetadata(params)).toBe(params);
  });
});

describe("withInvocationMetadata", () => {
  it("replaces a value that was already there and keeps other entries", () => {
    const params = { name: "echo", _meta: { progressToken: 1, [MCP_INVOCATION_META_KEY]: { toolContextId: "ctx_forged" } } };
    expect(withInvocationMetadata(params, { toolContextId: "ctx_trusted" }))
      .toEqual({ name: "echo", _meta: { progressToken: 1, [MCP_INVOCATION_META_KEY]: { toolContextId: "ctx_trusted" } } });
    // The input is not changed.
    expect(params._meta[MCP_INVOCATION_META_KEY]).toEqual({ toolContextId: "ctx_forged" });
  });

  it("removes the entry when there are no trusted values", () => {
    const params = { name: "echo", _meta: { [MCP_INVOCATION_META_KEY]: { toolContextId: "ctx_forged" } } };
    expect(withInvocationMetadata(params, undefined)).toEqual({ name: "echo" });
    expect(withInvocationMetadata(params, {})).toEqual({ name: "echo" });
  });
});
