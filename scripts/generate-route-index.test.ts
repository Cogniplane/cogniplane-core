import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { generateRouteIndex, listRoutes, routeSourceFiles } from "./generate-route-index.js";

it("keeps the route index current", async () => {
  await expect(generateRouteIndex(true)).resolves.toBeUndefined();
});

it("reads the core routes and the bundled overlay routes", () => {
  const files = routeSourceFiles();
  expect(files).toContain("apps/backend/src/routes/sessions.ts");
  expect(files).toContain("private/sharepoint-overlay-backend/src/routes/microsoft-tenant-routes.ts");
  const index = readFileSync(path.resolve(__dirname, "../docs/routes.md"), "utf8");
  expect(index).toContain("`/integrations/microsoft/callback`");
});

it("fails on a registration that it cannot read", () => {
  expect(() => listRoutes("app.get(buildPath(), handler);")).toThrow("Unsupported route registration");
  expect(() => listRoutes('server.post("/x", handler);')).toThrow("unknown receiver");
  expect(() => listRoutes("server.get(`/future/${kind}`, handler);")).toThrow("unknown receiver");
  expect(() => listRoutes("app.route({ method: verb, url: \"/x\", handler });")).toThrow("Unsupported route registration");
  expect(() => listRoutes("app.register(plugin, { prefix: \"/v2\" });")).toThrow("Route prefix is not supported");
  expect(() => listRoutes("server.get(PATH_CONST, handler);")).toThrow("unknown receiver");
  expect(() => listRoutes("app.route(options);")).toThrow("Unsupported route registration");
  expect(() => listRoutes('app["get"]("/future", handler);')).toThrow("Computed route method");
  expect(() => listRoutes("app.register(plugin, options);")).toThrow("Route prefix is not supported");
  expect(() => listRoutes('app.register(plugin, { "prefix": "/v2" });')).toThrow("Route prefix is not supported");
  expect(() => listRoutes("app.register(plugin, { ...options });")).toThrow("Route prefix is not supported");
  expect(() => listRoutes('app.register(plugin, { ["prefix"]: "/v2" });')).toThrow("Route prefix is not supported");
  expect(() => listRoutes('server["get"]("/missed", handler);')).toThrow("Computed route method");
  expect(() => listRoutes("adminApp.get(P, async () => ({}));")).toThrow("unknown receiver");
  expect(() => listRoutes("svc.get(PATH, handler);")).toThrow("unknown receiver");
});

it("finds Fastify receivers by declaration and resolves names by scope", () => {
  const source = `
    function one(server: FastifyInstance) { const base = "/a"; server.get(\`\${base}/one\`, handler); }
    function two(server: FastifyInstance) { const base = "/b"; server.get(\`\${base}/two\`, handler); }
    app.register(async (scoped) => { scoped.post("/inner", handler); });
    const alias = app;
    alias.delete("/alias", handler);
    const created = Fastify();
    created.get("/created", handler);
    type Api = FastifyInstance;
    function aliased(server: Api) { server.put("/aliased", handler); }
    const cache = new Map();
    cache.get("/not-a-route", fallback);
  `;
  expect(listRoutes(source)).toEqual(["GET `/a/one`", "GET `/b/two`", "POST `/inner`", "DELETE `/alias`", "GET `/created`", "PUT `/aliased`"]);
});

it("tags admin and step-up routes", () => {
  expect(listRoutes('app.get("/admin/x", withAdmin(app, handler));')).toEqual(["GET `/admin/x` (admin)"]);
  const index = readFileSync(path.resolve(__dirname, "../docs/routes.md"), "utf8");
  expect(index).toContain("POST `/tenant/members` (step-up)");
});

it("reads route() objects and every shorthand method", () => {
  expect(listRoutes('app.route({ method: ["GET", "HEAD"], url: "/future", handler }); app.head("/h", handler); routes.all("/a", handler);'))
    .toEqual(["GET `/future`", "HEAD `/future`", "HEAD `/h`", "ALL `/a`"]);
});

it("resolves constants, loop values and literal parameter types", () => {
  const source = `
    const base = "/projects/:projectId/skills";
    app.get(base, handler);
    routes.post(\`\${base}/:skillId\`, handler);
    for (const action of ["archive", "restore"] as const) app.post(\`/sessions/:sessionId/\${action}\`, handler);
    for (const [path, purpose] of [["/auth/a", "x"], ["/auth/b", "y"]] as const) app.post(path, handler);
    function register(kind: "publish" | "unpublish") { app.post(\`/servers/\${kind}\`, handler); }
    for (const other of paths) app.put(other, handler);
    const cache = new Map();
    cache.get(tenantId, fallback);
  `;
  expect(listRoutes(source)).toEqual([
    "GET `/projects/:projectId/skills`",
    "POST `/projects/:projectId/skills/:skillId`",
    "POST `/sessions/:sessionId/archive`",
    "POST `/sessions/:sessionId/restore`",
    "POST `/auth/a`",
    "POST `/auth/b`",
    "POST `/servers/publish`",
    "POST `/servers/unpublish`",
    "PUT `{other}`"
  ]);
});
