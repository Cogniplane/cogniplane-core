// Production DeepAgentsRuntimeFactory: compiles a deepagentsjs agent with
// initChatModel, the shared Postgres checkpointer, the lazy E2B sandbox
// backend, MCP gateway tools, and interrupt-based HITL approvals.
//
// MCP (bead im5e.4): a MultiServerMCPClient speaks streamable HTTP to the
// platform gateway (/mcp/:serverId) with the session's Bearer rt_* token —
// header auth only, never `?token=`. The per-turn toolContextId is injected
// into managed tool inputs at CALL time via a mutable ref, so the client
// never needs rebuilding between turns.
//
// Approvals (bead im5e.4): `interruptOn` (langchain humanInTheLoopMiddleware)
// pauses BEFORE tool execution and checkpoints — no held promise, no
// in-sandbox bridge. The adapter detects the pending interrupt after the
// stream ends, runs the approval round-trip, and resumes with a Command.

import { MemorySaver, Command, type BaseCheckpointSaver } from "@langchain/langgraph";
import type { ServerTool } from "@langchain/core/tools";
import { initChatModel } from "langchain";
import { CompositeBackend, StateBackend, createDeepAgent } from "deepagents";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";

import type { ModelProvider } from "@cogniplane/shared-types";
import { MODEL_PROVIDERS, MODEL_PROVIDER_META } from "@cogniplane/shared-types";

import { AVAILABLE_MODELS } from "../../domain/models.js";
import type { RuntimeReasoningEffort } from "../../runtime-contracts.js";

import { E2bDeepAgentsSandbox } from "./deep-agents-e2b-backend.js";
import { SKILLS_LIBRARY_PREFIX, createSkillsLibraryBackend } from "./deep-agents-skills-library.js";
import type {
  DeepAgentsGraph,
  DeepAgentsPendingAction,
  DeepAgentsRuntimeFactory,
  DeepAgentsSessionRuntime
} from "./deep-agents-types.js";

/**
 * Resolves the construction facts for an AVAILABLE_MODELS id:
 *   - `provider` — the public provider id (drives credential resolution).
 *   - `initModelId` — the LangChain `initChatModel` string
 *     ("<initPrefix>:<vendorModel>"). The initPrefix is NOT always the public
 *     provider ("openrouter" → "openai", "google" → "google-genai").
 *   - `baseUrl` — OpenAI-client base URL override (OpenRouter); null otherwise.
 *
 * The catalog id is namespaced "<catalogPrefix>/<vendorModel>" (e.g.
 * "deepagents/claude-sonnet-5", "openai/gpt-5.4",
 * "openrouter/meta-llama/llama-4-70b"). Only the FIRST path segment is the
 * namespace; the remainder is the vendor model id (which may itself contain
 * slashes, as OpenRouter ids do). The provider comes from the catalog entry,
 * not the namespace, so a mislabeled namespace can't pick the wrong client.
 */
export function resolveModelConstruction(modelId: string): {
  provider: ModelProvider;
  /** Bare vendor model id (namespace stripped; inner slashes preserved). */
  vendorModel: string;
  initModelId: string;
  baseUrl: string | null;
} {
  const entry = AVAILABLE_MODELS.find((m) => m.id === modelId);
  const slash = modelId.indexOf("/");
  const namespace = slash === -1 ? null : modelId.slice(0, slash);
  // Provider resolution order:
  //   1. the static catalog entry (builtin models — namespace may be a legacy
  //      alias like "deepagents", so the entry is authoritative),
  //   2. the id's namespace when it names a provider — admin-added custom
  //      models (tenant_custom_models) are constructed server-side as
  //      "<provider>/<vendorModelId>" exactly so this lookup needs no DB call,
  //   3. Anthropic as the never-throw fallback (legacy/test paths); the
  //      resolver validates ids upstream.
  const provider: ModelProvider =
    entry?.provider ??
    (namespace && (MODEL_PROVIDERS as readonly string[]).includes(namespace)
      ? (namespace as ModelProvider)
      : "anthropic");
  const meta = MODEL_PROVIDER_META[provider];
  const vendorModel = slash === -1 ? modelId : modelId.slice(slash + 1);
  return {
    provider,
    vendorModel,
    initModelId: `${meta.initPrefix}:${vendorModel}`,
    baseUrl: meta.baseUrl
  };
}

/**
 * Thrown by getAgentForModel when the selected model's provider has no
 * configured key. The adapter maps this to a client-safe turn failure.
 */
export class ProviderKeyMissingError extends Error {
  // 400 so clientSafeTurnFailureMessage passes the message through as
  // user-actionable (configure a key) rather than collapsing it to a generic
  // internal-failure string.
  readonly statusCode = 400;
  constructor(public readonly provider: ModelProvider) {
    super(
      `No API key is configured for the "${provider}" model provider. ` +
        `Add a ${provider} API key in organization settings or choose a different model.`
    );
    this.name = "ProviderKeyMissingError";
  }
}

/**
 * initChatModel base-URL option shaped per provider client. Each LangChain
 * chat client names this differently, and — critically for OpenAI/OpenRouter —
 * a top-level `baseUrl`/`baseURL` is IGNORED; the OpenAI client only reads
 * `configuration.baseURL` (verified against @langchain/openai). Returns an
 * empty object when no override applies (each client hits its own default).
 */
export function buildProviderBaseUrlOptions(
  provider: ModelProvider,
  baseUrl: string | null
): Record<string, unknown> {
  if (!baseUrl) return {};
  switch (MODEL_PROVIDER_META[provider].initPrefix) {
    case "anthropic":
      return { anthropicApiUrl: baseUrl };
    case "openai":
      // Includes OpenRouter (rides the OpenAI client). Must be nested under
      // `configuration`, not a top-level baseURL.
      return { configuration: { baseURL: baseUrl } };
    case "google-genai":
      return { baseUrl };
    default:
      return {};
  }
}

/**
 * initChatModel options that pin native OpenAI models to the Responses API.
 *
 * ChatOpenAI picks Chat Completions vs Responses per model via a hardcoded
 * allowlist (`_modelPrefersResponsesAPI`) that lags new releases — the GPT-5.6
 * family isn't in it as of @langchain/openai 1.5.3, and OpenAI rejects
 * function tools + `reasoning_effort` on /v1/chat/completions for those models
 * ("use /v1/responses or set reasoning_effort to 'none'"), which bricked every
 * tool-bearing turn. The Responses API is OpenAI's recommended path for all
 * GPT-5.x, so force it for the whole native-OpenAI catalog rather than
 * chasing the family list.
 *
 * Keyed on the provider, NOT the initPrefix: OpenRouter and Z.AI ride the
 * OpenAI client but their gateways speak Chat Completions.
 */
export function buildOpenAiResponsesApiOptions(
  provider: ModelProvider
): Record<string, unknown> {
  return provider === "openai" ? { useResponsesApi: true } : {};
}

/**
 * initChatModel options that bake reasoning effort into the chat model, shaped
 * per provider client (bead i52g). Each SDK names its knob differently and
 * accepts a different value set:
 *
 * - Anthropic (`@langchain/anthropic`): `outputConfig.effort` takes
 *   low/medium/high/xhigh/max and `thinking: { type: "adaptive" }` turns on
 *   extended thinking. `none` disables thinking (no outputConfig, no thinking).
 * - OpenAI (`@langchain/openai`, also OpenRouter): `reasoning.effort` takes
 *   none/minimal/low/medium/high/xhigh directly — pass the level through.
 * - Google (`@langchain/google-genai`): `thinkingConfig.thinkingLevel` takes
 *   LOW/MEDIUM/HIGH; `none` sets `thinkingBudget: 0` to disable thinking.
 *
 * Returns an empty object when there is no effort to apply (null/undefined, or
 * a provider we don't map), so the client keeps its own default. Effort levels
 * a provider can't express are clamped to its nearest supported level.
 */
export function applyReasoningEffort(
  provider: ModelProvider,
  effort: RuntimeReasoningEffort | null | undefined
): Record<string, unknown> {
  if (!effort) return {};
  switch (MODEL_PROVIDER_META[provider].initPrefix) {
    case "anthropic": {
      if (effort === "none") return {};
      // Anthropic's effort scale starts at "low"; "minimal" clamps up to it.
      const anthropicEffort = effort === "minimal" ? "low" : effort;
      return {
        thinking: { type: "adaptive" },
        outputConfig: { effort: anthropicEffort }
      };
    }
    case "openai":
      // Includes OpenRouter (rides the OpenAI client). OpenAI's ReasoningEffort
      // enum covers none/minimal/low/medium/high/xhigh — pass through. OpenRouter
      // models advertise no efforts today, so this path is OpenAI-only in practice.
      return { reasoning: { effort } };
    case "google-genai": {
      if (effort === "none") return { thinkingConfig: { thinkingBudget: 0 } };
      // Gemini thinkingLevel is LOW/MEDIUM/HIGH; minimal→LOW, xhigh/max→HIGH.
      const level =
        effort === "minimal" || effort === "low"
          ? "LOW"
          : effort === "medium"
            ? "MEDIUM"
            : "HIGH";
      return { thinkingConfig: { thinkingLevel: level } };
    }
    default:
      return {};
  }
}

/** Built-in Deep Agents tools that mutate state — gated whenever approvals are on. */
const MUTATING_BUILTIN_TOOLS = ["execute", "write_file", "edit_file"];
/**
 * Read-only built-ins. Gated only when the tenant turned OFF
 * autoApproveReadOnlyTools — that flag is the explicit "prompt me even for
 * reads" posture: every tool is gated and the read-only bypass is opt-in
 * (semantics carried over from the retired Claude runtime's canUseTool).
 * `write_todos` (plan state) and `task`
 * (subagent dispatch; its inner tool calls are gated individually) stay
 * ungated.
 */
const READ_ONLY_BUILTIN_TOOLS = ["ls", "read_file", "glob", "grep"];

/**
 * Names createDeepAgent reserves for its built-in tools — pinned to
 * deepagents@1.10.5 (BUILTIN_TOOL_NAMES in agent.ts = FILESYSTEM_TOOL_NAMES +
 * ASYNC_TASK_TOOL_NAMES + task + write_todos; the library does not export the
 * constant, so re-check on every SDK bump — deep-agents-graph.test.ts pins
 * this list against createDeepAgent's actual collision check). An MCP tool
 * with one of these names would make createDeepAgent throw
 * TOOL_NAME_COLLISION and brick the session, so such tools (possible via
 * proxy MCP servers exposing arbitrary upstream names) are dropped at load
 * time with a warning instead.
 */
export const RESERVED_BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...MUTATING_BUILTIN_TOOLS,
  ...READ_ONLY_BUILTIN_TOOLS,
  "task",
  "write_todos",
  "start_async_task",
  "check_async_task",
  "update_async_task",
  "cancel_async_task",
  "list_async_tasks"
]);

type LangchainToolLike = {
  name: string;
  description?: string;
  schema?: unknown;
  invoke: (args: Record<string, unknown>) => Promise<unknown>;
};

export const createDeepAgentsSessionRuntime: DeepAgentsRuntimeFactory = (init) => {
  // Durable PostgresSaver shared across all sessions when wired (im5e.3) —
  // conversations then resume across process restarts. Per-session MemorySaver
  // fallback otherwise. Either way the same instance is reused across model
  // rebuilds so a per-turn model switch keeps the thread history.
  const checkpointer = (init.checkpointer as BaseCheckpointSaver | undefined) ?? new MemorySaver();
  // One lazy sandbox per session: files persist across turns; chat-only
  // sessions never create it.
  const sandbox = init.e2b
    ? new E2bDeepAgentsSandbox({
        apiKey: init.e2b.apiKey,
        templateId: init.e2b.templateId,
        sandboxTimeoutMs: init.e2b.sandboxTimeoutMs,
        executeTimeoutMs: init.e2b.executeTimeoutMs,
        workspacePath: init.workspacePath,
        sessionId: init.sessionId,
        runtimeId: init.runtimeId,
        logger: init.logger
      })
    : null;

  // Skills library (bead kpit): enabled skills are served read-only at
  // /skills/ through a CompositeBackend route, and surfaced to the model by
  // the native deepagents skills middleware (`skills` param below) with
  // progressive disclosure. Routing — instead of staging files into the
  // sandbox — keeps the sandbox lazy (chat-only sessions with skills still
  // never create one) and the library immutable. When the default backend is
  // the sandbox, CompositeBackend still delegates `execute` to it and exposes
  // its non-empty `id`, so the execute tool stays available; without a
  // sandbox the composite wraps the same per-run StateBackend the library
  // would default to, and its empty `id` keeps execute hidden.
  const skillsFiles =
    init.skillsLibraryFiles && Object.keys(init.skillsLibraryFiles).length > 0
      ? init.skillsLibraryFiles
      : null;
  const skillsRoutes = skillsFiles
    ? { [SKILLS_LIBRARY_PREFIX]: createSkillsLibraryBackend(skillsFiles) }
    : null;
  const backend = skillsRoutes
    ? sandbox
      ? new CompositeBackend(sandbox, skillsRoutes)
      : // Mirrors createDeepAgent's default backend factory — StateBackend
        // needs the per-run config, so the composite is built per resolve.
        (config: { state: unknown }) =>
          new CompositeBackend(new StateBackend(config as ConstructorParameters<typeof StateBackend>[0]), skillsRoutes)
    : sandbox;

  const toolContextRef = init.toolContextRef ?? { current: null };
  const mcpToolNames = new Set<string>();
  const mcpToolServers = new Map<string, string>();
  let mcpClient: MultiServerMCPClient | null = null;
  let mcpToolsPromise: Promise<LangchainToolLike[]> | null = null;
  // Cached compiled agent, keyed by BOTH the model id and the reasoning effort
  // — effort is baked into the chat model at construction, so a change to
  // either invalidates the cache and rebuilds.
  let compiled: {
    modelId: string;
    effort: RuntimeReasoningEffort | null;
    agent: DeepAgentsGraph;
  } | null = null;

  // Path-semantics glue (verified live): the deepagents file tools go through
  // our backend, which roots "/" at the session workspace — but `execute`
  // shell commands see the REAL sandbox filesystem, where "/" is not
  // writable. Relative paths resolve identically on both sides (file tools
  // resolve against the workspace; execute runs with cwd = workspace), so
  // steer the model to relative paths.
  const workspaceNote = sandbox
    ? [
        "## Workspace",
        "",
        `Your working directory is ${init.workspacePath}. Shell commands run there,`,
        "and file tools resolve paths against it. ALWAYS use relative paths (e.g.",
        "`sales.csv`, `artifacts/chart.png`) in both shell commands and file tools",
        "so they refer to the same files. Never write to filesystem-root paths",
        'like "/file.txt".',
        ...(skillsFiles
          ? [
              "",
              `The read-only skills library at ${SKILLS_LIBRARY_PREFIX} is served by the`,
              "file tools only (ls, read_file, grep, glob) — shell commands cannot see",
              "it. To run a skill's script, read_file it and re-create it in the",
              "workspace first."
            ]
          : [])
      ].join("\n")
    : null;
  const systemPromptParts = [init.systemPrompt, workspaceNote].filter(
    (part): part is string => Boolean(part)
  );
  const systemPrompt = systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : null;

  /**
   * Load gateway tools once per session. The Bearer token is session-scoped;
   * only toolContextId rotates per turn, injected below at call time. A load
   * failure degrades to "no MCP tools" (logged) rather than failing session
   * creation, so a gateway hiccup at bootstrap doesn't kill the session.
   */
  const loadMcpTools = (): Promise<LangchainToolLike[]> => {
    if (mcpToolsPromise) return mcpToolsPromise;
    const servers = init.mcpServers ?? [];
    if (servers.length === 0) {
      mcpToolsPromise = Promise.resolve([]);
      return mcpToolsPromise;
    }
    mcpToolsPromise = (async () => {
      // Per-call arg injection via the adapter library's beforeToolCall hook
      // (NOT a tool re-wrap, which would degrade the tools' schemas): the
      // CURRENT turn's toolContextId is merged into managed tool args at call
      // time. ALWAYS
      // overrides any model-supplied value: the managed tool schemas expose
      // the field, and models hallucinate ids into it (observed live), which
      // the gateway then rejects. The backend-held per-turn id is the only
      // trusted source.
      const beforeToolCall = (_request: { args?: unknown }) => {
        if (!toolContextRef.current) return {};
        return { args: { toolContextId: toolContextRef.current } };
      };
      mcpClient = new MultiServerMCPClient({
        mcpServers: Object.fromEntries(
          servers.map((server) => [
            server.id,
            {
              transport: "http" as const,
              url: server.url,
              headers: { Authorization: server.authorization }
            }
          ])
        ),
        // Top-level, NOT per-server: the client's zod config parse strips
        // unknown per-connection keys, silently dropping a per-server hook.
        beforeToolCall,
        // Default is "throw", which would let one unreachable server take
        // down EVERY gateway tool via the catch below. Log-and-skip degrades
        // per server instead.
        onConnectionError: ({ serverName, error }) => {
          init.logger.warn(
            { err: error, serverName, sessionId: init.sessionId },
            "Deep Agents MCP server connection failed; its tools are skipped"
          );
        },
        throwOnLoadError: false
      });
      const tools: LangchainToolLike[] = [];
      // Per-server loads so (a) tool→server attribution is recorded (the
      // adapter library does not put the server name anywhere on the tool)
      // and (b) one broken server degrades to a warning, not zero MCP tools.
      for (const server of servers) {
        let serverTools: LangchainToolLike[];
        try {
          serverTools = (await mcpClient.getTools(server.id)) as unknown as LangchainToolLike[];
        } catch (err) {
          init.logger.warn(
            { err, serverId: server.id, sessionId: init.sessionId },
            "Failed to load MCP tools from gateway server for Deep Agents session"
          );
          continue;
        }
        for (const tool of serverTools) {
          if (RESERVED_BUILTIN_TOOL_NAMES.has(tool.name)) {
            init.logger.warn(
              { toolName: tool.name, serverId: server.id, sessionId: init.sessionId },
              "MCP tool name collides with a Deep Agents built-in tool; dropped"
            );
            continue;
          }
          if (mcpToolNames.has(tool.name)) {
            init.logger.warn(
              {
                toolName: tool.name,
                serverId: server.id,
                firstServerId: mcpToolServers.get(tool.name),
                sessionId: init.sessionId
              },
              "Duplicate MCP tool name across gateway servers; keeping the first"
            );
            continue;
          }
          mcpToolNames.add(tool.name);
          mcpToolServers.set(tool.name, server.id);
          tools.push(tool);
        }
      }
      return tools;
    })();
    return mcpToolsPromise;
  };

  const runtime: DeepAgentsSessionRuntime = {
    async getAgentForModel(
      modelId: string,
      effort?: RuntimeReasoningEffort | null
    ): Promise<DeepAgentsGraph> {
      const normalizedEffort = effort ?? null;
      if (compiled && compiled.modelId === modelId && compiled.effort === normalizedEffort) {
        return compiled.agent;
      }

      // Provider + init string are known only now (the model is selected
      // per-turn); resolve the credential for THIS provider.
      const { provider, initModelId, baseUrl } = resolveModelConstruction(modelId);
      const [apiKey, mcpTools] = await Promise.all([
        init.resolveProviderKey(provider),
        loadMcpTools()
      ]);
      if (!apiKey) {
        // Client-safe: the adapter surfaces provider-key errors as a 400-style
        // turn failure rather than a generic internal error.
        throw new ProviderKeyMissingError(provider);
      }

      // Base URL precedence: an explicit test/proxy override wins, else the
      // provider default (OpenRouter's OpenAI base URL, null otherwise).
      const overrideBaseUrl = init.providerBaseUrls?.[provider] ?? null;
      const effectiveBaseUrl = overrideBaseUrl ?? baseUrl;
      const model = await initChatModel(initModelId, {
        apiKey,
        // The in-process loop calls each provider's API DIRECTLY; usage is
        // accounted from stream usage_metadata.
        ...buildProviderBaseUrlOptions(provider, effectiveBaseUrl),
        // Native OpenAI models must use the Responses API — Chat Completions
        // rejects tools + reasoning_effort for newer families (GPT-5.6).
        ...buildOpenAiResponsesApiOptions(provider),
        // Reasoning effort baked in per provider (bead i52g). Empty object when
        // the model has no effort selected, so the client keeps its default.
        ...applyReasoningEffort(provider, normalizedEffort)
      });

      const interruptOn = buildInterruptOn({
        approvals: init.approvals,
        mcpToolNames: [...mcpToolNames]
      });

      // The tools cast bridges our structural LangchainToolLike view back to
      // the library's tool union (the tools really are DynamicStructuredTools
      // from @langchain/mcp-adapters).
      const agent = createDeepAgent({
        model,
        checkpointer,
        ...(mcpTools.length > 0 ? { tools: mcpTools as unknown as ServerTool[] } : {}),
        ...(interruptOn ? { interruptOn } : {}),
        ...(backend ? { backend } : {}),
        // Native skills middleware: lists name/description/path in the system
        // prompt; the model reads SKILL.md (and companions) on demand through
        // the composite backend's /skills/ route.
        ...(skillsFiles ? { skills: [SKILLS_LIBRARY_PREFIX] } : {}),
        ...(systemPrompt ? { systemPrompt } : {})
      }) as unknown as DeepAgentsGraph;

      compiled = { modelId, effort: normalizedEffort, agent };
      return agent;
    },
    async getPendingActions(threadId: string): Promise<DeepAgentsPendingAction[]> {
      if (!compiled) return [];
      const agent = compiled.agent as unknown as {
        getState: (config: { configurable: { thread_id: string } }) => Promise<unknown>;
      };
      const snapshot = (await agent.getState({ configurable: { thread_id: threadId } })) as {
        tasks?: Array<{ interrupts?: Array<{ id?: string; value?: unknown }> }>;
      } | null;
      const actions: DeepAgentsPendingAction[] = [];
      for (const task of snapshot?.tasks ?? []) {
        for (const interruptEntry of task.interrupts ?? []) {
          const value = interruptEntry.value as
            | { actionRequests?: Array<{ name?: string; args?: Record<string, unknown>; description?: string }> }
            | undefined;
          for (const request of value?.actionRequests ?? []) {
            if (typeof request.name !== "string") continue;
            actions.push({
              interruptId: typeof interruptEntry.id === "string" ? interruptEntry.id : null,
              name: request.name,
              args: request.args ?? {},
              description: request.description
            });
          }
        }
      }
      return actions;
    },
    buildResumeInput(actions, decisions) {
      // The HITL middleware raises ONE interrupt per interrupted task and
      // validates decision count against ITS OWN actionRequests. An un-keyed
      // resume value is delivered to EVERY pending task (LangGraph's
      // nullResume fallback), so with two concurrent interrupts (parallel
      // `task` subagents each hitting a gated tool) a flat decisions array
      // mis-routes. Keying the resume by interrupt id makes LangGraph route
      // each group to its own task. Interrupt-id-less entries (pre-id fakes)
      // fall back to the legacy un-keyed shape, which is correct for the
      // single-interrupt case.
      const groups = new Map<string | null, typeof decisions>();
      actions.forEach((action, index) => {
        const decision = decisions[index];
        if (!decision) return;
        const group = groups.get(action.interruptId) ?? [];
        group.push(decision);
        groups.set(action.interruptId, group);
      });
      const keyed = [...groups.entries()].filter(
        (entry): entry is [string, typeof decisions] => entry[0] !== null
      );
      if (keyed.length > 0) {
        // Mixed keyed/id-less groups must NOT fall back to the un-keyed shape:
        // LangGraph delivers an un-keyed resume to EVERY pending task, so the
        // combined payload would be consumed by the wrong interrupt. Resume
        // the keyed groups only; an id-less interrupt stays pending and is
        // re-detected (and re-prompted) on the next loop round.
        if (keyed.length < groups.size) {
          init.logger.warn(
            { sessionId: init.sessionId, keyedGroups: keyed.length, totalGroups: groups.size },
            "Deep Agents resume: dropping decisions for id-less interrupt(s) alongside keyed ones"
          );
        }
        return new Command({
          resume: Object.fromEntries(keyed.map(([id, group]) => [id, { decisions: group }]))
        });
      }
      // All id-less (legacy fakes): the un-keyed shape is only correct for a
      // single pending interrupt, which is the only case such sources produce.
      return new Command({ resume: { decisions } });
    },
    getMcpToolNames() {
      return mcpToolNames;
    },
    getMcpToolServers() {
      return mcpToolServers;
    },
    ...(sandbox
      ? {
          readFileBytes: (filePath: string) => sandbox.readFileBytes(filePath),
          statFile: (filePath: string) => sandbox.statFile(filePath),
          writeFileBytes: (filePath: string, data: Uint8Array | ArrayBuffer | string) =>
            sandbox.writeFileBytes(filePath, data)
        }
      : {}),
    async dispose(): Promise<void> {
      compiled = null;
      await mcpClient?.close().catch((err: unknown) => {
        init.logger.warn({ err, sessionId: init.sessionId }, "Failed to close Deep Agents MCP client");
      });
      mcpClient = null;
      mcpToolsPromise = null;
      await sandbox?.kill();
    }
  };

  return runtime;
};

/**
 * interruptOn map from tenant approval settings. Gated: all MCP gateway tools
 * (minus read-only ones when autoApproveReadOnly) + the mutating built-ins
 * (always — write_file/edit_file exist on the StateBackend too, not just the
 * sandbox) + the read-only built-ins when the tenant disabled the read-only
 * bypass. approvalPolicy "never" → undefined (bypass, like Claude's bypass
 * mode). Entries for tools that never get called (e.g. execute without a
 * sandbox) are inert.
 */
export function buildInterruptOn(input: {
  approvals?: { gate: boolean; autoApproveReadOnly: boolean; readOnlyToolNames: string[] };
  mcpToolNames: string[];
}): Record<string, { allowedDecisions: Array<"approve" | "reject"> }> | undefined {
  const { approvals, mcpToolNames } = input;
  if (!approvals?.gate) return undefined;

  const readOnly = new Set(approvals.autoApproveReadOnly ? approvals.readOnlyToolNames : []);
  const gated = [
    ...mcpToolNames.filter((name) => !readOnly.has(name)),
    ...MUTATING_BUILTIN_TOOLS,
    ...(approvals.autoApproveReadOnly ? [] : READ_ONLY_BUILTIN_TOOLS)
  ];
  if (gated.length === 0) return undefined;

  return Object.fromEntries(
    gated.map((name) => [name, { allowedDecisions: ["approve", "reject"] as Array<"approve" | "reject"> }])
  );
}
