import { test, expect } from "vitest";

import { parseRuntimePolicySnapshot } from "./admin-config-records.js";

const ctx = { toolContextId: "ctx-test" };

test("parseRuntimePolicySnapshot throws a clear error when the snapshot is missing", () => {
  expect(() => parseRuntimePolicySnapshot(undefined, ctx)).toThrow(
    /Runtime policy snapshot missing for tool context ctx-test/
  );
  expect(() => parseRuntimePolicySnapshot(null, ctx)).toThrow();
  expect(() => parseRuntimePolicySnapshot("not an object", ctx)).toThrow();
});

test("parseRuntimePolicySnapshot decodes a fully-populated snapshot", () => {
  const result = parseRuntimePolicySnapshot(
    {
      id: "tenant-settings:t-1",
      label: "Tenant Settings",
      description: "the desc",
      runtimeProvider: "claude-code",
      approvalPolicy: "on-request",
      approvalReviewer: "guardian_subagent",
      sandboxMode: "workspace-write",
      networkMode: "restricted",
      allowCommandExecution: true,
      allowUserTokenForwarding: false,
      autoApproveReadOnlyTools: true,
      developerInstructions: "do the thing",
      enabledToolIds: ["session_context", "write_artifact"],
      enabledMcpServers: ["github"],
      version: 7,
      hash: "abc123"
    },
    ctx
  );

  expect(result).toEqual({
    id: "tenant-settings:t-1",
    label: "Tenant Settings",
    description: "the desc",
    runtimeProvider: "claude-code",
    approvalPolicy: "on-request",
    approvalReviewer: "guardian_subagent",
    sandboxMode: "workspace-write",
    networkMode: "restricted",
    allowCommandExecution: true,
    allowUserTokenForwarding: false,
    autoApproveReadOnlyTools: true,
    developerInstructions: "do the thing",
    enabledToolIds: ["session_context", "write_artifact"],
    enabledMcpServers: ["github"],
    version: 7,
    hash: "abc123"
  });
});

test("parseRuntimePolicySnapshot accepts a granular approval policy object", () => {
  const granular = { granular: { command_execution: "always" } };
  const result = parseRuntimePolicySnapshot(
    {
      id: "x",
      runtimeProvider: "codex",
      approvalPolicy: granular
    },
    ctx
  );
  expect(result.approvalPolicy).toEqual(granular);
});

test("parseRuntimePolicySnapshot maps unknown enums to safe defaults", () => {
  const result = parseRuntimePolicySnapshot(
    {
      id: "x",
      runtimeProvider: "future-provider",
      approvalPolicy: "future-policy",
      approvalReviewer: "future-reviewer",
      autoApproveReadOnlyTools: "yes" // truthy non-bool
    },
    ctx
  );
  expect(result.runtimeProvider).toBe("codex");
  expect(result.approvalPolicy).toBe("never");
  expect(result.approvalReviewer).toBe("user");
  expect(result.autoApproveReadOnlyTools).toBe(true);
});

test("parseRuntimePolicySnapshot fills sensible defaults for missing optional fields", () => {
  const result = parseRuntimePolicySnapshot(
    { id: "tenant-settings:t-1", runtimeProvider: "codex" },
    ctx
  );
  expect(result.label).toBe("tenant-settings:t-1");
  expect(result.description).toBeNull();
  expect(result.developerInstructions).toBeNull();
  expect(result.allowCommandExecution).toBe(false);
  expect(result.allowUserTokenForwarding).toBe(false);
  expect(result.autoApproveReadOnlyTools).toBe(false);
  expect(result.enabledToolIds).toEqual([]);
  expect(result.enabledMcpServers).toEqual([]);
  expect(result.version).toBe(1);
  expect(result.hash).toBe("");
  expect(result.sandboxMode).toBe("workspace-write");
  expect(result.networkMode).toBe("restricted");
});

test("parseRuntimePolicySnapshot drops non-string entries from the array fields", () => {
  const result = parseRuntimePolicySnapshot(
    {
      id: "x",
      runtimeProvider: "codex",
      enabledToolIds: ["valid", 42, null, undefined, "another"],
      enabledMcpServers: [{ obj: "nope" }, "real-server"]
    },
    ctx
  );
  expect(result.enabledToolIds).toEqual(["valid", "another"]);
  expect(result.enabledMcpServers).toEqual(["real-server"]);
});
