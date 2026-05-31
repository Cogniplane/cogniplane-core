import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

import YAML from "yaml";

import type { AppConfig } from "../../config.js";
import type { RuntimeManifest, RuntimeManifestSkillEntry } from "../../domain/runtime-manifest.js";
import type { RuntimeConfigBundle } from "../admin-config-records.js";
import type { SkillBundleStorage } from "../skills/skill-bundle-storage.js";
import { generateRuntimeToken, runtimeTokenExpiry, type RuntimeTokenMintClaims } from "../auth/runtime-token.js";
import type { ManagedToolCatalog } from "../managed-tools/catalog.js";

export type WorkspaceArtifacts = {
  workspacePath: string;
  localWorkspacePath?: string;
  codexTomlPath: string;
  manifestPath: string;
  manifest: RuntimeManifest;
  runtimeToken: string;
};

const RUNTIME_MANIFEST_VERSION = "cogniplane.runtime-manifest.v1";
const skillDirectoryNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function encodeWorkspaceSegment(value: string): string {
  return `user-${Buffer.from(value).toString("base64url")}`;
}

function serializeApprovalPolicy(policy: unknown): string {
  return typeof policy === "object" && policy !== null ? JSON.stringify(policy) : String(policy);
}

function buildRuntimeManifest(input: {
  config: AppConfig;
  sessionId: string;
  userId: string;
  workspacePath: string;
  runtimeConfig: RuntimeConfigBundle;
  skills: RuntimeManifestSkillEntry[];
  runtimeToken: string;
  codexTomlPath: string;
  skillsPath: string;
}): RuntimeManifest {
  const { config, runtimeConfig, skills, runtimeToken } = input;
  const manifestBase = {
    manifestVersion: RUNTIME_MANIFEST_VERSION,
    sessionId: input.sessionId,
    userId: input.userId,
    generatedAt: new Date().toISOString(),
    workspacePath: input.workspacePath,
    codex: {
      binaryPath: config.CODEX_BINARY_PATH,
      version: config.CODEX_VERSION,
      schemaVersion: config.CODEX_SCHEMA_VERSION,
      model: config.CODEX_MODEL
    },
    runtimePolicy: {
      id: runtimeConfig.runtimePolicy.id,
      version: runtimeConfig.runtimePolicy.version,
      hash: runtimeConfig.runtimePolicy.hash,
      approvalPolicy: serializeApprovalPolicy(runtimeConfig.runtimePolicy.approvalPolicy),
      sandboxMode: runtimeConfig.runtimePolicy.sandboxMode,
      networkMode: runtimeConfig.runtimePolicy.networkMode,
      allowCommandExecution: runtimeConfig.runtimePolicy.allowCommandExecution,
      allowUserTokenForwarding: runtimeConfig.runtimePolicy.allowUserTokenForwarding,
      autoApproveReadOnlyTools: runtimeConfig.runtimePolicy.autoApproveReadOnlyTools,
      enabledToolIds: runtimeConfig.runtimePolicy.enabledToolIds
    },
    skills,
    mcpServers: runtimeConfig.mcpServers.map((server) => {
      const serverUrl = new URL(server.routePath, ensureTrailingSlash(config.RUNTIME_GATEWAY_BASE_URL));
      // Embed the runtime token in the URL so Codex's Streamable HTTP transport
      // authenticates even on the initialize POST (where it doesn't send headers).
      serverUrl.searchParams.set("token", runtimeToken);
      return {
        id: server.id,
        version: server.version,
        hash: server.hash,
        mode: server.mode,
        url: serverUrl.toString()
      };
    }),
    configSources: runtimeConfig.sources,
    config: {
      codexTomlPath: input.codexTomlPath,
      skillsPath: input.skillsPath,
      customSkillsEnabled: skills.length > 0,
      customMcpServersEnabled: runtimeConfig.mcpServers.length > 0
    }
  };
  return {
    ...manifestBase,
    configBundleHash: runtimeConfig.hash,
    manifestHash: createHash("sha256").update(JSON.stringify(manifestBase)).digest("hex")
  };
}

export async function createRuntimeWorkspace(
  config: AppConfig,
  input: {
    sessionId: string;
    userId: string;
    tenantId: string;
    runtimeId: string;
    runtimeConfig: RuntimeConfigBundle;
    skillBundleStorage: SkillBundleStorage;
    managedToolCatalog: ManagedToolCatalog;
  }
): Promise<WorkspaceArtifacts> {
  const workspacePath = path.join(
    config.RUNTIME_WORKSPACE_ROOT,
    encodeWorkspaceSegment(input.userId),
    input.sessionId
  );
  const frameworkPath = path.join(workspacePath, ".framework");
  const codexPath = path.join(workspacePath, ".codex");
  const skillsPath = path.join(codexPath, "skills");
  const codexTomlPath = path.join(workspacePath, "codex.toml");
  const manifestPath = path.join(frameworkPath, "runtime-manifest.json");

  // Regenerate framework-owned runtime files from scratch so removed skills
  // and stale manifest content cannot survive a runtime restart.
  await Promise.all([
    rm(skillsPath, { recursive: true, force: true }),
    rm(frameworkPath, { recursive: true, force: true })
  ]);

  // Workspace files contain the runtime token (codex.toml, runtime-manifest.json).
  // Lock the workspace tree to owner-only so same-host neighbors and forensic
  // captures cannot read the bearer token.
  await mkdir(workspacePath, { recursive: true, mode: 0o700 });
  await chmod(workspacePath, 0o700);
  await mkdir(frameworkPath, { recursive: true, mode: 0o700 });
  await chmod(frameworkPath, 0o700);
  await mkdir(skillsPath, { recursive: true, mode: 0o700 });

  const generatedSkills = await Promise.all(
    input.runtimeConfig.skills.map(async (skill) => {
      const directoryName = resolveRuntimeSkillDirectoryName(skill);
      const directoryPath = path.join(skillsPath, directoryName);

      if (skill.bundleStorageUri && skill.bundleName) {
        await input.skillBundleStorage.installBundle({
          storageUri: skill.bundleStorageUri,
          destinationPath: directoryPath
        });
      } else {
        const filePath = path.join(directoryPath, "SKILL.md");
        await mkdir(directoryPath, { recursive: true, mode: 0o700 });
        // Use YAML.stringify so descriptions containing ":", quotes, leading
        // special characters, or multi-line text get properly escaped. A
        // hand-rolled `description: ${value}` breaks for any description with
        // a colon-space sequence (e.g. "Python: data tools").
        const frontmatter = YAML.stringify(
          skill.description ? { name: skill.id, description: skill.description } : { name: skill.id }
        ).trimEnd();
        await writeFile(
          filePath,
          [
            "---",
            frontmatter,
            "---",
            `<!-- skill_id: ${skill.id} | version: ${skill.version} | hash: ${skill.hash} -->`,
            "",
            skill.instructions
          ].join("\n"),
          { mode: 0o600 }
        );
      }

      return {
        id: skill.id,
        name: skill.name,
        version: skill.version,
        hash: skill.hash,
        revisionId: skill.revisionId,
        bundleHash: skill.bundleHash ?? skill.hash,
        path: directoryPath,
        sourceType: skill.sourceType
      };
    })
  );

  // Generate a session-scoped runtime token for MCP gateway authentication.
  // Codex caches the Authorization header it reads at startup, so the token
  // must outlive the active runtime. The configurable TTL
  // (RUNTIME_TOKEN_TTL_MS, default 24 hours) bounds the leak window if
  // codex.toml or a sandbox snapshot is captured. The TTL needs to outlive
  // the longest realistic continuous session because the token is not
  // refreshed mid-runtime — only a fresh bootstrap mints a new one.
  const runtimeTokenClaims: RuntimeTokenMintClaims = {
    sid: input.sessionId,
    tid: input.tenantId,
    uid: input.userId,
    rid: input.runtimeId,
    exp: runtimeTokenExpiry(config.RUNTIME_TOKEN_TTL_MS)
  };
  const runtimeToken = generateRuntimeToken(runtimeTokenClaims, config.DATA_ENCRYPTION_SECRET);

  const manifest = buildRuntimeManifest({
    config,
    sessionId: input.sessionId,
    userId: input.userId,
    workspacePath,
    runtimeConfig: input.runtimeConfig,
    skills: generatedSkills,
    runtimeToken,
    codexTomlPath,
    skillsPath
  });

  for (const server of manifest.mcpServers) {
    if (!/^[a-zA-Z0-9_-]+$/.test(server.id)) {
      throw new Error(`MCP server id "${server.id}" contains characters that are unsafe for TOML bare keys.`);
    }
  }

  const authHeaderValue = `Bearer ${runtimeToken}`;

  const codexToml = [
    "# Auto-generated for Cogniplane",
    `# Session: ${input.sessionId}`,
    `# Capability profile: ${input.runtimeConfig.runtimePolicy.id}`,
    ""
  ];

  for (const server of manifest.mcpServers) {
    codexToml.push(`[mcp_servers.${server.id}]`);
    codexToml.push(`url = "${server.url}"`);
    codexToml.push("");
    codexToml.push(`[mcp_servers.${server.id}.headers]`);
    codexToml.push(`Authorization = "${authHeaderValue}"`);
    codexToml.push("");
  }

  // codex.toml lives at the workspace root and is overwritten in place across
  // session restarts, so explicitly chmod after writing — `mode` on writeFile
  // only takes effect on file creation.
  await writeFile(codexTomlPath, codexToml.join("\n"), { mode: 0o600 });
  await chmod(codexTomlPath, 0o600);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });

  const agentsMdPath = path.join(workspacePath, "AGENTS.md");
  await writeFile(agentsMdPath, await renderAgentsMd(manifest, input.managedToolCatalog), { mode: 0o600 });
  await chmod(agentsMdPath, 0o600);

  return {
    workspacePath,
    codexTomlPath,
    manifestPath,
    manifest,
    runtimeToken
  };
}

async function renderAgentsMd(manifest: RuntimeManifest, managedToolCatalog: ManagedToolCatalog): Promise<string> {
  const templatePath = fileURLToPath(new URL("./AGENTS.md.template", import.meta.url));
  const template = await readFile(templatePath, "utf8");
  const profile = manifest.runtimePolicy;

  const shellCommandsNote = profile.allowCommandExecution
    ? "allowed (each invocation requires explicit user approval)"
    : "disabled — do not attempt to run shell commands";

  const shellApprovalWarning = profile.allowCommandExecution
    ? [
        "",
        "> **Shell approval**: Every shell command you propose will be shown to the user",
        "> for approval before it runs. Request only commands that are strictly necessary.",
        "> Batch related commands into one invocation rather than many small ones."
      ].join("\n")
    : "";

  const mcpServersSection = buildMcpServersSection(manifest, profile.enabledToolIds, managedToolCatalog);
  const skillsSection = buildSkillsSection(manifest);
  const artifactRule = buildArtifactRule(profile.enabledToolIds);

  return template
    .replace("{{sandboxMode}}", profile.sandboxMode)
    .replace("{{networkMode}}", profile.networkMode)
    .replace("{{shellCommandsNote}}", shellCommandsNote)
    .replace("{{approvalPolicy}}", profile.approvalPolicy)
    .replace("{{shellApprovalWarning}}", shellApprovalWarning)
    .replace("{{mcpServersSection}}", mcpServersSection)
    .replace("{{skillsSection}}", skillsSection)
    .replace("{{artifactRule}}", artifactRule)
    .replace("{{sessionId}}", manifest.sessionId);
}

function buildArtifactRule(enabledToolIds: string[]): string {
  if (!enabledToolIds.includes("write_artifact")) {
    return "";
  }
  return [
    "## Artifacts vs. scratch files",
    "",
    "Use the filesystem normally for anything you need for your own work:",
    "scripts you are about to execute, intermediate data, tests, temp files.",
    "Those do NOT need to become artifacts.",
    "",
    "**Artifacts are for the user.** Any file the user is expected to see,",
    "download, or reuse is a deliverable and MUST also be saved as an",
    "artifact by calling `write_artifact` — in addition to writing it to disk.",
    "",
    "### When to call `write_artifact`",
    "",
    "- The final script, document, or data file the user asked for.",
    "- Generated HTML, Markdown, CSV, JSON, or binary outputs the user should",
    "  download.",
    "- Any file you tell the user is \"ready\", \"saved\", or \"available\".",
    "",
    "Skip it for scratch files, test fixtures the user did not ask for, and",
    "build-time side-effects. If you are unsure whether a file is a",
    "deliverable, save it as an artifact.",
    "",
    "### How to call `write_artifact`",
    "",
    "- **`content`** — the complete file content as a string. Best for text",
    "  files you generated in-context.",
    "- **`filePath`** — a workspace path (e.g. `./output.png`). The server",
    "  reads the file from the sandbox. Best for binary or large outputs.",
    "",
    "Use one or the other, not both. Maximum file size: **10 MB**.",
    "`mimeType` is optional (inferred from the extension).",
    "",
    "### Typical flow",
    "",
    "1. Write the file to the workspace filesystem so you can run, test, or",
    "   iterate on it.",
    "2. Execute it if the user asked you to.",
    "3. Call `write_artifact` with the filename and content for every",
    "   deliverable the user should see.",
    "4. Tell the user the file is available in the Artifacts panel.",
    "",
    "Save the artifact BEFORE confirming to the user. If `write_artifact`",
    "fails, report the error and show the content inline.",
    "",
  ].join("\n");
}

function buildMcpServersSection(manifest: RuntimeManifest, enabledToolIds: string[], managedToolCatalog: ManagedToolCatalog): string {
  if (manifest.mcpServers.length === 0) {
    return "No MCP servers are configured for this session.";
  }

  const lines: string[] = ["The following MCP servers are registered in `codex.toml`:", ""];

  for (const server of manifest.mcpServers) {
    lines.push(`### \`${server.id}\` (${server.mode})`);
    lines.push("");
    lines.push(`URL: \`${server.url}\``);
    lines.push("");
    if (server.mode === "managed") {
      lines.push("This is a framework-managed server. Its tools are described below.");
    } else {
      lines.push("This is a proxied enterprise MCP server. Consult the relevant skill");
      lines.push("instructions for how to use its tools.");
    }
    lines.push("");
  }

  const documentedTools = enabledToolIds
    .map((id) => managedToolCatalog.get(id))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

  if (documentedTools.length > 0) {
    lines.push("### Managed tool reference", "");
    for (const tool of documentedTools) {
      lines.push(`**\`${tool.name}\`** — ${tool.description}`, "");
    }

    // Workflow guidance for OneDrive/SharePoint file access — only reference tools that are actually enabled
    const hasReadFile = enabledToolIds.includes("sharepoint_read_file");
    const hasImport = enabledToolIds.includes("sharepoint_import_file_to_session");
    if (hasReadFile || hasImport) {
      lines.push("### Working with OneDrive / SharePoint files", "");
      if (hasReadFile && hasImport) {
        lines.push(
          "- **Text files** (`.txt`, `.csv`, `.json`, `.md`): use `sharepoint_read_file` to",
          "  read content directly.",
          "- **Binary or rich files** (`.pdf`, `.docx`, `.xlsx`, `.pptx`, `.png`, etc.):",
          "  1. Call `sharepoint_import_file_to_session` with the file's `driveId` and `itemId`.",
          "  2. Check the tool response — if a local copy was written, read it from `./artifacts/`.",
          "     If not (file too large or sandbox unavailable), tell the user the file is saved",
          "     as a session artifact but cannot be processed locally.",
          "- When in doubt, **prefer `sharepoint_import_file_to_session`** — it saves the file",
          "  as a session artifact and attempts to make a local copy for processing.",
          "- `sharepoint_read_file` returns metadata only for binary files — it cannot extract",
          "  text from PDFs or images. You **must** import those files first.",
          ""
        );
      } else if (hasImport) {
        lines.push(
          "- To work with any OneDrive / SharePoint file, call `sharepoint_import_file_to_session`",
          "  with the file's `driveId` and `itemId`. It saves the file as a session artifact and",
          "  for files under 10 MB also writes a local copy to `./artifacts/`. Check the tool",
          "  response to confirm whether the local copy is available before reading it.",
          ""
        );
      } else {
        lines.push(
          "- Use `sharepoint_read_file` to read text-based files from OneDrive / SharePoint.",
          "  Note: binary files (PDFs, images) return metadata only — text extraction is not supported.",
          ""
        );
      }
    }
  }

  return lines.join("\n").trimEnd();
}

function buildSkillsSection(manifest: RuntimeManifest): string {
  if (manifest.skills.length === 0) {
    return "No skills are active for this session.";
  }

  const lines: string[] = [
    "The following skills are loaded and describe additional capabilities or",
    "workflows you should follow:",
    ""
  ];
  for (const skill of manifest.skills) {
    const dirName = skill.path.split("/").slice(-1)[0];
    lines.push(`- **${skill.name}** — \`.codex/skills/${dirName}/SKILL.md\``);
  }
  lines.push("", "Read the SKILL.md file for each skill before invoking any related tools.");

  return lines.join("\n");
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function resolveRuntimeSkillDirectoryName(skill: RuntimeConfigBundle["skills"][number]): string {
  if (skill.bundleName) {
    if (!skillDirectoryNamePattern.test(skill.bundleName)) {
      throw new Error(`Invalid runtime skill bundle name: ${skill.bundleName}`);
    }

    return skill.bundleName;
  }

  if (skillDirectoryNamePattern.test(skill.id)) {
    return skill.id;
  }

  return encodeWorkspaceSegment(skill.id);
}
