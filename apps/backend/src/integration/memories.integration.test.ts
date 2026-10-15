// Long-term memories against real Postgres (VULN-05).
//
// What the unit tests cannot show:
//   - migration 068: the provenance columns, their defaults and the CHECK that
//     stops a row from claiming an approval it has no record of;
//   - the compare-and-set that ties an approved overwrite to the text the user
//     was shown, including two writers racing for the same row;
//   - that a memory saved in one session is read in another session of the same
//     user, and by nobody else;
//   - tenant and user isolation of /me/memories (list, edit, delete) with RLS on.
//
// Rows that probe a boundary go in through the superuser pool, so a store bug
// cannot hide a missing row. The stores and routes under test use the
// unprivileged application pool, like production.

import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import { describe, expect, test } from "vitest";

import { registerMemoryRoutes } from "../routes/memories.js";
import { AuditEventStore } from "../services/audit-event-store.js";
import {
  MemoryConflictError,
  MemoryStore,
  memoryContentSha256,
  type AgentApprovedProvenance
} from "../services/memory-store.js";
import { loadWorkspaceMemories } from "../services/memory-workspace-section.js";
import { withTenantScope } from "../lib/db.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedAgentMemory, seedMembership, seedSession, seedTenant, seedUser } from "./support/fixtures.js";

async function seedPerson(tenantId: string): Promise<string> {
  const userId = await seedUser();
  await seedMembership(tenantId, userId, "member");
  return userId;
}

function approvedBy(userId: string, sessionId: string): AgentApprovedProvenance {
  return {
    sourceSessionId: sessionId,
    approvedByUserId: userId,
    approvalId: `polapr_${randomUUID()}`,
    approvedAt: new Date().toISOString()
  };
}

const slug = () => `fact-${randomUUID().slice(0, 8)}`;

async function memoryRow(tenantId: string, userId: string, name: string) {
  const result = await superuserPool().query(
    "SELECT * FROM agent_memories WHERE tenant_id = $1 AND user_id = $2 AND slug = $3",
    [tenantId, userId, name]
  );
  return result.rows[0] as Record<string, unknown> | undefined;
}

describe.skipIf(!adminDatabaseUrl())("memory provenance (migration 068)", () => {
  test("a row from before the migration reads as unverified and unversioned by an agent", async () => {
    const tenantId = await seedTenant();
    const userId = await seedPerson(tenantId);
    const name = await seedAgentMemory(tenantId, userId); // inserts with no provenance columns, like the old code

    const memory = await new MemoryStore(appPool()).get(tenantId, userId, name);

    expect(memory).toMatchObject({
      provenance: "unverified", version: 1, sourceSessionId: null, approvedAt: null
    });
  });

  test("a row cannot claim an approval that it has no record of", async () => {
    const tenantId = await seedTenant();
    const userId = await seedPerson(tenantId);
    const insert = (columns: Record<string, unknown>) => {
      const all = {
        memory_id: `memory_${randomUUID()}`, tenant_id: tenantId, user_id: userId, slug: slug(), content: "text",
        ...columns
      };
      const names = Object.keys(all);
      return superuserPool().query(
        `INSERT INTO agent_memories (${names.join(", ")}) VALUES (${names.map((_n, i) => `$${i + 1}`).join(", ")})`,
        Object.values(all)
      );
    };

    // Agent-approved with no approval id, no source session or no approver.
    await expect(insert({ provenance: "agent_approved", source_session_id: "s", approved_by_user_id: userId,
      approved_at: new Date() })).rejects.toMatchObject({ code: "23514" });
    await expect(insert({ provenance: "agent_approved", approval_id: "a", approved_by_user_id: userId,
      approved_at: new Date() })).rejects.toMatchObject({ code: "23514" });
    await expect(insert({ provenance: "agent_approved", source_session_id: "s", approval_id: "a",
      approved_at: new Date() })).rejects.toMatchObject({ code: "23514" });
    // Unverified rows carry no approval fields, and user-authored rows have no approval or session.
    await expect(insert({ provenance: "unverified", approval_id: "a" })).rejects.toMatchObject({ code: "23514" });
    await expect(insert({ provenance: "user_authored", approved_by_user_id: userId, approved_at: new Date(),
      approval_id: "a" })).rejects.toMatchObject({ code: "23514" });
    // A value outside the set.
    await expect(insert({ provenance: "approved_by_the_model" })).rejects.toMatchObject({ code: "23514" });
    // Complete rows are accepted.
    await insert({ provenance: "agent_approved", source_session_id: "s", approval_id: "a",
      approved_by_user_id: userId, approved_at: new Date() });
    await insert({ provenance: "user_authored", approved_by_user_id: userId, approved_at: new Date() });
  });
});

describe.skipIf(!adminDatabaseUrl())("approved saves and overwrites", () => {
  test("a save records who approved it, in which session, and bumps the version on overwrite", async () => {
    const tenantId = await seedTenant();
    const userId = await seedPerson(tenantId);
    const sessionId = await seedSession(tenantId, userId);
    const store = new MemoryStore(appPool());
    const name = slug();
    const first = approvedBy(userId, sessionId);

    const created = await store.save(tenantId, userId, {
      slug: name, content: "Prefers metric units.", metadata: { approved: true, approvedBy: "model" },
      provenance: first, expectedPreviousContentSha256: null
    });

    expect(created).toMatchObject({ version: 1, provenance: "agent_approved", sourceSessionId: sessionId });
    const row = await memoryRow(tenantId, userId, name);
    expect(row).toMatchObject({
      provenance: "agent_approved", source_session_id: sessionId, approved_by_user_id: userId,
      approval_id: first.approvalId, version: 1
    });
    // Whatever the model put in metadata stays plain data.
    expect(row!.metadata).toEqual({ approved: true, approvedBy: "model" });

    const second = approvedBy(userId, sessionId);
    const replaced = await store.save(tenantId, userId, {
      slug: name, content: "Prefers metric units and 24-hour time.", provenance: second,
      expectedPreviousContentSha256: memoryContentSha256("Prefers metric units.")
    });
    expect(replaced).toMatchObject({ version: 2, content: "Prefers metric units and 24-hour time." });
    expect(await memoryRow(tenantId, userId, name)).toMatchObject({ approval_id: second.approvalId, version: 2 });
  });

  test("an approved overwrite replaces only the text that the user was shown", async () => {
    const tenantId = await seedTenant();
    const userId = await seedPerson(tenantId);
    const sessionId = await seedSession(tenantId, userId);
    const store = new MemoryStore(appPool());
    const name = slug();
    await store.save(tenantId, userId, { slug: name, content: "Old text.", provenance: approvedBy(userId, sessionId) });

    // The approval showed "Old text." as the replaced text, but the row has changed since.
    await superuserPool().query("UPDATE agent_memories SET content = 'Edited by the user.' WHERE slug = $1 AND tenant_id = $2", [name, tenantId]);
    await expect(store.save(tenantId, userId, {
      slug: name, content: "New text.", provenance: approvedBy(userId, sessionId),
      expectedPreviousContentSha256: memoryContentSha256("Old text.")
    })).rejects.toBeInstanceOf(MemoryConflictError);
    expect(await memoryRow(tenantId, userId, name)).toMatchObject({ content: "Edited by the user.", version: 1 });

    // The approval showed no earlier text, but one exists now.
    await expect(store.save(tenantId, userId, {
      slug: name, content: "New text.", provenance: approvedBy(userId, sessionId), expectedPreviousContentSha256: null
    })).rejects.toBeInstanceOf(MemoryConflictError);

    // The approval showed a text, and the memory is gone.
    await superuserPool().query("DELETE FROM agent_memories WHERE slug = $1 AND tenant_id = $2", [name, tenantId]);
    await expect(store.save(tenantId, userId, {
      slug: name, content: "New text.", provenance: approvedBy(userId, sessionId),
      expectedPreviousContentSha256: memoryContentSha256("Edited by the user.")
    })).rejects.toBeInstanceOf(MemoryConflictError);
    expect(await memoryRow(tenantId, userId, name)).toBeUndefined();
  });

  test("two approved saves racing for one text: exactly one wins", async () => {
    const tenantId = await seedTenant();
    const userId = await seedPerson(tenantId);
    const sessionId = await seedSession(tenantId, userId);
    const store = new MemoryStore(appPool());
    const name = slug();
    await store.save(tenantId, userId, { slug: name, content: "Old text.", provenance: approvedBy(userId, sessionId) });
    const expected = memoryContentSha256("Old text.");

    const results = await Promise.allSettled(["A", "B", "C"].map((label) => store.save(tenantId, userId, {
      slug: name, content: `New text ${label}.`, provenance: approvedBy(userId, sessionId),
      expectedPreviousContentSha256: expected
    })));

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results.filter((entry) => entry.status === "rejected")) {
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(MemoryConflictError);
    }
    expect(await memoryRow(tenantId, userId, name)).toMatchObject({ version: 2 });
  });

  test("two approved first saves of one name: exactly one wins", async () => {
    const tenantId = await seedTenant();
    const userId = await seedPerson(tenantId);
    const sessionId = await seedSession(tenantId, userId);
    const store = new MemoryStore(appPool());
    const name = slug();

    const results = await Promise.allSettled(["A", "B"].map((label) => store.save(tenantId, userId, {
      slug: name, content: `Text ${label}.`, provenance: approvedBy(userId, sessionId), expectedPreviousContentSha256: null
    })));

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await memoryRow(tenantId, userId, name)).toMatchObject({ version: 1 });
  });

  test("a memory saved in one session is read in another session of the same user, and by no one else", async () => {
    const tenantId = await seedTenant();
    const user = await seedPerson(tenantId);
    const colleague = await seedPerson(tenantId);
    const otherTenant = await seedTenant();
    await seedMembership(otherTenant, user, "member"); // the same person in a second organization
    const sessionA = await seedSession(tenantId, user);
    const store = new MemoryStore(appPool());
    const name = slug();

    await store.save(tenantId, user, { slug: name, content: "Standup is at 9:30.", provenance: approvedBy(user, sessionA) });

    // A later session reads it through the same path as the per-turn data message.
    const read = (tenant: string, person: string) =>
      loadWorkspaceMemories(store, { tenantId: tenant, userId: person, enabledToolIds: ["memory_search"] });
    expect((await read(tenantId, user)).map((memory) => memory.slug)).toEqual([name]);
    expect(await read(tenantId, colleague)).toEqual([]);
    expect(await read(otherTenant, user)).toEqual([]);
    expect(await store.search(tenantId, colleague, { query: "Standup" })).toEqual([]);
  });
});

describe.skipIf(!adminDatabaseUrl())("/me/memories isolation", () => {
  async function setup() {
    const tenantId = await seedTenant();
    const otherTenantId = await seedTenant();
    const alice = await seedPerson(tenantId);
    const bob = await seedPerson(tenantId);
    await seedMembership(otherTenantId, alice, "member");
    const store = new MemoryStore(appPool());
    const app = Fastify();
    let auth = { tenantId, userId: alice, role: "member" as const, isAdmin: false };
    app.addHook("preHandler", async (request) => { request.auth = auth; });
    await registerMemoryRoutes(app, { memories: store, auditEvents: new AuditEventStore(appPool()) });
    const sessionId = await seedSession(tenantId, alice);
    const save = async (tenant: string, user: string, content: string) => {
      const name = slug();
      const saved = await store.save(tenant, user, { slug: name, content, provenance: approvedBy(user, sessionId) });
      return { name, id: saved.memoryId };
    };
    return {
      app, store, tenantId, otherTenantId, alice, bob, save,
      as(tenant: string, user: string) { auth = { ...auth, tenantId: tenant, userId: user }; },
      scope: (tenant: string, user: string) => ({ tenantId: tenant, userId: user })
    };
  }

  test("a user lists only their own memories in their own organization", async () => {
    const h = await setup();
    try {
      const mine = await h.save(h.tenantId, h.alice, "Alice keeps this.");
      await h.save(h.tenantId, h.bob, "Bob keeps this.");
      await h.save(h.otherTenantId, h.alice, "Alice in the other organization.");

      const response = await h.app.inject("/me/memories");

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.scope).toEqual(h.scope(h.tenantId, h.alice));
      expect(body.total).toBe(1);
      expect(body.memories).toHaveLength(1);
      expect(body.memories[0]).toMatchObject({ id: mine.id, name: mine.name, content: "Alice keeps this.",
        provenance: "agent_approved", version: 1 });
      expect(JSON.stringify(body)).not.toContain("Bob keeps this.");
      expect(JSON.stringify(body)).not.toContain("other organization");

      h.as(h.otherTenantId, h.alice);
      expect((await h.app.inject("/me/memories")).json().memories.map((memory: { content: string }) => memory.content))
        .toEqual(["Alice in the other organization."]);
    } finally { await h.app.close(); }
  });

  test("a user cannot edit or delete another user's memory or another organization's memory", async () => {
    const h = await setup();
    try {
      const bobs = await h.save(h.tenantId, h.bob, "Bob's text.");
      const elsewhere = await h.save(h.otherTenantId, h.alice, "Alice's text in the other organization.");
      const edit = (id: string) => h.app.inject({ method: "PUT", url: `/me/memories/${id}`,
        payload: { scope: h.scope(h.tenantId, h.alice), content: "Overwritten.", version: 1 } });
      const remove = (id: string) => h.app.inject({ method: "DELETE", url: `/me/memories/${id}`,
        payload: { scope: h.scope(h.tenantId, h.alice) } });

      for (const target of [bobs, elsewhere]) {
        expect((await edit(target.id)).statusCode).toBe(404);
        expect((await remove(target.id)).statusCode).toBe(404);
      }

      // Nothing changed, and no audit event records a change.
      expect(await memoryRow(h.tenantId, h.bob, bobs.name)).toMatchObject({ content: "Bob's text.", version: 1 });
      expect(await memoryRow(h.otherTenantId, h.alice, elsewhere.name))
        .toMatchObject({ content: "Alice's text in the other organization.", version: 1 });
      const audit = await superuserPool().query(
        "SELECT 1 FROM audit_events WHERE tenant_id = ANY($1) AND event_type LIKE 'user.memory.%'", [[h.tenantId, h.otherTenantId]]);
      expect(audit.rows).toHaveLength(0);
    } finally { await h.app.close(); }
  });

  test("an edit records the user as author, needs the version they saw, and a delete removes the row", async () => {
    const h = await setup();
    try {
      const mine = await h.save(h.tenantId, h.alice, "Alice's first text.");
      const url = `/me/memories/${mine.id}`;
      const scope = h.scope(h.tenantId, h.alice);

      // A stale version is refused and changes nothing.
      const stale = await h.app.inject({ method: "PUT", url, payload: { scope, content: "Stale edit.", version: 7 } });
      expect(stale.statusCode).toBe(409);
      expect(await memoryRow(h.tenantId, h.alice, mine.name)).toMatchObject({ content: "Alice's first text.", version: 1 });

      const edited = await h.app.inject({ method: "PUT", url, payload: { scope, content: "Alice's own words.", version: 1 } });
      expect(edited.statusCode).toBe(200);
      expect(edited.json().memory).toMatchObject({ content: "Alice's own words.", version: 2, provenance: "user_authored" });
      expect(await memoryRow(h.tenantId, h.alice, mine.name)).toMatchObject({
        provenance: "user_authored", approved_by_user_id: h.alice, source_session_id: null, approval_id: null, version: 2
      });

      // The same version cannot be used twice.
      expect((await h.app.inject({ method: "PUT", url, payload: { scope, content: "Again.", version: 1 } })).statusCode).toBe(409);

      expect((await h.app.inject({ method: "DELETE", url, payload: { scope } })).statusCode).toBe(204);
      expect(await memoryRow(h.tenantId, h.alice, mine.name)).toBeUndefined();
      expect((await h.app.inject({ method: "DELETE", url, payload: { scope } })).statusCode).toBe(404);

      const audit = await superuserPool().query(
        "SELECT event_type, user_id, payload FROM audit_events WHERE tenant_id = $1 AND event_type LIKE 'user.memory.%' ORDER BY id",
        [h.tenantId]);
      expect(audit.rows.map((row) => row.event_type)).toEqual(["user.memory.updated", "user.memory.deleted"]);
      expect(audit.rows.every((row) => row.user_id === h.alice)).toBe(true);
      expect(JSON.stringify(audit.rows)).not.toContain("Alice's own words.");
    } finally { await h.app.close(); }
  });

  test("a tab opened under another organization cannot write after the account changed", async () => {
    const h = await setup();
    try {
      const inFirst = await h.save(h.tenantId, h.alice, "Text in the first organization.");
      h.as(h.otherTenantId, h.alice); // the browser now holds a token for the other organization

      const response = await h.app.inject({ method: "DELETE", url: `/me/memories/${inFirst.id}`,
        payload: { scope: h.scope(h.tenantId, h.alice) } });

      expect(response.statusCode).toBe(409);
      expect(await memoryRow(h.tenantId, h.alice, inFirst.name)).toBeDefined();
    } finally { await h.app.close(); }
  });

  test("row level security hides every memory from a connection with no tenant", async () => {
    const h = await setup();
    try {
      const mine = await h.save(h.tenantId, h.alice, "Alice keeps this.");

      const noTenant = await appPool().query("SELECT memory_id FROM agent_memories");
      expect(noTenant.rows.map((row) => row.memory_id)).not.toContain(mine.id);

      const inOther = await withTenantScope(appPool(), h.otherTenantId, (client) =>
        client.query("SELECT memory_id FROM agent_memories WHERE memory_id = $1", [mine.id]));
      expect(inOther.rows).toHaveLength(0);
      const inOwn = await withTenantScope(appPool(), h.tenantId, (client) =>
        client.query("SELECT memory_id FROM agent_memories WHERE memory_id = $1", [mine.id]));
      expect(inOwn.rows).toHaveLength(1);
    } finally { await h.app.close(); }
  });
});
