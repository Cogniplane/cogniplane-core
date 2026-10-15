import { describe, test, beforeEach, expect, vi } from "vitest";

import { EventType, type BaseEvent } from "@ag-ui/client";

import type { RuntimeSessionRef } from "../runtime-contracts.js";
import { AGUI_INTERRUPTED_RESULT } from "./deep-agents/agui-events.js";
import type { SessionRecord } from "./session-store.js";
import type { MessageRecord, ToolResultRecord } from "./message-store.js";
import type { ToolExecutionContext } from "./auth/tool-execution-context-store.js";
import type { ScheduledJobRecord } from "./user-settings-store.js";
import { PiiProtectionServiceError, type PiiDecision } from "./pii/pii-protection-service.js";
import type { PiiFinding } from "./pii/pii-provider.js";
import {
  SchedulerWorker,
  type SchedulerRuntimeResolution,
  type SchedulerRuntimeAdapter,
  type SchedulerWorkerDeps
} from "./scheduler-worker.js";

function makeFakeSessionRef(sessionId: string): RuntimeSessionRef {
  return {
    sessionId,
    runtimeId: `rt-${sessionId}`,
    mcpServerSources: [{ id: "docs", hash: "server-hash", credentialVersion: 1 }],
    integrationAccounts: { notion: "notion-user:workspace" },
    runtimePolicy: {
      id: "default-profile",
      label: "Default",
      description: null,
      webSearchMode: "disabled",
      approvalPolicy: "never",
      approvalReviewer: "user",
      sandboxMode: "workspace-write",
      sandboxEgressDomains: [],
      allowCommandExecution: true,
      autoApproveReadOnlyTools: false,
      policyEnforcementMode: "monitor",
      developerInstructions: null,
      enabledToolIds: [],
      enabledMcpServers: [],
      version: 1,
      hash: "abc123"
    }
  };
}

function makeFakeJob(overrides: Partial<ScheduledJobRecord> = {}): ScheduledJobRecord {
  return {
    tenantId: "test-tenant",
    jobId: "job-1",
    userId: "user-1",
    jobName: "Daily report",
    description: null,
    scheduleKind: "cron",
    cronExpression: "0 9 * * *",
    timeZone: "UTC",
    targetType: "prompt",
    targetRef: null,
    input: { prompt: "Generate the daily report" },
    settingsSnapshot: {},
    enabled: true,
    consecutiveFailures: 0,
    lastRunAt: null,
    nextRunAt: "2026-01-01T09:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

let messageIdCounter = 0;

function makeFakeMessageRecord(
  sessionId: string,
  userId: string,
  role: MessageRecord["role"],
  status: MessageRecord["status"],
  content: string,
  overrides?: Partial<MessageRecord>
): MessageRecord {
  messageIdCounter += 1;
  return {
    id: messageIdCounter,
    messageId: `msg-${messageIdCounter}`,
    sessionId,
    userId,
    role,
    status,
    content,
    reasoningContent: "",
    reasoningSegments: null,
    planContent: "",
    tokenUsage: null,
    modelName: null,
    costUsd: null,
    feedbackRating: null,
    detail: {},
    toolResults: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

function createFakeDeps(options?: {
  dueJobs?: ScheduledJobRecord[];
  claimReturns?: (ScheduledJobRecord | null)[];
  runtimeEvents?: BaseEvent[][];
  runMessageImpl?: (
    session: RuntimeSessionRef,
    input: { prompt: string }
  ) => AsyncIterable<BaseEvent>;
  /** Token usage the runtime adapter is pretended to have persisted on the assistant row. */
  assistantTokenUsage?: { inputTokens: number; outputTokens: number };
  /** Override per-tenant runtime resolution (e.g. to fail it or to hand back
   * a different adapter per tenant). Defaults to resolving the shared fake
   * adapter with the fake default model. */
  resolveRuntimeImpl?: (tenantId: string) => Promise<SchedulerRuntimeResolution>;
  /** Orphaned pending runs the stale-run sweep is pretended to recover. */
  orphanedRuns?: Array<{
    tenantId: string;
    runId: string;
    jobId: string;
    userId: string;
    sessionId: string | null;
  }>;
  /** Make the stale-run sweep itself fail. */
  sweepStaleJobRunsError?: Error;
  /** Delay runtime resolution so a short jobTimeoutMs fires BEFORE `turn.adapter`
   *  is assigned — the watchdog then has no adapter to abort through. */
  resolveRuntimeDelayMs?: number;
  /** Make every assistant text/status write fail. */
  updateContentError?: Error;
  /** Make every assistant text/status write match no row, as the store does
   *  when the tenant, message, and user scope finds nothing. */
  updateContentReturnsNull?: boolean;
  /** Hold the usage read that runs before the final transcript write. */
  getOwnedGate?: Promise<void>;
}) {
  const dueJobs = options?.dueJobs ?? [];
  const claimReturns = options?.claimReturns ?? dueJobs.map((j) => j);
  const runtimeEventsPerCall = options?.runtimeEvents ?? [
    [
      { type: EventType.RUN_STARTED, threadId: "session-1", runId: "resp-1" } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg-1",
        delta: "Hello from scheduler"
      } as BaseEvent,
      { type: EventType.RUN_FINISHED, threadId: "session-1", runId: "resp-1" } as BaseEvent
    ]
  ];

  let claimIndex = 0;
  let runtimeCallIndex = 0;

  const sessionsCreated: Array<{ userId: string; sessionName: string; options?: { purpose?: string } }> = [];
  const claimsCalled: Array<{ tenantId: string; jobId: string; nextRunAt: string | null }> = [];
  const jobRunsCreated: Array<{ runId: string; jobId: string; userId: string; sessionId: string | null }> = [];
  const jobRunsCompleted: Array<{
    runId: string;
    status: string;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    errorMessage: string | null;
    summary: string | null;
  }> = [];
  const messagesCreated: Array<{
    sessionId: string;
    userId: string;
    role: string;
    status: string;
    content: string;
  }> = [];
  const messagesUpdated: Array<{
    messageId: string;
    userId: string;
    status: string;
    content: string;
  }> = [];
  const streamingUpdates: Array<{
    reasoningContent?: string;
    reasoningSegments?: Array<{ offset: number; text: string }>;
    planContent?: string;
  }> = [];
  const toolResultsSaved: Array<Record<string, unknown>> = [];
  const noticesSaved: unknown[][] = [];
  const toolContextsCreated: Array<{
    sessionId: string;
    userId: string;
    runtimeId: string;
    runtimePolicyId: string;
    messageId: string | null;
    metadata: Record<string, unknown>;
    ttlMs: number;
  }> = [];
  const runtimeSessionsCreated: Array<{ sessionId: string; userId: string }> = [];
  const runMessageCalls: Array<{ sessionId: string; prompt: string; model?: string }> = [];
  const abortSessionCalls: Array<{ tenantId: string; sessionId: string; userId: string }> = [];
  const purgeSessionDataCalls: Array<{ tenantId: string; sessionId: string; userId: string }> = [];
  const resolveRuntimeCalls: string[] = [];
  const auditEvents: Array<{
    sessionId: string | null;
    userId: string;
    type: string;
    payload: Record<string, unknown>;
  }> = [];
  const recordOutcomeCalls: Array<{ tenantId: string; jobId: string; succeeded: boolean }> = [];
  const failureCounts = new Map<string, number>();
  const sweepStaleJobRunsCalls: Array<{ olderThanMs: number; limit: number }> = [];

  // The adapter `resolveRuntime` hands back by default — what the worker
  // dispatches createSession/runMessageAGUI/abortSession to after resolution.
  const runtimeAdapter: Extract<SchedulerRuntimeResolution, { kind: "ok" }>["adapter"] = {
    id: "deep-agents",
    createSession: async (input) => {
      runtimeSessionsCreated.push(input);
      return makeFakeSessionRef(input.sessionId);
    },
    runMessageAGUI: function (_session, input) {
      runMessageCalls.push({ sessionId: _session.sessionId, prompt: input.prompt, model: input.model });
      if (options?.runMessageImpl) {
        return options.runMessageImpl(_session, { prompt: input.prompt });
      }
      const events = runtimeEventsPerCall[runtimeCallIndex] ?? [];
      runtimeCallIndex += 1;
      return (async function* () {
        for (const event of events) {
          yield event;
        }
      })();
    },
    abortSession: async (input) => {
      abortSessionCalls.push(input);
    },
    purgeSessionData: async (input) => {
      purgeSessionDataCalls.push(input);
    }
  };

  const deps: SchedulerWorkerDeps = {
    runtimeAdapter,
    settings: {
      listDueJobs: async (limit: number) => dueJobs.slice(0, limit),
      claimJob: async (tenantId, jobId, nextRunAt) => {
        claimsCalled.push({ tenantId, jobId, nextRunAt });
        const result = claimReturns[claimIndex] ?? null;
        claimIndex += 1;
        return result;
      },
      createJobRun: async (input) => {
        jobRunsCreated.push(input);
        return {
          runId: input.runId,
          jobId: input.jobId,
          userId: input.userId,
          sessionId: input.sessionId,
          status: "pending",
          startedAt: new Date().toISOString(),
          completedAt: null,
          durationMs: null,
          inputTokens: 0,
          outputTokens: 0,
          errorMessage: null,
          summary: null,
          createdAt: new Date().toISOString()
        };
      },
      completeJobRun: async (input) => {
        jobRunsCompleted.push(input);
        return {
          runId: input.runId,
          jobId: "job-1",
          userId: "user-1",
          sessionId: null,
          status: input.status,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: input.durationMs,
          inputTokens: input.inputTokens,
          outputTokens: input.outputTokens,
          errorMessage: input.errorMessage,
          summary: input.summary,
          createdAt: new Date().toISOString()
        };
      },
      recordJobRunOutcome: async (tenantId: string, jobId: string, succeeded: boolean) => {
        recordOutcomeCalls.push({ tenantId, jobId, succeeded });
        const next = succeeded ? 0 : (failureCounts.get(jobId) ?? 0) + 1;
        failureCounts.set(jobId, next);
        return next;
      },
      sweepStaleJobRuns: async (olderThanMs: number, limit: number) => {
        sweepStaleJobRunsCalls.push({ olderThanMs, limit });
        if (options?.sweepStaleJobRunsError) {
          throw options.sweepStaleJobRunsError;
        }
        return options?.orphanedRuns ?? [];
      }
    },
    sessions: {
      create: async (
        _tenantId: string,
        userId: string,
        sessionName: string,
        options?: { purpose?: string }
      ): Promise<SessionRecord> => {
        sessionsCreated.push({ userId, sessionName, options });
        const sessionId = `session-${sessionsCreated.length}`;
        return {
          sessionId,
          projectId: null,
          userId,
          sessionName,
          status: "active",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          transcriptFormat: "current"
        };
      }
    },
    messages: {
      create: async (input) => {
        messagesCreated.push(input);
        return makeFakeMessageRecord(
          input.sessionId,
          input.userId,
          input.role,
          input.status,
          input.content
        );
      },
      updateContent: async (_tenantId, messageId, userId, status, content) => {
        messagesUpdated.push({ messageId, userId, status, content });
        if (options?.updateContentError) throw options.updateContentError;
        if (options?.updateContentReturnsNull) return null;
        return makeFakeMessageRecord("session-1", userId, "assistant", status, content, { messageId });
      },
      updateStreamingContent: async (_tenantId, _messageId, _userId, content) => {
        streamingUpdates.push(content);
      },
      upsertToolResult: async (input) => {
        toolResultsSaved.push(input);
        return input as unknown as ToolResultRecord;
      },
      setRuntimeNotices: async (_tenantId, _messageId, _userId, notices) => {
        noticesSaved.push([...notices]);
      },
      getOwned: async (_tenantId: string, messageId: string, userId: string) => {
        await options?.getOwnedGate;
        const usage = options?.assistantTokenUsage;
        return makeFakeMessageRecord("session-1", userId, "assistant", "completed", "", {
          messageId,
          tokenUsage: usage
            ? {
                inputTokens: usage.inputTokens,
                cachedInputTokens: 0,
                outputTokens: usage.outputTokens,
                reasoningOutputTokens: 0,
                totalTokens: usage.inputTokens + usage.outputTokens
              }
            : null
        });
      }
    },
    toolContexts: {
      create: async (input) => {
        toolContextsCreated.push({
          sessionId: input.sessionId,
          userId: input.userId,
          runtimeId: input.runtimeId,
          runtimePolicyId: input.runtimePolicyId,
          messageId: input.messageId,
          metadata: input.metadata ?? {},
          ttlMs: input.ttlMs
        });
        return {
          toolContextId: `ctx-${toolContextsCreated.length}`,
          tenantId: input.tenantId,
          sessionId: input.sessionId,
          userId: input.userId,
          runtimeId: input.runtimeId,
          runtimePolicyId: input.runtimePolicyId,
          messageId: input.messageId,
          credentialEnvelope: {},
          metadata: input.metadata ?? {},
          expiresAt: new Date(Date.now() + input.ttlMs).toISOString(),
          createdAt: new Date().toISOString()
        } satisfies ToolExecutionContext;
      }
    },
    resolveRuntime: async (tenantId: string) => {
      resolveRuntimeCalls.push(tenantId);
      if (options?.resolveRuntimeDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.resolveRuntimeDelayMs));
      }
      if (options?.resolveRuntimeImpl) {
        return options.resolveRuntimeImpl(tenantId);
      }
      return {
        kind: "ok",
        adapter: runtimeAdapter,
        modelId: "default-model"
      };
    },
    auditEvents: {
      create: async (input) => {
        auditEvents.push(input);
      }
    },
    logger: {
      warn: () => {},
      error: () => {},
      info: () => {}
    }
  };

  return {
    deps,
    runtimeAdapter,
    sessionsCreated,
    claimsCalled,
    jobRunsCreated,
    jobRunsCompleted,
    messagesCreated,
    messagesUpdated,
    streamingUpdates,
    toolResultsSaved,
    noticesSaved,
    toolContextsCreated,
    runtimeSessionsCreated,
    runMessageCalls,
    abortSessionCalls,
    purgeSessionDataCalls,
    resolveRuntimeCalls,
    sweepStaleJobRunsCalls,
    auditEvents,
    recordOutcomeCalls,
    failureCounts
  };
}

describe("SchedulerWorker", () => {
  beforeEach(() => {
    messageIdCounter = 0;
  });

  test("tick does nothing when no jobs are due", async () => {
    const { deps, sessionsCreated, jobRunsCreated } = createFakeDeps({ dueJobs: [] });
    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 5, jobTimeoutMs: 60_000 });
    await worker.tick();

    expect(sessionsCreated.length).toBe(0);
    expect(jobRunsCreated.length).toBe(0);
  });

  test("a stopped worker claims no new job", async () => {
    const job = makeFakeJob();
    const { deps, jobRunsCreated } = createFakeDeps({ dueJobs: [job] });
    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 5, jobTimeoutMs: 60_000 });
    worker.stop();
    await worker.tick();
    expect(jobRunsCreated).toHaveLength(0);
  });

  test("drain waits for a running job and its outcome write", async () => {
    const job = makeFakeJob();
    let finishTurn = () => {};
    let turnStarted = false;
    const turnGate = new Promise<void>((resolve) => { finishTurn = resolve; });
    const { deps, jobRunsCompleted } = createFakeDeps({
      dueJobs: [job],
      async *runMessageImpl() {
        turnStarted = true;
        await turnGate;
        yield* [];
      }
    });
    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 5, jobTimeoutMs: 60_000 });
    void worker.tick();
    await vi.waitFor(() => expect(turnStarted).toBe(true));
    worker.stop();

    // The job is still running: a short budget is not enough.
    await expect(worker.drain(20)).resolves.toBe(false);
    const drained = worker.drain(5_000);
    finishTurn();
    await expect(drained).resolves.toBe(true);
    expect(jobRunsCompleted).toHaveLength(1);
  });

  test("drain waits for a job that outlives its timeout wrapper", async () => {
    const job = makeFakeJob();
    let finishTurn = () => {};
    const turnGate = new Promise<void>((resolve) => { finishTurn = resolve; });
    const { deps, jobRunsCompleted } = createFakeDeps({
      dueJobs: [job],
      // The turn ignores the abort and ends only when the gate opens.
      async *runMessageImpl() {
        await turnGate;
        yield* [];
      }
    });
    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 5, jobTimeoutMs: 10, abortSettleGraceMs: 10 });

    // The tick settles once the abort grace frees the slot; the job does not.
    await worker.tick();
    worker.stop();
    await expect(worker.drain(30)).resolves.toBe(false);
    const drained = worker.drain(5_000);
    finishTurn();
    await expect(drained).resolves.toBe(true);
    expect(jobRunsCompleted).toHaveLength(1);
  });

  test("drain waits for a started job when a later claim fails", async () => {
    const first = makeFakeJob();
    const second = { ...makeFakeJob(), jobId: "job-2" };
    let finishTurn = () => {};
    const turnGate = new Promise<void>((resolve) => { finishTurn = resolve; });
    const { deps, jobRunsCompleted } = createFakeDeps({
      dueJobs: [first, second],
      async *runMessageImpl() {
        await turnGate;
        yield* [];
      }
    });
    const claim = deps.settings.claimJob.bind(deps.settings);
    deps.settings.claimJob = async (tenantId, jobId, nextRunAt) => {
      if (jobId === "job-2") throw new Error("claim failed");
      return claim(tenantId, jobId, nextRunAt);
    };
    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 5, jobTimeoutMs: 60_000 });

    await expect(worker.tick()).rejects.toThrow("claim failed");
    worker.stop();
    await expect(worker.drain(30)).resolves.toBe(false);
    const drained = worker.drain(5_000);
    finishTurn();
    await expect(drained).resolves.toBe(true);
    expect(jobRunsCompleted).toHaveLength(1);
  });

  test("a job still preparing when the runtimes close fails instead of starting a turn", async () => {
    const job = makeFakeJob();
    let turns = 0;
    const { deps, jobRunsCompleted, jobRunsCreated } = createFakeDeps({
      dueJobs: [job],
      resolveRuntimeDelayMs: 50,
      async *runMessageImpl() {
        turns += 1;
        yield* [];
      }
    });
    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 5, jobTimeoutMs: 60_000 });
    const tick = worker.tick();
    // Shutdown refuses new turns while the claimed job still resolves its runtime.
    await vi.waitFor(() => expect(jobRunsCreated).toHaveLength(1));
    worker.refuseNewTurns();
    await tick;
    await expect(worker.drain(5_000)).resolves.toBe(true);
    expect(turns).toBe(0);
    expect(jobRunsCompleted).toEqual([expect.objectContaining({ status: "failed" })]);
  });

  test("a worker stopped while it lists due jobs claims none of them", async () => {
    const job = makeFakeJob();
    const { deps, claimsCalled } = createFakeDeps({ dueJobs: [job] });
    const list = deps.settings.listDueJobs.bind(deps.settings);
    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 5, jobTimeoutMs: 60_000 });
    deps.settings.listDueJobs = async (limit) => {
      worker.stop();
      return list(limit);
    };

    await worker.tick();

    expect(claimsCalled).toHaveLength(0);
  });

  test("tick claims and executes a due job", async () => {
    const job = makeFakeJob();
    const { deps, sessionsCreated, jobRunsCreated, jobRunsCompleted, messagesCreated, toolContextsCreated, auditEvents } =
      createFakeDeps({ dueJobs: [job] });
    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 5, jobTimeoutMs: 60_000 });
    await worker.tick();

    expect(sessionsCreated.length).toBe(1);
    expect(sessionsCreated[0].sessionName).toBe("[Scheduled] Daily report");
    expect(sessionsCreated[0].userId).toBe("user-1");
    // The session is stamped purpose:'scheduled' (drives chat-sidebar filtering +
    // corpus exclusion) — a dropped 4th arg would silently create a normal session.
    expect(sessionsCreated[0].options?.purpose).toBe("scheduled");

    expect(jobRunsCreated.length).toBe(1);
    expect(jobRunsCreated[0].jobId).toBe("job-1");
    expect(jobRunsCreated[0].userId).toBe("user-1");

    expect(jobRunsCompleted.length).toBe(1);
    expect(jobRunsCompleted[0].status).toBe("completed");
    expect(jobRunsCompleted[0].summary?.includes("Hello from scheduler")).toBeTruthy();

    // Two messages: user prompt + assistant placeholder
    expect(messagesCreated.length).toBe(2);
    expect(messagesCreated[0].role).toBe("user");
    expect(messagesCreated[1].role).toBe("assistant");
    expect(toolContextsCreated[0].metadata.turnContext).toBe("scheduled");
    expect(toolContextsCreated[0].metadata.runtimePolicy).toMatchObject({
      id: "default-profile",
      enabledToolIds: [],
      enabledMcpServers: []
    });
    expect(toolContextsCreated[0].metadata.mcpServerSources).toEqual([
      { id: "docs", hash: "server-hash", credentialVersion: 1 }
    ]);
    expect(toolContextsCreated[0].metadata.integrationAccounts).toEqual({ notion: "notion-user:workspace" });

    const completedAudit = auditEvents.find((e) => e.type === "scheduler.job.run.completed");
    if (!completedAudit) throw new Error("Expected scheduler completion audit event.");
    expect(completedAudit.userId).toBe("user-1");
  });

  test("an interrupted scheduled turn records a terminal failed run", async () => {
    const job = makeFakeJob();
    const { deps, jobRunsCompleted, auditEvents, messagesUpdated } = createFakeDeps({
      dueJobs: [job],
      runMessageImpl: async function* () {
        yield { type: EventType.RUN_STARTED, threadId: "session-1", runId: "resp-1" } as BaseEvent;
        yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "partial" } as BaseEvent;
        yield {
          type: EventType.RUN_FINISHED,
          threadId: "session-1",
          runId: "resp-1",
          result: AGUI_INTERRUPTED_RESULT
        } as BaseEvent;
      }
    });
    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 1, jobTimeoutMs: 60_000 });

    await worker.tick();

    expect(jobRunsCompleted).toHaveLength(1);
    expect(jobRunsCompleted[0]).toMatchObject({
      status: "failed",
      errorMessage: "Scheduled job was interrupted."
    });
    expect(auditEvents.some((event) => event.type === "scheduler.job.run.failed")).toBe(true);
    // Same row outcome as a stopped interactive turn: partial text is kept.
    expect(messagesUpdated).toEqual([
      expect.objectContaining({ status: "interrupted", content: "partial" })
    ]);
  });

  test("tick resolves the runtime per job tenant and dispatches to the resolved adapter", async () => {
    // The worker must NOT be hard-wired to Codex — each job runs on
    // the adapter `resolveRuntime` picks for its tenant (the same resolution
    // the interactive /messages path performs).
    const jobs = [
      makeFakeJob({ jobId: "job-a", tenantId: "tenant-a" }),
      makeFakeJob({ jobId: "job-b", tenantId: "tenant-b" })
    ];

    const completedEvents: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "session-1", runId: "resp-1" } as BaseEvent,
      { type: EventType.RUN_FINISHED, threadId: "session-1", runId: "resp-1" } as BaseEvent
    ];
    const makeAdapter = (id: string, calls: string[]): SchedulerRuntimeAdapter =>
      ({
        id,
        createSession: async (input: { sessionId: string }) => makeFakeSessionRef(input.sessionId),
        runMessageAGUI: function (_session: RuntimeSessionRef) {
          calls.push(_session.sessionId);
          return (async function* () {
            for (const event of completedEvents) {
              yield event;
            }
          })();
        },
        abortSession: async () => {},
        purgeSessionData: async () => {}
      });

    const callsA: string[] = [];
    const callsB: string[] = [];
    const adapterA = makeAdapter("deep-agents", callsA);
    const adapterB = makeAdapter("deep-agents", callsB);

    const { deps, resolveRuntimeCalls, jobRunsCompleted } = createFakeDeps({
      dueJobs: jobs,
      resolveRuntimeImpl: async (tenantId) =>
        tenantId === "tenant-b"
          ? { kind: "ok", adapter: adapterB, modelId: "model-b" }
          : { kind: "ok", adapter: adapterA, modelId: "model-a" }
    });
    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 5, jobTimeoutMs: 60_000 });
    await worker.tick();

    expect(resolveRuntimeCalls.sort()).toEqual(["tenant-a", "tenant-b"]);
    expect(callsA.length).toBe(1);
    expect(callsB.length).toBe(1);
    expect(jobRunsCompleted.length).toBe(2);
    expect(jobRunsCompleted.every((run) => run.status === "completed")).toBe(true);
  });

  test("tick threads the resolved default model into runMessage", async () => {
    const job = makeFakeJob();
    const { deps, runMessageCalls } = createFakeDeps({ dueJobs: [job] });
    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 1, jobTimeoutMs: 60_000 });
    await worker.tick();

    expect(runMessageCalls.length).toBe(1);
    expect(runMessageCalls[0].model).toBe("default-model");
  });

  test("an internal exception never reaches the job owner's run row or audit event", async () => {
    // R8. errorMessage is written to scheduled_job_runs, put in the
    // scheduler.job.run.failed audit payload, and returned to the job owner by
    // GET /me/scheduled-jobs/:jobId/runs. It used to be `error.message` raw, so
    // a pg or E2B failure put connection strings and sandbox ids in front of a
    // user. The interactive path already classified; this one did not.
    const job = makeFakeJob();
    const { deps, jobRunsCompleted, auditEvents, messagesUpdated } = createFakeDeps({
      dueJobs: [job],
      runMessageImpl: () => {
        throw Object.assign(
          new Error(
            "connect ECONNREFUSED postgres://app_user:s3cr3t@10.0.4.17:5432/cogniplane, sandbox i7x9k2mq0zt4vabc"
          ),
          { statusCode: 500 }
        );
      }
    });
    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 1, jobTimeoutMs: 60_000 });
    await worker.tick();

    expect(jobRunsCompleted.length).toBe(1);
    expect(jobRunsCompleted[0].status).toBe("failed");
    expect(jobRunsCompleted[0].errorMessage).toBe("The assistant run failed.");

    // The assistant row is closed out instead of staying pending.
    expect(messagesUpdated).toEqual([
      expect.objectContaining({ status: "error", content: "The assistant run failed." })
    ]);

    // Nothing internal in the run row, the transcript, or the audit trail.
    const serialized = JSON.stringify({ runs: jobRunsCompleted, audit: auditEvents, rows: messagesUpdated });
    expect(serialized).not.toContain("10.0.4.17");
    expect(serialized).not.toContain("s3cr3t");
    expect(serialized).not.toContain("i7x9k2mq0zt4vabc");
  });

  test("tick records a failed run when runtime resolution fails, without touching any runtime", async () => {
    const job = makeFakeJob();
    const { deps, jobRunsCreated, jobRunsCompleted, runtimeSessionsCreated, messagesCreated, auditEvents, recordOutcomeCalls } =
      createFakeDeps({
        dueJobs: [job],
        resolveRuntimeImpl: async () => ({
          kind: "error",
          message: "The runtime adapter is not available on this server."
        })
      });
    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 1, jobTimeoutMs: 60_000 });
    await worker.tick();

    // The run row exists and is completed as failed with the resolver's reason.
    expect(jobRunsCreated.length).toBe(1);
    expect(jobRunsCompleted.length).toBe(1);
    expect(jobRunsCompleted[0].status).toBe("failed");
    expect(jobRunsCompleted[0].errorMessage).toMatch(/runtime adapter is not available/);

    // No runtime session, no message rows (resolution happens before them),
    // and the poison counter sees a failure.
    expect(runtimeSessionsCreated.length).toBe(0);
    expect(messagesCreated.length).toBe(0);
    expect(recordOutcomeCalls).toEqual([{ tenantId: job.tenantId, jobId: job.jobId, succeeded: false }]);
    expect(auditEvents.find((e) => e.type === "scheduler.job.run.failed")).toBeTruthy();
  });

  test("tick records failure when runtime yields RUN_ERROR", async () => {
    const job = makeFakeJob();
    const failedEvents: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "session-1", runId: "resp-1" },
      { type: EventType.RUN_ERROR, message: "Something went wrong" }
    ];
    const { deps, jobRunsCompleted, auditEvents, messagesUpdated } = createFakeDeps({
      dueJobs: [job],
      runtimeEvents: [failedEvents]
    });
    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 5, jobTimeoutMs: 60_000 });
    await worker.tick();

    expect(jobRunsCompleted.length).toBe(1);
    expect(jobRunsCompleted[0].status).toBe("failed");
    expect(jobRunsCompleted[0].errorMessage).toBe("Something went wrong");
    expect(messagesUpdated).toEqual([
      expect.objectContaining({ status: "error", content: "Something went wrong" })
    ]);

    const failedAudit = auditEvents.find((e) => e.type === "scheduler.job.run.failed");
    expect(failedAudit).toBeTruthy();
  });

  test("a scheduled turn saves reasoning, plan, notices, and tools like an interactive turn", async () => {
    const job = makeFakeJob();
    // The narration quotes a 40-character token. The store saves the redacted
    // text, so the tool offset must point into "token is [REDACTED] ".
    const narration = "token is ghp_" + "A".repeat(36) + " ";
    const notice = { noticeId: "n-1", level: "warning", title: "Skipped", message: "Tool gated" };
    const { deps, jobRunsCompleted, messagesUpdated, streamingUpdates, toolResultsSaved, noticesSaved } =
      createFakeDeps({
        dueJobs: [job],
        runtimeEvents: [[
          { type: EventType.RUN_STARTED, threadId: "session-1", runId: "resp-1" },
          { type: EventType.REASONING_MESSAGE_START, messageId: "r", role: "reasoning" },
          { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "r", delta: "check the files" },
          { type: EventType.REASONING_MESSAGE_END, messageId: "r" },
          { type: EventType.STATE_DELTA, delta: [{ op: "add", path: "/plan", value: "1. list files" }] },
          { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: narration },
          { type: EventType.TOOL_CALL_START, toolCallId: "kept", toolCallName: "execute" },
          { type: EventType.TOOL_CALL_RESULT, toolCallId: "kept", messageId: "t", content: "file.txt" },
          { type: EventType.CUSTOM, name: "runtime_notice", value: notice },
          { type: EventType.RUN_FINISHED, threadId: "session-1", runId: "resp-1" }
        ] as BaseEvent[]]
      });
    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 1, jobTimeoutMs: 60_000 });

    await worker.tick();

    expect(messagesUpdated).toEqual([expect.objectContaining({ status: "completed", content: narration })]);
    expect(streamingUpdates).toEqual([{
      reasoningContent: "check the files",
      reasoningSegments: [{ offset: 0, text: "check the files" }],
      planContent: "1. list files"
    }]);
    expect(noticesSaved).toEqual([[notice]]);
    expect(toolResultsSaved).toHaveLength(1);
    expect(toolResultsSaved[0]).toMatchObject({
      toolResultId: "kept",
      status: "completed",
      output: "file.txt",
      textOffset: "token is [REDACTED] ".length
    });
    // The row keeps the raw text for the store to redact; the summary is redacted here.
    expect(jobRunsCompleted[0]).toMatchObject({ status: "completed", summary: "token is [REDACTED] " });
  });

  test.each([
    ["ordinary text", "a".repeat(600), "a".repeat(500)],
    ["a recognizable secret", "key ghp_" + "A".repeat(36) + " end", "key [REDACTED] end"],
    // Cut first, the summary would keep "sk-BBBBBBB": too short to match the key pattern.
    ["a secret across the 500-character limit", "x".repeat(489) + " sk-" + "B".repeat(40) + " done",
      "x".repeat(489) + " [REDACTED]"]
  ])("the run summary for %s is redacted before the cut", async (_name, text, summary) => {
    const { deps, jobRunsCompleted, messagesUpdated } = createFakeDeps({
      dueJobs: [makeFakeJob()],
      runtimeEvents: [[
        { type: EventType.RUN_STARTED, threadId: "session-1", runId: "resp-1" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: text },
        { type: EventType.RUN_FINISHED, threadId: "session-1", runId: "resp-1" }
      ] as BaseEvent[]]
    });
    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 1, jobTimeoutMs: 60_000 });

    await worker.tick();

    expect(jobRunsCompleted[0]).toMatchObject({ status: "completed", summary });
    expect(messagesUpdated).toEqual([expect.objectContaining({ status: "completed", content: text })]);
  });

  test("a scheduled turn that throws mid-stream keeps its partial transcript", async () => {
    const job = makeFakeJob();
    const { deps, jobRunsCompleted, messagesUpdated, toolResultsSaved, purgeSessionDataCalls } = createFakeDeps({
      dueJobs: [job],
      runMessageImpl: async function* () {
        yield { type: EventType.RUN_STARTED, threadId: "session-1", runId: "resp-1" } as BaseEvent;
        yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "partial" } as BaseEvent;
        yield { type: EventType.TOOL_CALL_START, toolCallId: "call-1", toolCallName: "execute" } as BaseEvent;
        throw new Error("socket closed by 10.0.4.17");
      }
    });
    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 1, jobTimeoutMs: 60_000 });

    await worker.tick();

    expect(messagesUpdated).toEqual([expect.objectContaining({ status: "error", content: "partial" })]);
    // The unfinished call is saved as failed, not left in progress.
    expect(toolResultsSaved).toEqual([expect.objectContaining({ toolResultId: "call-1", status: "failed" })]);
    expect(jobRunsCompleted[0]).toMatchObject({ status: "failed", errorMessage: "The assistant run failed." });
    expect(JSON.stringify(jobRunsCompleted)).not.toContain("10.0.4.17");
    expect(purgeSessionDataCalls).toHaveLength(1);
  });

  test("a failed transcript write records a failed run and still cleans up", async () => {
    const job = makeFakeJob();
    const { deps, jobRunsCompleted, messagesUpdated, toolResultsSaved, abortSessionCalls, purgeSessionDataCalls, auditEvents, recordOutcomeCalls } =
      createFakeDeps({
        dueJobs: [job],
        updateContentError: new Error("pool timeout"),
        runtimeEvents: [[
          { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "done" },
          { type: EventType.TOOL_CALL_START, toolCallId: "call-1", toolCallName: "execute" },
          { type: EventType.TOOL_CALL_RESULT, toolCallId: "call-1", messageId: "t", content: "ok" },
          { type: EventType.RUN_FINISHED, threadId: "session-1", runId: "resp-1" }
        ] as BaseEvent[]]
      });
    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 1, jobTimeoutMs: 60_000 });

    await worker.tick();

    // One attempt with the runtime outcome, one that marks the row failed.
    expect(messagesUpdated.map((update) => update.status)).toEqual(["completed", "error"]);
    // Rich parts are skipped when the required write failed.
    expect(toolResultsSaved).toEqual([]);
    expect(jobRunsCompleted[0]).toMatchObject({ status: "failed", errorMessage: "The assistant run failed." });
    expect(auditEvents.some((event) => event.type === "scheduler.job.run.completed")).toBe(false);
    expect(recordOutcomeCalls).toEqual([{ tenantId: job.tenantId, jobId: job.jobId, succeeded: false }]);
    expect(abortSessionCalls).toHaveLength(1);
    expect(purgeSessionDataCalls).toHaveLength(1);
  });

  test("a text/status write that updates no row records a failed run and still cleans up", async () => {
    const job = makeFakeJob();
    const { deps, jobRunsCompleted, messagesUpdated, toolResultsSaved, purgeSessionDataCalls, auditEvents, recordOutcomeCalls } =
      createFakeDeps({
        dueJobs: [job],
        updateContentReturnsNull: true,
        runtimeEvents: [[
          { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "done" },
          { type: EventType.TOOL_CALL_START, toolCallId: "call-1", toolCallName: "execute" },
          { type: EventType.TOOL_CALL_RESULT, toolCallId: "call-1", messageId: "t", content: "ok" },
          { type: EventType.RUN_FINISHED, threadId: "session-1", runId: "resp-1" }
        ] as BaseEvent[]]
      });
    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 1, jobTimeoutMs: 60_000 });

    await worker.tick();

    expect(messagesUpdated.map((update) => update.status)).toEqual(["completed", "error"]);
    expect(toolResultsSaved).toEqual([]);
    expect(jobRunsCompleted).toHaveLength(1);
    expect(jobRunsCompleted[0]).toMatchObject({ status: "failed", errorMessage: "The assistant run failed." });
    expect(auditEvents.some((event) => event.type === "scheduler.job.run.completed")).toBe(false);
    expect(recordOutcomeCalls).toEqual([{ tenantId: job.tenantId, jobId: job.jobId, succeeded: false }]);
    expect(purgeSessionDataCalls).toHaveLength(1);
  });

  test("tick records the real token usage persisted on the assistant message, not 0", async () => {
    const job = makeFakeJob();
    const { deps, jobRunsCompleted } = createFakeDeps({
      dueJobs: [job],
      assistantTokenUsage: { inputTokens: 12, outputTokens: 34 }
    });
    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 1, jobTimeoutMs: 60_000 });

    await worker.tick();

    expect(jobRunsCompleted.length).toBe(1);
    expect(jobRunsCompleted[0].inputTokens).toBe(12);
    expect(jobRunsCompleted[0].outputTokens).toBe(34);
  });

  test("tick resets the failure counter on a successful run", async () => {
    const job = makeFakeJob();
    const { deps, recordOutcomeCalls } = createFakeDeps({ dueJobs: [job] });
    const worker = new SchedulerWorker(deps, {
      maxConcurrentJobs: 1,
      jobTimeoutMs: 60_000,
      maxConsecutiveFailures: 3
    });

    await worker.tick();

    expect(recordOutcomeCalls).toEqual([
      { tenantId: job.tenantId, jobId: job.jobId, succeeded: true }
    ]);
  });

  test("tick threads the job's tenantId into the RLS-bypassing claim query", async () => {
    const job = makeFakeJob({ tenantId: "tenant-A" });
    const { deps, claimsCalled } = createFakeDeps({
      dueJobs: [job],
      claimReturns: [job]
    });
    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 1, jobTimeoutMs: 60_000 });

    await worker.tick();

    expect(claimsCalled.length).toBe(1);
    expect(claimsCalled[0].tenantId).toBe("tenant-A");
    expect(claimsCalled[0].jobId).toBe(job.jobId);
  });

  test("tick auto-disables a job once it crosses maxConsecutiveFailures", async () => {
    const job = makeFakeJob();
    const failedEvents: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "session-1", runId: "resp-1" },
      { type: EventType.RUN_ERROR, message: "boom" }
    ];
    const { deps, auditEvents } = createFakeDeps({
      dueJobs: [job],
      runtimeEvents: [failedEvents]
    });

    const disabled: string[] = [];
    deps.disableJob = async (input) => {
      disabled.push(input.jobId);
    };

    // Threshold of 1: a single failed run trips the poison guard.
    const worker = new SchedulerWorker(deps, {
      maxConcurrentJobs: 1,
      jobTimeoutMs: 60_000,
      maxConsecutiveFailures: 1
    });

    await worker.tick();

    expect(disabled).toEqual([job.jobId]);

    // The disable reason is carried on the audit event, not the disableJob call.
    const disabledAudit = auditEvents.find(
      (e) => e.type === "scheduler.job.disabled" && e.payload.reason === "repeated_failures"
    );
    expect(disabledAudit).toBeTruthy();
    expect(disabledAudit?.payload.disabled).toBe(true);
  });

  test("tick does not disable a failing job before the threshold is reached", async () => {
    const job = makeFakeJob();
    const failedEvents: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "session-1", runId: "resp-1" },
      { type: EventType.RUN_ERROR, message: "boom" }
    ];
    const { deps, auditEvents } = createFakeDeps({
      dueJobs: [job],
      runtimeEvents: [failedEvents]
    });

    const disabled: string[] = [];
    deps.disableJob = async (input) => {
      disabled.push(input.jobId);
    };

    const worker = new SchedulerWorker(deps, {
      maxConcurrentJobs: 1,
      jobTimeoutMs: 60_000,
      maxConsecutiveFailures: 3
    });

    await worker.tick();

    expect(disabled).toHaveLength(0);
    expect(auditEvents.find((e) => e.type === "scheduler.job.disabled")).toBeFalsy();
  });

  test("tick disables a job with an invalid cron expression instead of running it", async () => {
    const job = makeFakeJob({ cronExpression: "not-a-cron" });
    const { deps, sessionsCreated, jobRunsCompleted, auditEvents } = createFakeDeps({
      dueJobs: [job]
    });

    const disabled: string[] = [];
    deps.disableJob = async (input) => {
      disabled.push(input.jobId);
    };

    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 1, jobTimeoutMs: 60_000 });

    await worker.tick();

    // The job is disabled, never claimed for execution, and never run.
    expect(disabled).toEqual(["job-1"]);
    expect(sessionsCreated.length).toBe(0);
    expect(jobRunsCompleted.length).toBe(0);

    // The disable reason is carried on the audit event, not the disableJob call.
    const disabledAudit = auditEvents.find((e) => e.type === "scheduler.job.disabled");
    if (!disabledAudit) throw new Error("Expected invalid-cron disable audit event.");
    expect(disabledAudit.payload.reason).toBe("invalid_cron");
    expect(disabledAudit.payload.disabled).toBe(true);
  });

  test("tick parks an invalid-cron job dormant when no disable capability is wired", async () => {
    const job = makeFakeJob({ cronExpression: "not-a-cron" });
    const { deps, claimsCalled, sessionsCreated, auditEvents } = createFakeDeps({
      dueJobs: [job]
    });
    // No deps.disableJob wired — fall back to parking the job with next_run_at = NULL.
    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 1, jobTimeoutMs: 60_000 });

    await worker.tick();

    expect(claimsCalled.length).toBe(1);
    expect(claimsCalled[0].nextRunAt).toBe(null);
    expect(sessionsCreated.length).toBe(0);

    const disabledAudit = auditEvents.find((e) => e.type === "scheduler.job.disabled");
    if (!disabledAudit) throw new Error("Expected invalid-cron dormant audit event.");
    expect(disabledAudit.payload.disabled).toBe(false);
  });

  test("tick sweeps orphaned pending runs with a cutoff past the watchdog worst case", async () => {
    // A crash/restart strands run rows in 'pending' forever — the
    // tick must recover them. Cutoff = timeout + abort-settle grace + buffer
    // so a legitimately in-flight run can never be swept.
    const { deps, sweepStaleJobRunsCalls, auditEvents } = createFakeDeps({
      dueJobs: [],
      orphanedRuns: [
        {
          tenantId: "tenant-1",
          runId: "run-orphan",
          jobId: "job-9",
          userId: "user-1",
          sessionId: "session-9"
        }
      ]
    });
    const worker = new SchedulerWorker(deps, {
      maxConcurrentJobs: 1,
      jobTimeoutMs: 60_000,
      abortSettleGraceMs: 5_000
    });
    await worker.tick();

    expect(sweepStaleJobRunsCalls.length).toBe(1);
    // The sweep cutoff must exceed timeout + grace so an in-flight (not-yet-stale)
    // run is never swept — the exact buffer value can be retuned without breaking
    // this invariant. (jobTimeoutMs 60_000 + abortSettleGraceMs 5_000.)
    expect(sweepStaleJobRunsCalls[0].olderThanMs).toBeGreaterThan(60_000 + 5_000);

    const orphanAudit = auditEvents.find(
      (e) => e.type === "scheduler.job.run.failed" && e.payload.reason === "orphaned_on_sweep"
    );
    expect(orphanAudit).toBeTruthy();
    expect(orphanAudit!.payload.runId).toBe("run-orphan");
    expect(orphanAudit!.payload.jobId).toBe("job-9");
    expect(orphanAudit!.sessionId).toBe("session-9");
    expect(orphanAudit!.userId).toBe("user-1");
  });

  test("tick still executes due jobs when the stale-run sweep fails", async () => {
    const job = makeFakeJob();
    const { deps, jobRunsCompleted } = createFakeDeps({
      dueJobs: [job],
      sweepStaleJobRunsError: new Error("db unavailable")
    });
    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 1, jobTimeoutMs: 60_000 });
    await worker.tick();

    expect(jobRunsCompleted.length).toBe(1);
    expect(jobRunsCompleted[0].status).toBe("completed");
  });

  test("tick does not sweep stale runs when scheduling is disabled", async () => {
    const { deps, sweepStaleJobRunsCalls } = createFakeDeps({ dueJobs: [] });
    const worker = new SchedulerWorker(deps, {
      schedulingEnabled: false,
      maxConcurrentJobs: 1,
      jobTimeoutMs: 60_000
    });
    await worker.tick();

    expect(sweepStaleJobRunsCalls.length).toBe(0);
  });

  test("tick aborts the runtime and records failure when a job exceeds jobTimeoutMs", async () => {
    const job = makeFakeJob();

    // A deferred the hanging stream awaits; resolved only when abortSession runs.
    let releaseStream: (() => void) | null = null;
    const streamReleased = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });

    const { deps, runtimeAdapter, jobRunsCompleted, auditEvents, abortSessionCalls, messagesUpdated } = createFakeDeps({
      dueJobs: [job],
      runMessageImpl: async function* () {
        // Never yields a terminal event on its own — simulates a stuck turn.
        // It only ends once the runtime is aborted, mirroring the real runtime's
        // terminal RUN_ERROR and closed event queue.
        yield { type: EventType.RUN_STARTED, threadId: "session-1", runId: "resp-1" } as BaseEvent;
        await streamReleased;
        yield { type: EventType.RUN_ERROR, message: "aborted" } as BaseEvent;
      }
    });

    // When the watchdog aborts (via the resolved adapter), unblock the hanging
    // stream so executeJob settles.
    runtimeAdapter.abortSession = async (input) => {
      abortSessionCalls.push(input);
      releaseStream?.();
    };

    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 1, jobTimeoutMs: 10 });

    await worker.tick();

    // The watchdog aborts, and reclamation aborts again unconditionally (the
    // second is a no-op on the real adapter). Asserting an exact count here
    // would push the code back toward skipping reclamation's abort on
    // `timedOut`, which is exactly the bug the two tests below cover — so assert
    // the abort HAPPENED and targeted the right session instead.
    expect(abortSessionCalls.length).toBeGreaterThanOrEqual(1);
    expect(abortSessionCalls.every((c) => c.sessionId === "session-1")).toBe(true);
    expect(abortSessionCalls.every((c) => c.userId === "user-1")).toBe(true);

    expect(jobRunsCompleted.length).toBe(1);
    expect(jobRunsCompleted[0].status).toBe("failed");
    expect(jobRunsCompleted[0].errorMessage).toMatch(/timed out/);
    // The runtime's own "aborted" error loses to the timeout on the row too.
    expect(messagesUpdated).toEqual([
      expect.objectContaining({ status: "error", content: "Scheduled job timed out after 10ms" })
    ]);

    const failedAudit = auditEvents.find((e) => e.type === "scheduler.job.run.failed");
    expect(failedAudit).toBeTruthy();
  });

  test("a timeout during the usage read fails the row and the run", async () => {
    // The usage read runs before finalization, so a timeout that fires while
    // it waits still counts.
    const job = makeFakeJob();
    let watchdogFired!: () => void;
    const getOwnedGate = new Promise<void>((resolve) => { watchdogFired = resolve; });
    const { deps, runtimeAdapter, jobRunsCompleted, messagesUpdated, recordOutcomeCalls } = createFakeDeps({
      dueJobs: [job],
      getOwnedGate
    });
    // The first abort comes from the watchdog; only then does the usage read end.
    runtimeAdapter.abortSession = async () => { watchdogFired(); };
    const worker = new SchedulerWorker(deps, {
      maxConcurrentJobs: 1,
      jobTimeoutMs: 50,
      abortSettleGraceMs: 1_000
    });

    await worker.tick();

    expect(messagesUpdated).toEqual([
      expect.objectContaining({ status: "error", content: "Hello from scheduler" })
    ]);
    expect(jobRunsCompleted).toHaveLength(1);
    expect(jobRunsCompleted[0]).toMatchObject({ status: "failed", errorMessage: "Scheduled job timed out after 50ms" });
    expect(recordOutcomeCalls).toEqual([{ tenantId: job.tenantId, jobId: job.jobId, succeeded: false }]);
  });

  test.each(["text/status", "tool result"] as const)(
    "a timeout while the final %s write is blocked fails the row and the run",
    async (blocked) => {
      const job = makeFakeJob();
      let watchdogFired!: () => void;
      const writeGate = new Promise<void>((resolve) => { watchdogFired = resolve; });
      const { deps, runtimeAdapter, jobRunsCompleted, messagesUpdated, toolResultsSaved, purgeSessionDataCalls,
        auditEvents, recordOutcomeCalls } = createFakeDeps({
        dueJobs: [job],
        runtimeEvents: [[
          { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "done" },
          { type: EventType.TOOL_CALL_START, toolCallId: "call-1", toolCallName: "execute" },
          { type: EventType.TOOL_CALL_RESULT, toolCallId: "call-1", messageId: "t", content: "ok" },
          { type: EventType.RUN_FINISHED, threadId: "session-1", runId: "resp-1" }
        ] as BaseEvent[]]
      });
      // The first write of the blocked kind waits until the watchdog aborts.
      if (blocked === "text/status") {
        const write = deps.messages.updateContent;
        let calls = 0;
        deps.messages.updateContent = async (...args) => {
          calls += 1;
          if (calls === 1) await writeGate;
          return write(...args);
        };
      } else {
        const write = deps.messages.upsertToolResult;
        deps.messages.upsertToolResult = async (input) => {
          await writeGate;
          return write(input);
        };
      }
      const abortSession = runtimeAdapter.abortSession;
      runtimeAdapter.abortSession = async (input) => {
        watchdogFired();
        await abortSession(input);
      };
      const worker = new SchedulerWorker(deps, {
        maxConcurrentJobs: 1,
        jobTimeoutMs: 50,
        abortSettleGraceMs: 1_000
      });

      await worker.tick();

      // The runtime outcome is saved first, then replaced by the timeout.
      expect(messagesUpdated.map((update) => update.status)).toEqual(["completed", "error"]);
      expect(messagesUpdated.at(-1)).toMatchObject({ content: "done" });
      expect(toolResultsSaved).toEqual([expect.objectContaining({ toolResultId: "call-1" })]);
      expect(jobRunsCompleted).toHaveLength(1);
      expect(jobRunsCompleted[0]).toMatchObject({ status: "failed", errorMessage: "Scheduled job timed out after 50ms" });
      expect(auditEvents.filter((event) => event.type.startsWith("scheduler.job.run."))
        .map((event) => event.type)).toEqual(["scheduler.job.run.failed"]);
      expect(recordOutcomeCalls).toEqual([{ tenantId: job.tenantId, jobId: job.jobId, succeeded: false }]);
      expect(purgeSessionDataCalls).toHaveLength(1);
    }
  );

  test("a timeout during cleanup after the transcript is final keeps the run completed", async () => {
    const job = makeFakeJob();
    let watchdogFired!: () => void;
    const cleanupGate = new Promise<void>((resolve) => { watchdogFired = resolve; });
    const { deps, runtimeAdapter, jobRunsCompleted, messagesUpdated, recordOutcomeCalls, purgeSessionDataCalls } =
      createFakeDeps({ dueJobs: [job] });
    // Cleanup aborts first and waits there. The second abort comes from the
    // watchdog, which then lets cleanup continue.
    let aborts = 0;
    runtimeAdapter.abortSession = async () => {
      aborts += 1;
      if (aborts === 1) await cleanupGate;
      else watchdogFired();
    };
    const worker = new SchedulerWorker(deps, {
      maxConcurrentJobs: 1,
      jobTimeoutMs: 50,
      abortSettleGraceMs: 1_000
    });

    await worker.tick();

    expect(aborts).toBe(2);
    expect(messagesUpdated).toEqual([
      expect.objectContaining({ status: "completed", content: "Hello from scheduler" })
    ]);
    expect(jobRunsCompleted).toHaveLength(1);
    expect(jobRunsCompleted[0]).toMatchObject({ status: "completed", errorMessage: null });
    expect(recordOutcomeCalls).toEqual([{ tenantId: job.tenantId, jobId: job.jobId, succeeded: true }]);
    expect(purgeSessionDataCalls).toHaveLength(1);
  });

  // R2: `timedOut` must never be treated as proof the runtime was aborted.
  // executeJobWithTimeout only aborts `if (turn.sessionId && turn.adapter)`, and
  // its abortSession can throw — in both cases reclamation holds the only
  // remaining chance to release the runtime and its E2B sandbox.

  test("reclamation still aborts when the watchdog's own abort threw", async () => {
    const job = makeFakeJob();

    let releaseStream: (() => void) | null = null;
    const streamReleased = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });

    const { deps, runtimeAdapter, abortSessionCalls } = createFakeDeps({
      dueJobs: [job],
      runMessageImpl: async function* () {
        yield { type: EventType.RUN_STARTED, threadId: "session-1", runId: "resp-1" } as BaseEvent;
        await streamReleased;
        yield { type: EventType.RUN_ERROR, message: "aborted" } as BaseEvent;
      }
    });

    let attempts = 0;
    runtimeAdapter.abortSession = async (input) => {
      attempts += 1;
      abortSessionCalls.push(input);
      if (attempts === 1) {
        // The watchdog's abort fails. It still unblocks the stream so the job
        // settles, but the runtime was NOT released.
        releaseStream?.();
        throw new Error("abort failed");
      }
    };

    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 1, jobTimeoutMs: 10 });
    await worker.tick();

    // A second attempt must follow the failed one, or the runtime leaks until
    // the idle timeout and the thread is purged out from under a live graph.
    expect(abortSessionCalls.length).toBeGreaterThanOrEqual(2);
  });

  test("reclamation does NOT purge the thread when every abort attempt failed", async () => {
    const job = makeFakeJob();

    let releaseStream: (() => void) | null = null;
    const streamReleased = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });

    const { deps, runtimeAdapter, abortSessionCalls, purgeSessionDataCalls } = createFakeDeps({
      dueJobs: [job],
      runMessageImpl: async function* () {
        yield { type: EventType.RUN_STARTED, threadId: "session-1", runId: "resp-1" } as BaseEvent;
        await streamReleased;
        yield { type: EventType.RUN_ERROR, message: "aborted" } as BaseEvent;
      }
    });

    // Every abort fails, so we can never conclude the graph stopped.
    runtimeAdapter.abortSession = async (input) => {
      abortSessionCalls.push(input);
      releaseStream?.();
      throw new Error("abort failed");
    };

    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 1, jobTimeoutMs: 10 });
    await worker.tick();

    expect(abortSessionCalls.length).toBeGreaterThanOrEqual(1);
    // Purging here would delete the checkpointer thread beneath a graph that may
    // still be writing. An orphaned thread is the cheaper failure.
    expect(purgeSessionDataCalls.length).toBe(0);
  });

  test("reclamation purges the thread on the normal path, after a successful abort", async () => {
    const job = makeFakeJob();
    const { deps, abortSessionCalls, purgeSessionDataCalls } = createFakeDeps({ dueJobs: [job] });

    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 1, jobTimeoutMs: 5_000 });
    await worker.tick();

    expect(abortSessionCalls.length).toBe(1);
    expect(purgeSessionDataCalls.length).toBe(1);
    expect(purgeSessionDataCalls[0].sessionId).toBe("session-1");
  });

  test("reclamation aborts the runtime resolved after a watchdog timeout fired", async () => {
    vi.useFakeTimers();
    try {
      const job = makeFakeJob();

      const { deps, runtimeAdapter, abortSessionCalls, purgeSessionDataCalls } = createFakeDeps({
        dueJobs: [job],
        // Resolve the runtime only AFTER the watchdog has already fired, so
        // `turn.adapter` was still null when executeJobWithTimeout checked it and
        // no abort happened there.
        resolveRuntimeDelayMs: 40,
        runMessageImpl: async function* () {
          yield {
            type: EventType.RUN_FINISHED,
            threadId: "session-1",
            runId: "resp-1"
          } as BaseEvent;
        }
      });
      runtimeAdapter.abortSession = async (input) => {
        abortSessionCalls.push(input);
      };

      const worker = new SchedulerWorker(deps, {
        maxConcurrentJobs: 1,
        jobTimeoutMs: 10,
        abortSettleGraceMs: 500
      });
      const tick = worker.tick();
      await vi.advanceTimersByTimeAsync(10);
      expect(abortSessionCalls).toHaveLength(0);
      expect(purgeSessionDataCalls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(40);
      await tick;

      expect(abortSessionCalls.length).toBe(1);
      expect(abortSessionCalls[0].sessionId).toBe("session-1");
      expect(purgeSessionDataCalls.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a watchdog timeout before the runtime session exists starts no turn", async () => {
    vi.useFakeTimers();
    try {
      const job = makeFakeJob();
      const { deps, runtimeSessionsCreated, runMessageCalls, jobRunsCompleted, messagesUpdated } = createFakeDeps({
        dueJobs: [job],
        // The watchdog fires while the runtime resolves, so it has no session to abort.
        resolveRuntimeDelayMs: 40
      });
      const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 1, jobTimeoutMs: 10, abortSettleGraceMs: 500 });
      const tick = worker.tick();
      await vi.advanceTimersByTimeAsync(50);
      await tick;

      expect(runtimeSessionsCreated).toHaveLength(0);
      expect(runMessageCalls).toHaveLength(0);
      expect(jobRunsCompleted).toHaveLength(1);
      expect(jobRunsCompleted[0]).toMatchObject({ status: "failed", errorMessage: "Scheduled job timed out after 10ms" });
      expect(messagesUpdated).toEqual([
        expect.objectContaining({ status: "error", content: "Scheduled job timed out after 10ms" })
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("tick releases the slot after the abort grace even when the turn never settles", async () => {
    const firstJob = makeFakeJob();
    const secondJob = makeFakeJob({ jobId: "job-2" });
    const dueJobs = [firstJob];
    let turnsStarted = 0;
    const { deps, runtimeAdapter, claimsCalled, jobRunsCreated } = createFakeDeps({
      dueJobs,
      claimReturns: [firstJob, secondJob],
      runMessageImpl: async function* () {
        turnsStarted += 1;
        if (turnsStarted === 1) {
          yield { type: EventType.RUN_STARTED, threadId: "session-1", runId: "resp-1" } as BaseEvent;
          await new Promise<void>(() => {});
        }
        yield { type: EventType.RUN_FINISHED, threadId: "session-2", runId: "resp-2" } as BaseEvent;
      }
    });
    runtimeAdapter.abortSession = async () => {};
    const worker = new SchedulerWorker(deps, {
      maxConcurrentJobs: 1,
      jobTimeoutMs: 5,
      abortSettleGraceMs: 10
    });

    await worker.tick();
    expect(turnsStarted).toBe(1);
    dueJobs.splice(0, 1, secondJob);
    await worker.tick();

    expect(claimsCalled.map((claim) => claim.jobId)).toEqual(["job-1", "job-2"]);
    expect(jobRunsCreated.map((run) => run.jobId)).toEqual(["job-1", "job-2"]);
    expect(turnsStarted).toBe(2);
  });

  test("tick skips job when claim returns null", async () => {
    const job = makeFakeJob();
    const { deps, sessionsCreated, jobRunsCreated } = createFakeDeps({
      dueJobs: [job],
      claimReturns: [null]
    });
    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 5, jobTimeoutMs: 60_000 });
    await worker.tick();

    expect(sessionsCreated.length).toBe(0);
    expect(jobRunsCreated.length).toBe(0);
  });

  test("tick respects concurrency limit", async () => {
    const jobs = [
      makeFakeJob({ jobId: "job-1", jobName: "Job 1" }),
      makeFakeJob({ jobId: "job-2", jobName: "Job 2" }),
      makeFakeJob({ jobId: "job-3", jobName: "Job 3" })
    ];
    const { deps, sessionsCreated } = createFakeDeps({
      dueJobs: jobs,
      claimReturns: [jobs[0], jobs[1], jobs[2]],
      runtimeEvents: [
        [
          { type: EventType.RUN_STARTED, threadId: "session-1", runId: "resp-1" } as BaseEvent,
          { type: EventType.RUN_FINISHED, threadId: "session-1", runId: "resp-1" } as BaseEvent
        ],
        [
          { type: EventType.RUN_STARTED, threadId: "session-2", runId: "resp-2" } as BaseEvent,
          { type: EventType.RUN_FINISHED, threadId: "session-2", runId: "resp-2" } as BaseEvent
        ],
        [
          { type: EventType.RUN_STARTED, threadId: "session-3", runId: "resp-3" } as BaseEvent,
          { type: EventType.RUN_FINISHED, threadId: "session-3", runId: "resp-3" } as BaseEvent
        ]
      ]
    });
    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 2, jobTimeoutMs: 60_000 });
    await worker.tick();

    // Only 2 jobs should have been claimed and executed
    expect(sessionsCreated.length).toBe(2);
  });

  test("overlapping ticks cannot exceed maxConcurrentJobs (slot reserved before the claim await)", async () => {
    // `available` is computed before any await, so a stalled tick
    // plus the next interval firing would both admit with the same headroom.
    // The slot must be reserved synchronously before the claim await.
    const job1 = makeFakeJob({ jobId: "job-1" });
    const job2 = makeFakeJob({ jobId: "job-2" });
    const { deps, claimsCalled, sessionsCreated } = createFakeDeps({
      dueJobs: [job1, job2],
      claimReturns: [job1, job2]
    });

    // Stall the first claim so a second tick can overlap it.
    let releaseClaim = () => {};
    const claimGate = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    const originalClaim = deps.settings.claimJob.bind(deps.settings);
    deps.settings.claimJob = async (tenantId, jobId, nextRunAt) => {
      if (jobId === "job-1") {
        await claimGate;
      }
      return originalClaim(tenantId, jobId, nextRunAt);
    };

    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 1, jobTimeoutMs: 60_000 });

    const tick1 = worker.tick();
    const tick2 = worker.tick();
    // Let tick2 run to completion while tick1 is parked on the claim await —
    // it must see the reserved slot and admit nothing.
    await tick2;
    releaseClaim();
    await tick1;

    expect(claimsCalled.map((c) => c.jobId)).toEqual(["job-1"]);
    expect(sessionsCreated.length).toBe(1);
  });

  test("overlapping ticks cannot exceed the PII concurrency cap, and unused reservations are released", async () => {
    const { deps } = createFakeDeps({ dueJobs: [] });

    const now = new Date().toISOString();
    const makePiiJob = (jobId: string) => ({
      tenantId: "test-tenant",
      jobId,
      scanRunId: "scan-1",
      subjectType: "artifact" as const,
      subjectId: "art-1",
      sourceSessionId: null,
      sourceUserId: "user-1",
      mode: "detect" as const,
      payload: {},
      status: "queued" as const,
      attempts: 0,
      maxAttempts: 3,
      runAfter: now,
      claimedAt: null,
      completedAt: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now
    });

    let releaseClaim = () => {};
    const claimGate = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    const claimCalls: number[] = [];
    deps.piiScanJobs = {
      async sweepStaleClaims() {
        return 0;
      },
      async listUnfinishedFailures() {
        return [];
      },
      async claimDueJobs(limit: number) {
        claimCalls.push(limit);
        if (claimCalls.length === 1) {
          await claimGate;
          // Cap is 2, reservation took both slots, but only one job exists.
          return [makePiiJob("pii-1")];
        }
        return [];
      }
    };
    deps.piiScanJobHandler = {
      async finishFailedJob() {},
      async execute() {
        await new Promise<void>(() => {}); // hangs — keeps the slot occupied
      }
    };

    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 5, maxConcurrentPiiJobs: 2, jobTimeoutMs: 60_000 });

    const tick1 = worker.tick();
    // Overlapping tick while tick1 is parked inside claimDueJobs: the full
    // headroom (2) is already reserved, so this tick must not claim at all.
    const tick2 = worker.tick();
    await tick2;
    expect(claimCalls).toEqual([2]);

    releaseClaim();
    // tick1 never resolves (the handler hangs), but the claim has settled —
    // give the microtask queue a beat so the unused reservation is released.
    await new Promise((resolve) => setImmediate(resolve));

    // One job is running (1 slot held), the second reserved slot was released:
    // a later tick has exactly 1 slot of headroom again.
    const tick3 = worker.tick();
    await tick3;
    expect(claimCalls).toEqual([2, 1]);
    void tick1;
  });

  test("tick closes the scan run of each failed PII job and continues after an error", async () => {
    const { deps } = createFakeDeps({ dueJobs: [] });
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    deps.logger = logger;
    const now = new Date().toISOString();
    const failedJob = (jobId: string) => ({
      tenantId: "test-tenant", jobId, scanRunId: `scan-${jobId}`, subjectType: "artifact" as const,
      subjectId: `art-${jobId}`, sourceSessionId: null, sourceUserId: "user-1", mode: "detect" as const,
      payload: {}, status: "failed" as const, attempts: 3, maxAttempts: 3, runAfter: now, claimedAt: null,
      completedAt: now, errorMessage: "claim expired", createdAt: now, updatedAt: now
    });
    const finished: string[] = [];
    deps.piiScanJobs = {
      async sweepStaleClaims() {
        return 1;
      },
      async listUnfinishedFailures() {
        return [failedJob("pii-1"), failedJob("pii-2")];
      },
      async claimDueJobs() {
        return [];
      }
    };
    deps.piiScanJobHandler = {
      async finishFailedJob(job) {
        if (job.jobId === "pii-1") throw new Error("subject write unavailable");
        finished.push(job.jobId);
      },
      async execute() {}
    };

    await new SchedulerWorker(deps, { maxConcurrentJobs: 2, jobTimeoutMs: 60_000 }).tick();

    expect(finished).toEqual(["pii-2"]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "pii-1" }),
      "Failed to close the scan run of a failed PII scan job"
    );
  });

  test("tick drains PII scan jobs when the subsystem is wired", async () => {
    const { deps } = createFakeDeps({ dueJobs: [] });

    const now = new Date().toISOString();
    const piiJob = {
      tenantId: "test-tenant",
      jobId: "pii-job-1",
      scanRunId: "scan-1",
      subjectType: "artifact" as const,
      subjectId: "art-1",
      sourceSessionId: null,
      sourceUserId: "user-1",
      mode: "detect" as const,
      payload: {},
      status: "queued" as const,
      attempts: 0,
      maxAttempts: 3,
      runAfter: now,
      claimedAt: null,
      completedAt: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now
    };

    const claimed: typeof piiJob[] = [];
    const executed: typeof piiJob[] = [];
    deps.piiScanJobs = {
      async sweepStaleClaims() {
        return 0;
      },
      async listUnfinishedFailures() {
        return [];
      },
      async claimDueJobs(limit: number) {
        claimed.push(piiJob);
        return claimed.slice(0, limit);
      }
    };
    deps.piiScanJobHandler = {
      async finishFailedJob() {},
      async execute(job) {
        executed.push(job as typeof piiJob);
      }
    };

    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 2, jobTimeoutMs: 60_000 });
    await worker.tick();

    expect(claimed.length).toBe(1);
    expect(executed.length).toBe(1);
    expect(executed[0].jobId).toBe("pii-job-1");
  });

  test("tick drains PII scan jobs but skips cron jobs when schedulingEnabled is false", async () => {
    const cronJob = makeFakeJob();
    const { deps, sessionsCreated } = createFakeDeps({
      dueJobs: [cronJob],
      claimReturns: [cronJob]
    });

    const now = new Date().toISOString();
    const piiJob = {
      tenantId: "test-tenant",
      jobId: "pii-job-1",
      scanRunId: "scan-1",
      subjectType: "artifact" as const,
      subjectId: "art-1",
      sourceSessionId: null,
      sourceUserId: "user-1",
      mode: "detect" as const,
      payload: {},
      status: "queued" as const,
      attempts: 0,
      maxAttempts: 3,
      runAfter: now,
      claimedAt: null,
      completedAt: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now
    };

    const executed: typeof piiJob[] = [];
    deps.piiScanJobs = {
      async sweepStaleClaims() {
        return 0;
      },
      async listUnfinishedFailures() {
        return [];
      },
      async claimDueJobs(limit: number) {
        return [piiJob].slice(0, limit);
      }
    };
    deps.piiScanJobHandler = {
      async finishFailedJob() {},
      async execute(job) {
        executed.push(job as typeof piiJob);
      }
    };

    const worker = new SchedulerWorker(deps, {
      schedulingEnabled: false,
      maxConcurrentJobs: 2,
      jobTimeoutMs: 60_000
    });
    await worker.tick();

    // PII drain still runs...
    expect(executed.length).toBe(1);
    expect(executed[0].jobId).toBe("pii-job-1");
    // ...but the cron half is skipped entirely (no scheduled turn executed).
    expect(sessionsCreated.length).toBe(0);
  });

  test("tick continues when the PII handler rejects", async () => {
    const { deps } = createFakeDeps({ dueJobs: [] });

    const now = new Date().toISOString();
    const piiJob = {
      tenantId: "test-tenant",
      jobId: "pii-job-err",
      scanRunId: "scan-1",
      subjectType: "artifact" as const,
      subjectId: "art-1",
      sourceSessionId: null,
      sourceUserId: "user-1",
      mode: "detect" as const,
      payload: {},
      status: "queued" as const,
      attempts: 0,
      maxAttempts: 3,
      runAfter: now,
      claimedAt: null,
      completedAt: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now
    };

    deps.piiScanJobs = {
      async sweepStaleClaims() {
        return 0;
      },
      async listUnfinishedFailures() {
        return [];
      },
      async claimDueJobs() {
        return [piiJob];
      }
    };
    deps.piiScanJobHandler = {
      async finishFailedJob() {},
      async execute() {
        throw new Error("handler exploded");
      }
    };

    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 2, jobTimeoutMs: 60_000 });
    await expect(worker.tick()).resolves.toBeUndefined();
  });
});

describe("SchedulerWorker chat-prompt PII policy", () => {
  function runWithPii(evaluateText: () => Promise<PiiDecision>) {
    const fake = createFakeDeps({ dueJobs: [makeFakeJob({ input: { prompt: "Email jane@example.com" } })] });
    fake.deps.piiProtection = { evaluateText };
    fake.deps.piiScanRuns = { create: async () => ({ scanRunId: "scan-1" }) };
    const worker = new SchedulerWorker(fake.deps, { maxConcurrentJobs: 1, jobTimeoutMs: 60_000, maxConsecutiveFailures: 5 });
    return { ...fake, run: () => worker.tick() };
  }
  const finding: PiiFinding = { entityType: "email", value: "jane@example.com", start: 6, end: 22, confidence: "high" };

  test("a blocked prompt fails the run without saving the prompt or calling the model", async () => {
    const { run, runMessageCalls, jobRunsCompleted, messagesCreated, recordOutcomeCalls, auditEvents } = runWithPii(
      async () => ({ action: "block", findings: [finding], blockReason: "email", providerType: null, providerModel: null })
    );
    await run();

    expect(runMessageCalls).toEqual([]);
    expect(jobRunsCompleted[0]).toMatchObject({ status: "failed" });
    expect(jobRunsCompleted[0].errorMessage).toContain("blocked by organization policy (email)");
    expect(messagesCreated.map((m) => m.role)).toEqual(["system"]);
    expect(messagesCreated.some((m) => m.content.includes("jane@example.com"))).toBe(false);
    expect(auditEvents.some((e) => e.type === "pii_blocked")).toBe(true);
    // The prompt never changes, so a block counts toward auto-disable.
    expect(recordOutcomeCalls).toEqual([{ tenantId: "test-tenant", jobId: "job-1", succeeded: false }]);
  });

  test("a transformed prompt is saved and sent in its transformed form", async () => {
    const { run, runMessageCalls, messagesCreated, jobRunsCompleted } = runWithPii(async () => ({
      action: "transform", transformedText: "Email [EMAIL]", findings: [finding], providerType: null, providerModel: null
    }));
    await run();

    expect(jobRunsCompleted[0]).toMatchObject({ status: "completed" });
    expect(runMessageCalls[0].prompt).toBe("Email [EMAIL]");
    expect(messagesCreated.find((m) => m.role === "user")?.content).toBe("Email [EMAIL]");
  });

  test("a provider outage fails the run but does not count toward auto-disable", async () => {
    const { run, runMessageCalls, jobRunsCompleted, messagesCreated, recordOutcomeCalls } = runWithPii(async () => {
      throw new PiiProtectionServiceError("pii_provider_unavailable", "down");
    });
    await run();

    expect(runMessageCalls).toEqual([]);
    expect(messagesCreated).toEqual([]);
    expect(jobRunsCompleted[0]).toMatchObject({ status: "failed" });
    expect(jobRunsCompleted[0].errorMessage).toContain("PII protection was unavailable");
    expect(recordOutcomeCalls).toEqual([]);
  });

  test("a permanent PII error counts toward auto-disable", async () => {
    const { run, runMessageCalls, recordOutcomeCalls } = runWithPii(async () => {
      throw new PiiProtectionServiceError("file_too_large", "Prompt is too large to scan.");
    });
    await run();

    expect(runMessageCalls).toEqual([]);
    expect(recordOutcomeCalls).toEqual([{ tenantId: "test-tenant", jobId: "job-1", succeeded: false }]);
  });
});

// Each tick starts the retention cleanups in the background. What counts as
// expired is the stores' job; the worker must hand them the right storage,
// report what they removed, contain a failure, and never run two at once.
describe("SchedulerWorker retention cleanup", () => {
  type CleanupCase = {
    name: string;
    wire: (deps: SchedulerWorkerDeps, cleanupExpired: ReturnType<typeof vi.fn>, storage: { delete: () => Promise<void> } | undefined) => void;
    removed: Record<string, number>;
    nothing: Record<string, number>;
    logged: string;
    failed: string;
  };
  const cases: CleanupCase[] = [
    {
      name: "session Trash",
      wire: (deps, cleanupExpired, storage) => {
        deps.sessionTrash = { cleanupExpired } as unknown as SchedulerWorkerDeps["sessionTrash"];
        deps.sessionStorage = storage;
      },
      removed: { deletedSessions: 2, deletedObjects: 3, purgedRuntimes: 1 },
      nothing: { deletedSessions: 0, deletedObjects: 0, purgedRuntimes: 0 },
      logged: "Expired session Trash cleaned up",
      failed: "Expired session Trash cleanup failed; will retry"
    },
    {
      name: "project files",
      wire: (deps, cleanupExpired, storage) => {
        deps.projectFiles = { cleanupExpired } as unknown as SchedulerWorkerDeps["projectFiles"];
        deps.projectFileStorage = storage;
      },
      removed: { deletedFiles: 4, deletedObjects: 5 },
      nothing: { deletedFiles: 0, deletedObjects: 0 },
      logged: "Expired project files cleaned up",
      failed: "Expired project file cleanup failed; will retry"
    }
  ];

  function setup(cleanupCase: CleanupCase, cleanupExpired: ReturnType<typeof vi.fn>, withStorage = true) {
    const fake = createFakeDeps({ dueJobs: [] });
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    fake.deps.logger = logger;
    const storage = withStorage ? { delete: async () => undefined } : undefined;
    cleanupCase.wire(fake.deps, cleanupExpired, storage);
    const worker = new SchedulerWorker(fake.deps, { maxConcurrentJobs: 1, jobTimeoutMs: 60_000 });
    return { worker, logger, storage, fake };
  }

  test.each(cases)("hands the storage to the $name cleanup and logs what it removed", async (cleanupCase) => {
    const cleanupExpired = vi.fn(async (_storage: unknown, _options?: unknown) => cleanupCase.removed);
    const { worker, logger, storage } = setup(cleanupCase, cleanupExpired);

    await worker.tick();

    await vi.waitFor(() => expect(logger.info).toHaveBeenCalledWith(cleanupCase.removed, cleanupCase.logged));
    expect(cleanupExpired.mock.calls[0]![0]).toBe(storage);
  });

  test.each(cases)("logs nothing when the $name cleanup removed nothing", async (cleanupCase) => {
    const cleanupExpired = vi.fn(async () => cleanupCase.nothing);
    const { worker, logger } = setup(cleanupCase, cleanupExpired);

    await worker.tick();

    await vi.waitFor(() => expect(cleanupExpired).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));
    expect(logger.info).not.toHaveBeenCalled();
  });

  test.each(cases)("contains a failed $name cleanup and retries it on the next tick", async (cleanupCase) => {
    const cleanupExpired = vi.fn()
      .mockRejectedValueOnce(new Error("storage down"))
      .mockResolvedValueOnce(cleanupCase.removed);
    const { worker, logger } = setup(cleanupCase, cleanupExpired);

    await expect(worker.tick()).resolves.toBeUndefined();
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledWith({ error: expect.any(Error) }, cleanupCase.failed));

    await worker.tick();
    await vi.waitFor(() => expect(logger.info).toHaveBeenCalledWith(cleanupCase.removed, cleanupCase.logged));
    expect(cleanupExpired).toHaveBeenCalledTimes(2);
  });

  test.each(cases)("does not start a second $name cleanup while one runs", async (cleanupCase) => {
    let finish!: () => void;
    const cleanupExpired = vi.fn()
      .mockReturnValueOnce(new Promise((resolve) => { finish = () => resolve(cleanupCase.nothing); }))
      .mockResolvedValue(cleanupCase.nothing);
    const { worker } = setup(cleanupCase, cleanupExpired);

    await worker.tick();
    await worker.tick();
    expect(cleanupExpired).toHaveBeenCalledTimes(1);

    finish();
    // Once the first cleanup settles, the next tick may start another.
    await vi.waitFor(async () => {
      await worker.tick();
      expect(cleanupExpired).toHaveBeenCalledTimes(2);
    });
  });

  test.each(cases)("skips the $name cleanup when its storage is not wired", async (cleanupCase) => {
    const cleanupExpired = vi.fn(async () => cleanupCase.removed);
    const { worker } = setup(cleanupCase, cleanupExpired, false);

    await worker.tick();
    await new Promise((resolve) => setImmediate(resolve));

    expect(cleanupExpired).not.toHaveBeenCalled();
  });

  test("lets the session Trash cleanup purge a runtime through the runtime adapter", async () => {
    const target = { tenantId: "tenant-a", sessionId: "session-1", userId: "user-1" };
    const cleanupExpired = vi.fn(async (_storage: unknown, options: { purgeRuntime: (input: typeof target) => Promise<void> }) => {
      await options.purgeRuntime(target);
      return cases[0]!.removed;
    });
    const { worker, fake } = setup(cases[0]!, cleanupExpired);

    await worker.tick();

    await vi.waitFor(() => expect(fake.purgeSessionDataCalls).toEqual([target]));
  });
});
