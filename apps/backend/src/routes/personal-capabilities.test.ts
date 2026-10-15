import type { McpConnection } from "@cogniplane/shared-types";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { registerPersonalCapabilityRoutes, type PersonalCapabilityStores } from "./personal-capabilities.js";
import { PersonalCapabilityAccessError } from "../services/personal-capability-store.js";
import type { SessionCapabilitiesUpdate } from "@cogniplane/shared-types";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function setup() {
  const app = Fastify(); apps.push(app);
  app.addHook("preHandler", async request => {
    request.auth = { tenantId: "tenant", userId: "member", role: "member", isAdmin: false };
  });
  const personalCapabilities = {
    get: vi.fn(async (): Promise<SessionCapabilitiesUpdate> => ({ selection: null, version: 0 })),
    save: vi.fn(async (_tenant: string, _user: string, input: SessionCapabilitiesUpdate): Promise<SessionCapabilitiesUpdate | null> =>
      ({ ...input, version: input.version + 1 }))
  };
  const memberMcpCredentials = { list: vi.fn(async (): Promise<McpConnection[]> => []) };
  const dynamicConfig = {
    compilePersonalCatalog: vi.fn(async () => ({ skills: [{ id: "pdf", name: "PDF", description: null }],
      mcpServers: [{ id: "docs", description: "Read docs" }] })),
    listMcpServers: vi.fn(async () => [{ serverId: "docs", serverName: "Documents" }])
  };
  const tenantMembers = { isUserBetaTester: vi.fn(async () => false) };
  await registerPersonalCapabilityRoutes(app, { personalCapabilities, dynamicConfig, tenantMembers, memberMcpCredentials } as unknown as PersonalCapabilityStores);
  return { personalCapabilities, dynamicConfig, tenantMembers, memberMcpCredentials,
    get: () => app.inject("/me/capabilities"),
    put: (selection: unknown, version = 0, extra = {}) => app.inject({ method: "PUT", url: "/me/capabilities", payload: {
      selection, version, scope: { tenantId: "tenant", userId: "member" }, ...extra } }) };
}

it("returns only the authenticated member's defaults and actor-visible catalog", async () => {
  const h = await setup();
  h.personalCapabilities.get.mockResolvedValue({ selection: { skillIds: ["unavailable"], connectorIds: [] }, version: 4 });
  const response = await h.get();
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ selection: { skillIds: ["unavailable"], connectorIds: [] }, version: 4, canEdit: true,
    scope: { tenantId: "tenant", userId: "member" },
    skills: [{ id: "pdf", name: "PDF", description: "", source: "organization" }], connectors: [{ id: "docs", name: "Documents", description: "Read docs" }] });
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(h.personalCapabilities.get).toHaveBeenCalledWith("tenant", "member");
  expect(h.tenantMembers.isUserBetaTester).toHaveBeenCalledWith("tenant", "member");
  expect(h.dynamicConfig.compilePersonalCatalog).toHaveBeenCalledWith("tenant", false, "member");
});

it("saves custom, empty and inherited choices for the authenticated member", async () => {
  const h = await setup();
  const selection = { skillIds: ["pdf"], connectorIds: ["docs"] };
  const response = await h.put(selection);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ selection, version: 1 });
  expect(h.personalCapabilities.save).toHaveBeenCalledWith("tenant", "member", { selection, version: 0 }, selection);
  expect((await h.put({ skillIds: [], connectorIds: [] })).statusCode).toBe(200);
  expect((await h.put(null)).statusCode).toBe(200);
});

it("retains unavailable references but rejects unavailable additions and identity injection", async () => {
  const h = await setup();
  h.personalCapabilities.get.mockResolvedValue({ selection: { skillIds: ["retired"], connectorIds: ["disabled"] }, version: 3 });
  expect((await h.put({ skillIds: ["retired", "pdf"], connectorIds: ["disabled", "docs"] }, 3)).statusCode).toBe(200);
  expect((await h.put({ skillIds: ["new"], connectorIds: [] }, 3)).statusCode).toBe(400);
  expect((await h.put({ skillIds: [], connectorIds: ["new"] }, 3)).statusCode).toBe(400);
  expect((await h.put(null, 3, { userId: "other" })).statusCode).toBe(400);
  expect((await h.put(null, 3, { tenantId: "other" })).statusCode).toBe(400);
  expect(h.personalCapabilities.save).toHaveBeenCalledTimes(1);
});

it("reports stale versions and a competing write without a success response", async () => {
  const h = await setup();
  h.personalCapabilities.get.mockResolvedValue({ selection: null, version: 2 });
  expect((await h.put(null, 1)).statusCode).toBe(409);
  expect(h.dynamicConfig.compilePersonalCatalog).not.toHaveBeenCalled();
  h.personalCapabilities.save.mockResolvedValue(null);
  expect((await h.put(null, 2)).statusCode).toBe(409);
});

it("rejects a save replayed under another organization or account before reading defaults", async () => {
  const h = await setup();
  for (const scope of [{ tenantId: "previous", userId: "member" }, { tenantId: "tenant", userId: "previous" }]) {
    const response = await h.put(null, 0, { scope });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("capabilities_scope_changed");
  }
  expect((await h.put(null, 0, { scope: undefined })).statusCode).toBe(400);
  expect(h.personalCapabilities.get).not.toHaveBeenCalled();
  expect(h.personalCapabilities.save).not.toHaveBeenCalled();
  expect(h.dynamicConfig.compilePersonalCatalog).not.toHaveBeenCalled();
});

it("rejects a removed member before reading the catalog", async () => {
  const h = await setup();
  h.personalCapabilities.get.mockRejectedValue(new PersonalCapabilityAccessError());
  expect((await h.get()).statusCode).toBe(403);
  expect((await h.put(null)).statusCode).toBe(403);
  expect(h.dynamicConfig.compilePersonalCatalog).not.toHaveBeenCalled();
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
  expect(h.memberMcpCredentials.list).toHaveBeenCalledWith("tenant", "member");
});
