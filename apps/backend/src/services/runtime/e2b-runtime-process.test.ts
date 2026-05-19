import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, expect, onTestFinished } from "vitest";

import {
  buildCodexStdioCommand,
  buildE2bCodexFactories,
  buildSandboxCodexConfig,
  collectLocalWorkspaceFiles,
  extractMcpServersToml,
  E2bRuntimeProcess,
  E2B_WORKSPACE_BASE
} from "./e2b-runtime-process.js";
import { createSilentLogger } from "../../test-helpers/silent-logger.js";
import { createTestConfig } from "../../test-helpers/test-config.js";
import { phase4RuntimePolicy } from "../../test-helpers/phase4-runtime-policy.js";

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
    RUNTIME_BACKEND: "e2b" as const,
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
    RUNTIME_BACKEND: "e2b" as const,
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
    RUNTIME_BACKEND: "e2b" as const,
    E2B_API_KEY: "e2b_test_key",
    E2B_TEMPLATE_ID: "test-template",
    E2B_SANDBOX_TIMEOUT_MS: 60_000,
    RUNTIME_GATEWAY_BASE_URL: "https://api.example.com"
  });

  const localWorkspacePath = await mkdtemp(path.join(os.tmpdir(), "e2b-factory-success-"));
  await writeFile(path.join(localWorkspacePath, "codex.toml"), "");

  const { processFactory } = buildE2bCodexFactories(config);
  const fakeProcess = { pid: 1234 };
  let capturedInput: Record<string, unknown> | null = null;
  const originalStart = E2bRuntimeProcess.start;
  Object.defineProperty(E2bRuntimeProcess, "start", {
    configurable: true,
    writable: true,
    value: async (input: Record<string, unknown>) => {
      capturedInput = input;
      return fakeProcess;
    }
  });
  onTestFinished(() => {
        Object.defineProperty(E2bRuntimeProcess, "start", {
          configurable: true,
          writable: true,
          value: originalStart
        });
      });

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
    RUNTIME_BACKEND: "e2b" as const,
    E2B_API_KEY: "e2b_test_key",
    E2B_TEMPLATE_ID: "test-template",
    E2B_SANDBOX_TIMEOUT_MS: 60_000,
    RUNTIME_GATEWAY_BASE_URL: "https://api.example.com"
  });

  const localWorkspacePath = await mkdtemp(path.join(os.tmpdir(), "e2b-factory-failure-"));
  await writeFile(path.join(localWorkspacePath, "codex.toml"), "");

  const { processFactory } = buildE2bCodexFactories(config);
  const originalStart = E2bRuntimeProcess.start;
  Object.defineProperty(E2bRuntimeProcess, "start", {
    configurable: true,
    writable: true,
    value: async () => {
      throw new Error("sandbox start failed");
    }
  });
  onTestFinished(() => {
        Object.defineProperty(E2bRuntimeProcess, "start", {
          configurable: true,
          writable: true,
          value: originalStart
        });
      });

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
