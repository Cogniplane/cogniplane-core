import { test, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdir, writeFile, rm } from "node:fs/promises";

import { E2bClaudeRuntimeProcess, SANDBOX_AGENT_PATH } from "./e2b-claude-runtime-process.js";
import type { SandboxTurnFrame } from "./sandbox-agent-protocol.js";

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => silentLog,
  level: "silent"
} as unknown as import("fastify").FastifyBaseLogger;

type HandleCallbacks = {
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
};

function createFakeSandbox() {
  const stdinLines: string[] = [];
  const callbacks: HandleCallbacks = {};
  const writes: Array<{ path: string; data: string | ArrayBuffer }> = [];

  const sandbox = {
    sandboxId: "sbx-fake",
    files: {
      write: async (files: Array<{ path: string; data: string | ArrayBuffer }>) => {
        writes.push(...files);
      },
      read: async () => new Uint8Array()
    },
    commands: {
      run: async (cmd: string, options?: HandleCallbacks) => {
        expect(cmd).toBe(`node ${SANDBOX_AGENT_PATH}`);
        if (options?.onStdout) callbacks.onStdout = options.onStdout;
        if (options?.onStderr) callbacks.onStderr = options.onStderr;
        return {
          pid: 4242,
          wait: () => new Promise<never>(() => {})
        };
      },
      sendStdin: async (_pid: number, data: string) => {
        stdinLines.push(data);
      },
      list: async () => []
    },
    kill: async () => {}
  };

  return { sandbox, stdinLines, callbacks, writes };
}

async function makeStagingDir(prefix: string): Promise<string> {
  const dir = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random()}`);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "CLAUDE.md"), "# test");
  return dir;
}

function turnFrame(turnId: string, overrides: Partial<SandboxTurnFrame> = {}): SandboxTurnFrame {
  return {
    type: "turn",
    turnId,
    prompt: "hi",
    contentBlocks: [{ type: "text", text: "hi" }],
    toolContextId: "ctx-1",
    resumeSessionId: null,
    model: "claude-sonnet-4-6",
    developerInstructions: null,
    mcpServers: [],
    enabledToolIds: [],
    bypass: false,
    autoApproveReadOnly: false,
    readOnlyManagedToolNames: [],
    ...overrides
  };
}

test("E2bClaudeRuntimeProcess uploads workspace and starts the harness", async () => {
  const staging = await makeStagingDir("claude-e2b-upload");
  try {
    const { sandbox, callbacks, writes } = createFakeSandbox();

    const proc = await E2bClaudeRuntimeProcess.start({
      e2bApiKey: "k",
      e2bTemplateId: "tpl",
      e2bSandboxTimeoutMs: 60000,
      workspacePath: "/home/user/workspace/sess-1",
      localWorkspacePath: staging,
      logger: silentLog,
      sessionId: "sess-1",
      runtimeId: "claude-1",
      loadSandboxClass: async () => ({ create: async () => sandbox })
    });

    expect(proc.isAlive()).toBeTruthy();
    expect(typeof callbacks.onStdout === "function").toBeTruthy();
    expect(writes.length).toBe(1);
    expect(writes[0]?.path).toBe("/home/user/workspace/sess-1/CLAUDE.md");
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
});

test("E2bClaudeRuntimeProcess runTurn round-trips sdk_message and turn_complete frames", async () => {
  const staging = await makeStagingDir("claude-e2b-turn");
  try {
    const { sandbox, stdinLines, callbacks } = createFakeSandbox();

    const proc = await E2bClaudeRuntimeProcess.start({
      e2bApiKey: "k",
      e2bTemplateId: "tpl",
      e2bSandboxTimeoutMs: 60000,
      workspacePath: "/home/user/workspace/sess-1",
      localWorkspacePath: staging,
      logger: silentLog,
      sessionId: "sess-1",
      runtimeId: "claude-1",
      loadSandboxClass: async () => ({ create: async () => sandbox })
    });

    const received: Array<Record<string, unknown>> = [];
    let completedSessionId: string | null | undefined;

    const runPromise = proc.runTurn(turnFrame("t-1"), {
      onSdkMessage: (payload) => received.push(payload),
      onApprovalRequest: () => expect.fail("no approvals expected"),
      onComplete: (sid) => {
        completedSessionId = sid;
      },
      onFail: (err) => expect.fail(`unexpected fail: ${err}`)
    });

    // Turn frame must have been serialized to stdin
    const turnLine = stdinLines.find((line) => line.includes('"type":"turn"'));
    expect(turnLine).toBeTruthy();

    // Simulate the harness emitting two sdk_messages then a completion
    callbacks.onStdout?.('{"type":"sdk_message","turnId":"t-1","payload":{"type":"system","subtype":"init","session_id":"claude-xyz"}}\n');
    callbacks.onStdout?.('{"type":"sdk_message","turnId":"t-1","payload":{"type":"assistant","text":"hello"}}\n');
    callbacks.onStdout?.('{"type":"turn_complete","turnId":"t-1","claudeSessionId":"claude-xyz"}\n');

    await runPromise;

    expect(received.length).toBe(2);
    expect((received[0] as { type?: string }).type).toBe("system");
    expect(completedSessionId).toBe("claude-xyz");
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
});

test("E2bClaudeRuntimeProcess forwards approval_request and sends approval_response on user decision", async () => {
  const staging = await makeStagingDir("claude-e2b-approval");
  try {
    const { sandbox, stdinLines, callbacks } = createFakeSandbox();

    const proc = await E2bClaudeRuntimeProcess.start({
      e2bApiKey: "k",
      e2bTemplateId: "tpl",
      e2bSandboxTimeoutMs: 60000,
      workspacePath: "/home/user/workspace/sess-1",
      localWorkspacePath: staging,
      logger: silentLog,
      sessionId: "sess-1",
      runtimeId: "claude-1",
      loadSandboxClass: async () => ({ create: async () => sandbox })
    });

    let approvalSeen:
      | { approvalId: string; toolName: string; kind: string }
      | null = null;

    const runPromise = proc.runTurn(turnFrame("t-2"), {
      onSdkMessage: () => {},
      onApprovalRequest: (frame) => {
        approvalSeen = {
          approvalId: frame.approvalId,
          toolName: frame.toolName,
          kind: frame.kind
        };
        // Simulate user approving via the public API
        void proc.sendApprovalResponse(frame.approvalId, "approve");
      },
      onComplete: () => {},
      onFail: (err) => expect.fail(`unexpected fail: ${err}`)
    });

    callbacks.onStdout?.(
      '{"type":"approval_request","approvalId":"a-1","toolName":"Write","toolInput":{"path":"/tmp/x"},"kind":"file_change"}\n'
    );
    callbacks.onStdout?.('{"type":"turn_complete","turnId":"t-2","claudeSessionId":null}\n');

    await runPromise;

    expect(approvalSeen).toBeTruthy();
    const captured = approvalSeen as unknown as { approvalId: string; toolName: string; kind: string };
    expect(captured.approvalId).toBe("a-1");
    expect(captured.toolName).toBe("Write");
    expect(captured.kind).toBe("file_change");
    // The approval_response must have been serialized to stdin
    const responseLine = stdinLines.find((line) => line.includes('"approval_response"'));
    expect(responseLine).toBeTruthy();
    expect(responseLine!).toMatch(/"decision":"approve"/);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
});

test("turn_complete reconciles an unresolved approval by firing onApprovalExpired", async () => {
  const staging = await makeStagingDir("claude-e2b-reconcile");
  try {
    const { sandbox, callbacks } = createFakeSandbox();
    const expired: string[] = [];

    const proc = await E2bClaudeRuntimeProcess.start({
      e2bApiKey: "k",
      e2bTemplateId: "tpl",
      e2bSandboxTimeoutMs: 60000,
      workspacePath: "/home/user/workspace/sess-1",
      localWorkspacePath: staging,
      logger: silentLog,
      sessionId: "sess-1",
      runtimeId: "claude-1",
      // Long TTL so the backend deny timer cannot fire on its own during the
      // test — the reconciliation must come from turn_complete, not the timer.
      approvalRequestTtlMs: 600_000,
      onApprovalExpired: (id) => expired.push(id),
      loadSandboxClass: async () => ({ create: async () => sandbox })
    });

    const runPromise = proc.runTurn(turnFrame("t-r"), {
      onSdkMessage: () => {},
      onApprovalRequest: () => {
        // User never decides; the harness self-denies and finishes the turn.
      },
      onComplete: () => {},
      onFail: (err) => expect.fail(`unexpected fail: ${err}`)
    });

    callbacks.onStdout?.(
      '{"type":"approval_request","approvalId":"a-9","toolName":"Write","toolInput":{},"kind":"file_change"}\n'
    );
    callbacks.onStdout?.('{"type":"turn_complete","turnId":"t-r","claudeSessionId":null}\n');

    await runPromise;

    // The still-pending approval was reconciled so its DB row can be expired,
    // rather than its timer being silently dropped (which would strand it).
    expect(expired).toEqual(["a-9"]);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
});

test("turn_complete does NOT expire an approval the user already resolved", async () => {
  const staging = await makeStagingDir("claude-e2b-resolved");
  try {
    const { sandbox, callbacks } = createFakeSandbox();
    const expired: string[] = [];

    const proc = await E2bClaudeRuntimeProcess.start({
      e2bApiKey: "k",
      e2bTemplateId: "tpl",
      e2bSandboxTimeoutMs: 60000,
      workspacePath: "/home/user/workspace/sess-1",
      localWorkspacePath: staging,
      logger: silentLog,
      sessionId: "sess-1",
      runtimeId: "claude-1",
      approvalRequestTtlMs: 600_000,
      onApprovalExpired: (id) => expired.push(id),
      loadSandboxClass: async () => ({ create: async () => sandbox })
    });

    const runPromise = proc.runTurn(turnFrame("t-ok"), {
      onSdkMessage: () => {},
      onApprovalRequest: (frame) => {
        void proc.sendApprovalResponse(frame.approvalId, "approve");
      },
      onComplete: () => {},
      onFail: (err) => expect.fail(`unexpected fail: ${err}`)
    });

    callbacks.onStdout?.(
      '{"type":"approval_request","approvalId":"a-ok","toolName":"Write","toolInput":{},"kind":"file_change"}\n'
    );
    callbacks.onStdout?.('{"type":"turn_complete","turnId":"t-ok","claudeSessionId":null}\n');

    await runPromise;

    // The user's decision cleared the timer in sendApprovalResponse, so turn end
    // must not also expire it.
    expect(expired).toEqual([]);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
});

test("E2bClaudeRuntimeProcess turn_failed surfaces to onFail and rejects runTurn", async () => {
  const staging = await makeStagingDir("claude-e2b-fail");
  try {
    const { sandbox, callbacks } = createFakeSandbox();

    const proc = await E2bClaudeRuntimeProcess.start({
      e2bApiKey: "k",
      e2bTemplateId: "tpl",
      e2bSandboxTimeoutMs: 60000,
      workspacePath: "/home/user/workspace/sess-1",
      localWorkspacePath: staging,
      logger: silentLog,
      sessionId: "sess-1",
      runtimeId: "claude-1",
      loadSandboxClass: async () => ({ create: async () => sandbox })
    });

    let failSeen: string | null = null;
    const runPromise = proc.runTurn(turnFrame("t-3"), {
      onSdkMessage: () => {},
      onApprovalRequest: () => {},
      onComplete: () => expect.fail("should not complete"),
      onFail: (error) => {
        failSeen = error;
      }
    });

    callbacks.onStdout?.('{"type":"turn_failed","turnId":"t-3","error":"boom"}\n');

    await expect(runPromise).rejects.toThrow(/boom/);
    expect(failSeen).toBe("boom");
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
});
