import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";

import { UserSettingsStore } from "../services/user-settings-store.js";
import { TenantSettingsStore, TenantSettingsConflictError } from "../services/tenant-settings-store.js";
import { adminDatabaseUrl, appPool, maintenancePool, superuserPool } from "./support/database.js";
import { seedScheduledJob, seedTenantGraph } from "./support/fixtures.js";

describe.skipIf(!adminDatabaseUrl())("scheduler persistence", () => {
  test("organization default model survives partial updates and enforces the settings version", async () => {
    const { tenantId } = await seedTenantGraph();
    const store = new TenantSettingsStore(appPool());
    const initial = await store.upsert(tenantId, { defaultModelId: "openai/gpt-5.6-sol" });
    expect(initial.defaultModelId).toBe("openai/gpt-5.6-sol");

    const updated = await store.upsert(tenantId, {
      expectedVersion: initial.version,
      showEffortSelector: true
    });
    expect(updated.defaultModelId).toBe("openai/gpt-5.6-sol");
    expect(updated.version).toBe(initial.version + 1);
    expect((await store.get(tenantId))?.defaultModelId).toBe("openai/gpt-5.6-sol");

    await expect(store.upsert(tenantId, {
      expectedVersion: initial.version,
      defaultModelId: null
    })).rejects.toBeInstanceOf(TenantSettingsConflictError);
  });

  test("only one concurrent tenant settings save can use the same version", async () => {
    const { tenantId } = await seedTenantGraph();
    const store = new TenantSettingsStore(appPool());
    const initial = await store.upsert(tenantId, {});
    const results = await Promise.allSettled([
      store.upsert(tenantId, { expectedVersion: initial.version, developerInstructions: "writer A" }),
      store.upsert(tenantId, { expectedVersion: initial.version, developerInstructions: "writer B" })
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: expect.any(TenantSettingsConflictError) });
    expect((await store.get(tenantId))?.version).toBe(initial.version + 1);
  });
  test("listDueJobs excludes disabled, future, and unscheduled jobs", async () => {
    const tenant = await seedTenantGraph();
    const due = tenant.jobId;
    const future = await seedScheduledJob({ ...tenant, due: false });
    const disabled = await seedScheduledJob(tenant);
    const unscheduled = await seedScheduledJob(tenant);
    await superuserPool().query("UPDATE scheduled_jobs SET enabled = FALSE WHERE job_id = $1", [disabled]);
    await superuserPool().query("UPDATE scheduled_jobs SET next_run_at = NULL WHERE job_id = $1", [unscheduled]);

    const store = new UserSettingsStore(appPool(), maintenancePool());
    const jobs = await store.listDueJobs(10_000);
    const ownJobIds = jobs.filter((job) => job.tenantId === tenant.tenantId).map((job) => job.jobId);
    expect(ownJobIds).toEqual([due]);
    expect(jobs.map((job) => job.jobId)).not.toContain(future);
  });

  test.each(["completed", "failed"])("persists a pending run and its %s outcome", async (status) => {
    const tenant = await seedTenantGraph();
    const runId = randomUUID();
    const store = new UserSettingsStore(appPool(), maintenancePool());
    await store.createJobRun({ ...tenant, runId });

    const pending = await superuserPool().query("SELECT * FROM scheduled_job_runs WHERE run_id = $1", [runId]);
    expect(pending.rows[0]).toMatchObject({ status: "pending", job_id: tenant.jobId, session_id: tenant.sessionId });
    expect(pending.rows[0].completed_at).toBeNull();

    const errorMessage = status === "failed" ? "provider timeout" : null;
    await store.completeJobRun({
      tenantId: tenant.tenantId, runId, status, durationMs: 1532,
      inputTokens: 23, outputTokens: 47, errorMessage, summary: "run summary"
    });
    const completed = await superuserPool().query("SELECT * FROM scheduled_job_runs WHERE run_id = $1", [runId]);
    expect(completed.rows[0]).toMatchObject({
      status, duration_ms: 1532, input_tokens: 23, output_tokens: 47,
      error_message: errorMessage, summary: "run summary"
    });
    expect(completed.rows[0].completed_at).toBeInstanceOf(Date);
  });

  test("tenant settings advance the persisted version on partial and concurrent updates", async () => {
    const { tenantId } = await seedTenantGraph();
    const store = new TenantSettingsStore(appPool());
    const initial = await store.upsert(tenantId, { developerInstructions: "initial" });
    const updated = await store.upsert(tenantId, { developerInstructions: "updated" });
    expect(updated.version).toBe(initial.version + 1);

    await Promise.all([
      store.upsert(tenantId, { developerInstructions: "writer A" }),
      store.upsert(tenantId, { showEffortSelector: true })
    ]);
    const persisted = await superuserPool().query("SELECT * FROM tenant_settings WHERE tenant_id = $1", [tenantId]);
    expect(persisted.rows[0]).toMatchObject({
      version: String(initial.version + 3), developer_instructions: "writer A", show_effort_selector: true
    });
  });
});
