import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { uuidv7 } from "../../lib/uuid.js";

import type { FastifyBaseLogger } from "fastify";

import type { AppConfig } from "../../config.js";
import { ClaudeApprovalHandler } from "./claude-code-approval-handler.js";
import { renderClaudeWorkspace } from "./claude-workspace-renderer.js";
import { E2bClaudeRuntimeProcess } from "../runtime/e2b-claude-runtime-process.js";
import { E2B_WORKSPACE_BASE } from "../runtime/e2b-runtime-process.js";
import type { RuntimeConfigBundle } from "../admin-config-records.js";
import { generateRuntimeToken, runtimeTokenExpiry } from "../auth/runtime-token.js";
import type { ManagedToolCatalog } from "../managed-tools/catalog.js";
import type { ClaudeCodeE2bOptions, ClaudeMcpServerEntry, ClaudeSessionState } from "./claude-types.js";
import { buildClaudeSdkEnv, buildClaudeSdkOptions } from "./claude-sdk-helpers.js";
import type { RuntimeManifest } from "../../domain/runtime-manifest.js";
import type { ActivationTracker } from "../activation-tracker.js";
import type { ApprovalStore } from "../auth/approval-store.js";
import type { DynamicConfigService } from "../dynamic-config-service.js";
import type { IntegrationRegistryService } from "../integrations/integration-registry-service.js";
import type { RuntimeSessionStore } from "../runtime/runtime-session-store.js";

export async function bootstrapClaudeSession(
  input: { tenantId: string; sessionId: string; userId: string },
  ctx: {
    config: AppConfig;
    dynamicConfig: DynamicConfigService;
    log: FastifyBaseLogger;
    getTenantApiKey?: (tenantId: string) => Promise<string | null>;
    e2bOptions?: ClaudeCodeE2bOptions | null;
    integrationRegistry?: IntegrationRegistryService;
    activationTracker?: ActivationTracker;
    managedToolCatalog: ManagedToolCatalog;
    stores?: { approvals?: ApprovalStore; runtimeSessions?: RuntimeSessionStore };
  }
): Promise<ClaudeSessionState> {
  const { tenantId, sessionId, userId } = input;
  const { config, dynamicConfig, log, getTenantApiKey, e2bOptions, integrationRegistry, activationTracker, managedToolCatalog, stores } = ctx;

  const runtimeId = `claude-${uuidv7()}`;

  const configBundle = await dynamicConfig.compileRuntimeConfig(tenantId, true, sessionId);
  configBundle.runtimePolicy = {
    ...configBundle.runtimePolicy,
    runtimeProvider: "claude-code"
  };

  // Union per-integration tool ids resolved from tenant_integrations toggles
  // (deduped). See codex-workspace-bootstrap.ts for the matching codex-side
  // injection.
  if (integrationRegistry) {
    try {
      const integrationIds = await integrationRegistry.resolveSessionToolIds(tenantId, userId);
      const existing = new Set(configBundle.runtimePolicy.enabledToolIds);
      for (const toolId of integrationIds) {
        if (!existing.has(toolId)) {
          configBundle.runtimePolicy.enabledToolIds.push(toolId);
        }
      }
    } catch (error) {
      log.warn(
        { err: error, sessionId, tenantId, userId },
        "integration registry tool id resolution failed during claude session bootstrap"
      );
    }
  }

  const { runtimePolicy } = configBundle;

  const approvalHandler = new ClaudeApprovalHandler();
  approvalHandler.setAutoApproveReadOnly(runtimePolicy.autoApproveReadOnlyTools);
  approvalHandler.setReadOnlyManagedToolNames(managedToolCatalog.listReadOnlyIds());
  approvalHandler.setApprovalTtlMs(config.APPROVAL_REQUEST_TTL_MS);
  const abortController = new AbortController();

  const tenantAnthropicKey = getTenantApiKey ? await getTenantApiKey(tenantId) : null;
  const anthropicApiKey = tenantAnthropicKey?.trim() || config.ANTHROPIC_API_KEY || null;

  const mode: "local" | "e2b" = config.CLAUDE_RUNTIME_BACKEND === "e2b" && e2bOptions ? "e2b" : "local";

  // ── Common setup (independent of mode) ──────────────────────────────────────

  const runtimeToken = generateRuntimeToken(
    {
      sid: sessionId,
      tid: tenantId,
      uid: userId,
      rid: runtimeId,
      exp: runtimeTokenExpiry(config.RUNTIME_TOKEN_TTL_MS)
    },
    config.DATA_ENCRYPTION_SECRET
  );

  const gatewayBase = config.RUNTIME_GATEWAY_BASE_URL.replace(/\/$/, "");
  // The SDK calls the backend's /llm/anthropic proxy in both local and e2b
  // mode so token usage + cost get captured uniformly via activeTurnMessageMap.
  // The real ANTHROPIC_API_KEY never leaves the backend; the SDK only ever
  // sees the session's short-lived rt_* runtime token.
  const proxyBaseUrl = `${gatewayBase}/llm/anthropic`;

  const sessionBase = {
    sessionId,
    tenantId,
    userId,
    runtimeId,
    configBundle,
    approvalHandler,
    abortController,
    claudeSessionId: null,
    anthropicApiKey,
    proxyBaseUrl,
    mode
  };
  const mcpServerEntries: ClaudeMcpServerEntry[] = configBundle.mcpServers.map((server) => {
    const url = new URL(server.routePath, gatewayBase + "/");
    return { id: server.id, url: url.toString() };
  });

  // Mutable ref for the per-turn canUseTool handler. Passed into the startup()
  // warmup options as a stable closure so the subprocess never needs rebuilding.
  const warmCanUseToolRef: { current: NonNullable<import("@anthropic-ai/claude-agent-sdk").Options["canUseTool"]> | null } = {
    current: null
  };

  const renderWorkspace = async (workspacePath: string, source: "local" | "e2b-staging") => {
    await renderClaudeWorkspace({
      workspacePath,
      developerInstructions: runtimePolicy.developerInstructions,
      skills: configBundle.skills.map((s) => ({ id: s.id, name: s.name, instructions: s.instructions })),
      mcpServers: configBundle.mcpServers.map((server, index) => ({
        id: server.id,
        url: mcpServerEntries[index]?.url ?? server.routePath,
        mode: server.mode
      })),
      enabledToolIds: runtimePolicy.enabledToolIds,
      runtimeToken,
      managedToolCatalog
    });
    await logClaudeWorkspaceDiagnostics(log, { workspacePath, sessionId, runtimeId, source });
  };

  // ── Mode-specific workspace setup ────────────────────────────────────────────

  let state: ClaudeSessionState;

  if (mode === "e2b") {
    const sandboxWorkspacePath = path.posix.join(E2B_WORKSPACE_BASE, sessionId);
    const localStagingPath = path.join(
      config.RUNTIME_WORKSPACE_ROOT,
      `claude-e2b-staging-${runtimeId}`
    );
    await mkdir(localStagingPath, { recursive: true });
    await renderWorkspace(localStagingPath, "e2b-staging");

    if (!e2bOptions) throw new Error("e2b mode requires e2bOptions to be set");
    // RUNTIME_GATEWAY_BASE_URL must be reachable from the sandbox — same
    // requirement the MCP gateway already imposes.
    const sandboxEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      buildClaudeSdkEnv(anthropicApiKey, { runtimeToken, baseUrl: proxyBaseUrl })
    )) {
      if (typeof value === "string") sandboxEnv[key] = value;
    }

    const e2bProcess = await E2bClaudeRuntimeProcess.start({
      e2bApiKey: e2bOptions.apiKey,
      e2bTemplateId: e2bOptions.templateId,
      e2bSandboxTimeoutMs: e2bOptions.sandboxTimeoutMs,
      workspacePath: sandboxWorkspacePath,
      localWorkspacePath: localStagingPath,
      env: sandboxEnv,
      logger: log,
      sessionId,
      runtimeId
    });

    e2bProcess
      .sendWarmup({
        type: "warmup",
        model: config.CLAUDE_CODE_MODEL,
        developerInstructions: runtimePolicy.developerInstructions,
        mcpServers: mcpServerEntries.map((e) => ({
          id: e.id,
          url: e.url,
          authorization: `Bearer ${runtimeToken}`
        }))
      })
      .catch((err: unknown) => {
        log.warn({ err, sessionId }, "Failed to send E2B warmup frame; first turn will cold-start");
      });

    state = {
      ...sessionBase,
      workspacePath: sandboxWorkspacePath,
      localStagingPath,
      runtimeToken,
      mcpServerEntries,
      e2bProcess,
      warmCanUseToolRef,
      warmState: null,
      activeTurnInterrupt: { current: null }
    };
  } else {
    const workspacePath = path.join(config.RUNTIME_WORKSPACE_ROOT, runtimeId);
    await mkdir(workspacePath, { recursive: true });
    await renderWorkspace(workspacePath, "local");

    const mcpServersConfig: Record<string, { type: "http"; url: string; headers: Record<string, string> }> = {};
    for (const server of mcpServerEntries) {
      mcpServersConfig[server.id] = {
        type: "http",
        url: server.url,
        headers: { Authorization: `Bearer ${runtimeToken}` }
      };
    }

    const warmState = import("@anthropic-ai/claude-agent-sdk")
      .then(async (sdk) => {
        const wq = await sdk.startup({
          options: buildClaudeSdkOptions({
            model: config.CLAUDE_CODE_MODEL,
            developerInstructions: runtimePolicy.developerInstructions,
            mcpServersConfig,
            workspacePath,
            env: buildClaudeSdkEnv(anthropicApiKey, { runtimeToken, baseUrl: proxyBaseUrl }),
            canUseTool: (toolName, toolInput, opts) => {
              const fn = warmCanUseToolRef.current;
              return fn
                ? fn(toolName, toolInput, opts)
                : Promise.resolve({ behavior: "deny" as const, message: "No active turn" });
            }
          })
        });
        return { query: wq, model: config.CLAUDE_CODE_MODEL };
      })
      .catch((err: unknown) => {
        log.warn({ err, sessionId }, "Claude SDK startup() pre-warm failed; first turn will cold-start");
        return null;
      });

    state = {
      ...sessionBase,
      workspacePath,
      localStagingPath: null,
      runtimeToken,
      mcpServerEntries,
      e2bProcess: null,
      warmCanUseToolRef,
      warmState,
      activeTurnInterrupt: { current: null }
    };
  }

  const { workspacePath } = state;

  if (activationTracker) {
    const events: Array<{ resourceType: "skill" | "mcp_server"; resourceId: string; metadata?: Record<string, unknown> }> = [];
    for (const skill of configBundle.skills) {
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
    for (const server of configBundle.mcpServers) {
      events.push({
        resourceType: "mcp_server",
        resourceId: server.id,
        metadata: { mode: server.mode }
      });
    }
    await activationTracker.recordMaterialization({ tenantId, sessionId }, events);
  }

  if (stores?.runtimeSessions) {
    const now = new Date().toISOString();
    try {
      await stores.runtimeSessions.upsert({
        tenantId,
        sessionId,
        userId,
        runtimeId,
        runtimeProvider: "claude-code",
        workspacePath,
        runtimeVersion: "claude-agent-sdk",
        runtimeSchemaVersion: "1",
        manifestPath: "",
        manifestMetadata: buildClaudeRuntimeManifest(configBundle, sessionId, userId, workspacePath),
        healthStatus: "healthy",
        lastActiveAt: now,
        startedAt: now,
        terminatedAt: null,
        lifecycleMetadata: { provider: "claude-code", mode: state.mode },
        status: "active"
      });
    } catch (err) {
      log.warn({ err, sessionId }, "Failed to persist Claude runtime session");
    }
  }

  return state;
}

async function logClaudeWorkspaceDiagnostics(
  log: FastifyBaseLogger,
  input: {
    workspacePath: string;
    sessionId: string;
    runtimeId: string;
    source: "local" | "e2b-staging";
  }
): Promise<void> {
  try {
    const [claudeMd, mcpJsonRaw] = await Promise.all([
      readFile(path.join(input.workspacePath, "CLAUDE.md"), "utf-8"),
      readFile(path.join(input.workspacePath, ".mcp.json"), "utf-8").catch(() => null)
    ]);
    const parsedMcpJson = mcpJsonRaw
      ? (JSON.parse(mcpJsonRaw) as { mcpServers?: Record<string, { type?: string; url?: string }> })
      : null;
    const mcpServers = parsedMcpJson?.mcpServers ?? {};
    log.info(
      {
        sessionId: input.sessionId,
        runtimeId: input.runtimeId,
        source: input.source,
        claudeMdBytes: claudeMd.length,
        claudeMdHasAvailableMcpTools: claudeMd.includes("## Available MCP Tools"),
        claudeMdHasWriteArtifactRule: claudeMd.includes("write_artifact"),
        claudeMdSkillSectionCount: (claudeMd.match(/^## Skill:/gm) ?? []).length,
        mcpServerIds: Object.keys(mcpServers),
        mcpServerTypes: Object.fromEntries(
          Object.entries(mcpServers).map(([id, s]) => [id, s.type ?? null])
        ),
        mcpServerUrls: Object.fromEntries(
          Object.entries(mcpServers).map(([id, s]) => [id, s.url ?? null])
        )
      },
      "Claude workspace diagnostics"
    );
  } catch (err) {
    log.warn(
      { err, sessionId: input.sessionId, runtimeId: input.runtimeId, source: input.source },
      "Failed to collect Claude workspace diagnostics"
    );
  }
}

function buildClaudeRuntimeManifest(
  configBundle: RuntimeConfigBundle,
  sessionId: string,
  userId: string,
  workspacePath: string
): RuntimeManifest {
  const { runtimePolicy, skills, mcpServers, sources } = configBundle;
  const now = new Date().toISOString();
  return {
    manifestVersion: "1",
    manifestHash: configBundle.hash,
    configBundleHash: configBundle.hash,
    sessionId,
    userId,
    generatedAt: now,
    workspacePath,
    // Not applicable for Claude — sentinel values clearly indicate "not Codex"
    codex: { binaryPath: "n/a", version: "n/a", schemaVersion: "n/a", model: "n/a" },
    runtimePolicy: {
      id: runtimePolicy.id,
      version: runtimePolicy.version,
      hash: runtimePolicy.hash,
      approvalPolicy:
        typeof runtimePolicy.approvalPolicy === "string"
          ? runtimePolicy.approvalPolicy
          : "on-request",
      sandboxMode: runtimePolicy.sandboxMode,
      networkMode: runtimePolicy.networkMode,
      allowCommandExecution: runtimePolicy.allowCommandExecution,
      allowUserTokenForwarding: runtimePolicy.allowUserTokenForwarding,
      autoApproveReadOnlyTools: runtimePolicy.autoApproveReadOnlyTools,
      enabledToolIds: runtimePolicy.enabledToolIds
    },
    skills: skills.map((s) => ({
      id: s.id,
      name: s.name,
      version: s.version,
      hash: s.hash,
      revisionId: s.revisionId,
      bundleHash: s.bundleHash ?? "",
      path: `.claude/commands/${s.name}.md`,
      sourceType: s.sourceType
    })),
    mcpServers: mcpServers.map((s) => ({
      id: s.id,
      version: s.version,
      hash: s.hash,
      mode: s.mode,
      url: s.routePath
    })),
    configSources: sources,
    config: {
      codexTomlPath: "n/a",
      skillsPath: ".claude/commands",
      customSkillsEnabled: skills.length > 0,
      customMcpServersEnabled: mcpServers.length > 0
    }
  };
}
