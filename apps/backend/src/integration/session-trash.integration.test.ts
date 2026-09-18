import { describe, expect, test, vi } from "vitest";

import { withTenantScope } from "../lib/db.js";
import { SessionStore } from "../services/session-store.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import {
  seedArtifact,
  seedDownloadToken,
  seedMessage,
  seedRuntimeSession,
  seedSession,
  seedTenant,
  seedUser,
} from "./support/fixtures.js";

describe.skipIf(!adminDatabaseUrl())("session Trash retention", () => {
  test("expires a session in FK-safe order, preserves shared objects, and enforces GC RLS", async () => {
    const tenant = await seedTenant();
    const otherTenant = await seedTenant();
    const user = await seedUser();
    const otherUser = await seedUser();
    const sessionId = await seedSession(tenant, user);
    const otherSessionId = await seedSession(otherTenant, otherUser);
    const messageId = await seedMessage(tenant, user, sessionId);
    const runtimeId = await seedRuntimeSession(tenant, user, sessionId);
    const artifactId = await seedArtifact(tenant, user, sessionId);
    await seedDownloadToken({ tenantId: tenant, userId: user, sessionId, artifactId });
    const otherArtifactId = await seedArtifact(otherTenant, otherUser, otherSessionId);
    const storageKey = `${tenant}/${artifactId}`;
    await superuserPool().query("UPDATE artifacts SET storage_key=$1 WHERE artifact_id=$2", [storageKey, artifactId]);
    await superuserPool().query("UPDATE artifacts SET storage_key=$1 WHERE artifact_id=$2", [storageKey, otherArtifactId]);

    const store = new SessionStore(appPool(), superuserPool());
    expect(await store.remove(tenant, sessionId, user)).toBe(true);
    expect(await store.list(tenant, user, { status: "deleted" })).toHaveLength(1);
    expect(await store.list(otherTenant, otherUser, { status: "deleted" })).toEqual([]);
    await superuserPool().query(
      "UPDATE sessions SET deleted_at=NOW() - INTERVAL '31 days' WHERE session_id=$1",
      [sessionId],
    );

    const storageDelete = vi.fn(async () => undefined);
    const purgeRuntime = vi.fn(async () => undefined);
    const result = await store.cleanupExpired({ delete: storageDelete }, { purgeRuntime });

    expect(result).toMatchObject({ deletedSessions: 1, deletedObjects: 0, purgedRuntimes: 1 });
    expect(purgeRuntime).toHaveBeenCalledWith({ tenantId: tenant, sessionId, userId: user });
    expect(storageDelete).not.toHaveBeenCalled();
    expect((await superuserPool().query("SELECT 1 FROM sessions WHERE session_id=$1", [sessionId])).rowCount).toBe(0);
    expect((await superuserPool().query("SELECT 1 FROM messages WHERE message_id=$1", [messageId])).rowCount).toBe(0);
    expect((await superuserPool().query("SELECT 1 FROM runtime_sessions WHERE runtime_id=$1", [runtimeId])).rowCount).toBe(0);
    expect((await superuserPool().query("SELECT 1 FROM artifacts WHERE artifact_id=$1", [artifactId])).rowCount).toBe(0);
    expect((await superuserPool().query("SELECT 1 FROM artifact_download_tokens WHERE session_id=$1", [sessionId])).rowCount).toBe(0);
    expect((await superuserPool().query("SELECT 1 FROM artifacts WHERE artifact_id=$1 AND storage_key=$2", [otherArtifactId, storageKey])).rowCount).toBe(1);
    expect((await superuserPool().query("SELECT 1 FROM session_storage_gc WHERE session_id=$1", [sessionId])).rowCount).toBe(0);
    expect((await superuserPool().query("SELECT 1 FROM session_runtime_gc WHERE session_id=$1", [sessionId])).rowCount).toBe(0);
    expect(await store.restoreDeleted(tenant, sessionId, user)).toBeNull();

    await superuserPool().query(
      `INSERT INTO session_storage_gc (tenant_id, session_id, storage_key)
       VALUES ($1, $2, $3)`,
      [otherTenant, otherSessionId, "tenant-b/gc-key"],
    );
    await superuserPool().query(
      `INSERT INTO session_runtime_gc (tenant_id, session_id, user_id)
       VALUES ($1, $2, $3)`,
      [otherTenant, otherSessionId, otherUser],
    );
    const hiddenStorageRows = await withTenantScope(appPool(), tenant, (db) =>
      db.query("SELECT session_id FROM session_storage_gc WHERE tenant_id=$1", [otherTenant]));
    expect(hiddenStorageRows.rows).toEqual([]);
    const hiddenRuntimeRows = await withTenantScope(appPool(), tenant, (db) =>
      db.query("SELECT session_id FROM session_runtime_gc WHERE tenant_id=$1", [otherTenant]));
    expect(hiddenRuntimeRows.rows).toEqual([]);
    await superuserPool().query("DELETE FROM session_storage_gc WHERE tenant_id=$1 AND session_id=$2", [otherTenant, otherSessionId]);
    await superuserPool().query("DELETE FROM session_runtime_gc WHERE tenant_id=$1 AND session_id=$2", [otherTenant, otherSessionId]);
  });

  test("restores an archived session to its archived state", async () => {
    const tenant = await seedTenant();
    const user = await seedUser();
    const sessionId = await seedSession(tenant, user);
    const store = new SessionStore(appPool(), superuserPool());

    expect((await store.setArchived(tenant, sessionId, user, true))?.status).toBe("archived");
    expect(await store.remove(tenant, sessionId, user)).toBe(true);
    expect((await store.restoreDeleted(tenant, sessionId, user))?.status).toBe("archived");
  });
});
