// Every place where a SQL predicate, not RLS, is the tenant boundary.
//
// The privileged pool bypasses RLS by design: the scheduler, the PII worker,
// the WorkOS auth hook and download-token resolution all have to read across
// tenants. On that pool `withTenantScope` still sets the GUC, but no policy
// reads it — so an in-SQL `tenant_id = $1` is the ONLY thing left. Drop that
// predicate and there is no second line of defence and no error; the query
// just starts returning other tenants' rows.
//
// Two shapes here, and the distinction matters:
//
//  1. Methods that carry `tenant_id = $n`. A cross-tenant call must return
//     nothing, and a same-tenant call must return something. Both halves are
//     asserted: without the positive control, a broken fixture makes every
//     "returns null" pass for the wrong reason.
//
//  2. Methods with no tenant predicate, which are cross-tenant on purpose
//     (the sweeps and claims). For those the invariant is the opposite one:
//     given the privileged pool they must see BOTH tenants. Given the RLS pool
//     they see nothing, which is the silent-empty-queue failure the boot
//     assertion in app.ts exists to prevent.

import { randomUUID } from "node:crypto";

import { DEFAULT_PII_PROTECTION, type PiiProtectionSettings } from "@cogniplane/shared-types";
import { beforeAll, describe, expect, test } from "vitest";

import { withTenantScope } from "../lib/db.js";

import { ApprovalStore } from "../services/auth/approval-store.js";
import {
  ArtifactStore,
  artifactPiiEligibleSql,
  isArtifactPiiEligible,
  type ArtifactPiiDetail
} from "../services/artifacts/artifact-store.js";
import { AuditEventStore } from "../services/audit-event-store.js";
import { MessageStore } from "../services/message-store.js";
import { PiiScanJobStore } from "../services/pii/pii-scan-job-store.js";
import { PrivilegedAuthStateLookup, TenantMemberStore } from "../services/tenant-member-store.js";
import {
  PiiSettingsConflictError,
  TenantOrgSettingsStore,
  type PiiProtectionSaveResult
} from "../services/tenant-org-settings-store.js";
import { UserSettingsStore } from "../services/user-settings-store.js";

import { adminDatabaseUrl, appPool, maintenancePool, superuserPool } from "./support/database.js";
import {
  seedApproval,
  seedDownloadToken,
  seedPiiScanJob,
  seedPiiScanRun,
  seedScheduledJob,
  seedScheduledJobRun,
  seedStreamingMessage,
  seedTenantGraph,
  seedUser,
  type TenantFixture
} from "./support/fixtures.js";
import { PII_SAVE_ALLOWED } from "../test-helpers/data-routes.js";

// Any 32-byte-derivable string works; the tests only need encrypt/decrypt to
// round-trip through the same instance.
const ENCRYPTION_SECRET = "integration-encryption-secret-value";

describe.skipIf(!adminDatabaseUrl())("privileged pool tenant predicates", () => {
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;

  beforeAll(async () => {
    tenantA = await seedTenantGraph();
    tenantB = await seedTenantGraph();
  });

  // Shape 1a: stores that call withTenantScope on the privileged pool. There
  // the wrapper is inert, and the predicate is the only tenant boundary.

  describe("TenantMemberStore.getRole on the privileged pool", () => {
    // If the tenant_id predicate were dropped, a membership in tenant A would
    // give the user a role in tenant B.
    test("returns the role for the tenant the user belongs to", async () => {
      const store = new TenantMemberStore(maintenancePool());
      expect(await store.getRole(tenantA.tenantId, tenantA.userId)).toBe("owner");
    });

    test("returns null for a tenant the user does not belong to", async () => {
      const store = new TenantMemberStore(maintenancePool());
      expect(await store.getRole(tenantB.tenantId, tenantA.userId)).toBeNull();
    });

    test("returns null for a user with no membership anywhere", async () => {
      const store = new TenantMemberStore(maintenancePool());
      const stranger = await seedUser();
      expect(await store.getRole(tenantA.tenantId, stranger)).toBeNull();
    });
  });

  describe("TenantOrgSettingsStore on the privileged pool", () => {
    // Bootstrap reads (the provider key for /models, the PII policy for the
    // scan worker) run outside any request scope, so this store is also
    // constructed against privilegedDb. A dropped predicate here leaks another
    // tenant's provider API key.
    beforeAll(async () => {
      const writer = new TenantOrgSettingsStore(appPool(), ENCRYPTION_SECRET);
      await writer.setApiKey(tenantA.tenantId, "anthropic", "sk-tenant-a-secret");
      await writer.setApiKey(tenantB.tenantId, "anthropic", "sk-tenant-b-secret");
    });

    test("getDecryptedApiKey returns each tenant's own key", async () => {
      const store = new TenantOrgSettingsStore(maintenancePool(), ENCRYPTION_SECRET);
      expect(await store.getDecryptedApiKey(tenantA.tenantId, "anthropic")).toBe(
        "sk-tenant-a-secret"
      );
      expect(await store.getDecryptedApiKey(tenantB.tenantId, "anthropic")).toBe(
        "sk-tenant-b-secret"
      );
    });

    test("get() returns the addressed tenant's row, not the first row in the table", async () => {
      // Asserting on the KEY MATERIAL, not just the echoed tenantId: a dropped
      // `WHERE tenant_id = $1` would return whichever row Postgres reaches
      // first, and `mapRow` would report that row's tenant. Reading tenant B
      // (seeded second) makes "first row wins" visibly wrong.
      const store = new TenantOrgSettingsStore(maintenancePool(), ENCRYPTION_SECRET);

      const recordB = await store.get(tenantB.tenantId);
      expect(recordB.tenantId).toBe(tenantB.tenantId);
      expect(await store.getDecryptedApiKey(tenantB.tenantId, "anthropic")).toBe(
        "sk-tenant-b-secret"
      );

      const recordA = await store.get(tenantA.tenantId);
      expect(recordA.tenantId).toBe(tenantA.tenantId);
      expect(await store.getDecryptedApiKey(tenantA.tenantId, "anthropic")).toBe(
        "sk-tenant-a-secret"
      );
    });

    test("a tenant with no settings row gets an empty record, not a peer's", async () => {
      // The failure this guards is a predicate drop turning "no row for me"
      // into "the first row in the table", which would hand a fresh tenant
      // somebody else's key.
      const store = new TenantOrgSettingsStore(maintenancePool(), ENCRYPTION_SECRET);
      const fresh = await seedTenantGraph();
      const record = await store.get(fresh.tenantId);
      expect(record.tenantId).toBe(fresh.tenantId);
      expect(await store.getDecryptedApiKey(fresh.tenantId, "anthropic")).toBeNull();
    });

    test("a PII save keeps raw stored scope keys that it does not name, in one tenant only", async () => {
      // The save locks and reads the row under RLS on the app pool, then
      // writes it with the audit event in the same transaction.
      const writer = new TenantOrgSettingsStore(appPool(), ENCRYPTION_SECRET);
      const first = { ...DEFAULT_PII_PROTECTION, scopes: { chatPrompts: true, uploads: true, retiredImports: false, junk: "x" } };
      await writer.setPiiProtection(tenantA.tenantId, first as never, PII_SAVE_ALLOWED);
      await writer.setPiiProtection(tenantB.tenantId, DEFAULT_PII_PROTECTION, PII_SAVE_ALLOWED);
      const next = { ...DEFAULT_PII_PROTECTION, scopes: { chatPrompts: false, uploads: true } };
      await writer.setPiiProtection(tenantA.tenantId, next, { ...PII_SAVE_ALLOWED, audit: (stored) => ({
        tenantId: tenantA.tenantId,
        sessionId: null,
        userId: tenantA.userId,
        type: "tenant.pii_protection.updated",
        payload: { piiProtection: stored }
      }) });

      const store = new TenantOrgSettingsStore(maintenancePool(), ENCRYPTION_SECRET);
      const expectedScopes = { chatPrompts: false, uploads: true, retiredImports: false, junk: "x" };
      expect((await store.get(tenantA.tenantId)).storedPiiProtection).toEqual({ ...next, scopes: expectedScopes });
      expect((await store.get(tenantB.tenantId)).storedPiiProtection).toEqual(DEFAULT_PII_PROTECTION);
      const audit = await superuserPool().query(
        "SELECT payload FROM audit_events WHERE tenant_id = $1 AND event_type = 'tenant.pii_protection.updated'",
        [tenantA.tenantId]
      );
      expect(audit.rows.map((row) => row.payload.piiProtection.scopes)).toEqual([expectedScopes]);
    });
  });

  describe("AuditEventStore.createSystemEvent", () => {
    test("writes an event with no user through the tenant-scoped pool", async () => {
      // The PII scan worker records a configuration-error stop for a job
      // with no source user. RLS and the nullable user_id must accept it.
      await new AuditEventStore(appPool()).createSystemEvent({
        tenantId: tenantA.tenantId,
        sessionId: null,
        type: "pii_policy_invalid",
        payload: { jobId: "job-system-event" }
      });
      const rows = await superuserPool().query(
        "SELECT tenant_id, user_id FROM audit_events WHERE event_type = 'pii_policy_invalid' AND payload->>'jobId' = 'job-system-event'"
      );
      expect(rows.rows).toEqual([{ tenant_id: tenantA.tenantId, user_id: null }]);
    });
  });

  describe("TenantOrgSettingsStore.setPiiProtection concurrency", () => {
    test("a first save that waits for another first save keeps the scope keys it does not name", async () => {
      // Save A is an open transaction that has inserted the first settings
      // row and has not committed. Save B starts while that row is not yet
      // visible. B must wait for A and then merge A's scopes; it must not
      // replace A's row with its own policy.
      const fresh = await seedTenantGraph();
      const saveA = await superuserPool().connect();
      let saveB: Promise<unknown> | undefined;
      let committed = false;
      try {
        await saveA.query("BEGIN");
        const pidA = (await saveA.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        const scopesA = { chatPrompts: true, uploads: true, retiredImports: false };
        await saveA.query(
          "INSERT INTO tenant_org_settings (tenant_id, pii_protection) VALUES ($1, $2::jsonb)",
          [fresh.tenantId, JSON.stringify({ ...DEFAULT_PII_PROTECTION, scopes: scopesA })]
        );

        const writer = new TenantOrgSettingsStore(appPool(), ENCRYPTION_SECRET);
        saveB = writer.setPiiProtection(fresh.tenantId, {
          ...DEFAULT_PII_PROTECTION,
          scopes: { chatPrompts: false, uploads: true }
        }, PII_SAVE_ALLOWED);
        // Observe a rejection now, so it is not reported as unhandled while
        // the test still waits.
        saveB.catch(() => undefined);

        // Commit A only when a session is blocked by A itself. Then the order
        // is fixed, and no other waiter in the cluster can release A early.
        for (let attempt = 0; ; attempt += 1) {
          const blocked = await superuserPool().query(
            "SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
            [pidA]
          );
          if (blocked.rowCount) break;
          if (attempt > 200) throw new Error("save B never waited for save A");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        await saveA.query("COMMIT");
        committed = true;
        await saveB;
      } finally {
        // On a failure, roll back A so that B can finish and release its
        // connection before the pools close.
        if (!committed) await saveA.query("ROLLBACK").catch(() => undefined);
        saveA.release();
        await saveB?.catch(() => undefined);
      }

      const store = new TenantOrgSettingsStore(maintenancePool(), ENCRYPTION_SECRET);
      const stored = (await store.get(fresh.tenantId)).storedPiiProtection as { scopes?: unknown } | null;
      expect(stored?.scopes).toEqual({
        chatPrompts: false,
        uploads: true,
        retiredImports: false
      });
    });

    function piiAudit(tenant: TenantFixture) {
      return (stored: PiiProtectionSettings) => ({
        tenantId: tenant.tenantId,
        sessionId: null,
        userId: tenant.userId,
        type: "tenant.pii_protection.updated" as const,
        payload: { piiProtection: stored }
      });
    }

    async function piiAuditModes(tenantId: string): Promise<string[]> {
      const audit = await superuserPool().query(
        "SELECT payload FROM audit_events WHERE tenant_id = $1 AND event_type = 'tenant.pii_protection.updated'",
        [tenantId]
      );
      return audit.rows.map((row) => String(row.payload.piiProtection.mode)).sort();
    }

    test("a save with the stored revision adds 1; a save with another revision writes nothing", async () => {
      const fresh = await seedTenantGraph();
      const writer = new TenantOrgSettingsStore(appPool(), ENCRYPTION_SECRET);
      const reader = new TenantOrgSettingsStore(maintenancePool(), ENCRYPTION_SECRET);
      const audit = piiAudit(fresh);
      const detect = { ...DEFAULT_PII_PROTECTION, enabled: true, mode: "detect" as const };

      // A tenant with no row has revision 0. A refused first save rolls back
      // the row that it inserted.
      await expect(writer.setPiiProtection(fresh.tenantId, detect, { ...PII_SAVE_ALLOWED, expectedRevision: 1, audit }))
        .rejects.toBeInstanceOf(PiiSettingsConflictError);
      const rows = await superuserPool().query("SELECT 1 FROM tenant_org_settings WHERE tenant_id = $1", [fresh.tenantId]);
      expect(rows.rowCount).toBe(0);

      expect(await writer.setPiiProtection(fresh.tenantId, detect, { ...PII_SAVE_ALLOWED, expectedRevision: 0, audit }))
        .toEqual({ stored: detect, revision: 1 });
      await expect(writer.setPiiProtection(fresh.tenantId, DEFAULT_PII_PROTECTION, { ...PII_SAVE_ALLOWED, expectedRevision: 0, audit }))
        .rejects.toBeInstanceOf(PiiSettingsConflictError);
      expect(await reader.get(fresh.tenantId)).toMatchObject({ storedPiiProtection: detect, piiProtectionRevision: 1 });

      // Compatibility path: a save with no revision is not checked.
      expect((await writer.setPiiProtection(fresh.tenantId, DEFAULT_PII_PROTECTION, { ...PII_SAVE_ALLOWED, audit })).revision).toBe(2);
      expect(await reader.get(fresh.tenantId)).toMatchObject({ storedPiiProtection: DEFAULT_PII_PROTECTION, piiProtectionRevision: 2 });
      expect(await piiAuditModes(fresh.tenantId)).toEqual(["detect", "off"]);
    });

    test("of two saves with the same revision, one is stored and the other gets a conflict", async () => {
      // A third transaction holds the row lock, and both saves wait for it.
      // When it commits, one save takes the row lock first. The other save
      // reads the row after the first save commits. It sees the new revision
      // and writes nothing.
      const fresh = await seedTenantGraph();
      const writer = new TenantOrgSettingsStore(appPool(), ENCRYPTION_SECRET);
      const { revision } = await writer.setPiiProtection(fresh.tenantId, DEFAULT_PII_PROTECTION, PII_SAVE_ALLOWED);
      const policies = [
        { ...DEFAULT_PII_PROTECTION, enabled: true, mode: "detect" as const },
        { ...DEFAULT_PII_PROTECTION, enabled: true, mode: "block" as const }
      ];
      const holder = await superuserPool().connect();
      let saves: Array<Promise<PiiProtectionSaveResult>> = [];
      let committed = false;
      let results: Array<PromiseSettledResult<PiiProtectionSaveResult>>;
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM tenant_org_settings WHERE tenant_id = $1 FOR UPDATE", [fresh.tenantId]);

        saves = policies.map((policy) =>
          writer.setPiiProtection(fresh.tenantId, policy, { ...PII_SAVE_ALLOWED, expectedRevision: revision, audit: piiAudit(fresh) }));
        // Observe a rejection now, so it is not reported as unhandled while
        // the test still waits.
        for (const save of saves) save.catch(() => undefined);

        // Commit only when both saves wait for a lock. A second waiter can
        // wait for the first waiter, not for the holder, so count all waiting
        // app sessions in this run's database.
        for (let attempt = 0; ; attempt += 1) {
          const waiting = await superuserPool().query<{ count: number }>(
            `SELECT count(*)::int AS count FROM pg_stat_activity
             WHERE datname = current_database() AND application_name = 'cogniplane-integration-app-user'
               AND cardinality(pg_blocking_pids(pid)) > 0`
          );
          if (waiting.rows[0].count >= 2) break;
          if (attempt > 200) throw new Error("the two saves never waited for the row lock");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        await holder.query("COMMIT");
        committed = true;
        results = await Promise.allSettled(saves);
      } finally {
        // On a failure, roll back so that the saves can finish and release
        // their connections before the pools close.
        if (!committed) await holder.query("ROLLBACK").catch(() => undefined);
        holder.release();
        await Promise.allSettled(saves);
      }

      const stored = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
      const refused = results.filter((result) => result.status === "rejected").map((result) => result.reason);
      expect(stored).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect(refused[0]).toBeInstanceOf(PiiSettingsConflictError);
      expect(stored[0].revision).toBe(revision + 1);

      const reader = new TenantOrgSettingsStore(maintenancePool(), ENCRYPTION_SECRET);
      expect(await reader.get(fresh.tenantId)).toMatchObject({
        storedPiiProtection: stored[0].stored,
        piiProtectionRevision: revision + 1
      });
      // Only the stored save has an audit event.
      expect(await piiAuditModes(fresh.tenantId)).toEqual([stored[0].stored.mode]);
    });
  });

  // Shape 1b: privileged methods that carry tenant_id = $n.

  describe("PrivilegedAuthStateLookup (the admission read of the auth middleware and /auth/refresh)", () => {
    // app.ts and routes/auth-session.ts construct this against privilegedDb:
    // the read runs BEFORE any tenant context exists, because "is this user a
    // member of this tenant" is itself a tenant-spanning question. It has no
    // withTenantScope. If the tenant_id predicate were dropped, a membership
    // in tenant A would admit the user to tenant B.
    function lookup(): PrivilegedAuthStateLookup {
      return new PrivilegedAuthStateLookup(maintenancePool());
    }

    test("returns the state for the tenant the user belongs to", async () => {
      expect(await lookup().getAuthState(tenantA.tenantId, tenantA.userId)).toEqual({
        role: "owner", loginType: "workos", authSource: "workos", localStatus: null, securityVersion: null
      });
    });

    test("returns null for a tenant the user does not belong to", async () => {
      expect(await lookup().getAuthState(tenantB.tenantId, tenantA.userId)).toBeNull();
    });

    test("returns null for a user with no membership anywhere", async () => {
      expect(await lookup().getAuthState(tenantA.tenantId, await seedUser())).toBeNull();
    });
  });

  describe("UserSettingsStore scheduled-job methods", () => {
    function store(): UserSettingsStore {
      // Claims use the job's tenant scope; cross-tenant scheduler methods
      // still use the maintenance pool.
      return new UserSettingsStore(appPool(), maintenancePool());
    }

    test("claimJob claims a job for its own tenant", async () => {
      const jobId = await seedScheduledJob({
        tenantId: tenantA.tenantId,
        userId: tenantA.userId
      });
      const claimed = await store().claimJob(tenantA.tenantId, jobId, randomUUID());
      expect(claimed).toMatchObject({ status: "claimed", job: { jobId } });
    });

    test("claimJob refuses another tenant's job", async () => {
      const jobId = await seedScheduledJob({
        tenantId: tenantA.tenantId,
        userId: tenantA.userId
      });
      expect(await store().claimJob(tenantB.tenantId, jobId, randomUUID())).toEqual({ status: "not_claimed" });

      // And the job is still claimable by its owner, so the refusal did not
      // half-apply.
      expect(await store().claimJob(tenantA.tenantId, jobId, randomUUID())).toMatchObject({ status: "claimed", job: { jobId } });
    });

    test("finishJobRun does not touch another tenant's run or failure counter", async () => {
      // Seeded NONZERO on purpose. Against a default of 0, "the counter did not
      // change" would be true whether or not the predicate worked.
      const jobId = await seedScheduledJob({
        tenantId: tenantA.tenantId,
        userId: tenantA.userId,
        consecutiveFailures: 3
      });
      const runId = await seedScheduledJobRun({ tenantId: tenantA.tenantId, userId: tenantA.userId, jobId, ageMs: 0 });
      const finish = (tenantId: string) => store().finishJobRun({
        tenantId, jobId, runId, revision: 0, status: "completed", durationMs: 1, inputTokens: 0,
        outputTokens: 0, errorMessage: null, summary: null, counts: true, disableAtFailures: 0
      });

      expect(await finish(tenantB.tenantId)).toEqual({ status: "missing" });

      const { rows } = await superuserPool().query<{ consecutive_failures: number }>(
        `SELECT consecutive_failures FROM scheduled_jobs WHERE job_id = $1`,
        [jobId]
      );
      expect(rows[0]?.consecutive_failures).toBe(3);

      // Positive control: the owning tenant CAN reset it.
      expect(await finish(tenantA.tenantId)).toMatchObject({ status: "finished", consecutiveFailures: 0 });
      const { rows: after } = await superuserPool().query<{ consecutive_failures: number }>(
        `SELECT consecutive_failures FROM scheduled_jobs WHERE job_id = $1`,
        [jobId]
      );
      expect(after[0]?.consecutive_failures).toBe(0);
    });

    test("disableJob does not disable another tenant's job", async () => {
      const jobId = await seedScheduledJob({
        tenantId: tenantA.tenantId,
        userId: tenantA.userId
      });

      expect(await store().disableJob(tenantB.tenantId, jobId, 0)).toBe(false);
      const { rows } = await superuserPool().query<{ enabled: boolean }>(
        `SELECT enabled FROM scheduled_jobs WHERE job_id = $1`,
        [jobId]
      );
      expect(rows[0]?.enabled).toBe(true);

      expect(await store().disableJob(tenantA.tenantId, jobId, 0)).toBe(true);
      const { rows: after } = await superuserPool().query<{ enabled: boolean }>(
        `SELECT enabled FROM scheduled_jobs WHERE job_id = $1`,
        [jobId]
      );
      expect(after[0]?.enabled).toBe(false);
    });

    test("parkJob does not park another tenant's job", async () => {
      const jobId = await seedScheduledJob({
        tenantId: tenantA.tenantId,
        userId: tenantA.userId
      });
      const nextRunAt = async () => (await superuserPool().query<{ next_run_at: Date | null }>(
        `SELECT next_run_at FROM scheduled_jobs WHERE job_id = $1`,
        [jobId]
      )).rows[0]?.next_run_at;

      expect(await store().parkJob(tenantB.tenantId, jobId, 0)).toBe(false);
      expect(await nextRunAt()).toBeInstanceOf(Date);

      expect(await store().parkJob(tenantA.tenantId, jobId, 0)).toBe(true);
      expect(await nextRunAt()).toBeNull();
    });
  });

  describe("ArtifactStore download tokens", () => {
    function store(): ArtifactStore {
      return new ArtifactStore(appPool(), maintenancePool());
    }

    test("peek resolves a token from the token row alone", async () => {
      const token = await seedDownloadToken({
        tenantId: tenantA.tenantId,
        userId: tenantA.userId,
        sessionId: tenantA.sessionId,
        artifactId: tenantA.artifactId
      });

      const record = await store().peekDownloadToken({ token });
      expect(record).toMatchObject({ tenantId: tenantA.tenantId, userId: tenantA.userId, artifactId: tenantA.artifactId });
    });

    test("peek refuses a personal-session token whose user does not own the session", async () => {
      // Identity comes from the token row, so the session clause is what keeps
      // a token minted for a peer from reading another user's session.
      const peer = await seedUser();
      const token = await seedDownloadToken({
        tenantId: tenantA.tenantId,
        userId: peer,
        sessionId: tenantA.sessionId,
        artifactId: tenantA.artifactId
      });

      expect(await store().peekDownloadToken({ token })).toBeNull();
    });

    test("peek and consume refuse a token whose user left the tenant", async () => {
      // The route is public, so the auth hook does not check membership. The
      // gate must, or a removed member keeps access until the token expires.
      const graph = await seedTenantGraph();
      const token = await seedDownloadToken({
        tenantId: graph.tenantId,
        userId: graph.userId,
        sessionId: graph.sessionId,
        artifactId: graph.artifactId
      });
      await superuserPool().query(
        "DELETE FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2",
        [graph.tenantId, graph.userId]
      );

      expect(await store().peekDownloadToken({ token })).toBeNull();
      expect(await store().consumeDownloadToken({ token })).toBeNull();
    });

    test("peek and consume refuse a token for an upload still waiting for its PII scan", async () => {
      const graph = await seedTenantGraph();
      const token = await seedDownloadToken({
        tenantId: graph.tenantId,
        userId: graph.userId,
        sessionId: graph.sessionId,
        artifactId: graph.artifactId
      });
      await superuserPool().query(
        "UPDATE artifacts SET status = 'pending' WHERE tenant_id = $1 AND artifact_id = $2",
        [graph.tenantId, graph.artifactId]
      );

      expect(await store().peekDownloadToken({ token })).toBeNull();
      expect(await store().consumeDownloadToken({ token })).toBeNull();
    });

    // A block can land on a record that is already ready and carries no pending
    // marker, so setPiiDetail leaves status alone. The verdict has to deny on its
    // own, and a token minted before the block has to stop working.
    async function readyArtifactWithToken() {
      const graph = await seedTenantGraph();
      const token = await seedDownloadToken({
        tenantId: graph.tenantId,
        userId: graph.userId,
        sessionId: graph.sessionId,
        artifactId: graph.artifactId
      });
      return { graph, token };
    }

    async function consumedAt(token: string): Promise<string | null> {
      const { rows } = await superuserPool().query<{ consumed_at: string | null }>(
        `SELECT consumed_at FROM artifact_download_tokens WHERE token = $1`,
        [token]
      );
      return rows[0]?.consumed_at ?? null;
    }

    test("peek and consume refuse a token minted before a later PII block, while status stays ready", async () => {
      const { graph, token } = await readyArtifactWithToken();
      // Positive control: the token resolves while the artifact is eligible.
      expect(await store().peekDownloadToken({ token })).toMatchObject({ artifactId: graph.artifactId });

      await store().setPiiDetail(graph.tenantId, graph.artifactId, { status: "blocked", blockReason: "pii_detected" });

      const { rows } = await superuserPool().query<{ status: string }>(
        "SELECT status FROM artifacts WHERE tenant_id = $1 AND artifact_id = $2",
        [graph.tenantId, graph.artifactId]
      );
      // Precondition: this is the inconsistent record the verdict must deny.
      expect(rows[0]?.status).toBe("ready");
      expect(await store().peekDownloadToken({ token })).toBeNull();
      expect(await store().consumeDownloadToken({ token })).toBeNull();
      expect(await consumedAt(token)).toBeNull();
    });

    test.each(["pending", "scanning"] as const)(
      "peek and consume refuse a ready artifact whose PII verdict is %s",
      async (status) => {
        const { graph, token } = await readyArtifactWithToken();
        await store().setPiiDetail(graph.tenantId, graph.artifactId, { status });

        expect(await store().peekDownloadToken({ token })).toBeNull();
        expect(await store().consumeDownloadToken({ token })).toBeNull();
      }
    );

    test("a detect-only verdict with findings stays downloadable, once", async () => {
      const { graph, token } = await readyArtifactWithToken();
      await store().setPiiDetail(graph.tenantId, graph.artifactId, {
        status: "scanned",
        modeApplied: "detect",
        findingsCount: 3
      });

      expect(await store().peekDownloadToken({ token })).toMatchObject({ artifactId: graph.artifactId });
      expect((await store().consumeDownloadToken({ token }))?.artifactId).toBe(graph.artifactId);
      expect(await store().consumeDownloadToken({ token })).toBeNull();
    });

    test("the SQL eligibility predicate agrees with the TS predicate for every status and verdict", async () => {
      // The one drift guard that needs a real database: both predicates are
      // built side by side, and this proves they answer alike.
      const graph = await seedTenantGraph();
      const statuses = ["pending", "processing", "ready", "failed", "deleted"] as const;
      // Also a verdict this code does not know, and a JSON null.
      const verdicts: Array<ArtifactPiiDetail["status"] | "quarantined" | null | undefined> = [
        undefined,
        null,
        "pending",
        "scanning",
        "scanned",
        "blocked",
        "transformed",
        "failed",
        "quarantined"
      ];

      for (const status of statuses) {
        for (const verdict of verdicts) {
          const detail = verdict === undefined ? {} : { pii: { status: verdict as ArtifactPiiDetail["status"] } };
          await superuserPool().query(
            "UPDATE artifacts SET status = $3, detail_json = $4::jsonb WHERE tenant_id = $1 AND artifact_id = $2",
            [graph.tenantId, graph.artifactId, status, JSON.stringify(detail)]
          );
          const { rows } = await superuserPool().query<{ eligible: boolean }>(
            `SELECT ${artifactPiiEligibleSql("a")} AS eligible
               FROM artifacts a WHERE a.tenant_id = $1 AND a.artifact_id = $2`,
            [graph.tenantId, graph.artifactId]
          );
          expect(rows[0]?.eligible, `${status} / ${String(verdict)}`).toBe(
            isArtifactPiiEligible({ status, detail })
          );
        }
      }
    });

    test("a refused consume leaves the token unburnt, and the first good consume wins", async () => {
      const peer = await seedUser();
      const refused = await seedDownloadToken({
        tenantId: tenantA.tenantId,
        userId: peer,
        sessionId: tenantA.sessionId,
        artifactId: tenantA.artifactId
      });
      expect(await store().consumeDownloadToken({ token: refused })).toBeNull();
      const { rows } = await superuserPool().query<{ consumed_at: string | null }>(
        `SELECT consumed_at FROM artifact_download_tokens WHERE token = $1`,
        [refused]
      );
      expect(rows[0]?.consumed_at).toBeNull();

      const token = await seedDownloadToken({
        tenantId: tenantA.tenantId,
        userId: tenantA.userId,
        sessionId: tenantA.sessionId,
        artifactId: tenantA.artifactId
      });
      expect((await store().consumeDownloadToken({ token }))?.artifactId).toBe(tenantA.artifactId);
      expect(await store().consumeDownloadToken({ token })).toBeNull();
    });
  });

  // Shape 2: sweeps and claims with no tenant predicate.

  // read_text_artifact falls back to derived text for non-text files. That
  // derived row needs the same PII eligibility as a download.
  describe("ArtifactStore.findLatestReadableDerived", () => {
    function store(): ArtifactStore {
      return new ArtifactStore(appPool(), maintenancePool());
    }

    test("returns ready derived text, and nothing once its PII verdict blocks it", async () => {
      const graph = await seedTenantGraph();
      const derivedId = crypto.randomUUID();
      await superuserPool().query(
        `
          INSERT INTO artifacts
            (artifact_id, tenant_id, session_id, user_id, artifact_type, source_artifact_id,
             artifact_name, mime_type, storage_backend, storage_key, status)
          VALUES ($1, $2, $3, $4, 'derived', $5, 'report.pdf.txt', 'text/plain', 'local', $6, 'ready')
        `,
        [derivedId, graph.tenantId, graph.sessionId, graph.userId, graph.artifactId, `${graph.tenantId}/${derivedId}`]
      );

      // Positive control: the derived row is found while it is eligible.
      expect(await store().findLatestReadableDerived(graph.tenantId, graph.artifactId, graph.userId)).toMatchObject({
        artifactId: derivedId
      });

      await store().setPiiDetail(graph.tenantId, derivedId, { status: "blocked", blockReason: "pii_detected" });
      expect(await store().findLatestReadableDerived(graph.tenantId, graph.artifactId, graph.userId)).toBeNull();
    });
  });

  describe("cross-tenant sweeps need the privileged pool", () => {
    test("listDueJobs sees both tenants on the privileged pool and neither on the RLS pool", async () => {
      const privileged = new UserSettingsStore(appPool(), maintenancePool());
      const rlsBound = new UserSettingsStore(appPool(), appPool());

      const jobA = await seedScheduledJob({
        tenantId: tenantA.tenantId,
        userId: tenantA.userId
      });
      const jobB = await seedScheduledJob({
        tenantId: tenantB.tenantId,
        userId: tenantB.userId
      });

      const due = await privileged.listDueJobs(500);
      const ids = due.map((job) => job.jobId);
      expect(ids).toContain(jobA);
      expect(ids).toContain(jobB);

      // The silent failure this guards: wired to the RLS pool, the queue looks
      // permanently empty and no job ever runs. Nothing errors.
      expect(await rlsBound.listDueJobs(500)).toEqual([]);
    });

    test("sweepStaleJobRuns recovers runs from both tenants", async () => {
      const privileged = new UserSettingsStore(appPool(), maintenancePool());
      const rlsBound = new UserSettingsStore(appPool(), appPool());

      const runA = await seedScheduledJobRun({
        tenantId: tenantA.tenantId,
        userId: tenantA.userId,
        jobId: tenantA.jobId
      });
      const runB = await seedScheduledJobRun({
        tenantId: tenantB.tenantId,
        userId: tenantB.userId,
        jobId: tenantB.jobId
      });

      expect(await rlsBound.sweepStaleJobRuns(1000, 500)).toEqual([]);

      const swept = await privileged.sweepStaleJobRuns(1000, 500);
      const ids = swept.map((run) => run.runId);
      expect(ids).toContain(runA);
      expect(ids).toContain(runB);
    });

    test("PiiScanJobStore.claimDueJobs claims across tenants", async () => {
      const privileged = new PiiScanJobStore(appPool(), maintenancePool());
      const rlsBound = new PiiScanJobStore(appPool(), appPool());

      const runIdA = await seedPiiScanRun({
        tenantId: tenantA.tenantId,
        userId: tenantA.userId,
        sessionId: tenantA.sessionId
      });
      const runIdB = await seedPiiScanRun({
        tenantId: tenantB.tenantId,
        userId: tenantB.userId,
        sessionId: tenantB.sessionId
      });
      const jobA = await seedPiiScanJob({
        tenantId: tenantA.tenantId,
        userId: tenantA.userId,
        sessionId: tenantA.sessionId,
        scanRunId: runIdA
      });
      const jobB = await seedPiiScanJob({
        tenantId: tenantB.tenantId,
        userId: tenantB.userId,
        sessionId: tenantB.sessionId,
        scanRunId: runIdB
      });

      expect(await rlsBound.claimDueJobs(500)).toEqual([]);

      const claimed = await privileged.claimDueJobs(500);
      const ids = claimed.map((job) => job.jobId);
      expect(ids).toContain(jobA);
      expect(ids).toContain(jobB);
    });

    test("PiiScanJobStore.sweepStaleClaims recovers claims across tenants", async () => {
      const privileged = new PiiScanJobStore(appPool(), maintenancePool());

      const runIdA = await seedPiiScanRun({
        tenantId: tenantA.tenantId,
        userId: tenantA.userId,
        sessionId: tenantA.sessionId
      });
      const runIdB = await seedPiiScanRun({
        tenantId: tenantB.tenantId,
        userId: tenantB.userId,
        sessionId: tenantB.sessionId
      });
      const jobA = await seedPiiScanJob({
        tenantId: tenantA.tenantId,
        userId: tenantA.userId,
        sessionId: tenantA.sessionId,
        scanRunId: runIdA,
        staleClaimAgeMs: 60 * 60 * 1000
      });
      const jobB = await seedPiiScanJob({
        tenantId: tenantB.tenantId,
        userId: tenantB.userId,
        sessionId: tenantB.sessionId,
        scanRunId: runIdB,
        staleClaimAgeMs: 60 * 60 * 1000
      });

      // Returns a COUNT, not rows, so the cross-tenant effect is checked on the
      // rows themselves: both tenants' claims must be released.
      const rlsBound = new PiiScanJobStore(appPool(), appPool());
      expect(await rlsBound.sweepStaleClaims(1000)).toBe(0);

      expect(await privileged.sweepStaleClaims(1000)).toBeGreaterThanOrEqual(2);

      const { rows } = await superuserPool().query<{ tenant_id: string; status: string }>(
        `SELECT tenant_id, status FROM pii_scan_jobs WHERE job_id = ANY($1::text[])`,
        [[jobA, jobB]]
      );
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.status === "queued")).toBe(true);
      expect(new Set(rows.map((row) => row.tenant_id))).toEqual(
        new Set([tenantA.tenantId, tenantB.tenantId])
      );
    });

    test("MessageStore.sweepStaleStreaming is empty on the RLS pool, cross-tenant on the privileged one", async () => {
      // This one is the sharpest edge in the codebase: MessageStore puts the
      // sweep on the SAME `this.db` field its tenant-scoped methods use, so the
      // class is safe or a silent no-op purely by which instance the caller
      // holds. build-stores wires the RLS pool; app.ts builds a second
      // privileged instance just for the sweeper.
      const msgA = await seedStreamingMessage(
        tenantA.tenantId,
        tenantA.userId,
        tenantA.sessionId
      );
      const msgB = await seedStreamingMessage(
        tenantB.tenantId,
        tenantB.userId,
        tenantB.sessionId
      );
      await new MessageStore(appPool()).upsertToolResult({
        tenantId: tenantA.tenantId, messageId: msgA, sessionId: tenantA.sessionId, userId: tenantA.userId,
        toolResultId: `tool-${msgA}`, kind: "command", title: "execute", status: "in_progress",
        command: "sleep", cwd: null, server: null, toolName: "execute", input: "{}", output: "",
        exitCode: null, durationMs: null, textOffset: 0
      });

      expect(await new MessageStore(appPool()).sweepStaleStreaming(1000, 500)).toEqual([]);

      const swept = await new MessageStore(maintenancePool()).sweepStaleStreaming(1000, 500);
      const ids = swept.map((row) => row.messageId);
      expect(ids).toContain(msgA);
      expect(ids).toContain(msgB);
      const recovered = await new MessageStore(appPool()).listBySession(tenantA.tenantId, tenantA.sessionId, tenantA.userId);
      expect(recovered.messages.find((message) => message.messageId === msgA)?.toolResults).toMatchObject([{ status: "in_progress" }]);
    });

    test("ApprovalStore.sweepExpired is empty on the RLS pool, cross-tenant on the privileged one", async () => {
      // Same two-instance shape as MessageStore above.
      const apprA = await seedApproval({
        tenantId: tenantA.tenantId,
        userId: tenantA.userId,
        sessionId: tenantA.sessionId,
        runtimeId: tenantA.runtimeId,
        expired: true
      });
      const apprB = await seedApproval({
        tenantId: tenantB.tenantId,
        userId: tenantB.userId,
        sessionId: tenantB.sessionId,
        runtimeId: tenantB.runtimeId,
        expired: true
      });

      expect(await new ApprovalStore(appPool()).sweepExpired(500)).toEqual([]);

      const swept = await new ApprovalStore(maintenancePool()).sweepExpired(500);
      const ids = swept.map((row) => row.approvalId);
      expect(ids).toContain(apprA);
      expect(ids).toContain(apprB);
    });
  });
});

// Relationship integrity across tenants. The shapes above do not cover it.
// Neither RLS nor a tenant predicate checks that a child row's parent belongs
// to the same tenant. Composite foreign keys give that guarantee, even when a
// route or store trusts a caller-supplied session id.
describe.skipIf(!adminDatabaseUrl())("cross-tenant parent references", () => {
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;

  beforeAll(async () => {
    tenantA = await seedTenantGraph();
    tenantB = await seedTenantGraph();
  });

  test("rejects an artifact that names another tenant's session", async () => {
    const store = new ArtifactStore(appPool(), maintenancePool());

    await expect(
      store.create({
        tenantId: tenantA.tenantId,
        artifactType: "upload",
        sessionId: tenantB.sessionId,
        userId: tenantA.userId,
        artifactName: "cross-tenant.txt",
        mimeType: "text/plain",
        storageBackend: "local",
        storageKey: `${tenantA.tenantId}/cross-tenant`,
        fileSizeBytes: 1,
        checksumSha256: "",
        status: "ready",
        createdByType: "user"
      })
    ).rejects.toMatchObject({ code: "23503" });
  });

  test("rejects a scheduled run that names another tenant's session", async () => {
    await expect(
      withTenantScope(appPool(), tenantA.tenantId, (client) =>
        client.query(
          `INSERT INTO scheduled_job_runs
             (run_id, tenant_id, job_id, user_id, session_id, status)
           VALUES ($1, $2, $3, $4, $5, 'pending')`,
          [
            `cross-tenant-run-${tenantA.sessionId}`,
            tenantA.tenantId,
            tenantA.jobId,
            tenantA.userId,
            tenantB.sessionId
          ]
        )
      )
    ).rejects.toMatchObject({ code: "23503" });
  });
});
