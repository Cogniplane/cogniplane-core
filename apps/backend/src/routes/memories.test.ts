import Fastify from "fastify";
import { afterEach, expect, test, vi } from "vitest";

import { registerMemoryRoutes, type MemoryRouteStores } from "./memories.js";
import {
  MemoryConflictError,
  MemoryNotFoundError,
  type MemoryRecord
} from "../services/memory-store.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

const scope = { tenantId: "tenant-a", userId: "member-1" };

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    memoryId: "m1", userId: "member-1", slug: "units", content: "User prefers metric units.", metadata: { source: "chat" },
    createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-02T00:00:00.000Z", version: 2,
    provenance: "agent_approved", sourceSessionId: "session-1", approvedAt: "2026-07-02T00:00:00.000Z",
    ...overrides
  };
}

async function setup(auth = scope) {
  const app = Fastify(); apps.push(app);
  app.addHook("preHandler", async (request) => { request.auth = { ...auth, role: "member", isAdmin: false }; });
  const memories = {
    list: vi.fn(async () => ({ memories: [record()], total: 1 })),
    updateByUser: vi.fn(async (_t: string, _u: string, _id: string, input: { content: string }) =>
      record({ content: input.content, provenance: "user_authored", version: 3, sourceSessionId: null })),
    removeById: vi.fn(async () => ({ slug: "units" }) as { slug: string } | null)
  };
  const auditEvents = { create: vi.fn(async () => null as never) };
  await registerMemoryRoutes(app, { memories, auditEvents } as unknown as MemoryRouteStores);
  return { app, memories, auditEvents };
}

test("lists the signed-in user's memories as private data, without the source session or the approver", async () => {
  const { app, memories } = await setup();

  const response = await app.inject("/me/memories");

  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("private, no-store");
  // The tenant and the user come from the authenticated request.
  expect(memories.list).toHaveBeenCalledWith("tenant-a", "member-1");
  expect(response.json()).toEqual({
    scope,
    total: 1,
    memories: [{
      id: "m1", name: "units", content: "User prefers metric units.", metadata: { source: "chat" }, version: 2,
      provenance: "agent_approved", approvedAt: "2026-07-02T00:00:00.000Z",
      createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-02T00:00:00.000Z"
    }]
  });
});

test("an edit sends the version the user saw, records the user as author and writes an audit event", async () => {
  const { app, memories, auditEvents } = await setup();

  const response = await app.inject({ method: "PUT", url: "/me/memories/m1",
    payload: { scope, content: "User prefers metric units and 24-hour time.", version: 2 } });

  expect(response.statusCode).toBe(200);
  expect(memories.updateByUser).toHaveBeenCalledWith("tenant-a", "member-1", "m1",
    { content: "User prefers metric units and 24-hour time.", expectedVersion: 2 });
  expect(response.json()).toMatchObject({ scope, memory: { name: "units", provenance: "user_authored", version: 3 } });
  expect(auditEvents.create).toHaveBeenCalledWith({
    tenantId: "tenant-a", sessionId: null, userId: "member-1", type: "user.memory.updated",
    payload: { memoryId: "m1", name: "units", version: 3 }
  });
  // The audit event names the memory and never carries its text.
  expect(JSON.stringify(auditEvents.create.mock.calls)).not.toContain("24-hour");
});

test("an edit of a changed memory is a conflict and of a missing one is not found", async () => {
  const { app, memories, auditEvents } = await setup();

  memories.updateByUser.mockRejectedValueOnce(new MemoryConflictError("units"));
  const conflict = await app.inject({ method: "PUT", url: "/me/memories/m1", payload: { scope, content: "x", version: 1 } });
  expect(conflict.statusCode).toBe(409);
  expect(conflict.json().error).toBe("memory_conflict");

  memories.updateByUser.mockRejectedValueOnce(new MemoryNotFoundError("units"));
  const missing = await app.inject({ method: "PUT", url: "/me/memories/m1", payload: { scope, content: "x", version: 1 } });
  expect(missing.statusCode).toBe(404);
  expect(missing.json().error).toBe("memory_not_found");
  expect(auditEvents.create).not.toHaveBeenCalled();
});

test.each([
  ["empty text", { content: "   ", version: 1 }],
  ["oversized text", { content: "x".repeat(8_001), version: 1 }],
  ["no version", { content: "x" }],
  ["a version of zero", { content: "x", version: 0 }],
  ["an unknown field", { content: "x", version: 1, provenance: "agent_approved" }]
])("an edit with %s is refused before any write", async (_label, payload) => {
  const { app, memories } = await setup();

  const response = await app.inject({ method: "PUT", url: "/me/memories/m1", payload: { scope, ...payload } });

  expect(response.statusCode).toBe(400);
  expect(memories.updateByUser).not.toHaveBeenCalled();
});

test("an id that cannot be a memory id is refused before any write", async () => {
  const { app, memories } = await setup();

  // Fastify refuses a segment of more than 100 characters, so the longest id that reaches the route is 64.
  const tooLong = "a".repeat(65);
  expect((await app.inject({ method: "PUT", url: `/me/memories/${tooLong}`, payload: { scope, content: "x", version: 1 } })).statusCode).toBe(400);
  expect((await app.inject({ method: "DELETE", url: `/me/memories/${tooLong}`, payload: { scope } })).statusCode).toBe(400);
  expect(memories.updateByUser).not.toHaveBeenCalled();
  expect(memories.removeById).not.toHaveBeenCalled();
});

test("a memory with the longest valid name can still be edited and deleted, because routes use its id", async () => {
  const { app, memories } = await setup();
  memories.updateByUser.mockImplementationOnce(async (_t, _u, _id, input) => record({ slug: "n".repeat(128), content: input.content }));

  const edit = await app.inject({ method: "PUT", url: "/me/memories/m1", payload: { scope, content: "x", version: 2 } });
  expect(edit.statusCode).toBe(200);
  expect(edit.json().memory.name).toBe("n".repeat(128));
  memories.removeById.mockResolvedValueOnce({ slug: "n".repeat(128) });
  expect((await app.inject({ method: "DELETE", url: "/me/memories/m1", payload: { scope } })).statusCode).toBe(204);
});

test("a delete removes only the signed-in user's memory and writes an audit event", async () => {
  const { app, memories, auditEvents } = await setup();

  const response = await app.inject({ method: "DELETE", url: "/me/memories/m1", payload: { scope } });

  expect(response.statusCode).toBe(204);
  expect(memories.removeById).toHaveBeenCalledWith("tenant-a", "member-1", "m1");
  expect(auditEvents.create).toHaveBeenCalledWith({
    tenantId: "tenant-a", sessionId: null, userId: "member-1", type: "user.memory.deleted",
    payload: { memoryId: "m1", name: "units" }
  });

  memories.removeById.mockResolvedValueOnce(null);
  const missing = await app.inject({ method: "DELETE", url: "/me/memories/m1", payload: { scope } });
  expect(missing.statusCode).toBe(404);
  expect(auditEvents.create).toHaveBeenCalledTimes(1);
});

test("a write from a tab that belongs to another organization or user is refused before it touches a memory", async () => {
  // The browser's token now belongs to tenant-b, but the open tab was loaded under tenant-a.
  const { app, memories, auditEvents } = await setup({ tenantId: "tenant-b", userId: "member-1" });

  const edit = await app.inject({ method: "PUT", url: "/me/memories/m1", payload: { scope, content: "x", version: 2 } });
  const remove = await app.inject({ method: "DELETE", url: "/me/memories/m1", payload: { scope } });
  const otherUser = await app.inject({ method: "DELETE", url: "/me/memories/m1",
    payload: { scope: { tenantId: "tenant-b", userId: "member-2" } } });

  for (const response of [edit, remove, otherUser]) {
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("memory_scope_changed");
  }
  expect(memories.updateByUser).not.toHaveBeenCalled();
  expect(memories.removeById).not.toHaveBeenCalled();
  expect(auditEvents.create).not.toHaveBeenCalled();
});
