import { test, expect, vi } from "vitest";

import { createTestConfig } from "../test-helpers/test-config.js";
import { createSilentLogger } from "../test-helpers/silent-logger.js";
import { buildSchedulerWorker } from "./build-scheduler-worker.js";
import type { PiiScanJobHandler } from "./pii/pii-scan-job-handler.js";
import type { PiiScanJobStore } from "./pii/pii-scan-job-store.js";

// The worker must exist when either the cron scheduler or the async PII scan
// drain is active. The cron half has its own gate, so PII scans still drain
// when SCHEDULER_ENABLED=false.

type SchedulerWorkerInput = Parameters<typeof buildSchedulerWorker>[1];

function makeInput(overrides?: Partial<SchedulerWorkerInput>) {
  // Only `userSettings.listDueJobs` runs in tick(). The other members are stubs
  // that tick() never calls. The input has the worker's real parameter type, so a
  // signature change, such as a renamed dependency, fails the build.
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

// The session store serves both session retention jobs. Each job has its own
// switch, and either one alone keeps the worker.
function makeSessionRetention() {
  const removed = { deletedSessions: 0, deletedObjects: 0, purgedRuntimes: 0 };
  const cleanupExpired = vi.fn(async () => removed);
  const cleanupExpiredScheduled = vi.fn(async () => removed);
  const store = { cleanupExpired, cleanupExpiredScheduled } as unknown as SchedulerWorkerInput["sessions"];
  const sessionStorage = { delete: vi.fn(async () => undefined) };
  return {
    overrides: { sessionTrash: store, scheduledSessions: store, sessionStorage },
    cleanupExpired,
    cleanupExpiredScheduled,
    sessionStorage
  };
}

const ONLY_SESSION_RETENTION = {
  SCHEDULER_ENABLED: false,
  PII_PROVIDER_ENABLED: false,
  PROJECT_FILE_RETENTION_ENABLED: false
} as const;

test("scheduled session retention alone keeps the worker and passes the configured window", async () => {
  const config = createTestConfig({
    ...ONLY_SESSION_RETENTION,
    SESSION_TRASH_RETENTION_ENABLED: false,
    SCHEDULED_SESSION_RETENTION_ENABLED: true,
    SCHEDULED_SESSION_RETENTION_DAYS: 45
  });
  const retention = makeSessionRetention();
  const { input, listDueJobs } = makeInput(retention.overrides);

  const worker = buildSchedulerWorker(config, input);
  expect(worker).not.toBeNull();
  await worker!.tick();
  expect(await worker!.drain(1_000)).toBe(true);

  expect(retention.cleanupExpiredScheduled).toHaveBeenCalledWith(
    retention.sessionStorage,
    expect.objectContaining({ retentionDays: 45 })
  );
  expect(retention.cleanupExpired).not.toHaveBeenCalled();
  expect(listDueJobs).not.toHaveBeenCalled();
});

test("SCHEDULED_SESSION_RETENTION_ENABLED=false keeps scheduled sessions and leaves Trash retention on", async () => {
  const config = createTestConfig({
    ...ONLY_SESSION_RETENTION,
    SESSION_TRASH_RETENTION_ENABLED: true,
    SCHEDULED_SESSION_RETENTION_ENABLED: false
  });
  const retention = makeSessionRetention();
  const { input } = makeInput(retention.overrides);

  const worker = buildSchedulerWorker(config, input);
  expect(worker).not.toBeNull();
  await worker!.tick();
  expect(await worker!.drain(1_000)).toBe(true);

  expect(retention.cleanupExpired).toHaveBeenCalledTimes(1);
  expect(retention.cleanupExpiredScheduled).not.toHaveBeenCalled();
});

test("returns null when both session retention jobs are off and nothing else runs", () => {
  const config = createTestConfig({
    ...ONLY_SESSION_RETENTION,
    SESSION_TRASH_RETENTION_ENABLED: false,
    SCHEDULED_SESSION_RETENTION_ENABLED: false
  });
  const { input } = makeInput(makeSessionRetention().overrides);
  expect(buildSchedulerWorker(config, input)).toBeNull();
});

test("scheduled session retention without storage does not keep the worker", () => {
  const config = createTestConfig({
    ...ONLY_SESSION_RETENTION,
    SESSION_TRASH_RETENTION_ENABLED: false,
    SCHEDULED_SESSION_RETENTION_ENABLED: true
  });
  const { sessionStorage: _storage, ...withoutStorage } = makeSessionRetention().overrides;
  const { input } = makeInput(withoutStorage);
  expect(buildSchedulerWorker(config, input)).toBeNull();
});

test("scheduler-enabled worker runs the cron half on tick", async () => {
  const config = createTestConfig({ SCHEDULER_ENABLED: true });
  const { input, listDueJobs } = makeInput();

  const worker = buildSchedulerWorker(config, input);
  expect(worker).not.toBeNull();
  await worker!.tick();

  expect(listDueJobs).toHaveBeenCalledTimes(1);
});
