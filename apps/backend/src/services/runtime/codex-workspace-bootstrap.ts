import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { uuidv7 } from "../../lib/uuid.js";

import type { FastifyBaseLogger } from "fastify";

import { extractMcpServersToml } from "./e2b-runtime-process.js";

import type { AppConfig } from "../../config.js";
import { CodexRuntimeProcess } from "./codex-runtime-process.js";
import { CodexSkillDiscoveryService } from "./codex-skill-discovery-service.js";
import type { GithubConnectionService } from "../integrations/github/github-connection-service.js";
import type { IntegrationRegistryService } from "../integrations/integration-registry-service.js";
import { prepareGithubWorkspace } from "./runtime-github-bootstrap.js";
import {
  createRuntimeWorkspace,
  type WorkspaceArtifacts
} from "./runtime-workspace.js";
import type { ManagedToolCatalog } from "../managed-tools/catalog.js";
import type { SkillBundleStorage } from "../skills/skill-bundle-storage.js";
import type { ActivationTracker } from "../activation-tracker.js";
import type { RuntimeConfigBundle } from "../admin-config-records.js";
import type {
  RuntimeProcessFactory,
  RuntimeProcessHandle,
  RuntimeState,
  RuntimeWorkspaceFactory
} from "./runtime-types.js";
import { CodexSessionLifecycle } from "./codex-session-lifecycle.js";
import type { DynamicConfigService } from "../dynamic-config-service.js";

export class CodexWorkspaceBootstrap {
  constructor(
    private readonly config: AppConfig,
    private readonly deps: {
      dynamicConfig: DynamicConfigService;
      logger: FastifyBaseLogger;
      isBetaTester?: (tenantId: string, userId: string) => Promise<boolean>;
      getTenantApiKey?: (tenantId: string) => Promise<string | null>;
      githubConnections?: GithubConnectionService;
      integrationRegistry?: IntegrationRegistryService;
      processFactory?: RuntimeProcessFactory;
      workspaceFactory?: RuntimeWorkspaceFactory;
      skillDiscovery?: CodexSkillDiscoveryService;
      skillBundleStorage: SkillBundleStorage;
      managedToolCatalog: ManagedToolCatalog;
      activationTracker?: ActivationTracker;
    },
    private readonly lifecycle: CodexSessionLifecycle,
    private readonly bindProcessHandlers: (runtime: RuntimeState) => void
  ) {}

  async startRuntime(
    tenantId: string,
    sessionId: string,
    userId: string
  ): Promise<RuntimeState> {
    const skillDiscovery = this.deps.skillDiscovery ?? new CodexSkillDiscoveryService();
    const runtimeConfig = await this.prepareRuntimeConfig(tenantId, sessionId, userId);
    const { workspace, processEnv, runtimeId, startedAt } = await this.prepareRuntimeWorkspaceAndEnv({
      tenantId,
      sessionId,
      userId,
      runtimeConfig
    });

    let process: RuntimeProcessHandle | null = null;
    try {
      const runtime = await this.spawnRuntimeProcess({
        tenantId,
        sessionId,
        userId,
        runtimeId,
        workspace,
        runtimeConfig,
        processEnv,
        startedAt
      });
      process = runtime.process;
      await this.initializeRuntimeThreadAndSkills({ runtime, workspace, runtimeConfig, skillDiscovery });
      return runtime;
    } catch (error) {
      await this.recordStartupFailure({
        tenantId,
        sessionId,
        userId,
        runtimeId,
        workspace,
        process,
        startedAt,
        error
      });
      throw error;
    }
  }

  private async prepareRuntimeConfig(
    tenantId: string,
    sessionId: string,
    userId: string
  ): Promise<RuntimeConfigBundle> {
    const isBetaTester = this.deps.isBetaTester
      ? await this.deps.isBetaTester(tenantId, userId)
      : true;
    const runtimeConfig = await this.deps.dynamicConfig.compileRuntimeConfig(
      tenantId,
      isBetaTester,
      sessionId
    );
    runtimeConfig.runtimePolicy = {
      ...runtimeConfig.runtimePolicy,
      runtimeProvider: "codex"
    };

    // Per-integration tool ids resolved from tenant_integrations toggles +
    // user connection presence. Single source of truth — admin toggles
    // cannot be bypassed.
    if (this.deps.integrationRegistry) {
      try {
        const integrationIds = await this.deps.integrationRegistry.resolveSessionToolIds(
          tenantId,
          userId
        );
        const existing = new Set(runtimeConfig.runtimePolicy.enabledToolIds);
        for (const toolId of integrationIds) {
          if (!existing.has(toolId)) {
            runtimeConfig.runtimePolicy.enabledToolIds.push(toolId);
          }
        }
      } catch (error) {
        this.deps.logger.warn(
          { err: error, sessionId, tenantId, userId },
          "integration registry tool id resolution failed during runtime start"
        );
      }
    }

    return runtimeConfig;
  }

  private async prepareRuntimeWorkspaceAndEnv(input: {
    tenantId: string;
    sessionId: string;
    userId: string;
    runtimeConfig: RuntimeConfigBundle;
  }): Promise<{
    workspace: WorkspaceArtifacts;
    processEnv: Record<string, string> | undefined;
    runtimeId: string;
    startedAt: string;
  }> {
    const { tenantId, sessionId, userId, runtimeConfig } = input;
    const workspaceFactory = this.deps.workspaceFactory ?? createRuntimeWorkspace;

    const runtimeId = uuidv7();
    const [workspace, tenantApiKey] = await Promise.all([
      workspaceFactory(this.config, {
        sessionId,
        userId,
        tenantId,
        runtimeId,
        runtimeConfig,
        skillBundleStorage: this.deps.skillBundleStorage,
        managedToolCatalog: this.deps.managedToolCatalog
      }),
      this.deps.getTenantApiKey
        ? this.deps.getTenantApiKey(tenantId)
        : Promise.resolve(null)
    ]);

    const startedAt = new Date().toISOString();
    const runtimeApiKey =
      tenantApiKey?.trim() ||
      this.config.OPENAI_API_KEY?.trim() ||
      null;
    // In e2b mode the sandbox never holds the real OpenAI key. The env's
    // OPENAI_API_KEY is the session's short-lived rt_* runtime token; Codex
    // is configured (via [model_providers.cogniplane_proxy] in
    // ~/.codex/config.toml) to call /llm/openai on the backend, which swaps
    // the rt_* for the real key. Local mode keeps the real key in env so
    // Codex talks to api.openai.com directly.
    const useOpenaiProxy = this.config.RUNTIME_BACKEND === "e2b" && Boolean(runtimeApiKey);
    let processEnv: Record<string, string> | undefined;
    if (useOpenaiProxy) {
      processEnv = { OPENAI_API_KEY: workspace.runtimeToken };
    } else if (runtimeApiKey) {
      processEnv = { OPENAI_API_KEY: runtimeApiKey };
    }

    if (this.deps.githubConnections) {
      const githubBootstrapWorkspacePath = workspace.localWorkspacePath ?? workspace.workspacePath;
      try {
        const githubCredentials = await this.deps.githubConnections.getRuntimeCredentials(
          tenantId,
          userId
        );
        if (githubCredentials) {
          processEnv = {
            ...(processEnv ?? {}),
            ...(await prepareGithubWorkspace(githubBootstrapWorkspacePath, githubCredentials))
          };
        }
      } catch (error) {
        this.deps.logger.warn(
          { err: error, sessionId, tenantId, userId },
          "github sandbox bootstrap failed"
        );
      }
    }

    if (this.deps.activationTracker) {
      const events: Array<{ resourceType: "skill" | "mcp_server"; resourceId: string; metadata?: Record<string, unknown> }> = [];
      for (const skill of runtimeConfig.skills) {
        events.push({
          resourceType: "skill",
          resourceId: skill.id,
          metadata: {
            revisionId: skill.revisionId,
            bundleHash: skill.bundleHash,
            associatedToolIds: skill.associatedToolIds ?? []
          }
        });
      }
      for (const server of runtimeConfig.mcpServers) {
        events.push({
          resourceType: "mcp_server",
          resourceId: server.id,
          metadata: { mode: server.mode }
        });
      }
      // Best-effort; the tracker swallows DB errors itself.
      await this.deps.activationTracker.recordMaterialization(
        { tenantId, sessionId },
        events
      );
    }

    return { workspace, processEnv, runtimeId, startedAt };
  }

  private async spawnRuntimeProcess(input: {
    tenantId: string;
    sessionId: string;
    userId: string;
    runtimeId: string;
    workspace: WorkspaceArtifacts;
    runtimeConfig: RuntimeConfigBundle;
    processEnv: Record<string, string> | undefined;
    startedAt: string;
  }): Promise<RuntimeState> {
    const { tenantId, sessionId, userId, runtimeId, workspace, runtimeConfig, processEnv, startedAt } =
      input;
    const processFactory = this.deps.processFactory ?? CodexRuntimeProcess.start;

    // Codex CLI ignores project-local config (including [mcp_servers.*]) for
    // any cwd that isn't trusted, and recent versions only honor [mcp_servers.*]
    // from the global ~/.codex/config.toml. We patch the global config to (a)
    // trust the per-session workspace and (b) mirror its [mcp_servers.*] blocks.
    // E2B mode handles this inside buildSandboxCodexConfig; this is the local-mode equivalent.
    await ensureLocalCodexGlobalConfig({
      workspacePath: workspace.workspacePath,
      workspaceCodexTomlPath: workspace.codexTomlPath,
      sessionId,
      logger: this.deps.logger
    });

    const process = await processFactory({
      binaryPath: this.config.CODEX_BINARY_PATH,
      cwd: workspace.workspacePath,
      localWorkspacePath: workspace.localWorkspacePath,
      logger: this.deps.logger,
      requestTimeoutMs: this.config.RUNTIME_REQUEST_TIMEOUT_MS,
      startTimeoutMs: this.config.RUNTIME_START_TIMEOUT_MS,
      runtimeId,
      sessionId,
      env: processEnv
    });

    const runtime = this.lifecycle.createRuntimeState({
      tenantId,
      sessionId,
      userId,
      runtimeId,
      workspace,
      runtimePolicy: runtimeConfig.runtimePolicy,
      process,
      startedAt
    });

    await this.lifecycle.persistRuntime(runtime, "starting", workspace);
    this.bindProcessHandlers(runtime);

    return runtime;
  }

  private async initializeRuntimeThreadAndSkills(input: {
    runtime: RuntimeState;
    workspace: WorkspaceArtifacts;
    runtimeConfig: RuntimeConfigBundle;
    skillDiscovery: CodexSkillDiscoveryService;
  }): Promise<void> {
    const { runtime, workspace, runtimeConfig, skillDiscovery } = input;

    const initResponse = (await runtime.process.sendRequest("initialize", {
      clientInfo: { name: "cogniplane-core", version: "0.1.0" },
      capabilities: { experimentalApi: true }
    })) as {
      codexHome?: string;
      platformOs?: string;
      platformFamily?: string;
      userAgent?: string;
    } | null;

    runtime.process.sendNotification("initialized");

    const threadStart = (await runtime.process.sendRequest("thread/start", {
      model: this.config.CODEX_MODEL,
      cwd: workspace.workspacePath,
      approvalPolicy: runtimeConfig.runtimePolicy.approvalPolicy,
      approvalsReviewer: runtimeConfig.runtimePolicy.approvalReviewer,
      sandbox: this.config.CODEX_SANDBOX_MODE ?? runtimeConfig.runtimePolicy.sandboxMode,
      ...(runtimeConfig.runtimePolicy.developerInstructions
        ? { developerInstructions: runtimeConfig.runtimePolicy.developerInstructions }
        : {}),
      experimentalRawEvents: false,
      persistExtendedHistory: false
    })) as { thread?: { id: string } };

    await this.verifySkillDiscovery(runtime, skillDiscovery);

    runtime.threadId = threadStart.thread?.id ?? "";
    runtime.healthStatus = "healthy";
    runtime.lifecycleMetadata = {
      ...runtime.lifecycleMetadata,
      startupCompletedAt: new Date().toISOString(),
      threadId: runtime.threadId,
      codexHome: initResponse?.codexHome ?? null,
      platformOs: initResponse?.platformOs ?? null,
      platformFamily: initResponse?.platformFamily ?? null,
      codexUserAgent: initResponse?.userAgent ?? null
    };

    await this.lifecycle.persistRuntime(runtime, "active", workspace);
    this.lifecycle.scheduleIdleTeardown(runtime);
    this.lifecycle.registerRuntime(runtime);
  }

  private async recordStartupFailure(input: {
    tenantId: string;
    sessionId: string;
    userId: string;
    runtimeId: string;
    workspace: WorkspaceArtifacts;
    process: RuntimeProcessHandle | null;
    startedAt: string;
    error: unknown;
  }): Promise<void> {
    input.process?.terminate();
    await this.lifecycle.persistStartupFailure({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      userId: input.userId,
      runtimeId: input.runtimeId,
      workspace: input.workspace,
      startedAt: input.startedAt,
      error: input.error,
      process: input.process
    });
  }

  private async verifySkillDiscovery(
    runtime: RuntimeState,
    skillDiscovery: CodexSkillDiscoveryService
  ): Promise<void> {
    const result = await skillDiscovery.verifyInstalledSkills({
      process: runtime.process,
      workspacePath: runtime.workspacePath,
      skills: runtime.manifest.skills.map((skill) => ({
        id: skill.id,
        path: skill.path,
        sourceType: skill.sourceType
      }))
    });

    runtime.lifecycleMetadata = {
      ...runtime.lifecycleMetadata,
      skillDiscoveryVerifiedAt: result.verifiedAt,
      discoveredSkillNames: result.discoveredSkillNames,
      skillDiscoveryErrors: result.skillDiscoveryErrors
    };
  }
}

async function ensureLocalCodexGlobalConfig(input: {
  workspacePath: string;
  workspaceCodexTomlPath: string;
  sessionId: string;
  logger: FastifyBaseLogger;
}): Promise<void> {
  const { workspacePath, workspaceCodexTomlPath, sessionId, logger } = input;
  const codexHome = process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
  const configPath = path.join(codexHome, "config.toml");

  let existing = "";
  try {
    existing = await readFile(configPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      logger.warn(
        { err: error, configPath },
        "Could not read Codex config.toml; spawning without injected config."
      );
      return;
    }
  }

  const trustHeader = `[projects."${workspacePath}"]`;
  let next = existing;

  if (!next.includes(trustHeader)) {
    const trim = next.endsWith("\n") || next.length === 0 ? "" : "\n";
    next = `${next}${trim}\n${trustHeader}\ntrust_level = "trusted"\n`;
  }

  let mcpServersToml = "";
  try {
    const workspaceToml = await readFile(workspaceCodexTomlPath, "utf8");
    mcpServersToml = extractMcpServersToml(workspaceToml);
  } catch (error) {
    logger.warn(
      { err: error, workspaceCodexTomlPath },
      "Could not read workspace codex.toml; managed MCP servers will be unavailable."
    );
  }

  // Strip every prior managed-MCP block (any session). MCP server names like
  // `managed-session-context` are not session-scoped at the TOML level, so
  // leaving stale blocks behind from other sessions produces a duplicate-key
  // error when Codex parses the file. Only one block — the current session's —
  // should ever be present.
  const begin = `# >>> cogniplane-managed-mcp:${sessionId}`;
  const end = `# <<< cogniplane-managed-mcp:${sessionId}`;
  const anyBlockPattern = /\n?# >>> cogniplane-managed-mcp:[^\n]*\n[\s\S]*?# <<< cogniplane-managed-mcp:[^\n]*\n?/g;
  next = next.replace(anyBlockPattern, "\n");

  if (mcpServersToml) {
    const trim = next.endsWith("\n") || next.length === 0 ? "" : "\n";
    next = `${next}${trim}\n${begin}\n${mcpServersToml}\n${end}\n`;
  }

  if (next === existing) {
    return;
  }

  try {
    await mkdir(codexHome, { recursive: true });
    await writeFile(configPath, next, { mode: 0o600 });
    logger.info(
      { workspacePath, configPath, mcpServers: mcpServersToml.length > 0 },
      "Updated Codex global config (project trust + managed MCP servers)"
    );
  } catch (error) {
    logger.warn(
      { err: error, configPath, workspacePath },
      "Failed to update Codex global config; spawning anyway."
    );
  }
}
