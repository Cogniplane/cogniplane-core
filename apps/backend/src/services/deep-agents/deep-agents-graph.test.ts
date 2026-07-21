import { describe, expect, it, vi } from "vitest";
import { Command } from "@langchain/langgraph";
import { createDeepAgent } from "deepagents";

// Controllable MultiServerMCPClient stand-in (ESM namespace exports cannot be
// spied on; the module mock below routes construction here).
const mcpMockState = vi.hoisted(() => ({
  current: null as null | { getTools: (serverId: string) => Promise<unknown[]>; close: () => Promise<void> },
  // Captures the config passed to the most recent MultiServerMCPClient
  // construction so tests can assert the top-level beforeToolCall hook.
  lastConfig: null as null | Record<string, unknown>
}));

vi.mock("@langchain/mcp-adapters", () => ({
  MultiServerMCPClient: class {
    constructor(config?: Record<string, unknown>) {
      mcpMockState.lastConfig = config ?? null;
      if (!mcpMockState.current) throw new Error("mcpMockState.current not set for this test");
      return mcpMockState.current as never;
    }
  }
}));

import {
  applyReasoningEffort,
  buildInterruptOn,
  buildOpenAiResponsesApiOptions,
  buildProviderBaseUrlOptions,
  createDeepAgentsSessionRuntime,
  ProviderKeyMissingError,
  RESERVED_BUILTIN_TOOL_NAMES,
  resolveModelConstruction
} from "./deep-agents-graph.js";

const fakeLog = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => fakeLog,
  level: "silent"
} as unknown as import("fastify").FastifyBaseLogger;

function makeRuntime(overrides: Partial<Parameters<typeof createDeepAgentsSessionRuntime>[0]> = {}) {
  return createDeepAgentsSessionRuntime({
    tenantId: "t1",
    sessionId: "sess-1",
    userId: "u1",
    runtimeId: "rt-1",
    resolveProviderKey: async () => "sk-ant-test",
    providerBaseUrls: null,
    systemPrompt: null,
    workspacePath: "/home/user/workspace/sess-1",
    e2b: null,
    logger: fakeLog,
    ...overrides
  });
}

describe("resolveModelConstruction", () => {
  it("derives provider/init string from the catalog entry, not the namespace", () => {
    expect(resolveModelConstruction("deepagents/claude-sonnet-5")).toEqual({
      provider: "anthropic",
      vendorModel: "claude-sonnet-5",
      initModelId: "anthropic:claude-sonnet-5",
      baseUrl: null
    });
    // A bare (un-namespaced) id resolves the same way — the fallback keeps the
    // init string stable for legacy/test callers.
    expect(resolveModelConstruction("claude-sonnet-5").initModelId).toBe("anthropic:claude-sonnet-5");
    expect(resolveModelConstruction("openai/gpt-5.4")).toEqual({
      provider: "openai",
      vendorModel: "gpt-5.4",
      initModelId: "openai:gpt-5.4",
      baseUrl: null
    });
  });

  it("uses the google-genai init prefix for Google models (not 'google'/Vertex)", () => {
    expect(resolveModelConstruction("google/gemini-2.5-pro").initModelId).toBe(
      "google-genai:gemini-2.5-pro"
    );
  });

  it("rides the OpenAI client + OpenRouter base URL, splitting only the first slash", () => {
    // The vendor model id itself contains a slash — it must survive intact.
    expect(resolveModelConstruction("openrouter/deepseek/deepseek-v4-pro")).toEqual({
      provider: "openrouter",
      vendorModel: "deepseek/deepseek-v4-pro",
      initModelId: "openai:deepseek/deepseek-v4-pro",
      baseUrl: "https://openrouter.ai/api/v1"
    });
  });

  it("rides the OpenAI client + Z.AI base URL for direct GLM models", () => {
    // Z.AI has no native initChatModel provider — like OpenRouter it rides the
    // OpenAI client with a custom base URL. Vendor id has no inner slash.
    expect(resolveModelConstruction("zai/glm-5.2")).toEqual({
      provider: "zai",
      vendorModel: "glm-5.2",
      initModelId: "openai:glm-5.2",
      // GLM Coding Plan endpoint (bills against the subscription), not the
      // general pay-per-token /api/paas/v4.
      baseUrl: "https://api.z.ai/api/coding/paas/v4"
    });
  });

  it("falls back to Anthropic for ids absent from the catalog", () => {
    // The resolver validates ids upstream; this fallback keeps the graph from
    // throwing on a legacy/unknown id (e.g. a retired catalog entry still named
    // by an in-flight scheduled job). It routes to the Anthropic client.
    expect(resolveModelConstruction("deepagents/claude-sonnet-4-5")).toEqual({
      provider: "anthropic",
      vendorModel: "claude-sonnet-4-5",
      initModelId: "anthropic:claude-sonnet-4-5",
      baseUrl: null
    });
  });
});

describe("buildProviderBaseUrlOptions", () => {
  it("nests the OpenRouter/Z.AI base URL under configuration.baseURL — a top-level baseURL is ignored by the OpenAI client", () => {
    // Regression guard: if this ever shapes as a top-level `baseUrl`/`baseURL`,
    // every test still passes but OpenRouter/Z.AI traffic silently hits
    // api.openai.com. The OpenAI client only reads `configuration.baseURL`.
    expect(
      buildProviderBaseUrlOptions("openrouter", "https://openrouter.ai/api/v1")
    ).toEqual({ configuration: { baseURL: "https://openrouter.ai/api/v1" } });
    expect(
      buildProviderBaseUrlOptions("zai", "https://api.z.ai/api/coding/paas/v4")
    ).toEqual({ configuration: { baseURL: "https://api.z.ai/api/coding/paas/v4" } });
  });

  it("shapes each other provider's base-url knob by its client's name", () => {
    expect(buildProviderBaseUrlOptions("anthropic", "https://example.test")).toEqual({
      anthropicApiUrl: "https://example.test"
    });
    expect(buildProviderBaseUrlOptions("google", "https://example.test")).toEqual({
      baseUrl: "https://example.test"
    });
  });

  it("returns an empty object when no base URL applies (client keeps its default)", () => {
    expect(buildProviderBaseUrlOptions("openai", null)).toEqual({});
    expect(buildProviderBaseUrlOptions("anthropic", null)).toEqual({});
  });
});

describe("buildOpenAiResponsesApiOptions", () => {
  it("forces the Responses API for native OpenAI models", () => {
    // Chat Completions rejects tools + reasoning_effort for the GPT-5.6
    // family, and @langchain/openai's per-model API allowlist lags releases.
    expect(buildOpenAiResponsesApiOptions("openai")).toEqual({
      useResponsesApi: true
    });
  });

  it("leaves OpenAI-client gateways on Chat Completions", () => {
    // OpenRouter and Z.AI ride the OpenAI client but their gateways speak
    // Chat Completions — keyed on provider, not initPrefix.
    expect(buildOpenAiResponsesApiOptions("openrouter")).toEqual({});
    expect(buildOpenAiResponsesApiOptions("zai")).toEqual({});
    expect(buildOpenAiResponsesApiOptions("anthropic")).toEqual({});
    expect(buildOpenAiResponsesApiOptions("google")).toEqual({});
  });
});

describe("applyReasoningEffort (bead i52g)", () => {
  it("returns an empty object when no effort is selected", () => {
    expect(applyReasoningEffort("anthropic", null)).toEqual({});
    expect(applyReasoningEffort("openai", undefined)).toEqual({});
    expect(applyReasoningEffort("google", null)).toEqual({});
  });

  it("shapes Anthropic extended thinking + outputConfig.effort", () => {
    expect(applyReasoningEffort("anthropic", "medium")).toEqual({
      thinking: { type: "adaptive" },
      outputConfig: { effort: "medium" }
    });
    // Anthropic's effort scale starts at "low"; "minimal" clamps up.
    expect(applyReasoningEffort("anthropic", "minimal")).toEqual({
      thinking: { type: "adaptive" },
      outputConfig: { effort: "low" }
    });
    // "none" disables thinking entirely.
    expect(applyReasoningEffort("anthropic", "none")).toEqual({});
  });

  it("passes OpenAI reasoning.effort through", () => {
    expect(applyReasoningEffort("openai", "minimal")).toEqual({
      reasoning: { effort: "minimal" }
    });
    expect(applyReasoningEffort("openai", "high")).toEqual({
      reasoning: { effort: "high" }
    });
  });

  it("routes OpenRouter through the OpenAI-shaped reasoning knob", () => {
    // OpenRouter rides the OpenAI initPrefix, so it uses reasoning.effort too.
    expect(applyReasoningEffort("openrouter", "low")).toEqual({
      reasoning: { effort: "low" }
    });
  });

  it("maps Gemini thinkingLevel and zeroes the budget for none", () => {
    expect(applyReasoningEffort("google", "low")).toEqual({
      thinkingConfig: { thinkingLevel: "LOW" }
    });
    expect(applyReasoningEffort("google", "minimal")).toEqual({
      thinkingConfig: { thinkingLevel: "LOW" }
    });
    expect(applyReasoningEffort("google", "medium")).toEqual({
      thinkingConfig: { thinkingLevel: "MEDIUM" }
    });
    expect(applyReasoningEffort("google", "high")).toEqual({
      thinkingConfig: { thinkingLevel: "HIGH" }
    });
    expect(applyReasoningEffort("google", "none")).toEqual({
      thinkingConfig: { thinkingBudget: 0 }
    });
  });
});

describe("RESERVED_BUILTIN_TOOL_NAMES pin (deepagents@1.10.5)", () => {
  // The library does not export BUILTIN_TOOL_NAMES, so our copy is pinned by
  // behavior: createDeepAgent must reject every name we reserve. If an SDK
  // bump changes the built-in set, this fails and the pinned list (and the
  // MUTATING/READ_ONLY gating splits) must be re-verified against the new
  // version's agent.ts.
  it("createDeepAgent rejects every reserved name as a tool-name collision", () => {
    for (const name of RESERVED_BUILTIN_TOOL_NAMES) {
      expect(
        () => createDeepAgent({ tools: [{ name } as never] }),
        `expected collision for built-in name "${name}"`
      ).toThrow(/conflict with built-in tools/);
    }
  });

  it("createDeepAgent accepts a non-reserved tool name (collision check still selective)", () => {
    expect(() =>
      createDeepAgent({
        model: "anthropic:claude-sonnet-4-5",
        tools: [
          {
            name: "definitely_not_builtin",
            description: "control",
            schema: { type: "object", properties: {} },
            invoke: async () => "ok"
          } as never
        ]
      })
    ).not.toThrow();
  });
});

describe("skills library wiring", () => {
  it("compiles an agent with the /skills/ composite route and no sandbox", async () => {
    // No MCP servers → the MultiServerMCPClient mock is never constructed.
    const runtime = makeRuntime({
      skillsLibraryFiles: {
        "/write-artifact/SKILL.md": {
          content:
            '---\nname: "write-artifact"\ndescription: "Persist generated files"\n---\n\nBody.',
          mimeType: "text/markdown",
          created_at: "2026-07-05T00:00:00.000Z",
          modified_at: "2026-07-05T00:00:00.000Z"
        }
      }
    });
    // Compiling exercises createDeepAgent with backend factory + skills
    // sources — a collision or backend-protocol mismatch would throw here.
    await expect(runtime.getAgentForModel("deepagents/claude-sonnet-5")).resolves.toBeTruthy();
  });

  it("compiles without skills exactly as before (no composite, library default backend)", async () => {
    const runtime = makeRuntime({ skillsLibraryFiles: null });
    await expect(runtime.getAgentForModel("deepagents/claude-sonnet-5")).resolves.toBeTruthy();
  });
});

describe("lazy provider-key resolution", () => {
  it("throws a 400 ProviderKeyMissingError when the per-turn provider key is null", async () => {
    // The provider is only known per-turn (the model is selected per-turn), so
    // the key is resolved lazily inside getAgentForModel. A user switching
    // mid-session to a provider with no configured key must get an actionable
    // 400 (ProviderKeyMissingError), NOT a generic 500. Its `provider` names the
    // missing provider so the client can point the user at the right key.
    const runtime = makeRuntime({ resolveProviderKey: async () => null });

    const error = await runtime
      .getAgentForModel("openai/gpt-5.5")
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderKeyMissingError);
    expect((error as ProviderKeyMissingError).statusCode).toBe(400);
    expect((error as ProviderKeyMissingError).provider).toBe("openai");
  });

  it("resolves the key for the SELECTED provider, not a fixed one", async () => {
    // Anthropic key present but the turn selects an OpenAI model with no OpenAI
    // key → still fails: the resolver gates on the selected model's provider.
    const resolveProviderKey = vi.fn(async (provider: string) =>
      provider === "anthropic" ? "sk-ant" : null
    );
    const runtime = makeRuntime({ resolveProviderKey });

    await expect(runtime.getAgentForModel("openai/gpt-5.5")).rejects.toBeInstanceOf(
      ProviderKeyMissingError
    );
    expect(resolveProviderKey).toHaveBeenCalledWith("openai");
  });
});

describe("buildResumeInput", () => {
  const approve = { type: "approve" as const };
  const reject = { type: "reject" as const, message: "no" };

  it("keys decisions per interrupt so concurrent interrupts each get their own group", () => {
    const runtime = makeRuntime();
    const actions = [
      { interruptId: "int-a", name: "execute", args: {} },
      { interruptId: "int-b", name: "write_file", args: {} },
      { interruptId: "int-b", name: "edit_file", args: {} }
    ];
    const command = runtime.buildResumeInput!(actions, [approve, reject, approve]) as Command;
    expect(command).toBeInstanceOf(Command);
    expect(command.resume).toEqual({
      "int-a": { decisions: [approve] },
      "int-b": { decisions: [reject, approve] }
    });
  });

  it("resumes only the keyed groups when keyed and id-less interrupts are mixed", () => {
    // An un-keyed resume is delivered to EVERY pending task, so a mixed state
    // must never take the fallback path — the id-less interrupt stays pending
    // for the next round instead.
    const runtime = makeRuntime();
    const actions = [
      { interruptId: "int-a", name: "execute", args: {} },
      { interruptId: null, name: "write_file", args: {} }
    ];
    const command = runtime.buildResumeInput!(actions, [approve, reject]) as Command;
    expect(command.resume).toEqual({ "int-a": { decisions: [approve] } });
  });

  it("falls back to the un-keyed single-interrupt shape when ids are absent", () => {
    const runtime = makeRuntime();
    const actions = [{ interruptId: null, name: "execute", args: {} }];
    const command = runtime.buildResumeInput!(actions, [approve]) as Command;
    expect(command.resume).toEqual({ decisions: [approve] });
  });
});

describe("buildInterruptOn (native HITL gating map)", () => {
  const READ_ONLY_BUILTINS = ["ls", "read_file", "glob", "grep"];
  const MUTATING_BUILTINS = ["execute", "write_file", "edit_file"];

  it("returns undefined when approvals are off (approvalPolicy 'never' → no gating)", () => {
    // No approvals object at all…
    expect(buildInterruptOn({ mcpToolNames: ["create_issue"] })).toBeUndefined();
    // …and an explicit gate:false both bypass gating entirely, so createDeepAgent
    // gets no interruptOn arg and the graph never pauses.
    expect(
      buildInterruptOn({
        approvals: { gate: false, autoApproveReadOnly: true, readOnlyToolNames: [] },
        mcpToolNames: ["create_issue", "read_file"]
      })
    ).toBeUndefined();
  });

  it("always gates the mutating built-ins and carries approve/reject decisions on every entry", () => {
    // No MCP tools, read-only bypass ON: the only thing left to gate is the
    // mutating built-in set — execute/write_file/edit_file are ALWAYS gated
    // when approvals are on, regardless of the read-only bypass.
    const map = buildInterruptOn({
      approvals: { gate: true, autoApproveReadOnly: true, readOnlyToolNames: READ_ONLY_BUILTINS },
      mcpToolNames: []
    });
    expect(map).toBeDefined();
    expect(Object.keys(map!).sort()).toEqual([...MUTATING_BUILTINS].sort());
    // Every gated entry offers exactly the approve/reject decision pair.
    for (const name of MUTATING_BUILTINS) {
      expect(map![name]).toEqual({ allowedDecisions: ["approve", "reject"] });
    }
  });

  it("drops read-only built-ins AND read-only MCP names when the read-only bypass is on", () => {
    // create_issue is a mutating MCP tool (not in readOnlyToolNames); read_page
    // is a read-only MCP tool. With the bypass on, read_page and the read-only
    // built-ins are auto-approved (absent from the map); create_issue stays.
    const map = buildInterruptOn({
      approvals: {
        gate: true,
        autoApproveReadOnly: true,
        readOnlyToolNames: [...READ_ONLY_BUILTINS, "read_page"]
      },
      mcpToolNames: ["create_issue", "read_page"]
    });
    expect(Object.keys(map!).sort()).toEqual(["create_issue", ...MUTATING_BUILTINS].sort());
    expect(map).not.toHaveProperty("read_page");
    for (const roBuiltin of READ_ONLY_BUILTINS) {
      expect(map).not.toHaveProperty(roBuiltin);
    }
  });

  it("gates read-only built-ins AND read-only MCP names when the read-only bypass is off", () => {
    // Bypass OFF is the explicit "prompt me even for reads" posture: read_page
    // and the read-only built-ins are gated alongside the mutating set.
    const map = buildInterruptOn({
      approvals: {
        gate: true,
        autoApproveReadOnly: false,
        readOnlyToolNames: [...READ_ONLY_BUILTINS, "read_page"]
      },
      mcpToolNames: ["create_issue", "read_page"]
    });
    expect(Object.keys(map!).sort()).toEqual(
      ["create_issue", "read_page", ...MUTATING_BUILTINS, ...READ_ONLY_BUILTINS].sort()
    );
    for (const name of Object.keys(map!)) {
      expect(map![name]).toEqual({ allowedDecisions: ["approve", "reject"] });
    }
  });
});

describe("MCP tool loading", () => {
  function makeMcpMocks(toolsByServer: Record<string, Array<{ name: string }>>) {
    return {
      getTools: vi.fn(async (serverId: string) => {
        const tools = toolsByServer[serverId];
        if (!tools) throw new Error(`connect failed: ${serverId}`);
        return tools.map((tool) => ({
          ...tool,
          description: "d",
          schema: {},
          invoke: async () => "ok"
        }));
      }),
      close: vi.fn(async () => {})
    };
  }

  async function loadVia(runtime: ReturnType<typeof makeRuntime>) {
    // getAgentForModel triggers the lazy MCP load; the fake client below is
    // injected via the module mock.
    await runtime.getAgentForModel("deepagents/claude-sonnet-5");
  }

  it("drops builtin-colliding and duplicate tool names, records server attribution, and survives a broken server", async () => {
    const mocks = makeMcpMocks({
      github: [{ name: "create_issue" }, { name: "read_file" }],
      notion: [{ name: "search_pages" }, { name: "create_issue" }]
      // "sharepoint" missing → getTools throws for it
    });
    mcpMockState.current = mocks as never;
    try {
      const runtime = makeRuntime({
        mcpServers: [
          { id: "github", url: "http://gw/mcp/github", authorization: "Bearer rt_1" },
          { id: "notion", url: "http://gw/mcp/notion", authorization: "Bearer rt_1" },
          { id: "sharepoint", url: "http://gw/mcp/sharepoint", authorization: "Bearer rt_1" }
        ]
      });
      await loadVia(runtime);

      expect([...runtime.getMcpToolNames!()]).toEqual(["create_issue", "search_pages"]);
      expect(Object.fromEntries(runtime.getMcpToolServers!())).toEqual({
        create_issue: "github",
        search_pages: "notion"
      });
      // A broken server degrades to a warning — the healthy servers' tools load.
      expect(mocks.getTools).toHaveBeenCalledTimes(3);
    } finally {
      mcpMockState.current = null;
    }
  });

  it("injects the backend-held toolContextId via beforeToolCall, overriding any model-supplied id", async () => {
    // Security property: the current turn's toolContextId is the ONLY trusted
    // source. The top-level beforeToolCall hook must inject it into every managed
    // tool call AND override a model-hallucinated id, or the gateway would trust
    // an id the model invented.
    const mocks = makeMcpMocks({ github: [{ name: "create_issue" }] });
    mcpMockState.current = mocks as never;
    mcpMockState.lastConfig = null;
    const toolContextRef = { current: "ctx-trusted" };
    try {
      const runtime = makeRuntime({
        toolContextRef,
        mcpServers: [{ id: "github", url: "http://gw/mcp/github", authorization: "Bearer rt_1" }]
      });
      await loadVia(runtime);

      const beforeToolCall = mcpMockState.lastConfig?.beforeToolCall as
        | ((request: { args?: unknown }) => { args?: unknown })
        | undefined;
      expect(typeof beforeToolCall).toBe("function");

      // A model-supplied (untrusted) id is overridden with the backend's.
      expect(beforeToolCall!({ args: { toolContextId: "ctx-hallucinated", other: 1 } })).toEqual({
        args: { toolContextId: "ctx-trusted" }
      });

      // If the backend has no active context, the hook injects nothing (no id).
      toolContextRef.current = null as unknown as string;
      expect(beforeToolCall!({ args: {} })).toEqual({});
    } finally {
      mcpMockState.current = null;
      mcpMockState.lastConfig = null;
    }
  });
});

// ── resolveModelConstruction: custom-model namespace fallback ────────────────
// Admin-added custom models (tenant_custom_models) are not in AVAILABLE_MODELS;
// their id namespace IS the provider (see custom-model-store.ts).
describe("resolveModelConstruction custom-model namespace fallback", () => {
  it("maps a custom OpenRouter id via its namespace", () => {
    const construction = resolveModelConstruction("openrouter/moonshotai/kimi-k3");
    expect(construction.provider).toBe("openrouter");
    expect(construction.vendorModel).toBe("moonshotai/kimi-k3");
    expect(construction.initModelId).toBe("openai:moonshotai/kimi-k3");
    expect(construction.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("maps custom google/openai ids via their namespace", () => {
    expect(resolveModelConstruction("google/custom-gemini-x").initModelId).toBe(
      "google-genai:custom-gemini-x"
    );
    expect(resolveModelConstruction("openai/gpt-6-preview").initModelId).toBe(
      "openai:gpt-6-preview"
    );
  });

  it("still prefers the catalog entry over the namespace", () => {
    // Built-in Anthropic ids use the legacy "deepagents/" namespace — the
    // catalog entry decides the provider, not the namespace.
    const construction = resolveModelConstruction("deepagents/claude-sonnet-5");
    expect(construction.provider).toBe("anthropic");
    expect(construction.initModelId).toBe("anthropic:claude-sonnet-5");
  });
});
