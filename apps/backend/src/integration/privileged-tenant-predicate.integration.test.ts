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

import { beforeAll, describe, expect, test } from "vitest";

import { withTenantScope } from "../lib/db.js";

import { ApprovalStore } from "../services/auth/approval-store.js";
import { ArtifactStore } from "../services/artifacts/artifact-store.js";
import { MessageStore } from "../services/message-store.js";
import { PiiScanJobStore } from "../services/pii/pii-scan-job-store.js";
import { TenantMemberStore } from "../services/tenant-member-store.js";
import { TenantOrgSettingsStore } from "../services/tenant-org-settings-store.js";
import { UserSettingsStore } from "../services/user-settings-store.js";

import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
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

  // ── Shape 1a: stores that call withTenantScope but run on the privileged
  // pool, where the wrapper is inert and the predicate is everything. ────────

  describe("TenantMemberStore.getRole (the auth middleware's admission check)", () => {
    // app.ts constructs this against privilegedDb: the lookup runs BEFORE any
    // tenant context exists, because "is this user a member of this tenant" is
    // itself a tenant-spanning question. If the tenant_id predicate were
    // dropped, a membership in tenant A would admit the user to tenant B.
    test("returns the role for the tenant the user belongs to", async () => {
      const store = new TenantMemberStore(superuserPool());
      expect(await store.getRole(tenantA.tenantId, tenantA.userId)).toBe("owner");
    });

    test("returns null for a tenant the user does not belong to", async () => {
      const store = new TenantMemberStore(superuserPool());
      expect(await store.getRole(tenantB.tenantId, tenantA.userId)).toBeNull();
    });

    test("returns null for a user with no membership anywhere", async () => {
      const store = new TenantMemberStore(superuserPool());
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
      const writer = new TenantOrgSettingsStore(superuserPool(), ENCRYPTION_SECRET);
      await writer.setApiKey(tenantA.tenantId, "anthropic", "sk-tenant-a-secret");
      await writer.setApiKey(tenantB.tenantId, "anthropic", "sk-tenant-b-secret");
    });

    test("getDecryptedApiKey returns each tenant's own key", async () => {
      const store = new TenantOrgSettingsStore(superuserPool(), ENCRYPTION_SECRET);
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
      const store = new TenantOrgSettingsStore(superuserPool(), ENCRYPTION_SECRET);

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
      const store = new TenantOrgSettingsStore(superuserPool(), ENCRYPTION_SECRET);
      const fresh = await seedTenantGraph();
      const record = await store.get(fresh.tenantId);
      expect(record.tenantId).toBe(fresh.tenantId);
      expect(await store.getDecryptedApiKey(fresh.tenantId, "anthropic")).toBeNull();
    });
  });

  // ── Shape 1b: privileged methods carrying tenant_id = $n. ─────────────────

  describe("UserSettingsStore scheduled-job methods", () => {
    function store(): UserSettingsStore {
      // Both pools privileged: these methods are called from the scheduler
      // worker, which has no request scope.
      return new UserSettingsStore(superuserPool(), superuserPool());
    }

    test("claimJob claims a job for its own tenant", async () => {
      const jobId = await seedScheduledJob({
        tenantId: tenantA.tenantId,
        userId: tenantA.userId
      });
      const claimed = await store().claimJob(tenantA.tenantId, jobId, null);
      expect(claimed?.jobId).toBe(jobId);
    });

    test("claimJob refuses another tenant's job", async () => {
      const jobId = await seedScheduledJob({
        tenantId: tenantA.tenantId,
        userId: tenantA.userId
      });
      expect(await store().claimJob(tenantB.tenantId, jobId, null)).toBeNull();

      // And the job is still claimable by its owner, so the refusal did not
      // half-apply.
      expect((await store().claimJob(tenantA.tenantId, jobId, null))?.jobId).toBe(jobId);
    });

    test("recordJobRunOutcome does not touch another tenant's failure counter", async () => {
      // Seeded NONZERO on purpose. Against a default of 0, "the counter did not
      // change" would be true whether or not the predicate worked.
      const jobId = await seedScheduledJob({
        tenantId: tenantA.tenantId,
        userId: tenantA.userId,
        consecutiveFailures: 3
      });

      await store().recordJobRunOutcome(tenantB.tenantId, jobId, true);

      const { rows } = await superuserPool().query<{ consecutive_failures: number }>(
        `SELECT consecutive_failures FROM scheduled_jobs WHERE job_id = $1`,
        [jobId]
      );
      expect(rows[0]?.consecutive_failures).toBe(3);

      // Positive control: the owning tenant CAN reset it.
      await store().recordJobRunOutcome(tenantA.tenantId, jobId, true);
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

      await store().disableJob(tenantB.tenantId, jobId);
      const { rows } = await superuserPool().query<{ enabled: boolean }>(
        `SELECT enabled FROM scheduled_jobs WHERE job_id = $1`,
        [jobId]
      );
      expect(rows[0]?.enabled).toBe(true);

      await store().disableJob(tenantA.tenantId, jobId);
      const { rows: after } = await superuserPool().query<{ enabled: boolean }>(
        `SELECT enabled FROM scheduled_jobs WHERE job_id = $1`,
        [jobId]
      );
      expect(after[0]?.enabled).toBe(false);
    });
  });

  describe("ArtifactStore download tokens", () => {
    function store(): ArtifactStore {
      return new ArtifactStore(appPool(), superuserPool());
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
      // The route is public, so the auth hook no longer checks membership. The
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

  // ── Shape 2: sweeps and claims with no tenant predicate. ──────────────────

  describe("cross-tenant sweeps need the privileged pool", () => {
    test("listDueJobs sees both tenants on the privileged pool and neither on the RLS pool", async () => {
      const privileged = new UserSettingsStore(superuserPool(), superuserPool());
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
      const privileged = new UserSettingsStore(superuserPool(), superuserPool());
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
      const privileged = new PiiScanJobStore(superuserPool(), superuserPool());
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
      const privileged = new PiiScanJobStore(superuserPool(), superuserPool());

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

      const swept = await new MessageStore(superuserPool()).sweepStaleStreaming(1000, 500);
      const ids = swept.map((row) => row.messageId);
      expect(ids).toContain(msgA);
      expect(ids).toContain(msgB);
      const recovered = await new MessageStore(appPool()).listBySession(tenantA.tenantId, tenantA.sessionId, tenantA.userId);
      expect(recovered.messages.find((message) => message.messageId === msgA)?.toolResults).toMatchObject([{ status: "failed" }]);
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

      const swept = await new ApprovalStore(superuserPool()).sweepExpired(500);
      const ids = swept.map((row) => row.approvalId);
      expect(ids).toContain(apprA);
      expect(ids).toContain(apprB);
    });
  });
});

// ── Relationship integrity across tenants. ─────────────────────────────────
//
// Separate from the two shapes above because neither RLS nor a tenant predicate
// checks that a child row's parent belongs to the same tenant. Composite foreign
// keys provide that database-level guarantee even if a route or store trusts a
// caller-supplied session id.
describe.skipIf(!adminDatabaseUrl())("cross-tenant parent references", () => {
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;

  beforeAll(async () => {
    tenantA = await seedTenantGraph();
    tenantB = await seedTenantGraph();
  });

  test("rejects an artifact that names another tenant's session", async () => {
    const store = new ArtifactStore(appPool(), superuserPool());

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
