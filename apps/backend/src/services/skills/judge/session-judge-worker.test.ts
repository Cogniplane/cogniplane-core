import { test, expect } from "vitest";

import type {
  EligibleSession,
  InflightBatch,
  JudgmentKind,
  SessionJudgmentRecord,
  SessionJudgmentStore
} from "../../session-judgment-store.js";
import type { ActivationTracker } from "../../activation-tracker.js";
import type { DynamicConfigService } from "../../dynamic-config-service.js";
import type { MessageRecord, MessageStore } from "../../message-store.js";

import { SessionJudgeWorker } from "./session-judge-worker.js";
import type {
  PollResult,
  SkillJudgeInput,
  SkillJudgeOutput,
  SkillJudgeProvider,
  SubmissionResult,
  SyncResult
} from "./skill-judge-types.js";

const noopLogger = {
  warn: () => {},
  info: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: function () {
    return this;
  },
  level: "info" as const
} as never;

function buildEligible(overrides: Partial<EligibleSession> = {}): EligibleSession {
  return {
    tenantId: "tenant-1",
    sessionId: "sess-1",
    userId: "user-1",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    mode: "sync",
    ...overrides
  };
}

function buildJudgmentRecord(overrides: Partial<SessionJudgmentRecord> = {}): SessionJudgmentRecord {
  const now = new Date().toISOString();
  return {
    tenantId: "tenant-1",
    sessionId: "sess-1",
    judgmentKind: "skill_invocation" as JudgmentKind,
    provider: "anthropic",
    model: "claude-haiku-4-5",
    mode: "sync",
    batchId: null,
    status: "running",
    submittedAt: now,
    completedAt: null,
    error: null,
    metadata: {},
    ...overrides
  };
}

function makeRecorder<R, A extends unknown[]>(handler: (...args: A) => Promise<R> | R) {
  const calls: A[] = [];
  const fn = async (...args: A): Promise<R> => {
    calls.push(args);
    return handler(...args);
  };
  return Object.assign(fn, { calls });
}

type StubProviderConfig = {
  providerId?: string;
  mode?: "sync" | "batch";
  submit: (inputs: SkillJudgeInput[]) => Promise<SubmissionResult> | SubmissionResult;
  poll?: (batchId: string, sessionIds: string[]) => Promise<PollResult> | PollResult;
};

function buildStubProvider(config: StubProviderConfig): SkillJudgeProvider & {
  submitCalls: SkillJudgeInput[][];
  pollCalls: Array<{ batchId: string; sessionIds: string[] }>;
} {
  const submitCalls: SkillJudgeInput[][] = [];
  const pollCalls: Array<{ batchId: string; sessionIds: string[] }> = [];
  return {
    providerId: config.providerId ?? "stub",
    mode: config.mode ?? "sync",
    submit: async (inputs) => {
      submitCalls.push(inputs);
      return config.submit(inputs);
    },
    poll: config.poll
      ? async (batchId, sessionIds) => {
          pollCalls.push({ batchId, sessionIds });
          return config.poll!(batchId, sessionIds);
        }
      : undefined,
    submitCalls,
    pollCalls
  };
}

type Harness = {
  worker: SessionJudgeWorker;
  judgments: {
    listSessionsToJudge: ReturnType<typeof makeRecorder<EligibleSession[], [JudgmentKind, number, number]>>;
    claim: ReturnType<typeof makeRecorder<SessionJudgmentRecord | null, [Parameters<SessionJudgmentStore["claim"]>[0]]>>;
    markCompleted: ReturnType<typeof makeRecorder<SessionJudgmentRecord | null, [Parameters<SessionJudgmentStore["markCompleted"]>[0]]>>;
    markFailed: ReturnType<typeof makeRecorder<SessionJudgmentRecord | null, [Parameters<SessionJudgmentStore["markFailed"]>[0]]>>;
    markSubmitted: ReturnType<typeof makeRecorder<SessionJudgmentRecord | null, [Parameters<SessionJudgmentStore["markSubmitted"]>[0]]>>;
    listInflightBatches: ReturnType<typeof makeRecorder<InflightBatch[], [number]>>;
    listInflight: ReturnType<typeof makeRecorder<SessionJudgmentRecord[], [number]>>;
    reapStuckRunningRows: ReturnType<typeof makeRecorder<number, [number]>>;
  };
  activations: {
    recordEvents: ReturnType<typeof makeRecorder<void, Parameters<ActivationTracker["recordEvents"]>>>;
  };
  provider: ReturnType<typeof buildStubProvider>;
};

function buildHarness(input: {
  eligible?: EligibleSession[];
  inflight?: InflightBatch[];
  /** Rows returned by `listInflight` — used to drive the submit-pass guard. */
  inflightRecords?: SessionJudgmentRecord[];
  /** Number returned by reapStuckRunningRows. */
  reapedCount?: number;
  /** Returns a non-null record if the (tenantId, sessionId) was claimed; null on race. */
  claim?: (input: Parameters<SessionJudgmentStore["claim"]>[0]) => SessionJudgmentRecord | null;
  bundleSkills?: Array<{ id: string; name: string; description: string | null; instructions: string }>;
  messages?: MessageRecord[];
  provider: StubProviderConfig;
}): Harness {
  const provider = buildStubProvider(input.provider);
  const claimFn = input.claim ?? (() => buildJudgmentRecord());
  const bundleSkills =
    input.bundleSkills ??
    [{ id: "skill-1", name: "Skill 1", description: null, instructions: "" }];

  const judgments = {
    listSessionsToJudge: makeRecorder<EligibleSession[], [JudgmentKind, number, number]>(
      async () => input.eligible ?? []
    ),
    claim: makeRecorder<SessionJudgmentRecord | null, [Parameters<SessionJudgmentStore["claim"]>[0]]>(
      async (arg) => claimFn(arg)
    ),
    markCompleted: makeRecorder<SessionJudgmentRecord | null, [Parameters<SessionJudgmentStore["markCompleted"]>[0]]>(
      async () => buildJudgmentRecord({ status: "completed" })
    ),
    markFailed: makeRecorder<SessionJudgmentRecord | null, [Parameters<SessionJudgmentStore["markFailed"]>[0]]>(
      async () => buildJudgmentRecord({ status: "failed" })
    ),
    markSubmitted: makeRecorder<SessionJudgmentRecord | null, [Parameters<SessionJudgmentStore["markSubmitted"]>[0]]>(
      async () => buildJudgmentRecord({ status: "submitted" })
    ),
    listInflightBatches: makeRecorder<InflightBatch[], [number]>(async () => input.inflight ?? []),
    // The submit-pass guard skips when prior batches are still pending. Tests
    // that don't care about that guard pass [] here. Tests that do flip it on
    // override `inflightRecords` after harness construction.
    listInflight: makeRecorder<SessionJudgmentRecord[], [number]>(
      async () => input.inflightRecords ?? []
    ),
    // The reap pass runs at the start of every tick. Default no-op for tests
    // that don't care; override `reapedCount` to assert the wiring.
    reapStuckRunningRows: makeRecorder<number, [number]>(
      async () => input.reapedCount ?? 0
    )
  };

  const activations = {
    recordEvents: makeRecorder<void, Parameters<ActivationTracker["recordEvents"]>>(async () => undefined)
  };

  const dynamicConfig: Pick<DynamicConfigService, "compileRuntimeConfig"> = {
    compileRuntimeConfig: async () => ({
      runtimePolicy: {} as never,
      skills: bundleSkills.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        instructions: s.instructions,
        version: 1,
        hash: "h",
        revisionId: null,
        bundleHash: null,
        sourceType: null,
        bundleName: null,
        bundleStorageUri: null,
        validationStatus: null,
        reviewStatus: null
      })),
      mcpServers: [],
      hash: "h",
      sources: {} as never
    })
  };

  const messages: Pick<MessageStore, "listBySession"> = {
    listBySession: async () => input.messages ?? []
  };

  const worker = new SessionJudgeWorker(
    {
      judgments: judgments as never,
      messages: messages as never,
      dynamicConfig: dynamicConfig as never,
      activations: activations as never,
      providerFactory: () => provider,
      logger: noopLogger
    },
    { inactiveBeforeMs: 1000, maxSessionsPerTick: 10, runningTimeoutMs: 0 }
  );

  return { worker, judgments, activations, provider };
}

test("submit pass: bundles same-(provider, model, mode) sessions into one provider call", async () => {
  const eligible = [
    buildEligible({ sessionId: "a" }),
    buildEligible({ sessionId: "b" }),
    buildEligible({ sessionId: "c" })
  ];
  const harness = buildHarness({
    eligible,
    provider: {
      submit: (inputs) => {
        const results = new Map<string, SyncResult>();
        for (const input of inputs) {
          results.set(input.sessionId, {
            status: "succeeded",
            output: {
              skills: [{ skillId: "skill-1", invoked: true, confidence: 0.9, evidence: [] }]
            } satisfies SkillJudgeOutput
          });
        }
        return { mode: "sync", results };
      }
    }
  });

  await harness.worker.tick();

  // One provider.submit call covering all three sessions.
  expect(harness.provider.submitCalls.length).toBe(1);
  expect(harness.provider.submitCalls[0]?.length).toBe(3);
  // Three claims, three record-events, three mark-completed.
  expect(harness.judgments.claim.calls.length).toBe(3);
  expect(harness.activations.recordEvents.calls.length).toBe(3);
  expect(harness.judgments.markCompleted.calls.length).toBe(3);
  expect(harness.judgments.markFailed.calls.length).toBe(0);
});

test("submit pass: writes invoked + materialized rows with judge metadata", async () => {
  const harness = buildHarness({
    eligible: [buildEligible()],
    bundleSkills: [
      { id: "skill-1", name: "Skill 1", description: null, instructions: "" },
      { id: "skill-2", name: "Skill 2", description: null, instructions: "" }
    ],
    provider: {
      submit: () => {
        const results = new Map<string, SyncResult>();
        results.set("sess-1", {
          status: "succeeded",
          output: {
            skills: [
              { skillId: "skill-1", invoked: true, confidence: 0.9, evidence: [] },
              { skillId: "skill-2", invoked: false, confidence: 0.1, evidence: [] }
            ]
          },
          rawRequestId: "req-123"
        });
        return { mode: "sync", results };
      }
    }
  });

  await harness.worker.tick();

  const events = harness.activations.recordEvents.calls[0]?.[1] ?? [];
  expect(events.length).toBe(2);
  expect(events.find((e) => e.resourceId === "skill-1")?.eventType).toBe("invoked");
  expect(events.find((e) => e.resourceId === "skill-2")?.eventType).toBe("materialized");
  const meta = events[0]?.metadata as { source: string; provider: string };
  expect(meta.source).toBe("llm_judge");
});

test("submit pass: per-session 'failed' SyncResult marks just that row failed", async () => {
  const harness = buildHarness({
    eligible: [
      buildEligible({ sessionId: "sess-ok" }),
      buildEligible({ sessionId: "sess-bad" })
    ],
    provider: {
      submit: (inputs) => {
        const results = new Map<string, SyncResult>();
        for (const input of inputs) {
          if (input.sessionId === "sess-bad") {
            results.set(input.sessionId, { status: "failed", error: "parse error" });
          } else {
            results.set(input.sessionId, {
              status: "succeeded",
              output: { skills: [] }
            });
          }
        }
        return { mode: "sync", results };
      }
    }
  });

  await harness.worker.tick();

  expect(harness.judgments.markCompleted.calls.length).toBe(1);
  expect(harness.judgments.markFailed.calls.length).toBe(1);
  const failed = harness.judgments.markFailed.calls[0]?.[0];
  expect(failed?.sessionId).toBe("sess-bad");
});

test("submit pass: provider throw fails the entire group", async () => {
  const harness = buildHarness({
    eligible: [buildEligible({ sessionId: "a" }), buildEligible({ sessionId: "b" })],
    provider: {
      submit: () => {
        throw new Error("upstream 500");
      }
    }
  });

  await harness.worker.tick();

  expect(harness.judgments.markFailed.calls.length).toBe(2);
  expect(harness.judgments.markCompleted.calls.length).toBe(0);
});

test("submit pass: skips already-claimed rows (race with another worker)", async () => {
  const harness = buildHarness({
    eligible: [buildEligible({ sessionId: "lost" }), buildEligible({ sessionId: "won" })],
    claim: (arg) => (arg.sessionId === "lost" ? null : buildJudgmentRecord()),
    provider: {
      submit: (inputs) => {
        const results = new Map<string, SyncResult>();
        for (const input of inputs) {
          results.set(input.sessionId, { status: "succeeded", output: { skills: [] } });
        }
        return { mode: "sync", results };
      }
    }
  });

  await harness.worker.tick();

  // Provider was called only with the won session.
  expect(harness.provider.submitCalls[0]?.length).toBe(1);
  expect(harness.provider.submitCalls[0]?.[0]?.sessionId).toBe("won");
});

test("submit pass: closes the row when no skills are available", async () => {
  const harness = buildHarness({
    eligible: [buildEligible()],
    bundleSkills: [],
    provider: {
      submit: () => {
        throw new Error("provider should not be called");
      }
    }
  });

  await harness.worker.tick();

  expect(harness.provider.submitCalls.length).toBe(0);
  expect(harness.judgments.markCompleted.calls.length).toBe(1);
  const meta = harness.judgments.markCompleted.calls[0]?.[0]?.metadata as { reason: string };
  expect(meta?.reason).toBe("no_skills_available");
});

test("submit pass: batch submission stamps every claimed row with the same batch id", async () => {
  const harness = buildHarness({
    eligible: [
      buildEligible({ sessionId: "a", mode: "batch" }),
      buildEligible({ sessionId: "b", mode: "batch" })
    ],
    provider: {
      mode: "batch",
      submit: (inputs) => ({
        mode: "batch",
        batchId: "msgbatch_xyz",
        sessionIds: inputs.map((i) => i.sessionId)
      })
    }
  });

  await harness.worker.tick();

  expect(harness.judgments.markSubmitted.calls.length).toBe(2);
  for (const call of harness.judgments.markSubmitted.calls) {
    expect(call[0]?.batchId).toBe("msgbatch_xyz");
  }
  expect(harness.activations.recordEvents.calls.length).toBe(0);
});

test("poll pass: completed batch persists per-session results", async () => {
  const harness = buildHarness({
    inflight: [
      {
        provider: "anthropic",
        model: "claude-haiku-4-5",
        batchId: "msgbatch_xyz",
        submittedAt: new Date().toISOString(),
        sessions: [
          { tenantId: "tenant-1", sessionId: "a", judgmentKind: "skill_invocation" },
          { tenantId: "tenant-1", sessionId: "b", judgmentKind: "skill_invocation" }
        ]
      }
    ],
    provider: {
      mode: "batch",
      submit: () => {
        throw new Error("submit should not be called in this test");
      },
      poll: (_batchId, sessionIds) => {
        const results = new Map<string, SyncResult>();
        for (const sessionId of sessionIds) {
          results.set(sessionId, {
            status: "succeeded",
            output: {
              skills: [{ skillId: "skill-1", invoked: true, confidence: 0.8, evidence: [] }]
            }
          });
        }
        return { status: "completed", results };
      }
    }
  });

  await harness.worker.tick();

  expect(harness.provider.pollCalls.length).toBe(1);
  expect(harness.judgments.markCompleted.calls.length).toBe(2);
  expect(harness.activations.recordEvents.calls.length).toBe(2);
});

test("poll pass: in_progress batch leaves rows untouched for next tick", async () => {
  const harness = buildHarness({
    inflight: [
      {
        provider: "anthropic",
        model: "claude-haiku-4-5",
        batchId: "msgbatch_pending",
        submittedAt: new Date().toISOString(),
        sessions: [{ tenantId: "tenant-1", sessionId: "a", judgmentKind: "skill_invocation" }]
      }
    ],
    provider: {
      mode: "batch",
      submit: () => {
        throw new Error("submit should not be called");
      },
      poll: () => ({ status: "in_progress" })
    }
  });

  await harness.worker.tick();

  expect(harness.judgments.markCompleted.calls.length).toBe(0);
  expect(harness.judgments.markFailed.calls.length).toBe(0);
});

test("poll pass: failed batch marks all sessions failed", async () => {
  const harness = buildHarness({
    inflight: [
      {
        provider: "anthropic",
        model: "claude-haiku-4-5",
        batchId: "msgbatch_dead",
        submittedAt: new Date().toISOString(),
        sessions: [
          { tenantId: "tenant-1", sessionId: "a", judgmentKind: "skill_invocation" },
          { tenantId: "tenant-1", sessionId: "b", judgmentKind: "skill_invocation" }
        ]
      }
    ],
    provider: {
      mode: "batch",
      submit: () => {
        throw new Error("submit should not be called");
      },
      poll: () => ({ status: "failed", error: "expired" })
    }
  });

  await harness.worker.tick();

  expect(harness.judgments.markFailed.calls.length).toBe(2);
});

test("poll pass: per-session result missing in completed batch is recorded as failure", async () => {
  const harness = buildHarness({
    inflight: [
      {
        provider: "anthropic",
        model: "claude-haiku-4-5",
        batchId: "msgbatch_sparse",
        submittedAt: new Date().toISOString(),
        sessions: [
          { tenantId: "tenant-1", sessionId: "a", judgmentKind: "skill_invocation" },
          { tenantId: "tenant-1", sessionId: "missing", judgmentKind: "skill_invocation" }
        ]
      }
    ],
    provider: {
      mode: "batch",
      submit: () => {
        throw new Error("submit should not be called");
      },
      poll: () => {
        const results = new Map<string, SyncResult>();
        results.set("a", { status: "succeeded", output: { skills: [] } });
        // intentionally omit "missing"
        return { status: "completed", results };
      }
    }
  });

  await harness.worker.tick();

  expect(harness.judgments.markCompleted.calls.length).toBe(1);
  expect(harness.judgments.markFailed.calls.length).toBe(1);
  expect(harness.judgments.markFailed.calls[0]?.[0]?.sessionId).toBe("missing");
});

test("worker handles a tick with no eligible sessions and no inflight batches", async () => {
  const harness = buildHarness({
    provider: {
      submit: () => {
        throw new Error("unreachable");
      }
    }
  });

  await harness.worker.tick();

  expect(harness.judgments.claim.calls.length).toBe(0);
  expect(harness.activations.recordEvents.calls.length).toBe(0);
});
