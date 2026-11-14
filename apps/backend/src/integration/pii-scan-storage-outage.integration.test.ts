// A slow or failing bucket during a queued PII scan. The scan reads the file
// through the real S3 client (createBucketClient) from a local HTTP stub of
// S3. A stall or an outage puts the job back in the queue without using its
// scan budget, the upload stays pending, and the reader leaves no socket
// open. A missing object still uses the budget and fails the upload.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { DEFAULT_PII_PROTECTION, type PiiProtectionSettings } from "@cogniplane/shared-types";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { AppConfig } from "../config.js";
import { BucketArtifactStorage, BUCKET_REQUEST_LIMITS, createBucketClient, type BucketRequestLimits } from "../services/artifacts/artifact-storage.js";
import { ArtifactStore, UPLOAD_SCAN_PENDING_KEY } from "../services/artifacts/artifact-store.js";
import { AuditEventStore } from "../services/audit-event-store.js";
import { piiPolicyReader } from "../services/pii/build-pii-services.js";
import { PiiArtifactScanEnqueuer } from "../services/pii/pii-artifact-scan-enqueuer.js";
import { PiiProtectionService } from "../services/pii/pii-protection-service.js";
import { PiiScanJobHandler } from "../services/pii/pii-scan-job-handler.js";
import { PiiScanJobStore } from "../services/pii/pii-scan-job-store.js";
import { PiiScanRunStore } from "../services/pii/pii-scan-run-store.js";
import { DatabasePiiScanSubjectReader } from "../services/pii/pii-scan-subject-reader.js";
import { RuleBasedPiiDetector } from "../services/pii/rule-based-pii-detector.js";
import { TenantOrgSettingsStore } from "../services/tenant-org-settings-store.js";
import { PII_SAVE_ALLOWED } from "../test-helpers/data-routes.js";
import { adminDatabaseUrl, appPool, maintenancePool, superuserPool } from "./support/database.js";
import { seedTenantGraph } from "./support/fixtures.js";

const ENCRYPTION_SECRET = "pii-scan-storage-outage-integration-secret";
const BUCKET = "uploads";

type Mode = "ok" | "stall-headers" | "stall-body" | "missing" | "unavailable";

/** A local S3 endpoint (path style). It records its open sockets. */
class BucketStub {
  mode: Mode = "ok";
  requests = 0;
  readonly sockets = new Set<Socket>();
  private readonly server: Server;
  private readonly stalled = new Set<ServerResponse>();

  constructor() {
    this.server = createServer((request, response) => this.handle(request, response));
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    for (const response of this.stalled) response.destroy();
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(_request: IncomingMessage, response: ServerResponse): void {
    this.requests += 1;
    const body = Buffer.from("Contact jane.doe@example.com about the report.\n");
    switch (this.mode) {
      case "ok":
        response.writeHead(200, { "Content-Type": "text/plain", "Content-Length": String(body.length) });
        response.end(body);
        return;
      case "stall-headers":
        // The first byte would come after 60 seconds.
        this.stalled.add(response);
        setTimeout(() => response.destroy(), 60_000).unref();
        return;
      case "stall-body":
        this.stalled.add(response);
        response.writeHead(200, { "Content-Type": "text/plain", "Content-Length": String(body.length * 10) });
        response.write(body.subarray(0, 8));
        return;
      case "missing":
        response.writeHead(404, { "Content-Type": "application/xml" });
        response.end("<?xml version=\"1.0\"?><Error><Code>NoSuchKey</Code><Message>missing</Message></Error>");
        return;
      case "unavailable":
        response.writeHead(503, { "Content-Type": "application/xml" });
        response.end("<?xml version=\"1.0\"?><Error><Code>ServiceUnavailable</Code><Message>down</Message></Error>");
        return;
    }
  }
}

function detectPolicy(): PiiProtectionSettings {
  return { ...DEFAULT_PII_PROTECTION, enabled: true, mode: "detect", scopes: { ...DEFAULT_PII_PROTECTION.scopes, uploads: true } };
}

let stub: BucketStub;
let endpoint: string;

async function setup(options: { evaluationTimeoutMs: number; limits: BucketRequestLimits }) {
  const fixture = await seedTenantGraph();
  const storageKey = `${fixture.tenantId}/${fixture.artifactId}`;
  // A new upload waits for its scan.
  // As UploadAdmission writes it (artifact-store.ts, createUpload).
  await superuserPool().query(
    `UPDATE artifacts SET status = 'pending', storage_backend = 'bucket',
       detail_json = COALESCE(detail_json, '{}'::jsonb) || jsonb_build_object($2::text, true)
     WHERE artifact_id = $1`,
    [fixture.artifactId, UPLOAD_SCAN_PENDING_KEY]
  );
  const settings = new TenantOrgSettingsStore(appPool(), ENCRYPTION_SECRET);
  await settings.setPiiProtection(fixture.tenantId, detectPolicy(), PII_SAVE_ALLOWED);
  const client = createBucketClient({
    ARTIFACT_BUCKET_REGION: "us-east-1",
    ARTIFACT_BUCKET_ENDPOINT: endpoint,
    ARTIFACT_BUCKET_FORCE_PATH_STYLE: true,
    ARTIFACT_BUCKET_ACCESS_KEY_ID: "test-access-key",
    ARTIFACT_BUCKET_SECRET_ACCESS_KEY: "test-secret-key"
  } as AppConfig, options.limits);
  const storage = new BucketArtifactStorage({ client, bucketName: BUCKET });
  const artifacts = new ArtifactStore(appPool());
  const piiScanRuns = new PiiScanRunStore(appPool());
  const piiScanJobs = new PiiScanJobStore(appPool(), maintenancePool());
  const piiProtection = new PiiProtectionService({
    policyReader: piiPolicyReader(new TenantOrgSettingsStore(maintenancePool(), ENCRYPTION_SECRET)),
    ruleDetector: new RuleBasedPiiDetector(),
    timeoutMs: options.evaluationTimeoutMs
  });
  const deps = {
    piiProtection,
    piiScanRuns,
    piiScanJobs,
    artifacts,
    storage,
    subjectReader: new DatabasePiiScanSubjectReader({ db: appPool(), artifacts, storage }),
    auditEvents: new AuditEventStore(appPool()),
    logger: { error() {}, warn() {} }
  };
  const queued = await new PiiArtifactScanEnqueuer(deps).enqueue({
    tenantId: fixture.tenantId, artifactId: fixture.artifactId, sessionId: fixture.sessionId,
    userId: fixture.userId, contentType: "text/plain", storageKey, source: "upload"
  });
  if (queued.kind !== "queued") throw new Error(`expected a queued scan, got ${queued.kind}`);
  const handler = new PiiScanJobHandler({ ...deps, messages: { setPiiDetail: async () => {} } });
  /** Makes the job due, claims it as the worker does, and runs it. */
  const runOnce = async () => {
    await superuserPool().query("UPDATE pii_scan_jobs SET run_after = NOW() WHERE job_id = $1 AND status = 'queued'", [queued.jobId]);
    const [job] = (await piiScanJobs.claimDueJobs(50)).filter((claimed) => claimed.jobId === queued.jobId);
    if (!job) throw new Error("the job was not claimed");
    await handler.execute(job);
  };
  const state = async () => {
    const db = superuserPool();
    const [job, artifact] = await Promise.all([
      db.query("SELECT status, attempts, transient_retries, error_message, run_after > NOW() AS deferred FROM pii_scan_jobs WHERE job_id = $1", [queued.jobId]),
      db.query("SELECT status, detail_json->'pii'->>'status' AS pii FROM artifacts WHERE artifact_id = $1", [fixture.artifactId])
    ]);
    return { job: job.rows[0], artifact: artifact.rows[0] };
  };
  return { runOnce, state, client };
}

/** Short limits, so a test does not wait 30 seconds for each request. */
const FAST_LIMITS: BucketRequestLimits = { connectionTimeout: 500, requestTimeout: 600, socketTimeout: 600 };

describe.skipIf(!adminDatabaseUrl())("PII scan during a storage outage", () => {
  beforeEach(async () => {
    stub = new BucketStub();
    endpoint = await stub.listen();
  });

  afterEach(async () => {
    await stub.close();
  });

  test("a bucket that delays the first byte by 60 seconds puts the job back without using its budget", async () => {
    stub.mode = "stall-headers";
    const h = await setup({ evaluationTimeoutMs: 20_000, limits: FAST_LIMITS });
    const started = Date.now();
    await h.runOnce();
    // The request limit ended the wait (the SDK retries a timeout twice).
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(stub.requests).toBeGreaterThanOrEqual(1);
    expect(await h.state()).toEqual({
      job: { status: "queued", attempts: 1, transient_retries: 1, error_message: expect.stringMatching(/^pii_storage_unavailable/), deferred: true },
      artifact: { status: "pending", pii: "pending" }
    });
    await vi.waitFor(() => expect(stub.sockets.size).toBe(0), { timeout: 5_000 });
    h.client.destroy();
  });

  test("with the production request limits, the evaluation timeout ends a first-byte stall as a storage failure and closes the socket", async () => {
    stub.mode = "stall-headers";
    const h = await setup({ evaluationTimeoutMs: 1_000, limits: BUCKET_REQUEST_LIMITS });
    await h.runOnce();
    expect((await h.state()).job).toMatchObject({ status: "queued", attempts: 1, transient_retries: 1 });
    expect((await h.state()).job.error_message).toMatch(/^pii_storage_unavailable/);
    // The abort destroyed the request: no socket waits for the 60 seconds.
    await vi.waitFor(() => expect(stub.sockets.size).toBe(0), { timeout: 5_000 });
    h.client.destroy();
  });

  test("a body that stalls is destroyed: by the socket limit, or by the evaluation timeout", async () => {
    stub.mode = "stall-body";
    const bySocket = await setup({ evaluationTimeoutMs: 20_000, limits: FAST_LIMITS });
    await bySocket.runOnce();
    expect((await bySocket.state()).job).toMatchObject({ status: "queued", transient_retries: 1 });
    await vi.waitFor(() => expect(stub.sockets.size).toBe(0), { timeout: 5_000 });
    bySocket.client.destroy();

    const byTimeout = await setup({ evaluationTimeoutMs: 1_000, limits: BUCKET_REQUEST_LIMITS });
    await byTimeout.runOnce();
    expect((await byTimeout.state()).job).toMatchObject({ status: "queued", transient_retries: 1 });
    expect((await byTimeout.state()).artifact).toEqual({ status: "pending", pii: "pending" });
    await vi.waitFor(() => expect(stub.sockets.size).toBe(0), { timeout: 5_000 });
    byTimeout.client.destroy();
  });

  test("repeated outages keep the scan budget, and the scan finishes when the bucket is back", async () => {
    const h = await setup({ evaluationTimeoutMs: 20_000, limits: FAST_LIMITS });
    for (const mode of ["unavailable", "stall-headers", "unavailable", "stall-body", "unavailable"] as const) {
      stub.mode = mode;
      await h.runOnce();
      expect((await h.state()).job.status).toBe("queued");
    }
    expect((await h.state()).job).toMatchObject({ attempts: 5, transient_retries: 5 });
    stub.mode = "ok";
    await h.runOnce();
    expect(await h.state()).toMatchObject({
      job: { status: "completed", attempts: 6, transient_retries: 5 },
      artifact: { status: "ready", pii: "scanned" }
    });
    h.client.destroy();
  });

  test("a missing object is not a storage outage: it uses the budget and fails the upload", async () => {
    stub.mode = "missing";
    const h = await setup({ evaluationTimeoutMs: 20_000, limits: FAST_LIMITS });
    for (let attempt = 0; attempt < 3; attempt += 1) await h.runOnce();
    expect(await h.state()).toMatchObject({
      job: { status: "failed", attempts: 3, transient_retries: 0 },
      artifact: { status: "failed", pii: "failed" }
    });
    h.client.destroy();
  });
});
