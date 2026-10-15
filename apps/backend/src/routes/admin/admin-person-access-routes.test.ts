import { MemberMcpAccessError } from "../../services/member-mcp-credential-store.js";
import Fastify from "fastify";
import { describe, expect, test, vi } from "vitest";
import { PERSON_ACCESS_NOT_COVERED } from "@cogniplane/shared-types";
import { FakePool } from "../../test-helpers/fake-pool.js";
import { PersonAccessMemberNotFound } from "../../services/person-access-service.js";
import { PersonalCapabilityAccessError } from "../../services/personal-capability-store.js";
import { registerAdminPersonAccessRoutes } from "./admin-person-access-routes.js";

async function setup(isAdmin = true) {
  const app = Fastify();
  app.decorate("db", new FakePool().onQuery(/INSERT INTO users/, () => ({ rows: [], rowCount: 1 })).asPool());
  app.addHook("preHandler", async request => {
    request.auth = { tenantId: "tenant", userId: "admin", isAdmin, role: isAdmin ? "admin" : "member" };
  });
  const response = { tenantId: "tenant", userId: "target", scope: "new_standalone_chat" as const,
    checkedAt: new Date().toISOString(), member: { isTestUser: false, defaults: "inherited" as const },
    notCovered: [...PERSON_ACCESS_NOT_COVERED], items: [] };
  const service = { explain: vi.fn(async () => response) };
  await registerAdminPersonAccessRoutes(app, service);
  return { app, service, response };
}

describe("person access route", () => {
  test("takes the tenant from auth and the target from the validated path; never caches", async () => {
    const { app, service, response } = await setup();
    try {
      const result = await app.inject("/admin/users/target/skills-connections");
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual(response);
      expect(result.headers["cache-control"]).toBe("private, no-store");
      expect(service.explain).toHaveBeenCalledWith("tenant", "target");
      expect((await app.inject("/admin/users/target/skills-connections?tenantId=other")).statusCode).toBe(400);
      expect(service.explain).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });
  test("rejects a non-admin before reading member settings", async () => {
    const { app, service } = await setup(false);
    try {
      expect((await app.inject("/admin/users/target/skills-connections")).statusCode).toBe(403);
      expect(service.explain).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  test.each([new PersonAccessMemberNotFound(), new PersonalCapabilityAccessError(), new MemberMcpAccessError()])("returns 404 for absent or removed members", async error => {
    const { app, service } = await setup();
    service.explain.mockRejectedValue(error);
    try {
      const result = await app.inject("/admin/users/target/skills-connections");
      expect(result.statusCode).toBe(404);
      expect(result.json()).toEqual({ error: "member_not_found" });
    } finally { await app.close(); }
  });
  test("fails closed without returning database details or a partial catalog", async () => {
    const { app, service } = await setup();
    service.explain.mockRejectedValue(new Error("private database address"));
    try {
      const result = await app.inject("/admin/users/target/skills-connections");
      expect(result.statusCode).toBe(503);
      expect(result.json()).toEqual({ error: "lookup_unavailable" });
    } finally { await app.close(); }
  });
  test("rejects unexpected private fields instead of serializing them", async () => {
    const { app, service, response } = await setup();
    service.explain.mockResolvedValue({ ...response, accountLabel: "private account" } as typeof response);
    try {
      const result = await app.inject("/admin/users/target/skills-connections");
      expect(result.statusCode).toBe(503);
      expect(result.body).not.toContain("private account");
    } finally { await app.close(); }
  });
});
