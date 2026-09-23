import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test, vi } from "vitest";
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph";

import { createDeepAgentsCheckpointer } from "../services/deep-agents/deep-agents-checkpointer.js";
import { TenantDeletionService } from "../services/tenant-deletion-service.js";
import {
  adminDatabaseUrl,
  appPool,
  runAppUserUrl,
  superuserPool
} from "./support/database.js";
import {
  seedArtifact,
  seedMembership,
  seedSession,
  seedTenant,
  seedUser
} from "./support/fixtures.js";

describe.skipIf(!adminDatabaseUrl())("tenant offboarding", () => {
  const checkpointer = adminDatabaseUrl() ? createDeepAgentsCheckpointer(runAppUserUrl()) : null;

  afterAll(async () => {
    await checkpointer?.end();
  });

  test("every tenant table cascades from the tenant root", async () => {
    const result = await superuserPool().query<{ table_name: string; has_cascade: boolean }>(`
      SELECT c.table_name,
             EXISTS (
               SELECT 1
               FROM pg_constraint con
               JOIN pg_attribute a
                 ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
               WHERE con.contype = 'f'
                 AND con.conrelid = format('public.%I', c.table_name)::regclass
                 AND con.confrelid = 'public.tenants'::regclass
                 AND array_length(con.conkey, 1) = 1
                 AND a.attname = 'tenant_id'
                 AND con.confdeltype = 'c'
             ) AS has_cascade
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.column_name = 'tenant_id'
        AND c.table_name <> 'tenants'
      ORDER BY c.table_name
    `);
    expect(result.rows.filter((row) => !row.has_cascade).map((row) => row.table_name)).toEqual([]);
  });

  test("deletes one non-production tenant and records a content-free receipt", async () => {
    const targetTenant = await seedTenant();
    const otherTenant = await seedTenant();
    const targetUser = await seedUser();
    const sharedUser = await seedUser();
    const otherUser = await seedUser();
    await seedMembership(targetTenant, targetUser, "owner");
    await seedMembership(targetTenant, sharedUser);
    await seedMembership(otherTenant, sharedUser);
    await seedMembership(otherTenant, otherUser, "owner");
    const targetSession = await seedSession(targetTenant, targetUser);
    const otherSession = await seedSession(otherTenant, otherUser);

    const dedicatedArtifactId = await seedArtifact(targetTenant, targetUser, targetSession);
    const sharedTargetArtifactId = await seedArtifact(targetTenant, targetUser, targetSession);
    const sharedOtherArtifactId = await seedArtifact(otherTenant, otherUser, otherSession);
    const dedicatedKey = `${targetTenant}/${dedicatedArtifactId}`;
    const sharedKey = `shared/${randomUUID()}`;
    await superuserPool().query(
      `UPDATE artifacts SET storage_key = $1 WHERE artifact_id = ANY($2::text[])`,
      [sharedKey, [sharedTargetArtifactId, sharedOtherArtifactId]]
    );

    const dedicatedBundle = `file:///tmp/${targetTenant}/dedicated-skill`;
    const sharedBundle = `file:///tmp/shared-${randomUUID()}`;
    await superuserPool().query(
      `
        INSERT INTO admin_skills (tenant_id, skill_id, skill_name, created_by)
        VALUES ($1, 'skill-dedicated', 'Dedicated', $2),
               ($1, 'skill-shared', 'Shared target', $2),
               ($3, 'skill-shared', 'Shared other', $4)
      `,
      [targetTenant, targetUser, otherTenant, otherUser]
    );
    await superuserPool().query(
      `
        INSERT INTO admin_skill_revisions
          (tenant_id, skill_id, revision_number, source_type, bundle_hash, created_by, bundle_storage_uri)
        VALUES ($1, 'skill-dedicated', 1, 'upload', 'hash-a', $2, $3),
               ($1, 'skill-shared', 1, 'upload', 'hash-b', $2, $4),
               ($5, 'skill-shared', 1, 'upload', 'hash-c', $6, $4)
      `,
      [targetTenant, targetUser, dedicatedBundle, sharedBundle, otherTenant, otherUser]
    );

    const checkpointConfig = { configurable: { thread_id: targetSession, checkpoint_ns: "" } };
    const checkpoint: Checkpoint = {
      v: 4,
      id: `cp-${randomUUID()}`,
      ts: new Date().toISOString(),
      channel_values: { messages: ["must be removed"] },
      channel_versions: { messages: 1 },
      versions_seen: {}
    };
    const metadata: CheckpointMetadata = { source: "input", step: 1, parents: {} };
    await checkpointer!.put(checkpointConfig, checkpoint, metadata, { messages: 1 });

    const deleteArtifact = vi
      .fn<(storageKey: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("temporary object-store failure"))
      .mockResolvedValue(undefined);
    const deleteBundle = vi.fn(async () => undefined);
    const flushRedis = vi.fn(async () => undefined);
    const service = new TenantDeletionService({
      db: superuserPool(),
      artifactStorage: { delete: deleteArtifact },
      skillBundleStorage: { deleteBundle },
      purgeRuntimeThread: (threadId) => checkpointer!.deleteThread(threadId),
      flushRedis
    });
    const requestId = `NONPROD-OFFBOARD-${randomUUID()}`;
    const deletionInput = {
      requestId,
      tenantId: targetTenant,
      redisDisposition: "Integration Redis double flushed.",
      thirdPartyDisposition: "No third-party tenant was provisioned in the integration fixture.",
      backupDisposition: "Throwaway integration database is destroyed after the suite."
    };
    const failedReceipt = await service.execute(deletionInput);
    expect(failedReceipt).toMatchObject({
      status: "cleanup_failed",
      deletedObjectCount: 1,
      retainedSharedObjectCount: 2,
      lastError: expect.stringContaining("temporary object-store failure")
    });
    expect((await superuserPool().query(`SELECT 1 FROM tenants WHERE tenant_id = $1`, [targetTenant])).rowCount).toBe(0);

    const receipt = await service.execute(deletionInput);

    expect(receipt).toMatchObject({
      requestId,
      status: "completed",
      objectCount: 4,
      deletedObjectCount: 2,
      retainedSharedObjectCount: 2,
      runtimeThreadCount: 1,
      purgedRuntimeThreadCount: 1,
      lastError: null
    });
    expect(JSON.stringify(receipt)).not.toContain(targetTenant);
    expect(deleteArtifact).toHaveBeenCalledTimes(2);
    expect(deleteArtifact).toHaveBeenNthCalledWith(1, dedicatedKey);
    expect(deleteArtifact).toHaveBeenNthCalledWith(2, dedicatedKey);
    expect(deleteBundle).toHaveBeenCalledTimes(1);
    expect(deleteBundle).toHaveBeenCalledWith(dedicatedBundle);
    expect(flushRedis).toHaveBeenCalledTimes(1);
    expect(await checkpointer!.getTuple(checkpointConfig)).toBeUndefined();

    expect((await superuserPool().query(`SELECT 1 FROM tenants WHERE tenant_id = $1`, [targetTenant])).rowCount).toBe(0);
    expect((await superuserPool().query(`SELECT 1 FROM tenants WHERE tenant_id = $1`, [otherTenant])).rowCount).toBe(1);
    expect((await superuserPool().query(`SELECT 1 FROM users WHERE user_id = $1`, [targetUser])).rowCount).toBe(0);
    expect((await superuserPool().query(`SELECT 1 FROM users WHERE user_id = $1`, [sharedUser])).rowCount).toBe(1);
    expect((await superuserPool().query(`SELECT 1 FROM artifacts WHERE artifact_id = $1`, [sharedOtherArtifactId])).rowCount).toBe(1);

    const tenantTables = await superuserPool().query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'tenant_id'
    `);
    for (const { table_name: tableName } of tenantTables.rows) {
      const quoted = `"${tableName.replaceAll('"', '""')}"`;
      const remaining = await superuserPool().query(
        `SELECT 1 FROM public.${quoted} WHERE tenant_id = $1 LIMIT 1`,
        [targetTenant]
      );
      expect(remaining.rowCount, tableName).toBe(0);
    }

    expect(
      (await appPool().query(`SELECT * FROM tenant_deletion_receipts WHERE request_id = $1`, [requestId])).rowCount
    ).toBe(0);
  });
});
