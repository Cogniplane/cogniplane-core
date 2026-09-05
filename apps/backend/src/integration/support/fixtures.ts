// Row factories for the integration suite.
//
// Every insert runs on the SUPERUSER pool, deliberately. Seeding through the
// stores would mean a store bug (writing the wrong tenant_id, or not writing
// at all) could mask a policy failure: the cross-tenant count would read zero
// for the wrong reason and the test would pass. Superuser inserts put the row
// there unconditionally, so a zero under tenant B is RLS and nothing else.
//
// The flip side, stated so nobody misreads green CI: this suite therefore does
// NOT exercise any store's insert path. A tenant-scoped store that stopped
// calling `withTenantScope` on writes would not be caught here.
//
// Ids are UUIDs, not a counter. A counter resets every process run and every
// worker starts at the same value, so it collides on exactly the dirty-database
// case it would be there to prevent.

import { randomUUID } from "node:crypto";

import { superuserPool } from "./database.js";

function id(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export async function seedTenant(): Promise<string> {
  const tenantId = id("tenant");
  await superuserPool().query(
    `INSERT INTO tenants (tenant_id, tenant_name, slug) VALUES ($1, $2, $3)`,
    [tenantId, `Tenant ${tenantId}`, tenantId]
  );
  return tenantId;
}

export async function seedUser(): Promise<string> {
  const userId = id("user");
  await superuserPool().query(`INSERT INTO users (user_id, email) VALUES ($1, $2)`, [
    userId,
    `${userId}@example.test`
  ]);
  return userId;
}

export async function seedMembership(
  tenantId: string,
  userId: string,
  role: "owner" | "admin" | "member" = "member"
): Promise<void> {
  await superuserPool().query(
    `INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)`,
    [tenantId, userId, role]
  );
}

export async function seedSession(tenantId: string, userId: string): Promise<string> {
  const sessionId = id("session");
  await superuserPool().query(
    `INSERT INTO sessions (session_id, tenant_id, user_id, session_name) VALUES ($1, $2, $3, $4)`,
    [sessionId, tenantId, userId, "integration session"]
  );
  return sessionId;
}

/**
 * Required by `seedApproval`: `approvals.runtime_id` is NOT NULL and FKs to
 * `runtime_sessions`.
 */
export async function seedRuntimeSession(
  tenantId: string,
  userId: string,
  sessionId: string
): Promise<string> {
  const runtimeId = id("runtime");
  await superuserPool().query(
    `
      INSERT INTO runtime_sessions
        (session_id, tenant_id, user_id, runtime_id, workspace_path, runtime_version)
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [sessionId, tenantId, userId, runtimeId, `/home/user/workspace/${sessionId}`, "test"]
  );
  return runtimeId;
}

export async function seedMessage(
  tenantId: string,
  userId: string,
  sessionId: string
): Promise<string> {
  const messageId = id("message");
  await superuserPool().query(
    `
      INSERT INTO messages (message_id, tenant_id, session_id, user_id, role, status, content_text)
      VALUES ($1, $2, $3, $4, 'user', 'complete', 'hello')
    `,
    [messageId, tenantId, sessionId, userId]
  );
  return messageId;
}

/**
 * A message left mid-stream, which is what `MessageStore.sweepStaleStreaming`
 * looks for. `created_at` is pushed into the past so the sweep's age predicate
 * matches without the test having to wait.
 */
export async function seedStreamingMessage(
  tenantId: string,
  userId: string,
  sessionId: string,
  ageMs = 60 * 60 * 1000
): Promise<string> {
  const messageId = id("message");
  await superuserPool().query(
    `
      INSERT INTO messages
        (message_id, tenant_id, session_id, user_id, role, status, content_text, created_at, updated_at)
      VALUES ($1, $2, $3, $4, 'assistant', 'streaming', '', NOW() - ($5::bigint * INTERVAL '1 millisecond'),
              NOW() - ($5::bigint * INTERVAL '1 millisecond'))
    `,
    [messageId, tenantId, sessionId, userId, ageMs]
  );
  return messageId;
}

export async function seedArtifact(
  tenantId: string,
  userId: string,
  sessionId: string
): Promise<string> {
  const artifactId = id("artifact");
  await superuserPool().query(
    `
      INSERT INTO artifacts
        (artifact_id, tenant_id, session_id, user_id, artifact_type, artifact_name,
         mime_type, storage_backend, storage_key, status)
      VALUES ($1, $2, $3, $4, 'upload', 'report.txt', 'text/plain', 'local', $5, 'ready')
    `,
    [artifactId, tenantId, sessionId, userId, `${tenantId}/${artifactId}`]
  );
  return artifactId;
}

export async function seedDownloadToken(input: {
  tenantId: string;
  userId: string;
  sessionId: string;
  artifactId: string;
}): Promise<string> {
  const token = id("dltok");
  await superuserPool().query(
    `
      INSERT INTO artifact_download_tokens
        (token, tenant_id, artifact_id, session_id, user_id, storage_backend,
         storage_key, file_name, content_type, expires_at)
      VALUES ($1, $2, $3, $4, $5, 'local', $6, 'report.txt', 'text/plain', NOW() + INTERVAL '15 minutes')
    `,
    [
      token,
      input.tenantId,
      input.artifactId,
      input.sessionId,
      input.userId,
      `${input.tenantId}/${input.artifactId}`
    ]
  );
  return token;
}

export async function seedApproval(input: {
  tenantId: string;
  userId: string;
  sessionId: string;
  runtimeId: string;
  /** Past expiry makes the row visible to `ApprovalStore.sweepExpired`. */
  expired?: boolean;
}): Promise<string> {
  const approvalId = id("approval");
  await superuserPool().query(
    `
      INSERT INTO approvals
        (approval_id, tenant_id, session_id, user_id, runtime_id, turn_id, item_id,
         request_method, request_id, kind, title, summary, status, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'tools/call', $8, 'tool', 'Run tool',
              'integration approval', 'pending',
              NOW() + ($9::int * INTERVAL '1 minute'))
    `,
    [
      approvalId,
      input.tenantId,
      input.sessionId,
      input.userId,
      input.runtimeId,
      id("turn"),
      id("item"),
      id("req"),
      input.expired ? -10 : 10
    ]
  );
  return approvalId;
}

export async function seedAgentMemory(tenantId: string, userId: string): Promise<string> {
  const memoryId = id("memory");
  await superuserPool().query(
    `
      INSERT INTO agent_memories (memory_id, tenant_id, user_id, slug, content)
      VALUES ($1, $2, $3, $4, 'remembered fact')
    `,
    [memoryId, tenantId, userId, memoryId]
  );
  return memoryId;
}

export async function seedScheduledJob(input: {
  tenantId: string;
  userId: string;
  /** Due now by default, so `listDueJobs` / `claimJob` match it. */
  due?: boolean;
  consecutiveFailures?: number;
}): Promise<string> {
  const jobId = id("job");
  await superuserPool().query(
    `
      INSERT INTO scheduled_jobs
        (job_id, tenant_id, user_id, job_name, cron_expression, time_zone,
         enabled, consecutive_failures, next_run_at)
      VALUES ($1, $2, $3, 'integration job', '0 * * * *', 'UTC', TRUE, $4,
              CASE WHEN $5::boolean THEN NOW() - INTERVAL '1 minute' ELSE NOW() + INTERVAL '1 day' END)
    `,
    [jobId, input.tenantId, input.userId, input.consecutiveFailures ?? 0, input.due ?? true]
  );
  return jobId;
}

/**
 * A run left `pending`, which is what `sweepStaleJobRuns` recovers. `started_at`
 * is pushed into the past so the sweep's age predicate matches.
 */
export async function seedScheduledJobRun(input: {
  tenantId: string;
  userId: string;
  jobId: string;
  ageMs?: number;
}): Promise<string> {
  const runId = id("run");
  await superuserPool().query(
    `
      INSERT INTO scheduled_job_runs
        (run_id, tenant_id, job_id, user_id, status, started_at)
      VALUES ($1, $2, $3, $4, 'pending', NOW() - ($5::bigint * INTERVAL '1 millisecond'))
    `,
    [runId, input.tenantId, input.jobId, input.userId, input.ageMs ?? 60 * 60 * 1000]
  );
  return runId;
}

export async function seedPiiScanRun(input: {
  tenantId: string;
  userId: string;
  sessionId: string;
}): Promise<string> {
  const scanRunId = id("scanrun");
  await superuserPool().query(
    `
      INSERT INTO pii_scan_runs
        (tenant_id, scan_run_id, subject_type, subject_id, source_session_id, source_user_id, mode)
      VALUES ($1, $2, 'message', $3, $4, $5, 'detect')
    `,
    [input.tenantId, scanRunId, id("subject"), input.sessionId, input.userId]
  );
  return scanRunId;
}

export async function seedPiiScanJob(input: {
  tenantId: string;
  userId: string;
  sessionId: string;
  scanRunId: string;
  /** `claimed` and stale, so `sweepStaleClaims` matches. */
  staleClaimAgeMs?: number;
}): Promise<string> {
  const jobId = id("piijob");
  if (input.staleClaimAgeMs === undefined) {
    await superuserPool().query(
      `
        INSERT INTO pii_scan_jobs
          (tenant_id, job_id, scan_run_id, subject_type, subject_id,
           source_session_id, source_user_id, mode, status, run_after)
        VALUES ($1, $2, $3, 'message', $4, $5, $6, 'detect', 'queued', NOW() - INTERVAL '1 minute')
      `,
      [input.tenantId, jobId, input.scanRunId, id("subject"), input.sessionId, input.userId]
    );
  } else {
    await superuserPool().query(
      `
        INSERT INTO pii_scan_jobs
          (tenant_id, job_id, scan_run_id, subject_type, subject_id,
           source_session_id, source_user_id, mode, status, claimed_at)
        VALUES ($1, $2, $3, 'message', $4, $5, $6, 'detect', 'claimed',
                NOW() - ($7::bigint * INTERVAL '1 millisecond'))
      `,
      [
        input.tenantId,
        jobId,
        input.scanRunId,
        id("subject"),
        input.sessionId,
        input.userId,
        input.staleClaimAgeMs
      ]
    );
  }
  return jobId;
}

/** One tenant with a full object graph, for the isolation tests. */
export type TenantFixture = {
  tenantId: string;
  userId: string;
  sessionId: string;
  runtimeId: string;
  messageId: string;
  artifactId: string;
  approvalId: string;
  memoryId: string;
  jobId: string;
};

export async function seedTenantGraph(): Promise<TenantFixture> {
  const tenantId = await seedTenant();
  const userId = await seedUser();
  await seedMembership(tenantId, userId, "owner");
  const sessionId = await seedSession(tenantId, userId);
  const runtimeId = await seedRuntimeSession(tenantId, userId, sessionId);
  const messageId = await seedMessage(tenantId, userId, sessionId);
  const artifactId = await seedArtifact(tenantId, userId, sessionId);
  const approvalId = await seedApproval({ tenantId, userId, sessionId, runtimeId });
  const memoryId = await seedAgentMemory(tenantId, userId);
  const jobId = await seedScheduledJob({ tenantId, userId });

  return {
    tenantId,
    userId,
    sessionId,
    runtimeId,
    messageId,
    artifactId,
    approvalId,
    memoryId,
    jobId
  };
}
