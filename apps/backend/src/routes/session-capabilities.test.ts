import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { registerSessionCapabilityRoutes, type SessionCapabilityStores } from "./session-capabilities.js";
import { ActiveTurnsRegistry } from "../services/active-turns-registry.js";

const sessionId = "0198c0de-0000-7000-8000-000000000001";
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
async function setup() {
  const app = Fastify(); apps.push(app);
  const sessions = {
    getOwned: vi.fn(async () => ({ status: "active" } as { status: string } | null)),
    getCapabilities: vi.fn(async () => ({ selection: null, version: 0, canEdit: true })),
    setCapabilities: vi.fn(async () => true)
  };
  const getReadable = vi.fn(async () => {
    const session = await sessions.getOwned();
    return session?.status === "deleted" ? null : session;
  });
  const dynamicConfig = {
    compileRuntimeConfig: vi.fn(async () => ({ skills: [{ id: "pdf", name: "PDF", description: null }], mcpServers: [{ id: "docs", description: "Read docs" }] })),
    listMcpServers: vi.fn(async () => [{ serverId: "docs", serverName: "Docs" }])
  };
  const activeTurns = new ActiveTurnsRegistry();
  const hasActiveTurn = vi.fn(() => false);
  app.addHook("preHandler", async (request) => { request.auth = { userId: "user", tenantId: "tenant", role: "member", isAdmin: false }; });
  await registerSessionCapabilityRoutes(app, { sessions: { ...sessions, getReadable }, dynamicConfig, activeTurns,
    runtimeAdapter: { hasActiveTurn }, tenantMembers: { isUserBetaTester: vi.fn(async () => false) }
  } as unknown as SessionCapabilityStores);
  const update = (selection: unknown = { skillIds: ["pdf"], connectorIds: [] }, version = 0) => app.inject({
    method: "PUT", url: `/sessions/${sessionId}/capabilities`, payload: { selection, version }
  });
  return { app, sessions, dynamicConfig, activeTurns, hasActiveTurn, update };
}

it("returns a member-safe catalog and saves an allowlist or organization defaults", async () => {
  const h = await setup();
  const response = await h.app.inject(`/sessions/${sessionId}/capabilities`);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ selection: null, version: 0, canEdit: true,
    skills: [{ id: "pdf", name: "PDF", description: "" }], connectors: [{ id: "docs", name: "Docs", description: "Read docs" }] });
  expect(h.dynamicConfig.compileRuntimeConfig).toHaveBeenCalledWith("tenant", false);
  expect((await h.update()).statusCode).toBe(200);
  expect(h.sessions.setCapabilities).toHaveBeenCalledWith("tenant", sessionId, "user", { selection: { skillIds: ["pdf"], connectorIds: [] }, version: 0 });
  expect((await h.update(null, 2)).statusCode).toBe(200);
  expect(h.activeTurns.snapshot().size).toBe(0);
});

it.each([null, { status: "deleted" }])("rejects unowned and deleted sessions before reading the catalog", async (owned) => {
  const h = await setup(); h.sessions.getOwned.mockResolvedValue(owned);
  expect((await h.update()).statusCode).toBe(404);
  expect((await h.app.inject(`/sessions/${sessionId}/capabilities`)).statusCode).toBe(404);
  expect(h.dynamicConfig.compileRuntimeConfig).not.toHaveBeenCalled();
});

it.each([
  { skillIds: ["disabled"], connectorIds: [] },
  { skillIds: [], connectorIds: ["foreign"] },
  { skillIds: [], connectorIds: [], enabledToolIds: ["execute"] }
])("rejects unavailable capabilities and unsupported overrides", async (selection) => {
  const h = await setup(); expect((await h.update(selection)).statusCode).toBe(400);
  expect(h.sessions.setCapabilities).not.toHaveBeenCalled();
});

it("blocks active and archived sessions and releases reservations on conflicts and failures", async () => {
  const h = await setup();
  h.hasActiveTurn.mockReturnValue(true);
  expect((await h.update()).statusCode).toBe(409);
  h.hasActiveTurn.mockReturnValue(false);
  h.activeTurns.mark(sessionId);
  expect((await h.update()).statusCode).toBe(409);
  h.activeTurns.clear(sessionId);
  h.sessions.getOwned.mockResolvedValue({ status: "archived" });
  expect((await h.update()).statusCode).toBe(409);
  h.sessions.getOwned.mockResolvedValue({ status: "active" });
  h.sessions.setCapabilities.mockResolvedValue(false);
  expect((await h.update()).statusCode).toBe(409);
  expect(h.activeTurns.snapshot().size).toBe(0);
  h.sessions.setCapabilities.mockRejectedValue(new Error("database unavailable"));
  expect((await h.update()).statusCode).toBe(500);
  expect(h.activeTurns.snapshot().size).toBe(0);
});

it("holds an invisible reservation during saves and rejects concurrent saves", async () => {
  const h = await setup();
  let finish!: (value: boolean) => void;
  let entered!: () => void;
  const writing = new Promise<void>((resolve) => { entered = resolve; });
  h.sessions.setCapabilities.mockImplementation(() => {
    entered();
    return new Promise<boolean>((resolve) => { finish = resolve; });
  });
  const saving = h.update().then((response) => response);
  await writing;
  expect(h.activeTurns.isBusy(sessionId)).toBe(true);
  expect(h.activeTurns.snapshot().size).toBe(0);
  expect((await h.update()).statusCode).toBe(409);
  finish(true);
  expect((await saving).statusCode).toBe(200);
  expect(h.activeTurns.isBusy(sessionId)).toBe(false);
});

it("preserves a turn that starts while the catalog loads", async () => {
  const h = await setup();
  h.dynamicConfig.listMcpServers.mockImplementation(async () => {
    h.activeTurns.mark(sessionId);
    return [];
  });
  expect((await h.update()).statusCode).toBe(409);
  expect(h.sessions.setCapabilities).not.toHaveBeenCalled();
  expect(h.activeTurns.snapshot().has(sessionId)).toBe(true);
});
