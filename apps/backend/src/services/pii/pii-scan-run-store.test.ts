import { test, expect } from "vitest";

import type { Pool } from "../../lib/db.js";

import { PiiScanRunStore } from "./pii-scan-run-store.js";

class CaptureDatabase {
  lastQuery: { text: string; values: unknown[] } | null = null;
  insertReturn: Record<string, unknown> | null = null;
  updateReturn: Record<string, unknown> | null = null;
  selectReturn: Record<string, unknown>[] = [];

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
    if (text.trim().startsWith("INSERT INTO pii_scan_runs")) {
      return { rows: this.insertReturn ? [this.insertReturn] : [], rowCount: 1 };
    }
    if (text.trim().startsWith("UPDATE pii_scan_runs")) {
      return { rows: this.updateReturn ? [this.updateReturn] : [], rowCount: this.updateReturn ? 1 : 0 };
    }
    if (text.trim().startsWith("SELECT")) {
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
    scan_run_id: "scan-1",
    subject_type: "message",
    subject_id: "msg-1",
    source_session_id: "session-1",
    source_user_id: "user-1",
    mode: "block",
    provider_type: "openrouter",
    provider_model: "google/gemini-2.5-flash",
    status: "pending",
    findings_json: [],
    summary_text: null,
    action_taken: null,
    error_message: null,
    created_at: now,
    updated_at: now,
    completed_at: null,
    ...overrides
  };
}

test("PiiScanRunStore.create inserts with defaults and returns mapped record", async () => {
  const db = new CaptureDatabase();
  db.insertReturn = sampleRow();
  const store = new PiiScanRunStore(db as unknown as Pool);

  const record = await store.create({
    tenantId: "tenant-1",
    scanRunId: "scan-1",
    subjectType: "message",
    subjectId: "msg-1",
    sourceSessionId: "session-1",
    sourceUserId: "user-1",
    mode: "block",
    providerType: "openrouter",
    providerModel: "google/gemini-2.5-flash"
  });

  expect(db.lastQuery).toBeTruthy();
  // Column-presence (not positional binds): the INSERT targets pii_scan_runs
  // and includes the status + findings_json columns we rely on below.
  expect(db.lastQuery!.text).toMatch(/INSERT INTO pii_scan_runs/);
  expect(db.lastQuery!.text).toMatch(/\bstatus\b/);
  expect(db.lastQuery!.text).toMatch(/\bfindings_json\b/);
  // The inputs + applied defaults reach the query as bound values, regardless
  // of column order. Default status is 'pending'; default findings serialize
  // to "[]".
  expect(db.lastQuery!.values).toContain("tenant-1");
  expect(db.lastQuery!.values).toContain("scan-1");
  expect(db.lastQuery!.values).toContain("message");
  expect(db.lastQuery!.values).toContain("pending");
  expect(db.lastQuery!.values).toContain("[]");
  expect(record.scanRunId).toBe("scan-1");
  expect(record.status).toBe("pending");
  expect(record.findings).toEqual([]);
});

test("PiiScanRunStore.create serializes findings_json", async () => {
  const db = new CaptureDatabase();
  db.insertReturn = sampleRow({
    status: "completed",
    findings_json: [
      { entityType: "email", value: "x@y.com", start: 0, end: 7, confidence: "high" }
    ]
  });
  const store = new PiiScanRunStore(db as unknown as Pool);

  await store.create({
    tenantId: "tenant-1",
    subjectType: "message",
    subjectId: "msg-1",
    mode: "detect",
    status: "completed",
    findings: [
      { entityType: "email", value: "x@y.com", start: 0, end: 7, confidence: "high" }
    ]
  });

  expect(db.lastQuery).toBeTruthy();
  // findings_json is bound as a serialized JSON string. Locate it by content
  // (a value that parses to the findings array) rather than by bind position.
  const serializedFindings = (db.lastQuery!.values as unknown[]).find((v) => {
    if (typeof v !== "string") return false;
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) && parsed[0]?.entityType === "email";
    } catch {
      return false;
    }
  });
  expect(serializedFindings).toBeTruthy();
  const parsed = JSON.parse(String(serializedFindings));
  expect(parsed.length).toBe(1);
  expect(parsed[0].entityType).toBe("email");
});

test("PiiScanRunStore.update builds patch SQL with only provided fields", async () => {
  const db = new CaptureDatabase();
  db.updateReturn = sampleRow({ status: "completed", summary_text: "ok", action_taken: "report" });
  const store = new PiiScanRunStore(db as unknown as Pool);

  const updated = await store.update("tenant-1", "scan-1", {
    status: "completed",
    summaryText: "ok",
    actionTaken: "report",
    completedAt: new Date("2026-04-17T00:00:00Z")
  });

  expect(db.lastQuery).toBeTruthy();
  expect(db.lastQuery!.text).toMatch(/UPDATE pii_scan_runs/);
  // The patch builder emits a SET clause for each provided column (and always
  // bumps updated_at). Assert column presence rather than the generated bind
  // numbers, which are an implementation detail of clause ordering.
  expect(db.lastQuery!.text).toMatch(/\bstatus\s*=/);
  expect(db.lastQuery!.text).toMatch(/\bsummary_text\s*=/);
  expect(db.lastQuery!.text).toMatch(/\baction_taken\s*=/);
  expect(db.lastQuery!.text).toMatch(/\bcompleted_at\s*=/);
  expect(db.lastQuery!.text).toMatch(/updated_at\s*=\s*NOW\(\)/);
  // Fields NOT in the patch must not appear in the SET clause.
  expect(db.lastQuery!.text).not.toMatch(/\bprovider_type\s*=/);
  expect(db.lastQuery!.text).not.toMatch(/\bfindings_json\s*=/);
  // Patch values + the WHERE scope all reach the query as bound values.
  expect(db.lastQuery!.values).toContain("completed");
  expect(db.lastQuery!.values).toContain("ok");
  expect(db.lastQuery!.values).toContain("report");
  expect(db.lastQuery!.values).toContain("tenant-1");
  expect(db.lastQuery!.values).toContain("scan-1");
  expect(updated).toBeTruthy();
  expect(updated?.status).toBe("completed");
});

test("PiiScanRunStore.update returns null when row missing", async () => {
  const db = new CaptureDatabase();
  db.updateReturn = null;
  const store = new PiiScanRunStore(db as unknown as Pool);

  const updated = await store.update("tenant-1", "missing", { status: "failed" });
  expect(updated).toBe(null);
});

test("PiiScanRunStore.getById returns mapped record", async () => {
  const db = new CaptureDatabase();
  db.selectReturn = [sampleRow({ status: "completed" })];
  const store = new PiiScanRunStore(db as unknown as Pool);

  const record = await store.getById("tenant-1", "scan-1");
  expect(record).toBeTruthy();
  expect(record?.scanRunId).toBe("scan-1");
  expect(record?.status).toBe("completed");
});

test("PiiScanRunStore.listForSubject queries by subject tuple", async () => {
  const db = new CaptureDatabase();
  db.selectReturn = [sampleRow(), sampleRow({ scan_run_id: "scan-2" })];
  const store = new PiiScanRunStore(db as unknown as Pool);

  const rows = await store.listForSubject("tenant-1", "message", "msg-1", 10);

  expect(db.lastQuery).toBeTruthy();
  expect(db.lastQuery!.text).toMatch(/FROM pii_scan_runs/);
  // The subject tuple + limit all reach the query as bound values.
  expect(db.lastQuery!.values).toContain("tenant-1");
  expect(db.lastQuery!.values).toContain("message");
  expect(db.lastQuery!.values).toContain("msg-1");
  expect(db.lastQuery!.values).toContain(10);
  expect(rows.length).toBe(2);
});

test("mapRow preserves canonical action_taken values", async () => {
  const db = new CaptureDatabase();
  db.selectReturn = [sampleRow({ action_taken: "report" })];
  const store = new PiiScanRunStore(db as unknown as Pool);
  const record = await store.getById("tenant-1", "scan-1");
  expect(record?.actionTaken).toBe("report");
});
