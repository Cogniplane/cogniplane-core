import { createSilentLogger } from "../../test-helpers/silent-logger.js";
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
import { SessionBusyError, type RuntimeReasoningEffort } from "../../runtime-contracts.js";
import {
  DeepAgentsRuntimeAdapter,
  USAGE_FLUSH_DEADLINE_MS
} from "./deep-agents-runtime-adapter.js";
import { isAGUIInterruptedFinish } from "./agui-events.js";
import type { ProviderCredentials } from "../runtime/provider-credentials.js";
import type { RuntimeSessionUpsertInput } from "../runtime/runtime-session-store.js";
import type {
  DeepAgentsGraph,
  DeepAgentsRuntimeFactory,
  DeepAgentsSessionRuntime
} from "./deep-agents-types.js";
import type { DynamicConfigService } from "../dynamic-config-service.js";
import type { RuntimeConfigBundle } from "../admin-config-records.js";
import { createPolicyApprovalProof } from "../policy/policy-approval-proof.js";
import type { PolicyApprovalProof } from "../policy/policy-approval-proof.js";

const testConfig = createTestConfig({ ANTHROPIC_API_KEY: "sk-ant-test-key" });

const sessionInput = {
  tenantId: "test-tenant",
  sessionId: "sess-1",
  userId: "user-1"
};

function makeDynamicConfig(
  policyOverrides: Partial<RuntimeConfigBundle["runtimePolicy"]> = {},
  bundleOverrides: {
    skills?: RuntimeConfigBundle["skills"];
    mcpServers?: RuntimeConfigBundle["mcpServers"];
  } = {}
) {
  return {
    async compileRuntimeConfig() {
      return {
        runtimePolicy: { ...testRuntimePolicy, ...policyOverrides },
        skills: bundleOverrides.skills ?? [],
        mcpServers: bundleOverrides.mcpServers ?? [],
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

const fakeLog = createSilentLogger();

it("refreshes a cached session before the next turn without disposing its workspace", async () => {
  const original = makeRuntimeFactory(() => scriptedChatStream());
  const refreshCapabilities = vi.fn(async () => {});
  const dynamicConfig = makeDynamicConfig();
  let bundle = await dynamicConfig.compileRuntimeConfig("tenant", false);
  dynamicConfig.compileRuntimeConfig = vi.fn(async () => bundle);
  const adapter = makeAdapter({ dynamicConfig, factory: (init) => ({ ...original.factory(init), refreshCapabilities }) });
  const first = await adapter.createSession(sessionInput);
  bundle = { ...bundle, hash: "narrowed", runtimePolicy: { ...bundle.runtimePolicy, enabledMcpServers: [] } };
  const next = await adapter.createSession(sessionInput);
  expect(next.runtimeId).toBe(first.runtimeId);
  expect(next.runtimePolicy.enabledMcpServers).toEqual([]);
  expect(refreshCapabilities).toHaveBeenCalledWith(expect.objectContaining({ skillsLibraryFiles: {}, mcpServers: [] }));
  expect(original.dispose).not.toHaveBeenCalled();
  expect(original.factoryCalls).toHaveLength(1);
  refreshCapabilities.mockRejectedValueOnce(new Error("refresh failed"));
  bundle = { ...bundle, hash: "new selection" };
  await expect(adapter.createSession(sessionInput)).rejects.toThrow("refresh failed");
  await adapter.createSession(sessionInput);
  expect(refreshCapabilities).toHaveBeenCalledTimes(3);
  await adapter.close();
});

it("applies the project approval mode at turn start and keeps it out of tenant settings", async () => {
  const setApprovalSettings = vi.fn();
  const base = makeRuntimeFactory(() => scriptedChatStream());
  const adapter = makeAdapter({
    factory: (init) => ({
      ...base.factory(init),
      setApprovalSettings
    })
  });
  const session = await adapter.createSession(sessionInput);
  await collect(adapter.runMessageAGUI(session, {
    ...runMessageInput(),
    projectApprovalMode: "manual"
  }));
  expect(setApprovalSettings).toHaveBeenCalledWith({
    gate: true,
    autoApproveReadOnly: false,
    readOnlyToolNames: []
  });
  await collect(adapter.runMessageAGUI(session, runMessageInput()));
  expect(setApprovalSettings).toHaveBeenLastCalledWith({
    gate: true,
    autoApproveReadOnly: true,
    readOnlyToolNames: []
  });
  await adapter.close();
});

it("applies automatic project approval only to the new turn", async () => {
  const setApprovalSettings = vi.fn();
  const base = makeRuntimeFactory(() => scriptedChatStream());
  const adapter = makeAdapter({
    factory: (init) => ({
      ...base.factory(init),
      setApprovalSettings
    })
  });
  const session = await adapter.createSession(sessionInput);

  await collect(adapter.runMessageAGUI(session, {
    ...runMessageInput(),
    projectApprovalMode: "automatic"
  }));
  expect(setApprovalSettings).toHaveBeenCalledWith({
    gate: true,
    autoApproveReadOnly: true,
    readOnlyToolNames: []
  });

  await collect(adapter.runMessageAGUI(session, runMessageInput()));
  expect(setApprovalSettings).toHaveBeenLastCalledWith({
    gate: true,
    autoApproveReadOnly: true,
    readOnlyToolNames: []
  });
  await adapter.close();
});

function emptyRuntimeCapabilities(): Pick<DeepAgentsSessionRuntime,
  "setApprovalSettings" | "refreshCapabilities" | "getPendingActions" | "buildResumeInput" | "getMcpToolNames" | "getMcpToolServers"> {
  return {
    setApprovalSettings() {},
    async refreshCapabilities() {},
    async getPendingActions() { return []; },
    buildResumeInput() { throw new Error("This fixture has no pending approvals"); },
    getMcpToolNames() { return new Set<string>(); },
    getMcpToolServers() { return new Map<string, string>(); }
  };
}


const fakeApprovalStore = {
  async create() {
    return {} as never;
  },
  async resolve() {
    return null;
  }
} as never;
const fakeAuditEventStore = { async create() {} } as never;
const fakeTenantMemberStore = { isUserBetaTester: async () => false };

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
      ...emptyRuntimeCapabilities(),
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

const fakeSessionAccess = {
  async getReadable(_tenantId: string, sessionId: string, userId: string) {
    return { sessionId, userId, sessionName: "Test", status: "active" as const, projectId: null,
      createdAt: "2026-01-01", updatedAt: "2026-01-01" };
  }
};
const unusedExecutions = {
  async isCurrent() { throw new Error("Unexpected project execution"); },
  async bindRuntime() { throw new Error("Unexpected project execution"); },
};

function makeAdapter(input: {
  factory: DeepAgentsRuntimeFactory;
  dynamicConfig?: DynamicConfigService;
  runtimeSessions?: unknown;
  memories?: unknown;
  checkpointer?: { deleteThread: (threadId: string) => Promise<void>; end?: () => Promise<void> };
  conversationMessages?: unknown;
  messages?: unknown;
  executions?: Pick<import("../session-execution-store.js").SessionExecutionStore, "isCurrent" | "bindRuntime">;
  sessions?: Pick<import("../session-store.js").SessionStore, "getReadable">;
  activationTracker?: Pick<import("../activation-tracker.js").ActivationTracker, "recordMaterialization">;
  tenantMembers?: { isUserBetaTester: (tenantId: string, userId: string) => Promise<boolean> };
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
      activationTracker: input.activationTracker,
      runtimeSessions: input.runtimeSessions as never,
      memories: input.memories as never,
      checkpointer: input.checkpointer,
      messages: input.messages as never,
      executions: input.executions ?? unusedExecutions,
      conversationMessages: input.conversationMessages as never,
      sessions: input.sessions ?? fakeSessionAccess,
      tenantMembers: (input.tenantMembers ?? fakeTenantMemberStore) as never
    },
    credentials,
    input.factory
  );
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function makeDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function runMessageInput(
  overrides: Partial<{ prompt: string; model: string; effort: RuntimeReasoningEffort }> = {}
) {
  return {
    prompt: overrides.prompt ?? "hello",
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
  policyApproval?: PolicyApprovalProof;
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
    ...emptyRuntimeCapabilities(),
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
    async get(_tenantId: string, approvalId: string, _userId: string) {
      return (rows.get(approvalId) ?? null) as never;
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
  const events: AGUIBaseEvent[] = [];
  const done = (async () => {
    for await (const event of adapter.runMessageAGUI(session, { ...runMessageInput(), ...input } as never)) {
      events.push(event);
    }
  })();
  return { events, done };
}

async function waitForEvent(
  events: AGUIBaseEvent[],
  predicate: (event: AGUIBaseEvent) => boolean,
  timeoutMs = 2_000
): Promise<AGUIBaseEvent> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const match = events.find(predicate);
    if (match) return match;
    if (Date.now() > deadline) throw new Error("timed out waiting for event");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("DeepAgentsRuntimeAdapter", () => {
  it("creates a session, persists the runtime_sessions row, and is idempotent", async () => {
    const upsert = vi.fn(async (_input: RuntimeSessionUpsertInput) => {});
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

  it("preserves MCP server mode in the runtime factory configuration", async () => {
    const { factory, factoryCalls } = makeRuntimeFactory(() => scriptedChatStream());
    const dynamicConfig = makeDynamicConfig(
      {},
      {
        mcpServers: [
          {
            id: "proxy_docs",
            description: "Proxy docs",
            mode: "proxy",
            routePath: "/mcp/proxy_docs",
            upstreamUrl: "https://docs.example/mcp",
            transportKind: "http",
            version: 1,
            hash: "proxy-docs-hash"
          }
        ]
      }
    );
    const adapter = makeAdapter({ factory, dynamicConfig });

    await adapter.createSession(sessionInput);

    expect(factoryCalls[0]?.mcpServers).toEqual([
      expect.objectContaining({ id: "proxy_docs", mode: "proxy" })
    ]);
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

  it.each([
    { phase: "creation", identity: { userId: "other-user" } },
    { phase: "creation", identity: { tenantId: "other-tenant" } },
    { phase: "refresh", identity: { userId: "other-user" } },
    { phase: "refresh", identity: { tenantId: "other-tenant" } }
  ])("rejects another identity during pending $phase: $identity", async ({ phase, identity }) => {
    const { factory, factoryCalls } = makeRuntimeFactory(() => scriptedChatStream());
    const dynamicConfig = makeDynamicConfig();
    const bundle = await dynamicConfig.compileRuntimeConfig("tenant", false);
    const adapter = makeAdapter({ factory, dynamicConfig });
    if (phase === "refresh") await adapter.createSession(sessionInput);

    const started = makeDeferred();
    const release = makeDeferred();
    const compile = vi.fn(async () => {
      started.resolve();
      await release.promise;
      return bundle;
    });
    dynamicConfig.compileRuntimeConfig = compile;
    const owner = adapter.createSession(sessionInput);
    await started.promise;
    const sameOwner = adapter.createSession(sessionInput);
    try {
      const otherIdentity = adapter.createSession({ ...sessionInput, ...identity });
      release.resolve();
      await expect(otherIdentity).rejects.toMatchObject({
        message: "Session ownership mismatch", statusCode: 403
      });
      expect(compile).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await Promise.allSettled([owner, sameOwner]);
      await adapter.close();
    }
    expect(await sameOwner).toEqual(await owner);
    expect(factoryCalls).toHaveLength(1);
  });

  it.each([{ userId: "other-user" }, { tenantId: "other-tenant" }])(
    "rejects a cached runtime identity mismatch as forbidden: %j", async (identity) => {
      const { factory, factoryCalls } = makeRuntimeFactory(() => scriptedChatStream());
      const adapter = makeAdapter({ factory });
      try {
        const original = await adapter.createSession(sessionInput);
        await expect(adapter.createSession({ ...sessionInput, ...identity })).rejects.toMatchObject({
          message: "Session ownership mismatch", statusCode: 403
        });
        expect(await adapter.createSession(sessionInput)).toEqual(original);
        expect(factoryCalls).toHaveLength(1);
      } finally {
        await adapter.close();
      }
    }
  );

  it("allows creation retry after a failed shared build", async () => {
    const { factory, factoryCalls } = makeRuntimeFactory(() => scriptedChatStream());
    const dynamicConfig = makeDynamicConfig();
    const bundle = await dynamicConfig.compileRuntimeConfig("tenant", false);
    const compile = vi.fn()
      .mockRejectedValueOnce(new Error("compile failed"))
      .mockResolvedValue(bundle);
    dynamicConfig.compileRuntimeConfig = compile;
    const adapter = makeAdapter({ factory, dynamicConfig });
    try {
      const results = await Promise.allSettled([
        adapter.createSession(sessionInput), adapter.createSession(sessionInput)
      ]);
      expect(results).toEqual([
        { status: "rejected", reason: new Error("compile failed") },
        { status: "rejected", reason: new Error("compile failed") }
      ]);
      const retry = await adapter.createSession(sessionInput);
      expect(retry.runtimeId).toMatch(/^deepagents-/);
      expect(compile).toHaveBeenCalledTimes(2);
      expect(factoryCalls).toHaveLength(1);
    } finally {
      await adapter.close();
    }
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

    const busyTurn = collect(adapter.runMessageAGUI(busySession, runMessageInput()));
    // Give the turn a tick to reserve the slot.
    await new Promise((resolve) => setImmediate(resolve));
    expect(adapter.hasActiveTurn("sess-1")).toBe(true);
    await expect(adapter.createSession(sessionInput)).rejects.toThrow(SessionBusyError);

    // The admin "idle" rollout path: the mid-turn session must survive.
    const invalidated = await adapter.invalidateTenantRuntimes("test-tenant", { idleOnly: true });
    expect(invalidated).toEqual(["sess-idle"]);
    expect(adapter.hasSession("sess-1")).toBe(true);
    expect(adapter.hasSession("sess-idle")).toBe(false);

    release();
    const events = await busyTurn;
    expect(events.at(-1)).toMatchObject({ type: AGUIEventType.RUN_FINISHED });
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

  it("loads the complete transcript for a long project session", async () => {
    const runtime = makeRuntimeFactory(() => scriptedChatStream());
    const messages = Array.from({ length: 601 }, (_, index) => ({
      messageId: `message-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `turn-${index}`
    }));
    let requestedOptions: unknown;
    const executions = {
      isCurrent: vi.fn(async () => true),
      bindRuntime: vi.fn(async () => {})
    };
    const adapter = makeAdapter({
      factory: runtime.factory,
      executions,
      sessions: {
        getReadable: async (...args) => ({
          ...await fakeSessionAccess.getReadable(...args),
          projectId: "project-1"
        })
      },
      conversationMessages: {
        async listBySession(_tenantId: string, _sessionId: string, _userId: string, options: unknown) {
          requestedOptions = options;
          return { messages, hasMore: true };
        }
      }
    });
    const execution = {
      ...sessionInput,
      executionId: "execution-1",
      projectId: "project-1",
      expiresAt: new Date(Date.now() + 30_000).toISOString()
    };

    try {
      const session = await adapter.createSession({ ...sessionInput, execution });
      await collectAGUI(adapter.runMessageAGUI(session, runMessageInput()));

      expect(requestedOptions).toEqual({ limit: null });
      const input = runtime.streamInputs[0] as { messages: Array<{ content: string }> };
      expect(input.messages[0]?.content).toBe("turn-0");
      expect(input.messages.at(-1)?.content).toBe("hello");
      expect(input.messages).toHaveLength(601);
    } finally {
      await adapter.close();
    }
  });

  it.each(["creation", "refresh"])("admits a turn immediately after awaiting %s", async (phase) => {
    const runtime = makeRuntimeFactory(() => scriptedChatStream());
    const adapter = makeAdapter({ factory: runtime.factory });
    try {
      if (phase === "refresh") await adapter.createSession(sessionInput);
      // No intervening await between createSession and the generator's first next().
      const events = await collectAGUI(adapter.runMessageAGUI(await adapter.createSession(sessionInput), {
        prompt: "immediate", toolContextId: null
      }));
      expect(events.at(-1)?.type).toBe(AGUIEventType.RUN_FINISHED);
      expect(runtime.streamConfigs).toHaveLength(1);
      expect(adapter.hasActiveTurn(sessionInput.sessionId)).toBe(false);
    } finally {
      await adapter.close();
    }
  });

  it("rejects a retired reference before touching its replacement runtime", async () => {
    const runtime = makeRuntimeFactory(() => scriptedChatStream());
    const extendSandboxTimeout = vi.fn(async () => {});
    const adapter = makeAdapter({ factory: (init) => ({ ...runtime.factory(init), extendSandboxTimeout }) });
    const retired = await adapter.createSession(sessionInput);
    await adapter.abortSession(sessionInput);
    const current = await adapter.createSession({ ...sessionInput, userId: "user-2" });
    const onBeforeTurn = vi.fn(async () => {});
    try {
      expect(current.runtimeId).not.toBe(retired.runtimeId);
      await expect(collectAGUI(adapter.runMessageAGUI(retired, {
        prompt: "stale", toolContextId: "old-context", onBeforeTurn
      }))).rejects.toMatchObject({ statusCode: 409 });
      expect(extendSandboxTimeout).not.toHaveBeenCalled();
      expect(onBeforeTurn).not.toHaveBeenCalled();
      expect(runtime.modelRequests).toEqual([]);
      expect(runtime.streamConfigs).toEqual([]);
      expect(runtime.factoryCalls[1]!.toolContextRef?.current).toBeNull();
      expect(adapter.hasActiveTurn(sessionInput.sessionId)).toBe(false);
      const events = await collectAGUI(adapter.runMessageAGUI(current, {
        prompt: "current", toolContextId: "new-context"
      }));
      expect(events.at(-1)?.type).toBe(AGUIEventType.RUN_FINISHED);
    } finally {
      await adapter.close();
    }
  });

  it("rejects an aborted runtime while disposal is still pending", async () => {
    const runtime = makeRuntimeFactory(() => scriptedChatStream());
    const release = makeDeferred();
    const adapter = makeAdapter({ factory: (init) => ({ ...runtime.factory(init), dispose: () => release.promise }) });
    const session = await adapter.createSession(sessionInput);
    const disposal = adapter.abortSession(sessionInput);
    const onBeforeTurn = vi.fn(async () => {});
    try {
      await expect(collectAGUI(adapter.runMessageAGUI(session, {
        prompt: "late", toolContextId: null, onBeforeTurn
      }))).rejects.toMatchObject({ statusCode: 409 });
      expect(onBeforeTurn).not.toHaveBeenCalled();
      expect(runtime.modelRequests).toEqual([]);
      expect(adapter.hasActiveTurn(sessionInput.sessionId)).toBe(false);
    } finally {
      release.resolve();
      await disposal;
      await adapter.close();
    }
  });

  it("reserves admission during warm refresh and allows a turn after refresh", async () => {
    const runtime = makeRuntimeFactory(() => scriptedChatStream());
    const dynamicConfig = makeDynamicConfig();
    const adapter = makeAdapter({ factory: runtime.factory, dynamicConfig });
    const session = await adapter.createSession(sessionInput);
    const bundle = await dynamicConfig.compileRuntimeConfig("tenant", false);
    const started = makeDeferred();
    const release = makeDeferred();
    dynamicConfig.compileRuntimeConfig = vi.fn(async () => {
      started.resolve();
      await release.promise;
      return { ...bundle, hash: "refreshed" };
    });
    const refresh = adapter.createSession(sessionInput);
    await started.promise;
    const onBeforeTurn = vi.fn(async () => {});
    try {
      await expect(collectAGUI(adapter.runMessageAGUI(session, {
        prompt: "early", toolContextId: null, onBeforeTurn
      }))).rejects.toBeInstanceOf(SessionBusyError);
      expect(onBeforeTurn).not.toHaveBeenCalled();
      expect(runtime.modelRequests).toEqual([]);
      expect(adapter.hasActiveTurn(sessionInput.sessionId)).toBe(false);
      release.resolve();
      const refreshed = await refresh;
      const events = await collectAGUI(adapter.runMessageAGUI(refreshed, {
        prompt: "ready", toolContextId: null
      }));
      expect(events.at(-1)?.type).toBe(AGUIEventType.RUN_FINISHED);
    } finally {
      release.resolve();
      await refresh;
      await adapter.close();
    }
  });

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

  it("keeps RUN_STARTED first when a workspace-reset notice is raised during onBeforeTurn", async () => {
    // @ag-ui/client's verifier rejects any stream whose first event is not
    // RUN_STARTED ("First event must be 'RUN_STARTED'" — @ag-ui/client@0.0.59),
    // and the frontend runs that verifier. A notice raised before the agent run
    // begins must therefore be held and flushed AFTER RUN_STARTED, not pushed
    // onto the queue as it arrives.
    let notify: ((info: { previousSandboxId: string | null }) => void) | undefined;
    const { factory: baseFactory } = makeRuntimeFactory(() => scriptedChatStream());
    const factory: DeepAgentsRuntimeFactory = (init) => {
      notify = (init as { onSandboxRecreated?: (i: { previousSandboxId: string | null }) => void })
        .onSandboxRecreated;
      return baseFactory(init);
    };
    const adapter = makeAdapter({ factory });
    const session = await adapter.createSession(sessionInput);

    const events = await collectAGUI(
      adapter.runMessageAGUI(session, {
        prompt: "hello",
        toolContextId: "ctx-1",
        onBeforeTurn: async () => {
          notify?.({ previousSandboxId: "sbx-during-sync" });
        }
      })
    );

    const types = events.map((e) => e.type);
    expect(types[0]).toBe(AGUIEventType.RUN_STARTED);
    expect(types.at(-1)).toBe(AGUIEventType.RUN_FINISHED);
    // The notice still reaches the client — held, not dropped.
    expect(types).toContain(AGUIEventType.CUSTOM);
    await adapter.close();
  });

  it("does not corrupt the stream when the run fails before emitting its first event", async () => {
    // A run that errors during startup never reaches the flush, so pre-run
    // notices are undeliverable — emitting one ahead of the terminal RUN_ERROR
    // would break the same RUN_STARTED-first rule the buffering exists to
    // satisfy. The stream must stay legal; the notice is logged, not emitted.
    let notify: ((info: { previousSandboxId: string | null }) => void) | undefined;
    const factory: DeepAgentsRuntimeFactory = (init) => {
      notify = (init as { onSandboxRecreated?: (i: { previousSandboxId: string | null }) => void })
        .onSandboxRecreated;
      return {
        ...emptyRuntimeCapabilities(),
      async getAgentForModel() {
          return {
            // eslint-disable-next-line require-yield
            async *streamEvents() {
              throw new Error("model provider exploded");
            }
          };
        },
        dispose: async () => {}
      };
    };
    const adapter = makeAdapter({ factory });
    const session = await adapter.createSession(sessionInput);

    const events = await collectAGUI(
      adapter.runMessageAGUI(session, {
        prompt: "hello",
        toolContextId: "ctx-1",
        onBeforeTurn: async () => {
          notify?.({ previousSandboxId: "sbx-lost" });
        }
      })
    );

    const types = events.map((e) => e.type);
    // Legal lead event either way — never a CUSTOM notice.
    expect([AGUIEventType.RUN_STARTED, AGUIEventType.RUN_ERROR]).toContain(types[0]);
    expect(types[0]).not.toBe(AGUIEventType.CUSTOM);
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
      {
        sessions: fakeSessionAccess,
        executions: unusedExecutions,
        approvals: approvals as never,
        auditEvents: { create: async () => {} } as never,
        tenantMembers: fakeTenantMemberStore
      },
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

  it("resumes a checkpointed Policy Center interrupt from its durable approved row", async () => {
    const proof = createPolicyApprovalProof({
      tenantId: sessionInput.tenantId,
      sessionId: sessionInput.sessionId,
      toolContextId: "ctx-1",
      toolCallId: "call-1",
      toolName: "github_write_file",
      serverId: "managed",
      args: { path: "README.md" },
      ruleId: "rule-1",
      explanation: "Review this write."
    });
    const { factory, resumes } = makeInterruptingFactory({
      rounds: [[{
        interruptId: "int-1",
        name: "github_write_file",
        args: { path: "README.md" },
        policyApproval: proof
      }], []],
      mcpToolNames: ["github_write_file"]
    });
    const approvals = makeRichApprovalStore();
    approvals.rows.set(proof.approvalId, {
      approvalId: proof.approvalId,
      tenantId: sessionInput.tenantId,
      sessionId: sessionInput.sessionId,
      userId: sessionInput.userId,
      runtimeId: "prior-runtime",
      itemId: proof.approvalId,
      kind: "mcp_tool",
      status: "approved",
      decision: "approve",
      requestPayload: { policyApproval: proof }
    });
    const adapter = new DeepAgentsRuntimeAdapter(
      testConfig,
      makeDynamicConfig(),
      fakeLog,
      {
        sessions: fakeSessionAccess,
        executions: unusedExecutions,
        approvals: approvals as never,
        auditEvents: { create: async () => {} } as never,
        tenantMembers: fakeTenantMemberStore
      },
      undefined,
      factory
    );
    const session = await adapter.createSession(sessionInput);

    const events = await collectAGUI(
      adapter.runMessageAGUI(session, { prompt: "resume", toolContextId: "ctx-1" })
    );

    expect(resumes).toEqual([[{ type: "approve" }]]);
    expect(
      events.some(
        (event) =>
          event.type === AGUIEventType.CUSTOM &&
          (event as { name?: string }).name === "approval_required"
      )
    ).toBe(false);
    await adapter.close();
  });

  it("translates an intentional Stop into a graceful RUN_FINISHED, not RUN_ERROR", async () => {
    // A stream that emits one chunk then hangs until the turn signal aborts —
    // lets us interrupt mid-turn the way the Stop button / a disconnect would.
    const factory: DeepAgentsRuntimeFactory = () =>
      ({
        ...emptyRuntimeCapabilities(),
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
      });
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

  it("interrupts a turn when teardown starts during sandbox extension", async () => {
    const release = makeDeferred();
    let disposal: Promise<void> | undefined;
    const factory: DeepAgentsRuntimeFactory = () =>
      ({
        ...emptyRuntimeCapabilities(),
        async extendSandboxTimeout() {
          disposal = adapter.abortSession(sessionInput);
        },
        async getAgentForModel() {
          return {
            async *streamEvents(_input: unknown, config: { signal?: AbortSignal }) {
              // A real LangGraph stream rejects immediately on a pre-aborted
              // signal. If the guard is missing, turnAbort is NOT aborted here
              // and this yields normally — which is exactly the regression.
              if (config.signal?.aborted) {
                throw new DOMException("Aborted", "AbortError");
              }
              yield {
                event: "on_chat_model_stream",
                metadata: {},
                data: { chunk: { content: "should never stream" } }
              };
            }
          };
        },
        // Hang inside dispose so the session stays registered while its
        // abortController is already aborted — the real race window.
        dispose: async () => {
          await release.promise;
        }
      }) as unknown as DeepAgentsSessionRuntime;

    const adapter = makeAdapter({ factory });
    const session = await adapter.createSession(sessionInput);

    const events = await collectAGUI(
      adapter.runMessageAGUI(session, { prompt: "hi", toolContextId: null })
    );

    // Terminates as an intentional stop, and never streamed model output.
    const terminal = events.at(-1) as AGUIBaseEvent;
    expect(terminal.type).toBe(AGUIEventType.RUN_FINISHED);
    expect(isAGUIInterruptedFinish(terminal)).toBe(true);
    expect(events.map((e) => e.type)).not.toContain(AGUIEventType.TEXT_MESSAGE_CONTENT);
    // The slot must be released, or every later POST /messages 429s.
    expect(adapter.hasActiveTurn(sessionInput.sessionId)).toBe(false);
    release.resolve();
    await disposal;
    await adapter.close();
  });

  it("fails a wedged AG-UI turn on the watchdog and releases the session slot", async () => {
    // An upstream that stalls without erroring
    // (and never disconnects the client) must not pin activeTurns forever —
    // otherwise every subsequent POST /messages 429s until process restart.
    vi.useFakeTimers();
    try {
      const config = createTestConfig({
        ANTHROPIC_API_KEY: "sk-ant-test-key",
        RUNTIME_TURN_TIMEOUT_MS: 1000
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

describe("turn watchdog budget across approval pauses", () => {
  it("consumes the watchdog budget rather than refunding it on every resume", async () => {
    // The watchdog is paused while a human decides an approval, so it measures
    // WORKING time, not wall clock. But re-arming for the full duration after
    // each pause refunded the budget, letting a turn accumulate unbounded
    // working time across repeated approval rounds — exactly what the config
    // invariant TOOL_CONTEXT_TTL_MS > RUNTIME_TURN_TIMEOUT_MS +
    // APPROVAL_REQUEST_TTL_MS assumes cannot happen. Total working time must
    // stay capped at RUNTIME_TURN_TIMEOUT_MS however many pauses occur.
    vi.useFakeTimers();
    try {
      const config = createTestConfig({
        ANTHROPIC_API_KEY: "sk-ant-test-key",
        RUNTIME_TURN_TIMEOUT_MS: 1000
      });
      const adapter = makeAdapter({ factory: (() => ({
        ...emptyRuntimeCapabilities(),
      async getAgentForModel() {
          return { async *streamEvents() {} };
        },
        dispose: async () => {}
      })) as DeepAgentsRuntimeFactory, config });

      const turnAbort = new AbortController();
      const { arm, disarm, timedOut } = (
        adapter as unknown as {
          createTurnWatchdog: (
            a: AbortController
          ) => { arm: () => void; disarm: () => void; timedOut: () => boolean };
        }
      ).createTurnWatchdog(turnAbort);

      arm();
      // 600ms of working time — over half the 1000ms budget.
      await vi.advanceTimersByTimeAsync(600);
      expect(timedOut()).toBe(false);

      // Three approval rounds. Paused time must not count, and must not refund.
      for (let i = 0; i < 3; i += 1) {
        disarm();
        await vi.advanceTimersByTimeAsync(10_000);
        arm();
      }
      // Still alive: 10s x3 of PAUSED time is correctly not charged.
      expect(timedOut()).toBe(false);

      // Only ~400ms of budget can remain. Under the refunding bug each resume
      // restored a full 1000ms and 500ms more work would have been fine.
      await vi.advanceTimersByTimeAsync(500);
      expect(timedOut()).toBe(true);
      expect(turnAbort.signal.aborted).toBe(true);
      disarm();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not charge paused time, so an approval alone never times a turn out", async () => {
    vi.useFakeTimers();
    try {
      const config = createTestConfig({
        ANTHROPIC_API_KEY: "sk-ant-test-key",
        RUNTIME_TURN_TIMEOUT_MS: 1000
      });
      const adapter = makeAdapter({ factory: (() => ({
        ...emptyRuntimeCapabilities(),
      async getAgentForModel() {
          return { async *streamEvents() {} };
        },
        dispose: async () => {}
      })) as DeepAgentsRuntimeFactory, config });

      const turnAbort = new AbortController();
      const { arm, disarm, timedOut } = (
        adapter as unknown as {
          createTurnWatchdog: (
            a: AbortController
          ) => { arm: () => void; disarm: () => void; timedOut: () => boolean };
        }
      ).createTurnWatchdog(turnAbort);

      arm();
      disarm();
      // A human takes far longer than the whole turn budget to decide.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(timedOut()).toBe(false);
      arm();
      // The full budget is still there — no working time was spent.
      await vi.advanceTimersByTimeAsync(900);
      expect(timedOut()).toBe(false);
      disarm();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("sandbox lifetime and workspace-loss notice", () => {
  function makeSandboxFactory(input: {
    extendSandboxTimeout?: () => Promise<void>;
    onFactoryInit?: (init: { onSandboxRecreated?: (info: { previousSandboxId: string | null }) => void }) => void;
  }) {
    const factory: DeepAgentsRuntimeFactory = (init) => {
      input.onFactoryInit?.(init as never);
      return {
        ...emptyRuntimeCapabilities(),
      async getAgentForModel() {
          return {
            async *streamEvents() {
              yield {
                event: "on_chat_model_stream",
                metadata: {},
                data: { chunk: { content: "hi" } }
              };
            }
          };
        },
        ...(input.extendSandboxTimeout
          ? { extendSandboxTimeout: input.extendSandboxTimeout }
          : {}),
        dispose: async () => {}
      };
    };
    return factory;
  }

  it("extends the sandbox lifetime at the start of every turn", async () => {
    // R12: the E2B cap runs from the session's first tool use and is never
    // renewed, so an active session eventually crosses it mid-turn and loses
    // every file the agent wrote plus every synced artifact. Extending at each
    // turn start makes the cap idle-based.
    const extendSandboxTimeout = vi.fn(async () => {});
    const adapter = makeAdapter({ factory: makeSandboxFactory({ extendSandboxTimeout }) });
    const session = await adapter.createSession(sessionInput);

    await collect(adapter.runMessageAGUI(session, runMessageInput()));
    expect(extendSandboxTimeout).toHaveBeenCalledTimes(1);

    await collect(adapter.runMessageAGUI(session, runMessageInput()));
    expect(extendSandboxTimeout).toHaveBeenCalledTimes(2);
  });

  it("does not leak the turn slot when the sandbox extension rejects", async () => {
    // The slot is already reserved when the extension runs, so an unguarded
    // rejection would pin the session busy (429 on every later message) for
    // the life of the process. A failed extension must cost nothing.
    const adapter = makeAdapter({
      factory: makeSandboxFactory({
        extendSandboxTimeout: async () => {
          throw new Error("sandbox unreachable");
        }
      })
    });
    const session = await adapter.createSession(sessionInput);

    const first = await collect(adapter.runMessageAGUI(session, runMessageInput()));
    expect(first.at(-1)).toMatchObject({ type: AGUIEventType.RUN_FINISHED });

    // The session must still accept the next turn.
    expect(adapter.hasActiveTurn(session.sessionId)).toBe(false);
    const second = await collect(adapter.runMessageAGUI(session, runMessageInput()));
    expect(second.at(-1)).toMatchObject({ type: AGUIEventType.RUN_FINISHED });
  });

  it("runs a turn normally when the runtime exposes no sandbox extension", async () => {
    // State-only runtimes (allowCommandExecution=false, unit-test fakes) have
    // no sandbox — the optional call must not break their turns.
    const adapter = makeAdapter({ factory: makeSandboxFactory({}) });
    const session = await adapter.createSession(sessionInput);

    const events = await collect(adapter.runMessageAGUI(session, runMessageInput()));
    expect(events.at(-1)).toMatchObject({ type: AGUIEventType.RUN_FINISHED });
  });

  it("drops the workspace-reset notice when no turn is running", async () => {
    let notify: ((info: { previousSandboxId: string | null }) => void) | undefined;
    const adapter = makeAdapter({
      factory: makeSandboxFactory({
        onFactoryInit: (init) => {
          notify = init.onSandboxRecreated;
        }
      })
    });
    await adapter.createSession(sessionInput);

    // Between turns there is no response to attach to — must not throw.
    expect(() => notify?.({ previousSandboxId: "sbx-old" })).not.toThrow();
  });
});

// ── Review batch 3 (bead tnci): turn-loop robustness ─────────────────────────
// Five defects that shared one signature: the user, or the audit trail, is told
// nothing while something goes wrong.

describe("interrupting a turn while onBeforeTurn is still running (R9)", () => {
  it("aborts an AG-UI turn interrupted during artifact sync", async () => {
    const syncStarted = makeDeferred();
    const syncBlocked = makeDeferred();

    let streamed = false;
    // An aborted turn must not even resolve a graph: getAgentForModel builds the
    // model and resolves the provider key. The backend's own
    // `signal.throwIfAborted()` is what keeps this at zero — without it the
    // stream's abort check still stops the run, but only after the build.
    let graphResolutions = 0;
    const factory: DeepAgentsRuntimeFactory = () =>
      ({
        ...emptyRuntimeCapabilities(),
      async getAgentForModel() {
          graphResolutions += 1;
          return {
            async *streamEvents(_input: unknown, config: { signal?: AbortSignal }) {
              if (config.signal?.aborted) throw new DOMException("Aborted", "AbortError");
              streamed = true;
              yield {
                event: "on_chat_model_stream",
                metadata: {},
                data: { chunk: { content: "should never stream" } }
              };
            }
          };
        },
        dispose: async () => {}
      });

    const adapter = makeAdapter({ factory });
    const session = await adapter.createSession(sessionInput);

    const events: AGUIBaseEvent[] = [];
    const done = (async () => {
      for await (const event of adapter.runMessageAGUI(session, {
        prompt: "hi",
        toolContextId: null,
        onBeforeTurn: async () => {
          syncStarted.resolve();
          await syncBlocked.promise;
        }
      })) {
        events.push(event);
      }
    })();

    await syncStarted.promise;
    expect(await adapter.interruptTurn(sessionInput)).toBe("interrupted");
    syncBlocked.resolve();
    await done;

    expect(streamed).toBe(false);
    expect(graphResolutions).toBe(0);
    // Still a well-formed AG-UI stream: RUN_STARTED leads, and the abort ends it
    // as an intentional stop rather than an error.
    expect(events[0]?.type).toBe(AGUIEventType.RUN_STARTED);
    const terminal = events.at(-1) as AGUIBaseEvent;
    expect(terminal.type).toBe(AGUIEventType.RUN_FINISHED);
    expect(isAGUIInterruptedFinish(terminal)).toBe(true);
    expect(adapter.hasActiveTurn(sessionInput.sessionId)).toBe(false);
    await adapter.close();
  });

});

describe("approval bookkeeping failures (R10, R56)", () => {
  it("denies a gated tool when the approval row cannot be written", async () => {
    // Without the row there is nothing to decide: no sweep can recover it, no
    // restart can see it, and no approval.approved audit event can ever be
    // written. Honouring an in-memory decision would run the tool with no
    // record that anyone allowed it — so fail closed, and say why.
    const { factory, resumes } = makeInterruptingFactory({
      rounds: [[{ interruptId: "int-1", name: "execute", args: { command: "rm -rf build" } }], []]
    });
    const adapter = new DeepAgentsRuntimeAdapter(
      testConfig,
      makeDynamicConfig(),
      fakeLog,
      {
        sessions: fakeSessionAccess,
        executions: unusedExecutions,
        approvals: {
          async create() {
            throw new Error("approvals table unavailable");
          },
          async resolve() {
            return null;
          }
        } as never,
        auditEvents: fakeAuditEventStore,
        tenantMembers: fakeTenantMemberStore
      },
      undefined,
      factory
    );
    const session = await adapter.createSession(sessionInput);
    const events = await collect(adapter.runMessageAGUI(session, runMessageInput() as never));

    // No prompt was shown — there was no approval to answer.
    expect(
      events.some(
        (event) => event.type === AGUIEventType.CUSTOM && event.name === "approval_required"
      )
    ).toBe(false);
    // The user is told rather than left with a silently-skipped tool.
    expect(
      events.find(
        (event) => event.type === AGUIEventType.CUSTOM && event.name === "runtime_notice"
      )
    ).toMatchObject({
      value: expect.objectContaining({ level: "warning", title: "Approval unavailable" })
    });
    // And the graph resumed with a reject, not an approve — carrying a reason
    // that is TRUE. The reject message becomes the model's tool result, and
    // "User denied permission" for an approval nobody ever saw makes the model
    // apologise for a refusal that did not happen and reason about a preference
    // the user never expressed.
    expect(resumes).toEqual([
      [
        {
          type: "reject",
          message: "This action was blocked: its approval request could not be recorded."
        }
      ]
    ]);
    await adapter.close();
  });

  it("reports a decision resolved even when the approval row write throws", async () => {
    // `entry.settle` has already handed the decision to the turn loop in-process,
    // so the tool has run (or been denied) and the graph resumed. Letting the
    // store's error escape would 500 the decision route, and the client's retry
    // would 404 — for an action that already happened.
    const { factory } = makeInterruptingFactory({
      rounds: [[{ interruptId: "int-1", name: "execute", args: { command: "ls" } }], []]
    });
    const adapter = new DeepAgentsRuntimeAdapter(
      testConfig,
      makeDynamicConfig(),
      fakeLog,
      {
        sessions: fakeSessionAccess,
        executions: unusedExecutions,
        approvals: {
          async create() {
            return {} as never;
          },
          async resolve() {
            throw new Error("connection terminated");
          }
        } as never,
        auditEvents: fakeAuditEventStore,
        tenantMembers: fakeTenantMemberStore
      },
      undefined,
      factory
    );
    const session = await adapter.createSession(sessionInput);
    const { events, done } = startTurn(adapter, session);

    const approvalEvent = (await waitForEvent(
      events,
      (event) => event.type === AGUIEventType.CUSTOM && event.name === "approval_required"
    )) as AGUIBaseEvent & { value: { approvalId: string } };

    await expect(
      adapter.resolveApproval({
        tenantId: sessionInput.tenantId,
        userId: sessionInput.userId,
        approvalId: approvalEvent.value.approvalId,
        decision: "approve"
      })
    ).resolves.toBe("resolved");

    await done;
    expect(events.at(-1)).toMatchObject({ type: AGUIEventType.RUN_FINISHED });
    await adapter.close();
  });
});

describe("token usage reaches the row before the terminal event (R50)", () => {
  function makeUsageFactory() {
    const factory: DeepAgentsRuntimeFactory = () =>
      ({
        ...emptyRuntimeCapabilities(),
      async getAgentForModel() {
          return {
            async *streamEvents() {
              yield {
                event: "on_chat_model_stream",
                metadata: {},
                data: { chunk: { content: "hi" } }
              };
              yield {
                event: "on_chat_model_end",
                metadata: {},
                data: {
                  output: {
                    usage_metadata: {
                      input_tokens: 10,
                      output_tokens: 5,
                      total_tokens: 15
                    }
                  }
                }
              };
            }
          };
        },
        dispose: async () => {}
      }) as unknown as DeepAgentsSessionRuntime;
    return factory;
  }

  /**
   * MessageStore fake that records WHEN usage landed relative to the stream.
   * The write takes a real tick, as a DB round-trip does: without that, an
   * unawaited write started after the terminal event still resolves in the same
   * microtask drain and the ordering looks fine when it is not.
   */
  function makeUsageRecorder(marks: string[]) {
    return {
      async addTokenUsage() {
        await new Promise((resolve) => setTimeout(resolve, 10));
        marks.push("usage");
        return { inputTokens: 10, outputTokens: 5, totalTokens: 15 } as never;
      },
      async setCostUsd() {
        marks.push("cost");
      }
    };
  }

  it("persists usage before RUN_FINISHED on the AG-UI wire", async () => {
    const marks: string[] = [];
    const adapter = makeAdapter({
      factory: makeUsageFactory(),
      messages: makeUsageRecorder(marks)
    });
    const session = await adapter.createSession(sessionInput);

    for await (const event of adapter.runMessageAGUI(session, {
      prompt: "hi",
      toolContextId: null
    })) {
      if (event.type === AGUIEventType.RUN_FINISHED) marks.push("finished");
    }

    expect(marks.indexOf("usage")).toBeGreaterThanOrEqual(0);
    expect(marks.indexOf("usage")).toBeLessThan(marks.indexOf("finished"));
    await adapter.close();
  });

  it("does not let a stalled usage write hold the terminal event or the slot", async () => {
    // Ordering the flush before the terminal event must not make the terminal
    // event DEPEND on the database. The write has no cancellation of its own and
    // the turn watchdog can only abort the graph, so an unbounded wait would pin
    // `activeTurns` — and every later POST /messages would 429 — for as long as
    // the pool took to answer. Past USAGE_FLUSH_DEADLINE_MS the turn ends and the
    // write finishes on its own.
    const stalled = makeDeferred();
    const adapter = makeAdapter({
      factory: makeUsageFactory(),
      messages: {
        async addTokenUsage() {
          await stalled.promise;
          return { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
        },
        async setCostUsd() {}
      }
    });
    const session = await adapter.createSession(sessionInput);

    vi.useFakeTimers();
    try {
      const events: AGUIBaseEvent[] = [];
      const collected = (async () => {
        for await (const event of adapter.runMessageAGUI(session, runMessageInput())) {
          events.push(event);
        }
      })();
      // Well past USAGE_FLUSH_DEADLINE_MS, and the write is still stalled.
      // Advanced in several passes: the turn's tail is a chain of awaits behind
      // the deadline timer, and one advance only drains the microtasks queued at
      // the moment it fires.
      for (let i = 0; i < 5; i += 1) {
        await vi.advanceTimersByTimeAsync(USAGE_FLUSH_DEADLINE_MS);
      }
      await collected;

      expect(events.at(-1)).toMatchObject({ type: AGUIEventType.RUN_FINISHED });
      expect(adapter.hasActiveTurn(sessionInput.sessionId)).toBe(false);
      stalled.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await adapter.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes resolved isBetaTester to compileRuntimeConfig during session creation", async () => {
    let capturedIsBetaTester: boolean | null = null;
    const dynamicConfig = {
      async compileRuntimeConfig(_tenantId: string, isBetaTester: boolean, _sessionId?: string) {
        capturedIsBetaTester = isBetaTester;
        return {
          runtimePolicy: testRuntimePolicy,
          skills: [],
          mcpServers: [],
          hash: "hash",
          sources: { runtimePolicy: { id: "test", version: 1, hash: "h" }, skills: [], mcpServers: [] }
        };
      }
    } as unknown as DynamicConfigService;

    const tenantMembers = {
      isUserBetaTester: async (tenantId: string, userId: string) => {
        return tenantId === "beta-tenant" && userId === "beta-user";
      }
    };

    const { factory } = makeRuntimeFactory(() => scriptedChatStream());
    const adapter = makeAdapter({
      factory,
      dynamicConfig,
      tenantMembers
    });

    await adapter.createSession({
      tenantId: "beta-tenant",
      sessionId: "beta-sess",
      userId: "beta-user"
    });
    expect(capturedIsBetaTester).toBe(true);

    await adapter.createSession({
      tenantId: "regular-tenant",
      sessionId: "regular-sess",
      userId: "regular-user"
    });
    expect(capturedIsBetaTester).toBe(false);

    await adapter.close();
  });

  it("aborts session creation when tenant-member lookup fails", async () => {
    const tenantMembers = {
      isUserBetaTester: async () => {
        throw new Error("database connection timeout");
      }
    };
    const { factory } = makeRuntimeFactory(() => scriptedChatStream());
    const adapter = makeAdapter({ factory, tenantMembers });

    await expect(
      adapter.createSession({
        tenantId: "any-tenant",
        sessionId: "sess-1",
        userId: "user-1"
      })
    ).rejects.toThrow("database connection timeout");

    await adapter.close();
  });

  it("resolves isBetaTester to false when membership record is missing", async () => {
    let capturedIsBetaTester: boolean | undefined;
    const dynamicConfig = {
      async compileRuntimeConfig(_tenantId: string, isBetaTester: boolean, _sessionId?: string) {
        capturedIsBetaTester = isBetaTester;
        return {
          runtimePolicy: testRuntimePolicy,
          skills: [],
          mcpServers: [],
          hash: "hash",
          sources: { runtimePolicy: { id: "test", version: 1, hash: "h" }, skills: [], mcpServers: [] }
        };
      }
    } as unknown as DynamicConfigService;

    const tenantMembers = {
      isUserBetaTester: async () => false
    };

    const { factory } = makeRuntimeFactory(() => scriptedChatStream());
    const adapter = makeAdapter({
      factory,
      dynamicConfig,
      tenantMembers
    });

    await adapter.createSession({
      tenantId: "tenant-missing-member",
      sessionId: "sess-missing",
      userId: "user-missing"
    });
    expect(capturedIsBetaTester).toBe(false);

    await adapter.close();
  });
});


describe("turn resource availability", () => {
  const skill: RuntimeConfigBundle["skills"][number] = {
    id: "writer", name: "Writer", description: "Persist generated files",
    instructions: "Call write_artifact", associatedToolIds: ["write_artifact"],
    version: 1, hash: "h", revisionId: null, bundleHash: null, sourceType: "inline",
    bundleName: null, bundleStorageUri: null, validationStatus: null, reviewStatus: null
  };

  it("records only loaded resources before a tool can run, once per turn", async () => {
    const recordMaterialization = vi.fn(async () => {});
    const loadedServers = new Map<string, string>();
    const factory: DeepAgentsRuntimeFactory = () => ({
      ...emptyRuntimeCapabilities(),
      getMcpToolNames() { return new Set(loadedServers.keys()); },
      getMcpToolServers() { return loadedServers; },
      async getAgentForModel() {
        loadedServers.set("write_artifact", "loaded");
        loadedServers.set("session_context", "loaded");
        return {
          async *streamEvents() {
            expect(recordMaterialization).toHaveBeenCalled();
            yield* scriptedChatStream();
          }
        };
      },
      async dispose() {}
    });
    const adapter = makeAdapter({
      factory,
      activationTracker: { recordMaterialization },
      dynamicConfig: makeDynamicConfig({}, {
        skills: [skill, { ...skill, id: "empty", instructions: " " }],
        mcpServers: ["loaded", "unreachable"].map((id) => ({
          id, description: id, mode: "managed", routePath: `/mcp/${id}`,
          upstreamUrl: null, transportKind: "http", version: 1, hash: "h"
        }))
      })
    });
    try {
      const session = await adapter.createSession(sessionInput);
      expect(recordMaterialization).not.toHaveBeenCalled();
      for (const assistantMessageId of ["assistant-1", "assistant-2"]) {
        await collect(adapter.runMessageAGUI(session, {
          prompt: "Write a file", toolContextId: "context", assistantMessageId
        }));
        expect(recordMaterialization).toHaveBeenLastCalledWith(
          { tenantId: sessionInput.tenantId, sessionId: sessionInput.sessionId, messageId: assistantMessageId },
          [
            { resourceType: "skill", resourceId: "writer", metadata: { associatedToolIds: ["write_artifact"] } },
            { resourceType: "mcp_server", resourceId: "loaded" }
          ]
        );
      }
      expect(recordMaterialization).toHaveBeenCalledTimes(2);
    } finally {
      await adapter.close();
    }
  });

  it("does not record availability when graph compilation fails", async () => {
    const recordMaterialization = vi.fn(async () => {});
    const adapter = makeAdapter({
      factory: () => ({
        ...emptyRuntimeCapabilities(),
        async getAgentForModel() { throw new Error("compile failed"); },
        async dispose() {}
      }),
      activationTracker: { recordMaterialization },
      dynamicConfig: makeDynamicConfig({}, { skills: [skill] })
    });
    try {
      const session = await adapter.createSession(sessionInput);
      const events = await collect(adapter.runMessageAGUI(session, { prompt: "hi", toolContextId: "ctx" }));
      expect(events.some((event) => event.type === AGUIEventType.RUN_ERROR)).toBe(true);
      expect(recordMaterialization).not.toHaveBeenCalled();
    } finally {
      await adapter.close();
    }
  });
});

it("gives a new participant fresh runtime authority and rejects the prior execution", async () => {
  const runtime = makeRuntimeFactory(() => scriptedChatStream());
  let currentId = "execution-alice";
  const executions = {
    isCurrent: vi.fn(async (execution: { executionId: string }) => execution.executionId === currentId),
    bindRuntime: vi.fn(async () => {})
  };
  const checkpointer = { deleteThread: vi.fn(async () => {}) };
  const adapter = makeAdapter({ factory: runtime.factory, executions, checkpointer, sessions: {
    getReadable: async (...args) => ({ ...await fakeSessionAccess.getReadable(...args), projectId: "project" })
  } });
  const alice = { ...sessionInput, executionId: currentId, projectId: "project", expiresAt: new Date(Date.now() + 30_000).toISOString() };
  try {
    const first = await adapter.createSession({ ...alice, execution: alice });
    await collect(adapter.runMessageAGUI(first, runMessageInput()));
    currentId = "execution-bob";
    const bob = { ...alice, userId: "user-2", executionId: currentId };
    const second = await adapter.createSession({ ...bob, execution: bob });
    expect(second.runtimeId).not.toBe(first.runtimeId);
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
    expect(runtime.factoryCalls.map((call) => call.userId)).toEqual(["user-1", "user-2"]);
    expect(runtime.factoryCalls.every((call) => call.checkpointer === undefined)).toBe(true);
    await expect(runtime.factoryCalls[0]!.requireExecution!()).rejects.toThrow("execution permission");
    await expect(runtime.factoryCalls[1]!.requireExecution!()).resolves.toBeUndefined();
    await expect(collect(adapter.runMessageAGUI(first, runMessageInput()))).rejects.toThrow("no longer current");
    await collect(adapter.runMessageAGUI(second, runMessageInput()));
    currentId = "revoked";
    await expect(collect(adapter.runMessageAGUI(second, runMessageInput()))).rejects.toThrow("execution permission");
    expect(runtime.streamInputs).toHaveLength(2);
  } finally { await adapter.close(); }
});

it("does not install execution checks for personal runtimes", async () => {
  const runtime = makeRuntimeFactory(() => scriptedChatStream());
  const adapter = makeAdapter({ factory: runtime.factory });
  try {
    await adapter.createSession(sessionInput);
    expect(runtime.factoryCalls[0]?.requireExecution).toBeUndefined();
  } finally { await adapter.close(); }
});

it("does not dispose another tenant's runtime during project participant handoff", async () => {
  const runtime = makeRuntimeFactory(() => scriptedChatStream());
  const adapter = makeAdapter({ factory: runtime.factory, executions: {
    isCurrent: async () => true, bindRuntime: async () => {}
  } });
  try {
    await adapter.createSession(sessionInput);
    const execution = { ...sessionInput, tenantId: "another-tenant", executionId: "execution", projectId: "project", expiresAt: new Date(Date.now() + 30_000).toISOString() };
    await expect(adapter.createSession({ ...execution, execution })).rejects.toThrow("unavailable for execution");
    expect(runtime.dispose).not.toHaveBeenCalled();
    expect(runtime.factoryCalls).toHaveLength(1);
  } finally { await adapter.close(); }
});

it("requires a project execution before opening checkpoints and rejects private runtime reuse after assignment", async () => {
  const runtime = makeRuntimeFactory(() => scriptedChatStream());
  const session = { ...sessionInput, sessionName: "Shared", status: "active" as const, projectId: "project" as string | null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const adapter = makeAdapter({ factory: runtime.factory, sessions: { getReadable: async () => session } });
  try {
    await expect(adapter.createSession(sessionInput)).rejects.toMatchObject({ code: "session_unavailable" });
    expect(runtime.factoryCalls).toHaveLength(0);
    session.projectId = null;
    const privateRuntime = await adapter.createSession(sessionInput);
    expect(runtime.factoryCalls[0]!.requireExecution).toBeUndefined();
    session.projectId = "project";
    await expect(collect(adapter.runMessageAGUI(privateRuntime, runMessageInput()))).rejects.toMatchObject({ code: "session_unavailable" });
    expect(runtime.streamInputs).toHaveLength(0);
  } finally { await adapter.close(); }
});
