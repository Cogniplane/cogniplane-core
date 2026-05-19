import { describe, test, expect } from "vitest";

import { ClaudeApprovalHandler, type ClaudeApprovalEvent } from "./claude-code-approval-handler.js";

describe("ClaudeApprovalHandler", () => {
  test("canUseTool creates pending approval and blocks until resolved with approve", async () => {
    const handler = new ClaudeApprovalHandler();
    const events: ClaudeApprovalEvent[] = [];
    handler.onApprovalRequired((event) => { events.push(event); });

    const resultPromise = handler.canUseTool("Bash", { command: "ls" }, { signal: AbortSignal.timeout(5000) });

    // Give the microtask a tick to emit the event
    await new Promise((r) => setTimeout(r, 10));
    expect(events.length).toBe(1);
    expect(events[0].kind).toBe("command_execution");
    expect(handler.pendingCount).toBe(1);

    handler.resolveApproval(events[0].approvalId, "approve");
    const result = await resultPromise;
    expect(result.behavior).toBe("allow");
    expect(handler.pendingCount).toBe(0);
  });

  test("canUseTool returns deny when rejected", async () => {
    const handler = new ClaudeApprovalHandler();
    const events: ClaudeApprovalEvent[] = [];
    handler.onApprovalRequired((event) => { events.push(event); });

    const resultPromise = handler.canUseTool("Write", { file_path: "/etc/passwd" }, { signal: AbortSignal.timeout(5000) });
    await new Promise((r) => setTimeout(r, 10));

    handler.resolveApproval(events[0].approvalId, "reject");
    const result = await resultPromise;
    expect(result.behavior).toBe("deny");
  });

  test("classifies tool kinds correctly", () => {
    const handler = new ClaudeApprovalHandler();
    expect(handler.classifyToolKind("Bash")).toBe("command_execution");
    expect(handler.classifyToolKind("Write")).toBe("file_change");
    expect(handler.classifyToolKind("Edit")).toBe("file_change");
    expect(handler.classifyToolKind("NotebookEdit")).toBe("file_change");
    expect(handler.classifyToolKind("MultiEdit")).toBe("file_change");
    expect(handler.classifyToolKind("Read")).toBe("command_execution");
    expect(handler.classifyToolKind("Glob")).toBe("command_execution");
  });

  test("resolveApproval returns false for unknown id", () => {
    const handler = new ClaudeApprovalHandler();
    expect(handler.resolveApproval("nonexistent", "approve")).toBe(false);
  });

  test("auto-approves read-only tools when enabled", async () => {
    const handler = new ClaudeApprovalHandler();
    handler.setAutoApproveReadOnly(true);
    const events: ClaudeApprovalEvent[] = [];
    handler.onApprovalRequired((event) => { events.push(event); });

    const result = await handler.canUseTool("Read", { file_path: "/tmp/test" }, { signal: AbortSignal.timeout(5000) });
    expect(result.behavior).toBe("allow");
    expect(events.length).toBe(0);
    expect(handler.pendingCount).toBe(0);
  });

  test("auto-approve read-only does not affect write tools", async () => {
    const handler = new ClaudeApprovalHandler();
    handler.setAutoApproveReadOnly(true);
    const events: ClaudeApprovalEvent[] = [];
    handler.onApprovalRequired((event) => { events.push(event); });

    const resultPromise = handler.canUseTool("Write", { file_path: "/tmp/test" }, { signal: AbortSignal.timeout(5000) });
    await new Promise((r) => setTimeout(r, 10));
    expect(events.length).toBe(1);
    expect(handler.pendingCount).toBe(1);

    handler.resolveApproval(events[0].approvalId, "approve");
    const result = await resultPromise;
    expect(result.behavior).toBe("allow");
  });

  test("read-only tools require approval when auto-approve is disabled", async () => {
    const handler = new ClaudeApprovalHandler();
    // autoApproveReadOnly defaults to false
    const events: ClaudeApprovalEvent[] = [];
    handler.onApprovalRequired((event) => { events.push(event); });

    const resultPromise = handler.canUseTool("Glob", { pattern: "*.ts" }, { signal: AbortSignal.timeout(5000) });
    await new Promise((r) => setTimeout(r, 10));
    expect(events.length).toBe(1);
    expect(handler.pendingCount).toBe(1);

    handler.resolveApproval(events[0].approvalId, "approve");
    await resultPromise;
  });

  test("canUseTool denies after wall-clock TTL elapses", async () => {
    const handler = new ClaudeApprovalHandler();
    handler.setApprovalTtlMs(20);
    handler.onApprovalRequired(() => {});

    // No abort signal at all — confirms the wall-clock timer is independent.
    const resultPromise = handler.canUseTool("Bash", { command: "ls" }, { signal: new AbortController().signal });
    const result = await resultPromise;

    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      expect(result.message).toMatch(/timed out/i);
    }
    expect(handler.pendingCount).toBe(0);
  });

  test("clearAll denies all pending approvals", async () => {
    const handler = new ClaudeApprovalHandler();
    handler.onApprovalRequired(() => {});

    const p1 = handler.canUseTool("Bash", {}, { signal: AbortSignal.timeout(5000) });
    const p2 = handler.canUseTool("Write", {}, { signal: AbortSignal.timeout(5000) });
    await new Promise((r) => setTimeout(r, 10));
    expect(handler.pendingCount).toBe(2);

    handler.clearAll();
    expect(handler.pendingCount).toBe(0);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.behavior).toBe("deny");
    expect(r2.behavior).toBe("deny");
  });

  test("bypass mode: every call is auto-allowed without an approval event", async () => {
    const handler = new ClaudeApprovalHandler();
    handler.setBypass(true);
    const events: ClaudeApprovalEvent[] = [];
    handler.onApprovalRequired((e) => events.push(e));

    const r = await handler.canUseTool("Bash", { command: "rm -rf /" }, { signal: AbortSignal.timeout(5000) });
    expect(r.behavior).toBe("allow");
    expect(events).toHaveLength(0);
  });

  test("bypass mode injects toolContextId into MCP tool inputs", async () => {
    const handler = new ClaudeApprovalHandler();
    handler.setBypass(true);
    handler.setToolContextId("ctx-123");

    const r = await handler.canUseTool(
      "mcp__github__list_repos",
      { owner: "x" },
      { signal: AbortSignal.timeout(5000) }
    );
    expect(r.behavior).toBe("allow");
    if (r.behavior !== "allow") return;
    expect(r.updatedInput.toolContextId).toBe("ctx-123");
    expect(r.updatedInput.owner).toBe("x");
  });

  test("toolContextId injection skips non-MCP tools", async () => {
    const handler = new ClaudeApprovalHandler();
    handler.setAutoApproveReadOnly(true);
    handler.setToolContextId("ctx-abc");

    const r = await handler.canUseTool("Read", { file_path: "/tmp/x" }, { signal: AbortSignal.timeout(5000) });
    expect(r.behavior).toBe("allow");
    if (r.behavior !== "allow") return;
    expect(r.updatedInput.toolContextId).toBeUndefined();
  });

  test("toolContextId injection preserves an existing value on the input", async () => {
    const handler = new ClaudeApprovalHandler();
    handler.setBypass(true);
    handler.setToolContextId("ctx-new");

    const r = await handler.canUseTool(
      "mcp__github__list_repos",
      { toolContextId: "ctx-existing", owner: "x" },
      { signal: AbortSignal.timeout(5000) }
    );
    expect(r.behavior).toBe("allow");
    if (r.behavior !== "allow") return;
    expect(r.updatedInput.toolContextId).toBe("ctx-existing");
  });

  test("autoApproveReadOnly + readOnlyManagedToolNames auto-allows known read-only MCP tool", async () => {
    const handler = new ClaudeApprovalHandler();
    handler.setAutoApproveReadOnly(true);
    handler.setReadOnlyManagedToolNames(["session_context", "list_artifacts"]);
    handler.setToolContextId("ctx-1");

    const r = await handler.canUseTool(
      "mcp__cogniplane__session_context",
      {},
      { signal: AbortSignal.timeout(5000) }
    );
    expect(r.behavior).toBe("allow");
    if (r.behavior !== "allow") return;
    expect(r.updatedInput.toolContextId).toBe("ctx-1");
  });

  test("MCP write-mode managed tool falls through to approval flow even with autoApproveReadOnly", async () => {
    const handler = new ClaudeApprovalHandler();
    handler.setAutoApproveReadOnly(true);
    handler.setReadOnlyManagedToolNames(["session_context"]);
    const events: ClaudeApprovalEvent[] = [];
    handler.onApprovalRequired((e) => events.push(e));

    const p = handler.canUseTool(
      "mcp__cogniplane__write_artifact",
      {},
      { signal: AbortSignal.timeout(5000) }
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toHaveLength(1);
    handler.resolveApproval(events[0]!.approvalId, "approve");
    const r = await p;
    expect(r.behavior).toBe("allow");
  });

  test("MCP tool with non-standard prefix shape goes through approval (extractManagedToolName returns null)", async () => {
    const handler = new ClaudeApprovalHandler();
    handler.setAutoApproveReadOnly(true);
    handler.setReadOnlyManagedToolNames(["session_context"]);
    const events: ClaudeApprovalEvent[] = [];
    handler.onApprovalRequired((e) => events.push(e));

    // No `__` separator after the server prefix → extractManagedToolName -> null
    const p = handler.canUseTool(
      "mcp__weirdname",
      {},
      { signal: AbortSignal.timeout(5000) }
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toHaveLength(1);
    handler.resolveApproval(events[0]!.approvalId, "approve");
    await p;
  });

  test("rate limit: rejects when more than MAX_PENDING_APPROVALS_PER_SESSION concurrent approvals", async () => {
    const handler = new ClaudeApprovalHandler();
    handler.onApprovalRequired(() => {});
    // 5 pending approvals
    const ps = Array.from({ length: 5 }, (_, i) =>
      handler.canUseTool("Bash", { i }, { signal: AbortSignal.timeout(5000) })
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(handler.pendingCount).toBe(5);

    const r = await handler.canUseTool("Bash", { extra: true }, { signal: AbortSignal.timeout(5000) });
    expect(r.behavior).toBe("deny");
    if (r.behavior !== "deny") return;
    expect(r.message).toMatch(/Approval rate limit reached/);

    handler.clearAll();
    await Promise.all(ps);
  });

  test("rememberForTurn approves the same kind without prompting again", async () => {
    const handler = new ClaudeApprovalHandler();
    const events: ClaudeApprovalEvent[] = [];
    handler.onApprovalRequired((e) => events.push(e));

    // First Bash (command_execution) — approve with rememberForTurn=true
    const p1 = handler.canUseTool("Bash", {}, { signal: AbortSignal.timeout(5000) });
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toHaveLength(1);
    handler.resolveApproval(events[0]!.approvalId, "approve", true);
    expect((await p1).behavior).toBe("allow");

    // Second Bash — should NOT prompt; auto-allowed by remembered kind
    const r2 = await handler.canUseTool("Bash", { ls: true }, { signal: AbortSignal.timeout(5000) });
    expect(r2.behavior).toBe("allow");
    expect(events).toHaveLength(1); // still 1 — no new prompt

    // Different kind (file_change via Write) — still prompts
    const p3 = handler.canUseTool("Write", {}, { signal: AbortSignal.timeout(5000) });
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toHaveLength(2);
    handler.resolveApproval(events[1]!.approvalId, "approve");
    await p3;
  });

  test("clearAutoApprovedKindsForTurn forgets the remembered approval", async () => {
    const handler = new ClaudeApprovalHandler();
    const events: ClaudeApprovalEvent[] = [];
    handler.onApprovalRequired((e) => events.push(e));

    const p1 = handler.canUseTool("Bash", {}, { signal: AbortSignal.timeout(5000) });
    await new Promise((r) => setTimeout(r, 10));
    handler.resolveApproval(events[0]!.approvalId, "approve", true);
    await p1;

    handler.clearAutoApprovedKindsForTurn();

    const p2 = handler.canUseTool("Bash", {}, { signal: AbortSignal.timeout(5000) });
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toHaveLength(2); // new prompt fired
    handler.resolveApproval(events[1]!.approvalId, "approve");
    await p2;
  });

  test("AbortSignal abort denies the pending approval and cleans up", async () => {
    const handler = new ClaudeApprovalHandler();
    handler.onApprovalRequired(() => {});
    const ctrl = new AbortController();

    const p = handler.canUseTool("Bash", {}, { signal: ctrl.signal });
    await new Promise((r) => setTimeout(r, 10));
    expect(handler.pendingCount).toBe(1);
    ctrl.abort();
    const r = await p;
    expect(r.behavior).toBe("deny");
    if (r.behavior !== "deny") return;
    expect(r.message).toBe("Aborted.");
    expect(handler.pendingCount).toBe(0);
  });

  test("AbortSignal already aborted at canUseTool entry denies immediately", async () => {
    const handler = new ClaudeApprovalHandler();
    handler.onApprovalRequired(() => {});
    const ctrl = new AbortController();
    ctrl.abort(); // pre-aborted

    const r = await handler.canUseTool("Bash", {}, { signal: ctrl.signal });
    expect(r.behavior).toBe("deny");
    expect(handler.pendingCount).toBe(0);
  });

  test("setApprovalTtlMs ignores non-positive values", async () => {
    const handler = new ClaudeApprovalHandler();
    // Set to a known-good value
    handler.setApprovalTtlMs(50);
    handler.setApprovalTtlMs(0); // ignored
    handler.setApprovalTtlMs(-100); // ignored
    handler.onApprovalRequired(() => {});

    const start = Date.now();
    const r = await handler.canUseTool("Bash", {}, { signal: new AbortController().signal });
    const elapsed = Date.now() - start;
    expect(r.behavior).toBe("deny");
    expect(elapsed).toBeGreaterThanOrEqual(40); // ~50ms TTL still in effect
    expect(elapsed).toBeLessThan(500);
  });
});
