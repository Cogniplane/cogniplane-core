import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test, beforeEach, afterEach, expect } from "vitest";

import { ManagedToolCatalog } from "../managed-tools/catalog.js";
import { ManagedToolFactoryRegistry } from "../managed-tools/factory.js";
import { registerBuiltinManagedTools } from "../managed-tools/register-builtin-managed-tools.js";
import { renderClaudeWorkspace } from "./claude-workspace-renderer.js";

const sharedManagedToolCatalog = new ManagedToolCatalog();
registerBuiltinManagedTools(sharedManagedToolCatalog, new ManagedToolFactoryRegistry());

describe("claude workspace renderer", () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(path.join(os.tmpdir(), "claude-ws-test-"));
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  test("renders CLAUDE.md with developer instructions and skill content", async () => {
    await renderClaudeWorkspace({
      workspacePath,
      developerInstructions: "You are a helpful assistant.",
      skills: [
        { id: "pdf-skill", name: "PDF Processing", instructions: "Parse PDFs using pdftotext." }
      ],
      mcpServers: [{ id: "managed-session-context", url: "http://localhost:3001/mcp/managed", mode: "managed" }],
      enabledToolIds: ["session_context", "write_artifact"],
      runtimeToken: "rt_test_token",
      managedToolCatalog: sharedManagedToolCatalog
    });

    const claudeMd = await readFile(path.join(workspacePath, "CLAUDE.md"), "utf-8");
    expect(claudeMd.includes("You are a helpful assistant.")).toBeTruthy();
    expect(claudeMd.includes("Available MCP Tools")).toBeTruthy();
    expect(claudeMd.includes("session_context")).toBeTruthy();
    expect(claudeMd.includes("write_artifact")).toBeTruthy();
    expect(claudeMd.includes("The native `Write` tool only changes files in the workspace.")).toBeTruthy();
    expect(claudeMd.includes("PDF Processing")).toBeTruthy();
    expect(claudeMd.includes("Parse PDFs using pdftotext.")).toBeTruthy();
  });

  test("renders .mcp.json with server URLs and auth", async () => {
    await renderClaudeWorkspace({
      workspacePath,
      developerInstructions: null,
      skills: [],
      mcpServers: [
        { id: "managed", url: "http://localhost:3001/mcp/managed?token=rt_test", mode: "managed" },
        { id: "sharepoint", url: "http://localhost:3001/mcp/sharepoint?token=rt_test", mode: "proxy" }
      ],
      enabledToolIds: [],
      runtimeToken: "rt_test",
      managedToolCatalog: sharedManagedToolCatalog
    });

    const mcpJson = JSON.parse(await readFile(path.join(workspacePath, ".mcp.json"), "utf-8"));
    expect(mcpJson.mcpServers.managed).toBeTruthy();
    expect(mcpJson.mcpServers.managed.type).toBe("http");
    expect(mcpJson.mcpServers.managed.url.includes("/mcp/managed")).toBeTruthy();
    expect(mcpJson.mcpServers.sharepoint).toBeTruthy();
  });

  test("renders skills as .claude/commands/<name>.md files", async () => {
    await renderClaudeWorkspace({
      workspacePath,
      developerInstructions: null,
      skills: [
        { id: "write-artifact", name: "write-artifact", instructions: "Call write_artifact tool." }
      ],
      mcpServers: [],
      enabledToolIds: [],
      runtimeToken: "rt_test",
      managedToolCatalog: sharedManagedToolCatalog
    });

    const skillFile = await readFile(
      path.join(workspacePath, ".claude", "commands", "write-artifact.md"),
      "utf-8"
    );
    expect(skillFile.includes("Call write_artifact tool.")).toBeTruthy();
  });

  test("names the command file from the validated skill id, not the display name", async () => {
    await renderClaudeWorkspace({
      workspacePath,
      developerInstructions: null,
      skills: [
        // Display name carries spaces/casing; only the id is filesystem-safe.
        { id: "pdf-skill", name: "PDF Processing", instructions: "Parse PDFs." }
      ],
      mcpServers: [],
      enabledToolIds: [],
      runtimeToken: "rt_test",
      managedToolCatalog: sharedManagedToolCatalog
    });

    const skillFile = await readFile(
      path.join(workspacePath, ".claude", "commands", "pdf-skill.md"),
      "utf-8"
    );
    expect(skillFile.includes("Parse PDFs.")).toBeTruthy();
  });

  test("rejects a skill id that could escape the commands directory", async () => {
    await expect(
      renderClaudeWorkspace({
        workspacePath,
        developerInstructions: null,
        skills: [
          { id: "../../etc/evil", name: "Evil", instructions: "pwned" }
        ],
        mcpServers: [],
        enabledToolIds: [],
        runtimeToken: "rt_test",
        managedToolCatalog: sharedManagedToolCatalog
      })
    ).rejects.toThrow(/Invalid skill id/);
  });

  test("skips developer instructions section in CLAUDE.md when null", async () => {
    await renderClaudeWorkspace({
      workspacePath,
      developerInstructions: null,
      skills: [],
      mcpServers: [],
      enabledToolIds: [],
      runtimeToken: "rt_test",
      managedToolCatalog: sharedManagedToolCatalog
    });

    const claudeMd = await readFile(path.join(workspacePath, "CLAUDE.md"), "utf-8");
    expect(!claudeMd.includes("## Instructions")).toBeTruthy();
  });

  test("token-bearing files are written with mode 0600 on POSIX", async () => {
    if (process.platform === "win32") {
      return;
    }
    await renderClaudeWorkspace({
      workspacePath,
      developerInstructions: null,
      skills: [{ id: "write-artifact", name: "write-artifact", instructions: "x" }],
      mcpServers: [{ id: "managed", url: "http://localhost:3001/mcp/managed", mode: "managed" }],
      enabledToolIds: [],
      runtimeToken: "rt_perm_test",
      managedToolCatalog: sharedManagedToolCatalog
    });

    const mcpJsonMode = (await stat(path.join(workspacePath, ".mcp.json"))).mode & 0o777;
    expect(mcpJsonMode).toBe(0o600);
    const claudeMdMode = (await stat(path.join(workspacePath, "CLAUDE.md"))).mode & 0o777;
    expect(claudeMdMode).toBe(0o600);
    const skillMode = (
      await stat(path.join(workspacePath, ".claude", "commands", "write-artifact.md"))
    ).mode & 0o777;
    expect(skillMode).toBe(0o600);
  });

  // MCP transport contract: Claude MCP URLs must NOT carry `?token=rt_...` —
  // the runtime token is delivered exclusively via `Authorization: Bearer`.
  // Codex enforces the inverse (token-in-URL) — see runtime-workspace.test.ts.
  test(".mcp.json MCP URLs do not carry ?token= (transport contract)", async () => {
    const TOKEN = "rt_claude_contract_token_123";
    await renderClaudeWorkspace({
      workspacePath,
      developerInstructions: null,
      skills: [],
      mcpServers: [
        { id: "managed", url: "http://localhost:3001/mcp/managed", mode: "managed" },
        { id: "sharepoint", url: "http://localhost:3001/mcp/sharepoint", mode: "proxy" }
      ],
      enabledToolIds: [],
      runtimeToken: TOKEN,
      managedToolCatalog: sharedManagedToolCatalog
    });

    const mcpJson = JSON.parse(await readFile(path.join(workspacePath, ".mcp.json"), "utf-8")) as {
      mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>;
    };

    for (const [, server] of Object.entries(mcpJson.mcpServers)) {
      expect(!server.url.includes("?token=")).toBeTruthy();
      expect(server.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    }
  });
});
