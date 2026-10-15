import type { McpConnection } from "@cogniplane/shared-types";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { registerSessionCapabilityRoutes, type SessionCapabilityStores } from "./session-capabilities.js";
import { ActiveTurnsRegistry } from "../services/active-turns-registry.js";
import type { SessionCapabilitySelection } from "@cogniplane/shared-types";

const sessionId = "0198c0de-0000-7000-8000-000000000001";
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
async function setup() {
  const app = Fastify(); apps.push(app);
  const sessions = {
    getOwned: vi.fn(async () => ({ status: "active" } as { status: string } | null)),
    getCapabilities: vi.fn(async () => ({ selection: null as SessionCapabilitySelection | null, version: 0, canEdit: true,
      defaultsSource: "personal" as "organization" | "project" | "personal",
      defaultsSelection: null as SessionCapabilitySelection | null, personalUserId: "user" as string | null,
      projectId: null as string | null })),
    setCapabilities: vi.fn(async () => true)
  };
  const getReadable = vi.fn(async () => {
    const session = await sessions.getOwned();
    return session?.status === "deleted" ? null : session;
  });
  const memberMcpCredentials = { list: vi.fn(async (): Promise<McpConnection[]> => []) };
  const dynamicConfig = {
    compileRuntimeConfig: vi.fn(async () => ({ skills: [{ id: "pdf", name: "PDF", description: null, sourceType: undefined as string | undefined }], mcpServers: [{ id: "docs", description: "Read docs" }] })),
    compilePersonalCatalog: vi.fn(async () => ({ skills: [{ id: "pdf", name: "PDF", description: null as string | null, sourceType: undefined as string | undefined }], mcpServers: [{ id: "docs", description: "Read docs" }] })),
    compileProjectCatalog: vi.fn(async () => ({ skills: [{ id: "pdf", name: "PDF", description: null as string | null, sourceType: undefined as string | undefined },
      { id: "project-skill-a", name: "shared-notes", description: "Notes" as string | null, sourceType: "project" as string | undefined }], mcpServers: [] })),
    listMcpServers: vi.fn(async () => [{ serverId: "docs", serverName: "Docs" }])
  };
  const activeTurns = new ActiveTurnsRegistry();
  const hasActiveTurn = vi.fn(() => false);
  app.addHook("preHandler", async (request) => { request.auth = { userId: "user", tenantId: "tenant", role: "member", isAdmin: false }; });
  await registerSessionCapabilityRoutes(app, { sessions: { ...sessions, getReadable }, dynamicConfig, activeTurns, memberMcpCredentials,
    runtimeAdapter: { hasActiveTurn }, tenantMembers: { isUserBetaTester: vi.fn(async () => false) }
  } as unknown as SessionCapabilityStores);
  const update = (selection: unknown = { skillIds: ["pdf"], connectorIds: [] }, version = 0) => app.inject({
    method: "PUT", url: `/sessions/${sessionId}/capabilities`, payload: { selection, version }
  });
  return { app, sessions, dynamicConfig, memberMcpCredentials, activeTurns, hasActiveTurn, update };
}

it("returns a member-safe catalog and saves an allowlist or organization defaults", async () => {
  const h = await setup();
  const response = await h.app.inject(`/sessions/${sessionId}/capabilities`);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ selection: null, version: 0, canEdit: true, defaultsSource: "personal",
    skills: [{ id: "pdf", name: "PDF", description: "", source: "organization" }], connectors: [{ id: "docs", name: "Docs", description: "Read docs" }] });
  expect(h.dynamicConfig.compilePersonalCatalog).toHaveBeenCalledWith("tenant", false, "user");
  expect((await h.update()).statusCode).toBe(200);
  expect(h.sessions.setCapabilities).toHaveBeenCalledWith("tenant", sessionId, "user", { selection: { skillIds: ["pdf"], connectorIds: [] }, version: 0 },
    { skillIds: ["pdf"], connectorIds: ["docs"] });
  expect((await h.update(null)).statusCode).toBe(200);
  expect(h.activeTurns.snapshot().size).toBe(0);
});

it("limits project session options and keeps unavailable saved IDs visible", async () => {
  const h = await setup();
  h.sessions.getCapabilities.mockResolvedValue({
    selection: { skillIds: ["retired", "pdf"], connectorIds: ["docs", "removed"] },
    version: 4, canEdit: true, defaultsSource: "project",
    defaultsSelection: { skillIds: [], connectorIds: ["docs"] }, personalUserId: null, projectId: null
  });
  const response = await h.app.inject(`/sessions/${sessionId}/capabilities`);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    selection: { skillIds: ["retired", "pdf"], connectorIds: ["docs", "removed"] },
    version: 4, canEdit: true, defaultsSource: "project", skills: [],
    connectors: [{ id: "docs", name: "Docs", description: "Read docs" }]
  });
  expect((await h.update({ skillIds: ["pdf"], connectorIds: [] }, 4)).statusCode).toBe(200);
  expect((await h.update({ skillIds: ["retired", "pdf"], connectorIds: ["docs", "removed"] }, 4)).statusCode).toBe(200);
  expect((await h.update({ skillIds: ["retired"], connectorIds: ["docs", "new"] }, 4)).statusCode).toBe(400);
  expect((await h.update({ skillIds: [], connectorIds: ["docs"] }, 4)).statusCode).toBe(200);
  expect((await h.update(null, 4)).statusCode).toBe(200);
  expect((await h.update(null, 3)).statusCode).toBe(409);
});

it("offers this project's skills only in its project sessions", async () => {
  const h = await setup();
  h.sessions.getCapabilities.mockResolvedValue({ selection: null, version: 2, canEdit: true, defaultsSource: "project",
    defaultsSelection: null, personalUserId: null, projectId: "project-a" });
  const response = await h.app.inject(`/sessions/${sessionId}/capabilities`);
  expect(response.json().skills).toEqual([
    { id: "pdf", name: "PDF", description: "", source: "organization" },
    { id: "project-skill-a", name: "shared-notes", description: "Notes", source: "project" }
  ]);
  expect(h.dynamicConfig.compileProjectCatalog).toHaveBeenCalledWith("tenant", false, "project-a", "user");
  expect(h.dynamicConfig.compilePersonalCatalog).not.toHaveBeenCalled();
  expect((await h.update({ skillIds: ["project-skill-a"], connectorIds: [] }, 2)).statusCode).toBe(200);
  expect((await h.update({ skillIds: ["project-skill-other"], connectorIds: [] }, 2)).statusCode).toBe(400);

  h.sessions.getCapabilities.mockResolvedValue({ selection: null, version: 0, canEdit: true, defaultsSource: "personal",
    defaultsSelection: null, personalUserId: "user", projectId: null });
  expect((await h.update({ skillIds: ["project-skill-a"], connectorIds: [] }, 0)).statusCode).toBe(400);
  expect(h.sessions.setCapabilities).toHaveBeenCalledTimes(1);
});

it("narrows standalone choices to personal defaults and retains saved references", async () => {
  const h = await setup();
  h.sessions.getCapabilities.mockResolvedValue({
    selection: { skillIds: ["retired"], connectorIds: [] }, version: 2, canEdit: true,
    defaultsSource: "personal", defaultsSelection: { skillIds: ["pdf"], connectorIds: [] }, personalUserId: "user", projectId: null
  });
  const response = await h.app.inject(`/sessions/${sessionId}/capabilities`);
  expect(response.json()).toMatchObject({ defaultsSource: "personal",
    selection: { skillIds: ["retired"], connectorIds: [] }, connectors: [] });
  expect((await h.update({ skillIds: ["retired", "pdf"], connectorIds: [] }, 2)).statusCode).toBe(200);
  expect((await h.update({ skillIds: ["retired"], connectorIds: ["docs"] }, 2)).statusCode).toBe(400);
  expect((await h.update({ skillIds: ["retired", "pdf"], connectorIds: [] }, 1)).statusCode).toBe(409);
});

it("offers private skills only for the session owner's standalone catalog", async () => {
  const h = await setup();
  h.dynamicConfig.compilePersonalCatalog.mockResolvedValue({
    skills: [{ id: "personal-skill-1", name: "My notes", description: "Private", sourceType: "personal" }],
    mcpServers: []
  });
  const personal = await h.app.inject(`/sessions/${sessionId}/capabilities`);
  expect(personal.json().skills).toEqual([{ id: "personal-skill-1", name: "My notes",
    description: "Private", source: "personal" }]);
  h.sessions.getCapabilities.mockResolvedValue({ selection: null, version: 0, canEdit: true,
    defaultsSource: "project", defaultsSelection: null, personalUserId: null, projectId: null });
  const project = await h.app.inject(`/sessions/${sessionId}/capabilities`);
  expect(project.json().skills).toEqual([{ id: "pdf", name: "PDF", description: "", source: "organization" }]);
  expect(h.dynamicConfig.compileRuntimeConfig).toHaveBeenCalledWith("tenant", false);
  expect(h.dynamicConfig.compilePersonalCatalog).toHaveBeenCalledTimes(1);
});

it.each([null, { status: "deleted" }])("rejects unowned and deleted sessions before reading the catalog", async (owned) => {
  const h = await setup(); h.sessions.getOwned.mockResolvedValue(owned);
  expect((await h.update()).statusCode).toBe(404);
  expect((await h.app.inject(`/sessions/${sessionId}/capabilities`)).statusCode).toBe(404);
  expect(h.dynamicConfig.compileRuntimeConfig).not.toHaveBeenCalled();
  expect(h.dynamicConfig.compilePersonalCatalog).not.toHaveBeenCalled();
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


it("shows the caller's connection state without hiding an unconnected approved connector", async () => {
  const h = await setup();
  h.memberMcpCredentials.list.mockResolvedValue([{
    serverId: "docs", serverName: "Documents", description: null, upstreamUrl: "https://docs.example.test/mcp",
    authType: "bearer", authName: null, credentialScope: "personal", serverVersion: 1,
    credentialVersion: 0, status: "not_connected", accountLabel: null, hasCredential: false, canConnect: true
  }]);
  const response = await h.app.inject(`/sessions/${sessionId}/capabilities`);
  expect(response.statusCode).toBe(200);
  expect(response.json().connectors).toEqual([expect.objectContaining({
    id: "docs", connectionStatus: "not_connected", accountLabel: null
  })]);
  expect(h.memberMcpCredentials.list).toHaveBeenCalledWith("tenant", "user");
});
