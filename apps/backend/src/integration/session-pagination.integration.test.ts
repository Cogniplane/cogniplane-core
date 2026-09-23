import { describe, expect, test } from "vitest";
import { SessionStore, SessionListCursorSchema } from "../services/session-store.js";
import { ProjectStore } from "../services/project-store.js";
import { ProjectMemberStore } from "../services/project-member-store.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedTenant, seedUser, seedSession, seedMembership } from "./support/fixtures.js";

const decode = (value: string) => SessionListCursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString()));

describe.skipIf(!adminDatabaseUrl())("session pagination", () => {
  test("walks microsecond and equal timestamps without losing rows, even after the cursor row is deleted", async () => {
    const tenant = await seedTenant(), user = await seedUser();
    const store = new SessionStore(appPool());
    const ids: string[] = [];
    for (const fraction of ["123001", "123002", "123002", "123003", "123004", "123005"]) {
      const id = await seedSession(tenant, user);
      ids.push(id);
      await superuserPool().query("UPDATE sessions SET updated_at=$2 WHERE session_id=$1", [id, `2026-09-21T00:00:00.${fraction}Z`]);
    }
    const expected = (await superuserPool().query("SELECT session_id FROM sessions WHERE tenant_id=$1 ORDER BY updated_at DESC, session_id DESC", [tenant])).rows.map((row) => row.session_id);
    const first = await store.listPage(tenant, user, { limit: 2 });
    expect(first.sessions.map((row) => row.sessionId)).toEqual(expected.slice(0, 2));
    expect(decode(first.nextCursor!).updatedAt).toBe("2026-09-21T00:00:00.123004Z");
    await superuserPool().query("DELETE FROM sessions WHERE session_id=$1", [first.sessions[1].sessionId]);
    const second = await store.listPage(tenant, user, { limit: 2, cursor: decode(first.nextCursor!) });
    const third = await store.listPage(tenant, user, { limit: 2, cursor: decode(second.nextCursor!) });
    expect([...first.sessions, ...second.sessions, ...third.sessions].map((row) => row.sessionId)).toEqual(expected);
    expect(third.nextCursor).toBeNull();
    expect(new Set(expected).size).toBe(ids.length);
  });

  test("bounds default pages and searches or resolves older IDs without crossing tenants, owners or lifecycle filters", async () => {
    const tenant = await seedTenant(), foreignTenant = await seedTenant();
    const user = await seedUser(), other = await seedUser();
    const store = new SessionStore(appPool());
    for (let index = 0; index < 53; index++) await seedSession(tenant, user);
    const old = await seedSession(tenant, user);
    const archived = await seedSession(tenant, user);
    const deleted = await seedSession(tenant, user);
    const special = await seedSession(tenant, user);
    const otherOwned = await seedSession(tenant, other);
    const foreign = await seedSession(foreignTenant, user);
    await superuserPool().query("UPDATE sessions SET session_name='Older 100%_notes', updated_at='2020-01-01' WHERE session_id=ANY($1::text[])", [[old, archived, deleted, special, otherOwned, foreign]]);
    await superuserPool().query("UPDATE sessions SET status='archived' WHERE session_id=$1", [archived]);
    await superuserPool().query("UPDATE sessions SET status='deleted' WHERE session_id=$1", [deleted]);
    await superuserPool().query("UPDATE sessions SET purpose='scheduled' WHERE session_id=$1", [special]);
    const first = await store.listPage(tenant, user);
    expect(first.sessions).toHaveLength(50);
    expect(first.sessions.map((row) => row.sessionId)).not.toContain(old);
    expect((await store.listPage(tenant, user, { search: "100%_NOTES" })).sessions.map((row) => row.sessionId)).toEqual([old]);
    expect((await store.listPage(tenant, user, { ids: [old, archived, deleted, special, otherOwned, foreign] })).sessions.map((row) => row.sessionId)).toEqual([old]);
    expect((await store.listPage(tenant, user, { status: "archived", search: "%_" })).sessions.map((row) => row.sessionId)).toEqual([archived]);
    expect((await store.listPage(tenant, user, { purposes: "all", ids: [special] })).sessions.map((row) => row.sessionId)).toEqual([special]);
    expect((await store.listPage(foreignTenant, user, { ids: [old] })).sessions).toEqual([]);
  });

  test("searches shared project names, restricts the personal picker and rechecks membership for saved IDs", async () => {
    const tenant = await seedTenant(), owner = await seedUser(), viewer = await seedUser();
    await seedMembership(tenant, owner); await seedMembership(tenant, viewer);
    const projects = new ProjectStore(appPool());
    const members = new ProjectMemberStore(appPool());
    const project = await projects.create(tenant, owner, "Legacy research");
    const actor = { tenantId: tenant, userId: owner, projectId: project.projectId };
    await members.setMember(actor, viewer, "viewer");
    const id = (await projects.createSession(tenant, owner, project.projectId, "Old conversation"))!;
    const store = new SessionStore(appPool());
    expect((await store.listPage(tenant, viewer, { search: "legacy" })).sessions).toMatchObject([{ sessionId: id, canEdit: false }]);
    expect((await store.listPage(tenant, viewer, { personalOnly: true })).sessions).toEqual([]);
    expect((await store.listPage(tenant, viewer, { ids: [id] })).sessions).toHaveLength(1);
    await members.setMember(actor, viewer, null);
    expect((await store.listPage(tenant, viewer, { ids: [id] })).sessions).toEqual([]);
  });
});
