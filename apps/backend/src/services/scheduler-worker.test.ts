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
  content: string
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
    updatedAt: new Date().toISOString()
  };
}

function createFakeDeps(options?: {
  dueJobs?: ScheduledJobRecord[];
  claimReturns?: (ScheduledJobRecord | null)[];
  runtimeEvents?: RuntimeEvent[][];
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
  const claimsCalled: Array<{ jobId: string; nextRunAt: string | null }> = [];
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
  const auditEvents: Array<{
    sessionId: string | null;
    userId: string;
    type: string;
    payload: Record<string, unknown>;
  }> = [];

  const deps: SchedulerWorkerDeps = {
    settings: {
      listDueJobs: async (limit: number) => dueJobs.slice(0, limit),
      claimJob: async (jobId, nextRunAt) => {
        claimsCalled.push({ jobId, nextRunAt });
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
      runMessage: async function* (_session, input) {
        runMessageCalls.push({ sessionId: _session.sessionId, prompt: input.prompt });
        const events = runtimeEventsPerCall[runtimeCallIndex] ?? [];
        runtimeCallIndex += 1;
        for (const event of events) {
          yield event;
        }
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
    auditEvents
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

  test("tick survives an invalid cron expression and still claims the job", async () => {
    const job = makeFakeJob({ cronExpression: "not-a-cron" });
    const { deps, claimsCalled, jobRunsCompleted } = createFakeDeps({
      dueJobs: [job],
      runtimeEvents: [
        [
          { type: "response.created", responseId: "resp-1" },
          { type: "response.completed", responseId: "resp-1" }
        ]
      ]
    });
    const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 1, jobTimeoutMs: 60_000 });

    await worker.tick();

    expect(claimsCalled.length).toBe(1);
    expect(claimsCalled[0].nextRunAt).toBe(null);
    expect(jobRunsCompleted.length).toBe(1);
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
