import Fastify from "fastify";
import { afterEach, expect, test, vi } from "vitest";
import { registerMemberMcpRoutes, type MemberMcpRouteStores } from "./member-mcp.js";
import { MemberMcpAccessError, MemberMcpNotFoundError, MemberMcpConflictError, MemberMcpValidationError } from "../services/member-mcp-credential-store.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
const scope = { tenantId: "tenant", userId: "member" };
const connection = { serverId: "docs", serverName: "Documents", description: null,
  upstreamUrl: "https://mcp.example.test", authType: "bearer", authName: null,
  credentialScope: "personal", serverVersion: 3, credentialVersion: 2, canConnect: true, hasCredential: true,
  status: "connected", accountLabel: "Work" };
const input = { scope, serverVersion: 3, version: 1, secret: "private-member-secret", accountLabel: "Work" };
async function setup() {
  const app = Fastify(); apps.push(app);
  app.addHook("preHandler", async request => { request.auth = { ...scope, role: "member", isAdmin: false }; });
  const memberMcpCredentials = {
    list: vi.fn(async () => [{ ...connection, secret: "must-not-leak" }]),
    save: vi.fn(async () => ({ ...connection, secret: "must-not-leak" })),
    remove: vi.fn(async () => {})
  };
  await registerMemberMcpRoutes(app, { memberMcpCredentials } as unknown as MemberMcpRouteStores);
  return { app, memberMcpCredentials };
}

test("returns only safe connection fields for the authenticated member", async () => {
  const { app, memberMcpCredentials } = await setup();
  const response = await app.inject("/me/mcp-connections");
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.json()).toEqual({ scope, connections: [connection] });
  expect(memberMcpCredentials.list).toHaveBeenCalledWith("tenant", "member");
  expect(response.body).not.toContain("must-not-leak");
});

test("binds saves and removal to authenticated identity and preserves expected versions", async () => {
  const { app, memberMcpCredentials } = await setup();
  const response = await app.inject({ method: "PUT", url: "/me/mcp-connections/docs/credentials", payload: input });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ scope, connection });
  expect(memberMcpCredentials.save).toHaveBeenCalledWith("tenant", "member", "docs", {
    serverVersion: 3, version: 1, secret: "private-member-secret", accountLabel: "Work"
  });
  expect(response.body).not.toContain("secret");
  const removed = await app.inject({ method: "DELETE", url: "/me/mcp-connections/docs/credentials", payload: { scope, version: 2 } });
  expect(removed.json()).toEqual({ scope, removed: true });
  expect(memberMcpCredentials.remove).toHaveBeenCalledWith("tenant", "member", "docs", 2);
});

test("rejects account or organization changes before validating or saving a secret", async () => {
  const { app, memberMcpCredentials } = await setup();
  for (const changed of [{ ...scope, userId: "other" }, { ...scope, tenantId: "other" }]) {
    for (const method of ["PUT", "DELETE"] as const) {
      const response = await app.inject({ method, url: "/me/mcp-connections/docs/credentials",
        payload: { scope: changed, secret: "", version: 1 } });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("member_mcp_scope_changed");
      expect(response.headers["cache-control"]).toBe("private, no-store");
    }
  }
  expect(memberMcpCredentials.save).not.toHaveBeenCalled();
  expect(memberMcpCredentials.remove).not.toHaveBeenCalled();
});

test("rejects malformed credentials without echoing secret input", async () => {
  const { app, memberMcpCredentials } = await setup();
  const secret = "sensitive\r\nheader";
  const response = await app.inject({ method: "PUT", url: "/me/mcp-connections/docs/credentials", payload: { ...input, secret } });
  expect(response.statusCode).toBe(400);
  expect(response.body).not.toContain("sensitive");
  expect(memberMcpCredentials.save).not.toHaveBeenCalled();
});

test("maps access, missing connection, conflict, and validation errors", async () => {
  const { app, memberMcpCredentials } = await setup();
  for (const [error, status, code] of [
    [new MemberMcpAccessError(), 403, "member_mcp_access"],
    [new MemberMcpNotFoundError(), 404, "member_mcp_not_found"],
    [new MemberMcpConflictError(), 409, "member_mcp_conflict"],
    [new MemberMcpValidationError("Choose a supported credential."), 400, "member_mcp_invalid"]
  ] as const) {
    memberMcpCredentials.save.mockRejectedValueOnce(error);
    const response = await app.inject({ method: "PUT", url: "/me/mcp-connections/docs/credentials", payload: input });
    expect(response.statusCode).toBe(status);
    expect(response.json().error).toBe(code);
    expect(response.body).not.toContain(input.secret);
  }
});
