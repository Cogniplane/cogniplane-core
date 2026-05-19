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
    it("returns only enabled jobs with past nextRunAt", async () => {
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

      const result = await store.claimJob("job-1", "2026-03-19T09:00:00.000Z");

      expect(result).toBeTruthy();
      expect(result!.jobId).toBe("job-1");
      expect(result!.nextRunAt).toBe("2026-03-19T09:00:00.000Z");
    });

    it("returns null when the job was already claimed (no rows)", async () => {
      db.onQuery(() => ({ rows: [], rowCount: 0 }));

      const result = await store.claimJob("job-1", "2026-03-19T09:00:00.000Z");

      expect(result).toBe(null);
    });

    it("passes jobId and nextRunAt as parameters", async () => {
      db.onQuery(() => ({ rows: [], rowCount: 0 }));

      await store.claimJob("job-42", "2026-03-20T00:00:00.000Z");

      const call = db.calls[0];
      expect(call).toBeTruthy();
      expect(call.params[0]).toBe("job-42");
      expect(call.params[1]).toBe("2026-03-20T00:00:00.000Z");
    });
  });

  // ---- createJobRun + completeJobRun --------------------------------------

  describe("createJobRun + completeJobRun", () => {
    it("creates a pending run and then completes it", async () => {
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

    it("completeJobRun can record an error", async () => {
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
      expect(call).toBeTruthy();
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
