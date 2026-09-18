import { describe, test, beforeEach, expect } from "vitest";

import { EventType, type BaseEvent } from "@ag-ui/client";

import type { RuntimeSessionRef } from "../runtime-contracts.js";
import type { SessionRecord } from "./session-store.js";
import type { MessageRecord } from "./message-store.js";
import type { ToolExecutionContext } from "./auth/tool-execution-context-store.js";
import type { ScheduledJobRecord } from "./user-settings-store.js";
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
    runtimePolicy: {
      id: "default-profile",
      label: "Default",
      description: null,
      webSearchMode: "disabled",
      approvalPolicy: "never",
      approvalReviewer: "user",
      sandboxMode: "workspace-write",
      networkMode: "restricted",
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
          userId,
          sessionName,
          status: "active",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
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
        return null;
      },
      getOwned: async (_tenantId: string, messageId: string, userId: string) => {
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

    const completedAudit = auditEvents.find((e) => e.type === "scheduler.job.run.completed");
    if (!completedAudit) throw new Error("Expected scheduler completion audit event.");
    expect(completedAudit.userId).toBe("user-1");
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
    const { deps, jobRunsCompleted, auditEvents } = createFakeDeps({
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

    // Nothing internal in the run row or the audit trail.
    const serialized = JSON.stringify({ runs: jobRunsCompleted, audit: auditEvents });
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
    const { deps, jobRunsCompleted, auditEvents } = createFakeDeps({
      dueJobs: [job],
      runtimeEvents: [failedEvents]
    });
    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 5, jobTimeoutMs: 60_000 });
    await worker.tick();

    expect(jobRunsCompleted.length).toBe(1);
    expect(jobRunsCompleted[0].status).toBe("failed");
    expect(jobRunsCompleted[0].errorMessage).toBe("Something went wrong");

    const failedAudit = auditEvents.find((e) => e.type === "scheduler.job.run.failed");
    expect(failedAudit).toBeTruthy();
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

    const { deps, runtimeAdapter, jobRunsCompleted, auditEvents, abortSessionCalls } = createFakeDeps({
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

    const failedAudit = auditEvents.find((e) => e.type === "scheduler.job.run.failed");
    expect(failedAudit).toBeTruthy();
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
    await worker.tick();

    expect(abortSessionCalls.length).toBe(1);
    expect(abortSessionCalls[0].sessionId).toBe("session-1");
    expect(purgeSessionDataCalls.length).toBe(1);
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
      async claimDueJobs(limit: number) {
        claimed.push(piiJob);
        return claimed.slice(0, limit);
      }
    };
    deps.piiScanJobHandler = {
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
      async claimDueJobs(limit: number) {
        return [piiJob].slice(0, limit);
      }
    };
    deps.piiScanJobHandler = {
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
      async claimDueJobs() {
        return [piiJob];
      }
    };
    deps.piiScanJobHandler = {
      async execute() {
        throw new Error("handler exploded");
      }
    };

    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 2, jobTimeoutMs: 60_000 });
    await expect(worker.tick()).resolves.toBeUndefined();
  });
});
