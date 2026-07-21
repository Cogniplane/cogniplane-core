import { describe, expect, it, vi } from "vitest";
import {
  EventSchemas as AGUIEventSchemas,
  EventType as AGUIEventType,
  verifyEvents as aguiVerifyEvents,
  type BaseEvent as AGUIBaseEvent
} from "@ag-ui/client";
import { firstValueFrom, from as rxFrom, toArray } from "rxjs";

import { createTestConfig } from "../../test-helpers/test-config.js";
import { testRuntimePolicy } from "../../test-helpers/test-runtime-policy.js";
import { SessionBusyError, type RuntimeEvent, type RuntimeReasoningEffort } from "../../runtime-contracts.js";
import { DeepAgentsRuntimeAdapter } from "./deep-agents-runtime-adapter.js";
import { isAGUIInterruptedFinish } from "./runtime-event-to-agui.js";
import { calculateCostUsd } from "../token-cost-calculator.js";
import type { ProviderCredentials } from "../runtime/provider-credentials.js";
import type {
  DeepAgentsGraph,
  DeepAgentsRuntimeFactory,
  DeepAgentsSessionRuntime
} from "./deep-agents-types.js";
import type { DynamicConfigService } from "../dynamic-config-service.js";

const testConfig = createTestConfig({ ANTHROPIC_API_KEY: "sk-ant-test-key" });

const sessionInput = {
  tenantId: "test-tenant",
  sessionId: "sess-1",
  userId: "user-1"
};

function makeDynamicConfig(
  policyOverrides: Partial<typeof testRuntimePolicy> = {},
  bundleOverrides: { skills?: Array<Record<string, unknown>> } = {}
) {
  return {
    async compileRuntimeConfig() {
      return {
        runtimePolicy: { ...testRuntimePolicy, ...policyOverrides },
        skills: bundleOverrides.skills ?? [],
        mcpServers: [],
        hash: "test-hash",
        sources: {
          runtimePolicy: { id: "test", version: 1, hash: "h" },
          skills: [],
          mcpServers: []
        }
      };
    }
  } as unknown as DynamicConfigService;
}

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

const fakeApprovalStore = {
  async create() {
    return {} as never;
  },
  async resolve() {
    return null;
  }
} as never;
const fakeAuditEventStore = { async create() {} } as never;

type StreamScript = (config: {
  configurable: { thread_id: string };
  signal?: AbortSignal;
}) => AsyncIterable<Record<string, unknown>>;

/** Graph factory whose streamEvents replays a scripted envelope sequence. */
function makeRuntimeFactory(script: StreamScript) {
  const factoryCalls: Array<Parameters<DeepAgentsRuntimeFactory>[0]> = [];
  const dispose = vi.fn(async () => {});
  const streamConfigs: Array<{ configurable: { thread_id: string }; signal?: AbortSignal }> = [];
  const modelRequests: string[] = [];
  const effortRequests: Array<RuntimeReasoningEffort | null | undefined> = [];

  const streamInputs: unknown[] = [];
  const factory: DeepAgentsRuntimeFactory = (init) => {
    factoryCalls.push(init);
    const graph: DeepAgentsGraph = {
      streamEvents(streamInput, config) {
        streamInputs.push(streamInput);
        streamConfigs.push(config);
        return script(config);
      }
    };
    const runtime: DeepAgentsSessionRuntime = {
      async getAgentForModel(modelId, effort) {
        modelRequests.push(modelId);
        effortRequests.push(effort);
        return graph;
      },
      dispose
    };
    return runtime;
  };

  return { factory, factoryCalls, dispose, streamConfigs, streamInputs, modelRequests, effortRequests };
}

async function* scriptedChatStream(): AsyncGenerator<Record<string, unknown>> {
  yield { event: "on_chat_model_stream", metadata: {}, data: { chunk: { content: "Hi " } } };
  yield { event: "on_chat_model_stream", metadata: {}, data: { chunk: { content: "there" } } };
  yield { event: "on_chat_model_end", metadata: {} };
}

function makeAdapter(input: {
  factory: DeepAgentsRuntimeFactory;
  dynamicConfig?: DynamicConfigService;
  runtimeSessions?: unknown;
  memories?: unknown;
  checkpointer?: { deleteThread: (threadId: string) => Promise<void>; end?: () => Promise<void> };
  messages?: unknown;
  /**
   * Convenience: a single tenant key applied to every provider. Translated to a
   * ProviderCredentials below. Undefined/null → no key for any provider.
   */
  getTenantApiKey?: (tenantId: string) => Promise<string | null>;
  /** Full control over the ProviderCredentials (overrides getTenantApiKey). */
  providerCredentials?: ProviderCredentials;
  config?: typeof testConfig;
}) {
  const tenantKeyFn = input.getTenantApiKey;
  const credentials: ProviderCredentials | undefined =
    input.providerCredentials ??
    (tenantKeyFn
      ? {
          resolveKey: (tenantId: string) => tenantKeyFn(tenantId),
          hasKey: async (tenantId: string) => Boolean((await tenantKeyFn(tenantId))?.trim()),
          platformProviders: new Set()
        }
      : undefined);
  return new DeepAgentsRuntimeAdapter(
    input.config ?? testConfig,
    input.dynamicConfig ?? makeDynamicConfig(),
    fakeLog,
    {
      approvals: fakeApprovalStore,
      auditEvents: fakeAuditEventStore,
      runtimeSessions: input.runtimeSessions as never,
      memories: input.memories as never,
      checkpointer: input.checkpointer,
      messages: input.messages as never
    },
    credentials,
    input.factory
  );
}

async function collect(iterable: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function runMessageInput(
  overrides: Partial<{ prompt: string; model: string; effort: RuntimeReasoningEffort }> = {}
) {
  return {
    prompt: overrides.prompt ?? "hello",
    runtimePolicyId: "test",
    toolContextId: null,
    ...(overrides.model ? { model: overrides.model } : {}),
    ...(overrides.effort ? { effort: overrides.effort } : {})
  };
}

// ── HITL approval-flow support ───────────────────────────────────────────────

type PendingAction = {
  interruptId: string | null;
  name: string;
  args: Record<string, unknown>;
  description?: string;
};

/**
 * Runtime whose first stream ends with pending HITL actions; resuming plays a
 * final stream. Captures the resume decisions for assertions.
 */
function makeInterruptingFactory(input: {
  rounds: PendingAction[][];
  mcpToolNames?: string[];
}) {
  const resumes: unknown[] = [];
  let round = 0;
  const factory: DeepAgentsRuntimeFactory = () => ({
    async getAgentForModel() {
      return {
        async *streamEvents(streamInput: unknown) {
          const isResume = typeof streamInput === "object" && streamInput !== null && !("messages" in (streamInput as object));
          yield {
            event: "on_chat_model_stream",
            metadata: {},
            data: { chunk: { content: isResume ? "after approval" : "before approval " } }
          };
        }
      };
    },
    async getPendingActions() {
      return input.rounds[round] ?? [];
    },
    buildResumeInput(_actions, decisions) {
      resumes.push(decisions);
      round += 1;
      return { resume: decisions };
    },
    getMcpToolNames() {
      return new Set(input.mcpToolNames ?? []);
    },
    dispose: async () => {}
  });
  return { factory, resumes };
}

function makeRichApprovalStore() {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    rows,
    async create(row: Record<string, unknown>) {
      rows.set(row.approvalId as string, { ...row });
      return row as never;
    },
    async resolve(_tenantId: string, approvalId: string, _userId: string, decision: string) {
      const row = rows.get(approvalId);
      if (!row || row.status !== "pending") return null;
      row.status = decision;
      return row as never;
    }
  };
}

function startTurn(
  adapter: DeepAgentsRuntimeAdapter,
  session: Awaited<ReturnType<DeepAgentsRuntimeAdapter["createSession"]>>,
  input: Record<string, unknown> = {}
) {
  const events: RuntimeEvent[] = [];
  const done = (async () => {
    for await (const event of adapter.runMessage(session, { ...runMessageInput(), ...input } as never)) {
      events.push(event);
    }
  })();
  return { events, done };
}

async function waitForEvent(
  events: RuntimeEvent[],
  predicate: (event: RuntimeEvent) => boolean,
  timeoutMs = 2_000
): Promise<RuntimeEvent> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const match = events.find(predicate);
    if (match) return match;
    if (Date.now() > deadline) throw new Error("timed out waiting for event");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("DeepAgentsRuntimeAdapter HITL approvals", () => {
  it("pauses on an interrupt, resolves approve, and resumes the graph", async () => {
    const { factory, resumes } = makeInterruptingFactory({
      rounds: [[{ interruptId: "int-1", name: "execute", args: { command: "rm -rf build" } }], []]
    });
    const approvals = makeRichApprovalStore();
    const audits: Array<Record<string, unknown>> = [];
    const adapter = new DeepAgentsRuntimeAdapter(
      testConfig,
      makeDynamicConfig(),
      fakeLog,
      {
        approvals: approvals as never,
        auditEvents: { create: async (e: Record<string, unknown>) => void audits.push(e) } as never
      },
      undefined,
      factory
    );
    const session = await adapter.createSession(sessionInput);
    const { events, done } = startTurn(adapter, session);

    const approvalEvent = (await waitForEvent(
      events,
      (e) => e.type === "framework:approval_required"
    )) as Extract<RuntimeEvent, { type: "framework:approval_required" }>;
    expect(approvalEvent.kind).toBe("command_execution");
    expect(approvalEvent.command).toBe("rm -rf build");
    expect(approvals.rows.get(approvalEvent.approvalId)).toMatchObject({ status: "pending" });

    const outcome = await adapter.resolveApproval({
      tenantId: sessionInput.tenantId,
      approvalId: approvalEvent.approvalId,
      userId: sessionInput.userId,
      decision: "approve"
    });
    expect(outcome).toBe("resolved");

    await done;
    expect(resumes).toEqual([[{ type: "approve" }]]);
    expect(events.at(-1)).toMatchObject({ type: "response.completed" });
    expect(approvals.rows.get(approvalEvent.approvalId)).toMatchObject({ status: "approve" });
    expect(audits.some((a) => a.type === "approval.approved")).toBe(true);
    await adapter.close();
  });

  it("refuses a decision from a different user and stays pending", async () => {
    const { factory } = makeInterruptingFactory({
      rounds: [[{ interruptId: "int-1", name: "execute", args: { command: "ls" } }], []]
    });
    const approvals = makeRichApprovalStore();
    const adapter = new DeepAgentsRuntimeAdapter(
      testConfig,
      makeDynamicConfig(),
      fakeLog,
      { approvals: approvals as never, auditEvents: { create: async () => {} } as never },
      undefined,
      factory
    );
    const session = await adapter.createSession(sessionInput);
    const { events, done } = startTurn(adapter, session);
    const approvalEvent = (await waitForEvent(
      events,
      (e) => e.type === "framework:approval_required"
    )) as Extract<RuntimeEvent, { type: "framework:approval_required" }>;

    const outcome = await adapter.resolveApproval({
      tenantId: sessionInput.tenantId,
      approvalId: approvalEvent.approvalId,
      userId: "someone-else",
      decision: "approve"
    });
    expect(outcome).toBe("missing");

    // The rightful owner can still decide.
    await adapter.resolveApproval({
      tenantId: sessionInput.tenantId,
      approvalId: approvalEvent.approvalId,
      userId: sessionInput.userId,
      decision: "reject"
    });
    await done;
    await adapter.close();
  });

  it("classifies MCP gateway tools as mcp_tool approvals", async () => {
    const { factory, resumes } = makeInterruptingFactory({
      rounds: [[{ interruptId: "int-1", name: "memory_save", args: { name: "x", content: "y" } }], []],
      mcpToolNames: ["memory_save"]
    });
    const adapter = new DeepAgentsRuntimeAdapter(
      testConfig,
      makeDynamicConfig(),
      fakeLog,
      {
        approvals: makeRichApprovalStore() as never,
        auditEvents: { create: async () => {} } as never
      },
      undefined,
      factory
    );
    const session = await adapter.createSession(sessionInput);
    const { events, done } = startTurn(adapter, session);
    const approvalEvent = (await waitForEvent(
      events,
      (e) => e.type === "framework:approval_required"
    )) as Extract<RuntimeEvent, { type: "framework:approval_required" }>;
    expect(approvalEvent.kind).toBe("mcp_tool");

    await adapter.resolveApproval({
      tenantId: sessionInput.tenantId,
      approvalId: approvalEvent.approvalId,
      userId: sessionInput.userId,
      decision: "reject"
    });
    await done;
    expect(resumes).toEqual([[{ type: "reject", message: "User denied permission." }]]);
    await adapter.close();
  });

  it("expires an unanswered approval after the TTL with a reject + notice", async () => {
    const { factory, resumes } = makeInterruptingFactory({
      rounds: [[{ interruptId: "int-1", name: "write_file", args: { file_path: "a.txt" } }], []]
    });
    const audits: Array<Record<string, unknown>> = [];
    const approvals = makeRichApprovalStore();
    const adapter = new DeepAgentsRuntimeAdapter(
      createTestConfig({ ANTHROPIC_API_KEY: "sk-ant-test-key", APPROVAL_REQUEST_TTL_MS: 60 }),
      makeDynamicConfig(),
      fakeLog,
      {
        approvals: { ...approvals, expire: async () => null } as never,
        auditEvents: { create: async (e: Record<string, unknown>) => void audits.push(e) } as never
      },
      undefined,
      factory
    );
    const session = await adapter.createSession(sessionInput);
    const { events, done } = startTurn(adapter, session);

    await done;
    expect(resumes).toEqual([[{ type: "reject", message: "User denied permission." }]]);
    expect(
      events.some(
        (e) => e.type === "framework:runtime_notice" && e.noticeId.startsWith("approval-expired:")
      )
    ).toBe(true);
    await adapter.close();
  });

  it("auto-approves a remembered kind without a second prompt", async () => {
    const { factory, resumes } = makeInterruptingFactory({
      rounds: [
        [{ interruptId: "int-1", name: "execute", args: { command: "step one" } }],
        [{ interruptId: "int-2", name: "execute", args: { command: "step two" } }],
        []
      ]
    });
    const audits: Array<Record<string, unknown>> = [];
    const adapter = new DeepAgentsRuntimeAdapter(
      testConfig,
      makeDynamicConfig(),
      fakeLog,
      {
        approvals: makeRichApprovalStore() as never,
        auditEvents: { create: async (e: Record<string, unknown>) => void audits.push(e) } as never
      },
      undefined,
      factory
    );
    const session = await adapter.createSession(sessionInput);
    const { events, done } = startTurn(adapter, session);

    const approvalEvent = (await waitForEvent(
      events,
      (e) => e.type === "framework:approval_required"
    )) as Extract<RuntimeEvent, { type: "framework:approval_required" }>;
    await adapter.resolveApproval({
      tenantId: sessionInput.tenantId,
      approvalId: approvalEvent.approvalId,
      userId: sessionInput.userId,
      decision: "approve",
      rememberForTurn: true
    });

    await done;
    // Two approval rounds resumed, but only ONE prompt reached the user.
    expect(resumes).toEqual([[{ type: "approve" }], [{ type: "approve" }]]);
    const prompts = events.filter((e) => e.type === "framework:approval_required");
    expect(prompts).toHaveLength(1);
    expect(audits.some((a) => a.type === "approval.auto_approved")).toBe(true);
    await adapter.close();
  });

  it("remembers MCP approvals per tool name, not for all MCP tools", async () => {
    // Approving a read-only MCP tool with "remember" must NOT auto-approve a
    // DIFFERENT MCP tool later in the same turn (R6) — the second tool still
    // prompts.
    const { factory, resumes } = makeInterruptingFactory({
      rounds: [
        [{ interruptId: "int-1", name: "notion_search", args: { query: "q" } }],
        [{ interruptId: "int-2", name: "github_create_issue", args: { title: "t" } }],
        []
      ],
      mcpToolNames: ["notion_search", "github_create_issue"]
    });
    const audits: Array<Record<string, unknown>> = [];
    const adapter = new DeepAgentsRuntimeAdapter(
      testConfig,
      makeDynamicConfig(),
      fakeLog,
      {
        approvals: makeRichApprovalStore() as never,
        auditEvents: { create: async (e: Record<string, unknown>) => void audits.push(e) } as never
      },
      undefined,
      factory
    );
    const session = await adapter.createSession(sessionInput);
    const { events, done } = startTurn(adapter, session);

    // First prompt: notion_search — approve + remember.
    const first = (await waitForEvent(
      events,
      (e) => e.type === "framework:approval_required"
    )) as Extract<RuntimeEvent, { type: "framework:approval_required" }>;
    expect(first.command).toBe("notion_search");
    await adapter.resolveApproval({
      tenantId: sessionInput.tenantId,
      approvalId: first.approvalId,
      userId: sessionInput.userId,
      decision: "approve",
      rememberForTurn: true
    });

    // Second prompt MUST still appear — github_create_issue is a different tool.
    const second = (await waitForEvent(
      events,
      (e) =>
        e.type === "framework:approval_required" &&
        (e as Extract<RuntimeEvent, { type: "framework:approval_required" }>).approvalId !==
          first.approvalId
    )) as Extract<RuntimeEvent, { type: "framework:approval_required" }>;
    expect(second.command).toBe("github_create_issue");
    await adapter.resolveApproval({
      tenantId: sessionInput.tenantId,
      approvalId: second.approvalId,
      userId: sessionInput.userId,
      decision: "approve"
    });

    await done;
    expect(resumes).toEqual([[{ type: "approve" }], [{ type: "approve" }]]);
    // Both prompted — no silent auto-approval of the second MCP tool.
    expect(events.filter((e) => e.type === "framework:approval_required")).toHaveLength(2);
    expect(audits.some((a) => a.type === "approval.auto_approved")).toBe(false);
    await adapter.close();
  });

  it("interruptTurn while an approval is pending rejects it and ends interrupted", async () => {
    const { factory } = makeInterruptingFactory({
      rounds: [[{ interruptId: "int-1", name: "execute", args: { command: "slow" } }], []]
    });
    const adapter = new DeepAgentsRuntimeAdapter(
      testConfig,
      makeDynamicConfig(),
      fakeLog,
      {
        approvals: makeRichApprovalStore() as never,
        auditEvents: { create: async () => {} } as never
      },
      undefined,
      factory
    );
    const session = await adapter.createSession(sessionInput);
    const { events, done } = startTurn(adapter, session);
    await waitForEvent(events, (e) => e.type === "framework:approval_required");

    expect(await adapter.interruptTurn(sessionInput)).toBe("interrupted");
    await done;
    expect(events.at(-1)).toMatchObject({ type: "response.completed", interrupted: true });
    await adapter.close();
  });

  it("fans out two concurrent actions in one round, prompting both before either resolves", async () => {
    // One round with TWO pending actions (parallel `task` subagents each hitting
    // a gated tool). collectApprovalDecisions fans them out via Promise.all, so
    // BOTH prompts must reach the user before any single decision unblocks the
    // graph — a serialized "prompt, wait, prompt" implementation would emit only
    // one framework:approval_required until the first is answered.
    const { factory } = makeInterruptingFactory({
      rounds: [
        [
          { interruptId: "int-1", name: "execute", args: { command: "cmd-A" } },
          { interruptId: "int-2", name: "execute", args: { command: "cmd-B" } }
        ],
        []
      ]
    });
    const adapter = new DeepAgentsRuntimeAdapter(
      testConfig,
      makeDynamicConfig(),
      fakeLog,
      {
        approvals: makeRichApprovalStore() as never,
        auditEvents: { create: async () => {} } as never
      },
      undefined,
      factory
    );
    const session = await adapter.createSession(sessionInput);
    const { events, done } = startTurn(adapter, session);

    // Both prompts appear with NO decision made yet.
    await waitForEvent(
      events,
      (e) => e.type === "framework:approval_required" && e.command === "cmd-B"
    );
    const prompts = events.filter(
      (e): e is Extract<RuntimeEvent, { type: "framework:approval_required" }> =>
        e.type === "framework:approval_required"
    );
    expect(prompts.map((p) => p.command).sort()).toEqual(["cmd-A", "cmd-B"]);
    // Distinct approval rows — each concurrent action is independently settleable.
    expect(new Set(prompts.map((p) => p.approvalId)).size).toBe(2);
    // The turn has not resumed: the round is still awaiting decisions.
    expect(events.some((e) => e.type === "response.completed")).toBe(false);

    // Answer both so the round completes and the turn ends cleanly.
    for (const prompt of prompts) {
      await adapter.resolveApproval({
        tenantId: sessionInput.tenantId,
        approvalId: prompt.approvalId,
        userId: sessionInput.userId,
        decision: "approve"
      });
    }
    await done;
    await adapter.close();
  });

  it("maps out-of-order, mixed decisions back to action order positionally", async () => {
    // Resolve int-2 (reject) BEFORE int-1 (approve). The decisions array handed
    // to buildResumeInput must follow the ACTIONS order (int-1 then int-2), not
    // the order the humans answered — a flat resolution-ordered array would
    // deliver each subagent the wrong verdict.
    const { factory, resumes } = makeInterruptingFactory({
      rounds: [
        [
          { interruptId: "int-1", name: "execute", args: { command: "approve-me" } },
          { interruptId: "int-2", name: "execute", args: { command: "reject-me" } }
        ],
        []
      ]
    });
    const adapter = new DeepAgentsRuntimeAdapter(
      testConfig,
      makeDynamicConfig(),
      fakeLog,
      {
        approvals: makeRichApprovalStore() as never,
        auditEvents: { create: async () => {} } as never
      },
      undefined,
      factory
    );
    const session = await adapter.createSession(sessionInput);
    const { events, done } = startTurn(adapter, session);

    await waitForEvent(
      events,
      (e) => e.type === "framework:approval_required" && e.command === "reject-me"
    );
    const prompts = events.filter(
      (e): e is Extract<RuntimeEvent, { type: "framework:approval_required" }> =>
        e.type === "framework:approval_required"
    );
    const promptFor = (command: string) => {
      const match = prompts.find((p) => p.command === command);
      if (!match) throw new Error(`no prompt for ${command}`);
      return match;
    };

    // Reject the SECOND action first, then approve the first.
    await adapter.resolveApproval({
      tenantId: sessionInput.tenantId,
      approvalId: promptFor("reject-me").approvalId,
      userId: sessionInput.userId,
      decision: "reject"
    });
    await adapter.resolveApproval({
      tenantId: sessionInput.tenantId,
      approvalId: promptFor("approve-me").approvalId,
      userId: sessionInput.userId,
      decision: "approve"
    });

    await done;
    // Positional contract: index 0 = int-1 (approve), index 1 = int-2 (reject).
    expect(resumes).toEqual([
      [{ type: "approve" }, { type: "reject", message: "User denied permission." }]
    ]);
    await adapter.close();
  });
});

describe("DeepAgentsRuntimeAdapter", () => {
  it("creates a session, persists the runtime_sessions row, and is idempotent", async () => {
    const upsert = vi.fn(async () => {});
    const { factory, factoryCalls } = makeRuntimeFactory(() => scriptedChatStream());
    const adapter = makeAdapter({ factory, runtimeSessions: { upsert, setStatus: vi.fn() } });

    const ref = await adapter.createSession(sessionInput);
    expect(ref.sessionId).toBe("sess-1");
    expect(ref.runtimeId).toMatch(/^deepagents-/);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0]![0]).toMatchObject({
      runtimeProvider: "deep-agents",
      status: "active"
    });

    // Second call reuses the live session — no new runtime, no new DB row.
    const again = await adapter.createSession(sessionInput);
    expect(again.runtimeId).toBe(ref.runtimeId);
    expect(factoryCalls).toHaveLength(1);
    expect(upsert).toHaveBeenCalledTimes(1);

    await adapter.close();
  });

  it("collapses concurrent createSession calls for one session onto a single build", async () => {
    const upsert = vi.fn(async () => {});
    const { factory, factoryCalls } = makeRuntimeFactory(() => scriptedChatStream());
    const adapter = makeAdapter({ factory, runtimeSessions: { upsert, setStatus: vi.fn() } });

    // Two callers race before either registers the session state (R26).
    const [a, b] = await Promise.all([
      adapter.createSession(sessionInput),
      adapter.createSession(sessionInput)
    ]);

    // Exactly one runtime was built and one DB row written; both callers got it.
    expect(factoryCalls).toHaveLength(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(a.runtimeId).toBe(b.runtimeId);

    await adapter.close();
  });

  it("fails createSession when no provider key is available", async () => {
    const { factory } = makeRuntimeFactory(() => scriptedChatStream());
    // Credentials reporting zero configured providers.
    const adapter = makeAdapter({
      factory,
      providerCredentials: {
        resolveKey: async () => null,
        hasKey: async () => false,
        platformProviders: new Set()
      }
    });
    // 400 so the failure surfaces as user-actionable ("configure a key") via
    // clientSafeTurnFailureMessage rather than the generic message (R27).
    await expect(adapter.createSession(sessionInput)).rejects.toMatchObject({
      message: expect.stringMatching(/model-provider API key/),
      statusCode: 400
    });
  });

  it("resolves the provider key lazily and passes a resolver (never a proxy URL)", async () => {
    const { factory, factoryCalls } = makeRuntimeFactory(() => scriptedChatStream());
    const adapter = makeAdapter({
      factory,
      // Single tenant key applied to every provider (makeAdapter shim).
      getTenantApiKey: async () => "sk-ant-tenant-key"
    });
    await adapter.createSession(sessionInput);
    // The factory receives a resolver, not a pre-resolved key — the provider is
    // only known at model-selection time. The in-process loop calls each
    // provider directly, so providerBaseUrls stays null.
    const call = factoryCalls[0]!;
    expect(call.providerBaseUrls).toBeNull();
    await expect(call.resolveProviderKey("anthropic")).resolves.toBe("sk-ant-tenant-key");
    await adapter.close();
  });

  it("accumulates stream usage_metadata and persists tokens + cost", async () => {
    const { factory } = makeRuntimeFactory(async function* () {
      yield {
        event: "on_chat_model_stream",
        metadata: {},
        data: { chunk: { content: "hi" } }
      };
      yield {
        event: "on_chat_model_end",
        metadata: {},
        data: { output: { usage_metadata: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } }
      };
      // Subagent-namespace model call — its tokens count too.
      yield {
        event: "on_chat_model_end",
        metadata: { langgraph_checkpoint_ns: "tools:x|model_request:y" },
        data: {
          output: {
            usage_metadata: {
              input_tokens: 50,
              output_tokens: 5,
              total_tokens: 55,
              input_token_details: { cache_read: 10 }
            }
          }
        }
      };
    });
    const addTokenUsage = vi.fn(async (_t: string, _m: string, _u: string, delta: unknown) => ({
      inputTokens: 150,
      cachedInputTokens: 10,
      outputTokens: 25,
      reasoningOutputTokens: 0,
      totalTokens: 175,
      ...(delta as object ? {} : {})
    }));
    const setCostUsd = vi.fn(async () => {});
    const adapter = makeAdapter({
      factory,
      messages: { addTokenUsage, setCostUsd }
    });
    const session = await adapter.createSession(sessionInput);
    await collect(
      adapter.runMessage(session, { ...runMessageInput(), assistantMessageId: "msg-42" })
    );

    expect(addTokenUsage).toHaveBeenCalledTimes(1);
    const [tenantId, messageId, userId, delta, modelName] = addTokenUsage.mock.calls[0]!;
    expect([tenantId, messageId, userId]).toEqual(["test-tenant", "msg-42", "user-1"]);
    expect(delta).toEqual({
      inputTokens: 150,
      cachedInputTokens: 10,
      outputTokens: 25,
      reasoningOutputTokens: 0,
      totalTokens: 175
    });
    // Bare Anthropic model id (pricing-table key), not the namespaced one.
    expect(modelName).toBe("claude-sonnet-5");
    expect(setCostUsd).toHaveBeenCalledTimes(1);
    await adapter.close();
  });

  it("persists the pre-failure token usage when the turn throws mid-stream", async () => {
    // Billing/data-integrity: a turn that consumes tokens then errors must still
    // bill for what it burned. Usage is captured in on_chat_model_end BEFORE the
    // stream throws; persistTurnUsage runs in runTurn's finally, so the failed
    // turn still records its usage. A regression moving persistence out of the
    // finally (e.g. onto the success path) would silently stop billing errors.
    const { factory } = makeRuntimeFactory(async function* () {
      yield {
        event: "on_chat_model_end",
        metadata: {},
        data: { output: { usage_metadata: { input_tokens: 90, output_tokens: 10, total_tokens: 100 } } }
      };
      throw new Error("provider exploded mid-turn");
    });
    const addTokenUsage = vi.fn(async () => ({
      inputTokens: 90,
      cachedInputTokens: 0,
      outputTokens: 10,
      reasoningOutputTokens: 0,
      totalTokens: 100
    }));
    const setCostUsd = vi.fn(async () => {});
    const adapter = makeAdapter({ factory, messages: { addTokenUsage, setCostUsd } });
    const session = await adapter.createSession(sessionInput);
    const events = await collect(
      adapter.runMessage(session, { ...runMessageInput(), assistantMessageId: "msg-fail" })
    );

    // The turn surfaces a failure, not a completion...
    expect(events.at(-1)).toMatchObject({ type: "response.failed" });
    // ...yet the tokens burned before the throw were still billed.
    expect(addTokenUsage).toHaveBeenCalledTimes(1);
    const [tenantId, messageId, userId, delta] = addTokenUsage.mock.calls[0]!;
    expect([tenantId, messageId, userId]).toEqual(["test-tenant", "msg-fail", "user-1"]);
    expect(delta).toMatchObject({ inputTokens: 90, outputTokens: 10, totalTokens: 100 });
    await adapter.close();
  });

  it("keeps the same thread_id when the model switches mid-session", async () => {
    // A per-turn model switch rebuilds the compiled agent (new model reaches
    // getAgentForModel) but must keep the same checkpointer thread_id, so the
    // conversation history carries across the switch. thread_id === sessionId.
    const { factory, modelRequests, streamConfigs } = makeRuntimeFactory(scriptedChatStream);
    const adapter = makeAdapter({ factory, getTenantApiKey: async () => "sk-key" });
    const session = await adapter.createSession(sessionInput);

    // Turn 1: default model.
    await collect(adapter.runMessage(session, runMessageInput()));
    // Turn 2: same session, a different provider's model.
    await collect(adapter.runMessage(session, runMessageInput({ model: "openai/gpt-5.5" })));

    expect(modelRequests).toEqual(["deepagents/claude-sonnet-5", "openai/gpt-5.5"]);
    expect(streamConfigs.map((c) => c.configurable.thread_id)).toEqual(["sess-1", "sess-1"]);
    await adapter.close();
  });

  it("records the bare vendor id and the priced cost for a non-Anthropic model", async () => {
    const { factory } = makeRuntimeFactory(async function* () {
      yield {
        event: "on_chat_model_end",
        metadata: {},
        data: { output: { usage_metadata: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } }
      };
    });
    const usage = {
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 3,
      reasoningOutputTokens: 0,
      totalTokens: 13
    };
    const addTokenUsage = vi.fn(async () => usage);
    const setCostUsd = vi.fn(async (_t: string, _m: string, _u: string, _cost: number | null) => {});
    const adapter = makeAdapter({ factory, messages: { addTokenUsage, setCostUsd } });
    const session = await adapter.createSession(sessionInput);
    await collect(
      adapter.runMessage(session, {
        ...runMessageInput({ model: "openrouter/deepseek/deepseek-v4-pro" }),
        assistantMessageId: "msg-or"
      })
    );

    const modelName = addTokenUsage.mock.calls[0]![4];
    // First-slash-only strip preserves the OpenRouter vendor id's inner slash.
    expect(modelName).toBe("deepseek/deepseek-v4-pro");
    // Every provider is now priced (commit 0c47e37) — cost is the pricing-table
    // computation for the bare vendor id, not null.
    expect(addTokenUsage).toHaveBeenCalledTimes(1);
    expect(setCostUsd).toHaveBeenCalledTimes(1);
    const expectedCost = calculateCostUsd("deepseek/deepseek-v4-pro", usage);
    expect(expectedCost).not.toBeNull();
    expect(setCostUsd.mock.calls[0]![3]).toBe(expectedCost);
    await adapter.close();
  });

  it("applies the catalog defaultEffort when the turn omits an explicit effort", async () => {
    // No effort in the input (scheduled/API/no-selector paths). gpt-5.5's
    // catalog defaultEffort is "medium" — it must reach getAgentForModel.
    const { factory, effortRequests } = makeRuntimeFactory(scriptedChatStream);
    const adapter = makeAdapter({ factory, getTenantApiKey: async () => "sk-key" });
    const session = await adapter.createSession(sessionInput);
    await collect(adapter.runMessage(session, runMessageInput({ model: "openai/gpt-5.5" })));

    expect(effortRequests.at(-1)).toBe("medium");
    await adapter.close();
  });

  it("honors an explicit effort over the catalog default", async () => {
    // gpt-5.5 defaults to "medium"; an explicit "high" must win.
    const { factory, effortRequests } = makeRuntimeFactory(scriptedChatStream);
    const adapter = makeAdapter({ factory, getTenantApiKey: async () => "sk-key" });
    const session = await adapter.createSession(sessionInput);
    await collect(
      adapter.runMessage(session, runMessageInput({ model: "openai/gpt-5.5", effort: "high" }))
    );

    expect(effortRequests.at(-1)).toBe("high");
    await adapter.close();
  });

  it("passes null effort for a model whose catalog default is null", async () => {
    // OpenRouter models advertise no efforts (defaultEffort: null) — the
    // fallback resolves to null, not an invalid effort.
    const { factory, effortRequests } = makeRuntimeFactory(scriptedChatStream);
    const adapter = makeAdapter({ factory, getTenantApiKey: async () => "sk-key" });
    const session = await adapter.createSession(sessionInput);
    await collect(
      adapter.runMessage(session, runMessageInput({ model: "openrouter/deepseek/deepseek-v4-pro" }))
    );

    expect(effortRequests.at(-1)).toBeNull();
    await adapter.close();
  });

  it("attaches the sandbox only when the owner allows command execution", async () => {
    const configWithE2b = createTestConfig({
      ANTHROPIC_API_KEY: "sk-ant-test-key",
      E2B_API_KEY: "e2b-test-key"
    });

    // testRuntimePolicy has allowCommandExecution=false — owner said no
    // shell, so no sandbox is attached even though the E2B key exists.
    const denied = makeRuntimeFactory(() => scriptedChatStream());
    const deniedAdapter = makeAdapter({ factory: denied.factory, config: configWithE2b });
    await deniedAdapter.createSession(sessionInput);
    expect(denied.factoryCalls[0]!.e2b).toBeNull();
    await deniedAdapter.close();

    const allowed = makeRuntimeFactory(() => scriptedChatStream());
    const allowedAdapter = makeAdapter({
      factory: allowed.factory,
      config: configWithE2b,
      dynamicConfig: makeDynamicConfig({ allowCommandExecution: true })
    });
    await allowedAdapter.createSession(sessionInput);
    expect(allowed.factoryCalls[0]!.e2b).toMatchObject({ apiKey: "e2b-test-key" });
    await allowedAdapter.close();
  });

  it("sends the artifact-context user inputs instead of the raw prompt", async () => {
    const { factory, streamInputs } = makeRuntimeFactory(() => scriptedChatStream());
    const adapter = makeAdapter({ factory });
    const session = await adapter.createSession(sessionInput);

    const artifactText = "Artifact context:\n- sales.xlsx synced\n\nWhat is the Q3 total?";
    await collect(
      adapter.runMessage(session, {
        ...runMessageInput(),
        userInputs: [{ type: "text" as const, text: artifactText }]
      })
    );
    expect(streamInputs[0]).toEqual({
      messages: [{ role: "user", content: artifactText }]
    });

    // Without userInputs, the raw prompt is the message content.
    await collect(adapter.runMessage(session, runMessageInput({ prompt: "plain question" })));
    expect(streamInputs[1]).toEqual({
      messages: [{ role: "user", content: "plain question" }]
    });
    await adapter.close();
  });

  it("streams a chat turn as created → deltas → done → completed", async () => {
    const { factory, streamConfigs, modelRequests } = makeRuntimeFactory(() =>
      scriptedChatStream()
    );
    const adapter = makeAdapter({ factory });
    const session = await adapter.createSession(sessionInput);

    const events = await collect(
      adapter.runMessage(session, { ...runMessageInput(), assistantMessageId: "msg-1" })
    );

    expect(events.map((e) => e.type)).toEqual([
      "response.created",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_item.done",
      "response.output_item.done",
      "response.completed"
    ]);
    expect(events.every((e) => !("responseId" in e) || e.responseId === "msg-1")).toBe(true);
    // Thread id is the session id (tenant ownership is enforced at the routes
    // — see im5e.3) and the default deep-agents model is requested.
    expect(streamConfigs[0]!.configurable.thread_id).toBe("sess-1");
    expect(modelRequests[0]).toBe("deepagents/claude-sonnet-5");

    await adapter.close();
  });

  it("rejects a concurrent turn for the same session with SessionBusyError", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { factory } = makeRuntimeFactory(async function* () {
      await gate;
      yield { event: "on_chat_model_stream", metadata: {}, data: { chunk: { content: "x" } } };
    });
    const adapter = makeAdapter({ factory });
    const session = await adapter.createSession(sessionInput);

    const firstTurn = collect(adapter.runMessage(session, runMessageInput()));
    // Give the first turn a tick to reserve the slot.
    await new Promise((resolve) => setImmediate(resolve));
    expect(adapter.hasActiveTurn("sess-1")).toBe(true);

    await expect(collect(adapter.runMessage(session, runMessageInput()))).rejects.toThrow(
      SessionBusyError
    );

    release();
    await firstTurn;
    await adapter.close();
  });

  it("surfaces stream failures as response.failed with a client-safe message", async () => {
    // Raw internals (pg hosts, DDL, stack detail) must not reach the
    // transcript — non-4xx errors collapse to the generic message.
    const { factory } = makeRuntimeFactory(async function* () {
      yield { event: "on_chat_model_stream", metadata: {}, data: { chunk: { content: "part" } } };
      throw new Error('connect ECONNREFUSED db.internal:5432 while running CREATE TABLE "secret"');
    });
    const adapter = makeAdapter({ factory });
    const session = await adapter.createSession(sessionInput);

    const events = await collect(adapter.runMessage(session, runMessageInput()));
    expect(events.at(-1)).toMatchObject({
      type: "response.failed",
      message: "The assistant run failed."
    });
    expect(adapter.hasActiveTurn("sess-1")).toBe(false);
    await adapter.close();
  });

  it("passes 4xx provider errors through and translates GraphRecursionError", async () => {
    // Real Anthropic/OpenAI SDK errors carry `.status`, not `.statusCode`;
    // `.statusCode` covers the app-thrown variant. Both must pass through.
    const sdkProviderError = Object.assign(new Error("invalid x-api-key"), { status: 401 });
    const appProviderError = Object.assign(new Error("rate limit exceeded"), { statusCode: 429 });
    for (const [thrown, expected] of [
      [sdkProviderError, "invalid x-api-key"],
      [appProviderError, "rate limit exceeded"],
      [
        Object.assign(new Error("Recursion limit of 10000 reached"), {
          name: "GraphRecursionError"
        }),
        "The agent hit its step limit before finishing. Try splitting the request into smaller steps."
      ]
    ] as const) {
      const { factory } = makeRuntimeFactory(async function* () {
        yield { event: "on_chat_model_stream", metadata: {}, data: { chunk: { content: "x" } } };
        throw thrown;
      });
      const adapter = makeAdapter({ factory });
      const session = await adapter.createSession(sessionInput);
      const events = await collect(adapter.runMessage(session, runMessageInput()));
      expect(events.at(-1)).toMatchObject({ type: "response.failed", message: expected });
      await adapter.close();
    }
  });

  it("does not open an approval round when the watchdog fired before collection", async () => {
    // Race: the stream ends, the watchdog fires DURING pending-interrupt
    // detection. The turn must fail on the timeout path without emitting
    // framework:approval_required (a prompt for a dead turn).
    vi.useFakeTimers();
    try {
      const config = createTestConfig({
        ANTHROPIC_API_KEY: "sk-ant-test-key",
        RUNTIME_TURN_TIMEOUT_MS: "1000"
      });
      const factory: DeepAgentsRuntimeFactory = () => ({
        async getAgentForModel() {
          return {
            async *streamEvents() {
              yield { event: "on_chat_model_stream", metadata: {}, data: { chunk: { content: "x" } } };
            }
          };
        },
        async getPendingActions() {
          // Slow state fetch straddling the watchdog deadline.
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          return [{ interruptId: "int-1", name: "execute", args: { command: "late" } }];
        },
        buildResumeInput() {
          throw new Error("must not resume a timed-out turn");
        },
        dispose: async () => {}
      });
      const adapter = makeAdapter({ factory, config });
      const session = await adapter.createSession(sessionInput);

      const collected = collect(adapter.runMessage(session, runMessageInput()));
      await vi.advanceTimersByTimeAsync(2_100);
      const events = await collected;

      expect(events.some((event) => event.type === "framework:approval_required")).toBe(false);
      expect(events.at(-1)).toMatchObject({
        type: "response.failed",
        message: "The turn exceeded the platform time limit and was stopped."
      });
      await adapter.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails a wedged turn when the RUNTIME_TURN_TIMEOUT_MS watchdog fires", async () => {
    vi.useFakeTimers();
    try {
      const config = createTestConfig({
        ANTHROPIC_API_KEY: "sk-ant-test-key",
        RUNTIME_TURN_TIMEOUT_MS: "1000"
      });
      const { factory } = makeRuntimeFactory(async function* (streamConfig) {
        yield { event: "on_chat_model_stream", metadata: {}, data: { chunk: { content: "stuck " } } };
        // A wedged model call: never resolves until the abort signal fires.
        await new Promise<void>((_resolve, reject) => {
          streamConfig.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true
          });
        });
      });
      const adapter = makeAdapter({ factory, config });
      const session = await adapter.createSession(sessionInput);

      const collected = collect(adapter.runMessage(session, runMessageInput()));
      await vi.advanceTimersByTimeAsync(1_100);
      const events = await collected;

      expect(events.at(-1)).toMatchObject({
        type: "response.failed",
        message: "The turn exceeded the platform time limit and was stopped."
      });
      // The watchdog must release the session slot for the next message.
      expect(adapter.hasActiveTurn("sess-1")).toBe(false);
      await adapter.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("interruptTurn aborts the stream and completes the turn as interrupted", async () => {
    const { factory } = makeRuntimeFactory(async function* (config) {
      yield { event: "on_chat_model_stream", metadata: {}, data: { chunk: { content: "partial" } } };
      // Simulate a long model call that only ends when the turn is aborted.
      await new Promise<void>((_resolve, reject) => {
        const signal = config.signal;
        if (!signal) return;
        if (signal.aborted) return reject(new Error("Aborted"));
        signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
      });
    });
    const adapter = makeAdapter({ factory });
    const session = await adapter.createSession(sessionInput);

    const turn = collect(adapter.runMessage(session, runMessageInput()));
    await new Promise((resolve) => setImmediate(resolve));

    const outcome = await adapter.interruptTurn(sessionInput);
    expect(outcome).toBe("interrupted");

    const events = await turn;
    expect(events.at(-1)).toMatchObject({ type: "response.completed", interrupted: true });
    // Session stays warm for the follow-up message.
    expect(adapter.hasSession("sess-1")).toBe(true);
    await adapter.close();
  });

  it("returns no_active_turn when there is nothing to interrupt", async () => {
    const { factory } = makeRuntimeFactory(() => scriptedChatStream());
    const adapter = makeAdapter({ factory });
    await adapter.createSession(sessionInput);
    expect(await adapter.interruptTurn(sessionInput)).toBe("no_active_turn");
    await adapter.close();
  });

  it("abortSession disposes the runtime, terminates the DB row, and drops state", async () => {
    const setStatus = vi.fn(async () => {});
    const { factory, dispose } = makeRuntimeFactory(() => scriptedChatStream());
    const adapter = makeAdapter({
      factory,
      runtimeSessions: { upsert: vi.fn(async () => {}), setStatus }
    });
    const ref = await adapter.createSession(sessionInput);

    await adapter.abortSession(sessionInput);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith(
      "test-tenant",
      "sess-1",
      "user-1",
      "terminated",
      ref.runtimeId
    );
    expect(adapter.hasSession("sess-1")).toBe(false);
  });

  it("invalidateTenantRuntimes tears down only that tenant's sessions", async () => {
    const { factory } = makeRuntimeFactory(() => scriptedChatStream());
    const adapter = makeAdapter({ factory });
    await adapter.createSession(sessionInput);
    await adapter.createSession({ tenantId: "other-tenant", sessionId: "sess-2", userId: "u2" });

    const invalidated = await adapter.invalidateTenantRuntimes("test-tenant");
    expect(invalidated).toEqual(["sess-1"]);
    expect(adapter.hasSession("sess-1")).toBe(false);
    expect(adapter.hasSession("sess-2")).toBe(true);
    await adapter.close();
  });

  it("invalidateTenantRuntimes with idleOnly skips sessions with an active turn", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { factory } = makeRuntimeFactory(async function* () {
      await gate;
      yield { event: "on_chat_model_stream", metadata: {}, data: { chunk: { content: "x" } } };
    });
    const adapter = makeAdapter({ factory });
    const busySession = await adapter.createSession(sessionInput);
    await adapter.createSession({ tenantId: "test-tenant", sessionId: "sess-idle", userId: "u1" });

    const busyTurn = collect(adapter.runMessage(busySession, runMessageInput()));
    // Give the turn a tick to reserve the slot.
    await new Promise((resolve) => setImmediate(resolve));
    expect(adapter.hasActiveTurn("sess-1")).toBe(true);

    // The admin "idle" rollout path: the mid-turn session must survive.
    const invalidated = await adapter.invalidateTenantRuntimes("test-tenant", { idleOnly: true });
    expect(invalidated).toEqual(["sess-idle"]);
    expect(adapter.hasSession("sess-1")).toBe(true);
    expect(adapter.hasSession("sess-idle")).toBe(false);

    release();
    const events = await busyTurn;
    expect(events.at(-1)).toMatchObject({ type: "response.completed" });
    await adapter.close();
  });

  it("purgeSessionData deletes the checkpointer thread; abortSession does not", async () => {
    const deleteThread = vi.fn(async () => {});
    const end = vi.fn(async () => {});
    const { factory, factoryCalls } = makeRuntimeFactory(() => scriptedChatStream());
    const adapter = makeAdapter({ factory, checkpointer: { deleteThread, end } });

    await adapter.createSession(sessionInput);
    // The shared checkpointer is threaded into the session runtime factory.
    expect(factoryCalls[0]!.checkpointer).toBeDefined();

    // Warm-session teardown (idle timeout / invalidation) must keep the thread.
    await adapter.abortSession(sessionInput);
    expect(deleteThread).not.toHaveBeenCalled();

    await adapter.purgeSessionData(sessionInput);
    expect(deleteThread).toHaveBeenCalledWith("sess-1");

    await adapter.close();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("routes runtime file ops to the session runtime's sandbox helpers", async () => {
    const { factory } = makeRuntimeFactory(() => scriptedChatStream());
    const files = new Map<string, Uint8Array>();
    const fileFactory: DeepAgentsRuntimeFactory = (init) => {
      const base = factory(init);
      return {
        ...base,
        readFileBytes: async (p) => {
          const stored = files.get(p);
          if (!stored) throw new Error("missing");
          return stored;
        },
        statFile: async (p) => ({ sizeBytes: files.get(p)?.byteLength ?? 0 }),
        writeFileBytes: async (p, data) => {
          files.set(p, typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data as Uint8Array));
          return `/home/user/workspace/sess-1/${p}`;
        }
      };
    };
    const adapter = makeAdapter({ factory: fileFactory });
    await adapter.createSession(sessionInput);

    const sandboxPath = await adapter.writeRuntimeFile("sess-1", "artifacts/a.csv", "x,y");
    expect(sandboxPath).toBe("/home/user/workspace/sess-1/artifacts/a.csv");
    expect(await adapter.statRuntimeFile("sess-1", "artifacts/a.csv")).toEqual({ sizeBytes: 3 });
    expect(new TextDecoder().decode(await adapter.readRuntimeFile("sess-1", "artifacts/a.csv"))).toBe("x,y");
    await adapter.close();
  });

  it("rejects runtime file ops when the runtime has no sandbox backend", async () => {
    const { factory } = makeRuntimeFactory(() => scriptedChatStream());
    const adapter = makeAdapter({ factory });
    await adapter.createSession(sessionInput);
    await expect(adapter.readRuntimeFile("sess-1", "a.txt")).rejects.toThrow(/no sandbox backend/);
    await adapter.close();
  });

  it("resolveApproval reports missing for approvals it does not own", async () => {
    const { factory } = makeRuntimeFactory(() => scriptedChatStream());
    const adapter = makeAdapter({ factory });
    const outcome = await adapter.resolveApproval({
      tenantId: "test-tenant",
      approvalId: "apr-unknown",
      userId: "user-1",
      decision: "approve"
    });
    expect(outcome).toBe("missing");
  });

  it("injects the memory section into the system prompt when memory_search is enabled", async () => {
    const { factory, factoryCalls } = makeRuntimeFactory(() => scriptedChatStream());
    const memories = {
      async search() {
        return [
          {
            memoryId: "m1",
            userId: "user-1",
            slug: "favorite-format",
            content: "User prefers xlsx exports",
            metadata: {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ];
      }
    };
    const adapter = makeAdapter({
      factory,
      memories,
      dynamicConfig: makeDynamicConfig({
        developerInstructions: "Be terse.",
        enabledToolIds: [...testRuntimePolicy.enabledToolIds, "memory_search"]
      })
    });

    await adapter.createSession(sessionInput);
    const systemPrompt = factoryCalls[0]!.systemPrompt;
    expect(systemPrompt).toContain("Be terse.");
    expect(systemPrompt).toContain("Long-term memory");
    expect(systemPrompt).toContain("favorite-format");
    await adapter.close();
  });

  it("serves enabled skills as a /skills/ library instead of inlining them into the prompt", async () => {
    const { factory, factoryCalls } = makeRuntimeFactory(() => scriptedChatStream());
    const adapter = makeAdapter({
      factory,
      dynamicConfig: makeDynamicConfig(
        {},
        {
          skills: [
            {
              id: "write-artifact",
              name: "write-artifact",
              description: "Persist generated files",
              instructions: "Call the write_artifact tool for every generated file.",
              version: 1,
              hash: "h",
              revisionId: null,
              bundleHash: null,
              sourceType: "inline",
              bundleName: null,
              bundleStorageUri: null,
              validationStatus: null,
              reviewStatus: null
            }
          ]
        }
      )
    });
    await adapter.createSession(sessionInput);
    const systemPrompt = factoryCalls[0]!.systemPrompt ?? "";
    // Progressive disclosure (bead kpit): skill instructions live in the
    // /skills/ file library, not the system prompt.
    expect(systemPrompt).not.toContain("## Skill:");
    expect(systemPrompt).not.toContain("Call the write_artifact tool");
    const library = factoryCalls[0]!.skillsLibraryFiles ?? {};
    const skillMd = library["/write-artifact/SKILL.md"];
    expect(skillMd).toBeTruthy();
    expect(skillMd!.content).toContain('name: "write-artifact"');
    expect(skillMd!.content).toContain("Call the write_artifact tool for every generated file.");
    await adapter.close();
  });

  it("omits memory contents when memory_search is not enabled", async () => {
    const search = vi.fn(async () => []);
    const { factory, factoryCalls } = makeRuntimeFactory(() => scriptedChatStream());
    const adapter = makeAdapter({ factory, memories: { search } });

    await adapter.createSession(sessionInput);
    expect(search).not.toHaveBeenCalled();
    expect(factoryCalls[0]!.systemPrompt ?? "").not.toContain("Long-term memory");
    await adapter.close();
  });
});

// ── Track B spike (boundary b): runMessageAGUI ───────────────────────────────
describe("DeepAgentsRuntimeAdapter runMessageAGUI (AG-UI)", () => {
  async function collectAGUI(iterable: AsyncIterable<AGUIBaseEvent>): Promise<AGUIBaseEvent[]> {
    const events: AGUIBaseEvent[] = [];
    for await (const event of iterable) {
      // Every emitted event must satisfy AG-UI's own schema — the same contract
      // the real runAgent() path enforces via verifyEvents.
      const result = AGUIEventSchemas.safeParse(event);
      expect(result.success, `invalid AG-UI event ${String((event as { type?: string }).type)}`).toBe(true);
      events.push(event);
    }
    return events;
  }

  it("streams a well-formed AG-UI turn (RUN_STARTED … RUN_FINISHED)", async () => {
    const { factory } = makeRuntimeFactory(() => scriptedChatStream());
    const adapter = makeAdapter({ factory });
    const session = await adapter.createSession(sessionInput);

    const events = await collectAGUI(
      adapter.runMessageAGUI(session, { prompt: "hello", toolContextId: "ctx-1" })
    );
    const types = events.map((e) => e.type);
    expect(types[0]).toBe(AGUIEventType.RUN_STARTED);
    expect(types.at(-1)).toBe(AGUIEventType.RUN_FINISHED);
    expect(types).toContain(AGUIEventType.TEXT_MESSAGE_CONTENT);
    await adapter.close();
  });

  it("bridges a native interrupt to an AG-UI approval carrying the real approvalId, then resumes", async () => {
    const { factory, resumes } = makeInterruptingFactory({
      rounds: [[{ interruptId: "int-1", name: "execute", args: { command: "rm -rf build" } }], []]
    });
    const approvals = makeRichApprovalStore();
    const adapter = new DeepAgentsRuntimeAdapter(
      testConfig,
      makeDynamicConfig(),
      fakeLog,
      { approvals: approvals as never, auditEvents: { create: async () => {} } as never },
      undefined,
      factory
    );
    const session = await adapter.createSession(sessionInput);

    const events: AGUIBaseEvent[] = [];
    const done = (async () => {
      for await (const event of adapter.runMessageAGUI(session, {
        prompt: "hi",
        toolContextId: "ctx-1"
      })) {
        events.push(event);
      }
    })();

    const approval = (await waitForAGUIEvent(
      events,
      (e) => e.type === AGUIEventType.CUSTOM && (e as { name?: string }).name === "approval_required"
    )) as AGUIBaseEvent & { value: { approvalId: string } };
    const approvalId = approval.value.approvalId;
    // The DB row (the decision route's key) exists and is pending — proving the
    // bridge went through the real approval plane, not the driver's placeholder.
    expect(approvals.rows.get(approvalId)).toMatchObject({ status: "pending" });

    const outcome = await adapter.resolveApproval({
      tenantId: sessionInput.tenantId,
      approvalId,
      userId: sessionInput.userId,
      decision: "approve"
    });
    expect(outcome).toBe("resolved");

    await done;
    expect(resumes).toEqual([[{ type: "approve" }]]);
    expect(events.at(-1)?.type).toBe(AGUIEventType.RUN_FINISHED);
    await adapter.close();
  });

  it("translates an intentional Stop into a graceful RUN_FINISHED, not RUN_ERROR", async () => {
    // A stream that emits one chunk then hangs until the turn signal aborts —
    // lets us interrupt mid-turn the way the Stop button / a disconnect would.
    const factory: DeepAgentsRuntimeFactory = () =>
      ({
        async getAgentForModel() {
          return {
            async *streamEvents(_input: unknown, config: { signal?: AbortSignal }) {
              yield { event: "on_chat_model_stream", metadata: {}, data: { chunk: { content: "partial" } } };
              await new Promise<never>((_resolve, reject) => {
                config.signal?.addEventListener(
                  "abort",
                  () => reject(new DOMException("Aborted", "AbortError")),
                  { once: true }
                );
              });
            }
          };
        },
        dispose: async () => {}
      }) as unknown as DeepAgentsSessionRuntime;
    const adapter = makeAdapter({ factory });
    const session = await adapter.createSession(sessionInput);

    const events: AGUIBaseEvent[] = [];
    const done = (async () => {
      for await (const event of adapter.runMessageAGUI(session, { prompt: "hi", toolContextId: null })) {
        events.push(event);
      }
    })();

    await waitForAGUIEvent(events, (e) => e.type === AGUIEventType.TEXT_MESSAGE_CONTENT);
    expect(await adapter.interruptTurn(sessionInput)).toBe("interrupted");
    await done;

    const terminal = events.at(-1) as AGUIBaseEvent;
    expect(terminal.type).toBe(AGUIEventType.RUN_FINISHED);
    // The turn-abort marker is carried on the private `result` field, checked
    // through the shared contract helper (NOT the AG-UI-native `outcome`, which
    // would signal a resumable pause — see AGUI_INTERRUPTED_RESULT).
    expect(isAGUIInterruptedFinish(terminal)).toBe(true);
    expect(events.map((e) => e.type)).not.toContain(AGUIEventType.RUN_ERROR);
    // The whole aborted-mid-text sequence must satisfy AG-UI's stateful verifier
    // (what the real runAgent() path enforces) — a text message left open when
    // RUN_FINISHED arrives would make verifyEvents reject the stream.
    await expect(
      firstValueFrom(rxFrom(events).pipe(aguiVerifyEvents(false), toArray()))
    ).resolves.toHaveLength(events.length);
    await adapter.close();
  });

  it("fails a wedged AG-UI turn on the watchdog and releases the session slot", async () => {
    // Parity with runTurn's watchdog: an upstream that stalls without erroring
    // (and never disconnects the client) must not pin activeTurns forever —
    // otherwise every subsequent POST /messages 429s until process restart.
    vi.useFakeTimers();
    try {
      const config = createTestConfig({
        ANTHROPIC_API_KEY: "sk-ant-test-key",
        RUNTIME_TURN_TIMEOUT_MS: "1000"
      });
      const { factory } = makeRuntimeFactory(async function* (streamConfig) {
        yield { event: "on_chat_model_stream", metadata: {}, data: { chunk: { content: "stuck " } } };
        // Wedged model call: never resolves until the watchdog aborts it.
        await new Promise<void>((_resolve, reject) => {
          streamConfig.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true
          });
        });
      });
      const adapter = makeAdapter({ factory, config });
      const session = await adapter.createSession(sessionInput);

      const collected = collectAGUI(adapter.runMessageAGUI(session, { prompt: "hi", toolContextId: null }));
      await vi.advanceTimersByTimeAsync(1_100);
      const events = await collected;

      // A timeout is a terminal FAILURE, not a graceful Stop.
      const terminal = events.at(-1) as AGUIBaseEvent & { message?: string };
      expect(terminal.type).toBe(AGUIEventType.RUN_ERROR);
      expect(terminal.message).toBe("The turn exceeded the platform time limit and was stopped.");
      // The core of R1: the watchdog must release the slot so the session is
      // usable again without a process restart.
      expect(adapter.hasActiveTurn("sess-1")).toBe(false);
      await adapter.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not time out a turn while a Policy Center approval is pending, then re-arms", async () => {
    // Codex P2 / watchdog-vs-policy-approval: a Policy Center approval is held at
    // the MCP gateway (requestPolicyApproval), NOT via the native awaitDecisions
    // path — so the turn watchdog must be paused for it too, else a long turn is
    // aborted mid-approval even though the approval is within its TTL.
    vi.useFakeTimers();
    try {
      const config = createTestConfig({
        ANTHROPIC_API_KEY: "sk-ant-test-key",
        RUNTIME_TURN_TIMEOUT_MS: "1000"
      });
      // A stream that stays open until the turn aborts, keeping the turn (and its
      // watchdog) live while we hold a policy approval.
      const { factory } = makeRuntimeFactory(async function* (streamConfig) {
        yield { event: "on_chat_model_stream", metadata: {}, data: { chunk: { content: "working " } } };
        await new Promise<void>((_resolve, reject) => {
          streamConfig.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true
          });
        });
      });
      const approvals = makeRichApprovalStore();
      const adapter = new DeepAgentsRuntimeAdapter(
        config,
        makeDynamicConfig(),
        fakeLog,
        { approvals: approvals as never, auditEvents: { create: async () => {} } as never },
        undefined,
        factory
      );
      const session = await adapter.createSession(sessionInput);

      const events: AGUIBaseEvent[] = [];
      const done = (async () => {
        for await (const event of adapter.runMessageAGUI(session, { prompt: "hi", toolContextId: null })) {
          events.push(event);
        }
      })();
      // Under fake timers the polling waitForAGUIEvent helper would deadlock, so
      // drive progress by flushing microtasks + timers directly.
      await vi.advanceTimersByTimeAsync(0);
      expect(events.some((e) => e.type === AGUIEventType.TEXT_MESSAGE_CONTENT)).toBe(true);

      // Hold a policy approval at the gateway (this pauses the watchdog).
      const policyDisposition = adapter.requestPolicyApproval({
        tenantId: sessionInput.tenantId,
        sessionId: sessionInput.sessionId,
        userId: sessionInput.userId,
        runtimeId: null,
        toolName: "execute",
        serverId: null,
        kind: "shell",
        explanation: "run a command"
      } as never);
      // Let the coordinator persist the row + push the approval_required event.
      await vi.advanceTimersByTimeAsync(0);
      const prompt = events.find(
        (e) => e.type === AGUIEventType.CUSTOM && (e as { name?: string }).name === "approval_required"
      ) as (AGUIBaseEvent & { value: { approvalId: string } }) | undefined;
      expect(prompt, "policy approval prompt should have been emitted").toBeDefined();

      // Advance WELL past the turn timeout while the approval is still pending.
      await vi.advanceTimersByTimeAsync(1_500);
      // The paused watchdog must NOT have fired: no RUN_ERROR, turn still active.
      expect(events.some((e) => e.type === AGUIEventType.RUN_ERROR)).toBe(false);
      expect(adapter.hasActiveTurn("sess-1")).toBe(true);

      // Resolve the approval → the coordinator settles and the watchdog re-arms.
      await adapter.resolveApproval({
        tenantId: sessionInput.tenantId,
        approvalId: prompt!.value.approvalId,
        userId: sessionInput.userId,
        decision: "approve"
      });
      expect(await policyDisposition).toBe("approve");

      // With the watchdog re-armed, the still-wedged stream now times out.
      await vi.advanceTimersByTimeAsync(1_100);
      const settled = await done;
      void settled;
      expect(events.at(-1)?.type).toBe(AGUIEventType.RUN_ERROR);
      expect(adapter.hasActiveTurn("sess-1")).toBe(false);
      await adapter.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

async function waitForAGUIEvent(
  events: AGUIBaseEvent[],
  predicate: (event: AGUIBaseEvent) => boolean,
  timeoutMs = 2_000
): Promise<AGUIBaseEvent> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const match = events.find(predicate);
    if (match) return match;
    if (Date.now() > deadline) throw new Error("timed out waiting for AG-UI event");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
