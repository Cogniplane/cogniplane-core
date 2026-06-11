import { describe, test, beforeEach, expect } from "vitest";

import type { FastifyBaseLogger } from "fastify";

import type { RuntimeAdapter, RuntimeEvent, RuntimeSessionRef } from "../runtime-contracts.js";
import type { SessionRecord } from "./session-store.js";
import type { MessageRecord } from "./message-store.js";
import type { ToolExecutionContext } from "./auth/tool-execution-context-store.js";
import type { ScheduledJobRecord } from "./user-settings-store.js";
import {
  SchedulerWorker,
  type SchedulerRuntimeResolution,
  type SchedulerWorkerDeps
} from "./scheduler-worker.js";

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
      policyEnforcementMode: "monitor",
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
    metadata: Record<string, unknown>;
    ttlMs: number;
  }> = [];
  const runtimeSessionsCreated: Array<{ sessionId: string; userId: string }> = [];
  const runMessageCalls: Array<{ sessionId: string; prompt: string; model?: string }> = [];
  const abortSessionCalls: Array<{ tenantId: string; sessionId: string; userId: string }> = [];
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
  // dispatches createSession/runMessage/abortSession to after resolution.
  const runtimeAdapter = {
    id: "codex",
    hasActiveTurn: () => false,
    createSession: async (input) => {
      runtimeSessionsCreated.push(input);
      return makeFakeSessionRef(input.sessionId);
    },
    runMessage: function (_session, input) {
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
    }
  } as RuntimeAdapter;

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
          metadata: input.metadata,
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
          metadata: input.metadata,
          expiresAt: new Date(Date.now() + input.ttlMs).toISOString(),
          createdAt: new Date().toISOString()
        } satisfies ToolExecutionContext;
      }
    },
    resolveRuntime: async (tenantId: string) => {
      resolveRuntimeCalls.push(tenantId);
      if (options?.resolveRuntimeImpl) {
        return options.resolveRuntimeImpl(tenantId);
      }
      return {
        kind: "ok",
        adapter: runtimeAdapter,
        provider: "codex",
        modelId: "codex-default-model"
      };
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
    expect(completedAudit).toBeTruthy();
    expect(completedAudit.userId).toBe("user-1");
  });

  test("tick resolves the runtime per job tenant and dispatches to the resolved adapter", async () => {
    // The worker must NOT be hard-wired to Codex — each job runs on
    // the adapter `resolveRuntime` picks for its tenant (the same resolution
    // the interactive /messages path performs).
    const jobs = [
      makeFakeJob({ jobId: "job-codex", tenantId: "tenant-codex" }),
      makeFakeJob({ jobId: "job-claude", tenantId: "tenant-claude" })
    ];

    const completedEvents: RuntimeEvent[] = [
      { type: "response.created", responseId: "resp-1" },
      { type: "response.completed", responseId: "resp-1" }
    ];
    const makeAdapter = (id: string, calls: string[]) =>
      ({
        id,
        hasActiveTurn: () => false,
        createSession: async (input: { sessionId: string }) => makeFakeSessionRef(input.sessionId),
        runMessage: function (_session: RuntimeSessionRef) {
          calls.push(_session.sessionId);
          return (async function* () {
            for (const event of completedEvents) {
              yield event;
            }
          })();
        },
        abortSession: async () => {}
      }) as unknown as RuntimeAdapter;

    const codexCalls: string[] = [];
    const claudeCalls: string[] = [];
    const codexAdapter = makeAdapter("codex", codexCalls);
    const claudeAdapter = makeAdapter("claude-code", claudeCalls);

    const { deps, resolveRuntimeCalls, jobRunsCompleted } = createFakeDeps({
      dueJobs: jobs,
      resolveRuntimeImpl: async (tenantId) =>
        tenantId === "tenant-claude"
          ? { kind: "ok", adapter: claudeAdapter, provider: "claude-code", modelId: "claude-model" }
          : { kind: "ok", adapter: codexAdapter, provider: "codex", modelId: "codex-model" }
    });
    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 5, jobTimeoutMs: 60_000 });
    await worker.tick();

    expect(resolveRuntimeCalls.sort()).toEqual(["tenant-claude", "tenant-codex"]);
    expect(codexCalls.length).toBe(1);
    expect(claudeCalls.length).toBe(1);
    expect(jobRunsCompleted.length).toBe(2);
    expect(jobRunsCompleted.every((run) => run.status === "completed")).toBe(true);
  });

  test("tick threads the resolved default model into runMessage", async () => {
    const job = makeFakeJob();
    const { deps, runMessageCalls } = createFakeDeps({ dueJobs: [job] });
    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 1, jobTimeoutMs: 60_000 });
    await worker.tick();

    expect(runMessageCalls.length).toBe(1);
    expect(runMessageCalls[0].model).toBe("codex-default-model");
  });

  test("tick records a failed run when runtime resolution fails, without touching any runtime", async () => {
    const job = makeFakeJob();
    const { deps, jobRunsCreated, jobRunsCompleted, runtimeSessionsCreated, messagesCreated, auditEvents, recordOutcomeCalls } =
      createFakeDeps({
        dueJobs: [job],
        resolveRuntimeImpl: async () => ({
          kind: "error",
          message: "The Claude Code runtime adapter is not available on this server."
        })
      });
    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 1, jobTimeoutMs: 60_000 });
    await worker.tick();

    // The run row exists and is completed as failed with the resolver's reason.
    expect(jobRunsCreated.length).toBe(1);
    expect(jobRunsCompleted.length).toBe(1);
    expect(jobRunsCompleted[0].status).toBe("failed");
    expect(jobRunsCompleted[0].errorMessage).toMatch(/Claude Code runtime adapter is not available/);

    // No runtime session, no message rows (resolution happens before them),
    // and the poison counter sees a failure.
    expect(runtimeSessionsCreated.length).toBe(0);
    expect(messagesCreated.length).toBe(0);
    expect(recordOutcomeCalls).toEqual([{ tenantId: job.tenantId, jobId: job.jobId, succeeded: false }]);
    expect(auditEvents.find((e) => e.type === "scheduler.job.run.failed")).toBeTruthy();
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
    // 60_000 (timeout) + 5_000 (grace) + 60_000 (buffer)
    expect(sweepStaleJobRunsCalls[0].olderThanMs).toBe(125_000);

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
        // It only ends once the runtime is aborted (mirrors the real runtime,
        // where requestRuntimeShutdown pushes response.failed and ends the queue).
        yield { type: "response.created", responseId: "resp-1" } as RuntimeEvent;
        await streamReleased;
        yield { type: "response.failed", responseId: "resp-1", message: "aborted" } as RuntimeEvent;
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
    const { deps, runtimeAdapter } = createFakeDeps({
      dueJobs: [job],
      runMessageImpl: async function* () {
        yield { type: "response.created", responseId: "resp-1" } as RuntimeEvent;
        await new Promise<void>(() => {}); // never resolves
      }
    });
    runtimeAdapter.abortSession = async () => {
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
    let releaseClaim: (() => void) | null = null;
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
    releaseClaim?.();
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

    let releaseClaim: (() => void) | null = null;
    const claimGate = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    const claimCalls: number[] = [];
    deps.piiScanJobs = {
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

    releaseClaim?.();
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
