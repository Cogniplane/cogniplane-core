// A member removal lasts (services/tenant-member-removal.ts). Real Postgres,
// the production removal route, WorkOS provisioning, the refresh route on the
// maintenance pool, and ToolExecutionContextStore on the application pool.
//
// - The removal deletes the member's project roles and records the removal.
//   A later WorkOS sign-in is refused, whatever role WorkOS sends.
// - A refresh family that started before the removal is refused, also after a
//   later change adds the membership again.
// - Every tool context of the member stops in the commit of the removal, also
//   a scheduled context of a WorkOS member, which has no execution and no
//   security version. Contexts of other members, and of the same person in
//   another tenant, go on.
// - Migration 091 records the removals from before the upgrade, from their
//   audit events, and the deferred file repeats that after the rollout.
// - The deferred file and a WorkOS sign-in that overlap run one at a time on
//   the tenant's membership lock: the file never records a removal between
//   the sign-in's removal check and its membership INSERT.

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import type pg from "pg";
import { describe, expect, test } from "vitest";

import { signRefreshToken } from "../lib/jwt.js";
import { prepareSession, registerSessionRoutes } from "../routes/auth-session.js";
import { registerTenantRoutes } from "../routes/tenant.js";
import { RefreshTokenRotationService } from "../services/auth/refresh-token-rotation-service.js";
import { ToolContextUnavailableError, ToolExecutionContextStore } from "../services/auth/tool-execution-context-store.js";
import { provisionTenantIdentity } from "../services/auth/workos-tenant-provisioning.js";
import { ProjectMemberStore } from "../services/project-member-store.js";
import { ProjectStore } from "../services/project-store.js";
import { MemberRemovedError } from "../services/tenant-member-removal.js";
import { TenantOrgSettingsStore } from "../services/tenant-org-settings-store.js";
import { devDataRoutes } from "../test-helpers/data-routes.js";
import { FakeRefreshTokenRedis } from "../test-helpers/fake-refresh-token-redis.js";
import { InMemoryAuditEventStore } from "../test-helpers/in-memory-audit-events.js";
import { IGNORE_SECURITY_CHANGE } from "../test-helpers/security-change.js";
import { createTestConfig } from "../test-helpers/test-config.js";
import { adminDatabaseUrl, appPool, maintenancePool, superuserPool } from "./support/database.js";
import { seedRuntimeSession, seedSession } from "./support/fixtures.js";
import { withStagedDatabase } from "./support/staged-migrations.js";

const CONFIG = createTestConfig({ AUTH_MODE: "jwt", AUTH_LOGIN_TYPES: ["workos"] });
const SECRET = "member-removal-integration-secret-32-chars";

type Person = { workosUserId: string; email: string };
type Member = { tenantId: string; userId: string };

const person = (): Person => ({ workosUserId: `user_${randomUUID()}`, email: `${randomUUID()}@example.test` });

function signIn(organizationId: string, who: Person, workosRoleSlug: string | null = "member") {
  return provisionTenantIdentity(maintenancePool(), {
    organizationId, organizationName: "Removal Org", workosUserId: who.workosUserId, email: who.email,
    displayName: "Test", workosRoleSlug
  });
}

/** A WorkOS tenant with its owner. */
async function workosTenant() {
  const organizationId = `org_${randomUUID()}`;
  const owner = await signIn(organizationId, person());
  expect(owner.role).toBe("owner");
  return { organizationId, tenantId: owner.tenantId, ownerId: owner.userId };
}

/** DELETE /tenant/members/:userId as the tenant's owner, in a WorkOS session. */
async function removeAsOwner(tenant: { tenantId: string; ownerId: string }, userId: string) {
  const app = Fastify();
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: tenant.ownerId, tenantId: tenant.tenantId, role: "owner", isAdmin: true,
      session: { authSource: "workos", familyId: "owner-family" }
    };
  });
  await registerTenantRoutes(app, {
    dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE, db: appPool(),
    tenantOrgSettings: new TenantOrgSettingsStore(appPool(), SECRET)
  });
  await app.ready();
  try {
    const response = await app.inject({ method: "DELETE", url: `/tenant/members/${userId}` });
    expect(response.statusCode, response.body).toBe(200);
  } finally {
    await app.close();
  }
}

async function count(sql: string, values: unknown[]): Promise<number> {
  return Number((await superuserPool().query<{ n: string }>(sql, values)).rows[0]!.n);
}

describe.skipIf(!adminDatabaseUrl())("member removal lasts", () => {
  test("removes the member's project roles, records the removal, and refuses the next WorkOS sign-in", async () => {
    const tenant = await workosTenant();
    const removed = person();
    const admin = await signIn(tenant.organizationId, removed, "admin");
    expect(admin.role).toBe("admin");

    // The admin owns a private project and edits one of the owner's projects.
    const projects = new ProjectStore(appPool());
    const own = await projects.create(tenant.tenantId, admin.userId, "Admin's project");
    const shared = await projects.create(tenant.tenantId, tenant.ownerId, "Owner's project");
    await new ProjectMemberStore(appPool()).setMember(
      { tenantId: tenant.tenantId, userId: tenant.ownerId, projectId: shared.projectId }, admin.userId, "editor");

    await removeAsOwner(tenant, admin.userId);

    expect(await count(`SELECT count(*) AS n FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2`,
      [tenant.tenantId, admin.userId])).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM project_memberships WHERE tenant_id = $1 AND user_id = $2`,
      [tenant.tenantId, admin.userId])).toBe(0);
    const removal = await superuserPool().query(
      `SELECT removed_by FROM tenant_member_removals WHERE tenant_id = $1 AND user_id = $2`, [tenant.tenantId, admin.userId]);
    expect(removal.rows).toEqual([{ removed_by: tenant.ownerId }]);
    const audit = await superuserPool().query(
      `SELECT payload FROM audit_events WHERE tenant_id = $1 AND event_type = 'tenant.member.removed'`, [tenant.tenantId]);
    expect(audit.rows.map((row) => row.payload)).toEqual([
      { targetUserId: admin.userId, previousRole: "admin", projectRolesRemoved: 2 }
    ]);
    // The project lost its only owner; an owner or admin can give it a new one.
    expect(await new ProjectMemberStore(appPool()).listOwnerless(tenant.tenantId, tenant.ownerId))
      .toEqual([{ projectId: own.projectId, name: "Admin's project" }]);

    // WorkOS still names the person an admin of the organization.
    await expect(signIn(tenant.organizationId, removed, "admin")).rejects.toBeInstanceOf(MemberRemovedError);
    expect(await count(`SELECT count(*) AS n FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2`,
      [tenant.tenantId, admin.userId])).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM project_memberships WHERE tenant_id = $1 AND user_id = $2`,
      [tenant.tenantId, admin.userId])).toBe(0);
  });

  test("refuses each refresh family that started before the removal, also when the membership exists again", async () => {
    const tenant = await workosTenant();
    const member = await signIn(tenant.organizationId, person());
    const redis = new FakeRefreshTokenRedis();
    const refreshTokens = new RefreshTokenRotationService(redis, 60);
    const app = Fastify();
    await app.register(cookie);
    await registerSessionRoutes(app, {
      db: maintenancePool(), config: CONFIG, auditEvents: new InMemoryAuditEventStore() as never, refreshTokens
    });
    const refresh = (refreshToken: string) => app.inject({
      method: "POST", url: "/auth/refresh", headers: { origin: CONFIG.API_ORIGIN }, cookies: { cogniplane_refresh: refreshToken }
    });
    const identity = { userId: member.userId, tenantId: member.tenantId, role: member.role, email: "m@example.test", amr: ["workos" as const] };
    const familyOf = (refreshToken: string) => JSON.parse(Buffer.from(refreshToken.split(".")[1]!, "base64url").toString()).fid as string;

    try {
      const used = await prepareSession(CONFIG, refreshTokens, identity);
      const unused = await prepareSession(CONFIG, refreshTokens, identity);
      const kept = await prepareSession(CONFIG, refreshTokens, identity);
      expect((await refresh(used.refreshToken)).statusCode).toBe(200);

      await removeAsOwner(tenant, member.userId);

      // No membership: the refresh is refused and its family revoked.
      const refused = await refresh(unused.refreshToken);
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toEqual({ error: "not_a_member" });
      expect(await refreshTokens.isActive(familyOf(unused.refreshToken))).toBe(false);

      // A later change adds the membership again. Re-admission is not a
      // feature; this stands for one. The family from before the removal
      // stays refused.
      await superuserPool().query(
        `INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1, $2, 'member')`, [member.tenantId, member.userId]);
      const old = await refresh(kept.refreshToken);
      expect(old.statusCode).toBe(403);
      expect(old.json()).toEqual({ error: "session_revoked" });
      expect(await refreshTokens.isActive(familyOf(kept.refreshToken))).toBe(false);

      // A session that started after the removal is admitted.
      const removedAt = Number((await superuserPool().query<{ at: number }>(
        `SELECT EXTRACT(EPOCH FROM removed_at)::float8 AS at FROM tenant_member_removals WHERE tenant_id = $1 AND user_id = $2`,
        [member.tenantId, member.userId])).rows[0]!.at);
      const jti = randomUUID();
      const familyId = randomUUID();
      await refreshTokens.issue({ jti, familyId });
      const later = await signRefreshToken(CONFIG, {
        sub: member.userId, tid: member.tenantId, jti, fid: familyId, amr: ["workos"], auth_time: Math.floor(removedAt) + 1
      });
      expect((await refresh(later)).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  test("stops every tool context of the removed member, scheduled ones included, and only in that tenant", async () => {
    const tenant = await workosTenant();
    const removed = person();
    const member = await signIn(tenant.organizationId, removed);
    const colleague = await signIn(tenant.organizationId, person());
    // The same WorkOS person is also a member of another organization.
    const elsewhere = await workosTenant();
    const sameElsewhere = await signIn(elsewhere.organizationId, removed);
    expect(sameElsewhere.userId).toBe(member.userId);

    const contexts = new ToolExecutionContextStore(appPool());
    // A scheduled turn: a normal chat with no execution, and no security
    // version (WorkOS owner). Before this fix, only the TTL ended it.
    const scheduledContext = async (owner: Member) => {
      const sessionId = await seedSession(owner.tenantId, owner.userId);
      const runtimeId = await seedRuntimeSession(owner.tenantId, owner.userId, sessionId);
      const context = await contexts.create({
        tenantId: owner.tenantId, sessionId, userId: owner.userId, runtimeId, runtimePolicyId: "removal-test",
        messageId: null, metadata: { turnContext: "scheduled" }, ownerSecurityVersion: null, ttlMs: 300_000
      });
      return { ...owner, sessionId, toolContextId: context.toolContextId };
    };
    const target = await scheduledContext(member);
    const other = await scheduledContext(colleague);
    const away = await scheduledContext(sameElsewhere);

    const state = async (c: Member & { sessionId: string; toolContextId: string }) => ({
      get: (await contexts.get(c.tenantId, c.toolContextId))?.toolContextId ?? null,
      liveness: await contexts.liveness(c.tenantId, c.toolContextId),
      extended: (await contexts.extend(c.tenantId, c.toolContextId, 300_000)) !== null,
      latest: (await contexts.findLatestActiveBySession(c.tenantId, c.sessionId))?.toolContextId ?? null
    });
    const live = (c: { toolContextId: string }) => ({ get: c.toolContextId, liveness: "live", extended: true, latest: c.toolContextId });

    for (const c of [target, other, away]) expect(await state(c)).toEqual(live(c));

    await removeAsOwner(tenant, member.userId);

    expect(await state(target)).toEqual({ get: null, liveness: "security_change", extended: false, latest: null });
    await expect(contexts.requireOwned(target.tenantId, target.toolContextId, target.userId))
      .rejects.toBeInstanceOf(ToolContextUnavailableError);
    expect(await state(other)).toEqual(live(other));
    expect(await state(away)).toEqual(live(away));
    // A context is read only in its own tenant.
    expect(await contexts.get(elsewhere.tenantId, target.toolContextId)).toBeNull();
    expect(await contexts.liveness(tenant.tenantId, away.toolContextId)).toBe("ended");
  });
});

const DEFERRED_RECORD_REMOVALS = new URL("../../db/deferred/record-member-removals.sql", import.meta.url);

/** Rows written with SQL, as the earlier release left them, on a staged database. */
function earlierRelease(db: pg.Pool) {
  return {
    async tenant() {
      const tenantId = randomUUID();
      const organizationId = `org_${randomUUID()}`;
      await db.query(`INSERT INTO tenants (tenant_id, tenant_name, slug, workos_org_id) VALUES ($1, 'Upgrade', $2, $3)`,
        [tenantId, organizationId.toLowerCase(), organizationId]);
      return { tenantId, organizationId };
    },
    async user() {
      const who = person();
      const userId = randomUUID();
      await db.query(`INSERT INTO users (user_id, email, display_name, workos_user_id) VALUES ($1, $2, 'Test', $3)`,
        [userId, who.email, who.workosUserId]);
      return { ...who, userId };
    },
    /** `since` is an SQL interval before now. */
    async member(tenantId: string, userId: string, role: "owner" | "admin" | "member", since: string) {
      await db.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at) VALUES ($1, $2, $3, NOW() - $4::interval)`,
        [tenantId, userId, role, since]);
    },
    /** An audit event `age` before now. Returns its time, in seconds since the epoch. */
    async event(tenantId: string, actorId: string | null, payload: unknown, age: string, type = "tenant.member.removed") {
      const result = await db.query<{ at: number }>(
        `INSERT INTO audit_events (tenant_id, user_id, event_type, payload, created_at)
         VALUES ($1, $2, $3, $4::jsonb, NOW() - $5::interval)
         RETURNING EXTRACT(EPOCH FROM created_at)::float8 AS at`,
        [tenantId, actorId, type, JSON.stringify(payload), age]);
      return result.rows[0]!.at;
    }
  };
}

function byKey<T extends { tenant_id: string; user_id: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => `${a.tenant_id}:${a.user_id}`.localeCompare(`${b.tenant_id}:${b.user_id}`));
}

async function removalRows(db: pg.Pool) {
  const result = await db.query<{ tenant_id: string; user_id: string; removed_by: string | null; removed_at: number }>(
    `SELECT tenant_id, user_id, removed_by, EXTRACT(EPOCH FROM removed_at)::float8 AS removed_at FROM tenant_member_removals`);
  return byKey(result.rows);
}

async function roleIn(db: pg.Pool, tenantId: string, userId: string): Promise<string | null> {
  const result = await db.query(`SELECT role FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId]);
  return result.rows[0]?.role ?? null;
}

function signInTo(db: pg.Pool, organizationId: string, who: Person, workosRoleSlug = "member") {
  return provisionTenantIdentity(db, {
    organizationId, organizationName: "Upgrade", workosUserId: who.workosUserId, email: who.email, displayName: "Test", workosRoleSlug
  });
}

/** Runs the deferred file. Returns the user ids that it lists, sorted. */
async function runDeferred(db: pg.Pool): Promise<string[]> {
  const deferred = await readFile(DEFERRED_RECORD_REMOVALS, "utf8");
  const results = (await db.query(deferred)) as unknown as pg.QueryResult[];
  const list = results.find((result) => result.command === "SELECT");
  return (list?.rows ?? []).map((row) => row.user_id as string).sort();
}

/**
 * The deferred file in pg_stat_activity. Postgres keeps only the first
 * kilobyte of a statement (track_activity_query_size), which is the file's
 * header, so match its first line.
 */
const DEFERRED_FILE_STATEMENT = "-- Run once, after every backend runs the release with migration 091%";

/** The type of the lock that the session waits for, if any. */
async function awaitedLock(pid: number): Promise<string | undefined> {
  const result = await superuserPool().query<{ locktype: string }>(
    `SELECT locktype FROM pg_locks WHERE pid = $1 AND NOT granted`, [pid]);
  return result.rows[0]?.locktype;
}

async function pidOf(client: pg.PoolClient): Promise<number> {
  return (await client.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid;
}

/**
 * The pid of a session that waits for a lock of `holderPid`, on a statement
 * that matches `statement` (ILIKE). Waits until there is one. Reads
 * pg_stat_activity on the suite's superuser pool, which sees the sessions of
 * every database, so it takes no connection of the staged pool.
 */
async function waiterOn(holderPid: number, statement: string): Promise<number> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const waiting = await superuserPool().query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) AND query ILIKE $2`, [holderPid, statement]);
    if (waiting.rows[0]) return waiting.rows[0].pid;
    if (Date.now() > deadline) throw new Error(`No statement like '${statement}' waited for session ${holderPid}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Rolls back the gate's transaction and returns its connection, then waits
 * for the statements that waited for it. A failed step leaves no open
 * transaction and no waiting statement for the next test. A connection whose
 * ROLLBACK failed is destroyed.
 */
async function openGate(gate: pg.PoolClient, settled: Promise<unknown>): Promise<void> {
  let rollbackError: Error | undefined;
  try {
    await gate.query("ROLLBACK");
  } catch (error) {
    rollbackError = error as Error;
    throw error;
  } finally {
    gate.release(rollbackError);
    await settled;
  }
}

/**
 * A staged database after migration 091, where a backend of the earlier
 * release removed `late` during the rollout: an audit event, no membership,
 * no removal row.
 */
async function removedDuringRollout(db: pg.Pool, migrate: (include: (file: string) => boolean) => Promise<void>) {
  await migrate((file) => Number.parseInt(file, 10) <= 90);
  const old = earlierRelease(db);
  const a = await old.tenant();
  const owner = await old.user();
  const late = await old.user();
  await old.member(a.tenantId, owner.userId, "owner", "4 days");
  await old.member(a.tenantId, late.userId, "member", "4 days");
  await migrate((file) => Number.parseInt(file, 10) === 91);
  await db.query(`DELETE FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2`, [a.tenantId, late.userId]);
  const removedAt = await old.event(a.tenantId, owner.userId, { targetUserId: late.userId, previousRole: "member" }, "1 minute");
  expect(await removalRows(db)).toEqual([]);
  return { a, owner, late, removedAt };
}

describe.skipIf(!adminDatabaseUrl())("migration 091: removals from before the upgrade", () => {
  test("records each removed user with no membership, at the latest removal, and keeps current memberships", async () => {
    await withStagedDatabase(async ({ db, migrate }) => {
      await migrate((file) => Number.parseInt(file, 10) <= 90);
      const old = earlierRelease(db);
      const a = await old.tenant();
      const b = await old.tenant();
      const owner = await old.user();
      const admin = await old.user();
      // Removed twice from A (a WorkOS sign-in added the user back in
      // between), and now a member of B.
      const gone = await old.user();
      // Removed from A, then added back by a WorkOS sign-in.
      const back = await old.user();
      // Removed from A by a user that no longer exists (the audit FK set the actor to NULL).
      const actorless = await old.user();
      // Not a member of A, with an event of another type only.
      const other = await old.user();
      await old.member(a.tenantId, owner.userId, "owner", "4 days");
      await old.member(a.tenantId, admin.userId, "admin", "4 days");
      await old.member(a.tenantId, back.userId, "admin", "1 day");
      await old.member(b.tenantId, gone.userId, "member", "1 day");

      const firstRemoval = await old.event(a.tenantId, owner.userId, { targetUserId: gone.userId, previousRole: "member" }, "3 days");
      const latestRemoval = await old.event(a.tenantId, admin.userId, { targetUserId: gone.userId, previousRole: "admin" }, "1 hour");
      await old.event(a.tenantId, owner.userId, { targetUserId: back.userId, previousRole: "admin" }, "2 days");
      const actorlessRemoval = await old.event(a.tenantId, null, { targetUserId: actorless.userId, previousRole: "member" }, "5 hours");
      await old.event(b.tenantId, null, { targetUserId: gone.userId, previousRole: "member" }, "2 days");
      await old.event(a.tenantId, owner.userId, { targetUserId: other.userId, previousRole: "member", role: "admin" }, "1 hour",
        "tenant.member.role_changed");
      // Payloads that name no user that exists. The migration skips them.
      for (const payload of [{}, { targetUserId: 42 }, { targetUserId: { id: other.userId } }, { targetUserId: "" },
        { targetUserId: randomUUID() }, "text", [other.userId], null]) {
        await old.event(a.tenantId, owner.userId, payload, "1 hour");
      }

      await migrate((file) => Number.parseInt(file, 10) === 91);

      expect(await removalRows(db)).toEqual(byKey([
        { tenant_id: a.tenantId, user_id: gone.userId, removed_by: admin.userId, removed_at: latestRemoval },
        { tenant_id: a.tenantId, user_id: actorless.userId, removed_by: null, removed_at: actorlessRemoval }
      ]));
      // Current memberships stay, with their roles.
      expect(await roleIn(db, a.tenantId, back.userId)).toBe("admin");
      expect(await roleIn(db, b.tenantId, gone.userId)).toBe("member");

      // WorkOS sign-in, on the new release.
      await expect(signInTo(db, a.organizationId, gone, "admin")).rejects.toBeInstanceOf(MemberRemovedError);
      await expect(signInTo(db, a.organizationId, actorless)).rejects.toBeInstanceOf(MemberRemovedError);
      expect(await roleIn(db, a.tenantId, gone.userId)).toBeNull();
      expect(await roleIn(db, a.tenantId, actorless.userId)).toBeNull();
      expect(await signInTo(db, b.organizationId, gone)).toMatchObject({ tenantId: b.tenantId, role: "member", previousRole: "member" });
      expect(await signInTo(db, a.organizationId, back)).toMatchObject({ role: "admin", previousRole: "admin" });
      expect(await signInTo(db, a.organizationId, other)).toMatchObject({ role: "member", previousRole: undefined });

      // Refresh families from before the latest removal stay refused, also
      // when the membership exists again.
      const redis = new FakeRefreshTokenRedis();
      const refreshTokens = new RefreshTokenRotationService(redis, 60);
      const app = Fastify();
      await app.register(cookie);
      await registerSessionRoutes(app, { db, config: CONFIG, auditEvents: new InMemoryAuditEventStore() as never, refreshTokens });
      const refreshFrom = async (authTime: number) => {
        const jti = randomUUID();
        const familyId = randomUUID();
        await refreshTokens.issue({ jti, familyId });
        const token = await signRefreshToken(CONFIG, {
          sub: gone.userId, tid: a.tenantId, jti, fid: familyId, amr: ["workos"], auth_time: Math.floor(authTime)
        });
        const response = await app.inject({
          method: "POST", url: "/auth/refresh", headers: { origin: CONFIG.API_ORIGIN }, cookies: { cogniplane_refresh: token }
        });
        return { status: response.statusCode, error: response.statusCode === 200 ? undefined : response.json().error };
      };
      try {
        expect(await refreshFrom(firstRemoval - 60)).toEqual({ status: 403, error: "not_a_member" });
        // Re-admission is not a feature; this stands for one.
        await db.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1, $2, 'member')`, [a.tenantId, gone.userId]);
        expect(await refreshFrom(firstRemoval - 60)).toEqual({ status: 403, error: "session_revoked" });
        // After the first removal, before the latest one.
        expect(await refreshFrom(firstRemoval + 60)).toEqual({ status: 403, error: "session_revoked" });
        expect(await refreshFrom(latestRemoval + 1)).toEqual({ status: 200, error: undefined });
      } finally {
        await app.close();
      }
    });
  });

  test("the deferred file records removals by backends of the earlier release, and lists members who came back", async () => {
    await withStagedDatabase(async ({ db, migrate }) => {
      await migrate((file) => Number.parseInt(file, 10) <= 90);
      const old = earlierRelease(db);
      const a = await old.tenant();
      const owner = await old.user();
      const gone = await old.user();
      const back = await old.user();
      const late = await old.user();
      await old.member(a.tenantId, owner.userId, "owner", "4 days");
      await old.member(a.tenantId, back.userId, "member", "1 day");
      await old.member(a.tenantId, late.userId, "member", "4 days");
      const goneRemoval = await old.event(a.tenantId, owner.userId, { targetUserId: gone.userId, previousRole: "member" }, "3 days");
      await old.event(a.tenantId, owner.userId, { targetUserId: back.userId, previousRole: "member" }, "2 days");

      await migrate((file) => Number.parseInt(file, 10) === 91);

      // During the rollout, a backend of the earlier release removes a member
      // without a row, and its WorkOS sign-in adds a removed user back.
      await db.query(`DELETE FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2`, [a.tenantId, late.userId]);
      const lateRemoval = await old.event(a.tenantId, owner.userId, { targetUserId: late.userId, previousRole: "member" }, "1 minute");
      await old.member(a.tenantId, gone.userId, "member", "0 seconds");

      expect(await runDeferred(db)).toEqual([gone.userId, back.userId].sort());
      // Safe to run again.
      expect(await runDeferred(db)).toEqual([gone.userId, back.userId].sort());

      expect(await removalRows(db)).toEqual(byKey([
        { tenant_id: a.tenantId, user_id: gone.userId, removed_by: owner.userId, removed_at: goneRemoval },
        { tenant_id: a.tenantId, user_id: late.userId, removed_by: owner.userId, removed_at: lateRemoval }
      ]));
      await expect(signInTo(db, a.organizationId, late)).rejects.toBeInstanceOf(MemberRemovedError);
      expect(await roleIn(db, a.tenantId, back.userId)).toBe("member");
    });
  });

  // The sign-in of the new release checks for a removal row, then inserts the
  // membership, under the tenant's membership lock. A file that recorded the
  // removal between those two steps would let the sign-in add the member,
  // with a session that starts after removed_at, which admission accepts.

  test("a WorkOS sign-in that holds the tenant's lock first keeps its membership; the deferred file waits and lists it", async () => {
    await withStagedDatabase(async ({ db, migrate }) => {
      const { a, late } = await removedDuringRollout(db, migrate);
      const gate = await db.connect();
      const started: Promise<unknown>[] = [];
      let signIn: Promise<unknown> | undefined;
      let file: Promise<unknown> | undefined;
      try {
        await gate.query("BEGIN");
        // An uncommitted row with the key of the sign-in's membership. The
        // sign-in passes its removal check, then waits at its membership
        // INSERT, with the tenant's lock held.
        await gate.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1, $2, 'member')`,
          [a.tenantId, late.userId]);
        signIn = signInTo(db, a.organizationId, late).then((identity) => identity.role, (error: unknown) => error);
        started.push(signIn);
        const signInPid = await waiterOn(await pidOf(gate), "%INSERT INTO tenant_memberships%");
        file = runDeferred(db).then((listed) => listed, (error: unknown) => error);
        started.push(file);
        const filePid = await waiterOn(signInPid, DEFERRED_FILE_STATEMENT);
        // The file waits for the sign-in's membership lock, while the
        // sign-in is between its check and its INSERT. It has recorded nothing.
        expect(await awaitedLock(filePid)).toBe("advisory");
        expect(await removalRows(db)).toEqual([]);
      } finally {
        await openGate(gate, Promise.allSettled(started));
      }
      expect(await signIn).toBe("member");
      // The membership stays, and the file lists it for the tenant to decide.
      expect(await file).toEqual([late.userId]);
      expect(await removalRows(db)).toEqual([]);
      expect(await roleIn(db, a.tenantId, late.userId)).toBe("member");
    });
  });

  test("a WorkOS sign-in that comes after the deferred file took the tenant's lock waits, finds the removal and is refused", async () => {
    await withStagedDatabase(async ({ db, migrate }) => {
      const { a, owner, late, removedAt } = await removedDuringRollout(db, migrate);
      const gate = await db.connect();
      const started: Promise<unknown>[] = [];
      let signIn: Promise<unknown> | undefined;
      let file: Promise<unknown> | undefined;
      try {
        await gate.query("BEGIN");
        // The foreign-key check of the file's INSERT waits for this row lock,
        // after the file took every tenant's lock.
        await gate.query(`SELECT 1 FROM users WHERE user_id = $1 FOR UPDATE`, [late.userId]);
        file = runDeferred(db).then((listed) => listed, (error: unknown) => error);
        started.push(file);
        const filePid = await waiterOn(await pidOf(gate), DEFERRED_FILE_STATEMENT);
        signIn = signInTo(db, a.organizationId, late).then((identity) => identity.role, (error: unknown) => error);
        started.push(signIn);
        const signInPid = await waiterOn(filePid, "%tenant_membership_changes%");
        expect(await awaitedLock(signInPid)).toBe("advisory");
      } finally {
        await openGate(gate, Promise.allSettled(started));
      }
      expect(await file).toEqual([]);
      expect(await removalRows(db)).toEqual([
        { tenant_id: a.tenantId, user_id: late.userId, removed_by: owner.userId, removed_at: removedAt }
      ]);
      expect(await signIn).toBeInstanceOf(MemberRemovedError);
      expect(await roleIn(db, a.tenantId, late.userId)).toBeNull();
    });
  });
});
