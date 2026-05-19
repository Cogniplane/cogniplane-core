import { test, expect } from "vitest";

import type { Pool } from "../../lib/db.js";

import { PiiScanJobStore } from "./pii-scan-job-store.js";

class CaptureDatabase {
  lastQuery: { text: string; values: unknown[] } | null = null;
  insertReturn: Record<string, unknown> | null = null;
  updateReturn: Record<string, unknown> | null = null;
  selectReturn: Record<string, unknown>[] = [];
  claimReturn: Record<string, unknown>[] = [];

  async connect() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      async query(text: string, values: unknown[] = []) {
        return self._query(text, values);
      },
      async release() {}
    };
  }

  _query(text: string, values: unknown[] = []) {
    if (
      text === "BEGIN" ||
      text === "COMMIT" ||
      text === "ROLLBACK" ||
      text.startsWith("SELECT set_config")
    ) {
      return { rows: [], rowCount: 0 };
    }
    this.lastQuery = { text, values };
    const trimmed = text.trim();
    if (trimmed.startsWith("INSERT INTO pii_scan_jobs")) {
      return { rows: this.insertReturn ? [this.insertReturn] : [], rowCount: 1 };
    }
    if (trimmed.startsWith("WITH due")) {
      return { rows: this.claimReturn, rowCount: this.claimReturn.length };
    }
    if (trimmed.startsWith("UPDATE pii_scan_jobs")) {
      return {
        rows: this.updateReturn ? [this.updateReturn] : [],
        rowCount: this.updateReturn ? 1 : 0
      };
    }
    if (trimmed.startsWith("SELECT")) {
      return { rows: this.selectReturn, rowCount: this.selectReturn.length };
    }
    throw new Error(`Unexpected query: ${text}`);
  }

  async query(text: string, values: unknown[] = []) {
    return this._query(text, values);
  }
}

function sampleRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    tenant_id: "tenant-1",
    job_id: "job-1",
    scan_run_id: "scan-1",
    subject_type: "artifact",
    subject_id: "art-1",
    source_session_id: null,
    source_user_id: "user-1",
    mode: "detect",
    payload_json: {},
    status: "queued",
    attempts: 0,
    max_attempts: 3,
    run_after: now,
    claimed_at: null,
    completed_at: null,
    error_message: null,
    created_at: now,
    updated_at: now,
    ...overrides
  };
}

test("PiiScanJobStore.create inserts a queued row with defaults", async () => {
  const db = new CaptureDatabase();
  db.insertReturn = sampleRow();
  const store = new PiiScanJobStore(db as unknown as Pool);

  const job = await store.create({
    tenantId: "tenant-1",
    jobId: "job-1",
    scanRunId: "scan-1",
    subjectType: "artifact",
    subjectId: "art-1",
    sourceUserId: "user-1",
    mode: "detect",
    payload: { storageKey: "s3://bucket/key" }
  });

  expect(db.lastQuery).toBeTruthy();
  expect(db.lastQuery.text.includes("INSERT INTO pii_scan_jobs")).toBeTruthy();
  expect(db.lastQuery.values[0]).toBe("tenant-1");
  expect(db.lastQuery.values[1]).toBe("job-1");
  expect(db.lastQuery.values[7]).toBe("detect");
  expect(job.status).toBe("queued");
  expect(job.attempts).toBe(0);
});

test("PiiScanJobStore.claimDueJobs returns mapped rows and uses SKIP LOCKED query", async () => {
  const db = new CaptureDatabase();
  db.claimReturn = [sampleRow({ status: "claimed", attempts: 1, claimed_at: new Date().toISOString() })];
  const store = new PiiScanJobStore(db as unknown as Pool);

  const claimed = await store.claimDueJobs(5);

  expect(db.lastQuery).toBeTruthy();
  expect(db.lastQuery.text.includes("FOR UPDATE SKIP LOCKED")).toBeTruthy();
  expect(db.lastQuery.text.includes("SET")).toBeTruthy();
  expect(db.lastQuery.values[0]).toBe(5);
  expect(claimed.length).toBe(1);
  expect(claimed[0].status).toBe("claimed");
  expect(claimed[0].attempts).toBe(1);
});

test("PiiScanJobStore.markCompleted updates the job status", async () => {
  const db = new CaptureDatabase();
  db.updateReturn = sampleRow({ status: "completed", completed_at: new Date().toISOString() });
  const store = new PiiScanJobStore(db as unknown as Pool);

  await store.markCompleted("tenant-1", "job-1");

  expect(db.lastQuery).toBeTruthy();
  expect(db.lastQuery.text.includes("UPDATE pii_scan_jobs")).toBeTruthy();
  expect(db.lastQuery.text.includes("status = 'completed'")).toBeTruthy();
  expect(db.lastQuery.values[0]).toBe("tenant-1");
  expect(db.lastQuery.values[1]).toBe("job-1");
});

test("PiiScanJobStore.recordFailure requeues and stores the error message", async () => {
  const db = new CaptureDatabase();
  db.updateReturn = sampleRow({ status: "queued", attempts: 1, error_message: "timeout" });
  const store = new PiiScanJobStore(db as unknown as Pool);

  const updated = await store.recordFailure("tenant-1", "job-1", "timeout", { backoffMs: 15_000 });

  expect(db.lastQuery).toBeTruthy();
  expect(db.lastQuery.text.includes("attempts >= max_attempts")).toBeTruthy();
  expect(db.lastQuery.values[0]).toBe("tenant-1");
  expect(db.lastQuery.values[1]).toBe("job-1");
  expect(db.lastQuery.values[2]).toBe(15_000);
  expect(db.lastQuery.values[3]).toBe("timeout");
  // Transient default: permanent flag false.
  expect(db.lastQuery.values[4]).toBe(false);
  expect(updated).toBeTruthy();
  expect(updated?.status).toBe("queued");
  expect(updated?.errorMessage).toBe("timeout");
});

test("PiiScanJobStore.recordFailure with permanent=true forces status='failed' regardless of attempts", async () => {
  const db = new CaptureDatabase();
  db.updateReturn = sampleRow({ status: "failed", attempts: 1, error_message: "artifact_not_found" });
  const store = new PiiScanJobStore(db as unknown as Pool);

  const updated = await store.recordFailure("tenant-1", "job-1", "artifact_not_found", {
    permanent: true
  });

  expect(db.lastQuery).toBeTruthy();
  expect(db.lastQuery.values[4]).toBe(true);
  expect(updated).toBeTruthy();
  expect(updated?.status).toBe("failed");
});

test("PiiScanJobStore.getById returns null when missing", async () => {
  const db = new CaptureDatabase();
  db.selectReturn = [];
  const store = new PiiScanJobStore(db as unknown as Pool);

  const record = await store.getById("tenant-1", "missing");
  expect(record).toBe(null);
});
