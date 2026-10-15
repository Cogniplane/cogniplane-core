import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";

import type { Pool } from "../lib/db.js";
import { TenantDeletionService } from "./tenant-deletion-service.js";

// Unit tests for the operator offboarding path. They use an in-memory stand-in
// for the privileged pool, so they prove the service's own decisions: replay
// checks, transaction boundaries and cleanup accounting. The real cascade,
// cross-tenant object sharing and receipt content are proven against Postgres
// in src/integration/tenant-deletion.integration.test.ts.

type QueueItem = { requestId: string; kind: string; locator: string; attempts: number; lastError: string | null };
type Receipt = Record<string, unknown>;
type Logged = { text: string; values: unknown[]; via: "client" | "pool" };

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function receiptRow(requestId: string, tenantId: string, overrides: Receipt = {}): Receipt {
  return {
    request_id: requestId, tenant_id_hash: hash(tenantId), status: "cleanup_failed",
    row_counts: {}, object_count: 0, runtime_thread_count: 0,
    deleted_object_count: 0, retained_shared_object_count: 0, purged_runtime_thread_count: 0,
    redis_disposition: "r", third_party_disposition: "t", backup_disposition: "b",
    initiated_at: "2026-10-01T00:00:00.000Z", database_deleted_at: "2026-10-01T00:00:01.000Z",
    completed_at: null, last_error: null,
    ...overrides
  };
}

class OffboardingDatabase {
  readonly log: Logged[] = [];
  readonly releases: unknown[] = [];
  connections = 0;
  readonly tenants = new Set<string>();
  readonly members: { tenantId: string; userId: string }[] = [];
  readonly receipts = new Map<string, Receipt>();
  readonly queue: QueueItem[] = [];
  // Objects the enqueue statement finds for each tenant.
  readonly tenantObjects = new Map<string, { kind: string; locator: string }[]>();
  // Locators that rows outside the deleted tenant still reference.
  readonly sharedLocators = new Set<string>();
  failOn: { fragment: string; error: Error } | null = null;
  rollbackError: Error | null = null;

  asPool(): Pool {
    return this as unknown as Pool;
  }

  async connect() {
    this.connections += 1;
    return {
      query: (text: string, values: unknown[] = []) => this.run(text, values, "client"),
      release: (error?: unknown) => {
        this.releases.push(error);
      }
    };
  }

  async query(text: string, values: unknown[] = []) {
    return this.run(text, values, "pool");
  }

  statements(): string[] {
    return this.log.map(entry => entry.text.trim());
  }

  ran(fragment: string): boolean {
    return this.log.some(entry => entry.text.includes(fragment));
  }

  private result(rows: Record<string, unknown>[], rowCount = rows.length) {
    return { rows, rowCount };
  }

  private async run(text: string, values: unknown[], via: Logged["via"]) {
    this.log.push({ text, values, via });
    if (this.failOn && text.includes(this.failOn.fragment)) throw this.failOn.error;
    const sql = text.trim();
    if (sql === "BEGIN" || sql === "COMMIT") return this.result([]);
    if (sql === "ROLLBACK") {
      if (this.rollbackError) throw this.rollbackError;
      return this.result([]);
    }
    if (sql.startsWith("SELECT * FROM tenant_deletion_receipts")) {
      const receipt = this.receipts.get(String(values[0]));
      return this.result(receipt ? [receipt] : []);
    }
    if (sql.startsWith("SELECT tenant_id FROM tenants")) {
      return this.result(this.tenants.has(String(values[0])) ? [{ tenant_id: values[0] }] : []);
    }
    if (sql.includes("FROM information_schema.columns")) {
      return this.result([{ table_name: "sessions" }, { table_name: "tenant_memberships" }]);
    }
    if (sql.startsWith("SELECT COUNT(*)::text AS count FROM public.")) {
      const count = sql.includes('"tenant_memberships"')
        ? this.members.filter(member => member.tenantId === values[0]).length
        : 1;
      return this.result([{ count: String(count) }]);
    }
    if (sql.startsWith("SELECT user_id FROM tenant_memberships")) {
      return this.result(this.members.filter(member => member.tenantId === values[0]).map(member => ({ user_id: member.userId })));
    }
    if (sql.startsWith("INSERT INTO tenant_deletion_receipts")) {
      const [requestId, tenantIdHash, rowCounts, redis, thirdParty, backup] = values;
      this.receipts.set(String(requestId), {
        request_id: requestId, tenant_id_hash: tenantIdHash, status: "cleanup_pending",
        row_counts: JSON.parse(String(rowCounts)), object_count: 0, runtime_thread_count: 0,
        deleted_object_count: 0, retained_shared_object_count: 0, purged_runtime_thread_count: 0,
        redis_disposition: redis, third_party_disposition: thirdParty, backup_disposition: backup,
        initiated_at: "2026-10-01T00:00:00.000Z", database_deleted_at: "2026-10-01T00:00:01.000Z",
        completed_at: null, last_error: null
      });
      return this.result([], 1);
    }
    if (sql.startsWith("INSERT INTO tenant_deletion_cleanup")) {
      const requestId = String(values[0]);
      const items = sql.includes("'redis_database'")
        ? [{ kind: "redis_database", locator: "dedicated-environment-database" }]
        : this.tenantObjects.get(String(values[1])) ?? [];
      for (const item of items) this.queue.push({ requestId, ...item, attempts: 0, lastError: null });
      return this.result([], items.length);
    }
    if (sql.includes("COUNT(*) FILTER (WHERE kind IN ('artifact', 'skill_bundle'))")) {
      const queued = this.queue.filter(item => item.requestId === values[0]);
      return this.result([{
        objects: String(queued.filter(item => item.kind === "artifact" || item.kind === "skill_bundle").length),
        runtime_threads: String(queued.filter(item => item.kind === "runtime_thread").length)
      }]);
    }
    if (sql.startsWith("UPDATE tenant_deletion_receipts") && sql.includes("SET object_count")) {
      Object.assign(this.receipts.get(String(values[0]))!, { object_count: values[1], runtime_thread_count: values[2] });
      return this.result([], 1);
    }
    if (sql.startsWith("DELETE FROM tenants")) {
      this.tenants.delete(String(values[0]));
      for (let i = this.members.length - 1; i >= 0; i -= 1) {
        if (this.members[i]!.tenantId === values[0]) this.members.splice(i, 1);
      }
      return this.result([], 1);
    }
    if (sql.startsWith("DELETE FROM users u")) {
      const orphaned = (values[0] as string[]).filter(userId => !this.members.some(member => member.userId === userId));
      return this.result([], orphaned.length);
    }
    if (sql.startsWith("UPDATE tenant_deletion_receipts SET row_counts")) {
      this.receipts.get(String(values[0]))!.row_counts = JSON.parse(String(values[1]));
      return this.result([], 1);
    }
    if (sql.startsWith("SELECT kind, locator")) {
      const pending = this.queue
        .filter(item => item.requestId === values[0])
        .sort((a, b) => a.kind.localeCompare(b.kind) || a.locator.localeCompare(b.locator));
      return this.result(pending.map(({ kind, locator }) => ({ kind, locator })));
    }
    if (sql.startsWith("SELECT 1 FROM artifacts") || sql.startsWith("SELECT 1 FROM admin_skill_revisions")) {
      return this.result([], this.sharedLocators.has(String(values[0])) ? 1 : 0);
    }
    if (sql.startsWith("WITH removed AS")) {
      const [requestId, kind, locator, outcome] = values.map(String);
      const index = this.queue.findIndex(item =>
        item.requestId === requestId && item.kind === kind && item.locator === locator);
      if (index >= 0) {
        this.queue.splice(index, 1);
        const receipt = this.receipts.get(requestId)!;
        const object = kind === "artifact" || kind === "skill_bundle";
        if (object && outcome === "deleted") receipt.deleted_object_count = Number(receipt.deleted_object_count) + 1;
        if (object && outcome === "retained_shared") {
          receipt.retained_shared_object_count = Number(receipt.retained_shared_object_count) + 1;
        }
        if (kind === "runtime_thread") {
          receipt.purged_runtime_thread_count = Number(receipt.purged_runtime_thread_count) + 1;
        }
      }
      return this.result([], index >= 0 ? 1 : 0);
    }
    if (sql.startsWith("UPDATE tenant_deletion_cleanup")) {
      const item = this.queue.find(entry =>
        entry.requestId === values[0] && entry.kind === values[1] && entry.locator === values[2]);
      if (item) {
        item.attempts += 1;
        item.lastError = String(values[3]);
      }
      return this.result([], item ? 1 : 0);
    }
    if (sql.startsWith("SELECT COUNT(*)::text AS count FROM tenant_deletion_cleanup")) {
      return this.result([{ count: String(this.queue.filter(item => item.requestId === values[0]).length) }]);
    }
    if (sql.startsWith("UPDATE tenant_deletion_receipts") && sql.includes("SET status")) {
      Object.assign(this.receipts.get(String(values[0]))!, {
        status: values[1],
        completed_at: values[1] === "completed" ? "2026-10-01T00:00:02.000Z" : null,
        last_error: values[2]
      });
      return this.result([], 1);
    }
    throw new Error(`OffboardingDatabase: unexpected statement: ${sql}`);
  }
}

function storage() {
  return {
    artifactStorage: { delete: vi.fn(async (_key: string) => undefined) },
    skillBundleStorage: { deleteBundle: vi.fn(async (_uri: string) => undefined) },
    purgeRuntimeThread: vi.fn(async (_threadId: string) => undefined)
  };
}

const input = (requestId: string, tenantId: string) => ({
  requestId,
  tenantId,
  redisDisposition: "No dedicated Redis database.",
  thirdPartyDisposition: "No third-party processors.",
  backupDisposition: "Backups expire on schedule."
});

function seedTenant(db: OffboardingDatabase, tenantId: string) {
  db.tenants.add(tenantId);
  db.members.push({ tenantId, userId: "only-here" }, { tenantId, userId: "also-elsewhere" });
  db.members.push({ tenantId: "tenant-other", userId: "also-elsewhere" });
  db.tenantObjects.set(tenantId, [
    { kind: "artifact", locator: "tenants/t1/dedicated.pdf" },
    { kind: "artifact", locator: "shared/template.pdf" },
    { kind: "skill_bundle", locator: "bundles/t1/skill.zip" },
    { kind: "runtime_thread", locator: "session-1" }
  ]);
  db.sharedLocators.add("shared/template.pdf");
}

function expectRolledBackWithoutCleanup(db: OffboardingDatabase, deps: ReturnType<typeof storage>) {
  const statements = db.statements();
  expect(statements).toContain("ROLLBACK");
  expect(statements).not.toContain("COMMIT");
  expect(db.log.filter(entry => entry.via === "pool")).toEqual([]);
  expect(deps.artifactStorage.delete).not.toHaveBeenCalled();
  expect(deps.skillBundleStorage.deleteBundle).not.toHaveBeenCalled();
  expect(deps.purgeRuntimeThread).not.toHaveBeenCalled();
  expect(db.releases).toHaveLength(1);
}

describe("TenantDeletionService", () => {
  test("rejects a blank request or tenant identifier before it opens a connection", async () => {
    const db = new OffboardingDatabase();
    const service = new TenantDeletionService({ db: db.asPool(), ...storage() });

    await expect(service.execute(input("  ", "tenant-1"))).rejects.toThrow("requestId is required.");
    await expect(service.execute(input("request-1", " "))).rejects.toThrow("tenantId is required.");
    expect(db.connections).toBe(0);
    expect(db.log).toEqual([]);
  });

  test("deletes the tenant once, keeps shared objects and removes only users without another tenant", async () => {
    const db = new OffboardingDatabase();
    seedTenant(db, "tenant-1");
    const deps = storage();
    const flushRedis = vi.fn(async () => undefined);
    const service = new TenantDeletionService({ db: db.asPool(), ...deps, flushRedis });

    const receipt = await service.execute(input("request-1", "tenant-1"));

    expect(receipt).toMatchObject({
      requestId: "request-1",
      tenantIdHash: hash("tenant-1"),
      status: "completed",
      objectCount: 3,
      runtimeThreadCount: 1,
      deletedObjectCount: 2,
      retainedSharedObjectCount: 1,
      purgedRuntimeThreadCount: 1,
      lastError: null
    });
    expect(receipt.rowCounts).toEqual({ sessions: 1, tenant_memberships: 2, orphaned_users: 1 });
    expect(receipt.completedAt).not.toBeNull();
    expect(deps.artifactStorage.delete.mock.calls).toEqual([["tenants/t1/dedicated.pdf"]]);
    expect(deps.skillBundleStorage.deleteBundle.mock.calls).toEqual([["bundles/t1/skill.zip"]]);
    expect(deps.purgeRuntimeThread.mock.calls).toEqual([["session-1"]]);
    expect(flushRedis).toHaveBeenCalledTimes(1);
    expect(db.tenants.has("tenant-1")).toBe(false);
    expect(db.queue).toEqual([]);

    // The deletion runs in one transaction that commits before any object is
    // removed, and the durable receipt never stores the raw tenant identifier.
    const statements = db.statements();
    expect(statements.indexOf("COMMIT")).toBeLessThan(statements.findIndex(sql => sql.startsWith("SELECT kind, locator")));
    expect(statements.filter(sql => sql === "BEGIN")).toHaveLength(1);
    const receiptWrites = db.log.filter(entry => entry.text.includes("tenant_deletion_receipts") &&
      !entry.text.trim().startsWith("SELECT"));
    expect(receiptWrites.length).toBeGreaterThan(0);
    expect(JSON.stringify(receiptWrites.map(entry => entry.values))).not.toContain("tenant-1");
    expect(db.releases).toHaveLength(2);
  });

  test("refuses a replayed request ID that belongs to another tenant and deletes nothing", async () => {
    const db = new OffboardingDatabase();
    seedTenant(db, "tenant-1");
    db.receipts.set("request-1", receiptRow("request-1", "tenant-other"));
    const deps = storage();
    const service = new TenantDeletionService({ db: db.asPool(), ...deps });

    await expect(service.execute(input("request-1", "tenant-1"))).rejects.toThrow(
      "Request request-1 belongs to a different tenant identifier."
    );

    expect(db.ran("DELETE FROM tenants")).toBe(false);
    expect(db.ran("INSERT INTO tenant_deletion_receipts")).toBe(false);
    expect(db.tenants.has("tenant-1")).toBe(true);
    expectRolledBackWithoutCleanup(db, deps);
  });

  test("fails without a receipt when the tenant does not exist", async () => {
    const db = new OffboardingDatabase();
    const deps = storage();
    const service = new TenantDeletionService({ db: db.asPool(), ...deps });

    await expect(service.execute(input("request-1", "tenant-missing"))).rejects.toThrow(
      "Tenant tenant-missing does not exist and has no matching deletion receipt."
    );

    expect(db.receipts.size).toBe(0);
    expect(db.ran("DELETE FROM")).toBe(false);
    expectRolledBackWithoutCleanup(db, deps);
  });

  test("rolls back the whole deletion and removes no object when a statement fails inside the transaction", async () => {
    const db = new OffboardingDatabase();
    seedTenant(db, "tenant-1");
    const failure = new Error("could not delete tenant row");
    db.failOn = { fragment: "DELETE FROM tenants", error: failure };
    const deps = storage();
    const service = new TenantDeletionService({ db: db.asPool(), ...deps });

    await expect(service.execute(input("request-1", "tenant-1"))).rejects.toBe(failure);

    // The receipt and queue rows were written earlier in the same transaction,
    // so only ROLLBACK keeps them from claiming a deletion that did not happen.
    const statements = db.statements();
    expect(statements.findIndex(sql => sql.startsWith("INSERT INTO tenant_deletion_receipts")))
      .toBeLessThan(statements.indexOf("ROLLBACK"));
    expect(db.ran("DELETE FROM users")).toBe(false);
    expectRolledBackWithoutCleanup(db, deps);
  });

  test("reports the original failure and still releases the client when ROLLBACK also fails", async () => {
    const db = new OffboardingDatabase();
    seedTenant(db, "tenant-1");
    const failure = new Error("receipt insert failed");
    db.failOn = { fragment: "INSERT INTO tenant_deletion_receipts", error: failure };
    db.rollbackError = new Error("connection terminated");
    const deps = storage();
    const service = new TenantDeletionService({ db: db.asPool(), ...deps });

    await expect(service.execute(input("request-1", "tenant-1"))).rejects.toBe(failure);
    expectRolledBackWithoutCleanup(db, deps);
  });

  test("marks the receipt cleanup_failed and keeps a failed object queued without its key in the receipt", async () => {
    const db = new OffboardingDatabase();
    seedTenant(db, "tenant-1");
    const deps = storage();
    deps.artifactStorage.delete.mockRejectedValueOnce(new Error("object store unavailable"));
    const service = new TenantDeletionService({ db: db.asPool(), ...deps });

    const receipt = await service.execute(input("request-1", "tenant-1"));

    expect(receipt).toMatchObject({
      status: "cleanup_failed",
      completedAt: null,
      lastError: "artifact: object store unavailable",
      deletedObjectCount: 1,
      retainedSharedObjectCount: 1,
      purgedRuntimeThreadCount: 1
    });
    expect(db.queue).toEqual([{
      requestId: "request-1",
      kind: "artifact",
      locator: "tenants/t1/dedicated.pdf",
      attempts: 1,
      lastError: "artifact: object store unavailable"
    }]);
    // Without a Redis client, no Redis flush is queued at all.
    expect(db.ran("'redis_database'")).toBe(false);
  });

  test("resumes cleanup for a replay by the same tenant without deleting database rows again", async () => {
    const db = new OffboardingDatabase();
    db.receipts.set("request-1", receiptRow("request-1", "tenant-1", {
      object_count: 1, last_error: "artifact: object store unavailable"
    }));
    db.queue.push({ requestId: "request-1", kind: "artifact", locator: "tenants/t1/dedicated.pdf", attempts: 1, lastError: "x" });
    const deps = storage();
    const service = new TenantDeletionService({ db: db.asPool(), ...deps });

    const receipt = await service.execute(input("request-1", "tenant-1"));

    expect(receipt).toMatchObject({ status: "completed", deletedObjectCount: 1, lastError: null });
    expect(deps.artifactStorage.delete.mock.calls).toEqual([["tenants/t1/dedicated.pdf"]]);
    expect(db.ran("SELECT tenant_id FROM tenants")).toBe(false);
    expect(db.ran("DELETE FROM tenants")).toBe(false);
  });

  test("fails a queued Redis flush when this run has no Redis client", async () => {
    const db = new OffboardingDatabase();
    db.receipts.set("request-1", receiptRow("request-1", "tenant-1"));
    db.queue.push({ requestId: "request-1", kind: "redis_database", locator: "dedicated-environment-database", attempts: 0, lastError: null });
    const service = new TenantDeletionService({ db: db.asPool(), ...storage() });

    const receipt = await service.execute(input("request-1", "tenant-1"));

    expect(receipt).toMatchObject({
      status: "cleanup_failed",
      lastError: "redis_database: Redis cleanup was queued but no Redis client was configured."
    });
    expect(db.queue).toHaveLength(1);
    expect(db.queue[0]!.attempts).toBe(1);
  });
});
