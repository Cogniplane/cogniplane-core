import { describe, expect, test } from "vitest";
import { SessionStore } from "../services/session-store.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedTenant, seedUser, seedSession, seedRuntimeSession, seedApproval, seedStreamingMessage } from "./support/fixtures.js";

describe.skipIf(!adminDatabaseUrl())("session capability persistence", () => {
  test("persists choices and defaults, enforces ownership and isolates tenants", async () => {
    const tenant = await seedTenant(), foreignTenant = await seedTenant();
    const user = await seedUser(), foreignUser = await seedUser();
    const id = await seedSession(tenant, user);
    const store = new SessionStore(appPool());
    expect(await store.getCapabilities(tenant, id, user)).toEqual({ selection: null, version: 0, canEdit: true });
    await expect(store.getCapabilities(tenant, id, foreignUser)).rejects.toThrow("Session not found");
    await expect(store.getCapabilitySelection(tenant, id, foreignUser)).rejects.toThrow("Session not found");
    await expect(store.getCapabilitySelection(foreignTenant, id, user)).rejects.toThrow("Session not found");
    expect(await store.getCapabilitySelection(tenant, id, user)).toBeNull();
    const selection = { skillIds: ["pdf"], connectorIds: [] };
    expect(await store.setCapabilities(foreignTenant, id, user, { selection, version: 0 })).toBe(false);
    expect(await store.setCapabilities(tenant, id, foreignUser, { selection, version: 0 })).toBe(false);
    await expect(store.getCapabilities(foreignTenant, id, user)).rejects.toThrow("Session not found");
    expect(await store.setCapabilities(tenant, id, user, { selection, version: 0 })).toBe(true);
    expect(await store.getCapabilitySelection(tenant, id, user)).toEqual(selection);
    expect(await new SessionStore(appPool()).getCapabilities(tenant, id, user)).toEqual({ selection, version: 1, canEdit: true });
    expect(await store.setCapabilities(tenant, id, user, { selection: null, version: 0 })).toBe(false);
    const results = await Promise.all([
      store.setCapabilities(tenant, id, user, { selection: null, version: 1 }),
      store.setCapabilities(tenant, id, user, { selection: { skillIds: [], connectorIds: [] }, version: 1 })
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect(await store.setCapabilities(tenant, id, user, { selection: null, version: 2 })).toBe(true);
    expect((await store.getCapabilities(tenant, id, user)).selection).toBeNull();
    await store.setArchived(tenant, id, user, true);
    expect(await store.setCapabilities(tenant, id, user, { selection, version: 3 })).toBe(false);
  });

  test("pending approvals and streaming turns lock changes", async () => {
    const tenant = await seedTenant(), user = await seedUser();
    const id = await seedSession(tenant, user), runtimeId = await seedRuntimeSession(tenant, user, id);
    const store = new SessionStore(appPool());
    const approval = await seedApproval({ tenantId: tenant, userId: user, sessionId: id, runtimeId });
    const update = { selection: { skillIds: [], connectorIds: [] }, version: 0 };
    expect((await store.getCapabilities(tenant, id, user)).canEdit).toBe(false);
    expect(await store.setCapabilities(tenant, id, user, update)).toBe(false);
    await superuserPool().query("UPDATE approvals SET status = 'approved' WHERE approval_id = $1", [approval]);
    const message = await seedStreamingMessage(tenant, user, id);
    expect((await store.getCapabilities(tenant, id, user)).canEdit).toBe(false);
    expect(await store.setCapabilities(tenant, id, user, update)).toBe(false);
    await superuserPool().query("UPDATE messages SET status = 'completed' WHERE message_id = $1", [message]);
    expect(await store.setCapabilities(tenant, id, user, update)).toBe(true);
  });
});
