import { describe, it, beforeEach, expect } from "vitest";
import { UserSettingsStore } from "./user-settings-store.js";

type QueryResult = { rows: Record<string, unknown>[]; rowCount: number };
type QueryHandler = (sql: string, params: unknown[]) => QueryResult;

class FakeDatabase {
  private handlers: QueryHandler[] = [];
  public calls: { sql: string; params: unknown[] }[] = [];

  /** Register a handler; last registered wins (checked in reverse order). */
  onQuery(handler: QueryHandler): void {
    this.handlers.push(handler);
  }

  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    this.calls.push({ sql, params });
    for (let i = this.handlers.length - 1; i >= 0; i--) {
      const result = this.handlers[i](sql, params);
      if (result) return result;
    }
    return { rows: [], rowCount: 0 };
  }

  async connect(): Promise<{
    query: (sql: string, params?: unknown[]) => Promise<QueryResult>;
    release: () => void;
  }> {
    return {
      query: (sql: string, params: unknown[] = []) => this.query(sql, params),
      release: () => {}
    };
  }
}

const TRANSACTION_CONTROL = new Set(["BEGIN", "COMMIT", "ROLLBACK"]);

/** The calls of a change, without its transaction control. */
function workCalls(db: FakeDatabase): { sql: string; params: unknown[] }[] {
  return db.calls.filter((call) => !TRANSACTION_CONTROL.has(call.sql.trim()));
}

const jobAudit = {
  tenantId: "tenant-1", sessionId: null, userId: "user-1",
  type: "scheduler.job.disabled" as const, payload: { jobId: "job-1", reason: "invalid_cron" }
};

function fakeJobRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    job_id: "job-1",
    user_id: "user-1",
    job_name: "Daily digest",
    description: null,
    schedule_kind: "cron",
    cron_expression: "0 9 * * *",
    time_zone: "UTC",
    target_type: "prompt",
    target_ref: null,
    input_json: {},
    settings_snapshot_json: {},
    enabled: true,
    last_run_at: null,
    next_run_at: "2026-03-18T09:00:00.000Z",
    created_at: "2026-03-17T00:00:00.000Z",
    updated_at: "2026-03-17T00:00:00.000Z",
    ...overrides
  };
}

function fakeRunRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: "run-1",
    job_id: "job-1",
    user_id: "user-1",
    session_id: null,
    status: "pending",
    started_at: "2026-03-18T09:00:00.000Z",
    completed_at: null,
    duration_ms: null,
    input_tokens: 0,
    output_tokens: 0,
    error_message: null,
    summary: null,
    created_at: "2026-03-18T09:00:00.000Z",
    ...overrides
  };
}

describe("UserSettingsStore – scheduler methods", () => {
  let db: FakeDatabase;
  let store: UserSettingsStore;

  beforeEach(() => {
    db = new FakeDatabase();
    store = new UserSettingsStore(db as never);
  });

  describe("listDueJobs", () => {
    it("maps returned job rows and forwards the requested limit", async () => {
      const dueJob = fakeJobRow({ job_id: "job-due", next_run_at: "2026-03-18T09:00:00.000Z", enabled: true });
      db.onQuery((sql) => {
        if (sql.includes("scheduled_jobs") && sql.includes("enabled") && sql.includes("next_run_at")) {
          return { rows: [dueJob], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });

      const result = await store.listDueJobs(10);

      expect(result.length).toBe(1);
      expect(result[0].jobId).toBe("job-due");
      expect(result[0].enabled).toBe(true);
      const call = db.calls.find((c) => c.sql.includes("LIMIT"));
      expect(call).toBeTruthy();
      expect(call!.params[0]).toBe(10);
    });

    it("returns empty array when no jobs are due", async () => {
      db.onQuery(() => ({ rows: [], rowCount: 0 }));

      const result = await store.listDueJobs(5);

      expect(result.length).toBe(0);
    });
  });

  describe("claimJob", () => {
    const isLock = (sql: string) => sql.includes("FOR UPDATE");
    const isState = (sql: string) => sql.includes("clock_timestamp()");
    const isRunInsert = (sql: string) => sql.includes("INSERT") && sql.includes("scheduled_job_runs");
    const isAdvance = (sql: string) => sql.includes("UPDATE scheduled_jobs") && sql.includes("next_run_at = $3");
    const due = fakeJobRow({ tenant_id: "tenant-1", next_run_at: new Date("2026-03-18T09:00:00.000Z") });

    function answer(input: { dbNow: string; busy: boolean; inserted: boolean }) {
      db.onQuery((sql, params) => {
        if (isLock(sql)) return { rows: [due], rowCount: 1 };
        if (isState(sql)) return { rows: [{ db_now: new Date(input.dbNow), busy: input.busy }], rowCount: 1 };
        if (isRunInsert(sql)) return input.inserted ? { rows: [{ run_id: params[2] }], rowCount: 1 } : { rows: [], rowCount: 0 };
        if (isAdvance(sql)) return { rows: [{ ...due, next_run_at: params[2] }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      });
    }

    it("claims the slot, writes its pending run and takes the next slot from the database clock", async () => {
      // The database clock is a day after the slot; a worker clock plays no part.
      answer({ dbNow: "2026-03-19T09:00:30.000Z", busy: false, inserted: true });

      const result = await store.claimJob("tenant-1", "job-1", "run-1");

      expect(result).toMatchObject({
        status: "claimed",
        job: { jobId: "job-1", runId: "run-1", scheduledFor: "2026-03-18T09:00:00.000Z", nextRunAt: "2026-03-20T09:00:00.000Z" }
      });
      expect(db.calls.map((call) => call.sql.trim().split(/\s+/)[0])).toEqual(
        ["BEGIN", "SELECT", "SELECT", "SELECT", "INSERT", "UPDATE", "COMMIT"]
      );
      expect(db.calls[1]?.params).toEqual(["tenant-1"]);
      const insert = db.calls.find((call) => isRunInsert(call.sql));
      expect(insert?.sql).toContain("ON CONFLICT (tenant_id, job_id, scheduled_for) DO NOTHING");
      expect(insert?.params.slice(0, 4)).toEqual(["tenant-1", "job-1", "run-1", "pending"]);
      // A claimed run records its start.
      expect(db.calls.find((call) => isAdvance(call.sql))?.params).toEqual(["tenant-1", "job-1", "2026-03-20T09:00:00.000Z", true]);
    });

    it("writes a skipped run for the slot while an earlier run is pending", async () => {
      answer({ dbNow: "2026-03-18T09:00:30.000Z", busy: true, inserted: true });

      const result = await store.claimJob("tenant-1", "job-1", "run-2");

      expect(result).toEqual({ status: "skipped", runId: "run-2", scheduledFor: "2026-03-18T09:00:00.000Z" });
      expect(db.calls.find((call) => isRunInsert(call.sql))?.params.slice(0, 4)).toEqual(["tenant-1", "job-1", "run-2", "skipped"]);
      // A skipped slot moves next_run_at but is not a run start.
      expect(db.calls.find((call) => isAdvance(call.sql))?.params).toEqual(["tenant-1", "job-1", "2026-03-19T09:00:00.000Z", false]);
    });

    it("reports a slot that already has a run and only moves to the next slot", async () => {
      answer({ dbNow: "2026-03-18T09:00:30.000Z", busy: false, inserted: false });

      const result = await store.claimJob("tenant-1", "job-1", "run-3");

      expect(result).toEqual({ status: "slot_taken", scheduledFor: "2026-03-18T09:00:00.000Z" });
      expect(db.calls.find((call) => isAdvance(call.sql))?.params).toEqual(["tenant-1", "job-1", "2026-03-19T09:00:00.000Z", false]);
    });

    it("writes nothing when the job is not due for this claim", async () => {
      db.onQuery(() => ({ rows: [], rowCount: 0 }));

      expect(await store.claimJob("tenant-42", "job-42", "run-42")).toEqual({ status: "not_claimed" });
      const lock = db.calls.find((call) => isLock(call.sql));
      expect(lock?.sql).toContain("tenant_id = $1");
      expect(lock?.params).toEqual(["tenant-42", "job-42"]);
      expect(db.calls.some((call) => isRunInsert(call.sql) || isAdvance(call.sql))).toBe(false);
    });
  });

  describe("parkJob and disableJob", () => {
    it("parks only the listed revision of the tenant's due job and writes no run", async () => {
      db.onQuery(() => ({ rows: [], rowCount: 1 }));

      expect(await store.parkJob("tenant-1", "job-1", 4)).toBe(true);

      const calls = workCalls(db);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.sql).toContain("next_run_at = NULL");
      expect(calls[0]?.sql).toContain("tenant_id = $1");
      expect(calls[0]?.sql).toContain("revision = $3");
      expect(calls[0]?.sql).not.toContain("scheduled_job_runs");
      expect(calls[0]?.params).toEqual(["tenant-1", "job-1", 4]);
    });

    it("disables only an enabled job of the claimed revision", async () => {
      db.onQuery(() => ({ rows: [], rowCount: 0 }));

      expect(await store.disableJob("tenant-1", "job-1", 2, jobAudit)).toBe(false);

      const calls = workCalls(db);
      expect(calls[0]?.sql).toContain("enabled = TRUE AND revision = $3");
      expect(calls[0]?.params).toEqual(["tenant-1", "job-1", 2]);
      // No change, no event.
      expect(calls.some((call) => call.sql.includes("INSERT INTO audit_events"))).toBe(false);
    });

    it("writes the event of a change that matched the job in the change's transaction", async () => {
      db.onQuery(() => ({ rows: [], rowCount: 1 }));

      expect(await store.disableJob("tenant-1", "job-1", 2, jobAudit)).toBe(true);

      expect(db.calls.map((call) => call.sql.trim().split(/\s+/).slice(0, 3).join(" "))).toEqual([
        "BEGIN", "UPDATE scheduled_jobs SET", "INSERT INTO audit_events", "COMMIT"
      ]);
    });

    it("rolls the change back when its event cannot be written", async () => {
      db.onQuery((sql) => {
        if (sql.includes("INSERT INTO audit_events")) throw new Error("audit insert failed");
        return { rows: [], rowCount: 1 };
      });

      await expect(store.pauseJobForSecurityChange("tenant-1", "job-1", jobAudit)).rejects.toThrow("audit insert failed");

      expect(db.calls.map((call) => call.sql.trim()).at(-1)).toBe("ROLLBACK");
    });
  });

  describe("attachJobRunSession + finishJobRun", () => {
    const finishInput = {
      tenantId: "test-tenant",
      jobId: "job-1",
      runId: "run-abc",
      revision: 3,
      status: "completed" as const,
      durationMs: 1500,
      inputTokens: 200,
      outputTokens: 300,
      errorMessage: null,
      summary: "All done",
      counts: true,
      disableAtFailures: 3
    };
    const isJobLock = (sql: string) => sql.includes("FOR NO KEY UPDATE");
    const isRunUpdate = (sql: string) => sql.includes("UPDATE scheduled_job_runs");
    const isJobUpdate = (sql: string) => sql.includes("UPDATE scheduled_jobs");

    /**
     * A job row lock that finds the job, and a run update that finishes `run`.
     * With no `run`, the run row exists only when `runExists` is true.
     */
    function onFinish(job: Record<string, unknown>, run: Record<string, unknown> | null, runExists = false): void {
      db.onQuery((sql) => {
        if (isJobLock(sql)) return { rows: [{ enabled: true, revision: 3, consecutive_failures: 0, ...job }], rowCount: 1 };
        if (isRunUpdate(sql)) return run ? { rows: [run], rowCount: 1 } : { rows: [], rowCount: 0 };
        if (sql.startsWith("SELECT 1 FROM scheduled_job_runs")) return { rows: runExists ? [{}] : [], rowCount: runExists ? 1 : 0 };
        return { rows: [], rowCount: isJobUpdate(sql) || sql.includes("SET session_id") ? 1 : 0 };
      });
    }

    it("locks the job before the run, finishes the pending run and resets the counter", async () => {
      onFinish({}, fakeRunRow({
        run_id: "run-abc",
        session_id: "sess-1",
        status: "completed",
        scheduled_for: new Date("2026-03-18T09:00:00.000Z"),
        completed_at: "2026-03-18T09:01:00.000Z",
        duration_ms: 1500,
        input_tokens: 200,
        output_tokens: 300,
        summary: "All done"
      }));

      expect(await store.attachJobRunSession({ tenantId: "test-tenant", runId: "run-abc", sessionId: "sess-1" })).toBe(true);
      const attach = db.calls.find((call) => call.sql.includes("SET session_id"));
      expect(attach?.sql).toContain("status = 'pending'");
      expect(attach?.params).toEqual(["test-tenant", "run-abc", "sess-1"]);

      const finishStart = db.calls.length;
      const finished = await store.finishJobRun(finishInput);

      expect(finished).toMatchObject({
        status: "finished",
        consecutiveFailures: 0,
        disabled: false,
        run: { runId: "run-abc", sessionId: "sess-1", status: "completed", scheduledFor: "2026-03-18T09:00:00.000Z", summary: "All done" }
      });
      const finishCalls = db.calls.slice(finishStart);
      const statements = finishCalls.map((call) => call.sql);
      const lock = statements.findIndex(isJobLock);
      const runUpdate = statements.findIndex(isRunUpdate);
      const jobUpdate = statements.findIndex(isJobUpdate);
      // Job row, then run row: the order of a claim and of a job delete.
      expect(lock).toBeGreaterThanOrEqual(0);
      expect(lock).toBeLessThan(runUpdate);
      expect(runUpdate).toBeLessThan(jobUpdate);
      expect(statements[runUpdate]).toContain("status = 'pending'");
      expect(finishCalls[jobUpdate]?.params).toEqual(["test-tenant", "job-1", 0, false]);
    });

    it("disables the job in the write that takes the counter to the limit", async () => {
      onFinish({ consecutive_failures: 2 }, fakeRunRow({ run_id: "run-abc", status: "failed" }));

      expect(await store.finishJobRun({ ...finishInput, status: "failed", errorMessage: "boom" }))
        .toMatchObject({ status: "finished", consecutiveFailures: 3, disabled: true });
      const jobUpdate = db.calls.find((call) => isJobUpdate(call.sql));
      expect(jobUpdate?.sql).toContain("enabled = CASE WHEN $4::boolean THEN FALSE");
      expect(jobUpdate?.params).toEqual(["test-tenant", "job-1", 3, true]);
    });

    it("counts but does not disable a job that is already off", async () => {
      onFinish({ enabled: false, consecutive_failures: 2 }, fakeRunRow({ run_id: "run-abc", status: "failed" }));

      expect(await store.finishJobRun({ ...finishInput, status: "failed", errorMessage: "boom" }))
        .toMatchObject({ status: "finished", consecutiveFailures: 3, disabled: false });
      expect(db.calls.find((call) => isJobUpdate(call.sql))?.params).toEqual(["test-tenant", "job-1", 3, false]);
    });

    it("tells a run that another writer finished from a deleted job", async () => {
      onFinish({}, null, true);
      expect(await store.finishJobRun(finishInput)).toEqual({ status: "already_finished" });

      db.onQuery(() => ({ rows: [], rowCount: 0 }));
      expect(await store.attachJobRunSession({ tenantId: "test-tenant", runId: "gone", sessionId: "sess-1" })).toBe(false);
      expect(await store.finishJobRun({ ...finishInput, runId: "gone" })).toEqual({ status: "missing" });
      // No outcome was written, so the job was not touched.
      expect(db.calls.some((call) => isJobUpdate(call.sql))).toBe(false);
    });

    it("leaves the job alone for an outcome that does not count, or of an older revision", async () => {
      onFinish({}, fakeRunRow({ run_id: "run-err", status: "failed", error_message: "timeout" }));
      const failed = { ...finishInput, runId: "run-err", status: "failed" as const, errorMessage: "timeout" };

      expect(await store.finishJobRun({ ...failed, counts: false }))
        .toMatchObject({ status: "finished", consecutiveFailures: null, disabled: false, run: { status: "failed", errorMessage: "timeout" } });
      expect(await store.finishJobRun({ ...failed, revision: 2 }))
        .toMatchObject({ status: "finished", consecutiveFailures: null, disabled: false });
      expect(db.calls.some((call) => isJobUpdate(call.sql))).toBe(false);
    });
  });

  describe("sweepStaleJobRuns", () => {
    it("marks stale pending runs failed and returns identifying fields", async () => {
      db.onQuery((sql) => {
        if (sql.includes("UPDATE") && sql.includes("scheduled_job_runs")) {
          return {
            rows: [
              {
                tenant_id: "tenant-1",
                run_id: "run-stale",
                job_id: "job-1",
                user_id: "user-1",
                session_id: "session-9"
              }
            ],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 0 };
      });

      const result = await store.sweepStaleJobRuns(600_000, 50);

      expect(result).toEqual([
        {
          tenantId: "tenant-1",
          runId: "run-stale",
          jobId: "job-1",
          userId: "user-1",
          sessionId: "session-9"
        }
      ]);

      const call = workCalls(db)[0]!;
      // Only orphans are eligible: still pending and past the cutoff, claimed
      // with SKIP LOCKED so concurrent sweeps never double-recover a row.
      expect(call.sql).toContain("status = 'pending'");
      expect(call.sql).toContain("FOR UPDATE SKIP LOCKED");
      expect(call.sql).toContain("status = 'failed'");
      expect(call.params).toEqual([600_000, 50]);
    });

    it("returns an empty array when nothing is stale", async () => {
      db.onQuery(() => ({ rows: [], rowCount: 0 }));

      const result = await store.sweepStaleJobRuns(600_000);

      expect(result).toEqual([]);
    });
  });

  describe("listJobRuns", () => {
    it("returns runs for a specific job and user, ordered by created_at DESC", async () => {
      const run1 = fakeRunRow({ run_id: "run-1", created_at: "2026-03-18T10:00:00.000Z" });
      const run2 = fakeRunRow({ run_id: "run-2", created_at: "2026-03-18T09:00:00.000Z" });
      db.onQuery((sql) => {
        if (sql.includes("scheduled_job_runs") && sql.includes("job_id") && sql.includes("user_id")) {
          return { rows: [run1, run2], rowCount: 2 };
        }
        return { rows: [], rowCount: 0 };
      });

      const result = await store.listJobRuns("test-tenant", "job-1", "user-1");

      expect(result.length).toBe(2);
      expect(result[0].runId).toBe("run-1");
      expect(result[1].runId).toBe("run-2");

      // Verify params (tenantId is $1, jobId is $2, userId is $3)
      const call = db.calls.find((entry) => entry.sql.includes("FROM scheduled_job_runs"));
      if (!call) throw new Error("Expected listJobRuns query.");
      expect(call.params[0]).toBe("test-tenant");
      expect(call.params[1]).toBe("job-1");
      expect(call.params[2]).toBe("user-1");
    });

    it("returns empty array when no runs exist", async () => {
      db.onQuery(() => ({ rows: [], rowCount: 0 }));

      const result = await store.listJobRuns("test-tenant", "job-none", "user-1");

      expect(result.length).toBe(0);
    });
  });
});

describe("UserSettingsStore – scheduled job admission", () => {
  const quotaLock = `lock:${JSON.stringify(["scheduled-job-quota", "tenant-1", "user-1"])}`;

  const jobInput = (overrides: { enabled?: boolean } = {}) => ({
    tenantId: "tenant-1",
    jobId: "job-1",
    userId: "user-1",
    jobName: "Daily digest",
    description: null,
    cronExpression: "0 9 * * *",
    timeZone: "UTC",
    targetType: "prompt" as const,
    targetRef: null,
    input: { prompt: "Digest." },
    settingsSnapshot: {},
    enabled: overrides.enabled ?? true,
    nextRunAt: "2026-03-18T09:00:00.000Z",
    ownerSecurityVersion: null
  });

  // A scripted database: `activeJobs` answers the count, `rowEnabled` answers
  // the locked job row (undefined means the row does not exist).
  function scriptedStore(options: { activeJobs?: number; rowEnabled?: boolean }) {
    const db = new FakeDatabase();
    db.onQuery((sql) => {
      if (sql.includes("COUNT(*)")) {
        return { rows: [{ count: String(options.activeJobs ?? 0) }], rowCount: 1 };
      }
      if (sql.includes("FOR UPDATE")) {
        return options.rowEnabled === undefined
          ? { rows: [], rowCount: 0 }
          : { rows: [{ enabled: options.rowEnabled }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO scheduled_jobs") || sql.includes("UPDATE scheduled_jobs")) {
        return { rows: [fakeJobRow({ tenant_id: "tenant-1" })], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    // Statement kinds in order, to check what runs in the one transaction.
    const statements = () =>
      db.calls
        .map(({ sql, params }) => {
          const text = sql.trim();
          if (text.startsWith("SELECT set_config")) return null;
          if (text.startsWith("SELECT pg_advisory_xact_lock")) return `lock:${String(params[0])}`;
          if (text.includes("COUNT(*)")) return "count";
          if (text.includes("FOR UPDATE")) return "job-row-lock";
          return text.split(/\s+/)[0]!.toUpperCase();
        })
        .filter((kind): kind is string => kind !== null);
    return { store: new UserSettingsStore(db as never), statements };
  }

  describe("createScheduledJob", () => {
    it("takes the user's quota lock, then counts, then inserts in one transaction", async () => {
      const { store, statements } = scriptedStore({ activeJobs: 49 });

      const result = await store.createScheduledJob(jobInput(), { maxActive: 50 });

      expect(result.status).toBe("created");
      expect(statements()).toEqual(["BEGIN", quotaLock, "count", "INSERT", "COMMIT"]);
    });

    it("reports limit_reached at the cap and inserts nothing", async () => {
      const { store, statements } = scriptedStore({ activeJobs: 50 });

      const result = await store.createScheduledJob(jobInput(), { maxActive: 50 });

      expect(result).toEqual({ status: "limit_reached" });
      expect(statements()).toEqual(["BEGIN", quotaLock, "count", "COMMIT"]);
    });

    it("does not lock or count for a disabled job, even at the cap", async () => {
      const { store, statements } = scriptedStore({ activeJobs: 50 });

      const result = await store.createScheduledJob(jobInput({ enabled: false }), { maxActive: 50 });

      expect(result.status).toBe("created");
      expect(statements()).toEqual(["BEGIN", "INSERT", "COMMIT"]);
    });

    it("does not lock or count when the cap is 0 (disabled)", async () => {
      const { store, statements } = scriptedStore({ activeJobs: 500 });

      const result = await store.createScheduledJob(jobInput(), { maxActive: 0 });

      expect(result.status).toBe("created");
      expect(statements()).toEqual(["BEGIN", "INSERT", "COMMIT"]);
    });

    it("fails closed when the quota read fails: rolls back and inserts nothing", async () => {
      const db = new FakeDatabase();
      db.onQuery((sql) => {
        if (sql.includes("COUNT(*)")) throw new Error("count unavailable");
        return { rows: [], rowCount: 0 };
      });
      const store = new UserSettingsStore(db as never);

      await expect(store.createScheduledJob(jobInput(), { maxActive: 50 })).rejects.toThrow("count unavailable");

      const kinds = db.calls.map(({ sql }) => sql.trim().split(/\s+/)[0]!.toUpperCase());
      expect(kinds).toContain("ROLLBACK");
      expect(kinds).not.toContain("INSERT");
      expect(kinds).not.toContain("COMMIT");
    });

    it("locks per (tenant, user), so another user's key differs", async () => {
      const { store, statements } = scriptedStore({ activeJobs: 0 });

      await store.createScheduledJob({ ...jobInput(), userId: "user-2" }, { maxActive: 5 });

      expect(statements()[1]).toBe(`lock:${JSON.stringify(["scheduled-job-quota", "tenant-1", "user-2"])}`);
    });
  });

  describe("updateScheduledJob", () => {
    it("locks the quota first, then the job row, and counts before enabling a disabled job", async () => {
      const { store, statements } = scriptedStore({ activeJobs: 49, rowEnabled: false });

      const result = await store.updateScheduledJob(jobInput(), { maxActive: 50 });

      expect(result.status).toBe("updated");
      expect(statements()).toEqual(["BEGIN", quotaLock, "job-row-lock", "count", "UPDATE", "COMMIT"]);
    });

    it("reports limit_reached for a disabled job at the cap and writes nothing", async () => {
      const { store, statements } = scriptedStore({ activeJobs: 50, rowEnabled: false });

      const result = await store.updateScheduledJob(jobInput(), { maxActive: 50 });

      expect(result).toEqual({ status: "limit_reached" });
      expect(statements()).toEqual(["BEGIN", quotaLock, "job-row-lock", "count", "COMMIT"]);
    });

    it("does not count a job that the locked read shows as already enabled", async () => {
      // The caller's earlier read may be stale. The row read under the lock
      // decides, so enabling an enabled job at the cap must not count it twice.
      const { store, statements } = scriptedStore({ activeJobs: 50, rowEnabled: true });

      const result = await store.updateScheduledJob(jobInput(), { maxActive: 50 });

      expect(result.status).toBe("updated");
      expect(statements()).toEqual(["BEGIN", quotaLock, "job-row-lock", "UPDATE", "COMMIT"]);
    });

    it("reports not_found when the locked read finds no row", async () => {
      const { store, statements } = scriptedStore({ activeJobs: 0 });

      const result = await store.updateScheduledJob(jobInput(), { maxActive: 50 });

      expect(result).toEqual({ status: "not_found" });
      expect(statements()).toEqual(["BEGIN", quotaLock, "job-row-lock", "COMMIT"]);
    });

    it("does not lock or count when the update disables the job", async () => {
      const { store, statements } = scriptedStore({ activeJobs: 50, rowEnabled: true });

      const result = await store.updateScheduledJob(jobInput({ enabled: false }), { maxActive: 50 });

      expect(result.status).toBe("updated");
      expect(statements()).toEqual(["BEGIN", "UPDATE", "COMMIT"]);
    });

    it("does not lock or count when the cap is 0 (disabled)", async () => {
      const { store, statements } = scriptedStore({ activeJobs: 500, rowEnabled: false });

      const result = await store.updateScheduledJob(jobInput(), { maxActive: 0 });

      expect(result.status).toBe("updated");
      expect(statements()).toEqual(["BEGIN", "UPDATE", "COMMIT"]);
    });

    it("reports not_found when an unlocked update matches no row", async () => {
      const db = new FakeDatabase();
      const store = new UserSettingsStore(db as never);

      const result = await store.updateScheduledJob(jobInput({ enabled: false }), { maxActive: 50 });

      expect(result).toEqual({ status: "not_found" });
    });
  });
});
