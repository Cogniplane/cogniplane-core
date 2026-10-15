import type { McpConnection } from "@cogniplane/shared-types";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { registerProjectCapabilityRoutes, type ProjectCapabilityStores } from "./project-capabilities.js";

const projectId = "0198c0de-0000-7000-8000-000000000001";
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

async function setup() {
  const app = Fastify(); apps.push(app);
  app.addHook("preHandler", async request => {
    request.auth = { tenantId: "tenant", userId: "user", role: "member", isAdmin: false };
  });
  const projects = {
    getReadable: vi.fn(async () => ({ canManage: true, archivedAt: null } as { canManage: boolean; archivedAt: string | null } | null)),
    getCapabilities: vi.fn(async () => ({ selection: null as { skillIds: string[]; connectorIds: string[] } | null, version: 0, canEdit: true })),
    setCapabilities: vi.fn(async () => true)
  };
  const memberMcpCredentials = { list: vi.fn(async (): Promise<McpConnection[]> => []) };
  const dynamicConfig = {
    compileProjectCatalog: vi.fn(async () => ({ skills: [{ id: "pdf", name: "PDF", description: null }],
      mcpServers: [{ id: "docs", description: "Read docs" }] })),
    listMcpServers: vi.fn(async () => [{ serverId: "docs", serverName: "Docs" }])
  };
  await registerProjectCapabilityRoutes(app, { projects, dynamicConfig, memberMcpCredentials,
    tenantMembers: { isUserBetaTester: vi.fn(async () => false) }
  } as unknown as ProjectCapabilityStores);
  const get = () => app.inject(`/projects/${projectId}/capabilities`);
  const put = (selection: unknown, version = 0) => app.inject({ method: "PUT", url: `/projects/${projectId}/capabilities`,
    payload: { selection, version } });
  return { projects, dynamicConfig, memberMcpCredentials, get, put };
}

it("returns the actor-visible catalog and keeps unavailable saved IDs", async () => {
  const h = await setup();
  h.projects.getCapabilities.mockResolvedValue({ selection: { skillIds: ["old"], connectorIds: [] }, version: 4, canEdit: true });
  const response = await h.get();
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ selection: { skillIds: ["old"], connectorIds: [] }, version: 4, canEdit: true,
    skills: [{ id: "pdf", name: "PDF", description: "", source: "organization" }], connectors: [{ id: "docs", name: "Docs", description: "Read docs" }] });
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(h.dynamicConfig.compileProjectCatalog).toHaveBeenCalledWith("tenant", false, projectId, "user");
});

it("saves catalog IDs, permits reset, and rejects unavailable choices", async () => {
  const h = await setup();
  expect((await h.put({ skillIds: ["pdf"], connectorIds: ["docs"] })).statusCode).toBe(200);
  expect(h.projects.setCapabilities).toHaveBeenCalledWith("tenant", "user", projectId,
    { selection: { skillIds: ["pdf"], connectorIds: ["docs"] }, version: 0 },
    { skillIds: ["pdf"], connectorIds: ["docs"] });
  expect((await h.put(null)).statusCode).toBe(200);
  expect((await h.put({ skillIds: ["old"], connectorIds: [] })).statusCode).toBe(400);
  expect((await h.put({ skillIds: [], connectorIds: ["foreign"] })).statusCode).toBe(400);
  expect(h.projects.setCapabilities).toHaveBeenCalledTimes(2);
});

it("retains saved unavailable IDs while adding catalog IDs, but rejects new unavailable IDs", async () => {
  const h = await setup();
  h.projects.getCapabilities.mockResolvedValue({
    selection: { skillIds: ["retired"], connectorIds: ["disabled"] }, version: 4, canEdit: true
  });
  const retained = { skillIds: ["retired", "pdf"], connectorIds: ["disabled", "docs"] };
  expect((await h.put(retained, 4)).statusCode).toBe(200);
  expect(h.projects.setCapabilities).toHaveBeenCalledWith("tenant", "user", projectId,
    { selection: retained, version: 4 }, { skillIds: ["pdf"], connectorIds: ["docs"] });
  expect((await h.put({ skillIds: ["retired", "new"], connectorIds: ["disabled"] }, 4)).statusCode).toBe(400);
  expect((await h.put({ skillIds: ["retired"], connectorIds: ["disabled", "new"] }, 4)).statusCode).toBe(400);
  expect((await h.put(retained, 3)).statusCode).toBe(409);
  expect(h.projects.setCapabilities).toHaveBeenCalledTimes(1);
});

it("checks project membership and owner role before reading the catalog", async () => {
  const h = await setup();
  h.projects.getReadable.mockResolvedValue(null);
  expect((await h.put(null)).statusCode).toBe(404);
  h.projects.getReadable.mockResolvedValue({ canManage: false, archivedAt: null });
  expect((await h.put(null)).statusCode).toBe(403);
  expect(h.dynamicConfig.compileProjectCatalog).not.toHaveBeenCalled();
});

it("reports archive and version conflicts", async () => {
  const h = await setup();
  h.projects.getReadable.mockResolvedValue({ canManage: true, archivedAt: new Date().toISOString() });
  expect((await h.put(null)).statusCode).toBe(409);
  h.projects.getReadable.mockResolvedValue({ canManage: true, archivedAt: null });
  h.projects.setCapabilities.mockResolvedValue(false);
  expect((await h.put(null)).statusCode).toBe(409);
});


it("shows the caller's connection state without hiding an unconnected approved connector", async () => {
  const h = await setup();
  h.memberMcpCredentials.list.mockResolvedValue([{
    serverId: "docs", serverName: "Documents", description: null, upstreamUrl: "https://docs.example.test/mcp",
    authType: "bearer", authName: null, credentialScope: "personal", serverVersion: 1,
    credentialVersion: 0, status: "not_connected", accountLabel: null, hasCredential: false, canConnect: true
  }]);
  const response = await h.get();
  expect(response.statusCode).toBe(200);
  expect(response.json().connectors).toEqual([expect.objectContaining({
    id: "docs", connectionStatus: "not_connected", accountLabel: null
  })]);
  expect(h.memberMcpCredentials.list).toHaveBeenCalledWith("tenant", "user");
});

it("labels this project's skills and accepts only IDs from this project's catalog", async () => {
  const h = await setup();
  h.dynamicConfig.compileProjectCatalog.mockResolvedValue({ skills: [
    { id: "pdf", name: "PDF", description: null },
    { id: "project-skill-a", name: "shared-notes", description: "Notes", sourceType: "project" }
  ] as never, mcpServers: [] as never });
  expect((await h.get()).json().skills).toEqual([
    { id: "pdf", name: "PDF", description: "", source: "organization" },
    { id: "project-skill-a", name: "shared-notes", description: "Notes", source: "project" }
  ]);
  expect((await h.put({ skillIds: ["project-skill-a"], connectorIds: [] })).statusCode).toBe(200);
  expect((await h.put({ skillIds: ["project-skill-other"], connectorIds: [] })).statusCode).toBe(400);
  expect((await h.put({ skillIds: ["personal-skill-mine"], connectorIds: [] })).statusCode).toBe(400);
  expect(h.projects.setCapabilities).toHaveBeenCalledTimes(1);
  expect(h.dynamicConfig.compileProjectCatalog).toHaveBeenCalledWith("tenant", false, projectId, "user");
});
