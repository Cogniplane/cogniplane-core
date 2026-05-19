import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ManagedToolCatalog } from "../managed-tools/catalog.js";

export type ClaudeWorkspaceInput = {
  workspacePath: string;
  developerInstructions: string | null;
  skills: Array<{ id: string; name: string; instructions: string }>;
  mcpServers: Array<{ id: string; url: string; mode?: "managed" | "proxy" }>;
  enabledToolIds: string[];
  runtimeToken: string;
  managedToolCatalog: ManagedToolCatalog;
};


function buildArtifactRule(enabledToolIds: string[]): string[] {
  if (!enabledToolIds.includes("write_artifact")) {
    return [];
  }

  return [
    "## Artifacts vs. workspace files",
    "",
    "Use the filesystem normally for scripts, scratch files, and intermediate outputs.",
    "Those do not need to become session artifacts.",
    "",
    "Any user-facing deliverable must also be saved with `write_artifact`.",
    "The native `Write` tool only changes files in the workspace. It does NOT",
    "publish a Cogniplane artifact for the user.",
    "",
    "Call `write_artifact` before telling the user a file is ready when:",
    "- The user asked for a script, document, report, HTML file, CSV, JSON, or other deliverable.",
    "- You want the file to appear in the Artifacts panel.",
    "- You are producing binary output and need to pass `filePath` instead of inline `content`.",
    "",
    "For `write_artifact`, provide `name` and either `content` or `filePath`.",
    "`mimeType` is optional and inferred when omitted.",
    ""
  ];
}

function buildMcpSection(
  mcpServers: ClaudeWorkspaceInput["mcpServers"],
  enabledToolIds: string[],
  managedToolCatalog: ManagedToolCatalog
): string[] {
  const lines: string[] = ["## Available MCP Tools", ""];

  if (mcpServers.length === 0) {
    lines.push("No MCP servers are configured for this session.", "");
    return lines;
  }

  lines.push("This workspace exposes MCP servers through `.mcp.json`.", "");

  for (const server of mcpServers) {
    lines.push(`### \`${server.id}\` (${server.mode ?? "managed"})`);
    lines.push("");
    if (server.mode === "proxy") {
      lines.push("This is a proxied enterprise MCP server. Use its tools for that external system.");
    } else {
      lines.push("This is a framework-managed MCP server.");
    }
    lines.push("");
  }

  const documentedTools = enabledToolIds
    .map((id) => managedToolCatalog.get(id))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  const managedToolLines = documentedTools.map(
    (tool) => `- \`${tool.name}\`: ${tool.description}`
  );

  if (managedToolLines.length > 0) {
    lines.push("### Managed tool reference", "");
    lines.push(
      "When these tools are available, prefer them over improvised workspace-only",
      "workflows. In Claude, managed MCP tools appear with names like",
      "`mcp__<server>__<tool>`.",
      ""
    );
    lines.push(...managedToolLines, "");
  }

  return lines;
}

export async function renderClaudeWorkspace(input: ClaudeWorkspaceInput): Promise<void> {
  const { workspacePath } = input;

  // Render CLAUDE.md
  const sections: string[] = [
    "# Cogniplane Agent Workspace",
    "",
    "This workspace is managed by the Cogniplane platform.",
    ""
  ];

  if (input.developerInstructions) {
    sections.push("## Instructions", "", input.developerInstructions, "");
  }

  sections.push(...buildMcpSection(input.mcpServers, input.enabledToolIds, input.managedToolCatalog));
  sections.push(...buildArtifactRule(input.enabledToolIds));

  for (const skill of input.skills) {
    sections.push(`## Skill: ${skill.name}`, "", skill.instructions, "");
  }

  // Workspace files contain the runtime token (.mcp.json). Lock the workspace
  // tree to owner-only so same-host neighbors and forensic captures cannot
  // read the bearer token. CLAUDE.md and skills inherit the same posture.
  const claudeMdPath = path.join(workspacePath, "CLAUDE.md");
  await writeFile(claudeMdPath, sections.join("\n"), { mode: 0o600 });
  await chmod(claudeMdPath, 0o600);

  // Render .mcp.json
  if (input.mcpServers.length > 0) {
    const mcpConfig: Record<string, { type: string; url: string; headers: Record<string, string> }> = {};
    for (const server of input.mcpServers) {
      mcpConfig[server.id] = {
        // Claude CLI expects "http" for HTTP MCP servers (validated against the CLI schema).
        // Earlier versions accepted "streamableHttp"; 2.x rejects it.
        type: "http",
        url: server.url,
        headers: {
          Authorization: `Bearer ${input.runtimeToken}`
        }
      };
    }
    // .mcp.json sits at the workspace root and is overwritten in place across
    // session restarts; explicitly chmod since `mode` on writeFile only
    // applies on file creation.
    const mcpJsonPath = path.join(workspacePath, ".mcp.json");
    await writeFile(mcpJsonPath, JSON.stringify({ mcpServers: mcpConfig }, null, 2), { mode: 0o600 });
    await chmod(mcpJsonPath, 0o600);
  }

  // Render skills as .claude/commands/<name>.md
  if (input.skills.length > 0) {
    const commandsPath = path.join(workspacePath, ".claude", "commands");
    await mkdir(commandsPath, { recursive: true, mode: 0o700 });
    for (const skill of input.skills) {
      await writeFile(
        path.join(commandsPath, `${skill.name}.md`),
        skill.instructions,
        { mode: 0o600 }
      );
    }
  }
}
