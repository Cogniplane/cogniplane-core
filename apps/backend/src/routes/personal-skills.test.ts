import Fastify from "fastify";
import { afterEach, expect, test, vi } from "vitest";
import { registerPersonalSkillRoutes, type PersonalSkillStores } from "./personal-skills.js";
import { PersonalSkillAccessError, PersonalSkillConflictError, PersonalSkillDefaultsFullError,
  PersonalSkillLimitError, PersonalSkillNotFoundError } from "../services/skills/personal-skill-store.js";
import { PersonalSkillValidationError } from "../services/skills/personal-skill-validation.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
const scope = { tenantId: "tenant", userId: "member" };
const skillId = "personal-skill-00000000-0000-4000-8000-000000000000";
const revision = { revision: 1, content: { name: "notes", description: "Notes", instructions: "Write notes." },
  validationMessages: [], createdAt: "2026-01-01T00:00:00.000Z" };
const skill = { id: skillId, version: 1, enabled: false, latest: revision, active: null, updatedAt: revision.createdAt };
async function setup() {
  const app = Fastify(); apps.push(app);
  app.addHook("preHandler", async request => { request.auth = { ...scope, role: "member", isAdmin: false }; });
  const personalSkills = {
    list: vi.fn(async () => [skill]), get: vi.fn(async () => skill), history: vi.fn(async () => [revision]),
    create: vi.fn(async () => skill), update: vi.fn(async () => skill), action: vi.fn(async () => skill), remove: vi.fn(async () => {})
  };
  await registerPersonalSkillRoutes(app, { personalSkills } as unknown as PersonalSkillStores);
  return { app, personalSkills };
}
const source = { kind: "inline", name: "notes", description: "Notes", instructions: "Write notes." };

test("uses authenticated identity for every route and returns private responses", async () => {
  const { app, personalSkills } = await setup();
  const listed = await app.inject("/me/skills");
  expect(listed.statusCode).toBe(200);
  expect(listed.headers["cache-control"]).toBe("private, no-store");
  expect(listed.json()).toEqual({ scope, skills: [skill] });
  expect(personalSkills.list).toHaveBeenCalledWith("tenant", "member");
  const created = await app.inject({ method: "POST", url: "/me/skills", payload: { scope, source } });
  expect(created.statusCode).toBe(201);
  expect(personalSkills.create).toHaveBeenCalledWith("tenant", "member", source);
  expect((await app.inject(`/me/skills/${skillId}/history`)).json()).toEqual({ scope, revisions: [revision] });
  expect((await app.inject({ method: "PUT", url: `/me/skills/${skillId}`, payload: { scope, source, version: 1 } })).statusCode).toBe(200);
  expect((await app.inject({ method: "POST", url: `/me/skills/${skillId}/action`, payload: { scope, version: 1, action: "release" } })).statusCode).toBe(200);
  expect((await app.inject({ method: "DELETE", url: `/me/skills/${skillId}`, payload: { scope, version: 1 } })).json())
    .toEqual({ scope, deleted: true });
});

test("rejects changed scope before any write or validation", async () => {
  const { app, personalSkills } = await setup();
  const changed = { tenantId: "other", userId: "member" };
  const requests = [
    { method: "POST" as const, url: "/me/skills", payload: { scope: changed, source } },
    { method: "PUT" as const, url: `/me/skills/${skillId}`, payload: { scope: changed, source, version: 1 } },
    { method: "POST" as const, url: `/me/skills/${skillId}/action`, payload: { scope: changed, action: "release", version: 1 } },
    { method: "DELETE" as const, url: `/me/skills/${skillId}`, payload: { scope: changed, version: 1 } }
  ];
  for (const request of requests) expect((await app.inject(request)).statusCode).toBe(409);
  expect((await app.inject({ method: "POST", url: "/me/skills", payload: {
    scope: changed, source: { kind: "inline", name: "INVALID", description: "", instructions: "" }
  } })).statusCode).toBe(409);
  expect(personalSkills.create).not.toHaveBeenCalled();
  expect(personalSkills.update).not.toHaveBeenCalled();
  expect(personalSkills.action).not.toHaveBeenCalled();
  expect(personalSkills.remove).not.toHaveBeenCalled();
});

test("maps membership, ownership, and stale version errors", async () => {
  const { app, personalSkills } = await setup();
  personalSkills.list.mockRejectedValueOnce(new PersonalSkillAccessError());
  expect((await app.inject("/me/skills")).statusCode).toBe(403);
  personalSkills.get.mockRejectedValueOnce(new PersonalSkillNotFoundError());
  expect((await app.inject(`/me/skills/${skillId}`)).statusCode).toBe(404);
  personalSkills.action.mockRejectedValueOnce(new PersonalSkillConflictError());
  expect((await app.inject({ method: "POST", url: `/me/skills/${skillId}/action`, payload: { scope, action: "release", version: 1 } })).statusCode).toBe(409);
});

test("maps validation, skill limit, and full defaults to distinct errors", async () => {
  const { app, personalSkills } = await setup();
  personalSkills.create.mockRejectedValueOnce(new PersonalSkillValidationError("Duplicate name"));
  const invalid = await app.inject({ method: "POST", url: "/me/skills", payload: { scope, source } });
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json().error).toBe("personal_skill_invalid");
  personalSkills.create.mockRejectedValueOnce(new PersonalSkillLimitError());
  const limited = await app.inject({ method: "POST", url: "/me/skills", payload: { scope, source } });
  expect(limited.statusCode).toBe(409);
  expect(limited.json().error).toBe("personal_skill_limit");
  personalSkills.action.mockRejectedValueOnce(new PersonalSkillDefaultsFullError());
  const full = await app.inject({ method: "POST", url: `/me/skills/${skillId}/action`,
    payload: { scope, version: 1, action: "release" } });
  expect(full.statusCode).toBe(409);
  expect(full.json().error).toBe("personal_defaults_full");
});
