import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, expect, onTestFinished } from "vitest";

import {
  buildCodexStdioCommand,
  buildE2bCodexFactories,
  buildSandboxCodexConfig,
  collectLocalWorkspaceFiles,
  createLineBufferedStdoutHandler,
  extractMcpServersToml,
  E2bRuntimeProcess,
  E2B_WORKSPACE_BASE,
  startE2bStdioHarness
} from "./e2b-runtime-process.js";
import type { E2bSandboxLike, E2bStdioHarnessExitResult } from "./e2b-runtime-process.js";
import { createSilentLogger } from "../../test-helpers/silent-logger.js";
import { createTestConfig } from "../../test-helpers/test-config.js";
import { phase4RuntimePolicy } from "../../test-helpers/phase4-runtime-policy.js";

test("createLineBufferedStdoutHandler emits complete lines and buffers the trailing fragment", () => {
  const lines: string[] = [];
  const handler = createLineBufferedStdoutHandler((line) => lines.push(line));
  handler("a\nb\nc"); // "c" has no newline yet
  expect(lines).toEqual(["a", "b"]);
  handler("-rest\n");
  expect(lines).toEqual(["a", "b", "c-rest"]);
});

test("createLineBufferedStdoutHandler drops a newline-less flood once it crosses the cap", () => {
  const lines: string[] = [];
  let overflowBytes = 0;
  const handler = createLineBufferedStdoutHandler((line) => lines.push(line), {
    maxLineBytes: 10,
    onOverflow: (n) => {
      overflowBytes = n;
    }
  });

  // No newline ever — the trailing buffer must not grow without bound.
  handler("x".repeat(8));
  expect(overflowBytes).toBe(0); // under cap, still buffered
  handler("x".repeat(8)); // now 16 > 10 → dropped
  expect(overflowBytes).toBe(16);
  expect(lines).toEqual([]);

  // After the drop, a subsequent complete line still flows.
  handler("hi\n");
  expect(lines).toEqual(["hi"]);
});

test("createLineBufferedStdoutHandler drops a complete but over-limit line before onLine", () => {
  const lines: string[] = [];
  let overflowBytes = 0;
  const handler = createLineBufferedStdoutHandler((line) => lines.push(line), {
    maxLineBytes: 10,
    onOverflow: (n) => {
      overflowBytes = n;
    }
  });

  // A single newline-TERMINATED frame that already exceeds the cap must not be
  // handed to onLine (it would otherwise reach JSON.parse for the Codex path).
  handler("x".repeat(20) + "\nok\n");
  expect(overflowBytes).toBe(20);
  expect(lines).toEqual(["ok"]);
});

test("collectLocalWorkspaceFiles collects files recursively", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "e2b-test-"));

  try {
    await writeFile(path.join(tmpDir, "codex.toml"), "[mcp_servers]\n");
    await mkdir(path.join(tmpDir, ".codex", "skills", "write-artifact"), { recursive: true });
    await writeFile(
      path.join(tmpDir, ".codex", "skills", "write-artifact", "SKILL.md"),
      "# Write Artifact\n"
    );
    await mkdir(path.join(tmpDir, ".framework"), { recursive: true });
    await writeFile(path.join(tmpDir, ".framework", "runtime-manifest.json"), "{}");

    const files = await collectLocalWorkspaceFiles(tmpDir);

    const relativePaths = files.map((f) => f.relativePath).sort();
    expect(relativePaths).toEqual([
            ".codex/skills/write-artifact/SKILL.md",
            ".framework/runtime-manifest.json",
            "codex.toml"
          ]);

    const tomlFile = files.find((f) => f.relativePath === "codex.toml");
    expect(tomlFile).toBeTruthy();
    const content = typeof tomlFile.data === "string"
      ? tomlFile.data
      : new TextDecoder().decode(tomlFile.data);
    expect(content.includes("[mcp_servers]")).toBeTruthy();
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("collectLocalWorkspaceFiles returns empty for empty directory", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "e2b-test-empty-"));

  try {
    const files = await collectLocalWorkspaceFiles(tmpDir);
    expect(files.length).toBe(0);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("buildSandboxCodexConfig mirrors codex API-key bootstrap defaults", () => {
  const config = buildSandboxCodexConfig({
    model: "gpt-5.4",
    workspaceRoot: E2B_WORKSPACE_BASE
  });

  expect(config).toMatch(/model = "gpt-5\.4"/);
  expect(config).toMatch(/tool_output_token_limit = 25000/);
  expect(config).toMatch(/\[features\]/);
  expect(config).toMatch(/unified_exec = true/);
  expect(config).toMatch(/apply_patch_freeform = true/);
  expect(config).toMatch(/skills = true/);
  expect(config).toMatch(/shell_snapshot = false/);
  expect(config).toMatch(/\[projects\."\/home\/user\/workspace"\]/);
  expect(config).toMatch(/trust_level = "trusted"/);
});

test("buildCodexStdioCommand starts app-server with the documented default transport", () => {
  expect(buildCodexStdioCommand("codex")).toBe("codex app-server --listen stdio://");
});

test("buildE2bCodexFactories workspace factory remaps paths to sandbox", async () => {
  const config = createTestConfig({
    E2B_API_KEY: "e2b_test_key",
    E2B_TEMPLATE_ID: "test-template",
    E2B_SANDBOX_TIMEOUT_MS: 60_000,
    RUNTIME_GATEWAY_BASE_URL: "https://api.example.com"
  });

  const { workspaceFactory } = buildE2bCodexFactories(config);

  const runtimeConfig = {
    runtimePolicy: phase4RuntimePolicy,
    skills: [],
    mcpServers: [],
    sources: { runtimePolicy: "test", skills: [], mcpServers: [] },
    hash: "abc123"
  };

  const workspace = await workspaceFactory(config, {
    sessionId: "session-1",
    userId: "user-1",
    tenantId: "test-tenant",
    runtimeId: "runtime-1",
    runtimeConfig
  });

  expect(workspace.workspacePath.startsWith(E2B_WORKSPACE_BASE)).toBeTruthy();
  expect(workspace.workspacePath.includes("session-1")).toBeTruthy();
  expect(workspace.localWorkspacePath).toBeTruthy();
  expect(!workspace.localWorkspacePath?.startsWith(E2B_WORKSPACE_BASE)).toBeTruthy();
  expect(workspace.codexTomlPath.startsWith(E2B_WORKSPACE_BASE)).toBeTruthy();
  expect(workspace.manifestPath.startsWith(E2B_WORKSPACE_BASE)).toBeTruthy();
  expect(workspace.manifest).toBeTruthy();
  expect(workspace.runtimeToken.startsWith("rt_")).toBeTruthy();
});

test("buildE2bCodexFactories processFactory throws when localWorkspacePath is missing", async () => {
  const config = createTestConfig({
    E2B_API_KEY: "e2b_test_key",
    E2B_TEMPLATE_ID: "test-template",
    E2B_SANDBOX_TIMEOUT_MS: 60_000,
    RUNTIME_GATEWAY_BASE_URL: "https://api.example.com"
  });

  const { processFactory } = buildE2bCodexFactories(config);

  await expect(() =>
        processFactory({
          binaryPath: "codex",
          cwd: "/home/user/workspace/session-missing",
          logger: createSilentLogger(),
          requestTimeoutMs: 10_000,
          startTimeoutMs: 5_000,
          runtimeId: "runtime-1",
          sessionId: "session-missing",
          env: {}
        })).rejects.toThrow(/No local workspace path was provided/);
});

test("buildE2bCodexFactories processFactory uses the explicit staging path and cleans it up on success", async () => {
  const config = createTestConfig({
    E2B_API_KEY: "e2b_test_key",
    E2B_TEMPLATE_ID: "test-template",
    E2B_SANDBOX_TIMEOUT_MS: 60_000,
    RUNTIME_GATEWAY_BASE_URL: "https://api.example.com"
  });

  const localWorkspacePath = await mkdtemp(path.join(os.tmpdir(), "e2b-factory-success-"));
  await writeFile(path.join(localWorkspacePath, "codex.toml"), "");

  const fakeProcess = { pid: 1234 } as unknown as E2bRuntimeProcess;
  let capturedInput: Parameters<typeof E2bRuntimeProcess.start>[0] | null = null;
  const startProcess: typeof E2bRuntimeProcess.start = async (startInput) => {
    capturedInput = startInput;
    return fakeProcess;
  };
  const { processFactory } = buildE2bCodexFactories(config, { startProcess });

  const process = await processFactory({
    binaryPath: "codex",
    cwd: "/home/user/workspace/session-1",
    localWorkspacePath,
    logger: createSilentLogger(),
    requestTimeoutMs: 10_000,
    startTimeoutMs: 5_000,
    runtimeId: "runtime-1",
    sessionId: "session-1",
    env: {
      GIT_CONFIG_GLOBAL: path.join(localWorkspacePath, ".sandbox", "github", "gitconfig")
    }
  });

  expect(process).toBe(fakeProcess);
  expect(capturedInput?.localWorkspacePath).toBe(localWorkspacePath);
  expect(capturedInput?.cwd).toBe("/home/user/workspace/session-1");
  expect(capturedInput?.env).toEqual({
        GIT_CONFIG_GLOBAL: "/home/user/workspace/session-1/.sandbox/github/gitconfig"
      });
  await waitForPathRemoval(localWorkspacePath);
});

test("buildE2bCodexFactories processFactory cleans up the staging path on failure", async () => {
  const config = createTestConfig({
    E2B_API_KEY: "e2b_test_key",
    E2B_TEMPLATE_ID: "test-template",
    E2B_SANDBOX_TIMEOUT_MS: 60_000,
    RUNTIME_GATEWAY_BASE_URL: "https://api.example.com"
  });

  const localWorkspacePath = await mkdtemp(path.join(os.tmpdir(), "e2b-factory-failure-"));
  await writeFile(path.join(localWorkspacePath, "codex.toml"), "");

  const startProcess: typeof E2bRuntimeProcess.start = async () => {
    throw new Error("sandbox start failed");
  };
  const { processFactory } = buildE2bCodexFactories(config, { startProcess });

  await expect(() =>
        processFactory({
          binaryPath: "codex",
          cwd: "/home/user/workspace/session-1",
          localWorkspacePath,
          logger: createSilentLogger(),
          requestTimeoutMs: 10_000,
          startTimeoutMs: 5_000,
          runtimeId: "runtime-1",
          sessionId: "session-1",
          env: {}
        })).rejects.toThrow(/sandbox start failed/);

  await waitForPathRemoval(localWorkspacePath);
});

test("extractMcpServersToml extracts mcp_servers sections from codex.toml", () => {
  const toml = [
    "# Auto-generated for Cogniplane",
    "# Session: abc-123",
    "# Capability profile: phase4-tools",
    "",
    "[mcp_servers.managed-session-context]",
    'url = "https://api.example.com/mcp/managed-session-context"',
    "",
    "[mcp_servers.managed-session-context.headers]",
    'Authorization = "Bearer rt_secret"',
    ""
  ].join("\n");

  const result = extractMcpServersToml(toml);
  expect(result).toMatch(/\[mcp_servers\.managed-session-context\]/);
  expect(result).toMatch(/url = "https:\/\/api\.example\.com\/mcp\/managed-session-context"/);
  expect(result).toMatch(/\[mcp_servers\.managed-session-context\.headers\]/);
  expect(result).toMatch(/Authorization = "Bearer rt_secret"/);
});

test("extractMcpServersToml returns empty string when no mcp_servers present", () => {
  const toml = [
    "# Auto-generated",
    'model = "gpt-5.4"',
    "",
    "[features]",
    "unified_exec = true",
    ""
  ].join("\n");

  const result = extractMcpServersToml(toml);
  expect(result).toBe("");
});

test("extractMcpServersToml handles multiple mcp servers", () => {
  const toml = [
    "[mcp_servers.server-a]",
    'url = "https://a.example.com"',
    "",
    "[mcp_servers.server-a.headers]",
    'Authorization = "Bearer token-a"',
    "",
    "[mcp_servers.server-b]",
    'url = "https://b.example.com"',
    "",
    "[mcp_servers.server-b.headers]",
    'Authorization = "Bearer token-b"',
    ""
  ].join("\n");

  const result = extractMcpServersToml(toml);
  expect(result).toMatch(/\[mcp_servers\.server-a\]/);
  expect(result).toMatch(/\[mcp_servers\.server-b\]/);
  expect(result).toMatch(/token-a/);
  expect(result).toMatch(/token-b/);
});

test("buildSandboxCodexConfig includes mcpServersToml when provided", () => {
  const mcpToml = [
    "[mcp_servers.managed-session-context]",
    'url = "https://api.example.com/mcp/managed-session-context"',
    "",
    "[mcp_servers.managed-session-context.headers]",
    'Authorization = "Bearer rt_secret"'
  ].join("\n");

  const config = buildSandboxCodexConfig({
    model: "gpt-5.4",
    workspaceRoot: E2B_WORKSPACE_BASE,
    mcpServersToml: mcpToml
  });

  expect(config).toMatch(/model = "gpt-5\.4"/);
  expect(config).toMatch(/\[mcp_servers\.managed-session-context\]/);
  expect(config).toMatch(/url = "https:\/\/api\.example\.com\/mcp\/managed-session-context"/);
  expect(config).toMatch(/Authorization = "Bearer rt_secret"/);
});

test("startE2bStdioHarness exit watcher fires onExit when CommandHandle.wait() rejects", async () => {
  const exitResults: E2bStdioHarnessExitResult[] = [];

  // Empty staging dir so uploadWorkspaceFiles is a no-op (it still readdir()s).
  const emptyWorkspace = await mkdtemp(path.join(os.tmpdir(), "e2b-harness-exit-"));
  onTestFinished(() => rm(emptyWorkspace, { recursive: true, force: true }));

  const handle = {
    pid: 4321,
    wait: () => Promise.reject(new Error("sandbox was killed")),
    kill: async () => true
  };

  const fakeSandbox: E2bSandboxLike = {
    sandboxId: "sbx-killed",
    files: {
      write: async () => {},
      read: async () => new Uint8Array()
    },
    commands: {
      run: async () => handle as never,
      sendStdin: async () => {},
      list: async () => []
    },
    kill: async () => {}
  };

  const fakeSandboxClass = {
    create: async () => fakeSandbox
  };

  await startE2bStdioHarness({
    logger: createSilentLogger(),
    sessionId: "session-killed",
    runtimeId: "runtime-killed",
    e2bApiKey: "e2b_test_key",
    e2bTemplateId: "test-template",
    e2bSandboxTimeoutMs: 60_000,
    localWorkspacePath: emptyWorkspace,
    sandboxWorkspacePath: "/home/user/workspace/session-killed",
    command: "codex app-server --listen stdio://",
    stderrLogLabel: "Codex runtime (E2B)",
    onStdoutLine: () => {},
    onExit: (result) => exitResults.push(result),
    loadSandboxClass: async () => fakeSandboxClass as never
  });

  // The exit watcher's reject branch runs on a microtask after wait() rejects.
  for (let attempt = 0; attempt < 50 && exitResults.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  expect(exitResults.length).toBe(1);
  expect(exitResults[0].exitCode).toBeUndefined();
  expect(exitResults[0].error).toMatch(/sandbox was killed/);
});

async function waitForPathRemoval(targetPath: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await access(targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Expected ${targetPath} to be removed.`);
}

// ---------------------------------------------------------------------------
// markDead: unified teardown on every death path
// ---------------------------------------------------------------------------

// Boots a real E2bRuntimeProcess against a fake sandbox whose background
// process exit (wait) and stdin failures are test-controlled.
async function startProcessWithFakeSandbox(opts: {
  sendStdinError?: Error;
}): Promise<{
  proc: E2bRuntimeProcess;
  resolveWait: (result: E2bStdioHarnessExitResult) => void;
  killCalls: () => number;
}> {
  const emptyWorkspace = await mkdtemp(path.join(os.tmpdir(), "e2b-markdead-"));
  onTestFinished(() => rm(emptyWorkspace, { recursive: true, force: true }));

  let resolveWait: (result: E2bStdioHarnessExitResult) => void = () => {};
  const handle = {
    pid: 4321,
    wait: () =>
      new Promise<E2bStdioHarnessExitResult>((resolve) => {
        resolveWait = resolve;
      }),
    kill: async () => true
  };

  let killCount = 0;
  const fakeSandbox: E2bSandboxLike = {
    sandboxId: "sbx-markdead",
    files: {
      write: async () => {},
      read: async () => new Uint8Array()
    },
    commands: {
      run: async (_cmd, options) =>
        options?.background ? (handle as never) : ({ exitCode: 0, stdout: "", stderr: "" } as never),
      sendStdin: async () => {
        if (opts.sendStdinError) throw opts.sendStdinError;
      },
      list: async () => []
    },
    kill: async () => {
      killCount += 1;
    }
  };

  const proc = await E2bRuntimeProcess.start({
    binaryPath: "codex",
    cwd: "/home/user/workspace/session-md",
    logger: createSilentLogger(),
    requestTimeoutMs: 1_000,
    startTimeoutMs: 1_000,
    runtimeId: "runtime-md",
    sessionId: "session-md",
    e2bApiKey: "e2b_test_key",
    e2bTemplateId: "test-template",
    e2bSandboxTimeoutMs: 60_000,
    localWorkspacePath: emptyWorkspace,
    model: "gpt-5.4",
    loadSandboxClass: async () => ({ create: async () => fakeSandbox })
  });

  return { proc, resolveWait: (r) => resolveWait(r), killCalls: () => killCount };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("harness exit kills the sandbox and fires close+exit listeners exactly once", async () => {
  const { proc, resolveWait, killCalls } = await startProcessWithFakeSandbox({});

  let closeCount = 0;
  const exits: Array<number | null> = [];
  proc.onClose(() => {
    closeCount += 1;
  });
  proc.onExit((code) => {
    exits.push(code);
  });

  const pending = proc.sendRequest("turn/start", {});
  resolveWait({ exitCode: 137, stderr: "oom" });

  await expect(pending).rejects.toThrow(/exited with code 137/);
  await settle();

  expect(proc.isAlive()).toBe(false);
  // The Codex process died but the sandbox would keep running (and billing)
  // until the E2B hard timeout — markDead must kill it.
  expect(killCalls()).toBe(1);
  expect(closeCount).toBe(1);
  // Exit listeners are the lifecycle's finalizeRuntimeClosure hook (terminal
  // DB status, approval expiry, IP-pin release) — they must fire here too.
  expect(exits).toEqual([137]);

  // A racing terminate() must not re-fire listeners or re-kill the sandbox.
  proc.terminate();
  expect(killCalls()).toBe(1);
  expect(closeCount).toBe(1);
  expect(exits).toEqual([137]);
});

test("sendLine failure kills the sandbox and fires exit listeners (finalization hook)", async () => {
  const { proc, killCalls } = await startProcessWithFakeSandbox({
    sendStdinError: new Error("stdin pipe broke")
  });

  let closeCount = 0;
  const exits: Array<number | null> = [];
  proc.onClose(() => {
    closeCount += 1;
  });
  proc.onExit((code) => {
    exits.push(code);
  });

  await expect(proc.sendRequest("turn/start", {})).rejects.toThrow(/stdin pipe broke/);
  await settle();

  expect(proc.isAlive()).toBe(false);
  expect(killCalls()).toBe(1);
  expect(closeCount).toBe(1);
  expect(exits).toEqual([null]);
});
