import { test, expect } from "vitest";

import { parseRuntimePolicySnapshot } from "./admin-config-records.js";
import { UnreadableControlValueError } from "./admin-config-store-mappers.js";

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
      webSearchMode: "live",
      approvalPolicy: "on-request",
      approvalReviewer: "guardian_subagent",
      sandboxMode: "workspace-write",
      sandboxEgressDomains: ["pypi.org", "*.example.com"],
      allowCommandExecution: true,
      autoApproveReadOnlyTools: true,
      policyEnforcementMode: "enforce",
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
    webSearchMode: "live",
    approvalPolicy: "on-request",
    approvalReviewer: "guardian_subagent",
    sandboxMode: "workspace-write",
    sandboxEgressDomains: ["pypi.org", "*.example.com"],
    allowCommandExecution: true,
    autoApproveReadOnlyTools: true,
    policyEnforcementMode: "enforce",
    developerInstructions: "do the thing",
    enabledToolIds: ["session_context", "write_artifact"],
    enabledMcpServers: ["github"],
    version: 7,
    hash: "abc123"
  });
});

// The four closed-set controls that the current writer puts in every snapshot.
const CONTROLS = {
  webSearchMode: "disabled",
  approvalPolicy: "on-request",
  approvalReviewer: "user",
  policyEnforcementMode: "monitor"
} as const;

test("parseRuntimePolicySnapshot accepts a granular approval policy object", () => {
  const granular = { granular: { sandbox_approval: true, mcp_elicitations: false, rules: true } };
  const result = parseRuntimePolicySnapshot({ id: "x", ...CONTROLS, approvalPolicy: granular }, ctx);
  expect(result.approvalPolicy).toEqual(granular);
});

// Before issue #121 an unknown value read as a default: "monitor" (the gateway
// gated nothing), "never" (no approvals), "user", "disabled". Now a missing or
// unknown control throws, and the gateway refuses the tool call.
test.each([
  ["policyEnforcementMode", "strict"],
  ["policyEnforcementMode", undefined],
  ["approvalPolicy", "future-policy"],
  ["approvalPolicy", { granular: { command_execution: "always" } }],
  ["approvalPolicy", { granular: { sandbox_approval: true, mcp_elicitations: true, rules: true, future_switch: true } }],
  ["approvalPolicy", { granular: { sandbox_approval: true, mcp_elicitations: true, rules: true }, future_mode: "always" }],
  ["approvalReviewer", "future-reviewer"],
  ["webSearchMode", "everywhere"],
  ["webSearchMode", undefined]
])("parseRuntimePolicySnapshot refuses %s = %j and names only the field", (field, value) => {
  let error: unknown;
  try {
    parseRuntimePolicySnapshot({ id: "x", ...CONTROLS, [field]: value }, ctx);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(UnreadableControlValueError);
  expect(error).toMatchObject({ source: "runtime policy snapshot", field });
  expect((error as Error).message).not.toMatch(/strict|future|everywhere|always/);
});

test("parseRuntimePolicySnapshot reads every valid enforcement mode and web search mode", () => {
  for (const mode of ["monitor", "enforce"] as const) {
    expect(parseRuntimePolicySnapshot({ id: "x", ...CONTROLS, policyEnforcementMode: mode }, ctx).policyEnforcementMode)
      .toBe(mode);
  }
  for (const mode of ["disabled", "cached", "live"] as const) {
    expect(parseRuntimePolicySnapshot({ id: "x", ...CONTROLS, webSearchMode: mode }, ctx).webSearchMode).toBe(mode);
  }
});

test("parseRuntimePolicySnapshot keeps the safe reading of fields that are not closed sets", () => {
  const result = parseRuntimePolicySnapshot(
    { id: "tenant-settings:t-1", ...CONTROLS, autoApproveReadOnlyTools: "yes" },
    ctx
  );
  expect(result.label).toBe("tenant-settings:t-1");
  expect(result.description).toBeNull();
  expect(result.developerInstructions).toBeNull();
  expect(result.allowCommandExecution).toBe(false);
  // Boolean() does not check the type: a truthy non-boolean reads as true.
  expect(result.autoApproveReadOnlyTools).toBe(true);
  expect(result.enabledToolIds).toEqual([]);
  expect(result.enabledMcpServers).toEqual([]);
  expect(result.version).toBe(1);
  expect(result.hash).toBe("");
  expect(result.sandboxMode).toBe("workspace-write");
  // A snapshot without the field gives the strictest policy: no network.
  expect(result.sandboxEgressDomains).toEqual([]);
});

test("parseRuntimePolicySnapshot keeps string sandbox hosts and drops the rest", () => {
  const result = parseRuntimePolicySnapshot(
    { id: "x", ...CONTROLS, sandboxEgressDomains: ["pypi.org", 42, null, "*.example.com"] },
    ctx
  );
  expect(result.sandboxEgressDomains).toEqual(["pypi.org", "*.example.com"]);
  // A value that is not a list reads as no hosts, not as an error.
  expect(parseRuntimePolicySnapshot({ id: "x", ...CONTROLS, sandboxEgressDomains: "pypi.org" }, ctx).sandboxEgressDomains)
    .toEqual([]);
});

test("parseRuntimePolicySnapshot drops non-string entries from the array fields", () => {
  const result = parseRuntimePolicySnapshot(
    {
      id: "x",
      ...CONTROLS,
      enabledToolIds: ["valid", 42, null, undefined, "another"],
      enabledMcpServers: [{ obj: "nope" }, "real-server"]
    },
    ctx
  );
  expect(result.enabledToolIds).toEqual(["valid", "another"]);
  expect(result.enabledMcpServers).toEqual(["real-server"]);
});
