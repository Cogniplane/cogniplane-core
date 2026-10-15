// The active-job cap is checked and applied inside UserSettingsStore, in one
// transaction under a per-(tenant, user) advisory lock. Before that, the route
// counted in one transaction and wrote in another, so two requests could both
// see one free slot and each take it.
//
// Every test here calls the PRODUCTION store methods. The race tests use the
// pattern of policy-rule-concurrency.integration.test.ts: a superuser session
// holds the quota lock, the racers start and block on it, and the test releases
// the lock only when all of them wait. If the store did not take the lock, the
// racers would not wait and `waitForAdvisoryWaiters` would time out, so a
// store without the lock fails here instead of passing by luck.

import { describe, expect, test } from "vitest";

import { UserSettingsStore, type ScheduledJobAdmission } from "../services/user-settings-store.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedMembership, seedScheduledJob, seedTenant, seedUser } from "./support/fixtures.js";

const CAP = 3;
const RACERS = 4; // below the app pool's 5 connections, so all of them can wait

// Waits until `count` sessions wait for an advisory lock, so a test releases its
// held lock only after the writers it started are really blocked on it.
async function waitForAdvisoryWaiters(count: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await superuserPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pg_locks WHERE locktype = 'advisory' AND NOT granted");
    if (Number(waiting.rows[0]!.count) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Expected ${count} sessions to wait for the scheduled job quota lock.`);
}

// Holds the same lock the store takes for this user, until COMMIT.
async function holdQuotaLock(tenantId: string, userId: string) {
  const holder = await superuserPool().connect();
  await holder.query("BEGIN");
  await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [JSON.stringify(["scheduled-job-quota", tenantId, userId])]);
  return holder;
}

// Rolls back first: a client returned mid-transaction would carry its lock to
// the next borrower. After a COMMIT the rollback does nothing.
async function releaseQuotaLock(holder: Awaited<ReturnType<typeof holdQuotaLock>>): Promise<void> {
  await holder.query("ROLLBACK").catch(() => {});
  holder.release();
}

// A member with no jobs yet. Not seedTenantGraph: that seeds one enabled job.
async function seedMember(tenantId?: string) {
  const tenant = tenantId ?? await seedTenant();
  const userId = await seedUser();
  await seedMembership(tenant, userId, "member");
  return { tenantId: tenant, userId };
}

async function seedDisabledJob(tenantId: string, userId: string): Promise<string> {
  const jobId = await seedScheduledJob({ tenantId, userId, due: false });
  await superuserPool().query("UPDATE scheduled_jobs SET enabled = FALSE, next_run_at = NULL WHERE job_id = $1", [jobId]);
  return jobId;
}

async function seedEnabledJobs(tenantId: string, userId: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await seedScheduledJob({ tenantId, userId, due: false });
  }
}

async function enabledCount(tenantId: string, userId: string): Promise<number> {
  const result = await superuserPool().query<{ count: string }>(
    "SELECT count(*)::text AS count FROM scheduled_jobs WHERE tenant_id = $1 AND user_id = $2 AND enabled = TRUE",
    [tenantId, userId]);
  return Number(result.rows[0]!.count);
}

function jobFields(tenantId: string, userId: string, jobId: string, enabled: boolean) {
  return {
    tenantId,
    jobId,
    userId,
    jobName: `job ${jobId}`,
    description: null,
    cronExpression: "0 9 * * 1",
    timeZone: "UTC",
    targetType: "prompt" as const,
    targetRef: null,
    input: { prompt: "Write the digest." },
    settingsSnapshot: {},
    enabled,
    nextRunAt: enabled ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : null
  };
}

const cap: ScheduledJobAdmission = { maxActive: CAP };

describe.skipIf(!adminDatabaseUrl())("scheduled job admission", () => {
  test("concurrent creates with one remaining slot admit exactly one", async () => {
    const { tenantId, userId } = await seedMember();
    await seedEnabledJobs(tenantId, userId, CAP - 1);
    const store = new UserSettingsStore(appPool());

    const holder = await holdQuotaLock(tenantId, userId);
    let results;
    try {
      const pending = Promise.all(Array.from({ length: RACERS }, (_, index) =>
        store.createScheduledJob(jobFields(tenantId, userId, `race-create-${userId}-${index}`, true), cap)));
      await waitForAdvisoryWaiters(RACERS);
      await holder.query("COMMIT");
      results = await pending;
    } finally {
      await releaseQuotaLock(holder);
    }

    expect(results.filter((result) => result.status === "created")).toHaveLength(1);
    expect(results.filter((result) => result.status === "limit_reached")).toHaveLength(RACERS - 1);
    expect(await enabledCount(tenantId, userId)).toBe(CAP);
  });

  test("concurrent enables of different disabled jobs with one remaining slot admit exactly one", async () => {
    const { tenantId, userId } = await seedMember();
    await seedEnabledJobs(tenantId, userId, CAP - 1);
    const disabledIds = await Promise.all(Array.from({ length: RACERS }, () => seedDisabledJob(tenantId, userId)));
    const store = new UserSettingsStore(appPool());

    const holder = await holdQuotaLock(tenantId, userId);
    let results;
    try {
      const pending = Promise.all(disabledIds.map((jobId) =>
        store.updateScheduledJob(jobFields(tenantId, userId, jobId, true), cap)));
      await waitForAdvisoryWaiters(RACERS);
      await holder.query("COMMIT");
      results = await pending;
    } finally {
      await releaseQuotaLock(holder);
    }

    expect(results.filter((result) => result.status === "updated")).toHaveLength(1);
    expect(results.filter((result) => result.status === "limit_reached")).toHaveLength(RACERS - 1);
    expect(await enabledCount(tenantId, userId)).toBe(CAP);
  });

  test("a create and an enable race for the last slot, and only one wins", async () => {
    const { tenantId, userId } = await seedMember();
    await seedEnabledJobs(tenantId, userId, CAP - 1);
    const disabledId = await seedDisabledJob(tenantId, userId);
    const store = new UserSettingsStore(appPool());

    const holder = await holdQuotaLock(tenantId, userId);
    let outcomes;
    try {
      const pending = Promise.all([
        store.createScheduledJob(jobFields(tenantId, userId, `mixed-create-${userId}`, true), cap),
        store.updateScheduledJob(jobFields(tenantId, userId, disabledId, true), cap)
      ]);
      await waitForAdvisoryWaiters(2);
      await holder.query("COMMIT");
      outcomes = await pending;
    } finally {
      await releaseQuotaLock(holder);
    }

    expect(outcomes.map((outcome) => outcome.status).filter((status) => status === "limit_reached")).toHaveLength(1);
    expect(await enabledCount(tenantId, userId)).toBe(CAP);
  });

  test("enabling a job that a concurrent request already enabled does not count it twice", async () => {
    // Both requests read the job as disabled before the lock. The second one
    // must reread under the job's row lock, see it enabled, and not count it.
    // Counting it again would reject it, because the first one took the slot.
    const { tenantId, userId } = await seedMember();
    await seedEnabledJobs(tenantId, userId, CAP - 1);
    const jobId = await seedDisabledJob(tenantId, userId);
    const store = new UserSettingsStore(appPool());

    const holder = await holdQuotaLock(tenantId, userId);
    let results;
    try {
      const pending = Promise.all([
        store.updateScheduledJob(jobFields(tenantId, userId, jobId, true), cap),
        store.updateScheduledJob(jobFields(tenantId, userId, jobId, true), cap)
      ]);
      await waitForAdvisoryWaiters(2);
      await holder.query("COMMIT");
      results = await pending;
    } finally {
      await releaseQuotaLock(holder);
    }

    expect(results.map((result) => result.status)).toEqual(["updated", "updated"]);
    expect(await enabledCount(tenantId, userId)).toBe(CAP);
  });

  test("an update that keeps a job enabled passes at the cap", async () => {
    const { tenantId, userId } = await seedMember();
    const store = new UserSettingsStore(appPool());
    const first = await store.createScheduledJob(jobFields(tenantId, userId, `at-cap-${userId}-0`, true), cap);
    expect(first.status).toBe("created");
    await seedEnabledJobs(tenantId, userId, CAP - 1);
    expect(await enabledCount(tenantId, userId)).toBe(CAP);

    const renamed = await store.updateScheduledJob(
      { ...jobFields(tenantId, userId, `at-cap-${userId}-0`, true), jobName: "renamed" }, cap);

    expect(renamed.status).toBe("updated");
    expect(await enabledCount(tenantId, userId)).toBe(CAP);
  });

  test("a disabled job can be created at the cap and a disabling update frees a slot", async () => {
    const { tenantId, userId } = await seedMember();
    await seedEnabledJobs(tenantId, userId, CAP);
    const store = new UserSettingsStore(appPool());

    const parked = await store.createScheduledJob(jobFields(tenantId, userId, `parked-${userId}`, false), cap);
    expect(parked.status).toBe("created");
    expect((await store.createScheduledJob(jobFields(tenantId, userId, `blocked-${userId}`, true), cap)).status)
      .toBe("limit_reached");

    const enabledId = (await superuserPool().query<{ job_id: string }>(
      "SELECT job_id FROM scheduled_jobs WHERE tenant_id = $1 AND user_id = $2 AND enabled = TRUE LIMIT 1",
      [tenantId, userId])).rows[0]!.job_id;
    const disabled = await store.updateScheduledJob(jobFields(tenantId, userId, enabledId, false), cap);
    expect(disabled.status).toBe("updated");

    expect((await store.createScheduledJob(jobFields(tenantId, userId, `freed-${userId}`, true), cap)).status)
      .toBe("created");
    expect(await enabledCount(tenantId, userId)).toBe(CAP);
  });

  test("a cap of 0 lets enabled jobs exceed the usual limit, concurrently too", async () => {
    const { tenantId, userId } = await seedMember();
    await seedEnabledJobs(tenantId, userId, CAP);
    const disabledId = await seedDisabledJob(tenantId, userId);
    const store = new UserSettingsStore(appPool());
    const uncapped: ScheduledJobAdmission = { maxActive: 0 };

    const results = await Promise.all([
      store.createScheduledJob(jobFields(tenantId, userId, `uncapped-a-${userId}`, true), uncapped),
      store.createScheduledJob(jobFields(tenantId, userId, `uncapped-b-${userId}`, true), uncapped),
      store.updateScheduledJob(jobFields(tenantId, userId, disabledId, true), uncapped)
    ]);

    expect(results.map((result) => result.status)).toEqual(["created", "created", "updated"]);
    expect(await enabledCount(tenantId, userId)).toBe(CAP + 3);
  });

  test("the cap is per user: another user's lock and jobs do not block or count", async () => {
    const { tenantId, userId } = await seedMember();
    const colleague = await seedMember(tenantId);
    const outsider = await seedMember();
    await seedEnabledJobs(tenantId, userId, CAP);
    const store = new UserSettingsStore(appPool());

    // The first user's quota lock is held, and the first user is at the cap.
    const holder = await holdQuotaLock(tenantId, userId);
    let blocked;
    try {
      blocked = store.createScheduledJob(jobFields(tenantId, userId, `blocked-${userId}`, true), cap);
      await waitForAdvisoryWaiters(1);

      // A user in the same tenant and a user in another tenant are not held up.
      const sameTenant = await store.createScheduledJob(
        jobFields(tenantId, colleague.userId, `colleague-${colleague.userId}`, true), cap);
      const otherTenant = await store.createScheduledJob(
        jobFields(outsider.tenantId, outsider.userId, `outsider-${outsider.userId}`, true), cap);
      expect(sameTenant.status).toBe("created");
      expect(otherTenant.status).toBe("created");

      await holder.query("COMMIT");
      expect((await blocked).status).toBe("limit_reached");
    } finally {
      await releaseQuotaLock(holder);
      await blocked?.catch(() => {});
    }

    expect(await enabledCount(tenantId, userId)).toBe(CAP);
    expect(await enabledCount(tenantId, colleague.userId)).toBe(1);
    expect(await enabledCount(outsider.tenantId, outsider.userId)).toBe(1);
  });

  test("disabled jobs and other users' jobs do not count against a user's cap", async () => {
    const { tenantId, userId } = await seedMember();
    const colleague = await seedMember(tenantId);
    await seedEnabledJobs(tenantId, colleague.userId, CAP);
    await Promise.all(Array.from({ length: CAP }, () => seedDisabledJob(tenantId, userId)));
    const store = new UserSettingsStore(appPool());

    const created = await store.createScheduledJob(jobFields(tenantId, userId, `counts-${userId}`, true), cap);

    expect(created.status).toBe("created");
  });

  test("an update cannot reach a job that belongs to another user", async () => {
    const { tenantId, userId } = await seedMember();
    const colleague = await seedMember(tenantId);
    const colleagueJobId = await seedDisabledJob(tenantId, colleague.userId);
    const store = new UserSettingsStore(appPool());

    const stolen = await store.updateScheduledJob(jobFields(tenantId, userId, colleagueJobId, true), cap);

    expect(stolen).toEqual({ status: "not_found" });
    const row = await superuserPool().query<{ enabled: boolean }>(
      "SELECT enabled FROM scheduled_jobs WHERE job_id = $1", [colleagueJobId]);
    expect(row.rows[0]!.enabled).toBe(false);
  });

  test("an update of a missing job reports not_found with and without a cap", async () => {
    const { tenantId, userId } = await seedMember();
    const store = new UserSettingsStore(appPool());

    expect(await store.updateScheduledJob(jobFields(tenantId, userId, `missing-${userId}`, true), cap))
      .toEqual({ status: "not_found" });
    expect(await store.updateScheduledJob(jobFields(tenantId, userId, `missing-${userId}`, true), { maxActive: 0 }))
      .toEqual({ status: "not_found" });
  });
});
