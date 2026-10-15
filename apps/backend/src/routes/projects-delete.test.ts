import Fastify from "fastify";
import { expect, test, vi } from "vitest";

import { registerProjectRoutes, type ProjectRouteStores } from "./projects.js";

const TENANT_ID = "tenant-0000-0000-0000-000000000001";
const USER_ID = "user-0000-0000-0000-000000000001";
const PROJECT_ID = "00000000-0000-4000-8000-000000000001";

async function makeApp() {
  const stores = {
    projects: {
      getOwned: vi.fn(async () => ({ projectId: PROJECT_ID, archivedAt: null })),
    }
  } as unknown as ProjectRouteStores;
  const app = Fastify();
  app.addHook("preHandler", async (request) => {
    request.auth = { tenantId: TENANT_ID, userId: USER_ID, role: "member", isAdmin: false };
  });
  await registerProjectRoutes(app, stores);
  return { app, stores };
}

test("does not expose whole-project deletion", async () => {
  const h = await makeApp();

  const response = await h.app.inject({ method: "DELETE", url: `/projects/${PROJECT_ID}` });

  expect(response.statusCode).toBe(404);
  await h.app.close();
});

test("reads project artifacts without loading sessions or activity", async () => {
  const h = await makeApp();
  const getReadable = vi.fn(async () => ({ projectId: PROJECT_ID }));
  const listByProject = vi.fn(async () => []);
  const listPage = vi.fn();
  const listProjectActivity = vi.fn();
  h.stores.projects.getReadable = getReadable as never;
  h.stores.artifacts = { listByProject } as never;
  h.stores.sessions = { listPage } as never;
  h.stores.auditEvents = { listProjectActivity } as never;

  const response = await h.app.inject({ method: "GET", url: `/projects/${PROJECT_ID}/artifacts` });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ artifacts: [] });
  expect(listByProject).toHaveBeenCalledWith(TENANT_ID, USER_ID, PROJECT_ID);
  expect(listPage).not.toHaveBeenCalled();
  expect(listProjectActivity).not.toHaveBeenCalled();
  await h.app.close();
});

test("does not expose artifacts of an unreadable project", async () => {
  const h = await makeApp();
  h.stores.projects.getReadable = vi.fn(async () => null) as never;
  const response = await h.app.inject({ method: "GET", url: `/projects/${PROJECT_ID}/artifacts` });
  expect(response.statusCode).toBe(404);
  await h.app.close();
});
