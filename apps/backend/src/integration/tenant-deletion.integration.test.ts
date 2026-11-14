import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test, vi } from "vitest";
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph";

import { PasswordHasher } from "../lib/password-hash.js";
import { bootstrapLocalTenant } from "../scripts/local-auth-commands-lib.js";
import { LocalAccountService, markLocalIdentityRemoved } from "../services/auth/local-account-service.js";
import { createDeepAgentsCheckpointer } from "../services/deep-agents/deep-agents-checkpointer.js";
import {
  TenantDeletionService,
  USER_ID_COLUMNS_WITHOUT_FOREIGN_KEY
} from "../services/tenant-deletion-service.js";
import {
  adminDatabaseUrl,
  appPool,
  maintenancePool,
  runAppUserUrl,
  superuserPool,
  unfencedCheckpointWriter
} from "./support/database.js";
import {
  seedArtifact,
  seedMembership,
  seedMessage,
  seedScheduledJob,
  seedSession,
  seedTenant,
  seedUser
} from "./support/fixtures.js";
import { IGNORE_SECURITY_CHANGE } from "../test-helpers/security-change.js";
import { withSecurityChange } from "../services/auth/security-change.js";

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

  // Tenant deletion finds users through every column that can store a user id.
  // It reads foreign keys to users from the catalog; any other such column must
  // be in USER_ID_COLUMNS_WITHOUT_FOREIGN_KEY. Unknown, it would keep a user row
  // of the deleted tenant, or point at a deleted user in another tenant.
  test("names every column that can hold a user id", async () => {
    // Column names that look like a user id but hold another system's id.
    const otherIdentifiers = new Set([
      "user_github_connections.github_user_id",
      "user_jira_cleanups.pipedream_external_user_id",
      "user_jira_connections.pipedream_external_user_id",
      "user_jira_identities.pipedream_external_user_id",
      "user_microsoft_connections.microsoft_user_id",
      "user_notion_connections.notion_user_id"
    ]);
    const result = await superuserPool().query<{
      name: string;
      data_type: string;
      has_tenant_id: boolean;
      user_foreign_key: boolean;
    }>(`
      SELECT c.table_name || '.' || c.column_name AS name, c.data_type,
             EXISTS (
               SELECT 1 FROM information_schema.columns t
               WHERE t.table_schema = 'public' AND t.table_name = c.table_name AND t.column_name = 'tenant_id'
             ) AS has_tenant_id,
             EXISTS (
               SELECT 1
               FROM pg_constraint con
               JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
               WHERE con.contype = 'f'
                 AND con.confrelid = 'public.users'::regclass
                 AND con.conrelid = format('public.%I', c.table_name)::regclass
                 AND a.attname = c.column_name
             ) AS user_foreign_key
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public' AND c.table_name <> 'users'
      ORDER BY name
    `);
    const columns = new Map(result.rows.map((row) => [row.name, row]));
    const listed = USER_ID_COLUMNS_WITHOUT_FOREIGN_KEY.map(([table, column]) => `${table}.${column}`);

    // A listed column is a text column of a tenant table with no foreign key.
    const wrongEntries = listed.filter((name) => {
      const column = columns.get(name);
      return !column || column.data_type !== "text" || !column.has_tenant_id || column.user_foreign_key;
    });
    expect(wrongEntries).toEqual([]);
    expect([...otherIdentifiers].filter((name) => !columns.has(name))).toEqual([]);

    // `table.column` names: user_id, *_user_id, *_by.
    const userIdName = /[._]user_id$|_by$/;
    const unclassified = result.rows
      .filter((row) => userIdName.test(row.name) && !row.user_foreign_key)
      .map((row) => row.name)
      .filter((name) => !listed.includes(name) && !otherIdentifiers.has(name));
    expect(unclassified).toEqual([]);
    // The pattern finds every listed column, so it still finds new ones.
    expect(listed.filter((name) => !userIdName.test(name))).toEqual([]);
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
    await unfencedCheckpointWriter().put(checkpointConfig, checkpoint, metadata, { messages: 1 });

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

    // A replay of the completed request does no work and returns the same
    // receipt, completion time included.
    expect(await service.execute(deletionInput)).toEqual(receipt);
    expect(deleteArtifact).toHaveBeenCalledTimes(2);
    expect(flushRedis).toHaveBeenCalledTimes(1);

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

  // A local tenant's accounts, also one removed earlier (it has no membership
  // left), leave with the tenant: identities, passwords, links, and user rows.
  test("deletes a local tenant with its local accounts", async () => {
    const boot = await bootstrapLocalTenant(superuserPool(), "https://app.test", {
      tenantName: "Local offboarding", ownerEmail: `${randomUUID()}@example.test`, ownerName: null
    });
    const accounts = new LocalAccountService({ afterSecurityChange: IGNORE_SECURITY_CHANGE,
      db: appPool(), lookupDb: maintenancePool(), hasher: new PasswordHasher(2), frontendOrigin: "https://app.test"
    });
    const meta = { ipAddress: null, userAgent: null };
    await accounts.redeemLink("account_setup", boot.link.url.split("#token=")[1]!, "purple elephants dance quietly", meta);
    const removed = await accounts.createMember({
      tenantId: boot.tenantId, email: `${randomUUID()}@example.test`, displayName: null, role: "member", actorUserId: boot.userId, meta
    });
    await withSecurityChange(appPool(), boot.tenantId, IGNORE_SECURITY_CHANGE, async (client, change) => {
      await markLocalIdentityRemoved(change, removed.userId);
      await client.query(`DELETE FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2`, [boot.tenantId, removed.userId]);
    });

    const service = new TenantDeletionService({
      db: superuserPool(),
      artifactStorage: { delete: vi.fn(async () => undefined) },
      skillBundleStorage: { deleteBundle: vi.fn(async () => undefined) },
      purgeRuntimeThread: (threadId) => checkpointer!.deleteThread(threadId),
      flushRedis: vi.fn(async () => undefined)
    });
    const receipt = await service.execute({
      requestId: `NONPROD-OFFBOARD-${randomUUID()}`,
      tenantId: boot.tenantId,
      redisDisposition: "Integration Redis double flushed.",
      thirdPartyDisposition: "None.",
      backupDisposition: "None."
    });

    expect(receipt.status).toBe("completed");
    for (const table of ["local_identities", "local_passwords", "auth_action_tokens", "tenant_memberships"]) {
      expect((await superuserPool().query(`SELECT 1 FROM ${table} WHERE tenant_id = $1`, [boot.tenantId])).rowCount, table).toBe(0);
    }
    expect((await superuserPool().query(`SELECT 1 FROM users WHERE user_id = ANY($1)`, [[boot.userId, removed.userId]])).rowCount).toBe(0);
  });

  // Member removal (routes/tenant.ts) deletes only the membership row. The
  // removed member's sessions, jobs, settings and audit events stay in that
  // tenant, so a user without a membership can still belong to another tenant.
  describe("user rows", () => {
    function deletionService() {
      return new TenantDeletionService({
        db: superuserPool(),
        artifactStorage: { delete: vi.fn(async () => undefined) },
        skillBundleStorage: { deleteBundle: vi.fn(async () => undefined) },
        purgeRuntimeThread: (threadId) => checkpointer!.deleteThread(threadId),
        flushRedis: vi.fn(async () => undefined)
      });
    }

    const deletion = (tenantId: string) => ({
      requestId: `NONPROD-OFFBOARD-${randomUUID()}`,
      tenantId,
      redisDisposition: "Integration Redis double flushed.",
      thirdPartyDisposition: "None.",
      backupDisposition: "None."
    });

    async function existingUsers(userIds: string[]): Promise<string[]> {
      const result = await superuserPool().query<{ user_id: string }>(
        `SELECT user_id FROM users WHERE user_id = ANY($1::text[]) ORDER BY user_id`,
        [userIds]
      );
      return result.rows.map((row) => row.user_id);
    }

    // Row count of every tenant table for one tenant. A cascade from a user
    // delete changes it; equal counts before and after show that the deletion
    // of another tenant removed nothing here.
    async function tenantRows(tenantId: string): Promise<Record<string, number>> {
      const tables = await superuserPool().query<{ table_name: string }>(`
        SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'tenant_id'
        ORDER BY table_name
      `);
      const counts: Record<string, number> = {};
      for (const { table_name: tableName } of tables.rows) {
        const quoted = `"${tableName.replaceAll('"', '""')}"`;
        const result = await superuserPool().query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM public.${quoted} WHERE tenant_id = $1`,
          [tenantId]
        );
        counts[tableName] = result.rows[0]!.count;
      }
      return counts;
    }

    async function seedAuditEvent(tenantId: string, userId: string): Promise<string> {
      const result = await superuserPool().query<{ id: string }>(
        `INSERT INTO audit_events (tenant_id, user_id, event_type) VALUES ($1, $2, 'session.created') RETURNING id::text`,
        [tenantId, userId]
      );
      return result.rows[0]!.id;
    }

    async function seedTenantWithOwner(): Promise<string> {
      const tenantId = await seedTenant();
      await seedMembership(tenantId, await seedUser(), "owner");
      return tenantId;
    }

    test("keeps a former member whose rows in another tenant restrict the user delete", async () => {
      const target = await seedTenantWithOwner();
      const other = await seedTenantWithOwner();
      const formerMember = await seedUser();
      await seedMembership(target, formerMember);
      // Removed from `other` earlier: its session, message and project stay there.
      const session = await seedSession(other, formerMember);
      await seedMessage(other, formerMember, session);
      await superuserPool().query(
        `INSERT INTO projects (project_id, tenant_id, user_id, name) VALUES ($1, $2, $3, 'Former member project')`,
        [`project_${randomUUID()}`, other, formerMember]
      );
      const otherBefore = await tenantRows(other);

      const receipt = await deletionService().execute(deletion(target));

      expect(receipt.status).toBe("completed");
      expect((await superuserPool().query(`SELECT 1 FROM tenants WHERE tenant_id = $1`, [target])).rowCount).toBe(0);
      expect(await existingUsers([formerMember])).toEqual([formerMember]);
      expect(await tenantRows(other)).toEqual(otherBefore);
      expect(otherBefore).toMatchObject({ sessions: 1, messages: 1, projects: 1 });
    });

    test("keeps a former member whose rows in another tenant cascade, lose their user, or name it without a foreign key", async () => {
      const target = await seedTenantWithOwner();
      const other = await seedTenantWithOwner();
      // Removed from `other` earlier: rows that a user delete would cascade
      // away (job, settings) or set to NULL (audit event) stay there.
      const formerMember = await seedUser();
      await seedMembership(target, formerMember);
      await seedScheduledJob({ tenantId: other, userId: formerMember, due: false });
      await superuserPool().query(
        `INSERT INTO user_settings_sections (tenant_id, user_id, section_key) VALUES ($1, $2, 'general')`,
        [other, formerMember]
      );
      const auditId = await seedAuditEvent(other, formerMember);
      // A former admin of `other` that only an actor column names there.
      const formerAdmin = await seedUser();
      await seedMembership(target, formerAdmin);
      await superuserPool().query(
        `INSERT INTO admin_skills (tenant_id, skill_id, skill_name, created_by) VALUES ($1, 'skill-former-admin', 'Kept', $2)`,
        [other, formerAdmin]
      );
      const otherBefore = await tenantRows(other);

      const receipt = await deletionService().execute(deletion(target));

      expect(receipt.status).toBe("completed");
      expect(await existingUsers([formerMember, formerAdmin])).toEqual([formerMember, formerAdmin].sort());
      expect(await tenantRows(other)).toEqual(otherBefore);
      expect(otherBefore).toMatchObject({ scheduled_jobs: 1, user_settings_sections: 1, admin_skills: 1 });
      const audit = await superuserPool().query(`SELECT user_id FROM audit_events WHERE id = $1`, [auditId]);
      expect(audit.rows).toEqual([{ user_id: formerMember }]);
    });

    test("deletes former members that only the deleted tenant names, and keeps every other user", async () => {
      const target = await seedTenantWithOwner();
      const other = await seedTenantWithOwner();
      const shared = await seedUser();
      await seedMembership(target, shared);
      await seedMembership(other, shared);
      await seedSession(other, shared);
      const otherOnly = await seedUser();
      await seedMembership(other, otherOnly);
      await seedAuditEvent(other, otherOnly);
      // No tenant row names this user (a dev-headers `ensureUser` row).
      const unrelated = await seedUser();
      // A WorkOS member removed from the target earlier: no membership and no
      // local identity, but its session, message and audit event stay.
      const formerMember = await seedUser();
      const session = await seedSession(target, formerMember);
      await seedMessage(target, formerMember, session);
      await seedAuditEvent(target, formerMember);
      // A former admin of the target that only an actor column names.
      const formerAdmin = await seedUser();
      await superuserPool().query(
        `INSERT INTO admin_skills (tenant_id, skill_id, skill_name, created_by) VALUES ($1, 'skill-former-admin', 'Gone', $2)`,
        [target, formerAdmin]
      );
      const otherBefore = await tenantRows(other);

      const receipt = await deletionService().execute(deletion(target));

      expect(receipt.status).toBe("completed");
      expect(await existingUsers([shared, otherOnly, unrelated, formerMember, formerAdmin]))
        .toEqual([shared, otherOnly, unrelated].sort());
      // The target owner, the former member and the former admin.
      expect(receipt.rowCounts.orphaned_users).toBe(3);
      expect(await tenantRows(other)).toEqual(otherBefore);
      expect(otherBefore).toMatchObject({ tenant_memberships: 3, sessions: 1, audit_events: 1 });
    });

    // A sign-in that adds a candidate user to another tenant while the
    // deletion runs. Its foreign-key check holds FOR KEY SHARE on the users
    // row until it commits.
    test("waits for a concurrent reference to a candidate user, then keeps the user and the reference", async () => {
      const target = await seedTenantWithOwner();
      const other = await seedTenantWithOwner();
      const joining = await seedUser();
      await seedMembership(target, joining);

      const writer = await superuserPool().connect();
      let running: Promise<unknown> | undefined;
      try {
        await writer.query("BEGIN");
        const pid = Number((await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        await writer.query(
          `INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1, $2, 'member')`,
          [other, joining]
        );
        running = deletionService().execute(deletion(target));
        running.catch(() => undefined);
        await vi.waitFor(async () => {
          const waiting = await superuserPool().query<{ count: number }>(
            `SELECT count(*)::int AS count FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
            [pid]
          );
          expect(waiting.rows[0]!.count).toBeGreaterThan(0);
        }, { timeout: 10_000 });
        await writer.query("COMMIT");
        await expect(running).resolves.toMatchObject({ status: "completed" });
      } finally {
        await writer.query("ROLLBACK").catch(() => undefined);
        writer.release();
        await Promise.allSettled([running]);
      }

      expect(await existingUsers([joining])).toEqual([joining]);
      const membership = await superuserPool().query(
        `SELECT 1 FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2`,
        [other, joining]
      );
      expect(membership.rowCount).toBe(1);
    });
  });
});
