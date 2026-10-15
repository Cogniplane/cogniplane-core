import { test, expect, vi } from "vitest";

import { createTestConfig } from "../test-helpers/test-config.js";
import { createSilentLogger } from "../test-helpers/silent-logger.js";
import { buildSchedulerWorker } from "./build-scheduler-worker.js";
import type { PiiScanJobHandler } from "./pii/pii-scan-job-handler.js";
import type { PiiScanJobStore } from "./pii/pii-scan-job-store.js";

// The decoupling under test (review finding #8): the worker must be created
// when EITHER the cron scheduler or the async PII scan drain is active, and the
// cron half must be gated independently so PII scans still drain when
// SCHEDULER_ENABLED=false. The original `if (!SCHEDULER_ENABLED) return null`
// silently starved the PII queue — these tests lock that fix in.

type SchedulerWorkerInput = Parameters<typeof buildSchedulerWorker>[1];

function makeInput(overrides?: {
  piiScanJobs?: PiiScanJobStore;
  piiScanJobHandler?: PiiScanJobHandler;
}) {
  // Only `userSettings.listDueJobs` is exercised by tick(); everything else is
  // a never-called stub. We type the whole `input` as the worker's actual
  // parameter so a signature change (e.g. a dropped/renamed dependency) fails
  // this build instead of compiling behind an `as any` cast — the stale
  // `defaultAdapter`/`runtimeAdapters`-map/per-provider-getter shape that this
  // fixture used to carry (retired with the deep-agents provider collapse) can
  // no longer sneak through.
  const listDueJobs = vi.fn(async () => []);
  const stub = <T>() => ({}) as T;
  const input: SchedulerWorkerInput = {
    userSettings: {
      listDueJobs,
      disableJob: vi.fn(async () => {}),
      sweepStaleJobRuns: vi.fn(async () => [])
    } as unknown as SchedulerWorkerInput["userSettings"],
    sessions: stub<SchedulerWorkerInput["sessions"]>(),
    messages: stub<SchedulerWorkerInput["messages"]>(),
    toolContexts: stub<SchedulerWorkerInput["toolContexts"]>(),
    runtimeAdapter: stub<SchedulerWorkerInput["runtimeAdapter"]>(),
    dynamicConfig: stub<SchedulerWorkerInput["dynamicConfig"]>(),
    customModels: stub<SchedulerWorkerInput["customModels"]>(),
    providerCredentials: stub<SchedulerWorkerInput["providerCredentials"]>(),
    auditEvents: stub<SchedulerWorkerInput["auditEvents"]>(),
    logger: createSilentLogger(),
    ...overrides
  };
  return { input, listDueJobs };
}

function makePiiSubsystem() {
  const claimDueJobs = vi.fn(async () => []);
  const execute = vi.fn(async () => {});
  return {
    piiScanJobs: { claimDueJobs } as unknown as PiiScanJobStore,
    piiScanJobHandler: { execute } as unknown as PiiScanJobHandler,
    claimDueJobs,
    execute
  };
}

test("returns null when scheduler is disabled and PII provider is disabled", () => {
  const config = createTestConfig({ SCHEDULER_ENABLED: false, PII_PROVIDER_ENABLED: false });
  const { input } = makeInput();
  expect(buildSchedulerWorker(config, input)).toBeNull();
});

test("builds a worker when scheduler is enabled (PII provider off)", () => {
  const config = createTestConfig({ SCHEDULER_ENABLED: true, PII_PROVIDER_ENABLED: false });
  const { input } = makeInput();
  expect(buildSchedulerWorker(config, input)).not.toBeNull();
});

test("builds a worker when scheduler is disabled but the PII drain is enabled", () => {
  const config = createTestConfig({ SCHEDULER_ENABLED: false, PII_PROVIDER_ENABLED: true });
  const pii = makePiiSubsystem();
  const { input } = makeInput({
    piiScanJobs: pii.piiScanJobs,
    piiScanJobHandler: pii.piiScanJobHandler
  });
  expect(buildSchedulerWorker(config, input)).not.toBeNull();
});

test("runs the PII drain without the remote provider", async () => {
  // Rules-only detect still queues artifact scans. Without a drain, those
  // uploads stay pending forever.
  const config = createTestConfig({ SCHEDULER_ENABLED: false, PII_PROVIDER_ENABLED: false });
  const pii = makePiiSubsystem();
  const { input } = makeInput({
    piiScanJobs: pii.piiScanJobs,
    piiScanJobHandler: pii.piiScanJobHandler
  });

  const worker = buildSchedulerWorker(config, input);
  expect(worker).not.toBeNull();
  await worker!.tick();

  expect(pii.claimDueJobs).toHaveBeenCalledTimes(1);
});

test("a partially-wired PII subsystem does not enable the drain", () => {
  // Only one of the two halves present — not enough to drive the drain.
  const config = createTestConfig({ SCHEDULER_ENABLED: false, PII_PROVIDER_ENABLED: true });
  const pii = makePiiSubsystem();
  const { input } = makeInput({ piiScanJobs: pii.piiScanJobs });
  expect(buildSchedulerWorker(config, input)).toBeNull();
});

test("scheduler-disabled PII-only worker skips the cron half on tick", async () => {
  const config = createTestConfig({ SCHEDULER_ENABLED: false, PII_PROVIDER_ENABLED: true });
  const pii = makePiiSubsystem();
  const { input, listDueJobs } = makeInput({
    piiScanJobs: pii.piiScanJobs,
    piiScanJobHandler: pii.piiScanJobHandler
  });

  const worker = buildSchedulerWorker(config, input);
  expect(worker).not.toBeNull();
  await worker!.tick();

  // Cron half is gated off: no due-job query at all.
  expect(listDueJobs).not.toHaveBeenCalled();
  // PII half still drains.
  expect(pii.claimDueJobs).toHaveBeenCalledTimes(1);
});

test("scheduler-enabled worker runs the cron half on tick", async () => {
  const config = createTestConfig({ SCHEDULER_ENABLED: true });
  const { input, listDueJobs } = makeInput();

  const worker = buildSchedulerWorker(config, input);
  expect(worker).not.toBeNull();
  await worker!.tick();

  expect(listDueJobs).toHaveBeenCalledTimes(1);
});
