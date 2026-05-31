import { describe, test, beforeEach, expect } from "vitest";

import type { FastifyBaseLogger } from "fastify";

import type { RuntimeEvent, RuntimeSessionRef } from "../runtime-contracts.js";
import type { SessionRecord } from "./session-store.js";
import type { MessageRecord } from "./message-store.js";
import type { ToolExecutionContext } from "./auth/tool-execution-context-store.js";
import type { ScheduledJobRecord } from "./user-settings-store.js";
import { SchedulerWorker, type SchedulerWorkerDeps } from "./scheduler-worker.js";

function makeFakeSessionRef(sessionId: string): RuntimeSessionRef {
  return {
    sessionId,
    runtimeId: `rt-${sessionId}`,
    runtimePolicy: {
      id: "default-profile",
      label: "Default",
      runtimeProvider: "codex" as const,
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      networkMode: "restricted",
      allowCommandExecution: true,
      allowUserTokenForwarding: false,
      autoApproveReadOnlyTools: false,
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
  role: "user" | "assistant",
  status: "pending" | "streaming" | "completed" | "error",
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
    planContent: "",
    tokenUsage: null,
    modelName: null,
    costUsd: null,
    feedbackRating: null,
    toolResults: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

function createFakeDeps(options?: {
  dueJobs?: ScheduledJobRecord[];
  claimReturns?: (ScheduledJobRecord | null)[];
  runtimeEvents?: RuntimeEvent[][];
  runMessageImpl?: (
    session: RuntimeSessionRef,
    input: { prompt: string }
  ) => AsyncIterable<RuntimeEvent>;
  /** Token usage the LLM proxy is pretended to have persisted on the assistant row. */
  assistantTokenUsage?: { inputTokens: number; outputTokens: number };
}) {
  const dueJobs = options?.dueJobs ?? [];
  const claimReturns = options?.claimReturns ?? dueJobs.map((j) => j);
  const runtimeEventsPerCall = options?.runtimeEvents ?? [
    [
      { type: "response.created", responseId: "resp-1" },
      { type: "response.output_text.delta", responseId: "resp-1", delta: "Hello from scheduler" },
      { type: "response.completed", responseId: "resp-1" }
    ]
  ];

  let claimIndex = 0;
  let runtimeCallIndex = 0;

  const sessionsCreated: Array<{ userId: string; sessionName: string }> = [];
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
    ttlMs: number;
  }> = [];
  const runtimeSessionsCreated: Array<{ sessionId: string; userId: string }> = [];
  const runMessageCalls: Array<{ sessionId: string; prompt: string }> = [];
  const abortSessionCalls: Array<{ tenantId: string; sessionId: string; userId: string }> = [];
  const auditEvents: Array<{
    sessionId: string | null;
    userId: string;
    type: string;
    payload: Record<string, unknown>;
  }> = [];
  const recordOutcomeCalls: Array<{ tenantId: string; jobId: string; succeeded: boolean }> = [];
  const failureCounts = new Map<string, number>();

  const deps: SchedulerWorkerDeps = {
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
      }
    },
    sessions: {
      create: async (_tenantId: string, userId: string, sessionName: string): Promise<SessionRecord> => {
        sessionsCreated.push({ userId, sessionName });
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
          metadata: {},
          expiresAt: new Date(Date.now() + input.ttlMs).toISOString(),
          createdAt: new Date().toISOString()
        } satisfies ToolExecutionContext;
      }
    },
    runtimeManager: {
      createSession: async (input) => {
        runtimeSessionsCreated.push(input);
        return makeFakeSessionRef(input.sessionId);
      },
      runMessage: function (_session, input) {
        runMessageCalls.push({ sessionId: _session.sessionId, prompt: input.prompt });
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
      getRuntimePolicyId: async () => "default-profile"
    },
    auditEvents: {
      create: async (input) => {
        auditEvents.push(input);
      }
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      fatal: () => {},
      trace: () => {},
      child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, fatal: () => {}, trace: () => {}, child: () => ({}) }) as unknown
    } as unknown as FastifyBaseLogger
  };

  return {
    deps,
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
    const { deps, sessionsCreated, jobRunsCreated, jobRunsCompleted, messagesCreated, auditEvents } =
      createFakeDeps({ dueJobs: [job] });
    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 5, jobTimeoutMs: 60_000 });
    await worker.tick();

    expect(sessionsCreated.length).toBe(1);
    expect(sessionsCreated[0].sessionName).toBe("[Scheduled] Daily report");
    expect(sessionsCreated[0].userId).toBe("user-1");

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

    const completedAudit = auditEvents.find((e) => e.type === "scheduler.job.run.completed");
    expect(completedAudit).toBeTruthy();
    expect(completedAudit.userId).toBe("user-1");
  });

  test("tick records failure when runtime yields response.failed", async () => {
    const job = makeFakeJob();
    const failedEvents: RuntimeEvent[] = [
      { type: "response.created", responseId: "resp-1" },
      { type: "response.failed", responseId: "resp-1", message: "Something went wrong" }
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
    const failedEvents: RuntimeEvent[] = [
      { type: "response.created", responseId: "resp-1" },
      { type: "response.failed", responseId: "resp-1", message: "boom" }
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
    const failedEvents: RuntimeEvent[] = [
      { type: "response.created", responseId: "resp-1" },
      { type: "response.failed", responseId: "resp-1", message: "boom" }
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
    expect(disabledAudit).toBeTruthy();
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
    expect(disabledAudit).toBeTruthy();
    expect(disabledAudit.payload.disabled).toBe(false);
  });

  test("tick aborts the runtime and records failure when a job exceeds jobTimeoutMs", async () => {
    const job = makeFakeJob();

    // A deferred the hanging stream awaits; resolved only when abortSession runs.
    let releaseStream: (() => void) | null = null;
    const streamReleased = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });

    const { deps, jobRunsCompleted, auditEvents, abortSessionCalls } = createFakeDeps({
      dueJobs: [job],
      runMessageImpl: async function* () {
        // Never yields a terminal event on its own — simulates a stuck turn.
        // It only ends once the runtime is aborted (mirrors the real runtime,
        // where requestRuntimeShutdown pushes response.failed and ends the queue).
        yield { type: "response.created", responseId: "resp-1" } as RuntimeEvent;
        await streamReleased;
        yield { type: "response.failed", responseId: "resp-1", message: "aborted" } as RuntimeEvent;
      }
    });

    // When the watchdog aborts, unblock the hanging stream so executeJob settles.
    deps.runtimeManager.abortSession = async (input) => {
      abortSessionCalls.push(input);
      releaseStream?.();
    };

    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 1, jobTimeoutMs: 10 });

    await worker.tick();

    expect(abortSessionCalls.length).toBe(1);
    expect(abortSessionCalls[0].sessionId).toBe("session-1");
    expect(abortSessionCalls[0].userId).toBe("user-1");

    expect(jobRunsCompleted.length).toBe(1);
    expect(jobRunsCompleted[0].status).toBe("failed");
    expect(jobRunsCompleted[0].errorMessage).toMatch(/timed out/);

    const failedAudit = auditEvents.find((e) => e.type === "scheduler.job.run.failed");
    expect(failedAudit).toBeTruthy();
  });

  test("tick releases the slot after the abort grace even when the turn never settles", async () => {
    const job = makeFakeJob();

    // A turn that hangs forever and is NOT released by abort — models a runtime
    // that ignores the abort. Without a bounded grace this would pin the slot.
    const { deps } = createFakeDeps({
      dueJobs: [job],
      runMessageImpl: async function* () {
        yield { type: "response.created", responseId: "resp-1" } as RuntimeEvent;
        await new Promise<void>(() => {}); // never resolves
      }
    });
    deps.runtimeManager.abortSession = async () => {
      // Intentionally does NOT unblock the stream.
    };

    const worker = new SchedulerWorker(deps, {
      maxConcurrentJobs: 1,
      jobTimeoutMs: 5,
      abortSettleGraceMs: 10
    });

    // The assertion that matters: tick resolves (the slot frees) rather than
    // hanging on the never-settling turn.
    await worker.tick();

    // Slot is free again, so a second tick can run.
    await worker.tick();
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
          { type: "response.created", responseId: "resp-1" },
          { type: "response.completed", responseId: "resp-1" }
        ],
        [
          { type: "response.created", responseId: "resp-2" },
          { type: "response.completed", responseId: "resp-2" }
        ],
        [
          { type: "response.created", responseId: "resp-3" },
          { type: "response.completed", responseId: "resp-3" }
        ]
      ]
    });
    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 2, jobTimeoutMs: 60_000 });
    await worker.tick();

    // Only 2 jobs should have been claimed and executed
    expect(sessionsCreated.length).toBe(2);
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
