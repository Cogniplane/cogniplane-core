import Fastify from "fastify";
import { afterEach, expect, test, vi } from "vitest";
import { registerProjectSkillRoutes, type ProjectSkillStores } from "./project-skills.js";
import { ProjectAccessError } from "../services/project-access.js";
import {
  ProjectSkillConflictError, ProjectSkillLimitError, ProjectSkillNotFoundError,
  ProjectSkillSelectionFullError, ProjectSkillSourceError
} from "../services/skills/project-skill-store.js";
import { SkillSourceValidationError } from "../services/skills/personal-skill-validation.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
const projectId = "0198c0de-0000-7000-8000-000000000001";
const scope = { tenantId: "tenant", userId: "member", projectId };
const skillId = "project-skill-00000000-0000-4000-8000-000000000000";
const personalSkillId = "personal-skill-00000000-0000-4000-8000-000000000000";
const revision = { revision: 1, content: { name: "notes", description: "Notes", instructions: "Write notes." },
  validationMessages: [], copiedFromRevision: null, createdAt: "2026-01-01T00:00:00.000Z" };
const skill = { id: skillId, version: 1, enabled: false, latest: revision, active: null, copiedFrom: null, updatedAt: revision.createdAt };
const source = { kind: "inline", name: "notes", description: "Notes", instructions: "Write notes." };
const url = `/projects/${projectId}/skills`;

async function setup() {
  const app = Fastify(); apps.push(app);
  app.addHook("preHandler", async request => { request.auth = { tenantId: "tenant", userId: "member", role: "member", isAdmin: false }; });
  const projectSkills = {
    list: vi.fn(async () => ({ canEdit: true, skills: [skill] })), get: vi.fn(async () => skill),
    history: vi.fn(async () => [revision]), create: vi.fn(async () => skill),
    copyFromPersonal: vi.fn(async () => skill), update: vi.fn(async () => skill),
    updateFromPersonal: vi.fn(async () => skill), action: vi.fn(async () => skill), remove: vi.fn(async () => {})
  };
  await registerProjectSkillRoutes(app, { projectSkills } as unknown as ProjectSkillStores);
  return { app, projectSkills };
}

test("uses authenticated identity and the path project for every route", async () => {
  const { app, projectSkills } = await setup();
  const listed = await app.inject(url);
  expect(listed.statusCode).toBe(200);
  expect(listed.headers["cache-control"]).toBe("private, no-store");
  expect(listed.json()).toEqual({ scope, canEdit: true, skills: [skill] });
  expect(projectSkills.list).toHaveBeenCalledWith("tenant", "member", projectId);
  expect((await app.inject({ method: "POST", url, payload: { scope, source } })).statusCode).toBe(201);
  expect(projectSkills.create).toHaveBeenCalledWith("tenant", "member", projectId, source);
  const copied = await app.inject({ method: "POST", url: `${url}/from-personal`, payload: { scope, personalSkillId, sourceRevision: 3 } });
  expect(copied.statusCode).toBe(201);
  expect(projectSkills.copyFromPersonal).toHaveBeenCalledWith("tenant", "member", projectId, personalSkillId, 3);
  expect((await app.inject(`${url}/${skillId}`)).json()).toEqual({ scope, skill });
  expect((await app.inject(`${url}/${skillId}/history`)).json()).toEqual({ scope, revisions: [revision] });
  expect((await app.inject({ method: "PUT", url: `${url}/${skillId}`, payload: { scope, source, version: 1 } })).statusCode).toBe(200);
  expect(projectSkills.update).toHaveBeenCalledWith("tenant", "member", projectId, skillId, source, 1);
  expect((await app.inject({ method: "POST", url: `${url}/${skillId}/from-personal`,
    payload: { scope, version: 2, sourceRevision: 4 } })).statusCode).toBe(200);
  expect(projectSkills.updateFromPersonal).toHaveBeenCalledWith("tenant", "member", projectId, skillId, 4, 2);
  expect((await app.inject({ method: "POST", url: `${url}/${skillId}/action`,
    payload: { scope, version: 1, action: "disable" } })).statusCode).toBe(200);
  expect(projectSkills.action).toHaveBeenCalledWith("tenant", "member", projectId, skillId, "disable", 1);
  expect((await app.inject({ method: "DELETE", url: `${url}/${skillId}`, payload: { scope, version: 1 } })).json())
    .toEqual({ scope, deleted: true });
  expect(projectSkills.remove).toHaveBeenCalledWith("tenant", "member", projectId, skillId, 1);
});

test("rejects another tenant, member, or project scope before any write or validation", async () => {
  const { app, projectSkills } = await setup();
  const otherProject = "0198c0de-0000-7000-8000-000000000002";
  for (const changed of [{ ...scope, tenantId: "other" }, { ...scope, userId: "other" }, { ...scope, projectId: otherProject }]) {
    const requests = [
      { method: "POST" as const, url, payload: { scope: changed, source: { kind: "inline", name: "BAD", description: "", instructions: "" } } },
      { method: "POST" as const, url: `${url}/from-personal`, payload: { scope: changed, personalSkillId, sourceRevision: 1 } },
      { method: "PUT" as const, url: `${url}/${skillId}`, payload: { scope: changed, source, version: 1 } },
      { method: "POST" as const, url: `${url}/${skillId}/from-personal`, payload: { scope: changed, version: 1, sourceRevision: 1 } },
      { method: "POST" as const, url: `${url}/${skillId}/action`, payload: { scope: changed, action: "release", version: 1 } },
      { method: "DELETE" as const, url: `${url}/${skillId}`, payload: { scope: changed, version: 1 } }
    ];
    for (const request of requests) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("project_skill_scope_changed");
    }
  }
  expect((await app.inject({ method: "DELETE", url: `${url}/${skillId}`, payload: { version: 1 } })).statusCode).toBe(400);
  for (const write of ["create", "copyFromPersonal", "update", "updateFromPersonal", "action", "remove"] as const) {
    expect(projectSkills[write]).not.toHaveBeenCalled();
  }
});

test("rejects malformed project and skill IDs before reading", async () => {
  const { app, projectSkills } = await setup();
  expect((await app.inject("/projects/not-a-uuid/skills")).statusCode).toBe(400);
  expect((await app.inject(`${url}/personal-skill-00000000-0000-4000-8000-000000000000`)).statusCode).toBe(400);
  expect(projectSkills.list).not.toHaveBeenCalled();
  expect(projectSkills.get).not.toHaveBeenCalled();
});

test.each([
  [new ProjectAccessError("project_not_found", "This project is unavailable.", 404), 404, "project_not_found"],
  [new ProjectAccessError("project_role_required", "Your project role does not allow this action."), 403, "project_role_required"],
  [new ProjectAccessError("project_busy", "Busy", 409), 409, "project_busy"],
  [new ProjectSkillNotFoundError(), 404, "project_skill_not_found"],
  [new ProjectSkillConflictError(), 409, "project_skill_conflict"],
  [new ProjectSkillLimitError(), 409, "project_skill_limit"],
  [new ProjectSkillSelectionFullError(), 409, "project_selection_full"],
  [new ProjectSkillSourceError("personal_source_changed"), 409, "personal_source_changed"],
  [new ProjectSkillSourceError("personal_source_unavailable"), 409, "personal_source_unavailable"],
  [new SkillSourceValidationError("Duplicate"), 400, "project_skill_invalid"]
])("maps %s to a distinct response", async (error, status, code) => {
  const { app, projectSkills } = await setup();
  projectSkills.action.mockRejectedValueOnce(error);
  const response = await app.inject({ method: "POST", url: `${url}/${skillId}/action`, payload: { scope, version: 1, action: "release" } });
  expect(response.statusCode).toBe(status);
  expect(response.json().error).toBe(code);
});

test("does not turn unexpected failures into client errors", async () => {
  const { app, projectSkills } = await setup();
  projectSkills.list.mockRejectedValueOnce(new Error("database unavailable"));
  expect((await app.inject(url)).statusCode).toBe(500);
});
