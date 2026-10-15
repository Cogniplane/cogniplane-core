import { describe, it, beforeEach, expect } from "vitest";
import { UserSettingsStore } from "./user-settings-store.js";

// ---------------------------------------------------------------------------
// In-memory fake Pool that captures queries and returns scripted rows
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers to build fake DB rows
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UserSettingsStore – scheduler methods", () => {
  let db: FakeDatabase;
  let store: UserSettingsStore;

  beforeEach(() => {
    db = new FakeDatabase();
    store = new UserSettingsStore(db as never);
  });

  // ---- listDueJobs -------------------------------------------------------

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
      // Verify the query was parameterized with the limit
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

  // ---- claimJob -----------------------------------------------------------

  describe("claimJob", () => {
    it("returns the job when successfully claimed", async () => {
      const claimed = fakeJobRow({
        job_id: "job-1",
        last_run_at: "2026-03-18T09:00:00.000Z",
        next_run_at: "2026-03-19T09:00:00.000Z"
      });
      db.onQuery((sql) => {
        if (sql.includes("UPDATE") && sql.includes("scheduled_jobs") && sql.includes("RETURNING")) {
          return { rows: [claimed], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });

      const result = await store.claimJob("tenant-1", "job-1", "2026-03-19T09:00:00.000Z");

      expect(result).toBeTruthy();
      expect(result!.jobId).toBe("job-1");
      expect(result!.nextRunAt).toBe("2026-03-19T09:00:00.000Z");
    });

    it("returns null when the job was already claimed (no rows)", async () => {
      db.onQuery(() => ({ rows: [], rowCount: 0 }));

      const result = await store.claimJob("tenant-1", "job-1", "2026-03-19T09:00:00.000Z");

      expect(result).toBe(null);
    });

    it("scopes the RLS-bypassing claim to tenantId and passes jobId + nextRunAt", async () => {
      db.onQuery(() => ({ rows: [], rowCount: 0 }));

      await store.claimJob("tenant-42", "job-42", "2026-03-20T00:00:00.000Z");

      const call = db.calls[0];
      expect(call).toBeTruthy();
      // tenant_id MUST be the first predicate — it is the only isolation
      // guarantee on the BYPASSRLS scheduler pool.
      expect(call.sql).toContain("tenant_id = $1");
      expect(call.params[0]).toBe("tenant-42");
      expect(call.params[1]).toBe("job-42");
      expect(call.params[2]).toBe("2026-03-20T00:00:00.000Z");
    });
  });

  // ---- createJobRun + completeJobRun --------------------------------------

  describe("createJobRun + completeJobRun", () => {
    it("maps returned pending and completed run rows", async () => {
      // createJobRun handler
      db.onQuery((sql) => {
        if (sql.includes("INSERT") && sql.includes("scheduled_job_runs")) {
          return {
            rows: [fakeRunRow({ run_id: "run-abc", job_id: "job-1", user_id: "user-1", session_id: "sess-1", status: "pending" })],
            rowCount: 1
          };
        }
        if (sql.includes("UPDATE") && sql.includes("scheduled_job_runs")) {
          return {
            rows: [
              fakeRunRow({
                run_id: "run-abc",
                status: "completed",
                completed_at: "2026-03-18T09:01:00.000Z",
                duration_ms: 1500,
                input_tokens: 200,
                output_tokens: 300,
                summary: "All done"
              })
            ],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 0 };
      });

      const created = await store.createJobRun({
        tenantId: "test-tenant",
        runId: "run-abc",
        jobId: "job-1",
        userId: "user-1",
        sessionId: "sess-1"
      });

      expect(created.runId).toBe("run-abc");
      expect(created.status).toBe("pending");
      expect(created.sessionId).toBe("sess-1");

      const completed = await store.completeJobRun({
        tenantId: "test-tenant",
        runId: "run-abc",
        status: "completed",
        durationMs: 1500,
        inputTokens: 200,
        outputTokens: 300,
        errorMessage: null,
        summary: "All done"
      });

      expect(completed.runId).toBe("run-abc");
      expect(completed.status).toBe("completed");
      expect(completed.durationMs).toBe(1500);
      expect(completed.inputTokens).toBe(200);
      expect(completed.outputTokens).toBe(300);
      expect(completed.summary).toBe("All done");
    });

    it("maps a returned failed run", async () => {
      db.onQuery((sql) => {
        if (sql.includes("UPDATE") && sql.includes("scheduled_job_runs")) {
          return {
            rows: [
              fakeRunRow({
                run_id: "run-err",
                status: "failed",
                error_message: "timeout",
                completed_at: "2026-03-18T09:05:00.000Z",
                duration_ms: 30000
              })
            ],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 0 };
      });

      const completed = await store.completeJobRun({
        tenantId: "test-tenant",
        runId: "run-err",
        status: "failed",
        durationMs: 30000,
        inputTokens: 0,
        outputTokens: 0,
        errorMessage: "timeout",
        summary: null
      });

      expect(completed.status).toBe("failed");
      expect(completed.errorMessage).toBe("timeout");
    });
  });

  // ---- sweepStaleJobRuns ---------------------------------------------------

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

      const call = db.calls[0];
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

  // ---- listJobRuns --------------------------------------------------------

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
    nextRunAt: "2026-03-18T09:00:00.000Z"
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
