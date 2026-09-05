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

    test("peek resolves the owner's own token", async () => {
      const token = await seedDownloadToken({
        tenantId: tenantA.tenantId,
        userId: tenantA.userId,
        sessionId: tenantA.sessionId,
        artifactId: tenantA.artifactId
      });

      const record = await store().peekDownloadToken({
        token,
        requesterTenantId: tenantA.tenantId,
        requesterUserId: tenantA.userId,
        callerIsAdmin: false
      });
      expect(record?.artifactId).toBe(tenantA.artifactId);
    });

    test("peek refuses another tenant, holding the user constant", async () => {
      // The requester is tenant A's OWN user, only the tenant differs. Varying
      // both tenant and user would leave `download.user_id = $3` to reject the
      // call, so the test would pass with the tenant predicate deleted. This
      // isolates the tenant clause.
      const token = await seedDownloadToken({
        tenantId: tenantA.tenantId,
        userId: tenantA.userId,
        sessionId: tenantA.sessionId,
        artifactId: tenantA.artifactId
      });

      expect(
        await store().peekDownloadToken({
          token,
          requesterTenantId: tenantB.tenantId,
          requesterUserId: tenantA.userId,
          callerIsAdmin: false
        })
      ).toBeNull();
    });

    test("peek refuses a peer USER in the same tenant", async () => {
      // The gating clause protects peer users, not only peer tenants — a
      // download token is per-user. This half of the predicate has no RLS
      // backstop at all, since both users are in the same tenant.
      const token = await seedDownloadToken({
        tenantId: tenantA.tenantId,
        userId: tenantA.userId,
        sessionId: tenantA.sessionId,
        artifactId: tenantA.artifactId
      });
      const peer = await seedUser();

      expect(
        await store().peekDownloadToken({
          token,
          requesterTenantId: tenantA.tenantId,
          requesterUserId: peer,
          callerIsAdmin: false
        })
      ).toBeNull();
    });

    test("callerIsAdmin resolves a token minted for another user in the tenant", async () => {
      // Admin-minted tokens carry the artifact OWNER's user_id, not the
      // admin's, so this bypass has to work — and it must stay scoped to the
      // admin's own tenant, which the next assertion checks.
      const token = await seedDownloadToken({
        tenantId: tenantA.tenantId,
        userId: tenantA.userId,
        sessionId: tenantA.sessionId,
        artifactId: tenantA.artifactId
      });
      const admin = await seedUser();

      const record = await store().peekDownloadToken({
        token,
        requesterTenantId: tenantA.tenantId,
        requesterUserId: admin,
        callerIsAdmin: true
      });
      expect(record?.artifactId).toBe(tenantA.artifactId);
    });

    test("callerIsAdmin does NOT cross tenants", async () => {
      const token = await seedDownloadToken({
        tenantId: tenantA.tenantId,
        userId: tenantA.userId,
        sessionId: tenantA.sessionId,
        artifactId: tenantA.artifactId
      });

      // Admin of tenant B, but naming tenant A's user, so the admin bypass
      // cannot be what saves this: only the tenant clause can.
      expect(
        await store().peekDownloadToken({
          token,
          requesterTenantId: tenantB.tenantId,
          requesterUserId: tenantA.userId,
          callerIsAdmin: true
        })
      ).toBeNull();
    });

    test("a cross-tenant consume returns null AND leaves the token unburnt", async () => {
      // Tokens are single-use, so a refused cross-tenant call that still
      // flipped consumed_at would be a denial-of-service on the real owner.
      const token = await seedDownloadToken({
        tenantId: tenantA.tenantId,
        userId: tenantA.userId,
        sessionId: tenantA.sessionId,
        artifactId: tenantA.artifactId
      });

      // Tenant A's own user again, so only the tenant clause can reject this.
      expect(
        await store().consumeDownloadToken({
          token,
          requesterTenantId: tenantB.tenantId,
          requesterUserId: tenantA.userId,
          callerIsAdmin: false
        })
      ).toBeNull();

      const { rows } = await superuserPool().query<{ consumed_at: string | null }>(
        `SELECT consumed_at FROM artifact_download_tokens WHERE token = $1`,
        [token]
      );
      expect(rows[0]?.consumed_at).toBeNull();

      // The owner can still use it.
      const consumed = await store().consumeDownloadToken({
        token,
        requesterTenantId: tenantA.tenantId,
        requesterUserId: tenantA.userId,
        callerIsAdmin: false
      });
      expect(consumed?.artifactId).toBe(tenantA.artifactId);
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

      expect(await new MessageStore(appPool()).sweepStaleStreaming(1000, 500)).toEqual([]);

      const swept = await new MessageStore(superuserPool()).sweepStaleStreaming(1000, 500);
      const ids = swept.map((row) => row.messageId);
      expect(ids).toContain(msgA);
      expect(ids).toContain(msgB);
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
// covers it. `artifacts.session_id` FKs to `sessions(session_id)` alone, not to
// `(tenant_id, session_id)`, and session ids are globally unique. So the FK is
// satisfied by ANY tenant's session, and the artifact's own row passes its
// WITH CHECK as long as its `tenant_id` is the caller's. Table-level RLS has
// nothing to say about whether a row's parent belongs to the same tenant.
describe.skipIf(!adminDatabaseUrl())("cross-tenant parent references", () => {
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;

  beforeAll(async () => {
    tenantA = await seedTenantGraph();
    tenantB = await seedTenantGraph();
  });

  test("an artifact naming another tenant's session is either rejected or stays tenant-scoped", async () => {
    // Characterizes a known gap WITHOUT pinning the vulnerable behaviour.
    //
    // `artifacts.session_id` references `sessions(session_id)`, not
    // `(tenant_id, session_id)`, and session ids are globally unique. So the FK
    // is satisfied by ANY tenant's session, and the artifact's own WITH CHECK
    // passes as long as its `tenant_id` is the caller's. Table-level RLS has
    // nothing to say about whether a row's parent belongs to the same tenant.
    //
    // Written to accept BOTH outcomes on purpose. Asserting "the write
    // succeeds" would mean fixing bead 700o turns this test red, which is a
    // security suite penalising a security fix. Asserting "the write fails"
    // would fail today. So: whichever happens, the invariant that must hold is
    // that tenant B never gains access.
    //
    // When 700o lands (composite FK on (tenant_id, session_id)), tighten this
    // to require rejection.
    const store = new ArtifactStore(appPool(), superuserPool());

    let created: Awaited<ReturnType<typeof store.create>> | null = null;
    let rejection: unknown = null;
    try {
      created = await store.create({
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
      });
    } catch (error) {
      rejection = error;
    }

    if (rejection !== null) {
      // 700o fixed: the database refused the cross-tenant parent. Nothing more
      // to check.
      return;
    }

    // Current behaviour: the write lands. The row must still be tenant A's, and
    // tenant B must not be able to see it despite the row pointing at B's own
    // session. If THAT ever broke, it would be a live cross-tenant read.
    const artifactId = created!.artifactId;
    const { rows } = await superuserPool().query<{ tenant_id: string }>(
      `SELECT tenant_id FROM artifacts WHERE artifact_id = $1`,
      [artifactId]
    );
    expect(rows[0]?.tenant_id).toBe(tenantA.tenantId);

    const visibleToB = await withTenantScope(appPool(), tenantB.tenantId, async (client) => {
      const result = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM artifacts WHERE artifact_id = $1`,
        [artifactId]
      );
      return Number(result.rows[0]?.count);
    });
    expect(visibleToB).toBe(0);
  });
});
